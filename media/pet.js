// @ts-check
"use strict";
/**
 * The pet (/pet): a small pixel companion over the chat's top right corner, with a corner of its own to live in. It
 * only watches what the panel already shows (waiting on the model, reading, searching, changing a file, asking you,
 * done, failed) and acts it out. Nothing about it reaches the model or leaves the window, and it's off until asked for.
 *
 * Everything is drawn here from text grids, a character a pixel, on one 44×34 canvas that the CSS shows at three times
 * the size: there are no image files. The panel loads this as a script (window.SolderPet); node loads it for its tests
 * and for the extension's list of names.
 */
(function (root, make) {
  const made = make();
  if (typeof module === "object" && module.exports) module.exports = made;
  else /** @type {any} */ (root).SolderPet = made;
})(typeof self !== "undefined" ? self : this, function () {
  /** The canvas, in the pet's own pixels, and where the pet's 16×16 body stands on it. */
  const W = 44, H = 34, PX = 22, PY = 12;
  /** A frame every 125 ms: eight a second. */
  const FRAME_MS = 125;
  /** How long it's pleased with a finished reply, and upset by a failed one, before it settles. */
  const DONE_MS = 3600, ERROR_MS = 6000;
  /** With nothing to do for this long, it falls asleep (typing in the box, or a reply, wakes it). */
  const SLEEP_AFTER_MS = 5 * 60 * 1000;
  /** With reduced motion asked for, it holds one pose: this frame (eyes open, the bubble's dots and marks showing). */
  const STILL_T = 11;
  /** What it can be doing. */
  const STATES = ["idle", "thinking", "reading", "searching", "writing", "waiting", "done", "error", "sleeping"];
  /** What each tool looks like, while it runs. A tool not here is read as looking at something. */
  const DOING = /** @type {Record<string, string>} */ ({ read_file: "reading", symbols: "reading", changes: "reading", problems: "reading",
    search: "searching", find_files: "searching", edit_file: "writing", write_file: "writing", move_item: "writing", remove_item: "writing" });
  /** Solid at the corner, thinner away from it: a pixel is drawn where the corner's strength beats its place in this pattern. */
  const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

  // ---- what it holds or says, the same for every pet
  const LAPTOP = [".kkkkkkkkkk.", ".kSSSSSSSSk.", ".kSSSaaSSSk.", ".kSSSSSSSSk.", "kGGGGGGGGGGk", "kkkkkkkkkkkk"];
  const BOOK = [".kkkkkkkkk.", "kBBBBkBBBBk", "kBtBBkBBtBk", "kBBBBkBBBBk", "kBBBBkBBBBk", ".kkkkkkkkk."];
  const GLASS = [".rrr...", "rgggr..", "rgwgr..", "rgggr..", ".rrrr..", "....hh.", ".....hh"];
  const BUBBLE = [".kkkkkkkkk.", "kWWWWWWWWWk", "kWWWWWWWWWk", "kWWWWWWWWWk", "kWWWWWWWWWk", "kWWWWWWWWWk", ".kkkkkkWWk.", ".......kWk.", "........kk."];
  const ASK = ["###", "..#", ".#.", "...", ".#."];
  const ALARM = [".#.", ".#.", ".#.", "...", ".#."];
  const Z = ["###", ".#.", "###"];
  const IRON = ["......t.", ".....s..", "....s...", "...HH...", "..HH....", ".HH.....", "kkkkk..."];
  const PLANT = ["..g.g..", ".gGgGg.", "gGgGgGg", ".gGGGg.", "..gGg..", "...g...", ".ppppp.", ".pPPPp.", "..ppp.."];
  const MOON = ["..mmm.", ".mm...", "mm....", "mm....", ".mm...", "..mmm."];
  const CLOUD = ["...cccc....ccccc....", ".cccccccccccccccccc.", "cccccccccccccccccccc", ".cccccccccccccccccc."];
  const STARS = [[12, 4], [20, 2], [28, 6], [33, 12], [9, 13], [16, 9], [41, 14], [24, 3], [5, 6], [42, 22]];
  const SPARKLES = [[19, 9], [41, 12], [18, 22], [42, 24], [30, 5]];
  const LIGHTS = ["#ffd166", "#ef6f8f", "#6ee7ff", "#9be36b"];
  const HOP = [0, -2, -4, -5, -4, -2, 0, -1, 0, 0, 0, 0, 0, -2, -3, -2, 0];

  /**
   * A way to put pixels on a canvas. @param {any} g a 2D drawing context
   */
  function brush(g) {
    /** @param {number} x @param {number} y @param {string} color @param {number} [alpha] */
    const px = (x, y, color, alpha) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      g.globalAlpha = alpha === undefined ? 1 : alpha;
      g.fillStyle = color;
      g.fillRect(x, y, 1, 1);
    };
    /** @param {string[]} rows @param {number} x @param {number} y @param {Record<string, string>} pal @param {number} [alpha] */
    const sprite = (rows, x, y, pal, alpha) => {
      for (let r = 0; r < rows.length; r++) for (let c = 0; c < rows[r].length; c++) { const color = pal[rows[r][c]]; if (color) px(x + c, y + r, color, alpha); }
    };
    /** @param {number} x0 @param {number} x1 @param {number} y @param {string} color @param {number} [alpha] */
    const line = (x0, x1, y, color, alpha) => { for (let x = x0; x <= x1; x++) px(x, y, color, alpha); };
    return { px, sprite, line };
  }

  /**
   * The pets: a body (16×16), where its eyes are, the middle of it, and a corner to live in. `tintLight` is the
   * corner's colour on a light theme; a pet without one keeps its dark corner there (the night sky is dark anywhere).
   * @type {Record<string, { name: string, cx: number, floats?: boolean, eyes: number[][], eye: string, hand: string, tint: string, tintLight?: string,
   *   pal: Record<string, string>, body: string[], tail?: Record<number, string>, scene: (b: ReturnType<typeof brush>, t: number, dark: boolean) => void }>}
   */
  const PETS = {
    bit: {
      name: "Bit", cx: 7, eyes: [[5, 5], [9, 5]], eye: "#6ee7ff", hand: "#c9d4e6", tint: "#1c3157", tintLight: "#c3d4ee",
      pal: { k: "#2a3554", L: "#c9d4e6", F: "#141c33", D: "#7f8fb0", a: "#ffb454" },
      body: [".......a........", ".......k........", "...kkkkkkkkk....", "..kLLLLLLLLLk...", "..kLFFFFFFFLk...", "..kLFFFFFFFLk...",
        "..kLFFFFFFFLk...", "..kLFFFFFFFLk...", "..kLLLLLLLLLk...", "...kkkkkkkkk....", "....kDDDDDk.....", "..kkkDDaDDkkk...",
        "..kLkDDDDDkLk...", "....kDDDDDk.....", "....kkk.kkk.....", "...kLLk.kLLk...."],
      // A workbench: a shelf, a soldering iron and its smoke, a trace on the wall with a light that blinks.
      scene({ px, sprite, line }, t, dark) {
        line(9, 43, 28, "#93a0b8"); line(9, 43, 29, "#566078"); line(9, 43, 30, "#414a60"); px(12, 31, "#414a60"); px(40, 31, "#414a60");
        sprite(IRON, 10, 21, { t: "#ff7a3d", s: dark ? "#d7deea" : "#8894ab", H: "#3d7be0", k: "#566078" });
        for (let i = 0; i < 3; i++) { const up = (t + i * 5) % 15; if (up < 11) px(16 + [0, 1, 1, 0, -1, -1][(up + i) % 6], 20 - up, dark ? "#c8d2e6" : "#5f6c85", 0.55 - up * 0.045); }
        line(30, 40, 3, "#3fae7a", 0.5); for (let y = 4; y <= 7; y++) px(40, y, "#3fae7a", 0.5);
        px(30, 3, "#e2b04a", 0.8); px(34, 3, "#e2b04a", 0.8);
        px(40, 8, Math.floor(t / 6) % 2 ? "#ff5a5a" : "#6b2a2a");
      },
    },
    flux: {
      name: "Flux", cx: 6, eyes: [[3, 6], [9, 6]], eye: "#2b1a10", hand: "#fff1dc", tint: "#40284d", tintLight: "#f0dcc8",
      pal: { k: "#5a3520", O: "#f0a04b", o: "#cf7f2e", W: "#fff1dc", p: "#e8798a" },
      body: ["................", "..k.......k.....", ".kOk.....kOk....", ".kOOkkkkkOOk....", ".kOOOoOoOOOk....", ".kOOOOOOOOOk....",
        ".kOOOOOOOOOk....", ".kOOOOpOOOOk....", ".kOOWWWWWOOk....", "..kOOOOOOOk.....", "..kOOOOOOOk..k..", ".kOOWWWWWOOk.kOk",
        ".kOOWWWWWOOk.kOk", ".kOOWWWWWOOkkOk.", ".kOkOOOOOkOkOk..", ".kkkkkkkkkkkk..."],
      tail: { 10: "..kOOOOOOOk...k.", 11: ".kOOWWWWWOOk..kO", 12: ".kOOWWWWWOOk.kOk" },
      // A shelf at home: a plant, and a string of lights.
      scene({ px, sprite, line }, t) {
        line(9, 43, 28, "#c08a55"); line(9, 43, 29, "#8a5a34"); line(9, 43, 30, "#6b4426");
        sprite(PLANT, 10, 19, { g: "#3f9d5a", G: "#6fce7f", p: "#b5573a", P: "#d2714e" });
        for (let x = 6; x <= 43; x++) {
          const y = 1 + Math.round(2.4 * Math.sin((x - 6) / 37 * Math.PI));
          px(x, y, "#2a1f33", 0.9);
          if (x % 6 === 2) { const i = Math.floor(x / 6); px(x, y + 1, LIGHTS[i % 4], (Math.floor(t / 5) + i) % 3 !== 0 ? 1 : 0.3); }
        }
      },
    },
    wisp: {
      name: "Wisp", cx: 7, floats: true, eyes: [[5, 5], [10, 5]], eye: "#2d2a55", hand: "#f4f1ff", tint: "#251f5c",
      pal: { k: "#6f6ba8", W: "#f4f1ff", b: "#ffb3c7", m: "#2d2a55" },
      body: ["................", ".....kkkkkk.....", "...kkWWWWWWkk...", "..kWWWWWWWWWWk..", "..kWWWWWWWWWWk..", ".kWWWWWWWWWWWWk.",
        ".kWWWWWWWWWWWWk.", ".kWWWWWWWWWWWWk.", ".kWWbWWmmWWbWWk.", ".kWWWWWWWWWWWWk.", ".kWWWWWWWWWWWWk.", ".kWWWWWWWWWWWWk.",
        ".kWWWWWWWWWWWWk.", ".kWWWkWWWWkWWWk.", ".kWWk.kWWk.kWWk.", "..kk...kk...kk.."],
      // A night sky: a moon, stars that twinkle, a cloud to float over.
      scene({ px, sprite }, t) {
        sprite(MOON, 37, 2, { m: "#ffe9a8" });
        STARS.forEach(([x, y], i) => px(x, y, "#ffffff", (t + i * 5) % 14 < 9 ? 0.9 : 0.25));
        sprite(CLOUD, 20, 29, { c: "#c9c6ee" }, 0.5);
      },
    },
  };
  const NAMES = Object.keys(PETS);

  /**
   * One frame. `t` counts frames since it was shown, and `since` the frames since it began what it's doing.
   * @param {any} ctx a 2D drawing context, 44×34
   * @param {{ pet: string, state: string, corner: boolean, light?: boolean, t: number, since: number }} o
   */
  function render(ctx, o) {
    const b = brush(ctx), { px, sprite, line } = b, { state, t, since } = o;
    const P = PETS[o.pet] || PETS.bit;
    const tint = o.light && P.tintLight ? P.tintLight : P.tint;
    // Whether what's behind the pet is dark: its corner (a dark one on a dark theme, or one that's dark anywhere), or a dark theme.
    const dark = o.corner ? tint === P.tint : !o.light;
    ctx.clearRect(0, 0, W, H);
    if (o.corner) {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const strength = 1.08 - Math.hypot((W - 1 - x) / W, y / H * 0.95);
        if (strength * 0.9 > (BAYER[y & 3][x & 3] + 0.5) / 16) px(x, y, tint, 0.85);
      }
      P.scene(b, t, dark);
    } else if (!P.floats) line(PX + P.cx - 5, PX + P.cx + 5, PY + 16, "#000000", 0.3);

    // Where it stands this frame: it breathes, taps along as it types, hops when it's done, and shakes at a failure.
    let ox = 0, oy = 0;
    if (P.floats) oy = Math.round(Math.sin(t / 5) * 1.5);
    else if (state === "writing") oy = Math.floor(t / 2) % 2 ? 0 : -1;
    else if (state !== "sleeping") oy = Math.floor(t / 7) % 2 ? 0 : -1;
    if (state === "done") oy = HOP[since] || 0;
    if (state === "error" && since < 8) ox = since % 2 ? 1 : -1;
    const x = PX + ox, y = PY + oy;
    const tail = P.tail;
    sprite(tail && Math.floor(t / 5) % 2 ? P.body.map((row, i) => tail[i] || row) : P.body, x, y, P.pal);
    if (o.pet === "bit" && state === "thinking" && Math.floor(t / 2) % 2) px(x + 7, y, "#fff2c0"); // its antenna, working

    // Its eyes: they blink, glance about, follow the page or the glass, and say how it went.
    let look = t % 34 < 2 ? "blink" : "open", dx = 0, dy = 0;
    if (state === "done") look = "happy"; else if (state === "error") look = "crossed"; else if (state === "sleeping") look = "closed";
    if (state === "idle") { const k = t % 80; if (k > 50 && k < 58) dx = 1; else if (k > 62 && k < 68) dx = -1; }
    if (state === "thinking") { dx = -1; dy = -1; }
    if (state === "waiting") dx = -1;
    if (state === "reading") { dy = 1; dx = [-1, -1, 0, 0, 1, 1, 0, 0][Math.floor(t / 2) % 8]; }
    if (state === "writing") dy = 1;
    const glassAt = Math.round(Math.sin(t / 4) * 3);
    if (state === "searching") dx = Math.sign(glassAt);
    for (const [ex, ey] of P.eyes) {
      const X = x + ex + dx, Y = y + ey + dy, c = P.eye;
      if (look === "open") { px(X, Y, c); px(X, Y + 1, c); }
      else if (look === "blink") px(X, Y + 1, c);
      else if (look === "closed") { px(X - 1, Y + 1, c); px(X, Y + 1, c); px(X + 1, Y + 1, c); }
      else if (look === "happy") { px(X - 1, Y + 1, c); px(X, Y, c); px(X + 1, Y + 1, c); }
      else { px(X - 1, Y, c); px(X + 1, Y, c); px(X, Y + 1, c); px(X - 1, Y + 2, c); px(X + 1, Y + 2, c); }
    }

    // What it's holding, or saying.
    if (state === "writing") {
      const lx = PX + P.cx - 6, ly = PY + 10, tap = Math.floor(t / 2) % 2, key = dark ? "#8be9fd" : "#1f8fb0";
      sprite(LAPTOP, lx, ly, { k: "#232c45", S: "#3a4664", G: "#9aa7c0", a: t % 8 < 5 ? "#8be9fd" : "#4fb6cc" });
      px(lx, ly + (tap ? 2 : 3), P.hand); px(lx + 11, ly + (tap ? 3 : 2), P.hand);
      for (let i = 0; i < 3; i++) if ((t + i * 3) % 5 < 3) px(lx + 2 + (t * 7 + i * 3) % 8, ly - 1 - (t + i * 2) % 3, key, 0.9);
    }
    if (state === "reading") {
      const bx = PX + P.cx - 5, by = PY + 10;
      sprite(BOOK, bx, by, { k: "#3a1f1a", B: "#b5473c", t: "#f3c98b" });
      px(bx - 1, by + 2, P.hand); px(bx + 11, by + 2, P.hand);
      if (t % 26 < 3) { px(bx + 5, by - 1, "#ffffff"); px(bx + 4 + t % 3, by - 2, "#ffffff", 0.8); } // a page turning
    }
    if (state === "searching") sprite(GLASS, PX + P.cx + 2 + glassAt, PY + 7, { r: dark ? "#e6ebf7" : "#6f7b93", g: "rgba(150,215,255,0.45)", w: "#ffffff", h: "#b07a4a" });
    if (state === "thinking" || state === "waiting" || state === "error") {
      sprite(BUBBLE, 9, 2, { k: "#2a3350", W: "#f5f7ff" });
      if (state === "thinking") { const dots = Math.floor(t / 3) % 4; for (let i = 0; i < dots; i++) { px(11 + i * 3, 5, "#2a3350"); px(12 + i * 3, 5, "#2a3350"); } }
      else if (state === "error") sprite(ALARM, 13, 3, { "#": "#e5484d" });
      else if (t % 10 < 7) sprite(ASK, 13, 3, { "#": "#c77d00" });
    }
    if (state === "done") SPARKLES.forEach(([sx, sy], i) => {
      const k = (t + i * 2) % 6, c = dark ? "#ffe27a" : "#d99a00";
      if (k > 3) return;
      px(sx, sy, c);
      if (k === 1 || k === 2) { px(sx - 1, sy, c, 0.8); px(sx + 1, sy, c, 0.8); px(sx, sy - 1, c, 0.8); px(sx, sy + 1, c, 0.8); }
    });
    if (state === "sleeping") for (let i = 0; i < 2; i++) {
      const up = (Math.floor(t / 2) + i * 5) % 10;
      sprite(Z, PX + 13 + i * 3 + (up >> 2), PY + 2 - up, { "#": dark ? "#dfe6ff" : "#5b6480" }, 1 - up / 11);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * What the panel's state says Solder is doing, or "" when it's doing nothing: asking you, running a step (by its
   * tool), writing out a change, or waiting on the model. The words a change is written out under are the extension's
   * (draftingLabel in src/panel.js). @param {any} state
   */
  function activityOf(state) {
    if (!state || !state.busy) return "";
    if (state.approvals && state.approvals.length) return "waiting";
    const items = state.chat && state.chat.items || [];
    for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === "step" && items[i].running) return DOING[items[i].name] || "reading";
    if (/^(Writing|Editing|Moving|Removing) /.test(String(state.status || ""))) return "writing";
    return "thinking";
  }

  /**
   * The pet on the panel's canvas: `update` with each state the panel shows, `wake` when you type. It draws only while
   * it's on, the chat is showing and the panel is visible; with reduced motion asked for it holds one pose per activity.
   * @param {any} canvas @param {any} win the window
   */
  function attach(canvas, win) {
    const doc = win.document, ctx = canvas.getContext("2d");
    const still = win.matchMedia("(prefers-reduced-motion: reduce)");
    /** @type {{ pet: string, corner: boolean } | null} which pet, while it's showing */
    let choice = null;
    let doing = "idle", began = 0, t = 0, timer = 0, rate = 0, quietSince = Date.now(), until = 0, chat = "", wasBusy = false;
    const draw = () => {
      if (!choice || !ctx) return;
      render(ctx, { pet: choice.pet, corner: choice.corner, state: doing, light: doc.body.classList.contains("vscode-light"), t: still.matches ? STILL_T : t, since: still.matches ? 99 : t - began });
    };
    /** @param {string} next */
    const set = (next) => {
      if (next === doing) return;
      doing = next; began = t;
      const now = Date.now();
      if (next === "idle") quietSince = now;
      until = next === "done" ? now + DONE_MS : next === "error" ? now + ERROR_MS : 0;
    };
    const tick = () => {
      t++;
      const now = Date.now();
      if (until && now >= until) set("idle");
      else if (doing === "idle" && now - quietSince >= SLEEP_AFTER_MS) set("sleeping");
      draw();
    };
    const pace = () => {
      const want = choice && !doc.hidden ? (still.matches ? 1000 : FRAME_MS) : 0;
      if (want !== rate) { if (timer) win.clearInterval(timer); timer = want ? win.setInterval(tick, want) : 0; rate = want; }
      canvas.classList.toggle("hidden", !choice);
      draw();
    };
    doc.addEventListener("visibilitychange", pace);
    if (still.addEventListener) still.addEventListener("change", pace);
    return {
      /** @param {any} state the panel's state */
      update(state) {
        const p = state.pet, away = !!(state.setup || state.settings || state.projects);
        choice = p && p.on && !away && PETS[p.pet] ? { pet: p.pet, corner: p.corner !== false } : null;
        const now = activityOf(state), id = state.chat ? String(state.chat.id) : "";
        if (now) set(now);
        // A reply just ended, in the chat that was showing: pleased, or upset at a failure (a stop or a pause is neither).
        else if (wasBusy && id === chat) set(!state.error ? "done" : state.error.stopped || state.error.paused ? "idle" : "error");
        else if (doing !== "done" && doing !== "error" && doing !== "sleeping") set("idle");
        wasBusy = !!now; chat = id;
        pace();
      },
      wake() { if (doing === "sleeping") { set("idle"); draw(); } else if (doing === "idle") quietSince = Date.now(); },
      /** What it's doing now (for tests). */
      doing: () => doing,
      /** Whether it's showing (for tests). */
      shown: () => !!choice,
    };
  }

  return { W, H, NAMES, PETS, STATES, DOING, DONE_MS, ERROR_MS, SLEEP_AFTER_MS, PROPS: { LAPTOP, BOOK, GLASS, BUBBLE, ASK, ALARM, Z, IRON, PLANT, MOON, CLOUD }, render, activityOf, attach };
});
