import assert from "node:assert/strict";
import { test } from "node:test";
import { createMouseParser, isMouseFragment, type MouseEvent } from "./mouse.js";

const parse = (...chunks: string[]) => {
  const events: MouseEvent[] = [];
  const feed = createMouseParser((event) => events.push(event));
  for (const chunk of chunks) feed(chunk);
  return events;
};

test("a left press is a click with 0-based coordinates", () => {
  assert.deepEqual(parse("\u001B[<0;30;8M"), [{ kind: "click", x: 29, y: 7 }]);
});

test("a release is not a click", () => {
  assert.deepEqual(parse("\u001B[<0;30;8m"), []);
});

test("the wheel codes give a direction", () => {
  assert.deepEqual(parse("\u001B[<64;5;5M\u001B[<65;5;5M"), [
    { kind: "wheel", direction: "up", x: 4, y: 4 },
    { kind: "wheel", direction: "down", x: 4, y: 4 },
  ]);
});

test("a report split across two chunks gives one click", () => {
  assert.deepEqual(parse("\u001B[<0;12", ";3M"), [{ kind: "click", x: 11, y: 2 }]);
});

test("a right click and a key press give nothing", () => {
  assert.deepEqual(parse("\u001B[<2;4;4M", "r", "\u001B[A"), []);
});

test("isMouseFragment spots the pieces that Ink passes to useInput", () => {
  for (const piece of ["[<0;30;8M", "[<0;12", ";3M", "<0;1;1m"]) assert.equal(isMouseFragment(piece), true, piece);
  for (const key of ["r", "o", "q", "3", ""]) assert.equal(isMouseFragment(key), false, key);
});

test("the parser tells when a chunk completes a report that an earlier chunk started", () => {
  const feed = createMouseParser(() => {});
  assert.equal(feed("\u001B[<0;12;3"), false);
  assert.equal(feed("m"), true);
  assert.equal(feed("\u001B[<0;4;4M"), false);
  assert.equal(feed("m"), false);
});

test("an unfinished report expires, so a later key does not complete it", () => {
  let clock = 1_000;
  const feed = createMouseParser(() => {}, () => clock);
  assert.equal(feed("\u001B[<0;12;3"), false);
  clock += 5_000;
  assert.equal(feed("m"), false);
});

test("a report split within the expiry still completes", () => {
  let clock = 1_000;
  const events: unknown[] = [];
  const feed = createMouseParser((event) => events.push(event), () => clock);
  feed("\u001B[<0;12;3");
  clock += 20;
  assert.equal(feed("M"), true);
  assert.deepEqual(events, [{ kind: "click", x: 11, y: 2 }]);
});
