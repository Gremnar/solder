// @ts-check
"use strict";
/**
 * The pet (media/pet.js), under plain node: its drawings are well formed, every frame of every pet draws inside its
 * canvas, what it acts out follows the panel's state, and it comes and goes as it should.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const pet = require("../media/pet.js");
const prompt = require("../src/prompt.js");

/** A colour as the pet writes one. */
const COLOUR = /^(#[0-9a-f]{6}|rgba[(])/;

/** A canvas context that notes what's drawn on it. */
function surface() {
  const drawn = /** @type {{ x: number, y: number, w: number, h: number, color: any, alpha: any }[]} */ ([]);
  const ctx = { globalAlpha: 1, fillStyle: "", clearRect() { drawn.length = 0; },
    fillRect(/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ w, /** @type {number} */ h) { drawn.push({ x, y, w, h, color: ctx.fillStyle, alpha: ctx.globalAlpha }); } };
  return { ctx, drawn };
}

test("each pet's drawing is 16 by 16, in colours it has, with its eyes on it", () => {
  assert.deepEqual(pet.NAMES, ["bit", "flux", "wisp"]);
  for (const [key, p] of Object.entries(pet.PETS)) {
    assert.equal(p.body.length, 16, `${key}: 16 rows`);
    for (const row of [...p.body, ...Object.values(p.tail || {})]) {
      assert.equal(row.length, 16, `${key}: a row of 16 (${row})`);
      for (const ch of row) assert.ok(ch === "." || p.pal[ch], `${key}: "${ch}" has a colour`);
    }
    for (const [x, y] of p.eyes) assert.notEqual(p.body[y][x], ".", `${key}: an eye is on the body`);
  }
  for (const [name, rows] of Object.entries(pet.PROPS)) {
    for (const row of rows) assert.equal(row.length, rows[0].length, `${name}: every row as wide as the first`);
  }
});

test("every frame of every pet, in every state, draws whole pixels inside the canvas, in a real colour", () => {
  for (const name of pet.NAMES) for (const state of pet.STATES) for (const corner of [true, false]) for (const light of [false, true]) {
    const { ctx, drawn } = surface();
    for (let t = 0; t < 170; t++) {
      pet.render(ctx, { pet: name, state, corner, light, t, since: t % 40 });
      assert.ok(drawn.length > 60, `${name} ${state}: something is drawn`);
      const bad = drawn.find((d) => !(d.w === 1 && d.h === 1 && Number.isInteger(d.x) && Number.isInteger(d.y) && d.x >= 0 && d.y >= 0 && d.x < pet.W && d.y < pet.H) ||
        !(typeof d.color === "string" && COLOUR.test(d.color)) || !(d.alpha >= 0 && d.alpha <= 1));
      assert.equal(bad, undefined, `${name} ${state} t=${t}: ${JSON.stringify(bad)}`);
    }
  }
});

test("a pet nobody has heard of is drawn as the first one, not an error", () => {
  const { ctx, drawn } = surface();
  pet.render(ctx, { pet: "nobody", state: "idle", corner: true, t: 3, since: 3 });
  assert.ok(drawn.length > 60);
});

test("what it acts out follows the panel: asking you, the running step's tool, a change being written, or waiting on the model", () => {
  const step = (/** @type {string} */ name, running = true) => ({ kind: "step", name, running });
  assert.equal(pet.activityOf(null), "");
  assert.equal(pet.activityOf({ busy: false, status: "Thinking…", chat: { items: [step("search")] } }), "", "nothing, when no reply is under way");
  assert.equal(pet.activityOf({ busy: true, status: "Thinking…", chat: { items: [] } }), "thinking");
  assert.equal(pet.activityOf({ busy: true, status: "", chat: { items: [step("read_file", false)] } }), "thinking", "a finished step isn't what it's doing");
  assert.equal(pet.activityOf({ busy: true, approvals: [{ id: "a" }], chat: { items: [step("write_file")] } }), "waiting", "a question for you comes first");
  assert.equal(pet.activityOf({ busy: true, chat: { items: [step("read_file"), step("search")] } }), "searching", "the newest running step");
  assert.equal(pet.activityOf({ busy: true, chat: { items: [step("a_tool_made_later")] } }), "reading");
  // Every tool Solder has is acted out as one of the three.
  for (const tool of prompt.toolDefinitions(false, true)) {
    const name = tool.function.name;
    assert.ok(["reading", "searching", "writing"].includes(pet.DOING[name]), `${name} has an activity`);
    assert.equal(pet.activityOf({ busy: true, chat: { items: [step(name)] } }), pet.DOING[name]);
  }
  for (const name of ["edit_file", "write_file", "move_item", "remove_item"]) assert.equal(pet.DOING[name], "writing");
  // A change still being written out by the model: the extension's own words for it (draftingLabel in src/panel.js).
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "panel.js"), "utf8");
  for (const name of ["write_file", "edit_file", "move_item", "remove_item"]) {
    const word = new RegExp(`${name}: "(\\w+)"`).exec(source.slice(source.indexOf("function draftingLabel")));
    assert.ok(word, `draftingLabel has a word for ${name}`);
    assert.equal(pet.activityOf({ busy: true, status: `${word[1]} src/app.ps1 · 4.2 KB so far`, chat: { items: [] } }), "writing");
  }
  assert.equal(pet.activityOf({ busy: true, status: "Preparing read_file · 40 characters so far", chat: { items: [] } }), "thinking");
});

