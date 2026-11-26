// @ts-check
"use strict";
/**
 * A test proxy for the live suite: it passes requests to an OpenAI-compatible endpoint unchanged, except that a
 * streamed request asks for its token counts (stream_options.include_usage: some endpoints send none otherwise), and
 * it writes what each request cost to a ledger, with a hard cap: past it, requests are refused before they're sent.
 * Test tooling only (Solder itself never uses it). No packages: Node's http and https.
 *
 *   node live/usage-proxy.js --upstream <chat completions URL> --ledger <file.jsonl> --cap 35 [--port 8790]
 *                            [--price model=in/out ...]   (dollars per million tokens; default 3/15 for any model)
 *
 * The live suite then runs with --endpoint http://127.0.0.1:8790/chat/completions. The key goes through as the client
 * sends it, and is never written anywhere.
 */
const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");

const args = process.argv.slice(2);
const opt = (/** @type {string} */ name, /** @type {string} */ fallback) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : fallback; };
const upstream = new URL(opt("upstream", ""));
const ledger = opt("ledger", "");
const cap = Number(opt("cap", "0"));
const port = Number(opt("port", "8790"));
if (!ledger || !(cap > 0)) { console.error("--ledger and --cap are needed"); process.exit(2); }
/** @type {Record<string, [number, number]>} dollars per million tokens: in, out (thinking counts as out) */
const prices = {};
for (let i = 0; i < args.length; i++) if (args[i] === "--price") { const [model, p] = args[i + 1].split("="); const [a, b] = p.split("/").map(Number); prices[model] = [a, b]; }
const priceOf = (/** @type {string} */ model) => prices[model] ?? [3, 15];

/** What's been spent so far, from the ledger (so a restart doesn't forget). */
function spent() {
  try { return fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean).reduce((sum, line) => sum + (JSON.parse(line).cost || 0), 0); }
  catch { return 0; }
}
let total = spent();
console.log(`usage proxy on 127.0.0.1:${port} → ${upstream.origin}; spent so far $${total.toFixed(2)} of $${cap}`);

/** @param {any} usage @param {string} model */
function costOf(usage, model) {
  const [pin, pout] = priceOf(model);
  const prompt = Number(usage?.prompt_tokens) || 0;
  // Everything past the prompt is billed as output: the answer and any thinking.
  const out = Math.max(Number(usage?.completion_tokens) || 0, (Number(usage?.total_tokens) || 0) - prompt);
  return { prompt, out, cost: (prompt * pin + out * pout) / 1e6 };
}

http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = Buffer.concat(chunks);
    let model = "";
    let stream = false;
    if (req.method === "POST" && body.length) {
      try {
        const payload = JSON.parse(body.toString("utf8"));
        model = String(payload.model || "");
        stream = !!payload.stream;
        if (stream) payload.stream_options = { ...(payload.stream_options || {}), include_usage: true };
        body = Buffer.from(JSON.stringify(payload), "utf8");
      } catch { /* sent as it came */ }
      // The cap, with a margin for the request about to go: nothing is sent past it.
      if (total >= cap - 0.25) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Test budget used: $${total.toFixed(2)} of $${cap}.` } }));
        return;
      }
    }
    const path = req.url && req.url.endsWith("/models") ? upstream.pathname.replace(/\/chat\/completions$/, "/models") : upstream.pathname;
    const headers = { ...req.headers, host: upstream.host, "content-length": String(body.length) };
    delete headers["accept-encoding"]; // plain text back, so the usage can be read
    const started = Date.now();
    const out = https.request({ hostname: upstream.hostname, port: upstream.port || 443, path, method: req.method, headers }, (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      let tail = "";
      let usage = null;
      up.on("data", (c) => {
        res.write(c);
        if (req.method !== "POST") return;
        tail += c.toString("utf8");
        // The usage comes in a late event (streamed) or with the body (whole): read it from what passes.
        for (const m of tail.matchAll(/"usage"\s*:\s*(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})/g)) { try { usage = JSON.parse(m[1]); } catch { /* partial */ } }
        if (tail.length > 200_000) tail = tail.slice(-50_000);
      });
      up.on("end", () => {
        res.end();
        if (req.method !== "POST") return;
        const { prompt, out: outTokens, cost } = costOf(usage, model);
        total += cost;
        fs.appendFileSync(ledger, JSON.stringify({ at: new Date().toISOString(), model, stream, status: up.statusCode, prompt, out: outTokens,
          cost: Math.round(cost * 1e6) / 1e6, total: Math.round(total * 1e4) / 1e4, ms: Date.now() - started, usage: !!usage }) + "\n");
      });
    });
    out.on("error", (error) => { if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "proxy: " + error.message } })); });
    out.end(body);
  });
}).listen(port, "127.0.0.1");
