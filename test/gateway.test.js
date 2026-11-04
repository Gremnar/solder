// @ts-check
"use strict";
// node --test   (or, with no Node installed: $env:ELECTRON_RUN_AS_NODE=1; & code.exe --test test)
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { GatewayClient, GatewayError } = require("../src/gateway.js");

/** A fake gateway: each request is answered by the next handler in `script`. */
function fakeGateway(script) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      const handler = script.shift();
      if (!handler) { res.writeHead(500); res.end(); return; }
      handler(res);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const { port } = /** @type {any} */ (server.address());
    resolve({ server, seen, endpoint: `http://127.0.0.1:${port}/v1/chat/completions` });
  }));
}

const CREDITS = { "x-ratelimit-limit-tokens": "5000000", "x-ratelimit-remaining-tokens": "4200000",
  "x-ratelimit-reset-tokens": "3600", "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "99" };

function sse(res, events, { done = true, headers = CREDITS } = {}) {
  res.writeHead(200, { "Content-Type": "text/event-stream", ...headers });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\r\n\r\n`);
  if (done) res.write("data: [DONE]\n\n");
  res.end();
}

const ask = [{ role: "system", content: "rules" }, { role: "user", content: "hi" }];

test("text streams, usage and credits come back, the payload is shaped like Alloy's", async () => {
  const gw = await fakeGateway([(res) => sse(res, [
    { choices: [{ index: 0, delta: { content: "Hel" } }] },
    { choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  ])]);
  const client = new GatewayClient({ endpoint: gw.endpoint, apiKey: "k1" });
  const pieces = [];
  const reply = await client.reply({ model: "model-a", messages: ask, tools: [{ type: "function" }],
    effort: "high", onText: (t) => pieces.push(t) });
  gw.server.closeAllConnections();
  gw.server.close();
  assert.equal(reply.content, "Hello");
  assert.deepEqual(pieces, ["Hel", "lo"]);
  assert.equal(reply.usage.total_tokens, 12);
  assert.deepEqual(reply.credits, { bucket: "tokens", limit: 5000000, remaining: 4200000, resetSeconds: 3600 });
  const sent = gw.seen[0].body;
  assert.deepEqual(Object.keys(sent), ["model", "messages", "stream", "tools", "tool_choice", "reasoning_effort", "max_tokens"]);
  assert.equal(sent.max_tokens, 32768);
  assert.equal(gw.seen[0].auth, "Bearer k1");
});

test("a whole tool call in one chunk keeps its id and thought signature", async () => {
  const extra = { google: { thought_signature: "sig==" } };
  const gw = await fakeGateway([(res) => sse(res, [
    { choices: [{ index: 0, delta: { content: "Reading it." } }] },
    { choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: "c1", type: "function", extra_content: extra, function: { name: "read_file", arguments: "{\"path\":\"a.js\"}" } },
      { index: 1, id: "c2", type: "function", function: { name: "problems", arguments: "{}" } }] },
      finish_reason: "tool_calls" }] },
  ])]);
  const reply = await new GatewayClient({ endpoint: gw.endpoint, apiKey: "" }).reply({ model: "m", messages: ask });
  gw.server.closeAllConnections();
  gw.server.close();
  assert.equal(reply.finishReason, "stop");
  assert.deepEqual(reply.calls, [
    { id: "c1", name: "read_file", arguments: "{\"path\":\"a.js\"}", extra },
    { id: "c2", name: "problems", arguments: "{}", extra: undefined }]);
});

test("a call split over chunks is put back together", async () => {
  const gw = await fakeGateway([(res) => sse(res, [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "x", function: { name: "edit", arguments: "{\"pa" } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "th\":\"b\"}" } }] }, finish_reason: "tool_calls" }] },
  ])]);
  const reply = await new GatewayClient({ endpoint: gw.endpoint, apiKey: "" }).reply({ model: "m", messages: ask });
  gw.server.closeAllConnections();
  gw.server.close();
  assert.equal(reply.calls[0].arguments, "{\"path\":\"b\"}");
});

test("a stream without [DONE] fails, keeping what came", async () => {
  const gw = await fakeGateway([(res) => sse(res, [{ choices: [{ index: 0, delta: { content: "par" } }] }], { done: false })]);
  const client = new GatewayClient({ endpoint: gw.endpoint, apiKey: "" });
  await assert.rejects(client.reply({ model: "m", messages: ask }), (error) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.partial, "par");
    assert.ok(error.uncertain);
    return true;
  });
  gw.server.closeAllConnections();
  gw.server.close();
});

test("busy (429 with credits left) is retried; a 502 the model may have seen is not", async () => {
  const gw = await fakeGateway([
    (res) => { res.writeHead(429, { "Retry-After": "0", ...CREDITS }); res.end("{}"); },
    (res) => sse(res, [{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }]),
    (res) => { res.writeHead(502); res.end("<html>proxy</html>"); },
  ]);
  const client = new GatewayClient({ endpoint: gw.endpoint, apiKey: "" });
  assert.equal((await client.reply({ model: "m", messages: ask })).content, "ok");
  await assert.rejects(client.reply({ model: "m", messages: ask }), (error) => {
    assert.equal(error.status, 502);
    assert.ok(error.uncertain);
    assert.equal(error.message, "The gateway answered HTTP 502.");
    return true;
  });
  assert.equal(gw.seen.length, 3);
  gw.server.closeAllConnections();
  gw.server.close();
});

test("429 with no credits left is the allowance used up: not retried", async () => {
  const gw = await fakeGateway([(res) => {
    res.writeHead(429, { ...CREDITS, "x-ratelimit-remaining-tokens": "0", "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "quota exceeded for key sk-secret at https://gw.example.com/x" } }));
  }]);
  const client = new GatewayClient({ endpoint: gw.endpoint, apiKey: "sk-secret" });
  await assert.rejects(client.reply({ model: "m", messages: ask }), (error) => {
    assert.ok(error.exhausted);
    assert.equal(error.credits.remaining, 0);
    assert.match(error.message, /resets in about 60 minutes/);
    return true;
  });
  assert.equal(gw.seen.length, 1);
  gw.server.closeAllConnections();
  gw.server.close();
});

test("error details are cleaned of the key and addresses", () => {
  const client = new GatewayClient({ endpoint: "https://gw.example.com/v1/chat/completions", apiKey: "sk-secret" });
  const error = client._httpFailure(400, {}, JSON.stringify({ error: { message: "bad key sk-secret for https://gw.example.com/v1 at api.internal.corp:8443" } }));
  assert.equal(error.message, "The gateway answered HTTP 400: bad key [redacted] for [endpoint] at [server]");
});

test("an empty reply is an error; the models list is read from /models", async () => {
  const gw = await fakeGateway([
    (res) => sse(res, [{ choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }] }]),
    (res) => { res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a" }, { id: "model-a" }] })); },
  ]);
  const client = new GatewayClient({ endpoint: gw.endpoint, apiKey: "", maxRetries: 0 });
  await assert.rejects(client.reply({ model: "m", messages: ask }), /empty reply/);
  assert.deepEqual(await client.models(), ["model-a", "model-b"]);
  assert.equal(gw.seen[1].url, "/v1/models");
  gw.server.closeAllConnections();
  gw.server.close();
});

test("Stop ends a reply that's waiting", async () => {
  const gw = await fakeGateway([(res) => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": hold\n\n"); }]);
  const client = new GatewayClient({ endpoint: gw.endpoint, apiKey: "" });
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 100);
  await assert.rejects(client.reply({ model: "m", messages: ask, signal: stop.signal }), { name: "Cancelled" });
  gw.server.closeAllConnections();
  gw.server.close();
});
