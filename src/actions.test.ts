import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIONS, actionForKey, commandBody, moveSelection, refusal, reselect } from "./actions.js";

test("only merge uses m, the last byte of a mouse report, and it always asks for a confirmation", () => {
  const onM = ACTIONS.filter((action) => action.key.toLowerCase() === "m");
  assert.deepEqual(onM.map((action) => action.label), ["merge"]);
  assert.equal(onM[0]!.merge, true);
});

test("each key maps to one action", () => {
  assert.equal(new Set(ACTIONS.map((action) => action.key)).size, ACTIONS.length);
  assert.equal(actionForKey("a")?.command, "approve");
  assert.equal(actionForKey("x"), undefined);
});

test("the command body is a bare CodeRabbit command", () => {
  assert.equal(commandBody("full review"), "@coderabbitai full review");
});

test("open stays available on a merged pull request, a command does not", () => {
  const open = actionForKey("o")!;
  const approve = actionForKey("a")!;
  assert.equal(refusal(open, { left: true, dryRun: false }), null);
  assert.match(refusal(approve, { left: true, dryRun: false })!, /no longer open/);
  assert.match(refusal(approve, { left: false, dryRun: true })!, /dry run/);
  assert.equal(refusal(approve, { left: false, dryRun: false }), null);
});

test("the selection follows the key and stops at the ends", () => {
  const keys = ["a#1", "a#2", "a#3"];
  assert.equal(moveSelection(keys, undefined, 1), "a#1");
  assert.equal(moveSelection(keys, "a#2", 1), "a#3");
  assert.equal(moveSelection(keys, "a#3", 1), "a#3");
  assert.equal(moveSelection(keys, "a#1", -1), "a#1");
  assert.equal(moveSelection(["a#0", ...keys], "a#2", 1), "a#3");
  assert.equal(moveSelection([], "a#1", 1), undefined);
});

test("a visible selection stays", () => {
  assert.equal(reselect(["a", "b", "c"], ["a", "c"], "c"), "c");
});

test("a hidden selection goes to the next visible row", () => {
  assert.equal(reselect(["a", "b", "c", "d"], ["a", "d"], "b"), "d");
});

test("a hidden selection at the end goes to the previous visible row", () => {
  assert.equal(reselect(["a", "b", "c"], ["a"], "c"), "a");
});

test("no visible row gives no selection", () => {
  assert.equal(reselect(["a"], [], "a"), undefined);
  assert.equal(reselect(["a", "b"], ["b"], undefined), "b");
});

test("merge is refused on a pull request that is no longer open, and in a dry run", () => {
  const merge = actionForKey("m")!;
  assert.match(refusal(merge, { left: true, dryRun: false })!, /no longer open/);
  assert.match(refusal(merge, { left: false, dryRun: true })!, /dry run/);
  assert.equal(refusal(merge, { left: false, dryRun: false }), null);
});
