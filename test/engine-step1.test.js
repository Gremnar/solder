// @ts-check
"use strict";
/**
 * The engine: an Assist reply that only says what it will do is asked once for its request; a whole-file write cuts
 * the task's earlier reads of that file; writes join edits in the reply's one problems check.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { Engine, outbound } = require("../src/engine.js");
const { TEXTS, ASSIST } = require("../src/prompt.js");

/** A fake gateway: each reply() takes the next scripted answer (an object, or a string: an Assist reply's raw text). */
function fakeClient(/** @type {any[]} */ script) {
  /** @type {any[]} */
  const sent = [];
  return {
    sent,
    async reply(/** @type {any} */ request) {
      // Titles go on their own, whenever: answered here, outside the script.
      if (String(request.messages.at(-1)?.content || "").startsWith("Give a short title")) return { content: "A title", calls: [], finishReason: "stop", usage: {}, credits: null };
      sent.push(JSON.parse(JSON.stringify(request.messages)));
      const next = script.shift();
      if (next === undefined) throw new Error("no more scripted replies");
      const value = typeof next === "string" ? { content: next } : next;
      if (value.content) request.onText?.(value.content);
      return { content: "", calls: [], finishReason: "stop", usage: { total_tokens: 10 }, credits: null, ...value };
    },
  };
}

const call = (/** @type {string} */ id, /** @type {string} */ name, /** @type {any} */ args) => ({ id, name, arguments: JSON.stringify(args) });
const request = (/** @type {any} */ args) => "\n\n```tool\n" + JSON.stringify(args) + "\n```";

function fakeHost(/** @type {Record<string, (args: any, ctx: any) => any>} */ tools = {}) {
  /** @type {any[]} */
  const ran = [];
  return {
    ran,
    async systemPrompt() { return "SYSTEM"; },
    needsApproval() { return null; },
    async runTool(/** @type {string} */ name, /** @type {any} */ args, /** @type {any} */ ctx) {
      ran.push([name, args, ctx.edit]);
      const fn = tools[name];
      return fn ? fn(args, ctx) : { output: `${name} ok`, summary: `${name} done` };
    },
    async save() {},
  };
}

function engine(/** @type {any} */ client, /** @type {any} */ host, /** @type {any[]} */ events = [], settings = {}) {
  return new Engine({ client, host, retryDelays: [0, 0], now: () => new Date(2026, 10, 4, 14, 5),
    settings: () => ({ model: "m", compactAt: 100_000, maxRounds: 30, ...settings }), onEvent: (event) => events.push(event) });
}

/** Settings that put model "m" on the Assist lane. */
const ASSIST_LANE = { assistModels: ["m"] };
const PROMISE = "I’ll inspect `processOrders` and the surrounding logging style before making the change.";

// ---------------------------------------------------------------- 1. a reply that only says what it will do

test("assist: a reply that only says what it will do is asked once for its request, and the task goes on", async () => {
  const host = fakeHost();
  const client = fakeClient([PROMISE, "Reading it." + request({ tool: "read_file", path: "src/orders.js" }), "Done: it logs each failure now."]);
  const chat = Engine.newChat();
  const events = [];
  await engine(client, host, events, ASSIST_LANE).ask(chat, "add logging to processOrders");
  assert.deepEqual(host.ran.map(([name]) => name), ["read_file"], "the request it then sent ran");
  const nudges = chat.messages.filter((m) => m.meta?.nudge);
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0].content, ASSIST.promised);
  assert.equal(nudges[0].role, "user");
  assert.ok(nudges[0].meta.auto && nudges[0].meta.resume, "said by Solder, and part of the same turn");
  assert.match(client.sent[1].at(-1).content, new RegExp(ASSIST.promised.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the model was told");
  assert.equal(chat.messages.at(-1).content, "Done: it logs each failure now.");
  assert.equal(events.filter((e) => e.type === "done").length, 1, "one turn, done once");
});

test("assist: asked only once a turn; a second such reply ends the turn as before", async () => {
  const host = fakeHost();
  const client = fakeClient([PROMISE, "Let me check the callers first."]);
  const chat = Engine.newChat();
  await engine(client, host, [], ASSIST_LANE).ask(chat, "add logging");
  assert.equal(chat.messages.filter((m) => m.meta?.nudge).length, 1);
  assert.equal(chat.messages.at(-1).content, "Let me check the callers first.");
  assert.deepEqual(host.ran, []);
  // Resume is the same turn: no second nudge.
  const again = fakeClient(["I'll locate the function now."]);
  await engine(again, host, [], ASSIST_LANE).resume(chat);
  assert.equal(chat.messages.filter((m) => m.meta?.nudge).length, 1, "still one: Resume carries on the same turn");
  // A new message is a new turn: it may be asked once again.
  const next = fakeClient([PROMISE, "Fine, here's my answer."]);
  await engine(next, host, [], ASSIST_LANE).ask(chat, "try again");
  assert.equal(chat.messages.filter((m) => m.meta?.nudge).length, 2);
});

