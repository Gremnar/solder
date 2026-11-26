// @ts-check
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { getEventListeners } = require("node:events");
const { Engine, parseArguments, supersedeReads, repeatReads } = require("../src/engine.js");
const { TEXTS, RESULTS } = require("../src/prompt.js");

/** A fake gateway: each reply() takes the next scripted answer (an object, or a function of the request). @param {any[]} script */
function fakeClient(script) {
  return {
    async reply(/** @type {any} */ request) {
      const next = script.shift();
      if (!next) throw new Error("no more scripted replies");
      const value = typeof next === "function" ? next(request) : next;
      return { content: "", calls: [], finishReason: "stop", usage: { total_tokens: 10 }, credits: null, ...value };
    },
  };
}
const call = (/** @type {string} */ id, /** @type {string} */ name, /** @type {any} */ args) => ({ id, name, arguments: JSON.stringify(args) });

/** @param {any} [options] */
function fakeHost({ tools = {}, approval = /** @type {any} */ (null), needsApproval = (/** @type {string} */ name, /** @type {any} */ args) => name === "write_file" && String(args.path).startsWith("C:") ? "outside" : null } = {}) {
  const ran = /** @type {any[]} */ ([]);
  return {
    ran, approval, needsApproval,
    async systemPrompt() { return "SYSTEM"; },
    async runTool(/** @type {string} */ name, /** @type {any} */ args, /** @type {any} */ ctx) {
      ran.push([name, args, ctx]);
      const fn = /** @type {any} */ (tools)[name];
      return fn ? fn(args, ctx) : { output: `${name} ok`, summary: `${name} done` };
    },
    /** @type {(chat: any) => Promise<void>} */
    async save() {},
  };
}

/** @param {any} client @param {any} host @param {any[]} [events] */
function engine(client, host, events = []) {
  const e = new Engine({ client, host, retryDelays: [0, 0], now: () => new Date(2026, 10, 4, 14, 5),
    settings: () => ({ model: "m", compactAt: 100_000, maxRounds: 30 }),
    onEvent: (event) => {
      events.push(event);
      if (event.type === "approval" && host.approval) setImmediate(() => e.decide(event.id, host.approval(event)));
    } });
  return e;
}

test("Tool lane: valid arguments are taken as written, and a path's single backslashes keep their \\t and \\n", () => {
  assert.deepEqual(parseArguments("write_file", '{"path": "a.js", "content": "x = [1,]; re = /a{1,}/",}', false).args, { path: "a.js", content: "x = [1,]; re = /a{1,}/" });
  assert.equal(parseArguments("read_file", String.raw`{"path": "src\tools\run.ps1"}`, false).args.path, "src\\tools\\run.ps1");
  assert.equal(parseArguments("read_file", String.raw`{"file_path": "C:\Users\me\new\b.ps1"}`, false).args.path, "C:\\Users\\me\\new\\b.ps1");
  assert.deepEqual(parseArguments("edit_file", String.raw`{"path": "a\b.txt", "old_text": "a\tb", "new_text": "c\nd"}`, false).args,
    { path: "a\\b.txt", old_text: "a\tb", new_text: "c\nd" }, "text arguments are never touched");
});

test("a read that brought back no lines (past the end, a skill already read) or shortened long lines never cuts an earlier read", () => {
  const body = "x".repeat(3000);
  /** @param {[string, any, string, string][]} reads id, args, summary, output */
  const chatOf = (reads) => ({ ...Engine.newChat(), messages: [
    { role: "user", content: "go", meta: {} },
    ...reads.flatMap(([id, args, summary, output]) => [
      { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: JSON.stringify(args) } }] },
      { role: "tool", tool_call_id: id, content: output, meta: { name: "read_file", summary } }]),
  ] });
  const whole = /** @type {[string, any, string, string]} */ (["1", { path: "app.js" }, "Read app.js · 120 lines", body]);
  // Past the end.
  let chat = chatOf([whole, ["2", { path: "app.js", start_line: 500 }, "Read app.js · past the end", RESULTS.pastEnd("app.js", 120)]]);
  assert.equal(supersedeReads(chat), 0);
  assert.equal(repeatReads(chat).again, 0, "not a repeat read either");
  // A skill, already in the chat.
  chat = chatOf([whole, ["2", { path: "app.js" }, "Skill app · already in this chat", RESULTS.skillAgain("app")]]);
  assert.equal(supersedeReads(chat), 0);
  // All of it again, but with a long line shown only by its start: it doesn't hold every line.
  const shortened = "1\tconst a = 1;\n2\t" + "y".repeat(200) + "…\n" + RESULTS.longLine(2, 9000, true) + "\n3\tend";
  chat = chatOf([whole, ["2", { path: "app.js" }, "Read app.js · 120 lines", shortened]]);
  assert.equal(supersedeReads(chat), 0);
  chat = chatOf([whole, ["2", { path: "app.js" }, "Read app.js · 120 lines", "1\t" + "z".repeat(100) + "…\n" + RESULTS.longLine(1, 90_000, false)]]);
  assert.equal(supersedeReads(chat), 0, "the other wording too");
  // As before: a whole read again cuts the older one, and a part of it covered.
  chat = chatOf([["1", { path: "app.js", start_line: 10, end_line: 50 }, "Read app.js · lines 10–50 of 120", body], ["2", { path: "app.js" }, "Read app.js · 120 lines · with your note", body]]);
  assert.equal(supersedeReads(chat), 1);
  assert.equal(repeatReads(chatOf([whole, ["2", { path: "app.js", start_line: 3, end_line: 9 }, "Read app.js · lines 3–9 of 120", body]])).again, 1);
});

