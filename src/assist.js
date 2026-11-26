// @ts-check
"use strict";
/**
 * The Assist lane's text protocol (see lanes.js): reading the tool requests an Assist model writes in its reply,
 * and rendering a stored chat as the plain user/assistant text such a model takes. Chats are stored the same way on
 * both lanes (native tool calls, one tool message per result), so everything else in Solder is unchanged: a reply's
 * requests are parsed into tool_calls before they're stored, and rendered back as tool blocks when sent.
 * The parser is ported from Alloy's, tuned on months of real replies. No vscode here: tested under node.
 */
const { TOOLS, TEXTS, RESULTS, ASSIST, assistText } = require("./prompt.js");

// ================================================================ finding requests in a reply

/** A fence: two or more backticks, a tag, then a newline (or straight into JSON). */
const FENCE = /`{2,}[ \t]*([A-Za-z0-9_+#.-]*)[ \t]*(?:\r?\n|(?=[{[]))/g;
/** Starts like a request: {"tool": …, {"name": …, and similar, maybe inside a list. */
const TOOLISH = /^\s*\[?\s*\{\s*['"\u201c\u201d]?(?:tool|tool_name|name|function|action|type)['"\u201c\u201d]?\s*:/i;
/** Nothing but a request starts like this, whatever its block's tag. */
const SURELY_TOOL = /^\s*\[?\s*\{\s*['"\u201c\u201d]?(?:tool|tool_name|function|action)['"\u201c\u201d]?\s*:/i;
const PLAIN_TAGS = new Set(["", "json", "json5", "jsonc", "js", "javascript"]);
const CLOSING_FENCE = /\n[ \t]*`{2,}[ \t]*(?=\n|$)/g;

/**
 * Every request in a reply, in order: {start, end, call, problem, tagged}.
 * - Blocks tagged tool… always count; a broken one gets a "send it again".
 * - So does any block, whatever its tag, that starts with {"tool": nothing but a request starts that way.
 * - Other plain or json blocks, and bare JSON ending the reply, count only when they really are a request for a
 *   known tool, so an answer that shows ordinary JSON (a package.json) is never taken for one.
 * - A block that can't be read, with more prose after it, is an example in an explanation: left as text. Unless the
 *   reply holds a request that can be read: then it's one of the reply's requests gone wrong, and is kept as that (left
 *   as text, it was dropped without a word, and so were the requests after it).
 * @param {string} text
 */
function findRequests(text) {
  /** @type {{start: number, call: any, problem: string, tagged: boolean}[]} */
  const found = [];
  // A fence inside a request already found (an example in a file it writes) is part of that request, never another.
  let inside = -1;
  for (const match of text.matchAll(FENCE)) {
    if (/** @type {number} */ (match.index) < inside) continue;
    const tag = match[1].toLowerCase();
    const body = text.slice(/** @type {number} */ (match.index) + match[0].length);
    if (tag.startsWith("tool") || SURELY_TOOL.test(body)) {
      found.push(...attempt(body).map((tried) => ({ start: /** @type {number} */ (match.index), ...tried, tagged: true })));
      inside = requestEnd(text, /** @type {number} */ (match.index));
    } else if (PLAIN_TAGS.has(tag) && TOOLISH.test(body)) {
      const tried = attempt(body);
      // A list whose first is a request: the rest are requests too (one that can't be used is said, not dropped).
      if (tried[0].call) { found.push(...tried.map((t, n) => ({ start: /** @type {number} */ (match.index), ...t, tagged: n > 0 }))); inside = requestEnd(text, /** @type {number} */ (match.index)); }
    }
  }
  if (!found.length) {
    const start = trailingStart(text); // unfenced JSON that ends the reply
    if (start !== null) {
      const tried = attempt(text.slice(start));
      if (tried[0].call) found.push(...tried.map((t, n) => ({ start, ...t, tagged: n > 0 })));
    }
  }
  if (!found.length) {
    // The fence forgotten: a line that starts a request.
    for (const match of text.matchAll(/(?:^|\n)[ \t]*(?=\[?\{)/g)) {
      const at = /** @type {number} */ (match.index) + match[0].length;
      if (SURELY_TOOL.test(text.slice(at))) { found.push(...attempt(text.slice(at)).map((tried) => ({ start: /** @type {number} */ (match.index), ...tried, tagged: true }))); break; }
    }
  }
  const spans = found.map((r) => [r.start, requestEnd(text, r.start)]);
  return found.map((r, n) => ({ ...r, end: spans[n][1] })).filter((r, n) => {
    if (r.call) return true;
    // Unreadable, among requests that can be read: a request that went wrong, not an example.
    if (r.tagged && found.some((other) => other.call)) return true;
    // Unreadable: kept (to ask again) only when no prose follows outside the other requests.
    let after = text.slice(spans[n][1]);
    for (const [s, e] of spans.filter(([s]) => s >= spans[n][1]).reverse()) {
      after = after.slice(0, s - spans[n][1]) + after.slice(e - spans[n][1]);
    }
    return !/[\p{L}]{3}/u.test(after);
  });
}

/** Where a request starting at `start` ends: after its closing fence, or after its JSON. @param {string} text @param {number} start */
function requestEnd(text, start) {
  const open = new RegExp(FENCE.source, "y");
  open.lastIndex = start;
  const fenced = open.exec(text);
  if (fenced) {
    // The closing fence after its JSON, not the first one: the JSON may hold a fenced example of its own.
    const from = start + fenced[0].length;
    const body = text.slice(from);
    let after = from;
    try { after = from + (body.length - body.trimStart().length) + balanced(body.trimStart()).length; } catch { /* unreadable: the first fence */ }
    const close = new RegExp(CLOSING_FENCE.source, "g");
    close.lastIndex = after;
    const found = close.exec(text);
    return found ? found.index + found[0].length : text.length;
  }
  const body = text.slice(start);
  const lead = body.length - body.trimStart().length;
  try { return start + lead + balanced(body.trimStart()).length; } catch { return text.length; }
}

/** Where an unfenced JSON request that ends the reply begins, or null. @param {string} text */
function trailingStart(text) {
  const tail = text.trimEnd().replace(/`+$/, "").trimEnd();
  if (!/[}\]]$/.test(tail)) return null;
  const opens = [...text.matchAll(/[{[]/g)].map((m) => /** @type {number} */ (m.index)).reverse();
  for (const at of opens) {
    if (!TOOLISH.test(text.slice(at))) continue;
    try {
      const block = balanced(text.slice(at));
      if (text.slice(at).trimEnd().replace(/`+$/, "").trimEnd() === block) return at;
    } catch { /* not this one */ }
  }
  return null;
}