test("assist: answers, questions, reports of what's done and offers are never taken for a promise", async () => {
  for (const reply of [
    "Fixed the typo in `src/greet.js`. I'll leave the tests as they are.",
    "Updated `src/orders.js`. Next I'll check nothing else.",
    "Should I update the tests too? I'll wait for your answer.",
    "The function returns the cart's total. If you want, I'll add a test for it.",
    "That's all the places it's used. Let me know and I'll rename them.",
    "It's defined in src/a.js on line 12.",
    "I'll show you the change:\n\n```js\nconst x = 1;\n```",
  ]) {
    const host = fakeHost();
    const chat = Engine.newChat();
    await engine(fakeClient([reply]), host, [], ASSIST_LANE).ask(chat, "go");
    assert.equal(chat.messages.filter((m) => m.meta?.nudge).length, 0, reply);
  }
});

test("assist: no nudge at the step limit, on the Tool lane, or with a message of yours waiting; read-only mode still gets one", async () => {
  // At the step limit (one step allowed, and it was used): the turn ends paused, as ever.
  let chat = Engine.newChat();
  await engine(fakeClient(["Reading." + request({ tool: "read_file", path: "a.js" }), PROMISE]), fakeHost(), [], { ...ASSIST_LANE, assistMaxRounds: 1 }).ask(chat, "go");
  assert.equal(chat.messages.filter((m) => m.meta?.nudge).length, 0);
  assert.ok(chat.limitHit);
  // The Tool lane: a reply without calls is its answer.
  chat = Engine.newChat();
  await engine(fakeClient([{ content: PROMISE }]), fakeHost()).ask(chat, "go");
  assert.equal(chat.messages.filter((m) => m.meta?.nudge).length, 0);
  // A message you typed meanwhile goes next anyway.
  chat = Engine.newChat();
  /** @type {any} */
  let e;
  const client = fakeClient([PROMISE]);
  const original = client.reply;
  let typed = false;
  client.reply = async (/** @type {any} */ req) => { if (!typed) { typed = true; e.steer("also this"); } return original(req); };
  const events = [];
  e = engine(client, fakeHost(), events, ASSIST_LANE);
  await e.ask(chat, "go");
  assert.equal(chat.messages.filter((m) => m.meta?.nudge).length, 0);
  assert.ok(events.some((ev) => ev.type === "steer-unsent" && ev.send), "your message goes as the next one");
  // Read-only mode can still read: asked as ever.
  chat = Engine.newChat();
  await engine(fakeClient([PROMISE, "Nothing to change."]), fakeHost(), [], { ...ASSIST_LANE, readOnly: true }).ask(chat, "go");
  assert.equal(chat.messages.filter((m) => m.meta?.nudge).length, 1);
});

// ---------------------------------------------------------------- 2. a whole-file write cuts earlier reads of it

test("a file written whole: the task's earlier reads of it become a line pointing at the write, and the write stays whole", async () => {
  const body = (/** @type {string} */ mark) => mark.repeat(3000);
  const host = fakeHost({
    read_file: (args) => args.path === "notes.md" ? { output: body("n"), summary: "Read notes.md · 300 lines", keep: "KEPT" }
      : args.path === "small.js" ? { output: "tiny", summary: "Read small.js · 1 line" }
      : { output: body(args.path[0]), summary: args.start_line ? `Read ${args.path} · lines ${args.start_line}–${args.end_line} of 400` : `Read ${args.path} · 400 lines` },
    write_file: (args) => args.path === "fail.js" ? { output: "Error: locked", summary: "x", failed: true } : { output: "Written.", summary: `Wrote ${args.path}` },
  });
  const content = "w".repeat(5000);
  const client = fakeClient([
    { calls: [call("1", "read_file", { path: "a.js" }), call("2", "read_file", { path: "a.js", start_line: 10, end_line: 50 }), call("3", "read_file", { path: "b.js" }),
      call("4", "read_file", { path: "notes.md" }), call("5", "read_file", { path: "small.js" }), call("6", "read_file", { path: "fail.js" })] },
    { calls: [{ ...call("w1", "write_file", { path: ".\\A.js", content }), extra: { google: { thought_signature: "S" } } }, call("w2", "write_file", { path: "notes.md", content }),
      call("w3", "write_file", { path: "small.js", content }), call("w4", "write_file", { path: "fail.js", content })] },
    { calls: [call("7", "read_file", { path: "a.js" })] },
    { content: "Done." },
  ]);
  const chat = Engine.newChat();
  await engine(client, host).ask(chat, "rewrite a");
  const of = (/** @type {string} */ id) => chat.messages.find((m) => m.tool_call_id === id);
  assert.deepEqual(["1", "2", "3", "4", "5", "6", "7"].map((id) => !!of(id)?.meta.writtenOver), [true, true, false, false, false, false, false],
    "both reads of a.js (any range, the path written another way) went; b.js, the read carrying what's kept, the tiny one, the failed write's file and the read after the write stay");
  const sent = (/** @type {number} */ step, /** @type {string} */ id) => client.sent[step].find((/** @type {any} */ m) => m.tool_call_id === id)?.content;
  assert.equal(sent(1, "1"), body("a"), "whole until the write");
  assert.equal(sent(2, "1"), TEXTS.writtenOver("Read a.js · 400 lines"));
  assert.equal(sent(2, "2"), TEXTS.writtenOver("Read a.js · lines 10–50 of 400"));
  assert.equal(sent(2, "3"), body("b"));
  assert.equal(sent(2, "6"), body("f") + "\n\n" + TEXTS.groupChanges, "(the reply read six files: its last result says to group the changes)");
  assert.equal(sent(3, "7"), body("a"), "a read after the write is whole");
  assert.doesNotMatch(TEXTS.writtenOver("x"), /read it again/i, "it doesn't send the model back to read");
  // The write itself is sent as it came, its text and thought signature with it.
  const writes = client.sent[2].find((/** @type {any} */ m) => m.tool_calls?.some((/** @type {any} */ c) => c.id === "w1")).tool_calls;
  assert.equal(JSON.parse(writes[0].function.arguments).content, content);
  assert.deepEqual(writes[0].extra_content, { google: { thought_signature: "S" } });

  // In a later task the write's long text is left out of what's sent: the read's stand-in no longer points at it.
  chat.messages.push({ role: "user", content: "next", meta: { typed: "next" } });
  const later = outbound(chat, "SYSTEM");
  assert.equal(later.find((m) => m.tool_call_id === "1").content, TEXTS.stub("Read a.js · 400 lines"));
});

