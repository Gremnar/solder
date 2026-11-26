// @ts-check
"use strict";
// node --test   (or, with no Node installed: $env:ELECTRON_RUN_AS_NODE=1; & code.exe --test test)
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { GatewayClient, SseParser } = require("../src/gateway.js");

/** A fake gateway: each request is answered by the next handler in `script` (given the response and the request). */
function fakeGateway(script) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, body: body ? JSON.parse(body) : null });
      const handler = script.shift();
      if (!handler) { res.writeHead(500); res.end(); return; }
      handler(res, req);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const { port } = /** @type {any} */ (server.address());
    resolve({ server, seen, endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
      stop() { server.closeAllConnections(); server.close(); } });
  }));
}

/** @param {any} res @param {any} value */
function json(res, value, status = 200, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(value));
}

const ask = [{ role: "system", content: "rules" }, { role: "user", content: "hi" }];

// ---------------------------------------------------------------- 1: embeddings never resend what may have been billed --

test("embeddings: a 502 the gateway may have worked on is not sent again; a busy 503 still is", async () => {
  const gw = await fakeGateway([
    (res) => json(res, { error: { message: "bad gateway" } }, 502),
    (res) => json(res, { data: [{ index: 0, embedding: [1, 2] }] }),
  ]);
  try {
    const client = new GatewayClient({ endpoint: gw.endpoint, apiKey: "" });
    await assert.rejects(client.embed({ model: "embed-a", input: ["a"] }), (error) => error.uncertain === true && error.status === 502);
    assert.equal(gw.seen.length, 1, "not resent");
  } finally { gw.stop(); }
  const busy = await fakeGateway([
    (res) => json(res, { error: { message: "busy" } }, 503, { "Retry-After": "0" }),
    (res) => json(res, { data: [{ index: 0, embedding: [1, 2] }] }),
  ]);
  try {
    const result = await new GatewayClient({ endpoint: busy.endpoint, apiKey: "" }).embed({ model: "embed-a", input: ["a"] });
    assert.deepEqual(result.vectors, [[1, 2]]);
    assert.equal(busy.seen.length, 2, "a busy refusal is retried");
  } finally { busy.stop(); }
});

test("embeddings: a connection that fails after the request went out (an unreadable answer) is uncertain, and not sent again", async () => {
  const gw = await fakeGateway([
    (res) => { res.socket.write("NOT HTTP AT ALL\r\n\r\n"); res.socket.destroy(); },
    (res) => json(res, { data: [{ index: 0, embedding: [1, 2] }] }),
    (res) => json(res, { data: [{ index: 0, embedding: [1, 2] }] }),
  ]);
  try {
    const client = new GatewayClient({ endpoint: gw.endpoint, apiKey: "", maxRetries: 1 });
    await assert.rejects(client.embed({ model: "embed-a", input: ["a"] }), (error) => error.uncertain === true);
    assert.equal(gw.seen.length, 1, "not resent");
  } finally { gw.stop(); }
});

// ---------------------------------------------------------------- 2: embedding indexes --

test("embeddings: indexes out of range, repeated or leaving a gap are refused; reordered or absent indexes are fine", async () => {
  const answers = [
    { data: [{ index: 1, embedding: [1] }, { index: 2, embedding: [2] }] }, // 1-based: shifted by one
    { data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }] }, // repeated: a hole at 1
    { data: [{ index: -1, embedding: [1] }, { index: 0, embedding: [2] }] },
    { data: [{ index: 2, embedding: [1] }, { embedding: [2] }] }, // out of range, and the other place left empty
    { data: [{ embedding: [1] }, { index: 0, embedding: [2] }] }, // positional 0 and index 0: the same place twice
  ];
  const gw = await fakeGateway([...answers.map((answer) => (res) => json(res, answer)),
    (res) => json(res, { data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }),
    (res) => json(res, { data: [{ embedding: [1] }, { embedding: [2] }] }),
  ]);
  try {
    const client = new GatewayClient({ endpoint: gw.endpoint, apiKey: "" });
    for (let n = 0; n < answers.length; n++) {
      await assert.rejects(client.embed({ model: "embed-a", input: ["a", "b"] }), /didn't come back as lists of numbers/, `answer ${n}`);
    }
    assert.deepEqual((await client.embed({ model: "embed-a", input: ["a", "b"] })).vectors, [[1], [2]], "reordered");
    assert.deepEqual((await client.embed({ model: "embed-a", input: ["a", "b"] })).vectors, [[1], [2]], "no index: in order");
  } finally { gw.stop(); }
});

