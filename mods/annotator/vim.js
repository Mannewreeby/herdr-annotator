// Vim-style keyboard navigation for the review diff. Pure helpers: main.js
// owns focus, rendering and the review actions these keys trigger.

export const HALF_PAGE = 15;

/** Key context around comment textareas, and the action Escape dispatches there. */
export const COMMENT_CONTEXT = "AnnotatorComment";
export const LEAVE_COMMENT = "annotator_leave_comment";

export const VIM_HELP = "j/k move · gg/G top/bottom · Ctrl-d/u half page · ]c/[c change · ]q/[q file · "
  + "h/l old/new side · V visual · c/i/Enter comment · Esc normal · C file comment · K ask · "
  + "/ find, n/N · t split/unified · ZZ review & send";

function changed(item) {
  return item.kind === "add" || item.kind === "delete" || item.kind === "change";
}

function targetFor(item, split, side, only) {
  if (split) {
    const pick = only ?? (item[side]?.[side] != null ? side : item.new?.new != null ? "new" : item.old?.old != null ? "old" : null);
    const line = pick ? item[pick]?.[pick] : null;
    return line == null ? null : { side: pick, line };
  }
  const pick = only ?? (item.new != null ? "new" : item.old != null ? "old" : null);
  const line = pick ? item[pick] : null;
  return line == null ? null : { side: pick, line };
}

/**
 * Cursor stops in display order: one per selectable diff line.
 * @param {object[]} rows file.rows (unified) or splitRows(file.rows) (split)
 * @param {{split?: boolean, side?: "old"|"new", only?: "old"|"new"|null}} options
 *   side: preferred split column; only: stop only on lines of that side (visual mode)
 * @returns {{side: string, line: number, index: number, changed: boolean, breakBefore: boolean}[]}
 */
export function cursorTargets(rows, { split = false, side = "new", only = null } = {}) {
  const targets = [];
  let breakBefore = true;
  rows.forEach((item, index) => {
    const target = targetFor(item, split, side, only);
    if (!target) { breakBefore = true; return; }
    targets.push({ ...target, index, changed: changed(item), breakBefore });
    breakBefore = false;
  });
  return targets;
}

/** Index of the cursor among targets: the same line, else the same display row, else -1. */
export function findCursor(targets, cursor) {
  if (!cursor) return -1;
  const exact = targets.findIndex(t => t.side === cursor.side && t.line === cursor.line);
  if (exact >= 0) return exact;
  return targets.findIndex(t => t.index === cursor.index);
}

/** First stop of each run of changed lines; hunk headers split runs. */
export function changeStarts(targets) {
  return targets.flatMap((t, i) => t.changed && (i === 0 || !targets[i - 1].changed || t.breakBefore) ? [i] : []);
}

/**
 * Where a motion lands. Without a cursor every motion starts at the first change.
 * @param {string} motion down | up | top | bottom | line | half-down | half-up | next-change | prev-change
 */
export function moveIndex(targets, from, motion, count = 1) {
  if (!targets.length) return -1;
  const last = targets.length - 1, clamp = i => Math.max(0, Math.min(last, i));
  const starts = changeStarts(targets);
  if (from < 0 && !["top", "bottom", "line"].includes(motion)) return starts[0] ?? 0;
  switch (motion) {
    case "down": return clamp(from + count);
    case "up": return clamp(from - count);
    case "half-down": return clamp(from + HALF_PAGE * count);
    case "half-up": return clamp(from - HALF_PAGE * count);
    case "top": return 0;
    case "bottom": return last;
    case "line": {
      const at = targets.findIndex(t => t.side === "new" && t.line >= count);
      return at >= 0 ? at : last;
    }
    case "next-change": {
      const ahead = starts.filter(i => i > from);
      return ahead.length ? ahead[Math.min(count, ahead.length) - 1] : from;
    }
    case "prev-change": {
      const behind = starts.filter(i => i < from).reverse();
      return behind.length ? behind[Math.min(count, behind.length) - 1] : from;
    }
    default: return from;
  }
}

