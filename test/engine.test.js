// @ts-check
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Engine, outbound, trim, parseArguments, transcriptOf } = require("../src/engine.js");
const { GatewayError, Cancelled } = require("../src/gateway.js");
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
  assert.match(texts[0], /There's no tool called delete_everything. The tools are: read_file, symbols, search/);
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

test("compaction goes by the server's token count when it reports one, not just characters ÷ 4", async () => {
  const chat = Engine.newChat();
  for (let i = 0; i < 6; i++) {
    chat.messages.push({ role: "user", content: `question ${i} ` + "q".repeat(2000), meta: { typed: "q" } },
      { role: "assistant", content: `answer ${i}` });
  }
  // About 4,500 estimated tokens with the 10 tools: under 5,000, so the first message doesn't compact. Its reply says the
  // prompt was 1.5 times that, so the next one does.
  const client = fakeClient([(req) => ({ content: "first", usage: { prompt_tokens: Math.round(1.5 * (req.messages
    .reduce((sum, m) => sum + Math.ceil(m.content.length / 4) + Math.ceil(JSON.stringify(m.tool_calls || "").length / 4) + 4, 0)
    + Math.ceil(JSON.stringify(req.tools).length / 4))), total_tokens: 10 } }), { content: "SUMMARY" }, { content: "second" }]);
  const e = engine(client, fakeHost(), [], { compactAt: 5000 });
  await e.ask(chat, "one");
  assert.equal(chat.compaction, null);
  assert.ok(Math.abs(chat.tokenRatio - 1.5) < 0.01);
  await e.ask(chat, "two");
  assert.equal(chat.compaction?.summary, "SUMMARY");
});

test("argument checks coerce what's safe", () => {
  assert.deepEqual(parseArguments("read_file", '{"path":"a","start_line":"3"}', false).args, { path: "a", start_line: 3 });
  assert.match(parseArguments("read_file", '{"path":"a","start_line":"x"}', false).problem, /whole number/);
  assert.equal(parseArguments("write_file", '{"path":"a","content":"', true).problem, TEXTS.cutOff);
  assert.equal(parseArguments("edit_file", '{"path":"a","old_text":"x","new_text":""}', false).problem, "");
});

test("an empty reply to a result is resent once, with the note, and no more; a busy error isn't retried here", async () => {
  const empty = () => Object.assign(new GatewayError("empty", { transient: true, uncertain: true }),
    { empty: true, usage: { total_tokens: 50 } });
  const client = fakeClient([{ calls: [call("1", "problems", {})] }, empty(), empty(), empty()]);
  const chat = Engine.newChat();
  const events = [];
  await engine(client, fakeHost(), events).ask(chat, "go");
  assert.equal(client.sent.length, 3);
  assert.ok(client.sent[2].at(-1).content.endsWith(TEXTS.emptyReply));
  assert.equal(chat.usage.tokens, 10 + 50 + 50, "the empty replies were billed, so they're counted");
  assert.ok(events.some((e) => e.type === "error" && e.resumable));

  const busy = fakeClient([new GatewayError("busy", { transient: true, status: 429 })]);
  await engine(busy, fakeHost()).ask(Engine.newChat(), "go");
  assert.equal(busy.sent.length, 1, "the gateway already retried it on its backoff");
});

test("words that reached the panel are kept and never resent, even when the error doesn't carry them", async () => {
  const client = fakeClient([(req) => { req.onText("Half an "); throw new GatewayError("reset", { transient: true, uncertain: true }); }]);
  const chat = Engine.newChat();
  await engine(client, fakeHost()).ask(chat, "go");
  assert.equal(client.sent.length, 1);
  assert.deepEqual(chat.messages.at(-1), { role: "assistant", content: "Half an ", meta: { incomplete: true } });
});

test("Stop while words stream keeps them; Stop at an approval card isn't a decline", async () => {
  let e;
  const client = fakeClient([(req) => { req.onText("Most of it"); e.stop(); throw new Cancelled(); }]);
  const chat = Engine.newChat();
  const events = [];
  e = engine(client, fakeHost(), events);
  await e.ask(chat, "go");
  assert.equal(chat.messages.at(-1).content, "Most of it");
  assert.ok(events.some((x) => x.type === "stopped"));

  const host = fakeHost({ approval: () => { e2.stop(); return { decision: "decline" }; } });
  const writes = fakeClient([{ calls: [call("1", "write_file", { path: "C:/x.txt", content: "x" })] }]);
  const other = Engine.newChat();
  const e2 = engine(writes, host);
  await e2.ask(other, "go");
  assert.equal(other.messages.at(-1).content, TEXTS.notRunStopped);
});

test("a failed summary doesn't lose the message: it's saved first, and the chat goes on uncompacted", async () => {
  const chat = Engine.newChat();
  for (let i = 0; i < 6; i++) chat.messages.push({ role: "user", content: "q".repeat(4000), meta: { typed: "q" } }, { role: "assistant", content: "a" });
  const client = fakeClient([new GatewayError("bad", { status: 400 }), { content: "answer" }]);
  const events = [];
  await engine(client, fakeHost(), events, { compactAt: 5000 }).ask(chat, "my new question");
  assert.ok(events.some((e) => e.type === "compaction-failed"));
  assert.equal(chat.compaction, null);
  assert.match(client.sent[1].at(-1).content, /my new question$/);
  assert.equal(chat.messages.at(-1).content, "answer");
});

test("compaction keeps whole recent turns within a fifth of the limit, and always the new message", async () => {
  const chat = Engine.newChat();
  chat.messages.push({ role: "user", content: "first goal", meta: { typed: "x" } }, { role: "assistant", content: "ok" },
    { role: "user", content: "big turn", meta: { typed: "x" } }, { role: "assistant", content: "b".repeat(30_000) },
    { role: "user", content: "small turn", meta: { typed: "x" } }, { role: "assistant", content: "fine" });
  const client = fakeClient([{ content: "SUMMARY" }, { content: "next answer" }]);
  await engine(client, fakeHost(), [], { compactAt: 6000 }).ask(chat, "new");
  assert.equal(chat.compaction.through, 4, "the big turn is summarised, the small one kept");
  const sent = client.sent[1];
  assert.deepEqual(sent.slice(3).map((m) => m.content.replace(/^\(.*\)\n\n/, "")), ["small turn", "fine", "new"]);
});

test("Resume compacts an over-limit chat first, then asks it to carry on", async () => {
  const chat = Engine.newChat();
  for (let i = 0; i < 6; i++) chat.messages.push({ role: "user", content: "q".repeat(4000), meta: { typed: "q" } }, { role: "assistant", content: "a" });
  const client = fakeClient([{ content: "SUMMARY" }, { content: "carried on" }]);
  await engine(client, fakeHost(), [], { compactAt: 5000 }).resume(chat);
  assert.ok(chat.compaction);
  assert.equal(client.sent[1][2].content, "SUMMARY");
  assert.match(client.sent[1].at(-1).content, /Please carry on/);
});

const readCall = (id) => ({ id, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: id }) } });

