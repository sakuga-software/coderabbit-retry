import assert from "node:assert/strict";
import { test } from "node:test";
import { BOT_LOGIN, decide, parseDelay, type Comment, type Review } from "./decide.js";

const now = new Date("2026-09-23T09:00:00Z");
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000).toISOString();

const comment = (login: string, body: string, createdAgo: number, updatedAgo = createdAgo): Comment => ({
  user: { login },
  body,
  created_at: ago(createdAgo),
  updated_at: ago(updatedAgo),
});
const bot = (body: string, createdAgo: number, updatedAgo?: number) =>
  comment(BOT_LOGIN, body, createdAgo, updatedAgo);
const me = (body: string, createdAgo: number) => comment("octocat", body, createdAgo);

const summaryLimit =
  "<!-- summarize by coderabbit.ai --> <!-- rate limited by coderabbit.ai --> **Next included review available in 26 minutes.**";

const run = (comments: Comment[], reviews: Review[] = []) => decide({ head: "abc", reviews, comments, now });

test("the summary delay counts from its updated_at", () => {
  assert.deepEqual(run([bot(summaryLimit, 600)]), {
    kind: "wait",
    availableAt: new Date(now.getTime() + 16 * 60_000),
    delayGuessed: false,
  });
});

test("a chat reply to a request with extra text does not count as a request", () => {
  const decision = run([
    bot(summaryLimit, 2400),
    me("@coderabbitai review\n\nblabla", 600),
    bot("Analysis chain", 540),
  ]);
  assert.equal(decision.kind, "trigger");
});

test("a bare request without answer is pending", () => {
  assert.equal(run([bot(summaryLimit, 2400), me("@coderabbitai review", 60)]).kind, "pending");
});

test("a pending request expires after 15 minutes", () => {
  assert.equal(run([bot(summaryLimit, 2400), me("@coderabbitai review", 1000)]).kind, "trigger");
});

test("a delay in hours and minutes", () => {
  const decision = run([
    bot("Review rate limited. Your next included review will be available in 1 hour and 5 minutes.", 60),
  ]);
  assert.deepEqual(decision, {
    kind: "wait",
    availableAt: new Date(now.getTime() + 64 * 60_000),
    delayGuessed: false,
  });
});

test("a trigger reply after the rate limit lifts it", () => {
  const decision = run([
    bot("Review rate limited. available in 2 minutes.", 900),
    bot("Action performed Full review triggered.", 300),
  ]);
  assert.deepEqual(decision, { kind: "idle", limitLifted: true });
});

test("a review after the rate limit lifts it", () => {
  const review: Review = { user: { login: BOT_LOGIN }, commit_id: "old", submitted_at: ago(100) };
  assert.deepEqual(run([bot("Review rate limited. available in 2 minutes.", 900)], [review]), {
    kind: "idle",
    limitLifted: true,
  });
});

test("an edited summary uses its latest version", () => {
  const decision = run([bot("<!-- rate limited by coderabbit.ai --> available in 44 seconds.", 9000, 20)]);
  assert.equal(decision.kind, "wait");
});

test("an unreadable delay means one hour", () => {
  const decision = run([
    bot("<!-- rate limited by coderabbit.ai --> wait until the next included review is available", 600),
  ]);
  assert.deepEqual(decision, {
    kind: "wait",
    availableAt: new Date(now.getTime() + 50 * 60_000),
    delayGuessed: true,
  });
});

test("a review of the head commit wins", () => {
  const review: Review = { user: { login: BOT_LOGIN }, commit_id: "abc", submitted_at: ago(5000) };
  assert.equal(run([bot(summaryLimit, 60)], [review]).kind, "reviewed");
});

test("a summary in progress is busy", () => {
  assert.equal(run([bot("<!-- summarize by coderabbit.ai --> <!-- review in progress by coderabbit.ai -->", 60)]).kind, "busy");
});

test("parseDelay reads seconds", () => {
  assert.equal(parseDelay("available in 44 seconds."), 44_000);
  assert.equal(parseDelay("no delay here"), null);
});

test("a resolve reply after the rate limit does not lift it", () => {
  const decision = run([
    bot(summaryLimit, 600),
    bot("<details><summary>✅ Action performed</summary>\n\nComments resolved.\n\n</details>", 300),
  ]);
  assert.equal(decision.kind, "wait");
});

test("a finished full review after the rate limit lifts it", () => {
  const decision = run([
    bot("Review rate limited. available in 2 minutes.", 900),
    bot("<details><summary>✅ Action performed</summary>\n\nFull review finished.\n\n</details>", 300),
  ]);
  assert.deepEqual(decision, { kind: "idle", limitLifted: true });
});

const HEAD = "abc";
const coverage = (commit: string, kind = "reviewed") =>
  `<!-- final_review_risk_coverage:{"sourceCommitId":"${commit}","coveredCommitId":"${commit}","kind":"${kind}"} -->`;
const summary = (body: string, updatedAgo = 60) => bot(`<!-- This is an auto-generated comment: summarize by coderabbit.ai --> ${body}`, 9000, updatedAgo);

test("a finished review of the head in the summary counts, with no GitHub review", () => {
  assert.equal(run([summary(coverage(HEAD))]).kind, "reviewed");
});

test("a finished review of an older commit does not count", () => {
  assert.equal(run([summary(coverage("old"))]).kind, "idle");
});

test("a review in progress wins over the coverage of the head", () => {
  assert.equal(run([summary(`<!-- This is an auto-generated comment: review in progress by coderabbit.ai --> ${coverage(HEAD)}`)]).kind, "busy");
});

test("a coverage of another kind does not count", () => {
  assert.equal(run([summary(coverage(HEAD, "partial"))]).kind, "idle");
});

test("a skipped review gives its reason", () => {
  const body = "<!-- This is an auto-generated comment: skip review by coderabbit.ai -->\n> [!IMPORTANT]\n> ## Review skipped\n> \n> Bot user detected.\n> \n> To trigger a single review, invoke the `@coderabbitai review` command.";
  assert.deepEqual(run([summary(body)]), { kind: "skipped", reason: "Bot user detected" });
});

test("paused reviews on an unreviewed head give paused", () => {
  assert.equal(run([summary("<!-- This is an auto-generated comment: review paused by coderabbit.ai -->")]).kind, "paused");
});

test("paused reviews on a reviewed head give reviewed", () => {
  assert.equal(run([summary(`<!-- This is an auto-generated comment: review paused by coderabbit.ai --> ${coverage(HEAD)}`)]).kind, "reviewed");
});

test("a rate limit wins over a pause", () => {
  assert.equal(run([summary("<!-- review paused by coderabbit.ai --> <!-- rate limited by coderabbit.ai --> available in 26 minutes.", 60)]).kind, "wait");
});

test("no CodeRabbit comment and no review give unseen", () => {
  assert.equal(run([me("hello", 60)]).kind, "unseen");
});

test("a skip notice with its own title gives the title", () => {
  const body = "<!-- This is an auto-generated comment: skip review by coderabbit.ai -->\n\n> [!IMPORTANT]\n> ## Draft PR not reviewed\n> \n> Draft PRs are not automatically reviewed by default.";
  assert.deepEqual(run([summary(body)]), { kind: "skipped", reason: "Draft PR not reviewed" });
});

test("the skip reason ignores the headings before the notice", () => {
  const body = "## Walkthrough\n\nSome text.\n<!-- This is an auto-generated comment: skip review by coderabbit.ai -->\n> ## Review skipped\n> \n> Bot user detected.";
  assert.deepEqual(run([summary(body)]), { kind: "skipped", reason: "Bot user detected" });
});