test("a write that came before a read, or in another task, cuts nothing", async () => {
  const host = fakeHost({ read_file: (args) => ({ output: "r".repeat(3000), summary: `Read ${args.path} · 400 lines` }) });
  const client = fakeClient([
    { calls: [call("w", "write_file", { path: "a.js", content: "x" })] },
    { calls: [call("r", "read_file", { path: "a.js" })] },
    { content: "ok" },
    { calls: [call("r2", "read_file", { path: "b.js" })] },
    { content: "ok" },
    { calls: [call("w2", "write_file", { path: "b.js", content: "y" })] },
    { content: "ok" },
  ]);
  const chat = Engine.newChat();
  const e = engine(client, host);
  await e.ask(chat, "write then read");
  assert.ok(!chat.messages.find((m) => m.tool_call_id === "r").meta.stub);
  await e.ask(chat, "read b");
  await e.ask(chat, "write b");
  assert.ok(!chat.messages.find((m) => m.tool_call_id === "r2").meta.stub, "an earlier task's read is left to the budget, as ever");
});

test("assist: a whole-file write cuts the earlier reads there too (a carry-over sends their stand-ins)", async () => {
  const host = fakeHost({ read_file: () => ({ output: "r".repeat(3000), summary: "Read a.js · 400 lines" }) });
  const client = fakeClient([
    "Reading." + request({ tool: "read_file", path: "a.js" }),
    "Writing." + request({ tool: "write_file", path: "a.js", content: "new" }),
    "Done.",
  ]);
  const chat = Engine.newChat();
  await engine(client, host, [], ASSIST_LANE).ask(chat, "rewrite a");
  const read = chat.messages.find((m) => m.role === "tool" && m.meta.name === "read_file");
  assert.ok(read?.meta.writtenOver);
  assert.match(client.sent[2][0].content, new RegExp(TEXTS.writtenOver("Read a.js · 400 lines").slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

// ---------------------------------------------------------------- 3. writes join edits in the one problems check

test("writes join edits in a reply's one problems check, and a write's waiting check goes with it", async () => {
  const host = fakeHost();
  host.settleEdits = async (/** @type {string} */ group) => group === "w1"
    ? [{ path: "src/new.js", text: "\nNew problems in src/new.js", summary: " · 1 new problem" }, { path: "src/a.js", text: "\nNew problems in src/a.js", summary: " · 2 new problems" }] : [];
  const client = fakeClient([
    { calls: [call("w1", "write_file", { path: "src/new.js", content: "x" }), call("e1", "edit_file", { path: "src/a.js", old_text: "1", new_text: "2" }),
      call("r", "read_file", { path: "src/b.js" })] },
    { content: "ok" },
  ]);
  const chat = Engine.newChat();
  await engine(client, host).ask(chat, "go");
  assert.deepEqual(host.ran.map(([name, , edit]) => [name, edit]), [
    ["write_file", { group: "w1", more: true }], ["edit_file", { group: "w1", more: true }], ["read_file", undefined]]);
  const w1 = chat.messages.find((m) => m.tool_call_id === "w1");
  assert.match(w1.content, /New problems in src\/new\.js$/);
  assert.equal(w1.meta.summary, "write_file done · 1 new problem");
  assert.match(chat.messages.find((m) => m.tool_call_id === "e1").content, /New problems in src\/a\.js$/);

  // A write by itself in a reply is checked at once, as ever (and so is a write after a failed one to the same file: not run).
  host.ran.length = 0;
  await engine(fakeClient([{ calls: [call("s1", "write_file", { path: "src/a.js", content: "x" }), call("r", "read_file", { path: "src/a.js" })] }, { content: "ok" }]), host).ask(Engine.newChat(), "go");
  assert.deepEqual(host.ran[0][2], { group: "s1", more: false });
});
