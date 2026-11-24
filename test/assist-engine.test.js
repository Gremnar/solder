// @ts-check
"use strict";
/** The engine on the Assist lane, against a fake gateway that keeps sessions (test/fake-assist.js). */
const test = require("node:test");
const assert = require("node:assert/strict");
const { Engine } = require("../src/engine.js");
const { GatewayClient } = require("../src/gateway.js");
const { ASSIST } = require("../src/prompt.js");
const { fakeAssist } = require("./fake-assist.js");

const READ_A = 'Let me look.\n\n```tool\n{"tool": "read_file", "path": "a.js"}\n```';

/** The fake model: reads a.js when asked about it, answers from results, and says what a carry-over held. */
function script(/** @type {{role: string, content: string}[]} */ seen, /** @type {any} */ payload) {
  if (payload.tools) return "Tool lane answer.";
  const last = seen[seen.length - 1].content;
  if (last.startsWith("Give a short title")) return "A title";
  if (last.includes("please write a summary")) return "SUMMARY OF IT";
  if (last.includes(ASSIST.carryOverLead)) return `Recalled: ${last.includes("What's in a.js?") ? "a.js" : "nothing"}${last.includes("Tool lane answer.") ? ", the Tool lane's answer" : ""}.`;
  if (last.includes("couldn't read that request")) return READ_A;
  if (last.includes("Here's what my extension returned for read_file a.js")) return "a.js holds the cart.";
  if (last.includes("What's in a.js?")) return seen.length === 1 && last.includes("BROKEN") ? "Trying.\n\n```tool\n{oops\n```" : READ_A;
  if (last.includes("And b.js?")) return `b.js is empty (I remember ${seen.length} messages).`;
  return "Noted.";
}

/** The requests a task made (titles, which go on their own afterwards, left out). @param {any} gw */
const sent = (gw) => gw.requests.filter((/** @type {any} */ r) => !String(r.payload.messages?.at(-1)?.content || "").startsWith("Give a short title"));

/**
 * An engine on the fake gateway; `rules` can change between messages.
 * @param {{script?: (seen: any[], payload: any) => string, cut?: (text: string, count: number) => boolean}} [options]
 */
async function setup(options = {}) {
  const gw = await fakeAssist({ script: options.script || script, cut: options.cut });
  const client = new GatewayClient({ endpoint: gw.endpoint, apiKey: "" });
  const state = { rules: "Be brief.", model: "model-a" };
  const ran = [];
  const host = {
    async systemPrompt() { return "SYSTEM"; },
    async assistContext() { return { workspace: "C:\\w", rules: state.rules }; },
    needsApproval: () => null,
    async runTool(/** @type {string} */ name, /** @type {any} */ args) { ran.push([name, args]); return { output: "1\tconst cart = [];", summary: "Read " + args.path }; },
    async save() {},
  };
  const events = [];
  const engine = new Engine({ client, host, retryDelays: [0, 0], now: () => new Date(2026, 10, 9, 10, 0),
    settings: () => ({ model: state.model, compactAt: 100_000, maxRounds: 10, toolModels: "-tools$", assistSessionBlock: "test_session" }),
    onEvent: (/** @type {any} */ e) => events.push(e) });
  return { gw, engine, state, ran, events };
}

