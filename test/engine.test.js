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

test("a failed edit stops the later changes to its file; a failed read stops nothing", async () => {
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
  assert.equal(results[3].content, TEXTS.notRunSameFile, "the second edit to the same file was written for the file as the first would have left it");
});

test("a change that fails: other files' changes still run; a move or a removal after it doesn't; a decline stops everything", async () => {
  const edit = (id, file) => call(id, "edit_file", { path: file, old_text: "x", new_text: "y" });
  const failing = (file) => ({ tools: { edit_file: (a) => a.path === file ? { output: "Error: old_text wasn't found in " + file, summary: "x", failed: true } : { output: "Edited.", summary: "Edited" },
    write_file: (a) => a.path === file ? { output: "Error: it's a folder", summary: "x", failed: true } : { output: "Wrote.", summary: "Wrote" } } });
  const run = async (calls, options) => {
    const host = fakeHost(options);
    const chat = Engine.newChat();
    await engine(fakeClient([{ calls }, { content: "ok" }]), host).ask(chat, "go");
    return { ran: host.ran.map(([name, args]) => `${name} ${args.path || args.from}`), said: Object.fromEntries(chat.messages.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, m.content])) };
  };
  // The second of five misses: the other three files are still changed, and a read after it still runs.
  let out = await run([edit("1", "a.js"), edit("2", "b.js"), edit("3", "c.js"), call("r", "read_file", { path: "b.js" }), edit("4", "B.JS"), edit("5", "d.js"), call("w", "write_file", { path: "./b.js", content: "all of it" })], failing("b.js"));
  assert.deepEqual(out.ran, ["edit_file a.js", "edit_file b.js", "edit_file c.js", "read_file b.js", "edit_file d.js"]);
  assert.equal(out.said["4"], TEXTS.notRunSameFile, "the same file, however it's spelt");
  assert.equal(out.said.w, TEXTS.notRunSameFile, "a write over the file that the failed edit was for");
  // Nothing is moved or removed after a change that failed, whichever file it was.
  out = await run([edit("1", "a.js"), call("m", "move_item", { from: "old.js", to: "new.js" }), call("d", "remove_item", { path: "old.js" }), edit("2", "c.js")], failing("a.js"));
  assert.deepEqual(out.ran, ["edit_file a.js", "edit_file c.js"]);
  assert.deepEqual([out.said.m, out.said.d], [TEXTS.notRun, TEXTS.notRun]);
  // A write that fails is the same as an edit that does.
  out = await run([call("w", "write_file", { path: "a.js", content: "x" }), edit("1", "a.js"), edit("2", "c.js")], failing("a.js"));
  assert.deepEqual(out.ran, ["write_file a.js", "edit_file c.js"]);
  // A move that fails stops the rest, as it always did: what follows a move is usually about where things now are.
  out = await run([call("m", "move_item", { from: "a.js", to: "lib/a.js" }), edit("1", "lib/a.js"), edit("2", "c.js")],
    { tools: { move_item: () => ({ output: "Error: something is already there", summary: "x", failed: true }) } });
  assert.deepEqual(out.ran, ["move_item a.js"]);
  assert.deepEqual([out.said["1"], out.said["2"]], [TEXTS.notRun, TEXTS.notRun]);
});