test("the newest reply's results are never cut, however big: the model hasn't seen them yet", () => {
  const chat = Engine.newChat();
  const big = "x".repeat(28_000); // 7k tokens each: 7 of them pass the budget on their own
  chat.messages.push({ role: "assistant", content: "", tool_calls: [readCall("old")] },
    { role: "tool", tool_call_id: "old", content: big, meta: { summary: "read old" } });
  const ids = ["a", "b", "c", "d", "e", "f", "g"];
  chat.messages.push({ role: "assistant", content: "", tool_calls: ids.map(readCall) });
  for (const id of ids) chat.messages.push({ role: "tool", tool_call_id: id, content: big, meta: { summary: `read ${id}` } });
  trim(chat);
  assert.deepEqual(chat.messages.filter((m) => m.meta?.stub).map((m) => m.meta.summary), ["read old"]);
});

test("your steer and a folder's AGENTS.md survive their result being cut; a huge result is capped", async () => {
  let e;
  const host = fakeHost({ tools: {
    read_file: (args) => args.path === "a"
      ? (e.steer("keep the API stable"), { output: "A".repeat(50_000), summary: "read a", keep: "This folder's sub/AGENTS.md says: tabs" })
      : { output: (args.path === "big" ? "B".repeat(60_000) : "C".repeat(39_000)), summary: "read " + args.path },
  } });
  const client = fakeClient([{ calls: [call("1", "read_file", { path: "a" })] },
    ...["big", "c", "d", "e"].map((p, i) => ({ calls: [call(String(i + 2), "read_file", { path: p })] })), { content: "done" }]);
  const chat = Engine.newChat();
  e = engine(client, host);
  await e.ask(chat, "go");
  const first = client.sent[5].find((m) => m.tool_call_id === "1");
  assert.ok(first.content.startsWith(TEXTS.stub("read a")), "it was cut");
  assert.match(first.content, /sub\/AGENTS\.md says: tabs/);
  assert.match(first.content, /keep the API stable/);
  const second = chat.messages.find((m) => m.tool_call_id === "2");
  assert.ok(second.content.length < 41_000 && /characters of this output are left out/.test(second.content));
});

