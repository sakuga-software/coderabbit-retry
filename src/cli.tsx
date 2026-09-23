#!/usr/bin/env node
import { render } from "ink";
import meow from "meow";
import { App } from "./app.js";

const DEFAULT_ORG = "sakuga-software";

const cli = meow(
  `
  Posts "@coderabbitai review" on your open pull requests after their CodeRabbit quota comes back.

  Usage
    $ coderabbit-retry [options]

  Options
    -s, --since <YYYY-MM-DD>  Pull requests created on or after this date   (default: Monday of this week)
    -o, --org <org>           GitHub organization                           (default: ${DEFAULT_ORG})
    -a, --author <login>      Pull request author                           (default: @me)
    -w, --watch               Stay open until Ctrl+C: retry each pull request when its quota comes back
    -n, --dry-run             Show the decisions, but post no comment
    -h, --help                Show this help
        --version             Show the version

  States
    approved       CodeRabbit reviewed the last commit, and its last verdict approves
    changes requested
                   CodeRabbit reviewed the last commit, and its last verdict requests changes
    reviewed       CodeRabbit reviewed the last commit, with no verdict: comments only,
                   or a dismissed verdict
    reviewing      the CodeRabbit summary shows a review in progress
    quota          the quota is not back; shows when it comes back
    requested      a bare "@coderabbitai review" of less than 15 min waits for a reply
    nothing to do  the last commit has no review, but no rate limit is active
    to retry       the quota is back: posts a bare "@coderabbitai review"
    skipped        CodeRabbit skipped the review (a bot author, a draft…); r requests one
    paused         automatic reviews are paused and the last commit has no review
    no review yet  CodeRabbit has not commented on the pull request
    merged         the pull request is merged; the tool no longer watches it
    closed         the pull request is closed; the tool no longer watches it
    draft          the pull request is back to draft; watched again if it is ready

  A commit counts as reviewed with a GitHub review on it, or with a finished
  review of it in the CodeRabbit summary. The verdict is the last CodeRabbit
  review that approves, requests changes or is dismissed, as on GitHub.

  The delay comes from the current version of the CodeRabbit comment: its
  "available in …" starts at its last edit. The quota is shared by the whole
  organization, so the tool posts one request at a time, after the reply to
  the previous one.

  With --watch, the tool searches the pull requests again once a minute. It
  adds the new ones, shows the ones that are merged, closed or back to draft,
  and checks the settled ones again, so a first review shows up when it starts
  and when it ends.

  Keys and mouse
    With --watch in a terminal, the list takes keys and mouse clicks:
    ↑ ↓  or  k j    select a pull request; the mouse wheel does it too
    o  or  Enter    open the pull request in the browser
    r               post "@coderabbitai review"
    f               post "@coderabbitai full review"
    a               post "@coderabbitai approve": resolve the threads, then approve
    s               post "@coderabbitai resolve": resolve the threads
    h               hide or show the merged, closed and draft pull requests
    q               quit
  Each post asks for a confirmation: y or Enter posts, n or Esc cancels. A click selects a row or presses
  a button. The mouse mode takes over text selection: hold Shift or Option,
  depending on the terminal, to select text.

  Examples
    $ coderabbit-retry
    $ coderabbit-retry --watch
    $ coderabbit-retry --dry-run --since 2026-09-15

  Requires an authenticated gh (gh auth status).
`,
  {
    importMeta: import.meta,
    description: false,
    allowUnknownFlags: false,
    flags: {
      since: { type: "string", shortFlag: "s" },
      org: { type: "string", shortFlag: "o", default: DEFAULT_ORG },
      author: { type: "string", shortFlag: "a", default: "@me" },
      watch: { type: "boolean", shortFlag: "w", default: false },
      dryRun: { type: "boolean", shortFlag: "n", default: false },
      help: { type: "boolean", shortFlag: "h" },
    },
  },
);

function mondayOfThisWeek(): string {
  const day = new Date();
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

const since = cli.flags.since ?? mondayOfThisWeek();
if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(Date.parse(since))) {
  console.error(`--since expects a YYYY-MM-DD date, got "${since}".`);
  process.exit(2);
}

const interactive = cli.flags.watch && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
const app = render(<App options={{ ...cli.flags, since, interactive }} />, { alternateScreen: interactive });
process.once("SIGTERM", () => app.unmount());
try {
  await app.waitUntilExit();
} catch (error) {
  process.exitCode = 1;
  // The alternate screen drops its last frame on exit, and the error with it.
  if (interactive) console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
}