test("assist: a fresh start with the introduction once, then only each new message, in the gateway's session", async () => {
  const { gw, engine, ran } = await setup();
  try {
    const chat = Engine.newChat();
    await engine.ask(chat, "What's in a.js?");
    assert.equal(sent(gw).length, 2);
    const [first, second] = sent(gw);
    assert.ok(!first.payload.test_session, "no session on the first");
    assert.equal(first.payload.messages.length, 1);
    assert.ok(first.payload.messages[0].content.startsWith(ASSIST.lead));
    assert.ok(first.payload.messages[0].content.endsWith("What's in a.js?"));
    assert.ok(second.payload.test_session, "the second continues the session");
    assert.equal(second.payload.messages.length, 1);
    assert.ok(second.payload.messages[0].content.startsWith(ASSIST.resultOk("read_file a.js")));
    for (const r of gw.requests) { assert.deepEqual(r.extrasSent, []); assert.ok(!r.systemSent); }
    assert.deepEqual(ran.map(([name]) => name), ["read_file"]);
    assert.equal(chat.messages.at(-1).content, "a.js holds the cart.");
    assert.ok(chat.messages[0].meta.sent.startsWith(ASSIST.lead), "what went out is kept beside what's shown");
    assert.equal(chat.messages[1].content, "Let me look.", "only the words before the request are shown");
    assert.equal(chat.assist.held, chat.messages.length);
    await engine.ask(chat, "And b.js?");
    const third = sent(gw)[2];
    assert.equal(third.payload.messages.length, 1);
    assert.ok(!third.payload.messages[0].content.includes(ASSIST.lead), "no introduction again");
    assert.match(chat.messages.at(-1).content, /I remember 5 messages/, "the gateway had the whole conversation");
    assert.equal(chat.usage.tokens, 0, "Assist replies aren't counted against the allowance");
    assert.ok(chat.usage.assistTokens > 0);
    // The count is what the model took in: the conversation its session holds, not only the new message (the fake
    // gateway, like a real one that keeps sessions, reports 7 prompt tokens whatever was held).
    assert.ok(chat.usage.assistContext > 300, `the session holds the introduction, a read and its answer: ${chat.usage.assistContext}`);
    assert.ok(chat.usage.assistTokens > chat.usage.assistContext, "every request's held conversation counted, not the last one's alone");
    assert.ok(chat.usage.assistTokens > 4 * 12, `far more than the gateway's 12 a request: ${chat.usage.assistTokens}`);
  } finally { gw.close(); }
});

test("assist: a session that ended (502) is carried over once, and the conversation is remembered", async () => {
  const { gw, engine } = await setup();
  try {
    const chat = Engine.newChat();
    await engine.ask(chat, "What's in a.js?");
    chat.assist.fields = { ...chat.assist.fields, token: "t-garbled" };
    await engine.ask(chat, "And b.js?");
    const failed = gw.requests.filter((r) => r.status === 502);
    assert.ok(failed.length >= 1 && failed.length <= 2);
    const carried = sent(gw).at(-1);
    assert.ok(!carried.payload.test_session, "the carry-over starts a new session");
    assert.ok(carried.payload.messages[0].content.includes(ASSIST.carryOverLead));
    assert.match(chat.messages.at(-1).content, /^Recalled: a\.js/);
    assert.ok(chat.assist.fields && !chat.assist.lost, "and the new session holds the chat now");
  } finally { gw.close(); }
});

test("assist: a fork never sends its original's session; it carries the conversation over", async () => {
  const { gw, engine } = await setup();
  try {
    const chat = Engine.newChat();
    await engine.ask(chat, "What's in a.js?");
    const fork = Engine.fork(chat);
    assert.equal(fork.assist.lost, true);
    await engine.ask(fork, "And b.js?");
    const lastSent = sent(gw).at(-1);
    assert.ok(!lastSent.payload.test_session);
    assert.ok(lastSent.payload.messages[0].content.includes(ASSIST.carryOverLead));
  } finally { gw.close(); }
});

