// @ts-check
"use strict";
/**
 * Solder's gateway client: one OpenAI-compatible Chat Completions request with tools, streamed, with
 * its tool calls, usage and any rate-limit allowance the server reports. No npm packages:
 * node:http/https only, which VS Code's extension host routes through its proxy settings.
 *
 * Ported from Alloy's GatewayClient (its native-tools path). What it keeps from Alloy:
 * - a tool call comes back WHOLE in one SSE chunk, so a big write is minutes of silence: the timeout
 *   is quiet time on the socket (480 s for Tool models), not the whole request;
 * - every call's id and extra_content (Gemini models' thought signatures) are kept, to send back exactly;
 * - a stream that ends without [DONE] (or without a finish_reason) is a failure, never "done";
 * - busy answers (429, 503) are retried after a backoff (or Retry-After, up to 60 s); a failure the
 *   model may already have seen (a timeout, a reset, a 5xx other than 503) is NOT retried here:
 *   with no gateway session the retry resends the whole chat and is billed again, so the loop
 *   decides once;
 * - an empty reply is an error (transient unless the output limit or a filter caused it), and billed,
 *   so it isn't resent here either;
 * - a Retry-After over 60 s isn't retried at all: Resume, later;
 * - every failure carries the text that streamed before it (error.partial), so it's never lost;
 * - error text is cleaned of the key, URLs and host names before anyone sees it.
 */

const http = require("node:http");
const https = require("node:https");

const TRANSIENT_HTTP = new Set([408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const BUSY_HTTP = new Set([429, 503]); // turned away before the model saw it: safe to resend
const BACKOFF_MS = [1000, 4000, 8000];
const MAX_RETRY_AFTER_MS = 60_000;
/** How far into a call being written its path is looked for. */
const PATH_LOOK_CHARS = 2_000;
/** A 429 that asks to wait longer than this is an allowance used up, not a busy moment. */
const EXHAUSTED_WAIT_MS = 10 * 60_000;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_ERROR_BYTES = 16 * 1024;
const MAX_ERROR_CHARS = 500;
const MAX_EXTRA_CHARS = 20_000;
/** The output limit when none is set: it covers thinking as well as the answer (Google: at least this). */
const NATIVE_MAX_TOKENS = 32_768;
/** How long a reply may go quiet: a call that writes a big file arrives only once it's complete. */
const TOOL_QUIET_MS = 480_000;

/** Rate-limit headers in the common x-ratelimit-{limit,remaining,reset}-<bucket> shape. */
const RATE_HEADER = /^x-ratelimit-(limit|remaining|reset)-(.+)$/;

class GatewayError extends Error {
  /**
   * @param {string} message what the user may see (already cleaned)
   * @param {{transient?: boolean, uncertain?: boolean, status?: number, exhausted?: boolean,
   *          partial?: string, credits?: Credits | null}} [more]
   */
  constructor(message, more = {}) {
    super(message);
    this.name = "GatewayError";
    /** Worth trying again later (the loop decides). */
    this.transient = !!more.transient;
    /** The model may have seen it (and the tokens been counted). */
    this.uncertain = !!more.uncertain;
    this.status = more.status ?? 0;
    /** The day's allowance is used up: switch models or wait for the reset, don't retry. */
    this.exhausted = !!more.exhausted;
    /** Text that streamed before it failed. */
    this.partial = more.partial ?? "";
    this.credits = more.credits ?? null;
  }
}

class Cancelled extends GatewayError {
  constructor() { super("Stopped."); this.name = "Cancelled"; }
}

/**
 * @typedef {{bucket: string, limit: number, remaining: number, resetSeconds?: number}} Credits
 * @typedef {{id: string, name: string, arguments: string, extra?: object}} ToolCall
 * @typedef {{role: "system"|"user"|"assistant"|"tool", content: string, tool_calls?: object[],
 *            tool_call_id?: string}} Message
 * @typedef {{content: string, calls: ToolCall[], finishReason: string, usage: any,
 *            credits: Credits | null, ms: number}} Reply
 * @typedef {{endpoint: string, apiKey: string, modelsEndpoint?: string, embeddingsEndpoint?: string, quietMs?: number,
 *            maxRetries?: number, maxResponseBytes?: number, maxOutputTokens?: number}} Settings
 */

/**
 * The tightest allowance the server reports (x-ratelimit-limit-<bucket> with its -remaining-, and
 * -reset- when sent): the bucket with the smallest share left. null when it reports none.
 * @param {import("node:http").IncomingHttpHeaders} headers @returns {Credits | null}
 */
function credits(headers) {
  /** @type {Map<string, any>} */
  const buckets = new Map();
  for (const [name, raw] of Object.entries(headers)) {
    const match = RATE_HEADER.exec(name.toLowerCase());
    if (!match) continue;
    const text = String(Array.isArray(raw) ? raw[0] : raw ?? "").trim();
    const value = match[1] === "reset" ? Number.parseFloat(text) : Number.parseInt(text, 10);
    if (!Number.isFinite(value) || value < 0) continue;
    const bucket = buckets.get(match[2]) ?? { bucket: match[2] };
    bucket[match[1] === "reset" ? "resetSeconds" : match[1]] = value;
    buckets.set(match[2], bucket);
  }
  let best = null;
  for (const bucket of buckets.values()) {
    if (!("limit" in bucket) || !("remaining" in bucket) || bucket.limit <= 0) continue;
    if (!best || bucket.remaining / bucket.limit < best.remaining / best.limit) best = bucket;
  }
  return best;
}

/** @param {unknown} call */
function callId(call) {
  const value = call && typeof call === "object" ? /** @type {any} */ (call).id : undefined;
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value)
    ? value : "";
}

/** extra_content (the thought signature), kept only when it's small plain JSON. @param {unknown} call */
function callExtra(call) {
  const value = call && typeof call === "object" ? /** @type {any} */ (call).extra_content : undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) return undefined;
  try {
    return JSON.stringify(value).length <= MAX_EXTRA_CHARS ? value : undefined;
  } catch { return undefined; }
}

