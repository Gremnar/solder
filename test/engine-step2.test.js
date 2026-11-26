// @ts-check
"use strict";
/**
 * The engine, step 2: the Tool lane's cue to make independent changes together after a multi-file read; a change refused
 * before it ran stops what was built on it; an Assist reply cut off partway runs the requests that arrived whole; a
 * reply cut at the output limit is marked incomplete and ends with Resume.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { Engine } = require("../src/engine.js");
const { GatewayError } = require("../src/gateway.js");
const { TEXTS, ASSIST } = require("../src/prompt.js");
const { fakeAssist } = require("./fake-assist.js");
const { GatewayClient } = require("../src/gateway.js");

/** A fake gateway: each reply() takes the next scripted answer (an object, a string: an Assist reply's raw text, or an Error to throw). */
function fakeClient(/** @type {any[]} */ script) {
  /** @type {any[]} */
  const sent = [];
  return {
    sent,
    async reply(/** @type {any} */ request) {
      if (String(request.messages.at(-1)?.content || "").startsWith("Give a short title")) return { content: "A title", calls: [], finishReason: "stop", usage: {}, credits: null };
      sent.push(JSON.parse(JSON.stringify(request.messages)));
      const next = script.shift();
      if (next === undefined) throw new Error("no more scripted replies");
      if (next instanceof Error) { if (/** @type {any} */ (next).partial) request.onText?.(/** @type {any} */ (next).partial); throw next; }
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
      ran.push([name, args]);
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

const ASSIST_LANE = { assistModels: ["m"] };
const reads = (/** @type {string[]} */ paths, prefix = "r") => ({ calls: paths.map((p, n) => call(`${prefix}${n}`, "read_file", { path: p })) });

// ---------------------------------------------------------------- 1. the cue to make independent changes together

test("tool lane: after a reply that read three or more files, its last result says to make independent changes together, once a task", async () => {
  const client = fakeClient([
    reads(["src/a.js", "src/b.js", "./src/A.js", "src/c.js"]),
    reads(["src/d.js", "src/e.js", "src/f.js"], "s"),
    { content: "Done." },
  ]);
  const chat = Engine.newChat();
  await engine(client, fakeHost()).ask(chat, "five changes");
  const results = chat.messages.filter((m) => m.role === "tool");
  assert.ok(results[3].content.endsWith("\n\n" + TEXTS.groupChanges), "on the last result of the reply");
  assert.ok(!results[2].content.includes(TEXTS.groupChanges));
  assert.equal(chat.messages.filter((m) => m.role === "tool" && m.content.includes(TEXTS.groupChanges)).length, 1, "once a task");
  assert.ok(client.sent[1].at(-1).content.endsWith(TEXTS.groupChanges), "the model was told");
  // A new task may be told again.
  await engine(fakeClient([reads(["x.js", "y.js", "z.js"]), { content: "ok" }]), fakeHost()).ask(chat, "again");
  assert.equal(chat.messages.filter((m) => m.role === "tool" && m.content.includes(TEXTS.groupChanges)).length, 2);
});

test("tool lane: no cue for fewer than three different files, a reply that also changed something, read-only mode, or the Assist lane", async () => {
  const told = (/** @type {any} */ chat) => chat.messages.some((/** @type {any} */ m) => m.role === "tool" && m.content.includes(TEXTS.groupChanges));
  let chat = Engine.newChat();
  await engine(fakeClient([reads(["a.js", "b.js", "a.js"]), { content: "ok" }]), fakeHost()).ask(chat, "go");
  assert.ok(!told(chat), "two different files");
  chat = Engine.newChat();
  await engine(fakeClient([{ calls: [call("1", "read_file", { path: "a.js" }), call("2", "read_file", { path: "b.js" }), call("3", "read_file", { path: "c.js" }),
    call("4", "edit_file", { path: "d.js", old_text: "1", new_text: "2" })] }, { content: "ok" }]), fakeHost()).ask(chat, "go");
  assert.ok(!told(chat), "it already made a change");
  chat = Engine.newChat();
  await engine(fakeClient([reads(["a.js", "b.js", "c.js"]), { content: "ok" }]), fakeHost(), [], { readOnly: true }).ask(chat, "go");
  assert.ok(!told(chat), "read-only mode");
  chat = Engine.newChat();
  await engine(fakeClient(["Reading." + request({ tool: "read_file", path: "a.js" }) + request({ tool: "read_file", path: "b.js" }) + request({ tool: "read_file", path: "c.js" }), "ok"]),
    fakeHost(), [], ASSIST_LANE).ask(chat, "go");
  assert.ok(!told(chat), "the Assist lane");
  // Reads that failed don't count.
  chat = Engine.newChat();
  await engine(fakeClient([reads(["a.js", "b.js", "c.js"]), { content: "ok" }]), fakeHost({ read_file: (args) => args.path === "c.js"
    ? { output: "Error: c.js doesn't exist.", summary: "x", failed: true } : { output: "1\tx", summary: "Read" } })).ask(chat, "go");
  assert.ok(!told(chat), "one of the three failed");
});

// ---------------------------------------------------------------- 1b. a change refused before it ran

test("a change refused before it ran counts as a failed change to its file: the later changes there, and any move or removal, are skipped", async () => {
  const host = fakeHost();
  const client = fakeClient([{ calls: [
    call("1", "edit_file", { path: "src/a.js", old_text: "x" }), // no new_text: refused before it runs
    call("2", "edit_file", { path: "SRC\\a.js", old_text: "y", new_text: "z" }),
    call("3", "edit_file", { path: "src/b.js", old_text: "y", new_text: "z" }),
    call("4", "move_item", { from: "src/a.js", to: "lib/a.js" }),
  ] }, { content: "ok" }]);
  const chat = Engine.newChat();
  await engine(client, host).ask(chat, "go");
  const of = (/** @type {string} */ id) => chat.messages.find((m) => m.tool_call_id === id).content;
  assert.match(of("1"), /edit_file needs new_text/);
  assert.equal(of("2"), TEXTS.notRunSameFile);
  assert.equal(of("3"), "edit_file ok", "another file's change still runs");
  assert.equal(of("4"), TEXTS.notRun);
  assert.deepEqual(host.ran.map(([name, args]) => [name, args.path]), [["edit_file", "src/b.js"]]);

  // Arguments that can't be read name no file: every later change is skipped.
  const host2 = fakeHost();
  const chat2 = Engine.newChat();
  await engine(fakeClient([{ calls: [{ id: "1", name: "write_file", arguments: "{not json" }, call("2", "edit_file", { path: "b.js", old_text: "y", new_text: "z" }),
    call("3", "read_file", { path: "c.js" })] }, { content: "ok" }]), host2).ask(chat2, "go");
  assert.equal(chat2.messages.find((m) => m.tool_call_id === "2").content, TEXTS.notRun);
  assert.deepEqual(host2.ran.map(([name]) => name), ["read_file"], "a read still runs");
});

// ---------------------------------------------------------------- 3. an Assist reply cut off partway

const cutError = (/** @type {string} */ partial) => new GatewayError("The gateway's stream ended before it finished.", { transient: true, uncertain: true, partial });

test("assist: a reply cut off partway runs the requests that arrived whole, and says the rest didn't arrive", async () => {
  const host = fakeHost();
  const partial = "Reading both." + request({ tool: "read_file", path: "a.js" }) + "\n\n```tool\n{\"tool\": \"read_file\", \"pa";
  const client = fakeClient([cutError(partial), "Both read: done."]);
  const chat = Engine.newChat();
  const events = [];
  await engine(client, host, events, ASSIST_LANE).ask(chat, "read a and b");
  assert.deepEqual(host.ran.map(([name, args]) => [name, args.path]), [["read_file", "a.js"]]);
  assert.equal(events.some((e) => e.type === "error"), false);
  const cut = chat.messages[1];
  assert.equal(cut.meta.incomplete, true, "still marked as cut off");
  assert.equal(cut.content, "Reading both.");
  assert.equal(cut.tool_calls.length, 1);
  assert.equal(chat.messages.filter((m) => m.meta?.auto).length, 0, "no carry-on: the results go instead");
  const result = chat.messages[2];
  assert.equal(result.meta.unread, ASSIST.unread(ASSIST.dropped, 0));
  assert.ok(client.sent[1].at(-1).content.endsWith(ASSIST.unread(ASSIST.dropped, 0)), "the model is told the rest didn't arrive");
  assert.equal(chat.messages.at(-1).content, "Both read: done.");
});

test("assist: a cut after whole requests and no broken one says the rest of the reply didn't arrive; a cut right after is the error it was", async () => {
  const host = fakeHost();
  const client = fakeClient([cutError("Reading." + request({ tool: "read_file", path: "a.js" }) + "\n\nNext I will"), cutError("Half"), "never"]);
  const chat = Engine.newChat();
  const events = [];
  await engine(client, host, events, ASSIST_LANE).ask(chat, "go");
  assert.equal(chat.messages[2].meta.unread, ASSIST.restLost);
  const error = events.find((e) => e.type === "error");
  assert.ok(error && error.resumable, "cut again straight after: shown, with Resume");
  assert.equal(client.sent.length, 2);
});

/** The fake model for the session tests: reads a.js, then answers from its result, cut partway on the second reply. */
function carrying(/** @type {{role: string, content: string}[]} */ seen) {
  const last = seen[seen.length - 1].content;
  if (last.startsWith("Give a short title")) return "A title";
  if (last.includes("returned for read_file b.js")) return `Both read (${seen.filter((m) => m.content.includes("returned for read_file a.js")).length} copy of a.js's result).`;
  if (last.includes("Please carry on from where you stopped.")) return "Carried on." + request({ tool: "read_file", path: "b.js" });
  if (last.includes("returned for read_file a.js")) return "Now b." + request({ tool: "read_file", path: "b.js" }) + "\n\n" + "And then some words that are cut off. ".repeat(8);
  return 'Let me look.\n\n```tool\n{"tool": "read_file", "path": "a.js"}\n```';
}

async function sessionSetup(/** @type {(text: string, count: number) => boolean} */ cut, script = carrying) {
  const gw = await fakeAssist({ script, cut });
  const client = new GatewayClient({ endpoint: gw.endpoint, apiKey: "" });
  const ran = [];
  const host = {
    async systemPrompt() { return "SYSTEM"; },
    async assistContext() { return { workspace: "C:\\w" }; },
    needsApproval: () => null,
    async runTool(/** @type {string} */ name, /** @type {any} */ args) { ran.push([name, args]); return { output: "1\tconst cart = [];", summary: "Read " + args.path }; },
    async save() {},
  };
  const events = [];
  const e = new Engine({ client, host, retryDelays: [0, 0], now: () => new Date(2026, 10, 9, 10, 0),
    settings: () => ({ model: "model-a", compactAt: 100_000, maxRounds: 10, toolModels: "-tools$", assistSessionBlock: "test_session" }),
    onEvent: (/** @type {any} */ ev) => events.push(ev) });
  const sent = () => gw.requests.filter((/** @type {any} */ r) => !String(r.payload.messages?.at(-1)?.content || "").startsWith("Give a short title"));
  return { gw, engine: e, ran, events, sent };
}

test("assist, in a session: the requests of a cut reply run, and only their results go (not the results the session already holds)", async () => {
  const { gw, engine: e, ran, sent } = await sessionSetup((_text, count) => count === 2);
  try {
    const chat = Engine.newChat();
    await e.ask(chat, "What's in a.js and b.js?");
    assert.deepEqual(ran.map(([, args]) => args.path), ["a.js", "b.js"]);
    const third = sent()[2];
    assert.ok(third.payload.test_session, "the same session");
    const text = third.payload.messages[0].content;
    assert.ok(text.includes("returned for read_file b.js"));
    assert.ok(!text.includes("returned for read_file a.js"), "a.js's result isn't sent again");
    assert.equal(chat.messages.at(-1).content, "Both read (1 copy of a.js's result).");
  } finally { gw.close(); }
});

test("assist, in a session: a cut reply with no whole request is carried on from with the carry-on alone", async () => {
  const words = (/** @type {{role: string, content: string}[]} */ seen) => {
    const last = seen[seen.length - 1].content;
    if (last.startsWith("Give a short title")) return "A title";
    if (last.includes("Please carry on from where you stopped.")) return `Carried on (${seen.filter((m) => m.content.includes("returned for read_file a.js")).length} copy of a.js's result).`;
    if (last.includes("returned for read_file a.js")) return "a.js holds the cart, and there is more to say about it here.";
    return 'Let me look.\n\n```tool\n{"tool": "read_file", "path": "a.js"}\n```';
  };
  const { gw, engine: e, sent } = await sessionSetup((_text, count) => count === 2, words);
  try {
    const chat = Engine.newChat();
    await e.ask(chat, "What's in a.js?");
    const third = sent()[2];
    assert.ok(third.payload.test_session);
    assert.ok(!third.payload.messages[0].content.includes("returned for read_file a.js"), "only the carry-on goes");
    assert.match(third.payload.messages[0].content, /Please carry on from where you stopped\.$/);
    assert.equal(chat.messages.at(-1).content, "Carried on (1 copy of a.js's result).");
  } finally { gw.close(); }
});

// ---------------------------------------------------------------- 4. a reply cut at the output limit

test("tool lane: an answer cut at the output limit is kept as incomplete and ends with Resume, which carries on", async () => {
  const client = fakeClient([{ content: "The first half of a long ans", finishReason: "length" }, { content: "…wer." }]);
  const chat = Engine.newChat();
  const events = [];
  const e = engine(client, fakeHost(), events);
  await e.ask(chat, "explain");
  const last = chat.messages.at(-1);
  assert.equal(last.content, "The first half of a long ans");
  assert.equal(last.meta?.incomplete, true);
  assert.equal(last.meta?.finish, "length");
  assert.equal(events.some((ev) => ev.type === "done"), false, "not done");
  const error = events.find((ev) => ev.type === "error");
  assert.ok(error && error.resumable, "Resume shows");
  assert.equal(client.sent.length, 1, "nothing more was sent by itself (it's billed)");
  await e.resume(chat);
  assert.match(client.sent[1].at(-1).content, /Please carry on from where you stopped\.$/);
  assert.equal(client.sent[1].at(-2).content, "The first half of a long ans", "the part that came is sent back");
  assert.equal(chat.messages.at(-1).content, "…wer.");
});

test("tool lane: calls cut at the output limit are handled as before (the broken last one refused), and the turn goes on", async () => {
  const client = fakeClient([{ calls: [call("1", "read_file", { path: "a.js" }), { id: "2", name: "write_file", arguments: "{\"path\": \"b.js\", \"content\": \"hal" }], finishReason: "length" }, { content: "ok" }]);
  const chat = Engine.newChat();
  const events = [];
  await engine(client, fakeHost(), events).ask(chat, "go");
  assert.equal(chat.messages.find((m) => m.tool_call_id === "2").content, TEXTS.cutOff);
  assert.ok(events.some((ev) => ev.type === "done"));
});

test("assist: an answer cut at the output limit is kept as incomplete and ends with Resume; no nudge", async () => {
  const client = fakeClient([{ content: "I'll check the callers first, then", finishReason: "length" }, "Carried on: done."]);
  const chat = Engine.newChat();
  const events = [];
  const e = engine(client, fakeHost(), events, ASSIST_LANE);
  await e.ask(chat, "go");
  assert.equal(chat.messages.at(-1).meta?.incomplete, true);
  assert.equal(chat.messages.filter((m) => m.meta?.nudge).length, 0);
  assert.ok(events.find((ev) => ev.type === "error")?.resumable);
  assert.equal(events.some((ev) => ev.type === "done"), false);
  await e.resume(chat);
  assert.match(client.sent[1].at(-1).content, /Please carry on from where you stopped\.$/);
  assert.equal(chat.messages.at(-1).content, "Carried on: done.");
});
