import { Box, Text, useApp, useInput, useStdin, useStdout, useWindowSize, type DOMElement } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { setTimeout as sleep } from "node:timers/promises";
import { ACTIONS, actionForKey, commandBody, moveSelection, refusal, type Action, type Command } from "./actions.js";
import { decide, type Decision } from "./decide.js";
import * as github from "./github.js";
import type { PullRequest } from "./github.js";
import { createMouseParser, DISABLE_MOUSE, ENABLE_MOUSE, isMouseFragment } from "./mouse.js";
import { planSync, type LeftStatus } from "./sync.js";
import { visibleRange } from "./viewport.js";

export interface Options {
  org: string;
  author: string;
  since: string;
  watch: boolean;
  dryRun: boolean;
  interactive: boolean;
}

interface Row {
  pr: PullRequest;
  decision?: Decision;
  activity?: "loading" | { posting: Command };
  posted?: { command: Command; url: string };
  error?: string;
  left?: LeftStatus;
}

export type GitHub = Pick<typeof github, "listPullRequests" | "fetchReviewState" | "postCommand" | "openInBrowser">;

export interface Timing {
  replyPollMs: number;
  replyTimeoutMs: number;
  watchPollMs: number;
  listRefreshMs: number;
}

const DEFAULT_TIMING: Timing = { replyPollMs: 5_000, replyTimeoutMs: 90_000, watchPollMs: 30_000, listRefreshMs: 60_000 };
const REPOST_GUARD_MS = 15 * 60_000;
const BRAND = "#FF570A";
const REVIEW_COMMANDS: readonly Command[] = ["review", "full review"];
// Lines outside the list in interactive mode: the header, the margin, the scroll hints and the footer.
const CHROME_LINES = 11;

const keyOf = (pr: PullRequest) => `${pr.repo}#${pr.number}`;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const rowHeight = (row: Row) => (row.posted ? 4 : 3);

function needsWatch(row: Row, dryRun: boolean): boolean {
  if (row.left) return false;
  if (row.error) return true;
  switch (row.decision?.kind) {
    case "busy":
    case "pending":
    case "wait":
      return true;
    case "trigger":
      return !dryRun;
    default:
      return false;
  }
}

function absoluteRect(node: DOMElement) {
  let x = 0;
  let y = 0;
  for (let current: DOMElement | undefined = node; current?.yogaNode; current = current.parentNode) {
    x += current.yogaNode.getComputedLeft();
    y += current.yogaNode.getComputedTop();
  }
  return { x, y, width: node.yogaNode?.getComputedWidth() ?? 0, height: node.yogaNode?.getComputedHeight() ?? 0 };
}

function hitTest(nodes: Map<string, DOMElement>, x: number, y: number): string | undefined {
  for (const [id, node] of nodes) {
    const rect = absoluteRect(node);
    if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) return id;
  }
  return undefined;
}

interface Confirmation {
  key: string;
  action: Action;
  warning?: string;
}

interface PostControls {
  post(pr: PullRequest, command: Command): Promise<void>;
}

interface AppProps {
  options: Options;
  gitHub?: GitHub;
  timing?: Timing;
}

