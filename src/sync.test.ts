import assert from "node:assert/strict";
import { test } from "node:test";
import { planSync } from "./sync.js";

test("a new pull request in the search result is added", () => {
  assert.deepEqual(planSync([{ key: "a#1" }], ["a#1", "a#2"]), { added: ["a#2"], recheck: [] });
});

test("an open pull request that left the search result is checked again", () => {
  assert.deepEqual(planSync([{ key: "a#1" }, { key: "a#2" }], ["a#2"]), { added: [], recheck: ["a#1"] });
});

test("a pull request that left and stays out is not checked again", () => {
  assert.deepEqual(planSync([{ key: "a#1", left: "merged" }], []), { added: [], recheck: [] });
});

test("a draft that comes back to the search result is checked again", () => {
  assert.deepEqual(planSync([{ key: "a#1", left: "draft" }], ["a#1"]), { added: [], recheck: ["a#1"] });
});