test("switching lanes: Tool → Assist carries over; Assist → Tool sends what the Tool lane needs; and back again carries over", async () => {
  const { gw, engine, state } = await setup();
  try {
    const chat = Engine.newChat();
    chat.model = "model-a-tools";
    await engine.ask(chat, "Hello there");
    assert.ok(sent(gw)[0].systemSent && sent(gw)[0].toolsSent, "the Tool lane, as today");
    chat.model = "model-a";
    await engine.ask(chat, "What's in a.js?");
    const toAssist = sent(gw)[1];
    assert.ok(!toAssist.payload.test_session && toAssist.payload.messages[0].content.includes(ASSIST.carryOverLead));
    assert.match(chat.messages.at(-1).content, /Recalled: a\.js, the Tool lane's answer/);
    // To the Tool lane: user text as typed (no introduction), assistant calls without signatures.
    chat.model = "model-a-tools";
    await engine.ask(chat, "Thanks");
    const toTool = sent(gw).at(-1).payload;
    assert.ok(toTool.tools && toTool.messages[0].role === "system");
    assert.ok(!toTool.messages.some((/** @type {any} */ m) => m.role === "user" && String(m.content).includes(ASSIST.lead)));
    // Back to Assist: the Tool lane answered in between, so the session no longer holds the chat.
    chat.model = "model-a";
    await engine.ask(chat, "And b.js?");
    assert.ok(sent(gw).at(-1).payload.messages[0].content.includes(ASSIST.carryOverLead));
    void state;
  } finally { gw.close(); }
});

test("switching to another Assist model carries over (a session belongs to its model)", async () => {
  const { gw, engine } = await setup();
  try {
    const chat = Engine.newChat();
    await engine.ask(chat, "What's in a.js?");
    chat.model = "model-b";
    await engine.ask(chat, "And b.js?");
    const lastSent = sent(gw).at(-1);
    assert.ok(!lastSent.payload.test_session && lastSent.payload.messages[0].content.includes(ASSIST.carryOverLead));
  } finally { gw.close(); }
});

test("an unreadable request is asked for again, then runs; a changed setup is said in front of the next message", async () => {
  const { gw, engine, state, ran } = await setup();
  try {
    const chat = Engine.newChat();
    await engine.ask(chat, "What's in a.js? BROKEN");
    assert.ok(chat.messages.some((m) => m.meta?.repair), "asked again");
    assert.ok(sent(gw)[1].payload.messages[0].content.includes("couldn't read that request"));
    assert.deepEqual(ran.map(([name]) => name), ["read_file"]);
    state.rules = "Be thorough.";
    await engine.ask(chat, "And b.js?");
    const text = sent(gw).at(-1).payload.messages[0].content;
    assert.ok(text.startsWith("(My setup has changed") && text.includes("Be thorough.") && text.includes("And b.js?"));
  } finally { gw.close(); }
});

test("/compact on the Assist lane: a plain request, whole, with no session; the next message carries the recap over", async () => {
  const { gw, engine } = await setup();
  try {
    const chat = Engine.newChat();
    await engine.ask(chat, "What's in a.js?");
    const result = await engine.compactNow(chat);
    assert.equal(result, "done");
    const summary = sent(gw).at(-1);
    assert.equal(summary.payload.stream, false);
    assert.ok(!summary.payload.test_session && !summary.systemSent);
    assert.equal(chat.assist.why, "compacted");
    await engine.ask(chat, "And b.js?");
    const next = sent(gw).at(-1).payload.messages[0].content;
    assert.ok(next.includes(ASSIST.carryOverLead) && next.includes("SUMMARY OF IT"), "the recap (the summary) is carried over");
  } finally { gw.close(); }
});

test("the Assist lane isn't trimmed, has its own step limit, and carries over by its own budget", async () => {
  const { trim } = require("../src/engine.js");
  const { carryBudget } = require("../src/assist.js");
  const gw = await fakeAssist({ script });
  try {
    const client = new GatewayClient({ endpoint: gw.endpoint, apiKey: "" });
    const state = { model: "model-a" };
    const host = {
      async systemPrompt() { return "SYSTEM"; },
      async assistContext() { return { workspace: "C:\\w" }; },
      needsApproval: () => null,
      async runTool() { return { output: "x".repeat(60_000), summary: "Read a.js" }; }, // a big file, every time
      async save() {},
    };
    const engine = new Engine({ client, host, retryDelays: [0, 0], now: () => new Date(2026, 10, 9, 10, 0),
      settings: () => ({ model: state.model, compactAt: 100_000, maxRounds: 10, assistMaxRounds: 60, toolModels: "-tools$", assistSessionBlock: "test_session" }), onEvent() {} });
    const chat = Engine.newChat();
    for (let turn = 0; turn < 5; turn++) await engine.ask(chat, "What's in a.js?");
    const results = chat.messages.filter((m) => m.role === "tool");
    assert.equal(results.length, 5);
    assert.equal(results.some((m) => m.meta?.stub), false, "five big reads over five messages: all still whole on the Assist lane");
    assert.equal(chat.compaction, null, "and nothing was summarised by itself");
    // The same chat on a Tool model would have its older results cut: that's what trimming does there.
    assert.equal(trim(JSON.parse(JSON.stringify(chat)), 100_000), true);

    // Steps a message: the Assist lane's own limit; a Tool model keeps Max rounds.
    assert.equal(engine._roundLimit(chat), 60);
    state.model = "model-a-tools";
    assert.equal(engine._roundLimit(chat), 10);
    const plain = new Engine({ client, host, settings: () => ({ model: "model-a", compactAt: 100_000, maxRounds: 10, toolModels: "-tools$" }), onEvent() {} });
    assert.equal(plain._roundLimit(Engine.newChat()), 10, "with no Assist limit given, Max rounds");

    // A carry-over holds what the setting says (tokens, at four characters each), not a share of Compact at.
    assert.equal(carryBudget({ assistCarryTokens: 500_000 }), 2_000_000);
    assert.equal(carryBudget({ compactAt: 30_000 }), 800_000, "200,000 tokens when it isn't set, whatever Compact at is");
    assert.equal(carryBudget({ assistCarryTokens: NaN }), 800_000);
  } finally { await gw.close(); }
});

/** The fake model for the cut-off tests: reads a.js, then b.js once asked to carry on, then answers. */
function carrying(/** @type {{role: string, content: string}[]} */ seen) {
  const last = seen[seen.length - 1].content;
  if (last.startsWith("Give a short title")) return "A title";
  if (last.includes("Please carry on from where you stopped.")) return 'Carrying on.\n\n```tool\n{"tool": "read_file", "path": "b.js"}\n```';
  if (last.includes("returned for read_file b.js")) return "Both files hold the cart, and that's the whole answer.";
  if (last.includes("returned for read_file a.js")) return "a.js holds the cart, and there is more to say about it here.";
  return READ_A;
}

test("assist: a reply cut off partway is carried on from by itself, as Resume would; what had arrived is kept", async () => {
  // The answer to a.js's result (the second request) stops partway: its stream ends with no finish.
  const { gw, engine, events } = await setup({ script: carrying, cut: (_text, count) => count === 2 });
  try {
    const chat = Engine.newChat();
    await engine.ask(chat, "What's in a.js?");
    assert.equal(events.some((e) => e.type === "error"), false, "no error to answer: nothing to click");
    assert.equal(events.filter((e) => e.type === "retrying" && e.carriedOn).length, 1);
    const kinds = chat.messages.map((m) => m.role + (m.meta?.incomplete ? ":cut" : m.meta?.auto ? ":auto" : ""));
    assert.deepEqual(kinds, ["user", "assistant", "tool", "assistant:cut", "user:auto", "assistant", "tool", "assistant"]);
    const cut = chat.messages[3];
    assert.ok(cut.content.length > 0 && "a.js holds the cart, and there is more to say about it here.".startsWith(cut.content), "the part that arrived is shown");
    const carry = chat.messages[4];
    assert.deepEqual([carry.meta.typed, carry.meta.resume], ["Carry on", true]);
    assert.match(carry.content, /Please carry on from where you stopped\.$/);
    const third = sent(gw)[2];
    assert.ok(third.payload.test_session, "sent in the same session");
    assert.match(third.payload.messages[0].content, /Please carry on from where you stopped\.$/);
    assert.equal(third.payload.messages.length, 1, "only the carry-on goes: the part that arrived isn't sent back");
    assert.equal(chat.messages.at(-1).content, "Both files hold the cart, and that's the whole answer.");
  } finally { gw.close(); }
});

test("assist: carried on from once for each cut; a second cut straight after is the error it always was, with Resume", async () => {
  // Cut, carried on, a reply that finishes, then cut again later in the task: carried on from again.
  let { gw, engine, events } = await setup({ script: carrying, cut: (_text, count) => count === 2 || count === 4 });
  try {
    const chat = Engine.newChat();
    await engine.ask(chat, "What's in a.js?");
    assert.equal(events.some((e) => e.type === "error"), false);
    assert.equal(chat.messages.filter((m) => m.meta?.auto).length, 2, "each cut after a finished reply gets its one carry-on");
    assert.ok(chat.messages.at(-1).role === "assistant" && !chat.messages.at(-1).meta?.incomplete);
  } finally { gw.close(); }

  // Cut, carried on, and cut again at once: no third try by itself.
  ({ gw, engine, events } = await setup({ script: carrying, cut: (_text, count) => count === 2 || count === 3 }));
  try {
    const chat = Engine.newChat();
    await engine.ask(chat, "What's in a.js?");
    const error = events.find((e) => e.type === "error");
    assert.ok(error && error.resumable, "the second cut in a row is shown, with Resume");
    assert.match(error.message, /stream ended before it finished/);
    assert.equal(chat.messages.filter((m) => m.meta?.auto).length, 1);
    assert.equal(sent(gw).length, 3, "nothing more was sent");
    // Resume by hand still works from there.
    await engine.resume(chat);
    assert.ok(chat.messages.at(-1).role === "assistant" && !chat.messages.at(-1).meta?.incomplete);
  } finally { gw.close(); }
});

test("assist: a Stop, or a failure before any of the reply arrived, isn't carried on from", async () => {
  const { gw, engine, events } = await setup({ script: carrying });
  try {
    const chat = Engine.newChat();
    // A dead session and a carry-over that fails too would be the gateway's trouble, not a cut reply: here, simply
    // stopped partway by you.
    const real = engine.client.reply.bind(engine.client);
    engine.client.reply = (/** @type {any} */ request) => real({ ...request, onText: (/** @type {string} */ text) => { request.onText(text); engine.stop(); } });
    await engine.ask(chat, "What's in a.js?");
    assert.equal(events.some((e) => e.type === "stopped"), true);
    assert.equal(chat.messages.filter((m) => m.meta?.auto).length, 0, "a reply you stopped stays stopped");
    assert.equal(sent(gw).length, 1);
  } finally { gw.close(); }
});

test("assist: every request in a reply runs (a refactor's fifteen or twenty edits), up to a guard no task meets", async () => {
  const edits = (/** @type {number} */ n) => "Renaming it everywhere.\n\n" + Array.from({ length: n }, (_, i) =>
    "```tool\n" + JSON.stringify({ tool: "edit_file", path: `src/f${i}.js`, old_text: "oldName", new_text: "newName" }) + "\n```").join("\n\n");
  for (const [asked, runs] of [[20, 20], [55, 50]]) {
    const { gw, engine, ran } = await setup({ script: (seen) => {
      const last = seen[seen.length - 1].content;
      return last.startsWith("Give a short title") ? "A title" : seen.length === 1 ? edits(asked) : "All renamed.";
    } });
    try {
      const chat = Engine.newChat();
      await engine.ask(chat, "Rename oldName to newName everywhere.");
      assert.equal(ran.length, runs, `${asked} edits sent, ${runs} run`);
      assert.deepEqual(ran.map(([, args]) => args.path), Array.from({ length: runs }, (_, i) => `src/f${i}.js`), "in order");
      const refused = chat.messages.filter((m) => m.role === "tool" && /^Not run: Solder runs up to 50 calls from one reply/.test(m.content));
      assert.equal(refused.length, asked - runs);
      assert.equal(chat.messages.at(-1).content, "All renamed.");
    } finally { gw.close(); }
  }
});

test("assist: a request in the middle that can't be used stops the ones after it, and the model is told so with the results", async () => {
  const block = (/** @type {object} */ o) => "```tool\n" + JSON.stringify(o) + "\n```";
  const edit = (/** @type {string} */ file) => block({ tool: "edit_file", path: file, old_text: "oldName", new_text: "newName" });
  const first = ["Renaming it in all three.", edit("one.js"), block({ tool: "edit_file", path: "two.js", old_text: "oldName" }), edit("three.js"), "That covers all three files."].join("\n\n");
  const { gw, engine, ran } = await setup({ script: (seen) => {
    const last = seen[seen.length - 1].content;
    if (last.startsWith("Give a short title")) return "A title";
    if (seen.length === 1) return first;
    // Told what didn't run, it sends those two again; told nothing, it would say it was done.
    if (last.includes("It couldn't use your next one")) return ["Sending those again.", edit("two.js"), edit("three.js")].join("\n\n");
    return "All three are renamed.";
  } });
  try {
    const chat = Engine.newChat();
    await engine.ask(chat, "Rename oldName to newName in one.js, two.js and three.js.");
    assert.deepEqual(ran.map(([, args]) => args.path), ["one.js", "two.js", "three.js"], "each ran once, in the end");
    const second = sent(gw)[1].payload.messages[0].content;
    assert.match(second, /returned for edit_file one\.js/);
    assert.match(second, /Those are the only requests my extension ran\. It couldn't use your next one \(edit_file needs 'new_text'\), so it didn't run it, or the one after it\. Please send them again\.$/);
    assert.ok(!second.includes(ASSIST.resultClosing), "the usual closing line would say 'go ahead and answer'");
    const result = chat.messages.find((m) => m.role === "tool");
    assert.match(result.meta.summary, /a later request couldn't be used, and wasn't run/, "the step says so in the panel too");
    assert.ok(!result.content.includes("It couldn't use"), "kept beside the result, not written into it");
    assert.equal(chat.messages.at(-1).content, "All three are renamed.");
  } finally { gw.close(); }
});

test("assist: while a reply's requests are being written, the panel is told which one and how far (they aren't shown as text)", async () => {
  const { gw, engine, events } = await setup();
  try {
    await engine.ask(Engine.newChat(), "What's in a.js?");
    const drafting = events.filter((e) => e.type === "drafting");
    assert.ok(drafting.length >= 1, "said at least once for the reply that asks for a.js");
    assert.ok(drafting.every((e) => Array.isArray(e.calls) && e.calls.length === 1 && typeof e.calls[0].chars === "number"));
    const shown = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
    assert.ok(!shown.includes("```") && !shown.includes("read_file"), "and the request itself still isn't shown");
  } finally { gw.close(); }
});

test("assist: a switch is checked for what it would leave out; a Tool model, or one that fits, leaves out nothing", async () => {
  const { gw, engine } = await setup();
  try {
  const chat = Engine.newChat();
  for (let turn = 0; turn < 40; turn++) chat.messages.push({ role: "user", content: "q".repeat(300) }, { role: "assistant", content: "a".repeat(8000) });
  assert.equal(await engine.leftOutBySwitch(chat, "model-a-tools"), null, "a Tool model is sent the whole chat, trimmed and summarised as ever");
  const left = await engine.leftOutBySwitch(chat, "model-b");
  assert.equal(left, null, "about 83,000 tokens: within the default 200,000");
  engine.settings = () => ({ model: "model-a", compactAt: 100_000, maxRounds: 10, toolModels: "-tools$", assistSessionBlock: "test_session", assistCarryTokens: 20_000 });
  const cut = await engine.leftOutBySwitch(chat, "model-b");
  assert.ok(cut && cut.left > 50 && cut.first, JSON.stringify(cut));
  assert.equal(await engine.leftOutBySwitch(Engine.newChat(), "model-b"), null);
  } finally { gw.close(); }
});
