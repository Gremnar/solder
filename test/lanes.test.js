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

test("the model chosen for you: not a small one, then the highest version, then the bigger variant, then the gateway's order", () => {
  const { bestModel, versionOf } = require("../src/lanes.js");
  assert.deepEqual(versionOf("model-3.5-flash-lite"), [3, 5]);
  assert.deepEqual(versionOf("x-3.10"), [3, 10]);
  assert.deepEqual(versionOf("x-2024-05-13"), [], "a date isn't a version");
  assert.deepEqual(versionOf("x-0613"), []);
  assert.equal(bestModel(["model-3.5-lite", "model-3-pro", "model-3.5", "model-2.5-pro"]), "model-3.5");
  assert.equal(bestModel(["model-4-mini", "model-3.5-pro"]), "model-3.5-pro", "a small model comes last, whatever its version");
  assert.equal(bestModel(["m-3.5", "m-3.5-pro"]), "m-3.5-pro");
  assert.equal(bestModel(["x-3.9", "x-3.10"]), "x-3.10");
  assert.equal(bestModel(["x-2024-05-13", "x-4"]), "x-4");
  assert.equal(bestModel(["a", "b"]), "a", "no clue in the names: the gateway's order");
  assert.equal(bestModel(["m-lite", "m-nano"]), "m-lite", "only small ones: still one of them");
  assert.equal(bestModel([]), "");
});

test("the tool-calling test: a model that calls the tool, and uses its result; one served without tool calling answers in prose", async () => {
  const { probeTools } = require("../src/lanes.js");
  const { PROBE } = require("../src/prompt.js");
  const sent = [];
  const toolModel = { reply: async (/** @type {any} */ request) => {
    sent.push(request);
    if (sent.length === 1) return { content: "", calls: [{ id: "c1", name: "read_file", arguments: '{"path":"version.txt"}' }], ms: 5 };
    return { content: `It says ${request.messages.at(-1).content.includes(PROBE.canary) ? PROBE.canary : "nothing"}.`, calls: [], ms: 5 };
  } };
  const yes = await probeTools(toolModel, "model-a");
  assert.deepEqual([yes.calls, yes.used], [true, true]);
  assert.deepEqual(sent[0].tools, [PROBE.tool]);
  assert.equal(sent[0].messages[0].content, PROBE.system);
  assert.equal(sent[1].messages.at(-1).role, "tool");
  assert.equal(sent[1].messages.at(-1).content, PROBE.result);
  const prose = { reply: async () => ({ content: "I can't open files, but version.txt usually holds a version number.", calls: [], ms: 5 }) };
  const no = await probeTools(prose, "model-b");
  assert.deepEqual([no.calls, no.used, no.second], [false, false, null]);
  await assert.rejects(probeTools({ reply: async () => { throw new Error("gateway down"); } }, "model-c"), /gateway down/, "a failure is the caller's to handle");
});

test("marking a model as an Assist model keeps the ones a pattern made Assist models (a list, once there is one, decides alone)", () => {
  const { withAssist, laneOf } = require("../src/lanes.js");
  const offered = ["a-tools", "a", "b-tools", "b", "c-tools"];
  // By the pattern, a and b are Assist models; c-tools answered without calling a tool.
  const list = withAssist(offered, { toolModels: "-tools$" }, "c-tools");
  assert.deepEqual(list.sort(), ["a", "b", "c-tools"]);
  assert.equal(laneOf("c-tools", { toolModels: "-tools$", assistModels: list }), "assist");
  assert.equal(laneOf("a", { toolModels: "-tools$", assistModels: list }), "assist", "a stays an Assist model");
  assert.equal(laneOf("a-tools", { toolModels: "-tools$", assistModels: list }), "tool");
  // With a list already, it's added to, once.
  assert.deepEqual(withAssist(offered, { assistModels: ["b"] }, "b"), ["b"]);
  assert.deepEqual(withAssist(offered, {}, "a").sort(), ["a"], "no list and no pattern: every model was a Tool model");
});