export function App(props: AppProps) {
  // The workflow posts comments. If a new prop restarts it, it posts again and loses its repost guard.
  // Thus the component keeps the props of its first render.
  const [{ options, gitHub, timing }] = useState(() => ({
    options: props.options,
    gitHub: props.gitHub ?? github,
    timing: props.timing ?? DEFAULT_TIMING,
  }));
  const { exit } = useApp();
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  const { rows: screenRows } = useWindowSize();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [fatal, setFatal] = useState<string>();
  const [done, setDone] = useState(false);
  const [triggered, setTriggered] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const [nextCheckAt, setNextCheckAt] = useState<Date>();
  const [listError, setListError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [flash, setFlash] = useState<{ text: string; color: string }>();
  const rowsRef = useRef(new Map<string, Row>());
  const controls = useRef<PostControls>(null);
  const rowNodes = useRef(new Map<string, DOMElement>());
  const buttonNodes = useRef(new Map<string, DOMElement>());
  const scrollStart = useRef(0);

  useEffect(() => {
    const abort = new AbortController();
    const { signal } = abort;
    const lastPostedAt = new Map<string, number>();
    let orgBlockedUntil = 0;
    let postLock = Promise.resolve();

    const update = (pr: PullRequest, patch: Partial<Row>) => {
      const key = keyOf(pr);
      rowsRef.current.set(key, { ...rowsRef.current.get(key)!, ...patch });
      setRows([...rowsRef.current.values()]);
    };
    const rowOf = (pr: PullRequest) => rowsRef.current.get(keyOf(pr))!;

    // The CodeRabbit quota is shared by the whole org. Posts go one at a time, and each one
    // waits for the reply before the next: a new rate limit blocks all the other PRs too.
    function exclusive(task: () => Promise<void>): Promise<void> {
      const run = postLock.then(task);
      postLock = run.catch(() => {});
      return run;
    }

    async function refresh(pr: PullRequest): Promise<Decision | undefined> {
      update(pr, { activity: "loading" });
      try {
        const { status, ...state } = await gitHub.fetchReviewState(pr);
        if (status !== "open") {
          update(pr, { left: status, activity: undefined, error: undefined });
          return undefined;
        }
        const decision = decide({ ...state, now: new Date() });
        update(pr, { decision, left: undefined, activity: undefined, error: undefined });
        return decision;
      } catch (error) {
        update(pr, { activity: undefined, error: message(error) });
        return undefined;
      }
    }

    async function waitForReply(pr: PullRequest): Promise<Decision | undefined> {
      const deadline = Date.now() + timing.replyTimeoutMs;
      let decision: Decision | undefined;
      do {
        await sleep(Math.min(timing.replyPollMs, Math.max(0, deadline - Date.now())), undefined, { signal });
        decision = await refresh(pr);
      } while (decision?.kind === "pending" && Date.now() < deadline);
      return decision;
    }

    async function post(pr: PullRequest, command: Command): Promise<boolean> {
      update(pr, { activity: { posting: command } });
      try {
        const url = await gitHub.postCommand(pr, command);
        if (REVIEW_COMMANDS.includes(command)) lastPostedAt.set(keyOf(pr), Date.now());
        update(pr, { activity: undefined, posted: { command, url } });
      } catch (error) {
        update(pr, { activity: undefined, error: message(error) });
        return false;
      }
      const reply = await waitForReply(pr);
      if (reply?.kind === "wait") orgBlockedUntil = reply.availableAt.getTime();
      return true;
    }

    controls.current = {
      post: (pr, command) =>
        exclusive(async () => {
          const posted = await post(pr, command);
          setFlash(
            posted
              ? { text: `Posted "${commandBody(command)}" on ${keyOf(pr)}.`, color: "green" }
              : { text: `Could not post on ${keyOf(pr)}.`, color: "red" },
          );
        }),
    };

    async function triggerReady(prs: PullRequest[]) {
      if (options.dryRun) return;
      for (const pr of prs) {
        await exclusive(async () => {
          const row = rowOf(pr);
          if (row.left || row.decision?.kind !== "trigger") return;
          if (Date.now() < orgBlockedUntil) {
            update(pr, { decision: { kind: "wait", availableAt: new Date(orgBlockedUntil), delayGuessed: false } });
            return;
          }
          if (Date.now() - (lastPostedAt.get(keyOf(pr)) ?? 0) < REPOST_GUARD_MS) return;
          if (await post(pr, "review")) setTriggered((count) => count + 1);
        });
      }
    }

    function nextDelay(prs: PullRequest[]): number {
      const ends = prs
        .map((pr) => rowOf(pr).decision)
        .filter((decision) => decision?.kind === "wait")
        .map((decision) => decision.availableAt.getTime() + 2_000 - Date.now());
      return Math.max(1_000, Math.min(timing.watchPollMs, ...ends));
    }

    const tracked = () => [...rowsRef.current.values()].map((row) => row.pr);

    async function syncList() {
      const listed = new Map((await gitHub.listPullRequests(options)).map((pr) => [keyOf(pr), pr]));
      const plan = planSync(
        [...rowsRef.current].map(([key, row]) => ({ key, left: row.left })),
        [...listed.keys()],
      );
      const added = plan.added.map((key) => listed.get(key)!);
      for (const pr of added) rowsRef.current.set(keyOf(pr), { pr, activity: "loading" });
      setRows([...rowsRef.current.values()]);
      setSelected((current) => current ?? [...rowsRef.current.keys()][0]);
      await Promise.all([...added, ...plan.recheck.map((key) => rowsRef.current.get(key)!.pr)].map(refresh));
    }

    async function run() {
      await syncList();
      await triggerReady(tracked());
      if (!options.watch) return;

      let listedAt = Date.now();
      while (true) {
        const watched = tracked().filter((pr) => needsWatch(rowOf(pr), options.dryRun));
        const delay = nextDelay(watched);
        setNextCheckAt(new Date(Date.now() + delay));
        await sleep(delay, undefined, { signal });
        setNextCheckAt(undefined);

        if (Date.now() - listedAt >= timing.listRefreshMs) {
          listedAt = Date.now();
          try {
            await syncList();
            setListError(undefined);
          } catch (error) {
            setListError(message(error));
          }
        }

        const due = watched.filter((pr) => {
          const row = rowOf(pr);
          if (row.left) return false;
          return row.decision?.kind !== "wait" || row.decision.availableAt.getTime() <= Date.now();
        });
        await Promise.all(due.map(refresh));
        await triggerReady(tracked());
      }
    }

    run()
      .then(() => setDone(true))
      .catch((error) => {
        if (signal.aborted) return;
        setFatal(message(error));
        setDone(true);
      });
    return () => abort.abort();
  }, []);

  useEffect(() => {
    if (!options.watch) return;
    const timer = setInterval(() => setNow(new Date()), 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (done) exit(fatal ? new Error(fatal) : undefined);
  }, [done]);

  const keys = rows?.map((row) => keyOf(row.pr)) ?? [];

  function request(action: Action, key = selected) {
    const row = key ? rowsRef.current.get(key) : undefined;
    if (!row || !key) return;
    const refused = refusal(action, { left: row.left !== undefined, dryRun: options.dryRun });
    if (refused) {
      setFlash({ text: `Cannot ${action.label} ${key}: ${refused}.`, color: "yellow" });
      return;
    }
    if (!action.command) {
      gitHub.openInBrowser(row.pr.url);
      setFlash({ text: `Opened ${key} in the browser.`, color: "green" });
      return;
    }
    const quota =
      REVIEW_COMMANDS.includes(action.command) && row.decision?.kind === "wait"
        ? `The quota comes back at ${formatTime(row.decision.availableAt)}: CodeRabbit will likely refuse.`
        : undefined;
    setFlash(undefined);
    setConfirmation({ key, action, warning: quota });
  }

  function answer(yes: boolean) {
    const pending = confirmation;
    setConfirmation(undefined);
    if (!pending?.action.command) return;
    const row = rowsRef.current.get(pending.key);
    if (!yes || !row) {
      setFlash({ text: "Cancelled.", color: "gray" });
      return;
    }
    setFlash({ text: `Posting "${commandBody(pending.action.command)}" on ${pending.key}…`, color: "blue" });
    void controls.current?.post(row.pr, pending.action.command);
  }

  function press(id: string) {
    if (id === "yes" || id === "no") return answer(id === "yes");
    if (confirmation) return;
    const action = actionForKey(id);
    if (action) request(action);
  }

  const move = (step: number) => setSelected((current) => moveSelection(keys, current, step));

  useInput(
    (input, key) => {
      if (isMouseFragment(input)) return;
      if (confirmation) {
        if (input === "y") answer(true);
        else if (input === "n" || key.escape) answer(false);
        return;
      }
      if (key.upArrow || input === "k") move(-1);
      else if (key.downArrow || input === "j") move(1);
      else if (key.return) press("o");
      else if (input === "q") exit();
      else if (input.length === 1) press(input);
    },
    { isActive: options.interactive },
  );

  const handlers = useRef({ press, move, select: setSelected });
  handlers.current = { press, move, select: setSelected };

  useEffect(() => {
    if (!options.interactive) return;
    const disable = () => stdout.write(DISABLE_MOUSE);
    stdout.write(ENABLE_MOUSE);
    process.once("exit", disable);
    const feed = createMouseParser((event) => {
      if (event.kind === "wheel") return handlers.current.move(event.direction === "up" ? -1 : 1);
      const button = hitTest(buttonNodes.current, event.x, event.y);
      if (button) return handlers.current.press(button);
      const row = hitTest(rowNodes.current, event.x, event.y);
      if (row) handlers.current.select(row);
    });
    const onData = (data: Buffer | string) => feed(data.toString());
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
      process.off("exit", disable);
      disable();
    };
  }, []);

  const clock = options.watch ? now : new Date();
  const selectedIndex = selected ? keys.indexOf(selected) : 0;
  const range =
    options.interactive && rows
      ? visibleRange(rows.map(rowHeight), selectedIndex, Math.max(3, screenRows - CHROME_LINES), scrollStart.current)
      : { start: 0, end: rows?.length ?? 0 };
  scrollStart.current = range.start;

  const registerRow = (key: string) => (node: DOMElement | null) => {
    if (node) rowNodes.current.set(key, node);
    else rowNodes.current.delete(key);
  };
  const registerButton = (id: string) => (node: DOMElement | null) => {
    if (node) buttonNodes.current.set(id, node);
    else buttonNodes.current.delete(id);
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header options={options} />
      {rows === null && !fatal && (
        <Text>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>{" "}
          Searching pull requests…
        </Text>
      )}
      {rows?.length === 0 && (
        <Text dimColor>
          No open pull request by {options.author} in {options.org} since {formatDay(options.since)}.
        </Text>
      )}
      {rows && rows.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {options.interactive && (
            <Text dimColor>{range.start > 0 ? `  ↑ ${range.start} more` : " "}</Text>
          )}
          {rows.slice(range.start, range.end).map((row) => (
            <RowView
              key={keyOf(row.pr)}
              ref={registerRow(keyOf(row.pr))}
              row={row}
              now={clock}
              options={options}
              selected={options.interactive && keyOf(row.pr) === selected}
            />
          ))}
          {options.interactive && (
            <Text dimColor>{range.end < rows.length ? `  ↓ ${rows.length - range.end} more` : " "}</Text>
          )}
        </Box>
      )}
      {fatal && <Text color="red">✖ {fatal}</Text>}
      {rows && rows.length > 0 && (
        <Footer
          rows={rows}
          triggered={triggered}
          done={done}
          now={clock}
          nextCheckAt={nextCheckAt}
          listError={listError}
          options={options}
        />
      )}
      {options.interactive && (
        <Controls
          confirmation={confirmation}
          flash={flash}
          registerButton={registerButton}
          disabledCommands={options.dryRun}
        />
      )}
    </Box>
  );
}

