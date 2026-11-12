// @ts-check
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Engine, outbound, trim, parseArguments, transcriptOf } = require("../src/engine.js");
const { GatewayError, Cancelled } = require("../src/gateway.js");
const { TEXTS, PLAN } = require("../src/prompt.js");

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
  assert.equal(trim(chat, 20_000), true);
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
  trim(chat, 20_000);
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
  e = engine(client, host, [], { compactAt: 20_000 });
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
  trim(chat, 20_000);
  assert.deepEqual(chat.messages.filter((m) => m.meta?.stub).map((m) => m.meta.summary), ["s1a", "s1b"]);
});

test("this task's results stay whole up to 1.5× the compaction limit; earlier tasks' are cut past the budget", () => {
  const chat = Engine.newChat();
  const big = "y".repeat(80_000); // 20k tokens each
  const task = (/** @type {string} */ name, /** @type {number} */ steps) => {
    chat.messages.push({ role: "user", content: name, meta: { typed: name } });
    for (let i = 0; i < steps; i++) {
      chat.messages.push({ role: "assistant", content: "", tool_calls: [readCall(name + i)] },
        { role: "tool", tool_call_id: name + i, content: big, meta: { summary: name + i } });
    }
  };
  task("old", 2);
  task("now", 6); // 120k tokens: past the 30k budget, under the 150k ceiling
  trim(chat, 100_000);
  assert.deepEqual(chat.messages.filter((m) => m.meta?.stub).map((m) => m.meta.summary), ["old0", "old1"]);
  task("runaway", 0);
  for (let i = 0; i < 9; i++) {
    chat.messages.push({ role: "assistant", content: "", tool_calls: [readCall("r" + i)] },
      { role: "tool", tool_call_id: "r" + i, content: big, meta: { summary: "r" + i } });
  }
  trim(chat, 100_000); // 180k tokens in this task: the oldest go, the newest 150k stay
  assert.deepEqual(chat.messages.filter((m) => m.meta?.stub && m.meta.summary.startsWith("r")).map((m) => m.meta.summary), ["r0", "r1"]);
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

test("/compact summarises the whole chat now, small or not, with what you asked it to keep; then nothing's left to do", async () => {
  const chat = Engine.newChat();
  chat.messages.push({ role: "user", content: "rename priceOf", meta: { typed: "rename priceOf" } }, { role: "assistant", content: "Done." });
  const client = fakeClient([(req) => {
    assert.ok(!req.tools, "a summary request has no tools");
    assert.ok(req.messages[1].content.endsWith(TEXTS.compactionFocus("the API names")));
    return { content: "SUMMARY" };
  }, { content: "next answer" }]);
  const events = [];
  const e = engine(client, fakeHost(), events);
  assert.equal(await e.compactNow(chat, "the API names"), "done");
  assert.deepEqual(chat.compaction, { through: 2, summary: "SUMMARY" });
  assert.equal(client.sent.length, 1, "no reply loop after it");
  assert.equal(await e.compactNow(chat), "nothing", "nothing new since: no request");
  assert.equal(client.sent.length, 1);
  await e.ask(chat, "go on");
  assert.deepEqual(client.sent[1].slice(1, 3), [{ role: "user", content: TEXTS.compaction }, { role: "assistant", content: "SUMMARY" }]);
  assert.equal(client.sent[1].length, 4, "the summary, then your new message");
  assert.match(client.sent[1][3].content, /go on$/);
  assert.ok(events.some((x) => x.type === "busy" && x.busy === false));
});

test("/compact that fails leaves the chat as it was", async () => {
  const chat = Engine.newChat();
  chat.messages.push({ role: "user", content: "hi", meta: { typed: "hi" } }, { role: "assistant", content: "hello" });
  const client = fakeClient([() => { throw new GatewayError("The gateway answered HTTP 500.", { status: 500, retryable: false }); }]);
  const events = [];
  assert.equal(await engine(client, fakeHost(), events).compactNow(chat), "failed");
  assert.equal(chat.compaction, null);
  assert.ok(events.some((x) => x.type === "compaction-failed"));
});

test("/fork copies the chat to carry on in: its own id and title, the same history, the original untouched", () => {
  const chat = Engine.newChat();
  chat.title = "Fix the cart";
  chat.model = "model-b";
  chat.messages.push({ role: "user", content: "fix it", meta: { typed: "fix it" } }, { role: "assistant", content: "Fixed." });
  chat.compaction = { through: 0, summary: "S" };
  const copy = Engine.fork(chat);
  assert.notEqual(copy.id, chat.id);
  assert.equal(copy.title, "Fix the cart (fork)");
  assert.equal(copy.titleSource, "user", "not renamed automatically");
  assert.deepEqual(copy.messages, chat.messages);
  assert.equal(copy.model, "model-b");
  assert.deepEqual(copy.forkedFrom, { id: chat.id, title: "Fix the cart" });
  copy.messages.push({ role: "user", content: "more" });
  copy.compaction.summary = "changed";
  assert.equal(chat.messages.length, 2, "a deep copy");
  assert.equal(chat.compaction.summary, "S");
  assert.equal(Engine.fork(copy).title, "Fix the cart (fork)", "a fork of a fork isn't (fork) (fork)");
});

test("plan: a finished step's results stay while the task is small, and go first (notes standing in) once it's big", async () => {
  const big = (/** @type {string} */ what) => ({ output: what + " " + "x".repeat(3000), summary: "Read " + what });
  const host = fakeHost({ tools: { read_file: (args) => big(args.path) } });
  const plan = (/** @type {any} */ args, /** @type {string} */ id) => call(id, "plan", args);
  const client = fakeClient([
    { calls: [plan({ steps: [{ goal: "Fix A", work: "a.js, the null check" }, { goal: "Fix B", work: "b.js" }] }, "p1"), call("r1", "read_file", { path: "a.js" })] },
    { calls: [call("r2", "read_file", { path: "a2.js" })] },
    // Step 1 done, in the same reply as step 2's first read.
    { calls: [plan({ done: 1, notes: "a.js: defaulted $Path." }, "p2"), call("r3", "read_file", { path: "b.js" })] },
    (req) => {
      const results = Object.fromEntries(req.messages.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, m.content]));
      // A small task: what step 1 read stays whole, so step 2 needn't read it again.
      assert.match(results.r1, /^a\.js x/, "a finished step's read stays while the task is small");
      assert.match(results.r2, /^a2\.js x/);
      assert.match(results.r3, /^b\.js x/, "step 2's read stays whole");
      assert.match(results.p2, /\[done\] Fix A\n   Notes: a\.js: defaulted \$Path\./);
      assert.match(results.p2, /\[now\] Fix B\n   Work: b\.js/);
      return { calls: [plan({ done: 2, notes: "b.js done." }, "p3")] };
    },
    { content: "Both fixed." },
  ]);
  const chat = Engine.newChat();
  await engine(client, host).ask(chat, "fix a and b");
  assert.deepEqual(chat.plan.steps.map((step) => step.state), ["done", "done"]);
  assert.equal(chat.plan.steps[0].notes, "a.js: defaulted $Path.");
  // A new plan keeps the steps already done; a step that isn't there is an error the model can read.
  const again = fakeClient([{ calls: [plan({ steps: [{ goal: "Fix A" }, { goal: "Fix C" }] }, "p4"), plan({ done: 7 }, "p5")] }, { content: "ok" }]);
  await engine(again, host).ask(chat, "now C");
  assert.deepEqual(chat.plan.steps.map((step) => [step.goal, step.state]), [["Fix A", "done"], ["Fix C", "doing"]]);
  const p5 = chat.messages.find((m) => m.tool_call_id === "p5");
  assert.match(p5.content, /done needs a step number from 1 to 2/);

  // A big task (past the in-task ceiling): finished steps' results are cut first, their notes standing in.
  const huge = (/** @type {string} */ what) => ({ output: what + " " + "y".repeat(80_000), summary: "Read " + what });
  const bigHost = fakeHost({ tools: { read_file: (args) => huge(args.path) } });
  // Results are kept to about 30,000 characters each, so it takes a few to pass the ceiling (45k tokens at 30k).
  const bigClient = fakeClient([
    { calls: [plan({ steps: [{ goal: "Read A" }, { goal: "Read B" }] }, "q1"), call("s1", "read_file", { path: "a.js" }), call("s1b", "read_file", { path: "a2.js" }),
      call("s1c", "read_file", { path: "a3.js" })] },
    { calls: [plan({ done: 1, notes: "A read." }, "q2"), call("s2", "read_file", { path: "b.js" }), call("s2b", "read_file", { path: "b2.js" })] },
    { calls: [call("s3", "read_file", { path: "c.js" }), call("s3b", "read_file", { path: "c2.js" })] },
    (req) => {
      const results = Object.fromEntries(req.messages.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, m.content]));
      assert.match(results.s1, /^\(Step 1 is done; this result \(Read a\.js\) is left out/, "the finished step's read goes first");
      assert.match(results.s3, /^c\.js y/, "the newest stays");
      return { content: "done" };
    },
    { content: "B read too." }, // the nudge about step 2, still to do
  ]);
  const bigEvents = [];
  await engine(bigClient, bigHost, bigEvents, { compactAt: 30_000 }).ask(Engine.newChat(), "read them");
  assert.deepEqual(bigEvents.filter((e) => e.type === "error").map((e) => e.message), [], "the checks in the scripted reply passed");
});