/** The {...} or [...] text starts with, by bracket depth, quotes respected. Throws when unbalanced. @param {string} text */
function balanced(text) {
  let depth = 0, quote = "", escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === quote) quote = ""; }
    else if (c === '"') quote = c;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") { depth--; if (depth === 0) return text.slice(0, i + 1); }
  }
  throw new Error("unbalanced");
}

// ================================================================ reading one request leniently

/** @type {Record<string, string>} */
const SMART = { "\u201c": '"', "\u201d": '"', "\u2018": "'", "\u2019": "'" };

/**
 * JSON with the usual slips forgiven: raw newlines and tabs inside strings, \W-style escapes in Windows paths,
 * trailing commas, curly quotes. Returns the parsed value, or throws. @param {string} text
 */
function decode(text) {
  const body = balanced(text.trimStart());
  // Valid JSON is taken as it is: the forgiving passes below are only for what doesn't parse.
  try { return JSON.parse(body); } catch { /* forgive the usual slips */ }
  const straight = body.replace(/[\u201c\u201d\u2018\u2019]/g, (c) => SMART[c]);
  for (const candidate of [body, straight]) {
    for (const fixed of [candidate, invalidEscapes(candidate)]) {
      try { return JSON.parse(withoutTrailingCommas(rawControls(fixed))); } catch { /* next */ }
    }
  }
  throw new Error("not JSON");
}

/** Real newlines, tabs and carriage returns inside strings, escaped (JSON.parse rejects them; models write them). @param {string} text */
function rawControls(text) {
  let out = "", inString = false, escaped = false;
  for (const c of text) {
    if (inString) {
      if (escaped) { escaped = false; out += c; continue; }
      if (c === "\\") { escaped = true; out += c; continue; }
      if (c === '"') { inString = false; out += c; continue; }
      out += c === "\n" ? "\\n" : c === "\r" ? "\\r" : c === "\t" ? "\\t" : c;
    } else { if (c === '"') inString = true; out += c; }
  }
  return out;
}
/**
 * A backslash that isn't a JSON escape (C:\Users\W…), doubled. A valid escape is taken as a pair, so the second
 * backslash of an escaped one (\\) is never doubled on its own. @param {string} text
 */
const invalidEscapes = (text) => text.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})|\\/g, (pair, valid) => valid ? pair : "\\\\");
/** A comma right before a } or ], outside strings, left out (a ",]" inside a string is text). @param {string} text */
function withoutTrailingCommas(text) {
  let out = "", inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === ",") {
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next])) next++;
      if (text[next] === "}" || text[next] === "]") continue;
    }
    out += c;
  }
  return out;
}

/** Fields that hold a path: their \t and \n stay backslash-and-letter when salvaged (C:\temp\new). */
const PATH_FIELDS = new Set(["path", "from", "to"]);
/** Arguments that name files: no real path holds a tab, a line break or a backspace, so one there was a \t, \n… */
const PATH_ARGUMENTS = ["path", "from", "to", "glob"];
/** @type {Record<string, string>} */
const CONTROL_LETTERS = { "\t": "\\t", "\n": "\\n", "\r": "\\r", "\b": "\\b", "\f": "\\f" };
/**
 * A path written with single backslashes (src\tools\new.ps1) reads as JSON escapes: \t and \n became a tab and a line
 * break. In the arguments that name files they're put back as backslash and letter; text arguments are never touched.
 * @param {Record<string, any>} args changed in place @returns {Record<string, any>}
 */
