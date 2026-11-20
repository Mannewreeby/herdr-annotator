// The inline comment box backed by a headless nvim running the person's own
// config. The box keeps Herdr's look; nvim does the editing (modes, mappings,
// registers, undo). See nvim-bridge.lua for the nvim side.

export const NVIM_SERVER = "annotator-nvim";

const NAMED = {
  escape: "Esc", enter: "CR", return: "CR", backspace: "BS", delete: "Del", tab: "Tab",
  left: "Left", right: "Right", up: "Up", down: "Down", home: "Home", end: "End",
  pageup: "PageUp", pagedown: "PageDown",
};

/** Text in nvim's key notation, so a typed or pasted "<" stays literal. */
export function escapeKeys(text) {
  return text.replace(/</g, "<lt>").replace(/\r?\n/g, "<CR>");
}

/**
 * nvim key notation for a GPUI key event, or null when nvim should not get it
 * (Cmd chords stay with Herdr and the mod).
 */
export function nvimKey(event) {
  const mods = event.modifiers ?? {};
  if (mods.platform) return null;
  const named = NAMED[event.key];
  if (named) return `<${mods.control ? "C-" : ""}${mods.shift ? "S-" : ""}${named}>`;
  if (mods.control) return event.key?.length === 1 ? `<C-${event.key}>` : null;
  const char = event.key_char;
  return char ? escapeKeys(char) : null;
}

/** What a finished command line means for the box: save, leave, discard, or null for nvim to run. */
export function boxCommand(cmdline) {
  const match = /^:\s*(w|wq|x|q)(!?)\s*$/.exec(cmdline ?? "");
  if (!match) return null;
  if (match[1] === "q") return match[2] ? "discard" : "leave";
  return "save";
}

/** The status line under the text, vim style. */
export function modeLabel(state) {
  if (!state) return "Starting nvim…";
  if (state.cmdline != null) return state.cmdline;
  const kind = state.mode[0];
  if (kind === "i") return "-- INSERT --";
  if (kind === "R") return "-- REPLACE --";
  if (kind === "v") return "-- VISUAL --";
  if (kind === "V") return "-- VISUAL LINE --";
  if (kind === "\u0016") return "-- VISUAL BLOCK --";
  return "Esc: back to the diff · :w save · :q! discard";
}

function visualSpan(state, row, length) {
  const v = state.visual;
  if (!v) return null;
  const [top, bottom] = v.row < state.row || (v.row === state.row && v.col <= state.col)
    ? [{ row: v.row, col: v.col }, { row: state.row, col: state.col }] : [{ row: state.row, col: state.col }, { row: v.row, col: v.col }];
  if (row < top.row || row > bottom.row) return null;
  const kind = state.mode[0];
  if (kind === "V") return [0, Math.max(length, 1)];
  if (kind === "\u0016") return [Math.min(v.col, state.col), Math.max(v.col, state.col) + 1];
  return [row === top.row ? top.col : 0, row === bottom.row ? bottom.col + 1 : Math.max(length, 1)];
}

/**
 * Splits one buffer line into runs to draw: plain text, visual selection, the
 * block cursor (normal/visual), or the insert-mode bar (an empty "bar" run).
 * @returns {{kind: "plain"|"visual"|"cursor"|"bar", text: string}[]}
 */
export function lineRuns(line, row, state) {
  const chars = [...line];
  const onCursor = state && state.cmdline == null && row === state.row;
  const bar = onCursor && /^[iR]/.test(state.mode);
  const span = state ? visualSpan(state, row, chars.length) : null;
  const cells = chars.length || !onCursor || bar ? chars : [" "];
  if (onCursor && !bar && state.col >= cells.length) cells.push(" ");
  const runs = [];
  cells.forEach((char, col) => {
    if (bar && col === state.col) runs.push({ kind: "bar", text: "" });
    const kind = onCursor && !bar && col === state.col ? "cursor" : span && col >= span[0] && col < span[1] ? "visual" : "plain";
    const last = runs.at(-1);
    if (last && last.kind === kind && kind !== "cursor") last.text += char; else runs.push({ kind, text: char });
  });
  if (bar && state.col >= cells.length) runs.push({ kind: "bar", text: "" });
  return runs;
}

/** Why a key goes to the mod instead of nvim, given nvim's last known state. */
export function interceptFor(event, state) {
  if (!state) return null;
  if (event.key === "escape" && state.mode === "n" && !state.blocking) return "leave";
  if (["enter", "return"].includes(event.key) && state.cmdline != null) return boxCommand(state.cmdline);
  return null;
}

