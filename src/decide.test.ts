import assert from "node:assert/strict";
import { test } from "node:test";
import { BOT_LOGIN, decide, parseDelay, quotaSignals, type Comment, type QuotaSignal, type Review } from "./decide.js";

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
    availableAt: new Date(now.getTime() + 16 * 60_000 + 30_000),
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
    availableAt: new Date(now.getTime() + 64 * 60_000 + 30_000),
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

const botReview = (state: string, commit = HEAD, agoSeconds = 100): Review => ({
  user: { login: BOT_LOGIN },
  commit_id: commit,
  submitted_at: ago(agoSeconds),
  state,
});

test("the last approval gives approved, and later comment reviews do not change it", () => {
  const reviews = [botReview("CHANGES_REQUESTED", "old", 900), botReview("APPROVED", HEAD, 600), botReview("COMMENTED", HEAD, 300)];
  assert.deepEqual(run([], reviews), { kind: "reviewed", verdict: "approved" });
});

test("changes requested after an approval give changes requested", () => {
  const reviews = [botReview("APPROVED", "old", 900), botReview("CHANGES_REQUESTED", HEAD, 300)];
  assert.deepEqual(run([], reviews), { kind: "reviewed", verdict: "changes requested" });
});

test("a head covered by the summary keeps the verdict of an older review", () => {
  const reviews = [botReview("CHANGES_REQUESTED", "old", 900)];
  assert.deepEqual(run([summary(coverage(HEAD))], reviews), { kind: "reviewed", verdict: "changes requested" });
});

test("only comment reviews give commented, and a dismissed review clears the verdict", () => {
  assert.deepEqual(run([], [botReview("COMMENTED")]), { kind: "reviewed", verdict: "commented" });
  assert.deepEqual(run([], [botReview("CHANGES_REQUESTED", HEAD, 600), botReview("DISMISSED", HEAD, 300)]), { kind: "reviewed", verdict: "commented" });
});

// Verbatim CodeRabbit texts, copied from sakuga-software pull requests on 2026-09-23.
const REFUSED_REPLY =
  "<!-- This is an auto-generated reply by CodeRabbit -->\n<!-- CodeRabbit review command invocation: v2:1fb9257b -->\n<details>\n<summary>⚠️ Action not completed</summary>\n\nReview rate limited.\n\n> Note: CodeRabbit is an incremental review system and does not re-review already reviewed commits. This command is applicable only when automatic reviews are paused.\n\n</details>";
const LIMIT_SUMMARY =
  "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n\n> [!WARNING]\n> ## Review limit reached\n> \n> **Next included review available in 34 seconds.**\n> \n> **Limit details:** You’ve used all 10 included reviews currently available. Your 27 included PR review attempts over the past 7 days set your current allowance at 10 reviews per hour.\n> \n> Enable **[usage-based reviews](https://app.coderabbit.ai/settings/billing)** in Billing to review now. Otherwise, wait until the next included review is available.";
const FREE_SUMMARY = (remaining: number) =>
  `<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n<!-- final_review_risk_coverage:{"sourceCommitId":"x","coveredCommitId":"x","kind":"reviewed"} -->\n**Included review availability:** Your plan provides up to 10 included reviews per hour; ${remaining} ${remaining === 1 ? "remains" : "remain"} after this review.`;

const decideWith = (comments: Comment[], quota?: QuotaSignal[]) =>
  decide({ head: HEAD, reviews: [], comments, now, pr: "acme/web#1", quota });

test("a refused command with no delay keeps the delay of the summary", () => {
  const decision = decideWith([bot(LIMIT_SUMMARY, 9000, 20), bot(REFUSED_REPLY, 10)]);
  assert.deepEqual(decision, { kind: "wait", availableAt: new Date(now.getTime() + 44_000), delayGuessed: false });
});

test("a refusal after the time that the summary gave falls back to a guess", () => {
  const decision = decideWith([bot(LIMIT_SUMMARY, 9000, 600), bot(REFUSED_REPLY, 60)]);
  assert.deepEqual(decision, { kind: "wait", availableAt: new Date(now.getTime() - 60_000 + 3_600_000), delayGuessed: true });
});

test("a newer notice on another pull request of the developer gives the time", () => {
  const own = [bot(REFUSED_REPLY, 300)];
  const quota = [...quotaSignals("acme/web#1", own, []), ...quotaSignals("acme/api#2", [bot(LIMIT_SUMMARY, 9000, 20)], [])];
  assert.deepEqual(decideWith(own, quota), {
    kind: "wait",
    availableAt: new Date(now.getTime() + 44_000),
    delayGuessed: false,
    source: { pr: "acme/api#2", at: new Date(now.getTime() - 20_000) },
  });
});