class GatewayClient {
  /** @param {Settings} settings */
  constructor(settings) {
    this.endpoint = checkedUrl(settings.endpoint, "Endpoint");
    this.modelsEndpoint = settings.modelsEndpoint ? checkedUrl(settings.modelsEndpoint, "Models endpoint") : "";
    this.embeddingsEndpoint = settings.embeddingsEndpoint ? checkedUrl(settings.embeddingsEndpoint, "Embeddings endpoint") : "";
    const key = String(settings.apiKey ?? "").trim();
    if (/[\x00-\x20\x7f]/.test(key) || !/^[\x21-\x7e]*$/.test(key)) {
      throw new GatewayError("The API key must be a token without spaces or control characters.");
    }
    this.apiKey = key;
    this.quietMs = settings.quietMs ?? TOOL_QUIET_MS;
    this.maxRetries = settings.maxRetries ?? 2;
    this.maxResponseBytes = settings.maxResponseBytes ?? 8 * 1024 * 1024;
    this.maxOutputTokens = settings.maxOutputTokens || NATIVE_MAX_TOKENS;
  }

  /**
   * One reply. `messages` is the whole chat (Tool models keep no session), starting with the system
   * message; the last must be user text or a tool result. Text streams through `onText`.
   * @param {{model: string, messages: Message[], tools?: object[], effort?: "low"|"medium"|"high",
   *          onText?: (text: string) => void, signal?: AbortSignal}} request
   * @returns {Promise<Reply>}
   */
  async reply({ model, messages, tools, effort, onText = () => {}, onCalls = () => {}, signal }) {
    if (typeof model !== "string" || !model.trim() || model.length > 500) {
      throw new GatewayError("Choose a model before sending a message.");
    }
    if (!Array.isArray(messages) || !messages.length) throw new GatewayError("There's nothing to send.");
    const last = messages[messages.length - 1].role;
    if (last !== "user" && last !== "tool") throw new GatewayError("The last message must be user text or a tool result.");
    // Field order as Alloy sends it (the gateway was picky about Zom's shape; keep it).
    /** @type {any} */
    const payload = { model, messages, stream: true };
    if (tools && tools.length) Object.assign(payload, { tools, tool_choice: "auto" });
    if (effort) payload.reasoning_effort = effort; // nothing = the model's default (answers like low)
    payload.max_tokens = this.maxOutputTokens;
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    if (body.length > this.maxResponseBytes) {
      throw new GatewayError("The chat is too long to send. Compact it or start a new chat.");
    }
    const started = Date.now();
    let streamed = false;
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new Cancelled();
      try {
        const result = await this._streamOnce(body, (text) => { streamed = true; onText(text); }, signal, onCalls);
        return { ...result, ms: Date.now() - started };
      } catch (error) {
        if (error instanceof Cancelled || !(error instanceof GatewayError)) throw error;
        // Never resend once words have reached the user, or when the model may have seen it.
        if (!error.transient || error.uncertain || streamed || error.exhausted || attempt >= this.maxRetries) throw error;
        const wait = /** @type {any} */ (error).retryAfterMs ?? BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
        await sleep(wait, signal);
      }
    }
  }

  /** An address next to /chat/completions (its /models, its /embeddings). @param {string} name @param {string} what */
  sibling(name, what) {
    const url = new URL(this.endpoint);
    const path = url.pathname.replace(/\/+$/, "");
    if (!path.toLowerCase().endsWith("/chat/completions")) {
      throw new GatewayError(`Set ${what}; it can't be worked out from the endpoint.`);
    }
    url.pathname = path.slice(0, -"/chat/completions".length) + "/" + name;
    url.search = url.hash = "";
    return url.toString();
  }

  /**
   * One vector per text, in order, from the gateway's /embeddings (next to /chat/completions). Busy answers are
   * retried like replies; nothing is ever shown from an embedding, so a resend can't repeat anything.
   * @param {{model: string, input: string[], signal?: AbortSignal}} request
   * @returns {Promise<{vectors: number[][], tokens: number, credits: Credits | null}>}
   */
  async embed({ model, input, signal }) {
    if (typeof model !== "string" || !model.trim()) throw new GatewayError("Choose an embeddings model in Settings, under Your docs.");
    const endpoint = this.embeddingsEndpoint || this.sibling("embeddings", "an embeddings endpoint");
    const body = Buffer.from(JSON.stringify({ model, input }), "utf8");
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new Cancelled();
      let failure;
      try {
        const { status, headers, text } = await this._request(endpoint, body, signal, 120_000);
        if (status === 200) {
          const value = parseJson(text);
          const data = Array.isArray(value.data) ? value.data : null;
          if (!data || data.length !== input.length) throw new GatewayError("The embeddings didn't come back one for each text.");
          /** @type {number[][]} */
          const vectors = new Array(input.length);
          data.forEach((/** @type {any} */ item, /** @type {number} */ position) => {
            vectors[Number.isInteger(item?.index) ? item.index : position] = item?.embedding;
          });
          if (vectors.some((vector) => !Array.isArray(vector) || !vector.length || typeof vector[0] !== "number")) {
            throw new GatewayError("The embeddings didn't come back as lists of numbers.");
          }
          const usage = value.usage || {};
          return { vectors, tokens: Number(usage.prompt_tokens ?? usage.total_tokens ?? 0) || 0, credits: credits(headers) };
        }
        failure = this._httpFailure(status, headers, text);
      } catch (error) {
        if (error instanceof Cancelled) throw error;
        failure = error;
      }
      const e = /** @type {any} */ (failure);
      if (!(failure instanceof GatewayError) || !e.transient || e.exhausted || attempt >= this.maxRetries) throw failure;
      await sleep(e.retryAfterMs ?? BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)], signal);
    }
  }

  /** The model ids the gateway offers (its /models next to /chat/completions). @param {AbortSignal} [signal] */
  async models(signal) {
    const endpoint = this.modelsEndpoint || this.sibling("models", "a models endpoint");
    const { status, headers, text } = await this._request(endpoint, null, signal, 60_000);
    if (status !== 200) throw this._httpFailure(status, headers, text);
    const value = parseJson(text);
    if (!Array.isArray(value.data)) throw new GatewayError("The models list didn't come back as a list.");
    return [...new Set(value.data.map((item) => item && typeof item.id === "string" ? item.id.trim() : "")
      .filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  /**
   * @param {Buffer} body @param {(text: string) => void} emit @param {AbortSignal} [signal]
   * @param {(calls: {name: string, chars: number, path: string}[]) => void} [onCalls] tool calls as they're written
   */
  _streamOnce(body, emit, signal, onCalls) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.endpoint);
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": body.length,
                   ...(this.apiKey ? { Authorization: "Bearer " + this.apiKey } : {}) },
      });
      let settled = false;
      let sent = false;
      /** @type {ChatStream | null} */
      let reader = null;
      /** Every failure carries what streamed before it (a reset, a timeout and Stop too). @param {any} error */
      const fail = (error) => {
        if (settled) return;
        settled = true;
        if (error instanceof GatewayError && reader && !error.partial) error.partial = reader.text;
        reject(error);
        req.destroy();
      };
      const onAbort = () => fail(new Cancelled());
      signal?.addEventListener("abort", onAbort, { once: true });
      // Quiet time, not total time: a long reply that keeps streaming is fine.
      req.setTimeout(this.quietMs, () => fail(new GatewayError("The gateway went quiet for too long.",
        { transient: true, uncertain: true })));
      req.on("finish", () => { sent = true; });
      req.on("error", (error) => fail(this._transportFailure(error, sent)));
      req.on("response", (res) => {
        sent = true;
        const status = res.statusCode ?? 0;
        const found = credits(res.headers);
        if (status !== 200) {
          collect(res, MAX_ERROR_BYTES).then((text) => fail(this._httpFailure(status, res.headers, text, found)),
            () => fail(this._httpFailure(status, res.headers, "", found)));
          return;
        }
        const type = String(res.headers["content-type"] ?? "").toLowerCase();
        if (type && !type.includes("text/event-stream")) {
          fail(new GatewayError("The gateway didn't answer with a stream. Check the endpoint."));
          return;
        }
        const stream = reader = new ChatStream(emit, onCalls);
        const sse = new SseParser(MAX_EVENT_BYTES);
        let total = 0;
        /** Feed events; true once the reply is complete (and resolved). @param {string[]} events */
        const take = (events) => {
          for (const data of events) {
            if (stream.event(data)) {
              const done = stream.finish(); // may throw (an empty reply): before settling
              settled = true;
              signal?.removeEventListener("abort", onAbort);
              resolve({ ...done, credits: found });
              res.destroy();
              return true;
            }
          }
          return false;
        };
        res.on("data", (/** @type {Buffer} */ chunk) => {
          if (settled) return;
          total += chunk.length;
          try {
            if (total > this.maxResponseBytes) throw new GatewayError("The reply was larger than the size limit.");
            take(sse.push(chunk));
          } catch (error) {
            fail(error);
          }
        });
        res.on("end", () => {
          if (settled) return;
          try { if (take(sse.end())) return; } catch (error) { fail(error); return; }
          fail(new GatewayError(
            "The gateway's stream ended before it finished. What came through has been kept.",
            { transient: true, uncertain: true }));
        });
        res.on("error", (error) => fail(this._transportFailure(error, true)));
      });
      req.end(body);
    });
  }

  /** @param {string} endpoint @param {Buffer|null} body @param {AbortSignal|undefined} signal @param {number} ms */
  _request(endpoint, body, signal, ms) {
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint);
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.request(url, { method: body ? "POST" : "GET", signal,
        headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}),
          ...(this.apiKey ? { Authorization: "Bearer " + this.apiKey } : {}) } });
      req.setTimeout(ms, () => req.destroy(new GatewayError("The gateway took too long to answer.", { transient: true })));
      req.on("error", (error) => reject(signal?.aborted ? new Cancelled()
        : error instanceof GatewayError ? error : this._transportFailure(error)));
      req.on("response", (res) => collect(res, this.maxResponseBytes)
        .then((text) => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }), reject));
      req.end(body ?? undefined);
    });
  }

  /** @param {number} status @param {import("node:http").IncomingHttpHeaders} headers @param {string} text
   *  @param {Credits|null} [found] */
  _httpFailure(status, headers, text, found = credits(headers)) {
    let message = `The gateway answered HTTP ${status}.`;
    let detail = "";
    try {
      const error = parseJson(text).error;
      detail = error && typeof error.message === "string" ? this._clean(error.message) : "";
      if (detail) message = message.slice(0, -1) + ": " + detail;
    } catch { /* never show a proxy's HTML page */ }
    // A 429 is "used up", not "busy", when the tightest allowance is at 0 and doesn't come back within a
    // minute, or when the gateway asks to wait more than 10 minutes (seen: a daily limit, with a
    // Retry-After of hours and no usable bucket header), or when its words say so ("credit limit", "quota")
    // and it doesn't ask for a short wait (a per-minute quota is busy). Waiting a few seconds won't help: not retried.
    const asked = retryAfterMs(headers["retry-after"]);
    const zero = !!found && found.remaining === 0
      && !(found.resetSeconds !== undefined && found.resetSeconds * 1000 <= MAX_RETRY_AFTER_MS);
    const said = USED_UP_WORDS.test(detail) && !(asked !== null && asked <= MAX_RETRY_AFTER_MS);
    if (status === 429 && (zero || (asked !== null && asked > EXHAUSTED_WAIT_MS) || said)) {
      const told = toldAllowance(detail);
      const seconds = zero && found?.resetSeconds ? found.resetSeconds
        : asked !== null && asked > MAX_RETRY_AFTER_MS ? asked / 1000 : told.resetSeconds ?? 0;
      const left = found ?? (told.limit ? { bucket: "credits", limit: told.limit, remaining: 0, resetSeconds: seconds || undefined } : null);
      const size = left?.limit ? ` (${left.limit.toLocaleString("en-US")} ${left.bucket})` : "";
      const when = seconds ? ` It resets in about ${spoken(seconds)}, at ${clock(seconds)}.` : "";
      return new GatewayError(`The allowance is used up${size}.` + when + (detail ? ` (The gateway said: ${detail})` : ""),
        { status, exhausted: true, credits: left });
    }
    if (TRANSIENT_HTTP.has(status)) {
      let retryAfter = asked;
      if (retryAfter === null && status === 429 && found && found.remaining === 0 && found.resetSeconds !== undefined) {
        retryAfter = found.resetSeconds * 1000; // a short bucket at 0: wait for its reset
      }
      if (retryAfter !== null && retryAfter > MAX_RETRY_AFTER_MS) {
        // Not retried automatically (Resume still works): hammering a limiter that asked for minutes won't help.
        return new GatewayError(message + " The gateway asked to wait longer; try again later.",
          { status, uncertain: !BUSY_HTTP.has(status), credits: found });
      }
      const error = new GatewayError(message, { status, transient: true, uncertain: !BUSY_HTTP.has(status),
        credits: found });
      if (retryAfter !== null) /** @type {any} */ (error).retryAfterMs = retryAfter;
      return error;
    }
    return new GatewayError(message, { status, credits: found });
  }

  /** @param {any} error @param {boolean} [sent] the request had gone out (the model may have seen it) */
  _transportFailure(error, sent = false) {
    const code = error && error.code;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new GatewayError("The gateway's name couldn't be found.", { transient: true });
    if (code === "ECONNREFUSED") return new GatewayError("The gateway refused the connection.", { transient: true });
    if (code === "ECONNRESET" || code === "EPIPE" || code === "ECONNABORTED") {
      // Corporate gateways reset connections now and then (WinError 10054 on Windows).
      return new GatewayError("The connection to the gateway was interrupted.", { transient: true, uncertain: true });
    }
    if (code === "ETIMEDOUT") return new GatewayError("The gateway took too long to answer.", { transient: true, uncertain: true });
    if (String(code).startsWith("CERT_") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "SELF_SIGNED_CERT_IN_CHAIN") {
      return new GatewayError("The gateway's certificate couldn't be verified.");
    }
    return new GatewayError(sent ? "The connection to the gateway failed." : "Couldn't reach the gateway.",
      { transient: true, uncertain: sent });
  }

  /** Error text with the key, URLs and server names taken out. @param {string} text */
  _clean(text) {
    let out = String(text).slice(0, MAX_ERROR_BYTES);
    if (this.apiKey) out = out.split(this.apiKey).join("[redacted]");
    out = out.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/https?:\/\/[^\s<>"']+/gi, "[endpoint]")
      .replace(/\b(?:[A-Za-z0-9_-]+\.)+[A-Za-z0-9_-]+(?::\d+)?\b/g, "[server]")
      .replace(/[\x00-\x1f\x7f]/g, " ");
    return out.split(/\s+/).join(" ").trim().slice(0, MAX_ERROR_CHARS);
  }
}