test("the summary transcript keeps your first goal even when big writes overflow its budget", () => {
  const chat = Engine.newChat();
  chat.messages.push({ role: "user", content: "GOAL: never touch the legacy folder", meta: { typed: "x" } });
  for (let i = 0; i < 5; i++) {
    chat.messages.push({ role: "assistant", content: "Writing. " + "w".repeat(20_000), tool_calls: [{ id: `w${i}`, type: "function",
      function: { name: "write_file", arguments: JSON.stringify({ path: `f${i}.js`, content: "z".repeat(40_000) }) } }] },
    { role: "tool", tool_call_id: `w${i}`, content: "r".repeat(5000), meta: { summary: "wrote" } });
  }
  const text = transcriptOf(chat, 0, chat.messages.length, 12_000);
  assert.match(text, /^Me: GOAL: never touch the legacy folder/);
  assert.ok(text.length <= 12_100, `${text.length} characters`);
});

test("earlier turns' big writes are sent as a note, this turn's whole; compaction runs mid-task", async () => {
  const write = (id) => ({ id, type: "function", function: { name: "write_file",
    arguments: JSON.stringify({ path: id + ".js", content: "line\n".repeat(2000) }) } });
  const chat = Engine.newChat();
  chat.messages.push({ role: "user", content: "write a", meta: { typed: "x" } }, { role: "assistant", content: "", tool_calls: [write("a")] },
    { role: "tool", tool_call_id: "a", content: "Wrote a.js.", meta: {} }, { role: "assistant", content: "Done." },
    { role: "user", content: "write b", meta: { typed: "x" } }, { role: "assistant", content: "", tool_calls: [write("b")] },
    { role: "tool", tool_call_id: "b", content: "Wrote b.js.", meta: {} });
  const sent = outbound(chat, "S");
  assert.equal(JSON.parse(sent[2].tool_calls[0].function.arguments).content, TEXTS.argumentLeftOut(2001));
  assert.equal(sent[6].tool_calls[0], chat.messages[5].tool_calls[0], "this turn's call goes as it came");

  // A long task: each step adds a big result; past the limit, the earlier turns are summarised mid-task.
  const long = Engine.newChat();
  long.messages.push({ role: "user", content: "old " + "o".repeat(20_000), meta: { typed: "x" } }, { role: "assistant", content: "old answer" });
  const client = fakeClient([{ calls: [call("1", "read_file", { path: "a" })] }, { content: "SUMMARY" }, { content: "done" }]);
  const host = fakeHost({ tools: { read_file: () => ({ output: "x".repeat(12_000), summary: "read" }) } });
  await engine(client, host, [], { compactAt: 7000 }).ask(long, "new task");
  assert.equal(long.compaction?.summary, "SUMMARY");
  assert.equal(long.compaction.through, 2, "only the earlier turn");
  assert.ok(client.sent[2].some((m) => m.tool_call_id === "1"), "this turn's step went on, whole");
});