function Header({ options }: { options: Options }) {
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={BRAND} bold>
          🐇 coderabbit-retry
        </Text>
        {options.watch && <Text color="cyan"> [watch]</Text>}
        {options.dryRun && <Text color="yellow"> [dry-run]</Text>}
      </Text>
      <Text dimColor wrap="truncate-end">
        Open pull requests by {options.author} in {options.org} since {formatDay(options.since)}
      </Text>
    </Box>
  );
}

interface View {
  icon: ReactNode;
  label: string;
  color: string;
  detail: string;
}

const LEFT_VIEWS: Record<LeftStatus, View> = {
  merged: { icon: <Text color="magenta">◆</Text>, label: "merged", color: "magenta", detail: "merged, no longer watched" },
  closed: { icon: <Text color="red">○</Text>, label: "closed", color: "red", detail: "closed, no longer watched" },
  draft: {
    icon: <Text color="gray">◌</Text>,
    label: "draft",
    color: "gray",
    detail: "back to draft, not watched until it is ready for review",
  },
};

function describe(row: Row, now: Date, options: Options): View {
  const spinner = (color: string) => (
    <Text color={color}>
      <Spinner type="dots" />
    </Text>
  );
  if (typeof row.activity === "object") {
    const command = row.activity.posting;
    return {
      icon: spinner("blue"),
      label: command === "review" ? "retrying" : "posting",
      color: "blue",
      detail: `posting "${commandBody(command)}"…`,
    };
  }
  if (row.left) return LEFT_VIEWS[row.left];
  if (row.error) return { icon: <Text color="red">✖</Text>, label: "error", color: "red", detail: row.error };

  const decision = row.decision;
  if (!decision) return { icon: spinner("gray"), label: "checking", color: "gray", detail: "reading the reviews…" };

  switch (decision.kind) {
    case "reviewed":
      return { icon: <Text color="green">✔</Text>, label: "up to date", color: "green", detail: "the last commit is already reviewed" };
    case "busy":
      return { icon: spinner("cyan"), label: "reviewing", color: "cyan", detail: "CodeRabbit is reviewing the pull request" };
    case "idle":
      return {
        icon: <Text color="gray">·</Text>,
        label: "nothing to do",
        color: "gray",
        detail: decision.limitLifted
          ? "rate limit lifted, but the last commit has no review"
          : "no rate limit, but the last commit has no review",
      };
    case "wait": {
      const remaining = decision.availableAt.getTime() - now.getTime();
      const guess = decision.delayGuessed ? " · unreadable delay, 1 h assumed" : "";
      const when = remaining > 0 ? `in ${formatDuration(remaining, options.watch)}` : "now, checking…";
      return {
        icon: <Text color="yellow">◷</Text>,
        label: "quota",
        color: "yellow",
        detail: `quota back ${when} (at ${formatTime(decision.availableAt)})${guess}`,
      };
    }
    case "pending":
      return {
        icon: spinner("magenta"),
        label: "requested",
        color: "magenta",
        detail: `request of ${formatTime(decision.requestedAt)} has no reply from CodeRabbit`,
      };
    case "trigger": {
      const since = formatDuration(now.getTime() - decision.availableAt.getTime(), false);
      return {
        icon: <Text color="blue">↻</Text>,
        label: "to retry",
        color: "blue",
        detail: `quota back for ${since}${options.dryRun ? " · dry run, nothing posted" : ""}`,
      };
    }
  }
}