test("plan: done before any plan says so; a plan alone isn't a step to approve", async () => {
  const client = fakeClient([{ calls: [call("p1", "plan", { done: 1 })] }, { content: "ok" }]);
  const chat = Engine.newChat();
  const events = [];
  await engine(client, fakeHost(), events).ask(chat, "go");
  assert.match(chat.messages.find((m) => m.tool_call_id === "p1").content, /no plan yet/);
  assert.ok(!events.some((e) => e.type === "approval"));
});

test("plan: a step marked done after the next step's first read leaves that read alone", async () => {
  const big = (/** @type {string} */ what) => ({ output: what + " " + "x".repeat(3000), summary: "Read " + what });
  const host = fakeHost({ tools: { read_file: (args) => big(args.path) } });
  const plan = (/** @type {any} */ args, /** @type {string} */ id) => call(id, "plan", args);
  const client = fakeClient([
    { calls: [plan({ steps: [{ goal: "Fix A" }, { goal: "Fix B" }] }, "p1"), call("r1", "read_file", { path: "a.js" })] },
    // the next step's read first, then step 1 marked done, in one reply
    { calls: [call("r2", "read_file", { path: "b.js" }), plan({ done: 1, notes: "a.js fixed." }, "p2")] },
    { calls: [call("r3", "read_file", { path: "c.js" })] },
    (req) => {
      const results = Object.fromEntries(req.messages.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, m.content]));
      assert.match(results.r1, /^\(Step 1 is done/);
      assert.match(results.r2, /^b\.js x/, "the read in the reply that finished step 1 isn't step 1's");
      return { content: "done" };
    },
  ]);
  await engine(client, host).ask(Engine.newChat(), "fix a and b");
});