function pathsAsWritten(args) {
  for (const arg of PATH_ARGUMENTS) {
    if (typeof args[arg] === "string") args[arg] = args[arg].replace(/[\t\n\r\b\f]/g, (c) => CONTROL_LETTERS[c]);
  }
  return args;
}
/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A request whose JSON is broken (most often an unescaped " inside a long content), read by its field names. Only the
 * named tool's own argument names split it, each once, so code inside content holding {"path": …} can't break it.
 * @param {string} text @returns {Record<string, any>} throws when it can't tell which tool
 */
function salvage(text) {
  let body = text.trimStart();
  if (!body.startsWith("{")) throw new Error("no object");
  // The closing fence: the last one right after a }, since content can hold code blocks of its own; but never past the
  // start of the reply's next request (that one is read, and run, on its own).
  const next = nextRequestAt(body);
  let closed = false;
  for (const f of [...body.matchAll(/\n[ \t]*`{2,}/g)].reverse()) {
    if (/** @type {number} */ (f.index) > next) continue;
    if (body.slice(0, f.index).trimEnd().endsWith("}")) { body = body.slice(0, f.index); closed = true; break; }
  }
  if (!closed && next < body.length) throw new Error("runs into the next request");
  const nameMatch = /[{,]\s*["']?(?:tool|tool_name|name|function|action)["']?\s*:\s*["']?([A-Za-z_-]+)/i.exec(body);
  const tool = nameMatch && canonical(nameMatch[1]);
  if (!tool || !Object.hasOwn(TOOLS, tool)) throw new Error("no tool");
  const names = ["tool", "tool_name", "name", "function", "action", "arguments", "args", "parameters",
    ...Object.keys(TOOLS[/** @type {keyof TOOLS} */ (tool)][1])];
  const field = new RegExp(`([{,])\\s*["']?(${names.map(escapeRe).join("|")})["']?\\s*:\\s*`, "gi");
  const seen = new Set();
  const fields = [...body.matchAll(field)].filter((m) => !seen.has(m[2].toLowerCase()) && seen.add(m[2].toLowerCase()));
  /** @type {Record<string, any>} */
  const data = {};
  fields.forEach((m, n) => {
    const from = /** @type {number} */ (m.index) + m[0].length;
    const to = n + 1 < fields.length ? /** @type {number} */ (fields[n + 1].index) : body.length;
    let value = body.slice(from, to).trim().replace(/,$/, "").trim();
    if (!value || value.startsWith("{")) return; // "arguments": { … }: its fields come next
    if (value[0] === '"' || value[0] === "'") {
      const inner = value.replace(/[}\]\s]+$/, "");
      const close = inner.lastIndexOf(value[0]);
      if (close <= 0) throw new Error(`'${m[2]}' has no closing quote`);
      value = inner.slice(1, close);
      value = PATH_FIELDS.has(m[2]) ? value.replace(/\\([\\"/])/g, "$1")
        : value.replace(/\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g, (_, e) => e[0] === "u" ? String.fromCharCode(parseInt(e.slice(1), 16))
          : /** @type {Record<string, string>} */ ({ '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" })[e]);
    } else {
      value = value.replace(/[}\]\s]+$/, "");
      try { value = JSON.parse(value); } catch { /* kept as text */ }
    }
    if (!(m[2] in data)) data[m[2]] = value;
  });
  return data;
}

/**
 * Where a block's text meets the next request: the closing fence that's followed (after any words) by a fence that opens
 * a request. The text's length when there's none. @param {string} body
 */
function nextRequestAt(body) {
  for (const close of body.matchAll(/\n[ \t]*`{2,}[ \t]*(?=\r?\n|$)/g)) {
    const open = new RegExp(FENCE.source, "g");
    open.lastIndex = /** @type {number} */ (close.index) + close[0].length;
    const m = open.exec(body);
    if (m && (m[1].toLowerCase().startsWith("tool") || SURELY_TOOL.test(body.slice(/** @type {number} */ (m.index) + m[0].length)))) {
      return /** @type {number} */ (close.index);
    }
  }
  return body.length;
}

// ================================================================ from a request to a call

const NAME_KEYS = ["tool", "tool_name", "name", "function", "action"];
const ARGUMENT_KEYS = ["arguments", "args", "parameters", "params", "input"];
/** Names models use for Solder's arguments. @type {Record<string, string[]>} */
const ALIASES = { path: ["file_path", "file", "filename", "filepath"], old_text: ["old", "old_string", "search"],
  new_text: ["new", "new_string", "replace", "replacement"], content: ["text", "contents", "data"],
  glob: ["pattern"], query: ["q", "text", "pattern"], from: ["source", "src"], to: ["destination", "dest", "target"] };
/** read_file, readFile and read-file are the same tool. @param {unknown} name */
const canonical = (name) => String(name).trim().replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[-\s]+/g, "_").toLowerCase();

/**
 * A block's request, or its requests when it holds a list of them (each in order, as if written one after another).
 * @param {string} text @returns {{call: {name: string, args: Record<string, any>, salvaged?: boolean} | null, problem: string, unknown?: string}[]}
 */
function attempt(text) {
  let value;
  try { value = decode(text); } catch { /* try salvage */ }
  if (value !== undefined) {
    return Array.isArray(value) && value.length ? value.map(toCall) : [toCall(value)];
  }
  try {
    const result = toCall(salvage(text));
    if (result.call) result.call.salvaged = true;
    return [result];
  } catch {
    return [{ call: null, problem: "the block didn't hold valid JSON; quotes and backslashes inside strings need escaping" }];
  }
}

/** @param {any} value @returns {{call: {name: string, args: Record<string, any>, salvaged?: boolean} | null, problem: string, unknown?: string}} */
function toCall(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { call: null, problem: "the request wasn't a JSON object" };
  if (value.function && typeof value.function === "object") value = value.function; // OpenAI style
  const key = NAME_KEYS.find((k) => typeof value[k] === "string");
  if (!key) return { call: null, problem: "it didn't say which tool to use" };
  const name = canonical(value[key]);
  if (!Object.hasOwn(TOOLS, name)) return { call: null, problem: `there's no tool called '${value[key]}'`, unknown: String(value[key]) };
  let args = ARGUMENT_KEYS.map((k) => value[k]).find((v) => v !== undefined && v !== "");
  if (typeof args === "string") { try { args = decode(args); } catch { args = undefined; } }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    args = Object.fromEntries(Object.entries(value).filter(([k]) => k !== key && k !== "type"));
  } else args = { ...args };
  const [, properties, required] = TOOLS[/** @type {keyof TOOLS} */ (name)];
  for (const arg of Object.keys(properties)) {
    if (arg in args) continue;
    const alias = (ALIASES[arg] || []).find((a) => a in args && !(a in properties));
    if (alias) { args[arg] = args[alias]; delete args[alias]; }
  }
  pathsAsWritten(args);
  for (const arg of /** @type {string[]} */ (required)) {
    if (args[arg] === undefined || args[arg] === null) return { call: null, problem: `${name} needs '${arg}'` };
  }
  return { call: { name, args }, problem: "" };
}

/**
 * A reply's requests: the readable ones before the first that can't be read (whose problem is returned), whether any
 * request was found, and the visible text (what comes before the first request).
 * @param {string} reply @param {{cutOff?: boolean}} [options] cut off at the length limit: a salvaged last call may be missing its end
 * @returns {{calls: {name: string, args: Record<string, any>, salvaged?: boolean}[], problem: string, unknown: string, found: boolean, visible: string, after: number}}
 *   after: how many requests came after the one that couldn't be read (none of them run: a later one may rely on it)
 */
function parseReply(reply, { cutOff = false } = {}) {
  const found = findRequests(String(reply || ""));
  /** @type {{name: string, args: Record<string, any>, salvaged?: boolean}[]} */
  const calls = [];
  let problem = "";
  let unknown = "";
  let after = 0;
  for (const [index, r] of found.entries()) {
    if (!r.call) { problem = r.problem || "it couldn't be read"; unknown = /** @type {any} */ (r).unknown || ""; after = found.length - index - 1; break; }
    calls.push(r.call);
  }
  // Cut off at the length limit: a last call that had to be pieced together may be missing its end, so it isn't run.
  // That's a request that couldn't be used, like any other: said, never dropped quietly.
  if (cutOff) {
    while (calls.length && calls[calls.length - 1].salvaged) {
      calls.pop();
      if (!problem) problem = "it was cut off before it ended";
      else after++;
    }
  }
  // The same tool with the same arguments twice (written twice) runs once.
  const seen = new Set();
  const unique = calls.filter((c) => {
    const k = c.name + stableJson(c.args); // every level kept (a replacer array would drop nested keys)
    return !seen.has(k) && seen.add(k);
  });
  const visible = found.length ? String(reply).slice(0, found[0].start).trimEnd() : String(reply || "");
  return { calls: unique, problem, unknown, found: found.length > 0, visible, after };
}

/** A reply that says it's done, not what it will do. */
const DONE_WORDS = /^(?:done|saved|updated|fixed|changed|renamed|added|removed|created)\b/i;
/** "I'll inspect…", "Let me first check…": what it says it will do next in the workspace. */
const WILL_ACT = /\b(?:i'll|i will|let me|i'm going to|i am going to|next i'll|now i'll)(?:\s+[\w-]+){0,3}?\s+(?:inspect|read|check|look|locate|find|search|open|edit|update|change|add|rename|fix|write|create|move|remove|apply|implement|make)\b/i;
/** Waiting on you (an offer, or something you're asked to do first), not a step it means to take now. */
const OFFER = /\b(?:if you|let me know|want me|would you|you'd like|happy to)\b/i;

/**
 * Whether an Assist reply with no request only says what it will do next ("I'll inspect `processOrders` first."): a
 * short reply, no question, no code, not a report of what's done, whose last sentence is a step in the workspace it
 * means to take. Such a reply ended the turn with nothing done. Kept narrow: an answer must never read as one.
 * @param {string} text the reply's visible text
 */
function promisesAction(text) {
  const s = String(text || "").replace(/[\u2018\u2019]/g, "'").trim();
  if (!s || s.length > 450 || s.includes("?") || s.includes("```") || DONE_WORDS.test(s.replace(/^[^\w]+/, ""))) return false;
  // Sentences end at . ! : ; or a line break, or run together ("first.I'll check") as some models write them.
  const last = s.split(/(?<=[.!:;])\s+|\n+|(?<=[.!])(?=[A-Z])/).map((part) => part.trim()).filter(Boolean).pop() || "";
  return WILL_ACT.test(last) && !OFFER.test(s);
}

/**
 * While a reply streams: only the words before a request (from the first ``` that opens a tool or json block, or a
 * line starting {"tool"; and a half-typed fence at the very end is held back too).
 * @param {string} text @param {boolean} [streaming]
 */
function visibleText(text, streaming = false) {
  const s = String(text || "");
  const fence = /`{2,}[ \t]*(?:tool|json|jsonc|json5)?[ \t]*(?:\r?\n|$|(?=[{[]))/i.exec(s);
  const bare = /(?:^|\n)[ \t]*\{\s*["']?(?:tool|tool_name)["']?\s*:/i.exec(s);
  const cuts = [fence ? (/`{2,}[ \t]*(?:tool|json)/i.test(fence[0]) || /\{|\[/.test(s.slice(fence.index + fence[0].length, fence.index + fence[0].length + 2)) ? fence.index : -1) : -1,
    bare ? bare.index : -1].filter((n) => n >= 0);
  let out = cuts.length ? s.slice(0, Math.min(...cuts)) : s;
  if (streaming) out = out.replace(/`{1,3}$/, "");
  return cuts.length ? out.trimEnd() : out;
}

/**
 * While a reply streams: the tool requests written so far, as the Tool lane reports calls being written (the tool, how
 * much of it there is, the file it's about), for the panel's "Writing … so far". The last one may still be coming.
 * A reply's requests aren't shown as they're written, so without this a long write looked like nothing was happening.
 * @param {string} text @returns {{name: string, chars: number, path: string}[]}
 */
function draftingRequests(text) {
  const s = String(text || "");
  /** @type {{name: string, chars: number, path: string}[]} */
  const out = [];
  let inside = -1;
  for (const match of s.matchAll(FENCE)) {
    const start = /** @type {number} */ (match.index);
    if (start < inside) continue;
    const from = start + match[0].length;
    const body = s.slice(from, from + 600);
    if (!(match[1].toLowerCase().startsWith("tool") || SURELY_TOOL.test(body))) continue;
    inside = requestEnd(s, start);
    const name = /["'“”]?(?:tool|tool_name|name|function|action)["'“”]?\s*:\s*["'“”]?([A-Za-z_-]+)/.exec(body)?.[1] || "";
    // The file it's about, when that's said before any long text (which may hold a "path" of its own).
    const long = body.search(/"(?:content|new_text|old_text)"\s*:/);
    const found = /"(?:path|file_path|file|to)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body);
    const file = found && (long === -1 || found.index < long) ? found[1].replace(/\\\\/g, "\\") : "";
    out.push({ name: canonical(name), chars: inside - from, path: file });
  }
  return out;
}

// ================================================================ rendering a stored chat as Assist turns

/** The longest run of backticks in text, plus one (at least three), so output can't close its own fence. @param {string} text */
function fence(text) {
  const longest = Math.max(0, ...(String(text).match(/`+/g) || []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * One result, as Alloy has worded them on Assist models.
 * @param {string} label e.g. "read_file src/app.js" @param {string} output @param {boolean} failed @param {boolean} closing
 */
function resultMessage(label, output, failed, closing) {
  const f = fence(output);
  const lead = failed ? ASSIST.resultFailed(label) : ASSIST.resultOk(label);
  // Only the line breaks at its end go: spaces or a tab at the end of its last line are the file's, and an edit that
  // copies that line needs them.
  return `${lead}\n\n${f}\n${String(output).replace(/[\r\n]+$/, "")}\n${f}` + (closing ? `\n\n${ASSIST.resultClosing}` : "");
}

/** Stands in for a text's variable part (a file, your note) while Solder's own lines are worked out. */
const MARK = "\u0001";
/** The phrases ASSIST.swaps puts in first person. */
const SWAP_FROMS = ASSIST.swaps.map(([from]) => from);

/**
 * Solder's own lines that say "the user", each as the pattern of a whole line: every text in TEXTS and RESULTS that
 * holds a phrase ASSIST.swaps turns into first person, line by line, with its variable parts (a file, your note) left
 * open. A line counts only whole, with nothing before it but "Error: " (a tool's error) or, for a note in brackets, the
 * place it's about ("src/a.js 12 (…)"): a file's lines come numbered, search hits after their place, so a line of a
 * file that quotes Solder's words is never taken for Solder speaking.
 */
const OWN_LINES = (() => {
  /** @type {string[]} */
  const texts = [];
  for (const group of [TEXTS, RESULTS]) {
    for (const value of Object.values(group)) {
      if (typeof value === "string") texts.push(value);
      else if (typeof value === "function") {
        try { texts.push(String(value(...Array.from({ length: Math.max(1, value.length) }, () => MARK)))); } catch { /* it takes no text there */ }
      }
    }
  }
  const lines = new Set(texts.flatMap((text) => text.split("\n")).filter((line) => SWAP_FROMS.some((from) => line.includes(from))));
  return [...lines].map((line) => {
    const parts = line.split(MARK);
    const lead = line.startsWith("(") ? "(Error: |[^\\t\\n]* \\d+ )?" : "(Error: )?";
    return { parts, pattern: new RegExp(`^${lead}${parts.map(escapeRe).join("([^\\n]*?)")}$`) };
  });
})();

/**
 * A tool message's text as the Assist lane sends it: Solder's own lines in first person ("I declined this."), and
 * everything else exactly as it came (a file's text, search hits, a diff, another program's error, your own words). The
 * whole text used to be rewritten, so a file that quoted one of those phrases reached the model changed, and an edit
 * copying the line missed. @param {string} text
 */
function assistResult(text) {
  const s = String(text);
  if (!SWAP_FROMS.some((from) => s.includes(from))) return s;
  return s.split("\n").map((line) => {
    if (!SWAP_FROMS.some((from) => line.includes(from))) return line;
    for (const own of OWN_LINES) {
      const m = own.pattern.exec(line);
      if (m) return (m[1] || "") + own.parts.map((part, n) => assistText(part) + (n < own.parts.length - 1 ? m[n + 2] : "")).join("");
    }
    return line;
  }).join("\n");
}

/** Earlier turns' write and edit texts longer than this are left out of what's sent. */
const LONG_ARGUMENT_CHARS = 1_500;
/** Arguments a write or edit no longer needs in full (they're in the file). */
const LONG_ARGUMENTS = { write_file: ["content"], edit_file: ["old_text", "new_text"] };

/**
 * A call from an earlier task without its long text arguments. They're left out whole, never replaced by a note: a
 * note in a call's arguments reads to the model as something it wrote, and it wrote the same again as the text of a
 * new edit (which went into the user's file). A call copied from one of these lacks a required argument, so it's
 * refused before anything runs. What's said about it goes with the call's result instead (TEXTS.argumentsLeftOut).
 * @param {any} call
 */
function shortCall(call) {
  const fields = LONG_ARGUMENTS[/** @type {keyof LONG_ARGUMENTS} */ (call.function?.name)];
  if (!fields || (call.function.arguments || "").length <= LONG_ARGUMENT_CHARS) return call;
  let args;
  try { args = JSON.parse(call.function.arguments); } catch { return call; }
  if (!args || typeof args !== "object") return call;
  let changed = false;
  for (const field of fields) {
    if (typeof args[field] === "string" && args[field].length > LONG_ARGUMENT_CHARS) {
      delete args[field];
      changed = true;
    }
  }
  return changed ? { ...call, function: { ...call.function, arguments: JSON.stringify(args) } } : call;
}

/** A stored tool call as the ```tool block the model would have written. @param {any} call */
function requestBlock(call) {
  /** @type {Record<string, any>} */
  let args = {};
  try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* shown as it was */ }
  return "```tool\n" + JSON.stringify({ tool: call.function.name, ...args }) + "\n```";
}

/**
 * @typedef {{role: "user" | "assistant", content: string, index: number, must?: boolean, short?: string, reduced?: string, keeps?: string[]}} Piece
 *   One stored message (a batch of results: one piece), as the Assist lane sends it. index: its place in the chat (-1:
 *   the recap). must: it stays in any carry-over (the recap, the request being worked on and what followed it from you).
 *   short: shorter, for an earlier turn (long write and edit texts left out, long results a stand-in). reduced: a batch
 *   cut to what it holds to keep (a skill, a folder's AGENTS.md, your note or message), each with its result's stand-in;
 *   keeps: those results' call ids.
 */

/** Earlier turns' results longer than this are a stand-in in a carry-over that's too long (as the Tool lane cuts them). */
const STUB_MIN_CHARS = 2_000;

/**
 * The stored chat as Assist pieces, in order.
 * @param {any} chat @param {(message: any, earlier?: boolean) => string} resultText a tool message as the model gets it
 *   (stand-ins for trimmed ones; earlier: from an earlier task) @param {number} current where the task in progress starts:
 *   messages before it are earlier turns @param {number} [from] the first message (0: the whole chat, after any recap)
 * @returns {Piece[]}
 */
function carryPieces(chat, resultText, current, from = 0) {
  /** @type {Piece[]} */
  const pieces = [];
  let start = from;
  if (chat.compaction && from <= chat.compaction.through) {
    pieces.push({ role: "user", content: TEXTS.compaction, index: -1, must: true }, { role: "assistant", content: chat.compaction.summary, index: -1, must: true });
    start = chat.compaction.through;
  }
  const messages = chat.messages;
  /** @type {Set<string>} calls whose long text an earlier turn's shorter form leaves out: their results say so */
  const shortened = new Set();
  for (let i = start; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user") {
      pieces.push({ role: "user", content: m.meta?.sent ?? m.content, index: i, must: i >= current });
    } else if (m.role === "assistant") {
      // The model's own words as it wrote them; a Tool-lane reply is shown with its calls as tool blocks.
      const text = m.meta?.raw ?? [m.content, ...(m.tool_calls || []).map(requestBlock)].filter(Boolean).join("\n\n");
      if (!String(text).trim()) continue;
      /** @type {Piece} */
      const piece = { role: "assistant", content: text, index: i };
      if (i < current && m.tool_calls?.length) {
        const calls = m.tool_calls.map((/** @type {any} */ call) => shortCall(call));
        calls.forEach((/** @type {any} */ call, /** @type {number} */ n) => { if (call !== m.tool_calls[n]) shortened.add(call.id); });
        if (calls.some((/** @type {any} */ call, /** @type {number} */ n) => call !== m.tool_calls[n])) piece.short = [m.content, ...calls.map(requestBlock)].filter(Boolean).join("\n\n");
      }
      pieces.push(piece);
    } else if (m.role === "tool") {
      // Every tool message in a row is one batch: one user message, the closing line on the last result only.
      const at = i;
      const batch = [];
      while (i < messages.length && messages[i].role === "tool") batch.push(messages[i++]);
      i--;
      // Requests of the same reply that couldn't be used are said after the results, in place of the closing line.
      const unread = batch[batch.length - 1].meta?.unread;
      const label = (/** @type {any} */ t) => t.meta?.label || t.meta?.name || "that request";
      const one = (/** @type {any} */ t, /** @type {string} */ text, /** @type {boolean} */ closing) => resultMessage(label(t), assistResult(text), !!t.meta?.failed, closing);
      const all = (/** @type {string[]} */ texts) => {
        const body = batch.map((t, n) => one(t, texts[n], n === batch.length - 1 && !unread)).join("\n\n");
        return unread ? `${body}\n\n${unread}` : body;
      };
      /** @type {Piece} */
      const piece = { role: "user", content: all(batch.map((t) => resultText(t))), index: at };
      if (at < current) {
        const short = all(batch.map((t) => {
          const left = shortened.has(t.tool_call_id) ? "\n\n" + TEXTS.argumentsLeftOut : "";
          if (t.meta?.stub || String(t.content).length <= STUB_MIN_CHARS) return resultText(t, true) + left;
          return TEXTS.stub(t.meta?.summary || label(t)) + (t.meta?.keep ? "\n\n" + t.meta.keep : "") + left;
        }));
        if (short !== piece.content) piece.short = short;
      }
      const kept = batch.filter((t) => t.meta?.keep);
      if (kept.length) {
        piece.keeps = kept.map((t) => t.tool_call_id);
        piece.reduced = kept.map((t) => one(t, TEXTS.stub(t.meta?.summary || label(t)) + "\n\n" + t.meta.keep, false)).join("\n\n");
      }
      pieces.push(piece);
    }
  }
  return pieces;
}

/**
 * The stored chat as Assist turns: user and assistant text only. A batch's tool messages become one user message.
 * @param {any} chat @param {(message: any, earlier?: boolean) => string} resultText a tool message as the model gets it (stand-ins for trimmed ones)
 * @param {number} [from] the first message to render (0: the whole chat, after any recap)
 * @returns {{role: "user" | "assistant", content: string}[]}
 */
function assistOutbound(chat, resultText, from = 0) {
  // Two user messages in a row (a typed message right after results, a resume note): joined, as a turn can't be
  // answered twice and the conversation goes user, assistant, user…
  return carryPieces(chat, resultText, 0, from).reduce((acc, m) => {
    const last = acc[acc.length - 1];
    if (last && last.role === "user" && m.role === "user") last.content += "\n\n" + m.content;
    else acc.push({ role: m.role, content: m.content });
    return acc;
  }, /** @type {{role: "user" | "assistant", content: string}[]} */ ([]));
}

/** Where the task in progress starts: the latest message you typed (a "carry on" belongs to the task before). @param {any} chat */
function taskStartOf(chat) {
  for (let index = chat.messages.length - 1; index >= 0; index--) {
    if (chat.messages[index].role === "user" && !chat.messages[index].meta?.resume) return index;
  }
  return 0;
}

// ================================================================ carrying a conversation over

/** A message that went out with the introduction or a setup note, without it (a carry-over says the setup once). @param {string} text */
function stripSetup(text) {
  const s = String(text);
  const at = s.indexOf(ASSIST.messageLead);
  if (s.startsWith(ASSIST.lead) && at >= 0) return s.slice(at + ASSIST.messageLead.length).replace(/^\s+/, "");
  if (s.startsWith(ASSIST.setupChangedLead)) {
    // The note ends ")" then a blank line, but so may a line of the setup it holds (your rules, AGENTS.md): the message
    // after it starts with its date and time, so the end that's followed by one is the note's. Else the first, as before.
    let end = -1;
    for (let at = s.indexOf(")\n\n"); at >= 0; at = s.indexOf(")\n\n", at + 1)) {
      if (end < 0) end = at;
      if (DATED.test(s.slice(at + 3, at + 64))) { end = at; break; }
    }
    if (end >= 0) return s.slice(end + 3);
  }
  return s;
}

/** How each of your messages starts: "(Wednesday, 4 November 2026, 14:05)" (prompt.js timeNote). */
const DATED = /^\([A-Z][a-z]+day, \d{1,2} [A-Z][a-z]+ \d{4}, \d{2}:\d{2}\)/;

/**
 * When the gateway doesn't hold the conversation (a switch from the Tool lane, a fork, compaction, a session that
 * ended, another Assist model, or no sessions at all): one user message with my setup, the conversation so far and
 * the newest message. When it's too long, earlier turns are shortened, then the oldest messages are left out (not those
 * that must stay), and where and how many is said (carryFit).
 * @param {string} setup ASSIST.setup(context) @param {{role: string, content: string}[]} rendered carryPieces(chat), or assistOutbound(chat)
 * @param {number} budget characters
 */
function carryOver(setup, rendered, budget) {
  return carryText(setup, carryFit(setup, rendered, budget));
}

/** The carry-over message, from how the conversation fits. @param {string} setup @param {ReturnType<typeof carryFit>} fit */
function carryText(setup, fit) {
  if (!fit.any) return [setup, ASSIST.messageLead, fit.newest].join("\n\n");
  return [setup, ASSIST.carryOverLead, ...fit.entries, ASSIST.carryOverEnd, fit.newest].join("\n\n");
}

// ================================================================ sessions: what goes out, and what the gateway holds

const crypto = require("node:crypto");

/** What the gateway saw of a stored message (the Assist rendering's inputs), as one line. @param {any} m */
function canonicalOf(m) {
  return JSON.stringify([m.role, m.role === "user" ? (m.meta?.sent ?? m.content) : m.role === "assistant" ? (m.meta?.raw ?? m.content) : m.content,
    m.tool_call_id || "", (m.tool_calls || []).map((/** @type {any} */ c) => [c.id, c.function.name, c.function.arguments])]);
}
/** @param {string} text */
const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
/** A fingerprint for the log: never the session id or token itself. @param {string} text */
const fp = (text) => sha(String(text || "")).slice(0, 8);

/** The first `count` stored messages, as one hash: any rewrite of them (compaction, a fork, a Tool-lane reply) shows. @param {any[]} messages @param {number} count */
function prefixHash(messages, count) {
  const hash = crypto.createHash("sha256");
  for (let i = 0; i < count; i++) hash.update(canonicalOf(messages[i]) + "\n");
  return hash.digest("hex");
}

/**
 * Whether this model's session still holds the chat as stored, up to where it last answered: the same model, not lost,
 * nothing it saw rewritten (compaction, an edited or removed message), and no finished reply since that the gateway
 * never saw (the Tool lane answered in between). A partial one (a reply that failed partway) doesn't count: it's left
 * out of what's sent. Whether sessions are on at all is for the caller. @param {any} chat @param {string} model
 */
function sessionHolds(chat, model) {
  const record = chat.assist;
  if (!record?.fields || record.lost || record.model !== model || !(record.held <= chat.messages.length)) return false;
  if (prefixHash(chat.messages, record.held) !== record.heldHash) return false;
  return !chat.messages.slice(record.held).some((/** @type {any} */ m) => m.role === "assistant" && !m.meta?.incomplete);
}

/**
 * How an Assist request goes, for the chat as stored (ending with something to answer: your message, or results).
 * - "stateful": the gateway's session holds everything before the new user-side messages: only those go, as one.
 * - "fresh": nothing came before: the introduction and the message, with no session (one comes back).
 * - "carry_over": there's history the gateway doesn't hold (a switch from the Tool lane, a fork, compaction, a
 *   session that ended, another Assist model, or no sessions configured): all of it goes in one user message.
 * @param {any} chat @param {string} model @param {{assistSessionBlock?: string, compactAt: number}} settings
 * @param {any} context the setup's facts (workspace, instructions, rules, docs) @param {(message: any, earlier?: boolean) => string} resultText
 * @returns {{kind: "stateful" | "fresh" | "carry_over", messages: {role: "user", content: string}[], session: {block: string, fields: Record<string, string>} | null, setup: string, single: any,
 *   left?: number, leftOut?: string[]}} left, leftOut: a carry-over's (carryFit)
 */
function sessionPlan(chat, model, settings, context, resultText) {
  const record = chat.assist;
  const block = String(settings.assistSessionBlock || "").trim();
  const setup = ASSIST.setup(context);
  const told = sha(setup);
  if (block && sessionHolds(chat, model)) {
    const after = chat.messages.slice(record.held);
    // Only what's new goes: a partial reply (one that failed partway) is left out.
    if (after.some((/** @type {any} */ m) => m.role !== "assistant")) {
      const fresh = { ...chat, compaction: null, messages: after.filter((/** @type {any} */ m) => m.role !== "assistant") };
      let text = assistOutbound(fresh, resultText).filter((m) => m.role === "user").map((m) => m.content).join("\n\n");
      if (record.told !== told) text = ASSIST.setupChanged(setup) + "\n\n" + text;
      const users = fresh.messages.filter((/** @type {any} */ m) => m.role === "user");
      return { kind: "stateful", messages: [{ role: "user", content: text }], session: { block, fields: record.fields }, setup,
        single: users.length === 1 && fresh.messages.length === 1 ? users[0] : null };
    }
  }
  const rendered = assistOutbound(chat, resultText);
  if (rendered.length === 1 && !chat.compaction && rendered[0].role === "user") {
    const only = chat.messages.filter((/** @type {any} */ m) => m.role === "user");
    const content = rendered[0].content.startsWith(ASSIST.lead) ? rendered[0].content : setup + "\n\n" + ASSIST.messageLead + "\n\n" + rendered[0].content;
    return { kind: "fresh", messages: [{ role: "user", content }], session: null, setup, single: only.length === 1 ? only[0] : null };
  }
  const fit = carryFit(setup, carryPieces(chat, resultText, taskStartOf(chat)), carryBudget(settings));
  return { kind: "carry_over", messages: [{ role: "user", content: carryText(setup, fit) }], session: null, setup, single: null, left: fit.left, leftOut: fit.leftOut };
}

/**
 * How a conversation fits a carry-over. The newest messages from you (the last pieces, your message or results) always
 * go. When the whole is over the budget: first earlier turns are shortened, oldest first (their long write and edit
 * texts left out, as the Tool lane leaves them out, and long results a stand-in); then the oldest messages are left out,
 * but never one that must stay (the recap, the request being worked on and what you said after it), and a batch that
 * holds something to keep (a skill, a folder's AGENTS.md, your note or message) keeps that with its result's stand-in;
 * last, if that's still too long, those kept texts go too, oldest first, and leftOut names their results (a skill left
 * out can then be read again). It used to keep the newest messages that fit in a row, so a task's long results could
 * push out the request itself, while room shortening would have made went unused.
 * @param {string} setup @param {{role: string, content: string, index?: number, must?: boolean, short?: string, reduced?: string, keeps?: string[]}[]} rendered
 *   carryPieces(chat), or assistOutbound(chat) (nothing marked: the oldest simply go first) @param {number} budget characters
 * @returns {{entries: string[], newest: string, any: boolean, left: number, chars: number, first: boolean, leftOut: string[]}}
 *   entries: the conversation as written out, notes of what's left out in their places; any: there's a conversation
 *   before the newest; left: how many messages are left out or cut to what they keep; chars: how long the whole would
 *   be; first: the chat's first message is among those left out
 */
function carryFit(setup, rendered, budget) {
  let cut = rendered.length;
  while (cut > 0 && rendered[cut - 1].role === "user") cut--;
  const newest = stripSetup(rendered.slice(cut).map((m) => m.content).join("\n\n"));
  const history = rendered.slice(0, cut);
  /** @typedef {"full" | "short" | "reduced" | "out"} Mode */
  const textOf = (/** @type {any} */ m, /** @type {Mode} */ mode) =>
    mode === "out" ? "" : stripSetup(mode === "short" ? m.short ?? m.content : mode === "reduced" ? m.reduced : m.content).trim();
  const sizeOf = (/** @type {any} */ m, /** @type {Mode} */ mode) => mode === "out" ? 0 : textOf(m, mode).length + 6; // "Me:\n", the blank line after
  /** @type {Mode[]} */
  const modes = history.map(() => "full");
  const sizes = history.map((m) => sizeOf(m, "full"));
  const base = setup.length + ASSIST.carryOverLead.length + ASSIST.carryOverEnd.length + newest.length + 200;
  let used = base + sizes.reduce((sum, size) => sum + size, 0);
  const chars = used;
  const note = ASSIST.carryOverLeftOut(1000).length + 2;
  const over = () => used + modes.filter((mode, i) => mode === "out" && modes[i - 1] !== "out").length * note > budget;
  const set = (/** @type {number} */ i, /** @type {Mode} */ mode) => {
    const size = sizeOf(history[i], mode);
    used += size - sizes[i];
    sizes[i] = size;
    modes[i] = mode;
  };
  for (let i = 0; i < history.length && over(); i++) if (history[i].short !== undefined) set(i, "short");
  for (let i = 0; i < history.length && over(); i++) if (!history[i].must) set(i, history[i].reduced ? "reduced" : "out");
  /** @type {string[]} */
  const leftOut = [];
  for (let i = 0; i < history.length && over(); i++) {
    if (modes[i] === "reduced") { set(i, "out"); leftOut.push(...(history[i].keeps || [])); }
  }
  /** @type {string[]} */
  const entries = [];
  let run = 0;
  let joinable = false;
  history.forEach((m, i) => {
    if (modes[i] === "out") { run++; joinable = false; return; }
    if (run) { entries.push(ASSIST.carryOverLeftOut(run)); run = 0; }
    const text = textOf(m, modes[i]);
    // Your messages in a row are one turn, as assistOutbound joins them.
    if (joinable && m.role === "user") entries[entries.length - 1] += "\n\n" + text;
    else entries.push((m.role === "user" ? "Me" : "You") + ":\n" + text);
    joinable = m.role === "user";
  });
  if (run) entries.push(ASSIST.carryOverLeftOut(run));
  const left = modes.filter((mode) => mode === "out" || mode === "reduced").length;
  const first = history.some((m, i) => (m.index ?? i) === 0 && modes[i] === "out");
  return { entries, newest, any: history.length > 0, left, chars, first, leftOut };
}

/**
 * Whether a chat would lose its start if it went to this Assist model now: the conversation as it would be carried
 * over (a session belongs to the model that holds it, so another model starts with nothing), against the carry-over
 * budget. Null when nothing would be left out: it fits, or that model's session already holds the chat.
 * @param {any} chat @param {string} model @param {{assistSessionBlock?: string, assistCarryTokens?: number}} settings
 * @param {any} context the setup's facts @param {(message: any) => string} resultText
 * @returns {{tokens: number, budget: number, left: number, first: boolean} | null} first: the chat's first message is
 *   among those left out (no summary stands in for it)
 */
function wouldLeaveOut(chat, model, settings, context, resultText) {
  if (String(settings.assistSessionBlock || "").trim() && sessionHolds(chat, model)) return null;
  // What would go, as sessionPlan would carry it over: the conversation (all of it earlier turns by then), then your next
  // message (not typed yet: it's the small part).
  const pieces = [...carryPieces(chat, resultText, chat.messages.length), { role: "user", content: "", index: chat.messages.length, must: true }];
  if (pieces.length < 2) return null;
  const budget = carryBudget(/** @type {any} */ (settings));
  const fit = carryFit(ASSIST.setup(context), pieces, budget);
  if (!fit.left) return null;
  return { tokens: Math.ceil(fit.chars / 4), budget: Math.floor(budget / 4), left: fit.left, first: !chat.compaction && fit.first };
}

/** What a carry-over holds when the setting doesn't say: tokens, at about four characters each. */
const CARRY_TOKENS = 200_000;

/**
 * How much of the conversation a carry-over takes, in characters: the Assist carry-over setting (in tokens, at about
 * four characters each). It follows what the Assist models can hold, not Compact at, which is about what Tool models
 * cost. @param {{assistCarryTokens?: number}} settings
 */
function carryBudget(settings) {
  const tokens = Number(settings.assistCarryTokens);
  return Math.floor((Number.isFinite(tokens) && tokens >= 1 ? tokens : CARRY_TOKENS) * 4);
}

/**
 * After a reply: the session it came back with (or the one it continued) now holds everything stored so far, the
 * reply included. Returns what happened, for the log (fingerprints and ages only).
 * @param {any} chat @param {string} model @param {{kind: string, setup: string}} plan @param {{session?: {fields: Record<string, string>} | null}} reply
 * @param {(fields: Record<string, string>) => string} sessionId @returns {string}
 */
function holdSession(chat, model, plan, reply, sessionId) {
  const old = chat.assist || {};
  const now = Date.now();
  const held = { held: chat.messages.length, heldHash: prefixHash(chat.messages, chat.messages.length), told: sha(plan.setup), usedAt: now, model };
  // The results whose kept text (a skill) a carry-over left out: the model hasn't got them, so reading one again isn't
  // "already in this chat". A session that carries on keeps the list of the carry-over it started from.
  /** @type {string[]} */
  const leftOut = plan.kind === "carry_over" ? (/** @type {any} */ (plan).leftOut || []) : plan.kind === "stateful" ? (old.leftOut || []) : [];
  const keep = leftOut.length ? { leftOut } : {};
  if (!reply.session) {
    // No session in the answer: the one sent still holds it (stateful), or there's none (fresh, carry-over).
    if (plan.kind === "stateful") { chat.assist = { ...old, ...held }; return `continued ${fp(sessionId(old.fields || {}))}`; }
    chat.assist = { lost: true, why: "none", since: now, ...keep };
    return "no session";
  }
  const id = sessionId(reply.session.fields);
  const same = !!old.fields && sessionId(old.fields) === id;
  chat.assist = { fields: reply.session.fields, startedAt: same ? old.startedAt : now, ...held, ...keep };
  if (plan.kind === "stateful" && !same) return `replaced ${fp(sessionId(old.fields || {}))} by ${fp(id)} after ${Math.round((now - (old.startedAt || now)) / 60000)} min`;
  return same ? `continued ${fp(id)}, ${Math.round((now - (old.startedAt || now)) / 60000)} min old` : `started ${fp(id)} (${plan.kind})`;
}

/**
 * A request sent in the session whose reply was cut off partway (the cut reply is stored at `count`): the session was
 * sent everything before it, so it holds that, and a carry-on sends only what's new. It used to send the results the
 * session already had again. @param {any} chat @param {{kind: string, setup: string}} plan @param {number} count
 */
function heldThroughCut(chat, plan, count) {
  const record = chat.assist;
  if (plan.kind !== "stateful" || !record?.fields || record.lost) return;
  chat.assist = { ...record, held: count, heldHash: prefixHash(chat.messages, count), told: sha(plan.setup), usedAt: Date.now() };
}

/** JSON with object keys in order at every level, to tell two requests apart. @param {any} value @returns {string} */
function stableJson(value) {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stableJson(value[key])).join(",") + "}";
  return JSON.stringify(value);
}

module.exports = { findRequests, parseReply, promisesAction, visibleText, draftingRequests, ALIASES, decode, salvage, pathsAsWritten, canonical, fence, resultMessage, requestBlock,
  assistOutbound, carryPieces, carryOver, carryFit, wouldLeaveOut, stripSetup, sessionPlan, holdSession, heldThroughCut, prefixHash, canonicalOf, carryBudget, fp,
  assistResult, shortCall, LONG_ARGUMENT_CHARS };
