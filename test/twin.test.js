// @ts-check
"use strict";
/** Summaries and titles by a Tool model's Assist twin: free of the allowance, and the chat's own model if it fails. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { Engine } = require("../src/engine.js");
const { TEXTS } = require("../src/prompt.js");

/** A gateway that answers each request with `answer(request)`, and records them all. @param {(request: any) => any} answer */
function gateway(answer) {
  /** @type {any[]} */
  const sent = [];
  return { sent, async reply(/** @type {any} */ request) {
    sent.push(request);
    const value = answer(request);
    if (value instanceof Error) throw value;
    return { content: "", calls: [], finishReason: "stop", usage: { total_tokens: 10 }, credits: null, ...value };
  } };
}

const host = { async systemPrompt() { return "SYSTEM"; }, needsApproval() { return null; },
  async runTool() { return { output: "ok", summary: "done" }; }, async save() {} };

/** @param {any} client @param {any} [more] */
function engine(client, more = {}) {
  return new Engine({ client, host, retryDelays: [0], onEvent: () => {},
    settings: () => ({ model: "model-a-tools", compactAt: 30_000, maxRounds: 30, toolModels: "-tools$",
      assistTwinOf: (/** @type {string} */ id) => id === "model-a-tools" ? "model-a" : "", ...more }) });
}

/** A chat big enough to summarise: earlier turns of 4 × 40k characters, then a new message. */
function bigChat() {
  const chat = Engine.newChat();
  for (let i = 0; i < 4; i++) chat.messages.push({ role: "user", content: "q".repeat(40_000), meta: { typed: "q" } }, { role: "assistant", content: "a" + i });
  return chat;
}

const isSummary = (/** @type {any} */ r) => String(r.messages.at(-1)?.content || "").startsWith(TEXTS.compactionTranscript);
const isTitle = (/** @type {any} */ r) => JSON.stringify(r.messages).includes(TEXTS.titleRequest("X").slice(0, 30));

test("a Tool model's chat is summarised by its Assist twin, free of the allowance", async () => {
  const client = gateway((r) => isSummary(r) ? { content: "SUMMARY", usage: { total_tokens: 500 } } : isTitle(r) ? { content: "T" } : { content: "Answer." });
  const chat = bigChat();
  await engine(client).ask(chat, "next");
  const summary = client.sent.find(isSummary);
  assert.ok(summary, "it was summarised");
  assert.equal(summary.model, "model-a");
  assert.equal(summary.assist, true);
  assert.equal(summary.messages.length, 1, "an Assist request: no system message");
  assert.equal(chat.compaction?.summary, "SUMMARY");
  assert.equal(chat.usage.assistTokens || 0, 500, "counted as free");
  const answer = client.sent.find((r) => !isSummary(r) && !isTitle(r));
  assert.equal(answer.model, "model-a-tools", "the chat itself stays on its Tool model");
});

test("if the twin fails, the chat's own model writes the summary", async () => {
  const client = gateway((r) => isSummary(r) && r.model === "model-a" ? new Error("twin down")
    : isSummary(r) ? { content: "OWN SUMMARY" } : isTitle(r) ? { content: "T" } : { content: "Answer." });
  const chat = bigChat();
  await engine(client).ask(chat, "next");
  assert.deepEqual(client.sent.filter(isSummary).map((r) => r.model), ["model-a", "model-a-tools"]);
  assert.equal(chat.compaction?.summary, "OWN SUMMARY");
});

test("a twin your organization's model filter doesn't allow isn't used", async () => {
  const client = gateway((r) => isSummary(r) ? { content: "S" } : isTitle(r) ? { content: "T" } : { content: "Answer." });
  await engine(client, { modelAllowed: (/** @type {string} */ id) => id.endsWith("-tools") }).ask(bigChat(), "next");
  assert.deepEqual(client.sent.filter(isSummary).map((r) => r.model), ["model-a-tools"]);
});

test("the chat is named by the twin, and by its own model if the twin's name is no good", async () => {
  const titled = gateway((r) => isTitle(r) ? { content: "Fixing the cart" } : { content: "Answer." });
  const chat = Engine.newChat();
  await engine(titled).ask(chat, "fix the cart");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(titled.sent.filter(isTitle).map((r) => [r.model, !!r.assist]), [["model-a", true]]);
  assert.equal(chat.title, "Fixing the cart");
  const blank = gateway((r) => isTitle(r) ? { content: r.model === "model-a" ? "" : "Own name" } : { content: "Answer." });
  const other = Engine.newChat();
  await engine(blank).ask(other, "fix the cart");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(blank.sent.filter(isTitle).map((r) => r.model), ["model-a", "model-a-tools"]);
  assert.equal(other.title, "Own name");
});