test("odd calls are answered, never crash or run twice: prototype names, reordered keys, cut off with no arguments", async () => {
  for (const name of ["toString", "constructor", "__proto__"]) assert.match(parseArguments(name, "{}", false).problem, /no tool called/);
  assert.equal(parseArguments("write_file", "", true).problem, TEXTS.cutOff);
  const client = fakeClient([{ calls: [call("1", "toString", {}),
    { id: "2", name: "edit_file", arguments: JSON.stringify({ path: "a", old_text: "x", new_text: "y" }) },
    { id: "3", name: "edit_file", arguments: JSON.stringify({ new_text: "y", old_text: "x", path: "a" }) }] }, { content: "done" }]);
  const host = fakeHost();
  const chat = Engine.newChat();
  await engine(client, host).ask(chat, "go");
  assert.equal(host.ran.length, 1, "the reordered repeat didn't run");
  assert.deepEqual(chat.messages.filter((m) => m.role === "tool").map((m) => m.content.slice(0, 12)),
    [TEXTS.unknownTool("toString", []).slice(0, 12), "edit_file ok", TEXTS.repeat.slice(0, 12)]);
});

test("ids reused across turns are made unique, so every call gets its own answer", async () => {
  const client = fakeClient([{ calls: [call("call_0", "problems", {})] }, { calls: [call("call_0", "problems", { path: "b" })] }]);
  const chat = Engine.newChat();
  await engine(client, fakeHost(), [], { maxRounds: 1 }).ask(chat, "go");
  const calls = chat.messages.filter((m) => m.tool_calls).map((m) => m.tool_calls[0].id);
  assert.deepEqual(calls, ["call_0", "call_0_2"]);
  const answers = chat.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
  assert.deepEqual(answers, ["call_0", "call_0_2"], "the second, stopped at the limit, is answered too");
});

test("the chat is named by a request of its own after the 1st and 3rd answers; never once you've renamed it", async () => {
  const titled = [];
  const answers = [{ content: "first answer" }, (req) => { titled.push(req); return { content: "**Title:** Cart Rounding Fix." }; },
    { content: "second answer" }, { content: "third answer" }, (req) => { titled.push(req); return { content: "Cart totals and tests" }; },
    { content: "fourth" }, { content: "fifth" }];
  const client = fakeClient(answers);
  const chat = Engine.newChat();
  const events = [];
  const e = engine(client, fakeHost(), events);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  await e.ask(chat, "fix the rounding in cartTotal please"); await settle();
  assert.equal(chat.title, "Cart Rounding Fix");
  assert.equal(titled[0].messages.length, 1, "no history, no system prompt: just the excerpt");
  assert.ok(!titled[0].tools, "no tools");
  assert.match(titled[0].messages[0].content, /^Give a short title[\s\S]*\n\nMe: fix the rounding in cartTotal please\nAssistant: first answer$/);
  assert.ok(events.some((x) => x.type === "titled"));
  await e.ask(chat, "two"); await settle();
  await e.ask(chat, "three"); await settle();
  assert.equal(chat.title, "Cart totals and tests");
  chat.titleSource = "user";
  chat.titledAt = 0;
  await e.ask(chat, "four"); await settle();
  assert.equal(titled.length, 2, "renamed by you: never again");
});

test("each step records how long it took; a queued message can be taken back", async () => {
  const host = fakeHost({ tools: { problems: () => new Promise((resolve) => setTimeout(() => resolve({ output: "ok", summary: "ok" }), 30)) } });
  const client = fakeClient([{ calls: [call("1", "problems", {})] }, { content: "done" }]);
  const chat = Engine.newChat();
  const e = engine(client, host);
  await e.ask(chat, "go");
  assert.ok(chat.messages.find((m) => m.role === "tool").meta.ms >= 25);
  e.steer("one"); e.steer("two");
  assert.equal(e.unsteer(0), "one");
  assert.deepEqual(e.steers.map((s) => s.text), ["two"]);
  assert.equal(e.unsteer(5), "");
});

test("Stop ends the wait for a slow read-only tool at once; a slow edit is let finish", async () => {
  let e;
  const never = new Promise(() => {}); // a search stuck behind a huge index, say
  const host = fakeHost({ tools: { search: () => never } });
  const client = fakeClient([{ calls: [call("1", "search", { query: "x", docs: true })] }]);
  const chat = Engine.newChat();
  const events = [];
  e = engine(client, host, events);
  setTimeout(() => e.stop(), 20);
  await e.ask(chat, "go");
  assert.equal(chat.messages.find((m) => m.role === "tool").content, TEXTS.stoppedRunning);
  assert.ok(events.some((ev) => ev.type === "stopped"));

  let finished = false;
  const slowEdit = fakeHost({ tools: { edit_file: () => new Promise((r) => setTimeout(() => { finished = true; r({ output: "Edited a.", summary: "edit" }); }, 40)) } });
  const edits = fakeClient([{ calls: [call("1", "edit_file", { path: "a", old_text: "x", new_text: "y" })] }]);
  const other = Engine.newChat();
  const e2 = engine(edits, slowEdit);
  setTimeout(() => e2.stop(), 10);
  await e2.ask(other, "go");
  assert.ok(finished);
  assert.equal(other.messages.find((m) => m.role === "tool").content, "Edited a.");
});

