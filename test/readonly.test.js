// @ts-check
"use strict";
/** Read-only mode in the engine: the tools that change files are neither offered nor run. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { Engine } = require("../src/engine.js");
const { TEXTS } = require("../src/prompt.js");

const call = (/** @type {string} */ id, /** @type {string} */ name, /** @type {any} */ args) => ({ id, name, arguments: JSON.stringify(args) });

/** @param {any[]} script @param {boolean} readOnly */
async function run(script, readOnly) {
  /** @type {any[]} */
  const offered = [];
  /** @type {any[]} */
  const sent = [];
  const client = {
    async reply(/** @type {any} */ request) {
      offered.push((request.tools || []).map((/** @type {any} */ t) => t.function.name));
      sent.push(JSON.parse(JSON.stringify(request.messages)));
      return { content: "", calls: [], finishReason: "stop", usage: { total_tokens: 10 }, credits: null, ...script.shift() };
    },
  };
  /** @type {string[]} */
  const ran = [];
  const host = {
    async systemPrompt() { return "SYSTEM"; },
    needsApproval() { return null; },
    async runTool(/** @type {string} */ name) { ran.push(name); return { output: `${name} ok`, summary: `${name} done` }; },
    async save() {},
  };
  /** @type {any[]} */
  const events = [];
  const engine = new Engine({ client, host, retryDelays: [0, 0], onEvent: (event) => events.push(event),
    settings: () => ({ model: "m", compactAt: 100_000, maxRounds: 30, readOnly }) });
  const chat = Engine.newChat();
  await engine.ask(chat, "fix it");
  return { offered, sent, ran, events, chat };
}

test("read-only mode: the change tools aren't offered, and a change the model asks for anyway isn't run", async () => {
  const { offered, ran, sent, events } = await run([
    { calls: [call("a", "read_file", { path: "x.js" }), call("b", "edit_file", { path: "x.js", old_text: "a", new_text: "b" }),
      call("c", "write_file", { path: "y.js", content: "z" })] },
    { content: "Here's the change to make." },
  ], true);
  assert.ok(!offered[0].includes("edit_file") && !offered[0].includes("write_file") && !offered[0].includes("remove_item") && !offered[0].includes("move_item"));
  assert.ok(offered[0].includes("read_file") && offered[0].includes("plan"));
  assert.deepEqual(ran, ["read_file"], "only the read ran");
  const results = sent[1].filter((/** @type {any} */ m) => m.role === "tool").map((/** @type {any} */ m) => m.content);
  assert.equal(results[1], TEXTS.readOnly);
  assert.equal(results[2], TEXTS.readOnly, "each change says why");
  assert.ok(!events.some((e) => e.type === "error"));
});

test("with changes on, every tool is offered and runs", async () => {
  const { offered, ran } = await run([
    { calls: [call("b", "edit_file", { path: "x.js", old_text: "a", new_text: "b" })] },
    { content: "Done." },
  ], false);
  assert.ok(offered[0].includes("edit_file") && offered[0].includes("remove_item"));
  assert.deepEqual(ran, ["edit_file"]);
});