/** A stand-in window and canvas for the pet to live on. */
function world({ still = false } = {}) {
  const classes = new Set(["hidden"]);
  const timers = /** @type {Map<number, { run: () => void, ms: number }>} */ (new Map());
  let next = 1;
  const { ctx, drawn } = surface();
  const canvas = { getContext: () => ctx, classList: { toggle(/** @type {string} */ name, /** @type {boolean} */ on) { if (on) classes.add(name); else classes.delete(name); } } };
  const doc = { hidden: false, body: { classList: { contains: () => false } }, listeners: /** @type {(() => void)[]} */ ([]), addEventListener(/** @type {string} */ _type, /** @type {() => void} */ run) { doc.listeners.push(run); } };
  const win = { document: doc, matchMedia: () => ({ matches: still, addEventListener() {} }),
    setInterval(/** @type {() => void} */ run, /** @type {number} */ ms) { timers.set(next, { run, ms }); return next++; }, clearInterval(/** @type {number} */ id) { timers.delete(id); } };
  return { canvas, win, doc, timers, drawn, hidden: () => classes.has("hidden"), tick: () => { for (const timer of timers.values()) timer.run(); } };
}
const chat = (/** @type {any[]} */ items = [], id = "c1") => ({ id, items });
const ON = { on: true, pet: "flux", corner: true };

test("it's off until asked for, shows over the chat only, and stops drawing when it can't be seen", () => {
  const w = world();
  const p = pet.attach(w.canvas, w.win);
  p.update({ chat: chat(), busy: false });
  assert.ok(w.hidden() && !p.shown() && w.timers.size === 0, "no pet, no timer, with nothing saved");
  p.update({ chat: chat(), busy: false, pet: { on: false, pet: "bit", corner: true } });
  assert.ok(w.hidden() && w.timers.size === 0, "nor when it's off");
  p.update({ chat: chat(), busy: false, pet: ON });
  assert.ok(!w.hidden() && p.shown() && w.timers.size === 1 && w.drawn.length > 60, "on: shown, drawn, and moving");
  assert.equal([...w.timers.values()][0].ms, 125);
  for (const screen of ["setup", "settings", "projects"]) {
    p.update({ chat: chat(), busy: false, pet: ON, [screen]: {} });
    assert.ok(w.hidden() && w.timers.size === 0, `hidden on the ${screen} screen`);
  }
  p.update({ chat: chat(), busy: false, pet: ON });
  w.doc.hidden = true; w.doc.listeners.forEach((run) => run());
  assert.equal(w.timers.size, 0, "the panel out of sight: nothing is drawn");
  w.doc.hidden = false; w.doc.listeners.forEach((run) => run());
  assert.equal(w.timers.size, 1);
  p.update({ chat: chat(), busy: false, pet: { on: true, pet: "nobody", corner: true } });
  assert.ok(w.hidden(), "a pet it doesn't have isn't shown");
});