test("one reply's results have a total size limit: past it, its other reads wait for the next step", async () => {
  const host = fakeHost({ tools: { read_file: () => ({ output: "x".repeat(39_000), summary: "read" }) } });
  const reads = ["a", "b", "c", "d", "e", "f"].map((p, i) => call(String(i), "read_file", { path: p }));
  const client = fakeClient([{ calls: reads }, { content: "done" }]);
  const chat = Engine.newChat();
  await engine(client, host).ask(chat, "read them all");
  const results = chat.messages.filter((m) => m.role === "tool").map((m) => m.content === TEXTS.notRunFull ? "waits" : "read");
  assert.deepEqual(results, ["read", "read", "read", "waits", "waits", "waits"]);
  assert.ok(JSON.stringify(client.sent[1]).length < 140_000, "the next request stays bounded");
});

test("Resume after a stop during a step asks for the stopped step again, not just to carry on", async () => {
  let e;
  const host = fakeHost({ tools: { read_file: () => new Promise(() => {}) } });
  const client = fakeClient([{ calls: [call("1", "read_file", { path: "a" })] }, { content: "carried on" }]);
  const chat = Engine.newChat();
  e = engine(client, host);
  setTimeout(() => e.stop(), 20);
  await e.ask(chat, "go");
  await e.resume(chat);
  assert.match(client.sent[1].at(-1).content, /run again whatever was stopped/);
});

test("compaction doesn't run when what it could summarise is a sliver", async () => {
  const chat = Engine.newChat();
  chat.messages.push({ role: "user", content: "hi", meta: { typed: "hi" } }, { role: "assistant", content: "hello" });
  const client = fakeClient([{ content: "answer" }]);
  const events = [];
  await engine(client, fakeHost(), events, { compactAt: 30_000 }).ask(chat, "z".repeat(140_000));
  assert.ok(!events.some((x) => x.type === "compacting"), "no request spent summarising two short messages");
  assert.equal(client.sent.length, 1);
});

test("results from a task's last two steps stay whole, so reading spread over two steps survives", () => {
  const chat = Engine.newChat();
  const big = "y".repeat(60_000);
  chat.messages.push({ role: "user", content: "read them all", meta: { typed: "x" } });
  for (const step of ["s1", "s2", "s3"]) {
    chat.messages.push({ role: "assistant", content: "", tool_calls: [readCall(step + "a"), readCall(step + "b")] },
      { role: "tool", tool_call_id: step + "a", content: big, meta: { summary: step + "a" } },
      { role: "tool", tool_call_id: step + "b", content: big, meta: { summary: step + "b" } });
  }
  trim(chat);
  assert.deepEqual(chat.messages.filter((m) => m.meta?.stub).map((m) => m.meta.summary), ["s1a", "s1b"]);
});

test("a message queued while it works keeps its selection, and goes as the next message if no step comes", async () => {
  let e;
  const events = [];
  const client = fakeClient([(req) => { e.steer("also explain this", { context: "(Selected in a.js, lines 1–2:)", chips: ["a.js:1–2"] }); return { content: "first answer" }; }]);
  const chat = Engine.newChat();
  e = engine(client, fakeHost(), events);
  await e.ask(chat, "explain that");
  const unsent = events.find((x) => x.type === "steer-unsent");
  assert.equal(unsent.send, true, "no next step came, so it's sent as the next message");
  assert.equal(unsent.text, "also explain this");
  assert.equal(unsent.context, "(Selected in a.js, lines 1–2:)");
  assert.deepEqual(unsent.chips, ["a.js:1–2"]);
});