/** Reads Chat Completions SSE events: text deltas, tool-call pieces (by index), usage, finish. */
class ChatStream {
  /**
   * @param {(text: string) => void} emit
   * @param {(calls: {name: string, chars: number, path: string}[]) => void} [onCalls] the tool calls so far, as
   *   pieces arrive (from gateways that stream them; others send each call whole, at the end)
   */
  constructor(emit, onCalls = () => {}) {
    /** @type {Map<number, string>} each call's path, once found */
    this.paths = new Map();
    this.emit = emit;
    this.onCalls = onCalls;
    this.text = "";
    this.reason = "";
    this.usage = {};
    /** @type {Map<number, {id: string, name: string, arguments: string, extra?: object}>} */
    this.calls = new Map();
  }

  /** One event's data. True once the stream is complete ([DONE] after a finish_reason). @param {string} data */
  event(data) {
    if (data.trim() === "[DONE]") {
      if (!this.reason) throw new GatewayError("The gateway ended its reply without saying it was finished.", { transient: true, uncertain: true });
      return true;
    }
    let value;
    try { value = parseJson(data); } catch {
      throw new GatewayError("The gateway sent a stream event Solder couldn't read.", { transient: true, uncertain: true });
    }
    if (value.error) throw new GatewayError("The gateway's stream failed.", { transient: true, uncertain: true });
    if (value.usage && typeof value.usage === "object") this.usage = value.usage;
    if (!Array.isArray(value.choices)) {
      if (value.usage) return false; // a usage-only chunk
      throw new GatewayError("The gateway's stream wasn't Chat Completions events.");
    }
    for (const choice of value.choices) {
      if ((choice.index ?? 0) !== 0) continue;
      const delta = choice.delta ?? {};
      const pieces = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (let position = 0; position < pieces.length; position++) {
        const piece = pieces[position];
        let index = Number.isInteger(piece.index) ? piece.index : position;
        const id = callId(piece);
        if (!Number.isInteger(piece.index) && id && this.calls.get(index)?.id && this.calls.get(index)?.id !== id) {
          index = Math.max(...this.calls.keys()) + 1; // a new call, not more of the one at this position
        }
        const entry = this.calls.get(index) ?? { id: "", name: "", arguments: "" };
        entry.id ||= callId(piece);
        entry.extra ??= callExtra(piece);
        const fn = piece.function ?? {};
        if (typeof fn.name === "string") entry.name += fn.name;
        if (typeof fn.arguments === "string") entry.arguments += fn.arguments;
        else if (fn.arguments && typeof fn.arguments === "object") entry.arguments = JSON.stringify(fn.arguments);
        this.calls.set(index, entry);
      }
      if (pieces.length) {
        this.onCalls([...this.calls.entries()].map(([index, call]) => ({ name: call.name, chars: call.arguments.length, path: this._pathOf(index, call) })));
      }
      for (const text of [delta.content, delta.refusal]) {
        if (typeof text === "string" && text) {
          if (this.reason) throw new GatewayError("The gateway sent text after finishing.");
          this.text += text;
          this.emit(text);
        }
      }
      if (typeof choice.finish_reason === "string" && choice.finish_reason) {
        let finish = choice.finish_reason;
        if (finish === "tool_calls" || finish === "function_call") {
          if (!this.calls.size) throw new GatewayError("The model sent a tool call Solder couldn't read.");
          finish = "stop";
        }
        if (this.reason && this.reason !== finish) throw new GatewayError("The gateway gave two different finish reasons.");
        this.reason = finish;
      }
    }
    return false;
  }

