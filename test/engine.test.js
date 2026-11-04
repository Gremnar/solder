// @ts-check
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Engine, outbound, trim, parseArguments } = require("../src/engine.js");
const { GatewayError } = require("../src/gateway.js");
const { TEXTS } = require("../src/prompt.js");

/** A fake gateway: each reply() takes the next scripted answer (an object, or a function of the request). */
function fakeClient(script) {
  const sent = [];
  return {
    sent,
    async reply(request) {
      sent.push(JSON.parse(JSON.stringify(request.messages)));
      const next = script.shift();
      if (!next) throw new Error("no more scripted replies");
      const value = typeof next === "function" ? next(request) : next;
      if (value instanceof Error) throw value;
      if (value.content) request.onText?.(value.content);
      return { content: "", calls: [], finishReason: "stop", usage: { total_tokens: 10 }, credits: null, ...value };
    },
  };
}

const call = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) });

function fakeHost({ tools = {}, approval } = {}) {
  const ran = [];
  return {
    ran,
    async systemPrompt() { return "SYSTEM"; },
    needsApproval(name, args) { return name === "write_file" && String(args.path).startsWith("C:") ? "outside" : null; },
    async runTool(name, args) {
      ran.push([name, args]);
      const fn = tools[name];
      return fn ? fn(args) : { output: `${name} ok`, summary: `${name} done` };
    },
    async save() {},
    approval,
  };
}

function engine(client, host, events = [], settings = {}) {
  const e = new Engine({ client, host, retryDelays: [0, 0], now: () => new Date(2026, 10, 4, 14, 5),
    settings: () => ({ model: "m", compactAt: 100_000, maxRounds: 30, ...settings }),
    onEvent: (event) => {
      events.push(event);
      if (event.type === "approval" && host.approval) setImmediate(() => e.decide(event.id, host.approval(event)));
    } });
  return e;
}

test("a plain answer: the user message carries the time, the title comes from it", async () => {
  const client = fakeClient([{ content: "Hi there" }]);
  const chat = Engine.newChat();
  const events = [];
  await engine(client, fakeHost(), events).ask(chat, "hello solder");
  assert.equal(chat.title, "hello solder");
  assert.match(chat.messages[0].content, /^\(Wednesday, 4 November 2026, 14:05\)\n\nhello solder$/);
  assert.equal(chat.messages[1].content, "Hi there");
  assert.deepEqual(client.sent[0][0], { role: "system", content: "SYSTEM" });
  assert.ok(events.some((e) => e.type === "done"));
  assert.equal(chat.usage.tokens, 10);
});

test("tool calls run in order, each answered by its id, thought signatures kept", async () => {
  const client = fakeClient([
    { content: "Looking.", calls: [{ ...call("a", "read_file", { path: "x.js" }), extra: { google: { thought_signature: "s" } } },
      call("b", "search", { query: "foo" })] },
    { content: "Done." },
  ]);
  const host = fakeHost();
  const chat = Engine.newChat();
  await engine(client, host).ask(chat, "look");
  assert.deepEqual(host.ran.map((r) => r[0]), ["read_file", "search"]);
  const second = client.sent[1];
  assert.equal(second[2].tool_calls[0].extra_content.google.thought_signature, "s");
  assert.deepEqual(second.slice(3).map((m) => [m.role, m.tool_call_id, m.content]),
    [["tool", "a", "read_file ok"], ["tool", "b", "search ok"]]);
});

test("a failed edit stops the batch; a failed read doesn't", async () => {
  const client = fakeClient([
    { calls: [call("1", "read_file", { path: "gone" }), call("2", "read_file", { path: "b" }),
      call("3", "edit_file", { path: "b", old_text: "x", new_text: "y" }), call("4", "edit_file", { path: "b", old_text: "z", new_text: "w" })] },
    { content: "ok" },
  ]);
  const host = fakeHost({ tools: {
    read_file: (a) => a.path === "gone" ? { output: "Error: not found", summary: "x", failed: true } : { output: "1\tb", summary: "read" },
    edit_file: () => ({ output: "Error: old_text appears 0 times", summary: "x", failed: true }) } });
  const chat = Engine.newChat();
  await engine(client, host).ask(chat, "go");
  assert.deepEqual(host.ran.map((r) => r[0]), ["read_file", "read_file", "edit_file"]);
  const results = chat.messages.filter((m) => m.role === "tool");
  assert.equal(results.length, 4);
  assert.equal(results[3].content, TEXTS.notRun);
});