// ---------------------------------------------------------------- 3: SSE line ends split across chunks --

/** Events from chunks fed one at a time. @param {(string|Buffer)[]} chunks */
function events(chunks) {
  const parser = new SseParser(256 * 1024);
  return chunks.flatMap((chunk) => parser.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8")));
}

test("SSE: a CR at a chunk's end, then LF alone, then the blank line's LF: two events, not one merged", () => {
  assert.deepEqual(events(['data: {"a":1}\r', "\n", "\n", 'data: {"b":2}\r', "\n", "\n"]), ['{"a":1}', '{"b":2}']);
  // CRLF split in the ordinary way.
  assert.deepEqual(events(['data: {"a":1}\r', "\n\r\n", 'data: {"b":2}\r\n\r', "\n"]), ['{"a":1}', '{"b":2}']);
  // Bare CR line ends, split anywhere.
  assert.deepEqual(events(['data: {"a":1}\r', "\r", 'data: {"b":2}\r\r']), ['{"a":1}', '{"b":2}']);
  // LF alone.
  assert.deepEqual(events(['data: {"a":1}\n', "\n", 'data: {"b":2}\n\n']), ['{"a":1}', '{"b":2}']);
});

test("SSE: a character split across chunks after a CR keeps the CRLF pairing", () => {
  const euro = Buffer.from("€", "utf8"); // 3 bytes, split over three chunks
  const parser = new SseParser(256 * 1024);
  const out = [];
  out.push(...parser.push(Buffer.from("data: x\r", "utf8")));
  out.push(...parser.push(Buffer.from("\n", "utf8")));
  out.push(...parser.push(Buffer.concat([Buffer.from("\ndata: ", "utf8"), euro.subarray(0, 1)])));
  out.push(...parser.push(euro.subarray(1, 2)));
  out.push(...parser.push(Buffer.concat([euro.subarray(2), Buffer.from("\r", "utf8")])));
  out.push(...parser.push(Buffer.from("\n", "utf8")));
  out.push(...parser.push(Buffer.from("\n", "utf8")));
  assert.deepEqual(out, ["x", "€"]);
  // A chunk that decodes to nothing right after a CR: the LF after it is still the CR's partner.
  const second = new SseParser(256 * 1024);
  const got = [];
  got.push(...second.push(Buffer.from("data: y\r", "utf8")));
  got.push(...second.push(Buffer.alloc(0)));
  got.push(...second.push(Buffer.from("\n\n", "utf8")));
  assert.deepEqual(got, ["y"]);
});

// ---------------------------------------------------------------- 4: usage before a dropped stream --

test("a stream that ends after its usage but before [DONE] fails, and the failure carries that usage", async () => {
  const usage = { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 };
  const gw = await fakeGateway([
    (res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: "stop" }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
      res.end();
    },
    (res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Hi" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
      setTimeout(() => res.socket.destroy(), 50);
    },
    (res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Hi" } }] })}\n\n`);
      res.end();
    },
  ]);
  try {
    const client = new GatewayClient({ endpoint: gw.endpoint, apiKey: "" });
    await assert.rejects(client.reply({ model: "model-a", messages: ask }),
      (error) => /ended before it finished/.test(error.message) && error.partial === "Hi" && error.usage?.total_tokens === 105);
    await assert.rejects(client.reply({ model: "model-a", messages: ask }),
      (error) => error.uncertain === true && error.usage?.total_tokens === 105);
    await assert.rejects(client.reply({ model: "model-a", messages: ask }), (error) => error.usage === undefined, "no usage came: none is made up");
    assert.equal(gw.seen.length, 3, "none of them resent");
  } finally { gw.stop(); }
});

test("an empty reply keeps its own usage; a finished reply is unchanged", async () => {
  const usage = { prompt_tokens: 9, completion_tokens: 0, total_tokens: 9 };
  const gw = await fakeGateway([
    (res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
      res.end("data: [DONE]\n\n");
    },
    (res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage })}\n\n`);
      res.end("data: [DONE]\n\n");
    },
  ]);
  try {
    const client = new GatewayClient({ endpoint: gw.endpoint, apiKey: "", maxRetries: 0 });
    await assert.rejects(client.reply({ model: "model-a", messages: ask }), (error) => error.empty === true && error.usage.total_tokens === 9);
    const reply = await client.reply({ model: "model-a", messages: ask });
    assert.equal(reply.content, "ok");
    assert.equal(reply.usage.total_tokens, 9);
  } finally { gw.stop(); }
});