  /**
   * The file a call being written is about, for "Writing …": looked for near its start only (a call can be
   * megabytes, and arrive in thousands of pieces), before any "content" (whose text may hold a "path" of its own),
   * and kept once found. @param {number} index @param {any} call
   */
  _pathOf(index, call) {
    const known = this.paths.get(index);
    if (known) return known;
    const head = call.arguments.slice(0, PATH_LOOK_CHARS);
    const found = /"(?:path|to)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
    const content = head.indexOf('"content"');
    if (!found || (content !== -1 && content < found.index)) return "";
    const path = found[1].replace(/\\\\/g, "\\");
    this.paths.set(index, path);
    return path;
  }

  finish() {
    const calls = [...this.calls.keys()].sort((a, b) => a - b).map((index, n) => {
      const call = /** @type {any} */ (this.calls.get(index));
      // A call with no id still needs one: every tool result must answer its call by id.
      return { ...call, id: call.id || `call_${Date.now().toString(36)}_${n}`, name: call.name.trim() };
    });
    if (!this.text.trim() && !calls.length) {
      const why = this.reason === "length" ? " It ran out of room (the output limit)."
        : this.reason === "content_filter" ? " The gateway filtered it." : "";
      const error = new GatewayError("The model sent an empty reply." + why,
        { transient: this.reason !== "length" && this.reason !== "content_filter", uncertain: true });
      /** @type {any} */ (error).empty = true;
      /** @type {any} */ (error).usage = this.usage;
      throw error;
    }
    return { content: this.text, calls, finishReason: this.reason, usage: this.usage };
  }
}