test("several edits to one file in a reply: the problems check waits for the last; one that's left waiting is settled", async () => {
  const seen = [];
  const host = fakeHost();
  host.runTool = async (name, args, ctx) => {
    seen.push([name, args.path, ctx.edit]);
    if (args.old_text === "bad") return { output: "Error: old_text wasn't found", summary: "x", failed: true };
    return { output: `${name} ok`, summary: "Edited" };
  };
  host.settleEdits = async (group) => group === "e1" ? [{ path: "src/a.js", text: "\nNew problems in src/a.js", summary: " · 1 new problem" }] : [];
  const edit = (id, p, old) => call(id, "edit_file", { path: p, old_text: old, new_text: "y" });
  const client = fakeClient([
    { calls: [edit("e1", "src/a.js", "1"), edit("e2", "src\\A.js", "2"), edit("e3", "src/b.js", "3"), edit("e4", "./src/a.js", "bad")] },
    { content: "ok" },
  ]);
  const chat = Engine.newChat();
  await engine(client, host).ask(chat, "edit");
  assert.deepEqual(seen.map(([, p, hint]) => [p, hint]), [
    ["src/a.js", { group: "e1", more: true }], ["src\\A.js", { group: "e1", more: true }],
    ["src/b.js", { group: "e1", more: false }], ["./src/a.js", { group: "e1", more: false }]]);
  // e4 failed: a.js's waiting check goes with its last edit that ran (e2)
  const e2 = chat.messages.find((m) => m.tool_call_id === "e2");
  assert.match(e2.content, /New problems in src\/a\.js$/);
  assert.equal(e2.meta.summary, "Edited · 1 new problem");
});

