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

/** An engine on the fake gateway; `rules` can change between messages. */
async function setup() {
  const gw = await fakeAssist({ script });
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