interface RowViewProps {
  ref: (node: DOMElement | null) => void;
  row: Row;
  now: Date;
  options: Options;
  selected: boolean;
}

function RowView({ ref, row, now, options, selected }: RowViewProps) {
  const view = describe(row, now, options);
  const name = row.pr.repo.startsWith(`${options.org}/`) ? row.pr.repo.slice(options.org.length + 1) : row.pr.repo;
  const indent = options.interactive ? 21 : 19;
  return (
    <Box ref={ref} flexDirection="column" marginBottom={1}>
      <Box>
        {options.interactive && (
          <Box width={2} flexShrink={0}>
            <Text color={BRAND} bold>
              {selected ? "❯" : " "}
            </Text>
          </Box>
        )}
        <Box width={3} flexShrink={0}>
          {view.icon}
        </Box>
        <Box width={16} flexShrink={0}>
          <Text color={view.color} bold>
            {view.label}
          </Text>
        </Box>
        <Box flexShrink={0} marginRight={2}>
          <Text bold inverse={selected}>
            {name}#{row.pr.number}
          </Text>
        </Box>
        <Text wrap="truncate-end">{row.pr.title}</Text>
      </Box>
      <Box paddingLeft={indent}>
        <Text dimColor wrap="truncate-end">
          {view.detail}
        </Text>
      </Box>
      {row.posted && (
        <Box paddingLeft={indent}>
          <Text color="green" wrap="truncate-end">
            ↻ {row.posted.command === "review" ? "retried" : commandBody(row.posted.command)} → {row.posted.url}
          </Text>
        </Box>
      )}
    </Box>
  );
}

