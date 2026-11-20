import test from "node:test";
import assert from "node:assert/strict";
import { nvimKey, boxCommand, modeLabel, lineRuns, interceptFor } from "../mods/annotator/nvim-box.js";

const key = (key, extra = {}) => ({ key, keystroke: key, key_char: key.length === 1 ? key : undefined, modifiers: {}, ...extra });

test("GPUI keys become nvim key notation; Cmd chords stay with Herdr", () => {
  assert.equal(nvimKey(key("x")), "x");
  assert.equal(nvimKey(key("<")), "<lt>");
  assert.equal(nvimKey(key("escape")), "<Esc>");
  assert.equal(nvimKey(key("enter")), "<CR>");
  assert.equal(nvimKey(key("backspace")), "<BS>");
  assert.equal(nvimKey({ key: "r", keystroke: "ctrl-r", modifiers: { control: true } }), "<C-r>");
  assert.equal(nvimKey({ key: "tab", keystroke: "shift-tab", modifiers: { shift: true } }), "<S-Tab>");
  assert.equal(nvimKey({ key: "9", keystroke: "alt-9", key_char: "]", modifiers: { alt: true } }), "]", "Option-typed characters stay characters");
  assert.equal(nvimKey({ key: "c", keystroke: "cmd-c", key_char: "c", modifiers: { platform: true } }), null);
});

test(":w-family saves, :q leaves with the draft, :q! discards, other commands run in nvim", () => {
  for (const cmd of [":w", ":wq", ":x", ":w!", ":wq!"]) assert.equal(boxCommand(cmd), "save", cmd);
  assert.equal(boxCommand(":q"), "leave");
  assert.equal(boxCommand(":q!"), "discard");
  assert.equal(boxCommand(":s/foo/bar/"), null);
  assert.equal(boxCommand("/fee"), null);
});

test("Esc goes to the mod only from settled normal mode; Enter only on a command line", () => {
  assert.equal(interceptFor(key("escape"), { mode: "n", blocking: false }), "leave");
  assert.equal(interceptFor(key("escape"), { mode: "i", blocking: false }), null);
  assert.equal(interceptFor(key("escape"), { mode: "no", blocking: false }), null, "Esc cancels a pending operator in nvim");
  assert.equal(interceptFor(key("enter"), { mode: "c", cmdline: ":wq" }), "save");
  assert.equal(interceptFor(key("enter"), { mode: "i" }), null);
});

test("the status line reads like vim's", () => {
  assert.equal(modeLabel({ mode: "i" }), "-- INSERT --");
  assert.equal(modeLabel({ mode: "V" }), "-- VISUAL LINE --");
  assert.equal(modeLabel({ mode: "c", cmdline: ":w" }), ":w");
  assert.match(modeLabel({ mode: "n" }), /Esc: back to the diff/);
});

test("lines split into runs for the block cursor, insert bar and visual selection", () => {
  const normal = { mode: "n", row: 0, col: 4, lines: ["Use a constant"] };
  assert.deepEqual(lineRuns("Use a constant", 0, normal), [{ kind: "plain", text: "Use " }, { kind: "cursor", text: "a" }, { kind: "plain", text: " constant" }]);
  assert.deepEqual(lineRuns("", 0, { mode: "n", row: 0, col: 0 }), [{ kind: "cursor", text: " " }], "an empty line still shows the cursor");
  assert.deepEqual(lineRuns("abc", 0, { mode: "i", row: 0, col: 3 }), [{ kind: "plain", text: "abc" }, { kind: "bar", text: "" }]);
  const visual = { mode: "v", row: 0, col: 6, visual: { row: 0, col: 4 } };
  assert.deepEqual(lineRuns("Use a constant", 0, visual), [{ kind: "plain", text: "Use " }, { kind: "visual", text: "a " }, { kind: "cursor", text: "c" }, { kind: "plain", text: "onstant" }]);
  const lines = { mode: "V", row: 1, col: 0, visual: { row: 0, col: 2 } };
  assert.deepEqual(lineRuns("first", 0, lines), [{ kind: "visual", text: "first" }]);
  assert.deepEqual(lineRuns("other", 3, lines), [{ kind: "plain", text: "other" }]);
});
