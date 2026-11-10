// @ts-check
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { laneOf, assistTwin } = require("../src/lanes.js");
const { GatewayClient, GatewayError } = require("../src/gateway.js");
const { fakeAssist } = require("./fake-assist.js");

test("lanes: with no pattern every model is a Tool model; a pattern splits them; a broken one changes nothing", () => {
  assert.equal(laneOf("model-a", {}), "tool");
  assert.equal(laneOf("model-a", { toolModels: "" }), "tool");
  const settings = { toolModels: "-tools$" };
  assert.equal(laneOf("model-a-tools", settings), "tool");
  assert.equal(laneOf("model-a", settings), "assist");
  assert.equal(laneOf("model-a", { toolModels: "(" }), "tool");
});

test("an Assist twin is offered only when it's really there, and only for a Tool model", () => {
  const settings = { toolModels: "-tools$" };
  assert.equal(assistTwin("model-a-tools", settings, ["model-a", "model-a-tools"]), "model-a");
  assert.equal(assistTwin("model-a-tools", settings, ["model-a-tools"]), "", "not on offer");
  assert.equal(assistTwin("model-a", settings, ["model-a", "model-a-tools"]), "", "already Assist");
  assert.equal(assistTwin("model-a-tools", {}, ["model-a"]), "", "no pattern, no lanes");
});

test("an Assist request: plain text only, no tools, effort or limit; the session at the top level and in its block, in order", async () => {
  const gw = await fakeAssist({ script: (seen) => `I see ${seen.length} message(s): ${seen.map((m) => m.content).join(" | ")}` });
  try {
    const client = new GatewayClient({ endpoint: gw.endpoint, apiKey: "" });
    const first = await client.reply({ model: "model-a", messages: [{ role: "user", content: "hello" }], assist: true,
      tools: [{ type: "function", function: { name: "x" } }], effort: "high", sessionBlock: "test_session" });
    assert.equal(first.content, "I see 1 message(s): hello");
    assert.ok(first.session, "the session came back in the final chunk");
    assert.deepEqual(Object.keys(first.session.fields), ["session", "token"], "short string fields only (not the thoughts)");
    assert.deepEqual(gw.requests[0].extrasSent, [], "no tools, tool_choice, reasoning_effort or max_tokens");
    // The next request continues the session: only the new message goes, and the gateway has the rest.
    const second = await client.reply({ model: "model-a", messages: [{ role: "user", content: "again" }], assist: true,
      session: first.session, sessionBlock: "test_session" });
    assert.equal(second.content, "I see 3 message(s): hello | I see 1 message(s): hello | again");
    assert.deepEqual(Object.keys(gw.requests[1].payload), ["model", "session", "token", "test_session", "messages", "stream"]);
    assert.notEqual(second.session.fields.token, first.session.fields.token, "the token rolls");
    assert.equal(second.session.fields.session, first.session.fields.session);
    // An older token of the same session is still good.
    const third = await client.reply({ model: "model-a", messages: [{ role: "user", content: "once more" }], assist: true,
      session: first.session, sessionBlock: "test_session" });
    assert.match(third.content, /^I see 5 message/);
  } finally { gw.close(); }
});

test("an Assist request refuses anything but user and assistant text, ending with the user's", async () => {
  const client = new GatewayClient({ endpoint: "http://127.0.0.1:9/v1/chat/completions", apiKey: "" });
  await assert.rejects(client.reply({ model: "m", messages: [{ role: "system", content: "x" }, { role: "user", content: "y" }], assist: true }), GatewayError);
  await assert.rejects(client.reply({ model: "m", messages: [{ role: "user", content: "y" }, { role: "assistant", content: "z" }], assist: true }), /must be user text/);
  await assert.rejects(client.reply({ model: "m", messages: [{ role: "tool", content: "r" }], assist: true }), GatewayError);
});

test("a dead session answers 502, after one more try at most", async () => {
  const gw = await fakeAssist({ script: () => "ok" });
  try {
    const client = new GatewayClient({ endpoint: gw.endpoint, apiKey: "" });
    const dead = { block: "test_session", fields: { session: "s-gone", token: "t-gone" } };
    await assert.rejects(client.reply({ model: "m", messages: [{ role: "user", content: "hi" }], assist: true, session: dead, sessionBlock: "test_session" }),
      (error) => /** @type {any} */ (error).status === 502);
    assert.ok(gw.requests.length <= 2, `${gw.requests.length} requests`);
  } finally { gw.close(); }
});

test("an Assist side request answers whole (no stream), with its session", async () => {
  const gw = await fakeAssist({ script: () => "A short title" });
  try {
    const client = new GatewayClient({ endpoint: gw.endpoint, apiKey: "" });
    const reply = await client.reply({ model: "m", messages: [{ role: "user", content: "name this" }], assist: true, stream: false, sessionBlock: "test_session" });
    assert.equal(reply.content, "A short title");
    assert.equal(gw.requests[0].payload.stream, false);
    assert.ok(reply.session && reply.session.fields.token);
  } finally { gw.close(); }
});

test("the Tool lane is as it was: tools, effort and the output limit go, and no session is looked for", async () => {
  const gw = await fakeAssist({ script: () => "fine" });
  try {
    const client = new GatewayClient({ endpoint: gw.endpoint, apiKey: "" });
    const reply = await client.reply({ model: "m-tools", messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "x", parameters: { type: "object", properties: {} } } }], effort: "low" });
    assert.equal(reply.content, "fine");
    assert.equal(reply.session, null);
    assert.deepEqual(gw.requests[0].extrasSent, ["tools", "tool_choice", "reasoning_effort", "max_tokens"]);
    assert.ok(gw.requests[0].systemSent);
  } finally { gw.close(); }
});