interface FooterProps {
  rows: Row[];
  triggered: number;
  done: boolean;
  now: Date;
  nextCheckAt?: Date;
  listError?: string;
  options: Options;
}

function Footer({ rows, triggered, done, now, nextCheckAt, listError, options }: FooterProps) {
  const active = rows.filter((row) => !row.left);
  const count = (kind: Decision["kind"]) => active.filter((row) => row.decision?.kind === kind).length;
  const countLeft = (status: LeftStatus) => rows.filter((row) => row.left === status).length;
  const waiting = count("wait");
  const parts = [
    triggered > 0 && `${triggered} retried`,
    count("trigger") > 0 && `${count("trigger")} to retry`,
    waiting > 0 && `${waiting} waiting for quota`,
    count("busy") > 0 && `${count("busy")} reviewing`,
    count("reviewed") > 0 && `${count("reviewed")} up to date`,
    count("idle") > 0 && `${count("idle")} with nothing to do`,
    countLeft("merged") > 0 && `${countLeft("merged")} merged`,
    countLeft("closed") > 0 && `${countLeft("closed")} closed`,
    countLeft("draft") > 0 && `${countLeft("draft")} back to draft`,
  ].filter(Boolean);

  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">{parts.length > 0 ? parts.join(" · ") : "Nothing to do."}</Text>
      {options.watch && !done && (
        <Text dimColor wrap="truncate-end">
          Watching
          {nextCheckAt ? ` · next check in ${formatDuration(nextCheckAt.getTime() - now.getTime(), true)}` : " · checking…"}
          {options.interactive ? "" : " · Ctrl+C to quit"}
        </Text>
      )}
      {listError && (
        <Text color="red" wrap="truncate-end">
          The list refresh failed: {listError}
        </Text>
      )}
      {!options.watch && done && waiting > 0 && (
        <Text dimColor>
          Tip: <Text color={BRAND}>coderabbit-retry --watch</Text> waits for the quota and retries by itself.
        </Text>
      )}
    </Box>
  );
}