test("reviews left on another pull request after the refusal mean the quota is back", () => {
  const own = [bot(REFUSED_REPLY, 300)];
  const otherReviews = [botReview("APPROVED", "x", 100)];
  const quota = [...quotaSignals("acme/web#1", own, []), ...quotaSignals("acme/api#2", [bot(FREE_SUMMARY(1), 9000, 90)], otherReviews)];
  assert.deepEqual(decideWith(own, quota), {
    kind: "trigger",
    availableAt: new Date(now.getTime() - 100_000),
    source: { pr: "acme/api#2", at: new Date(now.getTime() - 100_000) },
  });
});

test("reviews left before the refusal do not free the quota", () => {
  const own = [bot(REFUSED_REPLY, 300)];
  const quota = [...quotaSignals("acme/web#1", own, []), ...quotaSignals("acme/api#2", [bot(FREE_SUMMARY(3), 9000, 400)], [botReview("APPROVED", "x", 400)])];
  assert.equal(decideWith(own, quota).kind, "wait");
});

test("quotaSignals dates a free signal by the review, not by a later edit of the summary", () => {
  const signals = quotaSignals("acme/api#2", [bot(FREE_SUMMARY(2), 9000, 10)], [botReview("APPROVED", "x", 500)]);
  assert.deepEqual(signals, [{ kind: "free", pr: "acme/api#2", at: now.getTime() - 500_000 }]);
});

test("quotaSignals ignores the remaining count of a summary that is not settled, and reads zero as a refusal", () => {
  assert.deepEqual(quotaSignals("p", [bot(`${LIMIT_SUMMARY} 2 remain after this review.`, 9000, 10)], []), [
    { kind: "limit", pr: "p", at: now.getTime() - 10_000, availableAt: now.getTime() + 54_000 },
  ]);
  assert.deepEqual(quotaSignals("p", [bot(FREE_SUMMARY(0), 9000, 10)], []), [{ kind: "refusal", pr: "p", at: now.getTime() - 9_000_000 }]);
});

test("a free signal older than a newer refusal does not free the quota", () => {
  const own = [bot(REFUSED_REPLY, 300)];
  const quota = [
    ...quotaSignals("acme/web#1", own, []),
    ...quotaSignals("acme/api#2", [bot(FREE_SUMMARY(1), 9000, 200)], [botReview("APPROVED", "x", 200)]),
    ...quotaSignals("acme/api#3", [bot(REFUSED_REPLY, 100)], []),
  ];
  assert.equal(decideWith(own, quota).kind, "wait");
});

test("quotaSignals dates a free signal with no review by the creation of the summary", () => {
  const signals = quotaSignals("acme/api#2", [bot(FREE_SUMMARY(2), 9000, 10)], []);
  assert.deepEqual(signals, [{ kind: "free", pr: "acme/api#2", at: now.getTime() - 9_000_000 }]);
});

const threadReply = (commit: string, agoSeconds: number): Review => ({ ...botReview("COMMENTED", commit, agoSeconds), body: "" });

test("a thread reply on the head is not a review of the head", () => {
  const reviews = [botReview("CHANGES_REQUESTED", "old", 900), threadReply(HEAD, 60)];
  assert.equal(run([summary("<!-- This is an auto-generated comment: rate limited by coderabbit.ai --> available in 13 minutes.", 30)], reviews).kind, "wait");
});

test("a thread reply after a rate limit does not lift it", () => {
  assert.equal(run([bot("Review rate limited. available in 20 minutes.", 300)], [threadReply(HEAD, 60)]).kind, "wait");
});

test("quotaSignals dates a free signal by the last real review, not by a later thread reply", () => {
  const reviews = [botReview("APPROVED", "x", 500), threadReply("x", 20)];
  assert.deepEqual(quotaSignals("acme/api#2", [bot(FREE_SUMMARY(2), 9000, 10)], reviews), [
    { kind: "free", pr: "acme/api#2", at: now.getTime() - 500_000 },
  ]);
});

test("a delay notice keeps a margin, because CodeRabbit rounds its delays", () => {
  // On coderabbit-retry#7, a request 4 s after "available in 13 minutes" was refused with "available in 17 seconds".
  const decision = run([bot(summaryLimit, 26 * 60 - 4)]);
  assert.equal(decision.kind, "wait");
  assert.equal(run([bot(summaryLimit, 26 * 60 + 31)]).kind, "trigger");
});
