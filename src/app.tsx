import { Box, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { setTimeout as sleep } from "node:timers/promises";
import { decide, type Decision } from "./decide.js";
import * as github from "./github.js";
import type { PullRequest } from "./github.js";

export interface Options {
  org: string;
  author: string;
  since: string;
  watch: boolean;
  dryRun: boolean;
}

interface Row {
  pr: PullRequest;
  decision?: Decision;
  activity?: "loading" | "posting";
  postedUrl?: string;
  error?: string;
}

export type GitHub = Pick<typeof github, "listPullRequests" | "fetchReviewState" | "requestReview">;

export interface Timing {
  replyPollMs: number;
  replyTimeoutMs: number;
  watchPollMs: number;
}

const DEFAULT_TIMING: Timing = { replyPollMs: 5_000, replyTimeoutMs: 90_000, watchPollMs: 30_000 };
const REPOST_GUARD_MS = 15 * 60_000;
const BRAND = "#FF570A";

const keyOf = (pr: PullRequest) => `${pr.repo}#${pr.number}`;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function needsWatch(row: Row, dryRun: boolean): boolean {
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

interface AppProps {
  options: Options;
  gitHub?: GitHub;
  timing?: Timing;
}

export function App({ options, gitHub = github, timing = DEFAULT_TIMING }: AppProps) {
  const { exit } = useApp();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [fatal, setFatal] = useState<string>();
  const [done, setDone] = useState(false);
  const [triggered, setTriggered] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const [nextCheckAt, setNextCheckAt] = useState<Date>();
  const rowsRef = useRef(new Map<string, Row>());

  useEffect(() => {
    const abort = new AbortController();
    const { signal } = abort;
    const lastPostedAt = new Map<string, number>();
    let orgBlockedUntil = 0;

    const update = (pr: PullRequest, patch: Partial<Row>) => {
      const key = keyOf(pr);
      rowsRef.current.set(key, { ...rowsRef.current.get(key)!, ...patch });
      setRows([...rowsRef.current.values()]);
    };
    const rowOf = (pr: PullRequest) => rowsRef.current.get(keyOf(pr))!;

    async function refresh(pr: PullRequest): Promise<Decision | undefined> {
      update(pr, { activity: "loading" });
      try {
        const state = await gitHub.fetchReviewState(pr);
        const decision = decide({ ...state, now: new Date() });
        update(pr, { decision, activity: undefined, error: undefined });
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
        await sleep(timing.replyPollMs, undefined, { signal });
        decision = await refresh(pr);
      } while (decision?.kind === "pending" && Date.now() < deadline);
      return decision;
    }

    // The CodeRabbit quota is shared by the whole org. Post one request at a time, and read
    // the reply before the next one: a new rate limit blocks all the other PRs too.
    async function triggerReady(prs: PullRequest[]) {
      if (options.dryRun) return;
      for (const pr of prs) {
        if (rowOf(pr).decision?.kind !== "trigger") continue;
        if (Date.now() < orgBlockedUntil) {
          update(pr, { decision: { kind: "wait", availableAt: new Date(orgBlockedUntil), delayGuessed: false } });
          continue;
        }
        if (Date.now() - (lastPostedAt.get(keyOf(pr)) ?? 0) < REPOST_GUARD_MS) continue;

        update(pr, { activity: "posting" });
        try {
          const url = await gitHub.requestReview(pr);
          lastPostedAt.set(keyOf(pr), Date.now());
          update(pr, { activity: undefined, postedUrl: url });
          setTriggered((count) => count + 1);
        } catch (error) {
          update(pr, { activity: undefined, error: message(error) });
          continue;
        }
        const reply = await waitForReply(pr);
        if (reply?.kind === "wait") orgBlockedUntil = reply.availableAt.getTime();
      }
    }

    function nextDelay(prs: PullRequest[]): number {
      const ends = prs
        .map((pr) => rowOf(pr).decision)
        .filter((decision) => decision?.kind === "wait")
        .map((decision) => decision.availableAt.getTime() + 2_000 - Date.now());
      return Math.max(1_000, Math.min(timing.watchPollMs, ...ends));
    }

    async function run() {
      const prs = await gitHub.listPullRequests(options);
      for (const pr of prs) rowsRef.current.set(keyOf(pr), { pr, activity: "loading" });
      setRows([...rowsRef.current.values()]);

      await Promise.all(prs.map(refresh));
      await triggerReady(prs);
      if (!options.watch) return;

      while (true) {
        const watched = prs.filter((pr) => needsWatch(rowOf(pr), options.dryRun));
        if (watched.length === 0) return;
        const delay = nextDelay(watched);
        setNextCheckAt(new Date(Date.now() + delay));
        await sleep(delay, undefined, { signal });
        setNextCheckAt(undefined);
        const due = watched.filter((pr) => {
          const decision = rowOf(pr).decision;
          return decision?.kind !== "wait" || decision.availableAt.getTime() <= Date.now();
        });
        await Promise.all(due.map(refresh));
        await triggerReady(prs);
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

  const clock = options.watch ? now : new Date();

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header options={options} />
      {rows === null && !fatal && (
        <Text>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>{" "}
          Recherche des PR…
        </Text>
      )}
      {rows?.length === 0 && (
        <Text dimColor>
          Aucune PR ouverte de {options.author} sur {options.org} depuis le {formatDay(options.since)}.
        </Text>
      )}
      {rows && rows.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {rows.map((row) => (
            <RowView key={keyOf(row.pr)} row={row} now={clock} options={options} />
          ))}
        </Box>
      )}
      {fatal && <Text color="red">✖ {fatal}</Text>}
      {rows && rows.length > 0 && (
        <Footer rows={rows} triggered={triggered} done={done} now={clock} nextCheckAt={nextCheckAt} options={options} />
      )}
    </Box>
  );
}

function Header({ options }: { options: Options }) {
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={BRAND} bold>
          🐇 coderabbit-retry
        </Text>
        {options.watch && <Text color="cyan"> [watch]</Text>}
        {options.dryRun && <Text color="yellow"> [dry-run]</Text>}
      </Text>
      <Text dimColor>
        PR ouvertes de {options.author} sur {options.org} depuis le {formatDay(options.since)}
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

function describe(row: Row, now: Date, options: Options): View {
  const spinner = (color: string) => (
    <Text color={color}>
      <Spinner type="dots" />
    </Text>
  );
  if (row.activity === "posting") {
    return { icon: spinner("blue"), label: "relance", color: "blue", detail: "envoi de « @coderabbitai review »…" };
  }
  if (row.error) return { icon: <Text color="red">✖</Text>, label: "erreur", color: "red", detail: row.error };

  const decision = row.decision;
  if (!decision) return { icon: spinner("gray"), label: "analyse", color: "gray", detail: "lecture des reviews…" };

  switch (decision.kind) {
    case "reviewed":
      return { icon: <Text color="green">✔</Text>, label: "à jour", color: "green", detail: "dernier commit déjà reviewé" };
    case "busy":
      return { icon: spinner("cyan"), label: "en cours", color: "cyan", detail: "CodeRabbit review la PR" };
    case "idle":
      return {
        icon: <Text color="gray">·</Text>,
        label: "rien à faire",
        color: "gray",
        detail: decision.limitLifted
          ? "rate limit levé, mais dernier commit non reviewé"
          : "pas de rate limit, dernier commit non reviewé",
      };
    case "wait": {
      const remaining = decision.availableAt.getTime() - now.getTime();
      const guess = decision.delayGuessed ? " · délai illisible, 1 h supposée" : "";
      const left = remaining > 0 ? `dans ${formatDuration(remaining, options.watch)}` : "maintenant, vérification…";
      return {
        icon: <Text color="yellow">◷</Text>,
        label: "quota",
        color: "yellow",
        detail: `quota de retour ${left} (à ${formatTime(decision.availableAt)})${guess}`,
      };
    }
    case "pending":
      return {
        icon: spinner("magenta"),
        label: "demandée",
        color: "magenta",
        detail: `demande de ${formatTime(decision.requestedAt)} sans réponse de CodeRabbit`,
      };
    case "trigger": {
      const since = formatDuration(now.getTime() - decision.availableAt.getTime(), false);
      return {
        icon: <Text color="blue">↻</Text>,
        label: "à relancer",
        color: "blue",
        detail: `quota revenu depuis ${since}${options.dryRun ? " · dry-run, rien posté" : ""}`,
      };
    }
  }
}

function RowView({ row, now, options }: { row: Row; now: Date; options: Options }) {
  const view = describe(row, now, options);
  const name = row.pr.repo.startsWith(`${options.org}/`) ? row.pr.repo.slice(options.org.length + 1) : row.pr.repo;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Box width={3} flexShrink={0}>
          {view.icon}
        </Box>
        <Box width={14} flexShrink={0}>
          <Text color={view.color} bold>
            {view.label}
          </Text>
        </Box>
        <Box flexShrink={0} marginRight={2}>
          <Text bold>
            {name}#{row.pr.number}
          </Text>
        </Box>
        <Text wrap="truncate-end">{row.pr.title}</Text>
      </Box>
      <Box paddingLeft={17}>
        <Text dimColor wrap="truncate-end">
          {view.detail}
        </Text>
      </Box>
      {row.postedUrl && (
        <Box paddingLeft={17}>
          <Text color="green" wrap="truncate-end">
            ↻ relancée → {row.postedUrl}
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
  options: Options;
}

function Footer({ rows, triggered, done, now, nextCheckAt, options }: FooterProps) {
  const count = (kind: Decision["kind"]) => rows.filter((row) => row.decision?.kind === kind).length;
  const waiting = count("wait");
  const parts = [
    triggered > 0 && `${triggered} relancée${triggered > 1 ? "s" : ""}`,
    count("trigger") > 0 && `${count("trigger")} à relancer`,
    waiting > 0 && `${waiting} en attente de quota`,
    count("busy") > 0 && `${count("busy")} en cours`,
    count("reviewed") > 0 && `${count("reviewed")} à jour`,
    count("idle") > 0 && `${count("idle")} sans action`,
  ].filter(Boolean);

  return (
    <Box flexDirection="column">
      <Text>{parts.length > 0 ? parts.join(" · ") : "Aucune action."}</Text>
      {options.watch && !done && (
        <Text dimColor>
          Surveillance active
          {nextCheckAt ? ` · prochaine vérification dans ${formatDuration(nextCheckAt.getTime() - now.getTime(), true)}` : " · vérification…"}
          {" · Ctrl+C pour quitter"}
        </Text>
      )}
      {!options.watch && done && waiting > 0 && (
        <Text dimColor>
          Astuce : <Text color={BRAND}>coderabbit-retry --watch</Text> attend le retour du quota et relance tout seul.
        </Text>
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
  return date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function formatDay(day: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
}