test("it follows a reply: working, pleased when it's done, upset at a failure, neither at a stop, and asleep after a long quiet", () => {
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    const w = world();
    const p = pet.attach(w.canvas, w.win);
    p.update({ chat: chat(), busy: false, pet: ON });
    assert.equal(p.doing(), "idle");
    p.update({ chat: chat(), busy: true, status: "Thinking…", pet: ON });
    assert.equal(p.doing(), "thinking");
    p.update({ chat: chat([{ kind: "step", name: "edit_file", running: true }]), busy: true, pet: ON });
    assert.equal(p.doing(), "writing");
    p.update({ chat: chat(), busy: false, pet: ON });
    assert.equal(p.doing(), "done");
    clock += pet.DONE_MS - 100; w.tick();
    assert.equal(p.doing(), "done", "still pleased");
    clock += 200; w.tick();
    assert.equal(p.doing(), "idle", "then it settles");

    p.update({ chat: chat(), busy: true, pet: ON });
    p.update({ chat: chat(), busy: false, error: { message: "The gateway said no." }, pet: ON });
    assert.equal(p.doing(), "error");
    clock += pet.ERROR_MS + 1; w.tick();
    assert.equal(p.doing(), "idle");

    for (const soft of [{ stopped: true }, { paused: true }]) {
      p.update({ chat: chat(), busy: true, pet: ON });
      p.update({ chat: chat(), busy: false, error: { message: "Stopped.", ...soft }, pet: ON });
      assert.equal(p.doing(), "idle", "a stop or a pause is neither");
    }

    // Another chat opened while this one works: nothing finished, so nothing to be pleased about.
    p.update({ chat: chat([], "c1"), busy: true, pet: ON });
    p.update({ chat: chat([], "c2"), busy: false, pet: ON });
    assert.equal(p.doing(), "idle");

    clock += pet.SLEEP_AFTER_MS - 1000; w.tick();
    assert.equal(p.doing(), "idle");
    p.wake(); // typing counts as company
    clock += pet.SLEEP_AFTER_MS - 1000; w.tick();
    assert.equal(p.doing(), "idle", "typing put sleep off");
    clock += 2000; w.tick();
    assert.equal(p.doing(), "sleeping");
    p.wake();
    assert.equal(p.doing(), "idle", "typing wakes it");
    clock += pet.SLEEP_AFTER_MS + 1; w.tick();
    p.update({ chat: chat([], "c2"), busy: true, pet: ON });
    assert.equal(p.doing(), "thinking", "and so does a reply");
  } finally { Date.now = realNow; }
});

test("with reduced motion asked for it holds one pose, redrawn only when what it's doing changes", () => {
  const w = world({ still: true });
  const p = pet.attach(w.canvas, w.win);
  p.update({ chat: chat(), busy: false, pet: ON });
  assert.equal([...w.timers.values()][0].ms, 1000, "a slow clock, for settling only");
  const frame = () => JSON.stringify(w.drawn);
  const first = frame();
  for (let i = 0; i < 20; i++) { w.tick(); assert.equal(frame(), first, "the same picture every time"); }
  p.update({ chat: chat(), busy: true, status: "Thinking…", pet: ON });
  assert.notEqual(frame(), first, "a new pose for a new activity");
});

test("the panel's page loads the pet's script under the same nonce, and has its canvas out of the way of clicks and screen readers", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "media", "panel.html"), "utf8");
  assert.match(html, /<script nonce="\{\{nonce\}\}" src="\{\{pet\}\}"><\/script>\s*<script nonce="\{\{nonce\}\}" src="\{\{js\}\}"><\/script>/);
  assert.match(html, /<div class="pet-spot" aria-hidden="true"><canvas id="pet" class="hidden" width="44" height="34"><\/canvas><\/div>\s*<main id="transcript"/);
  const css = fs.readFileSync(path.join(__dirname, "..", "media", "panel.css"), "utf8");
  assert.match(css, /#pet \{[^}]*pointer-events: none;/);
});