/** UTF-8 server-sent events, LF / CRLF / CR, comments, multi-line data. Yields each event's data. */
class SseParser {
  /** @param {number} limit */
  constructor(limit) {
    this.limit = limit;
    this.decoder = new TextDecoder("utf-8", { fatal: true });
    this.buffer = "";
    /** @type {string[]} */
    this.data = [];
    this.size = 0;
    /** The last chunk ended in a CR: an LF starting the next one is the rest of that CRLF. */
    this.afterCr = false;
  }

  /** The stream ended: nothing is held back any more (a line without its end is dropped, as the spec says). */
  end() {
    return [];
  }

  /** @param {Buffer} chunk @returns {string[]} */
  push(chunk) {
    let text;
    try { text = this.decoder.decode(chunk, { stream: true }); } catch {
      throw new GatewayError("The gateway's stream wasn't valid UTF-8.");
    }
    if (this.afterCr && text.startsWith("\n")) text = text.slice(1);
    if (text) this.afterCr = false;
    this.buffer += text;
    /** @type {string[]} */
    const events = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      // A CR at the very end is a line end now (no waiting, so a bare-CR stream isn't held up a chunk);
      // if the next chunk starts with LF, that LF was its other half.
      if (match[0] === "\r" && !this.buffer) this.afterCr = true;
      if (!line) {
        if (this.data.length) events.push(this.data.join("\n"));
        this.data = [];
        this.size = 0;
        continue;
      }
      this.size += Buffer.byteLength(line) + 1;
      if (this.size > this.limit) throw new GatewayError("One of the gateway's stream events was too large.");
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") this.data.push(value);
    }
    if (Buffer.byteLength(this.buffer) + this.size > this.limit) {
      throw new GatewayError("One of the gateway's stream events was too large.");
    }
    return events;
  }
}

