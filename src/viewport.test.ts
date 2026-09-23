import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleRange } from "./viewport.js";

const rows = (count: number, height = 3) => Array.from({ length: count }, () => height);

test("all the rows show when they fit", () => {
  assert.deepEqual(visibleRange(rows(4), 3, 20, 0), { start: 0, end: 4 });
});

test("the range scrolls down to show the selected row", () => {
  assert.deepEqual(visibleRange(rows(10), 5, 9, 0), { start: 3, end: 6 });
});

test("the range stays still while the selection moves inside it", () => {
  assert.deepEqual(visibleRange(rows(10), 4, 9, 3), { start: 3, end: 6 });
});

test("the range scrolls up to show the selected row", () => {
  assert.deepEqual(visibleRange(rows(10), 1, 9, 3), { start: 1, end: 4 });
});

test("a taller row counts its extra line", () => {
  assert.deepEqual(visibleRange([3, 4, 3], 2, 7, 0), { start: 1, end: 3 });
});

test("the range fills the space after the list shrinks", () => {
  assert.deepEqual(visibleRange(rows(4), 3, 12, 2), { start: 0, end: 4 });
});

test("one row shows even if it does not fit", () => {
  assert.deepEqual(visibleRange(rows(3, 5), 1, 2, 0), { start: 1, end: 2 });
});