test("a batch of reads leaves no abort listeners behind on the signal", async () => {
  let signal = /** @type {AbortSignal | null} */ (null);
  let left = -1;
  const reads = Array.from({ length: 24 }, (_, i) => call(`r${i}`, "read_file", { path: `f${i}.js` }));
  const host = fakeHost({ tools: { read_file: (/** @type {any} */ args, /** @type {any} */ ctx) => { signal = ctx.signal; return { output: "1\tx", summary: `Read ${args.path} · 1 lines` }; } } });
  const client = fakeClient([{ calls: reads }, () => { left = signal ? getEventListeners(signal, "abort").length : -2; return { content: "Done." }; }]);
  await engine(client, host).ask(Engine.newChat(), "read them");
  assert.equal(host.ran.length, 24);
  assert.equal(left, 0);
});

test("Stop pressed while the final answer is saved: the answer is kept, and a queued message goes back, not out", async () => {
  const events = /** @type {any[]} */ ([]);
  const host = fakeHost();
  /** @type {Engine} */
  let e;
  const client = fakeClient([() => { e.steer("and then this"); return { content: "Here's the answer." }; }]);
  e = engine(client, host, events);
  host.save = async (/** @type {any} */ chat) => { if (chat.messages.at(-1)?.role === "assistant" && e.controller && !e.controller.signal.aborted) e.stop(); };
  const chat = Engine.newChat();
  await e.ask(chat, "a question");
  assert.equal(chat.messages.at(-1)?.content, "Here's the answer.");
  const unsent = events.find((event) => event.type === "steer-unsent");
  assert.ok(unsent);
  assert.equal(unsent.text, "and then this");
  assert.equal(unsent.send, false);
});

test("a read you decline stops the rest of the reply, a change after it included", async () => {
  const host = fakeHost({ approval: () => ({ decision: "decline" }),
    needsApproval: (/** @type {string} */ name, /** @type {any} */ args) => String(args.path).startsWith("C:") ? "outside" : null });
  const chat = Engine.newChat();
  await engine(fakeClient([{ calls: [call("r", "read_file", { path: "C:/elsewhere/a.txt" }), call("w", "write_file", { path: "b.txt", content: "x" }),
    call("f", "find_files", { glob: "*.js" })] }, { content: "ok" }]), host).ask(chat, "go");
  assert.deepEqual(host.ran, [], "nothing ran");
  const said = (/** @type {string} */ id) => chat.messages.find((m) => m.tool_call_id === id)?.content;
  assert.equal(said("r"), TEXTS.declined);
  assert.equal(said("w"), TEXTS.notRun);
  assert.equal(said("f"), TEXTS.notRun);
});

test("problems settled after a reply's edits are saved and shown, and edits by another agent's name for path are grouped", async () => {
  const events = /** @type {any[]} */ ([]);
  const host = fakeHost();
  /** @type {any[]} */
  const hints = [];
  host.runTool = async (name, args, ctx) => { hints.push([args.path, ctx.edit]); return { output: `${name} ok`, summary: "Edited" }; };
  /** @type {any} */ (host).settleEdits = async (/** @type {string} */ group) => group === "e1" ? [{ path: "src/a.js", text: "\nNew problems in src/a.js", summary: " · 1 new problem" }] : [];
  let saved = "";
  host.save = async (chat) => { saved = JSON.stringify(chat); };
  let savedBeforeNext = "";
  const client = fakeClient([
    { calls: [call("e1", "edit_file", { file_path: "src/a.js", old_text: "1", new_text: "2" }), call("e2", "edit_file", { file_path: "src/a.js", old_text: "3", new_text: "4" })] },
    () => { savedBeforeNext = saved; return { content: "ok" }; },
  ]);
  const chat = Engine.newChat();
  await engine(client, host, events).ask(chat, "edit");
  assert.deepEqual(hints, [["src/a.js", { group: "e1", more: true }], ["src/a.js", { group: "e1", more: true }]]);
  const e2 = chat.messages.find((m) => m.tool_call_id === "e2");
  assert.match(String(e2?.content), /New problems in src\/a\.js$/);
  assert.match(savedBeforeNext, /New problems in src\/a\.js/, "saved before the next request");
  const second = events.indexOf(events.filter((event) => event.type === "thinking")[1]);
  assert.equal(events.slice(0, second).filter((event) => event.type === "message").length, 5, "your message, the reply, two results, then once more with the problems");
});