test("the batch limit: up to 8 calls, 5 of them changes, and plan calls aside", async () => {
  const reads = (n, from = 0) => Array.from({ length: n }, (_, i) => call(`r${from + i}`, "read_file", { path: `f${from + i}.js` }));
  const edits = (n) => Array.from({ length: n }, (_, i) => call(`e${i}`, "edit_file", { path: `g${i}.js`, old_text: "a", new_text: "b" }));
  const plan = call("p1", "plan", { steps: [{ goal: "Look" }, { goal: "Fix" }] });
  const run = async (calls) => {
    const host = fakeHost();
    await engine(fakeClient([{ calls }, { content: "ok" }]), host).ask(Engine.newChat(), "go");
    return host.ran.length;
  };
  assert.equal(await run([plan, ...reads(8)]), 8, "plan with 8 reads: all of them run");
  assert.equal(await run(reads(9)), 8);
  assert.equal(await run(edits(6)), 5);
  assert.equal(await run([...reads(3), ...edits(5)]), 8, "a mixed batch runs 8 when 5 or fewer are changes");
  assert.equal(await run([...reads(3), ...edits(5), ...reads(1, 10)]), 8);
  const chat = Engine.newChat();
  await engine(fakeClient([{ calls: edits(6) }, { content: "ok" }]), fakeHost()).ask(chat, "go");
  assert.match(chat.messages.find((m) => m.tool_call_id === "e5").content, /up to 8 calls from one reply, 5 of them changes/);
});

test("an older plan result the newest holds all of is left out; one the newest doesn't hold stays", async () => {
  const plan = (/** @type {any} */ args, /** @type {string} */ id) => call(id, "plan", args);
  const client = fakeClient([
    { calls: [plan({ steps: [{ goal: "Fix A" }, { goal: "Fix B" }, { goal: "Fix C" }] }, "p1")] },
    { calls: [plan({ done: 1, notes: "A done." }, "p2")] },
    { calls: [plan({ done: 2, notes: "B done." }, "p3")] },
    // a re-plan without step C: the result before it (which had C) stays whole
    { calls: [plan({ steps: [{ goal: "Fix A" }, { goal: "Fix B" }, { goal: "Fix D" }] }, "p4")] },
    (req) => {
      const results = Object.fromEntries(req.messages.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, m.content]));
      assert.equal(results.p1, PLAN.superseded);
      assert.equal(results.p2, PLAN.superseded);
      assert.match(results.p3, /Fix C/, "it had step C, which the newest plan doesn't");
      assert.match(results.p4, /\[done\] Fix B\n   Notes: B done\./);
      return { content: "ok" };
    },
  ]);
  await engine(client, fakeHost()).ask(Engine.newChat(), "fix them");
});