/** @param {string} value @param {string} label */
function checkedUrl(value, label) {
  let url;
  try { url = new URL(String(value ?? "").trim()); } catch { throw new GatewayError(`${label} isn't a valid address.`); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
    throw new GatewayError(`${label} must use https (http only for this PC).`);
  }
  if (url.username || url.password) throw new GatewayError(`${label} mustn't hold a user name or password.`);
  return url.toString();
}

/** @param {string} text */
function parseJson(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new GatewayError("The gateway sent something that wasn't JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GatewayError("The gateway sent something that wasn't a JSON object.");
  return value;
}

/** @param {unknown} raw @returns {number | null} */
function retryAfterMs(raw) {
  const text = String(Array.isArray(raw) ? raw[0] : raw ?? "").trim();
  if (!text || text.length > 128) return null;
  const seconds = Number(text);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(text);
  return Number.isNaN(when) ? null : Math.max(0, when - Date.now());
}

/** @param {import("node:http").IncomingMessage} res @param {number} limit @returns {Promise<string>} */
function collect(res, limit) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const parts = [];
    let size = 0;
    res.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) { res.destroy(); reject(new GatewayError("The gateway's answer was too large.")); return; }
      parts.push(chunk);
    });
    res.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    res.on("error", reject);
  });
}

/** A 429's words that mean the allowance is gone, not a moment's rush. */
const USED_UP_WORDS = /\b(credit limit|quota)\b/i;