/**
 * Talks to the shared headless nvim: keys go in through `nvim --server
 * --remote-send`, state comes back from the file the bridge writes on every
 * change. Nothing queries nvim while keys are in flight, so mappings like jk
 * keep working. One instance per mod copy; the nvim process is shared.
 */
export class NvimBox {
  /** @param {{exec: Function, hc: Function, readFile: Function, socket: string, bridge: string}} deps */
  constructor({ exec, hc, readFile, socket, bridge }) {
    this.exec = exec; this.hc = hc; this.readFile = readFile; this.socket = socket; this.bridge = bridge;
    this.stateFile = `${socket}.json`;
    this.active = false; this.state = null; this.events = []; this.running = false; this.ready = null;
  }

  async expr(expression) {
    const result = await this.exec("nvim", ["--server", this.socket, "--remote-expr", expression]);
    if (result.code !== 0) throw new Error((result.stderr || result.stdout || "nvim did not answer").trim());
    return result.stdout.trim();
  }

  async send(keys) {
    const result = await this.exec("nvim", ["--server", this.socket, "--remote-send", keys]);
    if (result.code !== 0) throw new Error((result.stderr || "nvim did not take the keys").trim());
  }

  async ping() {
    try { return (await this.expr("1")) === "1"; } catch { return false; }
  }

  /** Starts the shared nvim once; later calls reuse it while it answers. */
  ensureServer(cx) {
    this.ready ??= (async () => {
      if (await this.ping()) return;
      // A stale server (socket gone, nvim alive) would hold the name.
      await this.hc(["kill", NVIM_SERVER]).catch(() => {});
      await this.hc(["rm", NVIM_SERVER]).catch(() => {});
      await this.exec("rm", ["-f", this.socket]);
      const started = await this.hc(["run", "--json", "--bg", "--no-notify", "--name", NVIM_SERVER, "--",
        "nvim", "--headless", "-n", "--listen", this.socket, "-c", `luafile ${this.bridge}`]);
      if (started.code !== 0) throw new Error((started.stderr || started.stdout).trim());
      for (let tries = 0; tries < 100; tries++) {
        if (await this.ping()) return;
        await cx.sleep(50);
      }
      throw new Error("nvim did not start within 5 seconds");
    })();
    this.ready.catch(() => { this.ready = null; });
    return this.ready;
  }

  async load(text) {
    this.state = JSON.parse(await this.expr(`v:lua.AnnotatorBridge.load('${text.replace(/'/g, "''")}')`));
    return this.state;
  }

  /** Reads the pushed state; true when nvim published something new. */
  async readState() {
    try {
      const text = await this.readFile(this.stateFile);
      const state = text ? JSON.parse(text) : null;
      if (!state || state.seq === this.state?.seq) return false;
      this.state = state; return true;
    } catch { return false; }
  }

  /** Polls the state file after sending keys, until it changes or `ms` passes. */
  async awaitChange(cx, ms = 120) {
    for (const until = Date.now() + ms; Date.now() < until;) {
      if (await this.readState()) return true;
      await cx.sleep(10);
    }
    return false;
  }

  /**
   * Queues a key event. Keys reach nvim in order, quick typing is batched, and
   * Esc/Enter are checked against the state after the previous keys, so :w and
   * a second Esc land on the mod.
   * @param {{update: Function, save: Function, leave: Function, discard: Function, fail: Function}} actions
   */
  push(event, cx, actions) {
    this.events.push(event);
    if (!this.running) this.pump(cx, actions);
  }

  pump(cx, actions) {
    this.running = true;
    cx.spawn(async cx => {
      try {
        while (this.events.length && this.active) {
          const event = this.events.shift();
          const intercept = interceptFor(event, this.state);
          if (intercept) {
            if (this.state.cmdline != null) await this.send("<C-c>");
            this.events.length = 0;
            actions[intercept](cx);
            break;
          }
          let keys = nvimKey(event) ?? "";
          const quiet = next => !["escape", "enter", "return"].includes(next.key);
          if (quiet(event)) while (this.events.length && quiet(this.events[0])) keys += nvimKey(this.events.shift()) ?? "";
          if (!keys) continue;
          await this.send(keys);
          this.settled = await this.awaitChange(cx);
          if (this.settled) actions.update(cx);
        }
        // Nothing changed: maybe a half-typed mapping (the j of jk), which
        // resolves after timeoutlen without another key.
        if (this.active && this.settled === false && !this.events.length) {
          await cx.sleep((this.state?.timeout ?? 1000) + 40);
          if (this.active && await this.readState()) actions.update(cx);
        }
      } catch (error) {
        this.events.length = 0;
        actions.fail(error, cx);
      } finally {
        this.running = false;
        if (this.events.length && this.active) this.pump(cx, actions);
      }
    });
  }
}