interface ControlsProps {
  confirmation?: Confirmation;
  flash?: { text: string; color: string };
  registerButton: (id: string) => (node: DOMElement | null) => void;
  disabledCommands: boolean;
}

function Button({ id, hotkey, label, dim, register }: { id: string; hotkey: string; label: string; dim?: boolean; register: ControlsProps["registerButton"] }) {
  return (
    <Box ref={register(id)} marginRight={2} flexShrink={0}>
      <Text dimColor={dim}>
        <Text color={dim ? undefined : BRAND} bold>
          {hotkey}
        </Text>{" "}
        {label}
      </Text>
    </Box>
  );
}

function Controls({ confirmation, flash, registerButton, disabledCommands }: ControlsProps) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {confirmation ? (
        <>
          <Box>
            <Text wrap="truncate-end">
              Post <Text bold>"{commandBody(confirmation.action.command!)}"</Text> on{" "}
              <Text bold>{confirmation.key}</Text>?{"  "}
            </Text>
            <Button id="yes" hotkey="y" label="yes" register={registerButton} />
            <Button id="no" hotkey="n" label="no" register={registerButton} />
          </Box>
          <Text color="yellow" wrap="truncate-end">
            {confirmation.warning ?? " "}
          </Text>
        </>
      ) : (
        <>
          <Box>
            {ACTIONS.map((action) => (
              <Button
                key={action.key}
                id={action.key}
                hotkey={action.key}
                label={action.label}
                dim={disabledCommands && action.command !== undefined}
                register={registerButton}
              />
            ))}
            <Text dimColor>↑↓ select · q quit</Text>
          </Box>
          <Text color={flash?.color} wrap="truncate-end">
            {flash?.text ?? " "}
          </Text>
        </>
      )}
    </Box>
  );
}

function formatDuration(ms: number, precise: boolean): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (precise) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = String(seconds % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }
  const minutes = Math.ceil(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function formatDay(day: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}