/**
 * What a used-up message says about the allowance: "N/N credits used" and "reset … in 3h 12m".
 * @param {string} text @returns {{ limit?: number, resetSeconds?: number }}
 */
function toldAllowance(text) {
  /** @type {{ limit?: number, resetSeconds?: number }} */
  const told = {};
  const used = /(\d[\d,]*)\s*\/\s*(\d[\d,]*)\s*credits?\b/i.exec(text);
  if (used) { const limit = Number(used[2].replace(/,/g, "")); if (limit > 0) told.limit = limit; }
  const reset = /\breset[^.]*?\bin\s+(?:(\d+)\s*h(?:ours?|rs?)?\b)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?\b)?/i.exec(text);
  if (reset && (reset[1] || reset[2])) told.resetSeconds = (Number(reset[1] || 0) * 60 + Number(reset[2] || 0)) * 60;
  return told;
}

/** The time of day `seconds` from now, as "4:12 PM". @param {number} seconds */
function clock(seconds) {
  return new Date(Date.now() + seconds * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** @param {number} seconds */
function spoken(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes < 90 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${Math.round(minutes / 60)} hours`;
}

/** @param {number} ms @param {AbortSignal} [signal] */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Cancelled()); }, { once: true });
  });
}

module.exports = { GatewayClient, GatewayError, Cancelled, credits, NATIVE_MAX_TOKENS, TOOL_QUIET_MS };
