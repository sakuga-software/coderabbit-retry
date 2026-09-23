import { render } from "ink";
import { setTimeout as sleep } from "node:timers/promises";
import { App, type GitHub } from "../src/app.js";
import { BOT_LOGIN, REQUEST_BODY, type Comment, type Review } from "../src/decide.js";
import type { PullRequest } from "../src/github.js";

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
  repo: `sakuga-software/${repo}`,
  number,
  title,
  url: `https://github.com/sakuga-software/${repo}/pull/${number}`,
});

const prs = [
  pr("detectivebox-front", 517, "feat(infra): the migrations run before each deployment"),
  pr("suricarte", 912, "fix(sync): a lock stamp always moves forward"),
  pr("suricarte", 911, "feat(app): read a tooltip with a finger, by holding it"),
  pr("suricarte", 910, "fix(stock): one sale, one deduction"),
  pr("suricarte", 899, "feat(stock): a stale reading is no loss"),
];

let requestedAt: number | undefined;

function state(target: PullRequest): { head: string; reviews: Review[]; comments: Comment[] } {
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
      const request = comment("Mheaus", REQUEST_BODY, requestedAt);
      if (t < requestedAt + 2_500) return { head: "c1", reviews: [], comments: [rateLimited(-40_000, "50 seconds"), request] };
      if (t < requestedAt + 9_000) {
        const triggered = comment(BOT_LOGIN, "Action performed: Review triggered.", requestedAt + 2_000);
        return { head: "c1", reviews: [], comments: [inProgress(requestedAt + 2_000), request, triggered] };
      }
      return { head: "c1", reviews: [review("c1", requestedAt + 9_000)], comments: [] };
    }
    case 910:
      return { head: "d2", reviews: [review("d1", -900_000)], comments: [] };
    default:
      return { head: "e1", reviews: [review("e1", -1_200_000)], comments: [] };
  }
}

const fakeGitHub: GitHub = {
  async listPullRequests() {
    await sleep(900);
    return prs;
  },
  async fetchReviewState(target) {
    await sleep(300 + Math.random() * 700);
    return state(target);
  },
  async requestReview(target) {
    await sleep(900);
    requestedAt = elapsed();
    return `${target.url}#issuecomment-5791865880`;
  },
};

const app = render(
  <App
    options={{ org: "sakuga-software", author: "@me", since: "2026-09-21", watch: true, dryRun: false }}
    gitHub={fakeGitHub}
    timing={{ replyPollMs: 1_500, replyTimeoutMs: 30_000, watchPollMs: 3_000 }}
  />,
);
await app.waitUntilExit();