test("argument problems: every missing one at once, and ones a tool doesn't take are named", async () => {
  const chat = Engine.newChat();
  const host = fakeHost();
  const client = fakeClient([
    { calls: [call("x1", "edit_file", { file_path: "a.js", old_string: "a", new_string: "b" }), call("x2", "read_file", { path: "a.js", offset: 3 })] },
    { calls: [call("x3", "read_file", { path: "a.js", offset: 3, limit: 9 })] },
    { content: "ok" },
  ]);
  await engine(client, host).ask(chat, "go");
  const text = (id) => chat.messages.find((m) => m.tool_call_id === id).content;
  assert.equal(text("x1"), "edit_file needs path, old_text and new_text; it wasn't run. It doesn't take file_path, old_string and new_string.");
  assert.match(text("x3"), /read_file ok\n\n\(read_file doesn't take offset and limit, so they were left out\.\)$/);
  assert.match(text("x2"), /\(read_file doesn't take offset, so it was left out\.\)$/);
  assert.deepEqual(host.ran.map(([name]) => name), ["read_file", "read_file"], "the edit didn't run");
});

test("a failed summary isn't asked for again before every step of the same task", async () => {
  const chat = Engine.newChat();
  for (let i = 0; i < 6; i++) chat.messages.push({ role: "user", content: "q".repeat(4000), meta: { typed: "q" } }, { role: "assistant", content: "a" });
  const client = fakeClient([new GatewayError("bad", { status: 400 }), { calls: [call("r1", "read_file", { path: "a.js" })] },
    { calls: [call("r2", "read_file", { path: "b.js" })] }, { content: "answer" }]);
  await engine(client, fakeHost(), [], { compactAt: 5000 }).ask(chat, "my new question");
  assert.equal(client.sent.filter((messages) => messages[0].content === TEXTS.compactionSystem).length, 1);
  assert.equal(chat.messages.at(-1).content, "answer");
});

test("a task that stops with plan steps left is asked once to carry on; a question or a second stop ends it", async () => {
  const plan = (/** @type {any} */ args, /** @type {string} */ id) => call(id, "plan", args);
  // Stops after step 1 with nothing asked: one nudge, then it finishes.
  const client = fakeClient([
    { calls: [plan({ steps: [{ goal: "Fix A" }, { goal: "Fix B" }] }, "p1"), call("r1", "read_file", { path: "a.js" })] },
    { calls: [plan({ done: 1, notes: "A fixed." }, "p2")] },
    { content: "I fixed A." },
    (req) => {
      const last = req.messages.at(-1);
      assert.equal(last.role, "user");
      assert.match(last.content, /The plan still has a step to do: 2\. Fix B\. Please carry on with it\./);
      return { calls: [plan({ done: 2, notes: "B fixed." }, "p3")] };
    },
    { content: "Both fixed." },
  ]);
  const chat = Engine.newChat();
  await engine(client, fakeHost()).ask(chat, "fix a and b");
  assert.equal(chat.messages.at(-1).content, "Both fixed.");
  const nudges = chat.messages.filter((m) => m.meta?.nudge);
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0].meta.typed, "Carry on (the plan had 1 step left)");
  // A reply that asks something isn't nudged; nor is a second stop.
  const asking = fakeClient([
    { calls: [plan({ steps: [{ goal: "Fix A" }, { goal: "Fix B" }] }, "q1")] },
    { content: "Before B: should it keep the old name too?" },
  ]);
  const other = Engine.newChat();
  await engine(asking, fakeHost()).ask(other, "fix a and b");
  assert.ok(!other.messages.some((m) => m.meta?.nudge));
  const stubborn = fakeClient([
    { calls: [plan({ steps: [{ goal: "Fix A" }, { goal: "Fix B" }] }, "s1")] },
    { content: "Stopping here." },
    { content: "Still stopping." },
  ]);
  const third = Engine.newChat();
  await engine(stubborn, fakeHost()).ask(third, "fix a and b");
  assert.equal(third.messages.filter((m) => m.meta?.nudge).length, 1);
  assert.equal(third.messages.at(-1).content, "Still stopping.");
  // A plan from an earlier message, not touched in this one, isn't nudged about.
  const later = fakeClient([{ content: "Hello." }]);
  await engine(later, fakeHost()).ask(third, "something else");
  assert.equal(third.messages.filter((m) => m.meta?.nudge).length, 1);
});

test("the plan nudge's and Resume's \"carry on\" keep the task's results protected (they're the same task)", () => {
  const big = "x".repeat(80_000);
  const chat = Engine.newChat();
  chat.messages.push(
    { role: "user", content: "do the thing", meta: { typed: "do the thing" } },
    { role: "assistant", content: "", tool_calls: [{ id: "r1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.js\"}" } }] },
    { role: "tool", tool_call_id: "r1", content: big, meta: { name: "read_file", summary: "Read a.js" } },
    { role: "assistant", content: "", tool_calls: [{ id: "r2", type: "function", function: { name: "read_file", arguments: "{\"path\":\"b.js\"}" } }] },
    { role: "tool", tool_call_id: "r2", content: big, meta: { name: "read_file", summary: "Read b.js" } },
    { role: "assistant", content: "I read them." },
    { role: "user", content: "carry on", meta: { typed: "Carry on", resume: true, nudge: true } },
    { role: "assistant", content: "", tool_calls: [{ id: "r3", type: "function", function: { name: "read_file", arguments: "{\"path\":\"c.js\"}" } }] },
    { role: "tool", tool_call_id: "r3", content: "small", meta: { name: "read_file", summary: "Read c.js" } });
  trim(chat, 100_000);
  assert.ok(!chat.messages[2].meta.stub && !chat.messages[4].meta.stub, "the reads before the nudge are this task's, and stay whole");
});

test("the plan nudge isn't put off by a ? in code or a URL; a question in the last lines still counts", async () => {
  const plan = (/** @type {any} */ args, /** @type {string} */ id) => call(id, "plan", args);
  const run = async (/** @type {string} */ last) => {
    const client = fakeClient([{ calls: [plan({ steps: [{ goal: "Fix A" }, { goal: "Fix B" }] }, "p1")] }, { content: last }, { content: "ok" }]);
    const chat = Engine.newChat();
    await engine(client, fakeHost()).ask(chat, "fix a and b");
    return chat.messages.filter((m) => m.meta?.nudge).length;
  };
  assert.equal(await run("Done: I replaced `a ? b : c` in src/x.js, see https://example.com/x?page=2."), 1);
  assert.equal(await run("I fixed A.\n\n```js\nconst y = x ? 1 : 2;\n```"), 1);
  assert.equal(await run("A is done. Should B keep the old name too?"), 0);
});

test("plan steps: a read in the reply that finishes a step is the next step's (and leaves with it); a re-plan keeps the step in progress", async () => {
  const big = (/** @type {string} */ what) => ({ output: what + " " + "x".repeat(3000), summary: "Read " + what });
  const host = fakeHost({ tools: { read_file: (args) => big(args.path) } });
  const plan = (/** @type {any} */ args, /** @type {string} */ id) => call(id, "plan", args);
  const client = fakeClient([
    { calls: [plan({ steps: [{ goal: "Fix A" }, { goal: "Fix B" }, { goal: "Fix C" }] }, "p1"), call("r1", "read_file", { path: "a.js" })] },
    // a re-plan partway through A (C reworded): A keeps where it began
    { calls: [plan({ steps: [{ goal: "Fix A" }, { goal: "Fix B" }, { goal: "Fix C and D" }] }, "p2")] },
    { calls: [call("r2", "read_file", { path: "b.js" }), plan({ done: 1, notes: "A fixed." }, "p3")] },
    { calls: [plan({ done: 2, notes: "B fixed." }, "p4")] },
    { calls: [call("r3", "read_file", { path: "c.js" })] },
    (req) => {
      const results = Object.fromEntries(req.messages.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, m.content]));
      assert.match(results.r1, /^\(Step 1 is done/, "A's read leaves with A, though the plan was re-made partway");
      assert.match(results.r2, /^\(Step 2 is done/, "the read in A's finishing reply was B's");
      return { content: "done" };
    },
  ]);
  await engine(client, host).ask(Engine.newChat(), "fix them");
});

test("where the tokens went: every request's prompt tokens shared out by kind, side requests apart, repeat reads counted", async () => {
  const { breakdown, repeatReads, tokenReport } = require("../src/engine.js");
  const file = "x".repeat(4000);
  const signature = { google: { thought_signature: "S".repeat(400) } };
  const usage = (prompt, out) => ({ prompt_tokens: prompt, completion_tokens: out, total_tokens: prompt + out, completion_tokens_details: { reasoning_tokens: 5 } });
  const client = fakeClient([
    { calls: [{ ...call("a", "read_file", { path: "src/a.js" }), extra: signature }], usage: usage(100, 20) },
    { calls: [call("b", "read_file", { path: ".\\SRC\\a.js", start_line: 3, end_line: 9 }), call("c", "read_file", { path: "src/b.js" })], usage: usage(1200, 20) },
    { calls: [call("d", "edit_file", { path: "src/a.js", old_text: "x", new_text: "y" })], usage: usage(2400, 20) },
    { calls: [call("e", "read_file", { path: "src/a.js" })], usage: usage(2500, 20) },
    { content: "Done.", usage: usage(3600, 30) },
    { content: "A title", usage: usage(40, 4) },
  ]);
  const host = fakeHost({ tools: {
    read_file: (args) => ({ output: file, summary: args.start_line ? "Read src/a.js · lines 3–9 of 120" : "Read · 120 lines", ...(args.path === "src/b.js" ? { keep: "KEEP".repeat(50) } : {}) }),
    edit_file: () => ({ output: "Edited.", summary: "Edited src/a.js" }),
  } });
  const chat = Engine.newChat();
  await engine(client, host).ask(chat, "fix a");
  await new Promise((resolve) => setTimeout(resolve, 20)); // the title, on its own
  const u = chat.usage;
  assert.deepEqual([u.requests, u.prompt, u.output, u.thinking, u.side], [5, 9800, 110, 25, 44]);
  assert.equal(u.tokens, 9800 + 110 + 44);
  assert.ok(Math.abs(Object.values(u.by).reduce((sum, x) => sum + x, 0) - 9800) < 1e-6, "every prompt token is attributed to something");
  assert.ok(u.by.results > u.by.system && u.by.results > 0.8 * 9800 * 0.5, "the re-sent results are the big part");
  assert.ok(u.by.signatures > 0 && u.by.kept > 0 && u.by.calls > 0 && u.by.user > 0 && u.by.tools > 0);

  const now = breakdown(chat, "SYSTEM", [{ type: "function" }]);
  assert.equal(now.system, 6);
  assert.equal(now.results, 4 * 4000 + "Edited.".length + 2); // and the blank line before what's kept
  assert.equal(now.kept, 200);
  assert.equal(now.signatures, JSON.stringify(signature).length);

  // b re-read lines of a that were still whole in the chat; e read a again after an edit (fair); c was new.
  assert.deepEqual(repeatReads(chat), { reads: 4, again: 1, againTokens: 750, afterCut: 0 }); // 4,000 characters, at this chat's token ratio (0.75)
  chat.messages.find((m) => m.tool_call_id === "a").meta.stub = true;
  assert.deepEqual(repeatReads(chat), { reads: 4, again: 0, againTokens: 0, afterCut: 1 });

  const report = tokenReport(chat, "SYSTEM", [{ type: "function" }]).join("\n");
  assert.match(report, /5 requests · 9,800 in · 110 out \(25 of it thinking\) · 44 on summaries and titles/);
  assert.match(report, /tool results\s+[\d,]+\s+\d+%/);
  assert.match(report, /The next request as it stands, about [\d,]+ tokens:/);
  assert.match(report, /Results in the chat: 4 whole, 1 cut to stand-ins/);
  assert.match(report, /Reads: 4 · none repeated while the first was still in the chat · 1 again after the first read was cut\./);
  assert.doesNotMatch(report, /src|a\.js|xxxx/, "numbers only: no paths, no text");
  // An older chat: nothing recorded by kind.
  assert.match(tokenReport({ ...Engine.newChat(), usage: { tokens: 5000 } }, "S", []).join("\n"), /not recorded \(its 5,000 tokens/);
});

test("at the step limit: no plan nudge, the turn ends paused, and Resume says there's a fresh allowance", async () => {
  const plan = (args, id) => call(id, "plan", args);
  // It wraps up as told at the limit, with a plan step left: not nudged (you're asked instead), and paused.
  const client = fakeClient([
    { calls: [plan({ steps: [{ goal: "Fix A" }, { goal: "Fix B" }] }, "p1"), call("r1", "read_file", { path: "a.js" })] },
    { calls: [plan({ done: 1, notes: "A fixed." }, "p2"), call("r2", "read_file", { path: "b.js" })] },
    { content: "A is fixed; B is still to do." },
    { content: "A title" }, // the chat's title, asked for after its first answer
    (req) => {
      assert.equal(req.messages.at(-1).content.split("\n\n").pop(), TEXTS.resumeLimit(2));
      return { content: "Carrying on with B." };
    },
    { content: "B is done too." }, // the resumed run may be nudged once, as any run
  ]);
  const events = [];
  const chat = Engine.newChat();
  const e = engine(client, fakeHost(), events, { maxRounds: 2 });
  await e.ask(chat, "fix a and b");
  await new Promise((resolve) => setTimeout(resolve, 10)); // the title, on its own
  assert.ok(!chat.messages.some((m) => m.meta?.nudge), "no nudge at the limit");
  assert.equal(events.filter((x) => x.type === "done").at(-1).limit, 2, "it ends paused at the limit");
  assert.equal(chat.limitHit, true);
  await e.resume(chat);
  assert.ok(chat.messages.some((m) => m.meta?.typed === "Carry on" && m.content.endsWith(TEXTS.resumeLimit(2))), "Resume's note says the allowance is reset");
  assert.ok(!events.some((x) => x.type === "error"), "a fresh allowance: no errors");
  assert.equal(chat.limitHit, undefined);
  // A new message after a pause starts afresh: nothing about the limit.
  chat.limitHit = true;
  const fresh = fakeClient([{ content: "ok" }]);
  await engine(fresh, fakeHost(), [], { maxRounds: 2 }).ask(chat, "something else");
  assert.equal(chat.limitHit, undefined);

  // It makes calls anyway after the last allowed reply: those are refused, and Resume still says the allowance is reset.
  const pushy = fakeClient([
    { calls: [call("1", "problems", {})] }, { calls: [call("2", "problems", { path: "a" })] }, { calls: [call("3", "problems", { path: "b" })] },
    (req) => { assert.equal(req.messages.at(-1).content.split("\n\n").pop(), TEXTS.resumeLimit(2)); return { content: "done" }; },
  ]);
  const other = Engine.newChat();
  const p = engine(pushy, fakeHost(), [], { maxRounds: 2 });
  await p.ask(other, "go");
  assert.equal(other.messages.filter((m) => m.role === "tool").at(-1).content, TEXTS.notRunLimit);
  await p.resume(other);
  assert.equal(other.messages.at(-1).content, "done");
});
