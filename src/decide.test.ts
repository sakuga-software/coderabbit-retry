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
const me = (body: string, createdAgo: number) => comment("Mheaus", body, createdAgo);

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