/** Selection between a visual anchor and the cursor, on the anchor's side. */
export function rangeSelection(anchor, cursor) {
  return { side: anchor.side, start: Math.min(anchor.line, cursor.line), end: Math.max(anchor.line, cursor.line), origin: anchor.line };
}

/** Whether a rendered diff item (unified row or split pair) holds the cursor line. */
export function holdsCursor(item, cursor, split) {
  if (!cursor || !item) return false;
  return split ? item[cursor.side]?.[cursor.side] === cursor.line : item[cursor.side] === cursor.line;
}

const PREFIXES = new Set(["g", "]", "[", "Z"]);
const SEQUENCES = {
  gg: { type: "move", motion: "top" },
  "]c": { type: "move", motion: "next-change" },
  "[c": { type: "move", motion: "prev-change" },
  "]q": { type: "file", delta: 1 },
  "[q": { type: "file", delta: -1 },
  ZZ: { type: "submit" },
};
const SINGLE = {
  j: { type: "move", motion: "down" },
  k: { type: "move", motion: "up" },
  G: { type: "move", motion: "bottom" },
  h: { type: "side", side: "old" },
  l: { type: "side", side: "new" },
  v: { type: "visual" },
  V: { type: "visual" },
  c: { type: "comment" },
  i: { type: "comment" },
  a: { type: "comment" },
  o: { type: "comment" },
  C: { type: "file-comment" },
  K: { type: "ask" },
  "/": { type: "find" },
  n: { type: "find-step", delta: 1 },
  N: { type: "find-step", delta: -1 },
  t: { type: "toggle-split" },
  "?": { type: "help" },
};
const NAMED = {
  down: SINGLE.j,
  up: SINGLE.k,
  left: SINGLE.h,
  right: SINGLE.l,
  enter: SINGLE.c,
  "ctrl-d": { type: "move", motion: "half-down" },
  "ctrl-u": { type: "move", motion: "half-up" },
  escape: { type: "escape" },
};

export const EMPTY_KEYS = Object.freeze({ count: "", pending: "" });

/**
 * Feeds one key into the normal-mode parser.
 * Characters come from key_char so layouts that type ] with Option still work.
 * @param {{count: string, pending: string}} state
 * @param {{key: string, keystroke: string, key_char?: string, modifiers?: object}} event
 * @returns {{state: {count: string, pending: string}, action: object|null, handled: boolean}}
 */
export function readKey(state, event) {
  const mods = event.modifiers ?? {};
  if (mods.platform) return { state: EMPTY_KEYS, action: null, handled: false };
  const named = NAMED[event.keystroke] ?? (event.keystroke === "return" ? NAMED.enter : null);
  const count = Number(state.count) || 1;
  if (named) return { state: EMPTY_KEYS, action: { ...named, count, counted: Boolean(state.count) }, handled: named.type !== "escape" };
  if (mods.control) return { state: EMPTY_KEYS, action: null, handled: false };
  const char = event.key_char;
  if (!char || char.length !== 1) return { state: EMPTY_KEYS, action: null, handled: Boolean(state.pending || state.count) };
  if (state.pending) {
    const action = SEQUENCES[state.pending + char];
    return { state: EMPTY_KEYS, action: action ? { ...action, count, counted: Boolean(state.count) } : null, handled: true };
  }
  if (/[1-9]/.test(char) || (char === "0" && state.count)) return { state: { count: state.count + char, pending: "" }, action: null, handled: true };
  if (PREFIXES.has(char)) return { state: { count: state.count, pending: char }, action: null, handled: true };
  if (char === "G" && state.count) return { state: EMPTY_KEYS, action: { type: "move", motion: "line", count, counted: true }, handled: true };
  const action = SINGLE[char];
  return { state: EMPTY_KEYS, action: action ? { ...action, count, counted: Boolean(state.count) } : null, handled: Boolean(action) };
}