test("unknown tools, bad arguments and repeats are answered, and the rest still run", async () => {
  const client = fakeClient([
    { calls: [call("1", "delete_everything", {}), { id: "2", name: "read_file", arguments: "{oops" },
      call("3", "find_files", { glob: "*.js" }), call("4", "find_files", { glob: "*.js" }), call("5", "read_file", { start_line: 3 })] },
    { content: "ok" },
  ]);
  const host = fakeHost();
  const chat = Engine.newChat();
  await engine(client, host).ask(chat, "go");
  assert.deepEqual(host.ran.map((r) => r[0]), ["find_files"]);
  const texts = chat.messages.filter((m) => m.role === "tool").map((m) => m.content);
  assert.match(texts[0], /There's no tool called delete_everything. The tools are: read_file, search/);
  assert.equal(texts[1], TEXTS.badArguments);
  assert.equal(texts[3], TEXTS.repeat);
  assert.equal(texts[4], "read_file needs path; it wasn't run.");
});

test("a write outside the workspace asks first: declined with a note, or allowed", async () => {
  const decisions = [{ decision: "decline", note: "keep it in the repo" }, { decision: "allow" }];
  const host = fakeHost({ approval: () => decisions.shift() });
  const client = fakeClient([
    { calls: [call("1", "write_file", { path: "C:/x.txt", content: "a" })] },
    { calls: [call("2", "write_file", { path: "C:/x.txt", content: "a" })] },
    { content: "done" },
  ]);
  const events = [];
  const chat = Engine.newChat();
  await engine(client, host, events).ask(chat, "go");
  const results = chat.messages.filter((m) => m.role === "tool");
  assert.equal(results[0].content, TEXTS.declined + "\n\n" + TEXTS.userNote("keep it in the repo"));
  assert.equal(results[1].content, "write_file ok");
  assert.deepEqual(events.filter((e) => e.type === "approval").map((e) => e.id), ["1", "2"]);
});

test("writing outside the workspace asks", async () => {
  const host = fakeHost({ approval: () => ({ decision: "decline" }) });
  const client = fakeClient([{ calls: [call("1", "write_file", { path: "C:/x.txt", content: "" })] }, { content: "ok" }]);
  const chat = Engine.newChat();
  await engine(client, host).ask(chat, "go");
  assert.equal(host.ran.length, 0);
});

test("near the step limit it's told to wrap up; past it, calls are answered and it stops", async () => {
  const client = fakeClient([
    { calls: [call("1", "problems", {})] }, { calls: [call("2", "problems", { path: "a" })] }, { calls: [call("3", "problems", { path: "b" })] },
  ]);
  const events = [];
  const chat = Engine.newChat();
  await engine(client, fakeHost(), events, { maxRounds: 2 }).ask(chat, "go");
  const results = chat.messages.filter((m) => m.role === "tool");
  assert.match(results[0].content, /1 more reply with tool calls left/);
  assert.match(results[1].content, /That was the last reply with tool calls allowed/);
  assert.equal(results[2].content, TEXTS.notRunLimit);
  assert.equal(events.find((e) => e.type === "done").limit, 2);
});

test("a message typed while it works rides along on the next result", async () => {
  let e;
  const client = fakeClient([
    () => { e.steer("also check b.js"); return { calls: [call("1", "read_file", { path: "a.js" })] }; },
    { content: "ok" },
  ]);
  const chat = Engine.newChat();
  e = engine(client, fakeHost());
  await e.ask(chat, "go");
  assert.match(client.sent[1].at(-1).content, /a message from the user while you were working:\n\nalso check b\.js$/);
});

test("an empty reply to a result is sent again once with a note; an uncertain failure is retried once", async () => {
  const empty = Object.assign(new GatewayError("empty", { transient: true }), { empty: true });
  const reset = new GatewayError("reset", { transient: true, uncertain: true });
  const client = fakeClient([{ calls: [call("1", "problems", {})] }, empty, reset, { content: "fine" }]);
  const chat = Engine.newChat();
  await engine(client, fakeHost()).ask(chat, "go");
  assert.ok(client.sent[2].at(-1).content.endsWith(TEXTS.emptyReply));
  assert.equal(chat.messages.at(-1).content, "fine");

  const twice = fakeClient([reset, reset]);
  const events = [];
  const other = Engine.newChat();
  await engine(twice, fakeHost(), events).ask(other, "go");
  assert.equal(twice.sent.length, 2);
  assert.ok(events.find((e) => e.type === "error" && e.resumable));
});

test("text that streamed before a failure is kept; Resume asks it to carry on", async () => {
  const cut = new GatewayError("cut", { transient: true, uncertain: true, partial: "Half an ans" });
  const client = fakeClient([cut, { content: "…wer." }]);
  const chat = Engine.newChat();
  const e = engine(client, fakeHost());
  await e.ask(chat, "go");
  assert.deepEqual(chat.messages.at(-1), { role: "assistant", content: "Half an ans", meta: { incomplete: true } });
  await e.resume(chat);
  assert.equal(client.sent[1].at(-1).role, "user");
  assert.match(client.sent[1].at(-1).content, /Please carry on/);
});

test("Stop mid-batch: what ran is kept, the rest is answered as not run", async () => {
  let e;
  const host = fakeHost({ tools: { read_file: () => { e.stop(); return { output: "1\tx", summary: "read" }; } } });
  const client = fakeClient([{ calls: [call("1", "read_file", { path: "a" }), call("2", "read_file", { path: "b" })] }]);
  const events = [];
  const chat = Engine.newChat();
  e = engine(client, host, events);
  await e.ask(chat, "go");
  const results = chat.messages.filter((m) => m.role === "tool").map((m) => m.content);
  assert.deepEqual(results, ["1\tx", TEXTS.notRunStopped]);
  assert.ok(events.some((ev) => ev.type === "stopped"));
});

test("old large results become stand-ins once past the budget, sticky and newest-first", () => {
  const chat = Engine.newChat();
  const big = "x".repeat(60_000); // 15k tokens each
  for (let i = 0; i < 4; i++) {
    chat.messages.push({ role: "assistant", content: "", tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: `c${i}`, content: big, meta: { summary: `read ${i}` } });
  }
  assert.equal(trim(chat), true);
  const stubs = chat.messages.filter((m) => m.meta?.stub).map((m) => m.meta.summary);
  assert.deepEqual(stubs, ["read 0", "read 1"]);
  const sent = outbound(chat, "S");
  assert.equal(sent[2].content, TEXTS.stub("read 0"));
  assert.equal(sent[8].content, big);
});

test("compaction: past the limit, the older part is summarised and replayed as a recap", async () => {
  const chat = Engine.newChat();
  for (let i = 0; i < 6; i++) {
    chat.messages.push({ role: "user", content: `question ${i} ` + "q".repeat(4000), meta: { typed: "q" } },
      { role: "assistant", content: `answer ${i}` });
  }
  const client = fakeClient([(req) => {
    assert.match(req.messages[1].content, /^Here's our conversation so far/);
    assert.ok(!req.tools);
    return { content: "SUMMARY" };
  }, { content: "new answer" }]);
  const events = [];
  await engine(client, fakeHost(), events, { compactAt: 5000 }).ask(chat, "next");
  assert.ok(chat.compaction && chat.compaction.summary === "SUMMARY");
  const sent = client.sent[1];
  assert.deepEqual(sent.slice(1, 3), [{ role: "user", content: TEXTS.compaction }, { role: "assistant", content: "SUMMARY" }]);
  assert.equal(sent[3].role, "user");
  assert.match(sent.at(-1).content, /next$/);
  assert.ok(events.some((e) => e.type === "compacted"));
});

test("argument checks coerce what's safe", () => {
  assert.deepEqual(parseArguments("read_file", '{"path":"a","start_line":"3"}', false).args, { path: "a", start_line: 3 });
  assert.match(parseArguments("read_file", '{"path":"a","start_line":"x"}', false).problem, /whole number/);
  assert.equal(parseArguments("write_file", '{"path":"a","content":"', true).problem, TEXTS.cutOff);
  assert.equal(parseArguments("edit_file", '{"path":"a","old_text":"x","new_text":""}', false).problem, "");
});
