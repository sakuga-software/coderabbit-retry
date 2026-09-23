import { render } from "ink";
import { setTimeout as sleep } from "node:timers/promises";
import { App, type GitHub } from "../src/app.js";
import { BOT_LOGIN, REQUEST_BODY, type Comment, type Review } from "../src/decide.js";
import type { PullRequest, PullRequestStatus } from "../src/github.js";

const start = Date.now();
const iso = (offsetMs: number) => new Date(start + offsetMs).toISOString();
const elapsed = () => Date.now() - start;

const comment = (login: string, body: string, at: number, updatedAt = at): Comment => ({
  user: { login },
  body,
  created_at: iso(at),
  updated_at: iso(updatedAt),
});
const review = (commit: string, at: number): Review => ({
  user: { login: BOT_LOGIN },
  commit_id: commit,
  submitted_at: iso(at),
});

const SUMMARY = "<!-- summarize by coderabbit.ai -->";
const inProgress = (at: number) => comment(BOT_LOGIN, `${SUMMARY} <!-- review in progress by coderabbit.ai -->`, -3_600_000, at);
const rateLimited = (at: number, delay: string) =>
  comment(
    BOT_LOGIN,
    `${SUMMARY} <!-- rate limited by coderabbit.ai --> **Next included review available in ${delay}.**`,
    -3_600_000,
    at,
  );

const pr = (repo: string, number: number, title: string): PullRequest => ({
  repo: `acme/${repo}`,
  number,
  title,
  url: `https://github.com/acme/${repo}/pull/${number}`,
});

const prs = [
  pr("web", 517, "feat(checkout): pay with a saved card"),
  pr("api", 912, "fix(auth): refresh the token before it expires"),
  pr("mobile", 911, "feat(settings): a dark theme"),
  pr("api", 910, "fix(orders): one refund per order"),
  pr("web", 899, "docs: document the public API"),
];
const lateArrival = pr("web", 921, "feat(search): filter the results by date");
const CHANGE_AT = 8_000;
const DEMO_LENGTH_MS = 32_000;

let requestedAt: number | undefined;

type ReviewState = { head: string; reviews: Review[]; comments: Comment[] };

function status(target: PullRequest): PullRequestStatus {
  return target.number === 910 && elapsed() >= CHANGE_AT ? "merged" : "open";
}

function state(target: PullRequest): ReviewState {
  const t = elapsed();
  switch (target.number) {
    case 517:
      return t < 7_000
        ? { head: "a1", reviews: [], comments: [inProgress(-20_000)] }
        : { head: "a1", reviews: [review("a1", 6_500)], comments: [] };
    case 912:
      return { head: "b1", reviews: [review("b1", -600_000)], comments: [] };
    case 911: {
      if (requestedAt === undefined) return { head: "c1", reviews: [], comments: [rateLimited(-40_000, "50 seconds")] };
      const request = comment("octocat", REQUEST_BODY, requestedAt);
      if (t < requestedAt + 2_500) return { head: "c1", reviews: [], comments: [rateLimited(-40_000, "50 seconds"), request] };
      if (t < requestedAt + 6_000) {
        const triggered = comment(BOT_LOGIN, "Action performed: Review triggered.", requestedAt + 2_000);
        return { head: "c1", reviews: [], comments: [inProgress(requestedAt + 2_000), request, triggered] };
      }
      return { head: "c1", reviews: [review("c1", requestedAt + 6_000)], comments: [] };
    }
    case 910:
      return { head: "d2", reviews: [review("d1", -900_000)], comments: [] };
    case 921:
      return t < 16_000
        ? { head: "f1", reviews: [], comments: [inProgress(CHANGE_AT)] }
        : { head: "f1", reviews: [review("f1", 15_500)], comments: [] };
    default:
      return { head: "e1", reviews: [review("e1", -1_200_000)], comments: [] };
  }
}

const fakeGitHub: GitHub = {
  async listPullRequests() {
    await sleep(900);
    return elapsed() < CHANGE_AT ? prs : [...prs.filter((item) => item.number !== 910), lateArrival];
  },
  async fetchReviewState(target) {
    await sleep(300 + Math.random() * 700);
    return { ...state(target), status: status(target) };
  },
  async requestReview(target) {
    await sleep(900);
    requestedAt = elapsed();
    return `${target.url}#issuecomment-1234567890`;
  },
};

const app = render(
  <App
    options={{ org: "acme", author: "@me", since: "2026-09-21", watch: true, dryRun: false }}
    gitHub={fakeGitHub}
    timing={{ replyPollMs: 1_500, replyTimeoutMs: 30_000, watchPollMs: 3_000, listRefreshMs: 4_000 }}
  />,
);
setTimeout(() => app.unmount(), DEMO_LENGTH_MS);
await app.waitUntilExit();
