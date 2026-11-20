import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_KEYS, readKey, cursorTargets, findCursor, changeStarts, moveIndex, rangeSelection, holdsCursor } from "../mods/annotator/vim.js";
import { splitRows } from "../mods/annotator/review.js";

// A two-hunk diff of src/pricing.rs: a one-line rewrite, then an added block.
const rows = [
  { kind: "hunk", text: "@@ -10,4 +10,4 @@ fn total(order: &Order) -> u64 {" },
  { kind: "context", old: 10, new: 10, text: "    let base = order.subtotal();" },
  { kind: "delete", old: 11, text: "    let fee = base / 10;" },
  { kind: "add", new: 11, text: "    let fee = service_fee(base);" },
  { kind: "context", old: 12, new: 12, text: "    base + fee" },
  { kind: "hunk", text: "@@ -40,2 +40,5 @@" },
  { kind: "context", old: 40, new: 40, text: "fn service_fee(base: u64) -> u64 {" },
  { kind: "add", new: 41, text: "    if base == 0 {" },
  { kind: "add", new: 42, text: "        return 0;" },
  { kind: "add", new: 43, text: "    }" },
  { kind: "context", old: 41, new: 44, text: "    base / 10" },
];

const key = (char, modifiers = {}) => ({ key: char.toLowerCase(), keystroke: char, key_char: char, modifiers });
const press = keys => {
  let state = EMPTY_KEYS, last = null;
  for (const k of keys) last = readKey(state, typeof k === "string" ? key(k) : k), state = last.state;
  return last;
};

test("normal-mode keys parse into motions, counts and two-key sequences", () => {
  assert.deepEqual(press(["j"]).action, { type: "move", motion: "down", count: 1, counted: false });
  assert.deepEqual(press(["1", "2", "k"]).action, { type: "move", motion: "up", count: 12, counted: true });
  assert.equal(press(["g", "g"]).action.motion, "top");
  assert.equal(press(["4", "2", "G"]).action.motion, "line");
  assert.equal(press(["]", "c"]).action.motion, "next-change");
  assert.deepEqual(press(["[", "q"]).action, { type: "file", delta: -1, count: 1, counted: false });
  assert.equal(press(["Z", "Z"]).action.type, "submit");
  assert.equal(press([{ key: "d", keystroke: "ctrl-d", modifiers: { control: true } }]).action.motion, "half-down");
  assert.equal(press([{ key: "enter", keystroke: "enter" }]).action.type, "comment");
});

test("command chords and unknown keys pass through to Herdr and the mod", () => {
  const copy = readKey(EMPTY_KEYS, { key: "c", keystroke: "cmd-c", key_char: "c", modifiers: { platform: true } });
  assert.equal(copy.handled, false);
  assert.equal(readKey(EMPTY_KEYS, key("x")).handled, false);
  // Escape is offered to the mod's own handler unless visual mode claims it.
  const escape = readKey(EMPTY_KEYS, { key: "escape", keystroke: "escape" });
  assert.equal(escape.action.type, "escape");
  assert.equal(escape.handled, false);
  // A broken sequence is swallowed rather than typed elsewhere.
  assert.deepEqual(press(["g", "x"]), { state: EMPTY_KEYS, action: null, handled: true });
});

test("] typed with Option on Nordic layouts still starts a sequence", () => {
  const bracket = { key: "9", keystroke: "alt-9", key_char: "]", modifiers: { alt: true } };
  let { state } = readKey(EMPTY_KEYS, bracket);
  assert.equal(readKey(state, key("c")).action.motion, "next-change");
});

test("unified cursor stops on every source line and skips hunk headers", () => {
  const targets = cursorTargets(rows);
  assert.deepEqual(targets.map(t => `${t.side}:${t.line}`),
    ["new:10", "old:11", "new:11", "new:12", "new:40", "new:41", "new:42", "new:43", "new:44"]);
  // ]c lands on the deletion of the first change and the first added line of the second.
  assert.deepEqual(changeStarts(targets).map(i => `${targets[i].side}:${targets[i].line}`), ["old:11", "new:41"]);
});

test("motions move, clamp and jump between changes", () => {
  const targets = cursorTargets(rows);
  const at = cursor => findCursor(targets, cursor);
  const start = at({ side: "new", line: 10 });
  assert.equal(moveIndex(targets, -1, "down"), 1, "the first motion lands on the first change");
  assert.equal(targets[moveIndex(targets, start, "down", 3)].line, 12);
  assert.equal(moveIndex(targets, start, "up"), 0, "k at the top stays put");
  assert.equal(targets[moveIndex(targets, start, "next-change")].line, 11);
  assert.equal(targets[moveIndex(targets, start, "next-change", 2)].line, 41);
  assert.equal(targets[moveIndex(targets, targets.length - 1, "prev-change")].line, 41);
  assert.equal(targets[moveIndex(targets, start, "line", 42)].line, 42, "42G goes to new line 42");
  assert.equal(moveIndex(targets, start, "bottom"), targets.length - 1);
  assert.equal(moveIndex(targets, start, "half-down"), targets.length - 1);
});

test("visual mode stays on one side and selects the range between anchor and cursor", () => {
  const added = cursorTargets(rows, { only: "new" });
  assert.ok(added.every(t => t.side === "new"));
  assert.ok(!added.some(t => t.side === "old" && t.line === 11), "the deleted line is skipped");
  assert.deepEqual(rangeSelection({ side: "new", line: 43 }, { side: "new", line: 41 }), { side: "new", start: 41, end: 43, origin: 43 });
});

test("split view uses the preferred column and falls back where it is empty", () => {
  const pairs = splitRows(rows);
  const newSide = cursorTargets(pairs, { split: true, side: "new" });
  const oldSide = cursorTargets(pairs, { split: true, side: "old" });
  const change = pairs.findIndex(p => p.kind === "change");
  assert.deepEqual(newSide.find(t => t.index === change), { side: "new", line: 11, index: change, changed: true, breakBefore: false });
  assert.equal(oldSide.find(t => t.index === change).line, 11);
  assert.equal(oldSide.find(t => t.index === change).side, "old");
  // Added-only pairs have no old line, so the old column falls back to the new one.
  assert.equal(oldSide.find(t => t.line === 42).side, "new");
  assert.ok(holdsCursor(pairs[change], { side: "old", line: 11 }, true));
  assert.ok(!holdsCursor(pairs[change], { side: "new", line: 12 }, true));
  assert.ok(holdsCursor(rows[2], { side: "old", line: 11 }, false));
});