test("a change you decline stops the rest of the reply, other files included", async () => {
  const host = fakeHost({ approval: () => ({ decision: "decline" }) });
  const chat = Engine.newChat();
  await engine(fakeClient([{ calls: [call("w", "write_file", { path: "C:\outside\a.txt", content: "x" }), call("e", "edit_file", { path: "b.js", old_text: "x", new_text: "y" })] }, { content: "ok" }]), host).ask(chat, "go");
  assert.deepEqual(host.ran, [], "neither ran");
  assert.equal(chat.messages.find((m) => m.tool_call_id === "e").content, TEXTS.notRun);
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

test("a change whose text is Solder's old 'left out' note is refused, never run: it isn't text for a file", async () => {
  const note = "[Solder: 59 lines, left out of this copy of the chat to save space. They're in the file; read it if you need them.]";
  const client = fakeClient([
    { calls: [call("e1", "edit_file", { path: "a.ps1", old_text: "real line", new_text: note }), call("w1", "write_file", { path: "b.ps1", content: note })] },
    { content: "Sorry." },
  ]);
  const host = fakeHost();
  const chat = Engine.newChat();
  await engine(client, host).ask(chat, "add the block");
  assert.deepEqual(host.ran, [], "neither reached the tools");
  const results = client.sent[1].filter((m) => m.role === "tool").map((m) => m.content);
  assert.equal(results[0], TEXTS.standInArgument);
  // Real text that only mentions Solder goes through.
  const fine = fakeClient([{ calls: [call("e2", "edit_file", { path: "a.md", old_text: "x", new_text: "See [Solder: the docs] for more." })] }, { content: "ok" }]);
  const other = fakeHost();
  await engine(fine, other).ask(Engine.newChat(), "edit");
  assert.equal(other.ran.length, 1);
});

test("earlier tasks' big writes go as they came (some models copied the shortened ones); this task's too, a Resume included", async () => {
  const write = (id) => ({ id, type: "function", function: { name: "write_file",
    arguments: JSON.stringify({ path: id + ".js", content: "line\n".repeat(2000) }) } });
  const chat = Engine.newChat();
  chat.messages.push({ role: "user", content: "write a", meta: { typed: "x" } }, { role: "assistant", content: "", tool_calls: [write("a")] },
    { role: "tool", tool_call_id: "a", content: "Wrote a.js.", meta: {} }, { role: "assistant", content: "Done." },
    { role: "user", content: "write b", meta: { typed: "x" } }, { role: "assistant", content: "", tool_calls: [write("b")] },
    { role: "tool", tool_call_id: "b", content: "Wrote b.js.", meta: {} });
  const sent = outbound(chat, "S");
  // Left out, such a model sent its next write_file the same way, with no content (a round trip lost each time).
  assert.equal(sent[2].tool_calls[0], chat.messages[1].tool_calls[0], "an earlier task's call goes as it came");
  assert.ok(!JSON.stringify(sent).includes("left out"), "nothing says it was left out");
  assert.equal(sent[3].content, "Wrote a.js.");
  assert.equal(sent[6].tool_calls[0], chat.messages[5].tool_calls[0], "this turn's call goes as it came");
  assert.equal(sent[7].content, "Wrote b.js.");
  // After a Resume's "carry on" it's still the same task: its calls stay whole.
  chat.messages.push({ role: "user", content: "carry on", meta: { typed: "Carry on", resume: true } });
  assert.equal(outbound(chat, "S")[6].tool_calls[0], chat.messages[5].tool_calls[0], "the task's own call, whole after a Resume");
  // A call copied from a shortened one lacks a required argument: refused before it runs.
  assert.match(parseArguments("write_file", JSON.stringify({ path: "a.js" }), false).problem || "", /write_file needs content/);

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

test("this task's results stay whole up to twice the compaction limit; earlier tasks' are cut past the budget", () => {
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
  task("now", 9); // 180k tokens: past the 30k budget, under the 200k ceiling (it was cut at 150k before)
  trim(chat, 100_000);
  assert.deepEqual(chat.messages.filter((m) => m.meta?.stub).map((m) => m.meta.summary), ["old0", "old1"]);
  task("runaway", 0);
  for (let i = 0; i < 12; i++) {
    chat.messages.push({ role: "assistant", content: "", tool_calls: [readCall("r" + i)] },
      { role: "tool", tool_call_id: "r" + i, content: big, meta: { summary: "r" + i } });
  }
  trim(chat, 100_000); // 240k tokens in this task: the oldest go, the newest 200k stay
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

test("several edits in a reply: every file's problems check waits for the end of them, and goes with its last edit that ran", async () => {
  const seen = [];
  const host = fakeHost();
  host.runTool = async (name, args, ctx) => {
    seen.push([name, args.path, ctx.edit]);
    if (args.old_text === "bad") return { output: "Error: old_text wasn't found", summary: "x", failed: true };
    return { output: `${name} ok`, summary: "Edited" };
  };
  host.settleEdits = async (group) => group === "e1" ? [{ path: "src/a.js", text: "\nNew problems in src/a.js", summary: " · 1 new problem" },
    { path: "src/b.js", text: "\nNew problems in src/b.js", summary: " · 2 new problems" }] : [];
  const edit = (id, p, old) => call(id, "edit_file", { path: p, old_text: old, new_text: "y" });
  const client = fakeClient([
    { calls: [edit("e1", "src/a.js", "1"), edit("e2", "src\\A.js", "2"), edit("e3", "src/b.js", "3"), edit("e4", "./src/a.js", "bad")] },
    { content: "ok" },
  ]);
  const chat = Engine.newChat();
  await engine(client, host).ask(chat, "edit");
  assert.deepEqual(seen.map(([, p, hint]) => [p, hint]), [
    ["src/a.js", { group: "e1", more: true }], ["src\\A.js", { group: "e1", more: true }],
    ["src/b.js", { group: "e1", more: true }], ["./src/a.js", { group: "e1", more: true }]]);
  // e4 failed: a.js's waiting check goes with its last edit that ran (e2); b.js's goes with its own.
  const e2 = chat.messages.find((m) => m.tool_call_id === "e2");
  assert.match(e2.content, /New problems in src\/a\.js$/);
  assert.equal(e2.meta.summary, "Edited · 1 new problem");
  const e3 = chat.messages.find((m) => m.tool_call_id === "e3");
  assert.match(e3.content, /New problems in src\/b\.js$/);
  assert.equal(e3.meta.summary, "Edited · 2 new problems");
  assert.ok(!/New problems/.test(chat.messages.find((m) => m.tool_call_id === "e1").content), "said once a file, not after each of its edits");

  // An edit by itself in a reply is checked at once, as ever.
  seen.length = 0;
  await engine(fakeClient([{ calls: [edit("s1", "src/a.js", "1"), call("r", "read_file", { path: "src/a.js" })] }, { content: "ok" }]), host).ask(Engine.newChat(), "edit");
  assert.deepEqual(seen[0][2], { group: "s1", more: false });
});

test("a reply's calls all run, reads and changes alike, up to a guard no task meets (50)", async () => {
  const reads = (n, from = 0) => Array.from({ length: n }, (_, i) => call(`r${from + i}`, "read_file", { path: `f${from + i}.js` }));
  const edits = (n) => Array.from({ length: n }, (_, i) => call(`e${i}`, "edit_file", { path: `g${i}.js`, old_text: "a", new_text: "b" }));
  const run = async (calls) => {
    const host = fakeHost();
    await engine(fakeClient([{ calls }, { content: "ok" }]), host).ask(Engine.newChat(), "go");
    return host.ran.length;
  };
  assert.equal(await run(reads(12)), 12);
  assert.equal(await run(edits(20)), 20, "a refactor's twenty edits run in one step");
  assert.equal(await run([...reads(6), ...edits(15), ...reads(4, 10)]), 25, "mixed, in the order sent");
  assert.equal(await run(edits(50)), 50);
  assert.equal(await run(edits(53)), 50, "past the guard, the rest are refused");
  const chat = Engine.newChat();
  await engine(fakeClient([{ calls: edits(52) }, { content: "ok" }]), fakeHost()).ask(chat, "go");
  assert.equal(chat.messages.find((m) => m.tool_call_id === "e49").meta.failed, false, "the fiftieth ran");
  for (const id of ["e50", "e51"]) assert.match(chat.messages.find((m) => m.tool_call_id === id).content, /^Not run: Solder runs up to 50 calls from one reply\. Send it again/);
  // A change that fails doesn't stop the changes to other files.
  const stops = fakeHost();
  const run3 = stops.runTool;
  stops.runTool = async (name, args, ctx) => args.path === "g2.js" ? { output: "Error: no match", summary: "failed", failed: true } : run3.call(stops, name, args, ctx);
  const halted = Engine.newChat();
  await engine(fakeClient([{ calls: edits(20) }, { content: "ok" }]), stops).ask(halted, "go");
  assert.equal(halted.messages.filter((m) => m.role === "tool" && !m.meta.failed).length, 19, "one of twenty missed, and the other nineteen files were still changed");
  assert.equal(halted.messages.filter((m) => m.role === "tool" && /^Not run/.test(m.content)).length, 0);
});

test("argument problems: every missing one at once, and ones a tool doesn't take are named", async () => {
  const chat = Engine.newChat();
  const host = fakeHost();
  const client = fakeClient([
    { calls: [call("x1", "edit_file", { target_file: "a.js", before: "a", after: "b" }), call("x2", "read_file", { path: "a.js", offset: 3 })] },
    { calls: [call("x3", "read_file", { path: "a.js", offset: 3, limit: 9 })] },
    { content: "ok" },
  ]);
  await engine(client, host).ask(chat, "go");
  const text = (id) => chat.messages.find((m) => m.tool_call_id === id).content;
  assert.equal(text("x1"), "edit_file needs path, old_text and new_text; it wasn't run. It doesn't take target_file, before and after.");
  assert.match(text("x3"), /read_file ok\n\n\(read_file doesn't take offset and limit, so they were left out\.\)$/);
  assert.match(text("x2"), /\(read_file doesn't take offset, so it was left out\.\)$/);
  assert.deepEqual(host.ran.map(([name]) => name), ["read_file", "read_file"], "the edit didn't run");
});

test("a call's small slips are forgiven on the Tool lane as on the Assist lane: other agents' argument names, a trailing comma, a Windows path", async () => {
  const chat = Engine.newChat();
  const host = fakeHost();
  const client = fakeClient([
    { calls: [
      call("a1", "edit_file", { file_path: "a.js", old_string: "a", new_string: "b" }),
      { id: "a2", name: "read_file", arguments: '{"path": "src/app.js", "start_line": 3,}' },
      { id: "a3", name: "read_file", arguments: String.raw`{"path": "C:\Scripts\Deploy\win.ps1"}` },
      { id: "a4", name: "write_file", arguments: '{"path": "notes.txt", "content": "line one\nline two"}' },
      call("a5", "search", { query: "oldName", pattern: "*.js" }),
      call("a6", "edit_file", { path: "b.js", file_path: "ignored.js", old_text: "a", new_text: "b" }),
    ] },
    { calls: [{ id: "a7", name: "read_file", arguments: '{"path": ' }] },
    { content: "ok" },
  ]);
  await engine(client, host).ask(chat, "go");
  const ran = Object.fromEntries(host.ran.map(([name, args], n) => [`a${n + 1}`, [name, args]]));
  assert.deepEqual(ran.a1, ["edit_file", { path: "a.js", old_text: "a", new_text: "b" }]);
  assert.deepEqual(ran.a2, ["read_file", { path: "src/app.js", start_line: 3 }], "a trailing comma");
  assert.deepEqual(ran.a3, ["read_file", { path: "C:\\Scripts\\Deploy\\win.ps1" }], "a Windows path with single backslashes");
  assert.deepEqual(ran.a4, ["write_file", { path: "notes.txt", content: "line one\nline two" }], "a real line break inside a string");
  assert.deepEqual(ran.a5, ["search", { query: "oldName", glob: "*.js" }], "an alias goes to the argument that's missing");
  assert.equal(ran.a6[1].path, "b.js", "the tool's own name wins when both are given");
  assert.match(chat.messages.find((m) => m.tool_call_id === "a6").content, /doesn't take file_path, so it was left out/);
  assert.equal(host.ran.length, 6);
  assert.equal(chat.messages.find((m) => m.tool_call_id === "a7").meta.failed, true, "what can't be read at all is still refused");
  // What's sent back to the model is the call as it wrote it (a provider may check it against its own record).
  assert.equal(chat.messages.find((m) => m.tool_calls)?.tool_calls[1].function.arguments, '{"path": "src/app.js", "start_line": 3,}');
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

test("Resume's \"carry on\" keeps the task's results protected (it's the same task)", () => {
  const big = "x".repeat(80_000);
  const chat = Engine.newChat();
  chat.messages.push(
    { role: "user", content: "do the thing", meta: { typed: "do the thing" } },
    { role: "assistant", content: "", tool_calls: [{ id: "r1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.js\"}" } }] },
    { role: "tool", tool_call_id: "r1", content: big, meta: { name: "read_file", summary: "Read a.js" } },
    { role: "assistant", content: "", tool_calls: [{ id: "r2", type: "function", function: { name: "read_file", arguments: "{\"path\":\"b.js\"}" } }] },
    { role: "tool", tool_call_id: "r2", content: big, meta: { name: "read_file", summary: "Read b.js" } },
    { role: "assistant", content: "I read them." },
    { role: "user", content: "carry on", meta: { typed: "Carry on", resume: true } },
    { role: "assistant", content: "", tool_calls: [{ id: "r3", type: "function", function: { name: "read_file", arguments: "{\"path\":\"c.js\"}" } }] },
    { role: "tool", tool_call_id: "r3", content: "small", meta: { name: "read_file", summary: "Read c.js" } });
  trim(chat, 100_000);
  assert.ok(!chat.messages[2].meta.stub && !chat.messages[4].meta.stub, "the reads before the carry-on are this task's, and stay whole");
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
  // e read all of a again, so the two earlier copies of it (a whole, b its lines 3–9) were cut: b.js and e are whole.
  assert.equal(now.results, 2 * 4000 + "Edited.".length + 2); // and the blank line before what's kept
  assert.deepEqual(["a", "b", "c", "e"].map((id) => !!chat.messages.find((m) => m.tool_call_id === id).meta.superseded), [true, true, false, false]);
  assert.equal(now.kept, 200);
  assert.equal(now.signatures, JSON.stringify(signature).length);

  // b re-read lines of a that were still whole in the chat; e read a again after an edit (fair); c was new.
  // 4,000 characters at this chat's token ratio (which goes by the size of what was sent, the tools' definitions included,
  // so it isn't a number to write down here: it moved every time a tool's description did).
  const again = repeatReads(chat);
  assert.deepEqual({ ...again, againTokens: 0 }, { reads: 4, again: 1, againTokens: 0, afterCut: 0 });
  assert.equal(again.againTokens, Math.round(1000 * (chat.tokenRatio || 1)));
  // (a copy cut because it was read again was whole when that happened: it still counts as a repeat.)
  delete chat.messages.find((m) => m.tool_call_id === "a").meta.superseded; // cut for space instead, before b read it again
  assert.deepEqual(repeatReads(chat), { reads: 4, again: 0, againTokens: 0, afterCut: 1 });

  const report = tokenReport(chat, "SYSTEM", [{ type: "function" }]).join("\n");
  assert.match(report, /5 requests · 9,800 in · 110 out \(25 of it thinking\) · 44 on summaries and titles/);
  assert.match(report, /tool results\s+[\d,]+\s+\d+%/);
  assert.match(report, /The next request as it stands, about [\d,]+ tokens:/);
  assert.match(report, /Results in the chat: 3 whole, 2 cut to stand-ins/);
  assert.match(report, /Reads: 4 · none repeated while the first was still in the chat · 1 again after the first read was cut\./);
  assert.doesNotMatch(report, /src|a\.js|xxxx/, "numbers only: no paths, no text");
  // An older chat: nothing recorded by kind.
  assert.match(tokenReport({ ...Engine.newChat(), usage: { tokens: 5000 } }, "S", []).join("\n"), /not recorded \(its 5,000 tokens/);
});

test("at the step limit: no nudge, the turn ends paused, and Resume says there's a fresh allowance", async () => {
  // It wraps up as told at the limit, with work left: not nudged (you're asked instead), and paused.
  const client = fakeClient([
    { calls: [call("r1", "read_file", { path: "a.js" })] },
    { calls: [call("r2", "read_file", { path: "b.js" })] },
    { content: "A is fixed; B is still to do." },
    { content: "A title" }, // the chat's title, asked for after its first answer
    (req) => {
      assert.equal(req.messages.at(-1).content.split("\n\n").pop(), TEXTS.resumeLimit(2));
      return { content: "Carrying on with B." };
    },
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

test("Resume never summarises the task it resumes, however big: only the turns before it", async () => {
  const big = "x".repeat(60_000);
  const read = (id) => [{ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: "{\"path\":\"big.log\"}" } }] },
    { role: "tool", tool_call_id: id, content: big, meta: { name: "read_file", summary: "Read big.log" } }];
  // One turn, far past the limit, paused: Resume carries on with everything it read.
  const single = Engine.newChat();
  single.messages.push({ role: "user", content: "read all of big.log", meta: { typed: "read all of big.log" } }, ...read("r1"), ...read("r2"), ...read("r3"));
  const client = fakeClient([{ content: "Here's what it says." }]);
  await engine(client, fakeHost(), [], { compactAt: 30_000 }).resume(single);
  assert.equal(single.compaction, null, "nothing was summarised");
  assert.ok(!client.sent.some((messages) => String(messages.at(-1).content).startsWith(TEXTS.compactionTranscript)), "no summary was asked for");
  assert.ok(client.sent[0].some((m) => m.role === "tool" && m.content === big), "what it read is still there");
  // With an earlier turn: that one is summarised, the resumed task is kept whole.
  const two = Engine.newChat();
  two.messages.push({ role: "user", content: "earlier " + "e".repeat(80_000), meta: { typed: "earlier" } }, { role: "assistant", content: "earlier answer" },
    { role: "user", content: "read all of big.log", meta: { typed: "read all of big.log" } }, ...read("r1"), ...read("r2"));
  const second = fakeClient([{ content: "SUMMARY" }, { content: "Done." }]);
  await engine(second, fakeHost(), [], { compactAt: 30_000 }).resume(two);
  assert.equal(two.compaction?.through, 2, "summarised up to the task's own message, not past it");
  assert.ok(second.sent[1].some((m) => m.role === "tool" && m.content === big), "the task's reads go on whole");
});

test("a message queued while a reply fails isn't sent by itself: it goes back to you, and the error stays to act on", async () => {
  const events = [];
  /** @type {any} */
  let e;
  const client = fakeClient([
    () => ({ calls: [call("1", "read_file", { path: "a.js" })] }),
    () => { e.steer("also look at b.js"); return Object.assign(new GatewayError("The allowance is used up.", { status: 429 }), { exhausted: true }); },
  ]);
  e = engine(client, fakeHost(), events);
  const chat = Engine.newChat();
  await e.ask(chat, "read a.js");
  const unsent = events.find((event) => event.type === "steer-unsent");
  assert.equal(events.some((event) => event.type === "error"), true);
  assert.deepEqual([unsent?.text, unsent?.send], ["also look at b.js", false], "not sent at once into the same failure");
  // A reply that just ends (no failure, no Stop) still sends it as the next message.
  const calm = [];
  /** @type {any} */
  let e2;
  e2 = engine(fakeClient([() => { e2.steer("and b.js"); return { content: "Done." }; }]), fakeHost(), calm);
  await e2.ask(Engine.newChat(), "read a.js");
  assert.equal(calm.find((event) => event.type === "steer-unsent")?.send, true);
});

test("read-only mode turned on while a reply's calls run stops the changes still to come, and one waiting for your Allow", async () => {
  let readOnly = false;
  const host = fakeHost({ tools: { read_file: () => { readOnly = true; return { output: "text", summary: "read" }; } } });
  const client = fakeClient([
    { calls: [call("1", "read_file", { path: "a.js" }), call("2", "write_file", { path: "b.js", content: "x" })] },
    { content: "Couldn't." },
  ]);
  const e = new Engine({ client, host, retryDelays: [0, 0], now: () => new Date(2026, 10, 4, 14, 5),
    settings: () => ({ model: "m", compactAt: 100_000, maxRounds: 30, readOnly }), onEvent() {} });
  const chat = Engine.newChat();
  await e.ask(chat, "read then write");
  assert.deepEqual(host.ran.map(([name]) => name), ["read_file"], "the write that followed never ran");
  assert.equal(chat.messages.find((m) => m.tool_call_id === "2")?.content, TEXTS.readOnly);

  // Asked about first (outside the workspace), and read-only mode arrives before you click Allow.
  let later = false;
  const asking = fakeHost();
  /** @type {any} */
  let e2;
  e2 = new Engine({ client: fakeClient([{ calls: [call("1", "write_file", { path: "C:\\out.txt", content: "x" })] }, { content: "Couldn't." }]), host: asking, retryDelays: [0, 0],
    now: () => new Date(2026, 10, 4, 14, 5), settings: () => ({ model: "m", compactAt: 100_000, maxRounds: 30, readOnly: later }),
    onEvent: (event) => { if (event.type === "approval") { later = true; setImmediate(() => e2.decide(event.id, { decision: "allow" })); } } });
  const second = Engine.newChat();
  await e2.ask(second, "write outside");
  assert.deepEqual(asking.ran, [], "Allow doesn't run it once read-only mode is on");
  assert.equal(second.messages.find((m) => m.tool_call_id === "1")?.content, TEXTS.readOnly);
});

test("a file read again in a task: the older copy is cut to a line that points at the newer one, and nothing else is", async () => {
  const { supersedeReads } = require("../src/engine.js");
  const body = (/** @type {string} */ mark) => mark.repeat(3000);
  const reads = [];
  const host = fakeHost({ tools: {
    read_file: (args) => {
      reads.push(args);
      if (args.path === "skill.md") return { output: body("s"), summary: "Read the skill", keep: "KEPT" };
      if (args.path === "small.js") return { output: "tiny", summary: "Read small.js · 1 line" };
      return { output: body(String(reads.length)), summary: args.start_line ? `Read ${args.path} · lines ${args.start_line}–${args.end_line} of 400` : `Read ${args.path} · 400 lines` };
    },
    edit_file: () => ({ output: "Edited.", summary: "Edited a.js" }),
  } });
  const client = fakeClient([
    { calls: [call("1", "read_file", { path: "a.js", start_line: 10, end_line: 50 }), call("2", "read_file", { path: "b.js" }), call("3", "read_file", { path: "skill.md" }), call("4", "read_file", { path: "small.js" })] },
    { calls: [call("5", "read_file", { path: "a.js", start_line: 40, end_line: 90 })] }, // overlaps the first, doesn't cover it
    { calls: [call("6", "edit_file", { path: "a.js", old_text: "x", new_text: "y" })] },
    { calls: [call("7", "read_file", { path: "a.js" }), call("8", "read_file", { path: "skill.md" }), call("9", "read_file", { path: "small.js" })] }, // all of a again
    { content: "Done." },
  ]);
  const chat = Engine.newChat();
  await engine(client, host).ask(chat, "work on a");
  const of = (/** @type {string} */ id) => chat.messages.find((m) => m.tool_call_id === id);
  assert.deepEqual(["1", "2", "3", "4", "5", "7", "8", "9"].map((id) => !!of(id).meta.superseded), [true, false, false, false, true, false, false, false],
    "both partial reads of a.js went once all of it was read again; b.js, the skill (it carries what's kept) and the tiny file stay");
  // What the model was sent at each step: an overlap that doesn't cover leaves the older read alone.
  const sent = (/** @type {number} */ step, /** @type {string} */ id) => client.sent[step].find((m) => m.tool_call_id === id)?.content;
  assert.equal(sent(2, "1"), body("1"), "after the second read (lines 40–90), the first (10–50) is still whole");
  assert.equal(sent(4, "1"), TEXTS.superseded("Read a.js · lines 10–50 of 400"));
  assert.equal(sent(4, "5"), TEXTS.superseded("Read a.js · lines 40–90 of 400"));
  assert.equal(sent(4, "7"), body("6"), "the newer copy (the sixth read) is whole");
  assert.doesNotMatch(TEXTS.superseded("x"), /read it again/i, "it doesn't send the model back to read");
  assert.equal(supersedeReads(chat), 0, "nothing more to cut the second time round");

  // Another task: a read there doesn't reach back into the task before it.
  const later = fakeClient([{ calls: [call("10", "read_file", { path: "b.js" })] }, { content: "Done." }]);
  await engine(later, host).ask(chat, "now look at b");
  assert.equal(!!of("2").meta.superseded, false, "an earlier task's read is left to the usual trimming");

  // A newer read that came back capped (its middle left out) doesn't hold every line it names: the older stays.
  const capped = Engine.newChat();
  let n = 0;
  const big = fakeHost({ tools: { read_file: () => ({ output: (++n === 1 ? "a" : "b").repeat(n === 1 ? 3000 : 50_000), summary: "Read c.js · 9,000 lines" }) } });
  await engine(fakeClient([{ calls: [call("1", "read_file", { path: "c.js" })] }, { calls: [call("2", "read_file", { path: "./c.js" })] }, { content: "Done." }]), big).ask(capped, "read c twice");
  assert.equal(!!capped.messages.find((m) => m.tool_call_id === "1").meta.superseded, false);
});

test("looks next to each other in a reply run a few at a time; their results stay in the order asked, and a change waits its turn", async () => {
  /** A host whose tools take a while, and which records what ran beside what. */
  const slowHost = (/** @type {Record<string, number>} */ delays = {}, /** @type {Set<string>} */ failing = new Set()) => {
    const host = fakeHost();
    let running = 0;
    const log = { most: 0, order: /** @type {string[]} */ ([]), during: /** @type {Record<string, string[]>} */ ({}) };
    const active = new Set();
    host.runTool = async (name, args) => {
      const id = String(args.path || args.query || args.glob || name);
      host.ran.push([name, args]);
      log.order.push("start " + id);
      log.during[id] = [...active];
      active.add(id);
      running++;
      log.most = Math.max(log.most, running);
      await new Promise((resolve) => setTimeout(resolve, delays[id] ?? 20));
      running--;
      active.delete(id);
      log.order.push("end " + id);
      return failing.has(id) ? { output: "Error: gone", summary: "failed", failed: true } : { output: `${id} ok`, summary: `${name} done` };
    };
    return Object.assign(host, { log });
  };
  const read = (/** @type {string} */ file) => call("c-" + file, "read_file", { path: file });
  const ids = (/** @type {any} */ chat) => chat.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);

  // Eight reads: four at a time, never more; the first asked takes longest, and is still answered first.
  let host = slowHost({ "f0.js": 60 });
  let chat = Engine.newChat();
  await engine(fakeClient([{ calls: Array.from({ length: 8 }, (_, i) => read(`f${i}.js`)) }, { content: "ok" }]), host).ask(chat, "go");
  assert.equal(host.log.most, 4);
  assert.deepEqual(host.log.order.slice(0, 4), ["start f0.js", "start f1.js", "start f2.js", "start f3.js"], "started in the order asked");
  assert.deepEqual(ids(chat), Array.from({ length: 8 }, (_, i) => `c-f${i}.js`), "answered in the order asked");
  assert.equal(chat.messages.filter((m) => m.role === "tool" && !m.meta.failed).length, 8);

  // A change between reads: nothing after it starts until it's done, and it doesn't start until the reads before it are.
  host = slowHost();
  chat = Engine.newChat();
  await engine(fakeClient([{ calls: [read("a.js"), read("b.js"), call("e1", "edit_file", { path: "a.js", old_text: "x", new_text: "y" }), read("c.js"), read("d.js")] }, { content: "ok" }]), host).ask(chat, "go");
  const order = host.log.order;
  assert.ok(order.indexOf("end b.js") < order.indexOf("start a.js", 1) || order.filter((line) => line === "start a.js").length === 2);
  const editStart = order.lastIndexOf("start a.js");
  assert.ok(order.indexOf("end a.js") < editStart && order.indexOf("end b.js") < editStart, "the edit waited for the reads before it");
  assert.ok(order.lastIndexOf("end a.js") < order.indexOf("start c.js"), "and the reads after it waited for the edit");
  assert.deepEqual(host.log.during["d.js"], ["c.js"], "which then ran side by side");
  assert.deepEqual(ids(chat), ["c-a.js", "c-b.js", "e1", "c-c.js", "c-d.js"]);

  // A read that fails doesn't stop the ones beside it; nor does a change that fails stop the reads after it.
  host = slowHost({}, new Set(["b.js"]));
  chat = Engine.newChat();
  await engine(fakeClient([{ calls: [read("a.js"), read("b.js"), read("c.js")] }, { content: "ok" }]), host).ask(chat, "go");
  assert.deepEqual(chat.messages.filter((m) => m.role === "tool").map((m) => m.meta.failed), [false, true, false]);
  host = slowHost();
  host.runTool = ((inner) => async (name, args) => name === "edit_file" ? (host.ran.push([name, args]), { output: "Error: no match", summary: "failed", failed: true }) : inner(name, args))(host.runTool);
  chat = Engine.newChat();
  await engine(fakeClient([{ calls: [call("e1", "edit_file", { path: "a.js", old_text: "x", new_text: "y" }), read("c.js"), read("d.js")] }, { content: "ok" }]), host).ask(chat, "go");
  assert.deepEqual(host.ran.map(([name]) => name), ["edit_file", "read_file", "read_file"], "the reads after a failed change still run");

  // The same read twice, and a call that has to be asked about, are never started ahead.
  host = slowHost();
  chat = Engine.newChat();
  await engine(fakeClient([{ calls: [read("a.js"), read("a.js"), read("b.js"), call("p1", "problems", { path: "a.js" }), read("c.js")] }, { content: "ok" }]), host).ask(chat, "go");
  assert.deepEqual(host.ran.map(([name, args]) => `${name} ${args.path}`), ["read_file a.js", "read_file b.js", "problems a.js", "read_file c.js"]);
  assert.match(chat.messages.find((m) => m.role === "tool" && /same call/.test(m.content)).content, /Not run again/);
  assert.deepEqual(host.log.during["a.js"], [], "problems ran by itself (it opens the file to have it checked)");
});

test("Stop while several looks run: each is answered, none is left without a result", async () => {
  const host = fakeHost();
  host.runTool = async (name, args) => { host.ran.push([name, args]); await new Promise((resolve) => setTimeout(resolve, 200)); return { output: "late", summary: "late" }; };
  const chat = Engine.newChat();
  const e = engine(fakeClient([{ calls: Array.from({ length: 6 }, (_, i) => call(`r${i}`, "read_file", { path: `f${i}.js` })) }, { content: "ok" }]), host);
  setTimeout(() => e.stop(), 30);
  await e.ask(chat, "go");
  const results = chat.messages.filter((m) => m.role === "tool");
  assert.equal(results.length, 6, "every call has its answer");
  assert.ok(results.every((m) => m.meta.failed && /stopped|Not run/i.test(m.content)), results.map((m) => m.content.slice(0, 30)).join(" | "));
  assert.ok(host.ran.length <= 4, "no more were started than run at once");
});

test("a turn's working time is kept on its first message: a Resume adds to it, and time waiting on your approval doesn't count", async () => {
  const slow = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const host = fakeHost();
  host.runTool = async (name, args) => { host.ran.push([name, args]); await slow(60); return { output: "ok", summary: "done" }; };
  const chat = Engine.newChat();
  const e = engine(fakeClient([{ calls: [call("r1", "read_file", { path: "a.js" })] }, { content: "first answer" }]), host);
  await e.ask(chat, "go");
  const first = chat.messages[0].meta.worked;
  assert.ok(first >= 55 && first < 2000, `worked ${first} ms`);
  // Resume is the same turn: its time adds to the same total.
  chat.messages.pop();
  const again = engine(fakeClient([{ calls: [call("r2", "read_file", { path: "b.js" })] }, { content: "done" }]), host);
  await again.resume(chat);
  assert.ok(chat.messages[0].meta.worked >= first + 55, `${chat.messages[0].meta.worked} after ${first}`);
  assert.equal(chat.messages.filter((m) => m.meta?.worked).length, 1, "kept once, on the turn's own message");
  // A new message is a new turn, with its own time.
  await engine(fakeClient([{ content: "quick" }]), host).ask(chat, "and this?");
  const second = chat.messages.findLast((m) => m.role === "user" && !m.meta?.resume);
  assert.ok((second.meta.worked || 0) < 500, "a quick turn's own time (none at all when it took under a millisecond)");

  // Waiting on an approval card isn't working.
  const asking = fakeHost({ approval: () => ({ decision: "allow" }) });
  asking.needsApproval = () => "outside";
  const waits = Engine.newChat();
  const waiting = new Engine({ client: fakeClient([{ calls: [call("w", "write_file", { path: "C:/outside/x.txt", content: "x" })] }, { content: "ok" }]), host: asking, retryDelays: [0, 0],
    now: () => new Date(2026, 10, 4, 14, 5), settings: () => ({ model: "m", compactAt: 100_000, maxRounds: 30 }),
    onEvent: (event) => { if (event.type === "approval") setTimeout(() => waiting.decide(event.id, { decision: "allow" }), 300); } });
  await waiting.ask(waits, "write it");
  assert.ok((waits.messages[0].meta.worked || 0) < 250, `the 300 ms you took to answer wasn't counted: ${waits.messages[0].meta.worked} ms`);

  // /compact on its own isn't a turn's work.
  const before = chat.messages[0].meta.worked;
  await engine(fakeClient([{ content: "SUMMARY" }]), host).compactNow(chat);
  assert.equal(chat.messages[0].meta.worked, before);
});
