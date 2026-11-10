// @ts-check
"use strict";
/**
 * A fake Assist gateway (node:http, no packages) that behaves like the kind Solder's Assist lane is built for:
 * - It records any system message, tools, effort or output limit it's sent (a test fails on those).
 * - No session in the request: a new session, and it sees only the LAST user message (history is ignored).
 * - A known session with a token it issued: it sees the session's history plus the new message.
 * - An unknown session or a token it never issued: HTTP 502, like a backend error.
 * - Every answer carries {[block]: {session, token: <new each time>, thinking: []}}: in the final streamed chunk, or
 *   at the root when not streaming.
 * - Its "model" is a script: given what it sees (user and assistant text), it returns the reply text.
 * Neutral names only: the block and its fields are made up here, as in any test.
 */
const http = require("node:http");
const crypto = require("node:crypto");

/**
 * @param {{block?: string, script: (seen: {role: string, content: string}[], request: any) => string}} options
 */
async function fakeAssist({ block = "test_session", script }) {
  /** @type {{payload: any, seen: {role: string, content: string}[], session: string, status: number, systemSent: boolean, toolsSent: boolean, extrasSent: string[]}[]} */
  const requests = [];
  /** @type {Map<string, {history: {role: string, content: string}[], tokens: Set<string>}>} */
  const sessions = new Map();
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(raw);
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const record = { payload, seen: /** @type {any[]} */ ([]), session: "", status: 200,
        systemSent: messages.some((/** @type {any} */ m) => m.role === "system"), toolsSent: !!payload.tools,
        extrasSent: ["tools", "tool_choice", "reasoning_effort", "max_tokens"].filter((k) => k in payload) };
      requests.push(record);
      const given = payload[block];
      let session;
      if (given) {
        session = sessions.get(given.session);
        const top = payload.session === given.session && payload.token === given.token;
        if (!session || !session.tokens.has(given.token) || !top) {
          record.status = 502;
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "the model backend encountered an error, please try again later" } }));
          return;
        }
        record.session = given.session;
        record.seen = [...session.history, ...messages.filter((/** @type {any} */ m) => m.role === "user")];
      } else {
        const id = "s-" + crypto.randomBytes(6).toString("hex");
        session = { history: [], tokens: new Set() };
        sessions.set(id, session);
        record.session = id;
        const lastUser = [...messages].reverse().find((/** @type {any} */ m) => m.role === "user");
        record.seen = lastUser ? [{ role: "user", content: lastUser.content }] : [];
      }
      const text = script(record.seen, payload);
      session.history = [...record.seen, { role: "assistant", content: text }];
      const token = "t-" + crypto.randomBytes(8).toString("hex");
      session.tokens.add(token);
      const carried = { [block]: { session: record.session, token, thinking: [{ text: "hidden" }] } };
      const usage = { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 };
      if (payload.stream === false) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage, ...carried }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const half = Math.ceil(text.length / 2);
      for (const piece of [text.slice(0, half), text.slice(half)]) {
        if (piece) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage, ...carried })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    requests,
    sessions,
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

module.exports = { fakeAssist };
