// @ts-check
"use strict";
/**
 * The Assist lane's text protocol (see lanes.js): reading the tool requests an Assist model writes in its reply,
 * and rendering a stored chat as the plain user/assistant text such a model takes. Chats are stored the same way on
 * both lanes (native tool calls, one tool message per result), so everything else in Solder is unchanged: a reply's
 * requests are parsed into tool_calls before they're stored, and rendered back as tool blocks when sent.
 * The parser is ported from Alloy's, tuned on months of real replies. No vscode here: tested under node.
 */
const { TOOLS, TEXTS, ASSIST, assistText } = require("./prompt.js");

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
 * - A block that can't be read, with more prose after it, is an example in an explanation: left as text.
 * @param {string} text
 */
function findRequests(text) {
  /** @type {{start: number, call: any, problem: string, tagged: boolean}[]} */
  const found = [];
  for (const match of text.matchAll(FENCE)) {
    const tag = match[1].toLowerCase();
    const body = text.slice(/** @type {number} */ (match.index) + match[0].length);
    if (tag.startsWith("tool") || SURELY_TOOL.test(body)) {
      found.push({ start: /** @type {number} */ (match.index), ...attempt(body), tagged: true });
    } else if (PLAIN_TAGS.has(tag) && TOOLISH.test(body)) {
      const tried = attempt(body);
      if (tried.call) found.push({ start: /** @type {number} */ (match.index), ...tried, tagged: false });
    }
  }
  if (!found.length) {
    const start = trailingStart(text); // unfenced JSON that ends the reply
    if (start !== null) {
      const tried = attempt(text.slice(start));
      if (tried.call) found.push({ start, ...tried, tagged: false });
    }
  }
  if (!found.length) {
    // The fence forgotten: a line that starts a request.
    for (const match of text.matchAll(/(?:^|\n)[ \t]*(?=\[?\{)/g)) {
      const at = /** @type {number} */ (match.index) + match[0].length;
      if (SURELY_TOOL.test(text.slice(at))) { found.push({ start: /** @type {number} */ (match.index), ...attempt(text.slice(at)), tagged: true }); break; }
    }
  }
  const spans = found.map((r) => [r.start, requestEnd(text, r.start)]);
  return found.map((r, n) => ({ ...r, end: spans[n][1] })).filter((r, n) => {
    if (r.call) return true;
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
    const close = new RegExp(CLOSING_FENCE.source, "g");
    close.lastIndex = start + fenced[0].length;
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
/** A backslash that isn't a JSON escape (C:\Users\W…), doubled. @param {string} text */
const invalidEscapes = (text) => text.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
/** @param {string} text */
const withoutTrailingCommas = (text) => text.replace(/,(\s*[}\]])/g, "$1");

/** Fields that hold a path: their \t and \n stay backslash-and-letter when salvaged (C:\temp\new). */
const PATH_FIELDS = new Set(["path", "from", "to"]);
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
  // The closing fence: the last one right after a }, since content can hold code blocks of its own.
  for (const f of [...body.matchAll(/\n[ \t]*`{2,}/g)].reverse()) {
    if (body.slice(0, f.index).trimEnd().endsWith("}")) { body = body.slice(0, f.index); break; }
  }
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

// ================================================================ from a request to a call

const NAME_KEYS = ["tool", "tool_name", "name", "function", "action"];
const ARGUMENT_KEYS = ["arguments", "args", "parameters", "params", "input"];
/** Names models use for Solder's arguments. @type {Record<string, string[]>} */
const ALIASES = { path: ["file_path", "file", "filename", "filepath"], old_text: ["old", "old_string", "search"],
  new_text: ["new", "new_string", "replace", "replacement"], content: ["text", "contents", "data"],
  glob: ["pattern"], query: ["q", "text", "pattern"], from: ["source", "src"], to: ["destination", "dest", "target"] };
/** read_file, readFile and read-file are the same tool. @param {unknown} name */
const canonical = (name) => String(name).trim().replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[-\s]+/g, "_").toLowerCase();

/** @param {string} text @returns {{call: {name: string, args: Record<string, any>, salvaged?: boolean} | null, problem: string}} */
function attempt(text) {
  try { return toCall(decode(text)); } catch { /* try salvage */ }
  try {
    const result = toCall(salvage(text));
    if (result.call) result.call.salvaged = true;
    return result;
  } catch {
    return { call: null, problem: "the block didn't hold valid JSON; quotes and backslashes inside strings need escaping" };
  }
}

/** @param {any} value @returns {{call: {name: string, args: Record<string, any>, salvaged?: boolean} | null, problem: string, unknown?: string}} */
function toCall(value) {
  if (Array.isArray(value) && value.length) value = value[0];
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
  for (const arg of /** @type {string[]} */ (required)) {
    if (args[arg] === undefined || args[arg] === null) return { call: null, problem: `${name} needs '${arg}'` };
  }
  return { call: { name, args }, problem: "" };
}

/**
 * A reply's requests: the readable ones before the first that can't be read (whose problem is returned), whether any
 * request was found, and the visible text (what comes before the first request).
 * @param {string} reply @param {{cutOff?: boolean}} [options] cut off at the length limit: a salvaged last call may be missing its end
 * @returns {{calls: {name: string, args: Record<string, any>, salvaged?: boolean}[], problem: string, unknown: string, found: boolean, visible: string}}
 */
function parseReply(reply, { cutOff = false } = {}) {
  const found = findRequests(String(reply || ""));
  /** @type {{name: string, args: Record<string, any>, salvaged?: boolean}[]} */
  const calls = [];
  let problem = "";
  let unknown = "";
  for (const r of found) {
    if (!r.call) { problem = r.problem; unknown = /** @type {any} */ (r).unknown || ""; break; }
    calls.push(r.call);
  }
  if (cutOff) while (calls.length && calls[calls.length - 1].salvaged) calls.pop();
  // The same tool with the same arguments twice (written twice) runs once.
  const seen = new Set();
  const unique = calls.filter((c) => {
    const k = c.name + JSON.stringify(c.args, Object.keys(c.args).sort());
    return !seen.has(k) && seen.add(k);
  });
  const visible = found.length ? String(reply).slice(0, found[0].start).trimEnd() : String(reply || "");
  return { calls: unique, problem, unknown, found: found.length > 0, visible };
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
  return `${lead}\n\n${f}\n${String(output).replace(/\s+$/, "")}\n${f}` + (closing ? `\n\n${ASSIST.resultClosing}` : "");
}

/** A stored tool call as the ```tool block the model would have written. @param {any} call */
function requestBlock(call) {
  /** @type {Record<string, any>} */
  let args = {};
  try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* shown as it was */ }
  return "```tool\n" + JSON.stringify({ tool: call.function.name, ...args }) + "\n```";
}

/**
 * The stored chat as Assist turns: user and assistant text only. A batch's tool messages become one user message.
 * @param {any} chat @param {(message: any) => string} resultText a tool message as the model gets it (stand-ins for trimmed ones)
 * @param {number} [from] the first message to render (0: the whole chat, after any recap)
 * @returns {{role: "user" | "assistant", content: string}[]}
 */
function assistOutbound(chat, resultText, from = 0) {
  /** @type {{role: "user" | "assistant", content: string}[]} */
  const out = [];
  let start = from;
  if (chat.compaction && from <= chat.compaction.through) {
    out.push({ role: "user", content: TEXTS.compaction }, { role: "assistant", content: chat.compaction.summary });
    start = chat.compaction.through;
  }
  const messages = chat.messages;
  for (let i = start; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user") {
      out.push({ role: "user", content: m.meta?.sent ?? m.content });
    } else if (m.role === "assistant") {
      // The model's own words as it wrote them; a Tool-lane reply is shown with its calls as tool blocks.
      const text = m.meta?.raw ?? [m.content, ...(m.tool_calls || []).map(requestBlock)].filter(Boolean).join("\n\n");
      if (String(text).trim()) out.push({ role: "assistant", content: text });
    } else if (m.role === "tool") {
      // Every tool message in a row is one batch: one user message, the closing line on the last result only.
      const batch = [];
      while (i < messages.length && messages[i].role === "tool") batch.push(messages[i++]);
      i--;
      const text = batch.map((t, n) => resultMessage(t.meta?.label || t.meta?.name || "that request",
        assistText(resultText(t)), !!t.meta?.failed, n === batch.length - 1)).join("\n\n");
      out.push({ role: "user", content: text });
    }
  }
  // Two user messages in a row (a typed message right after results, a resume note): joined, as a turn can't be
  // answered twice and the conversation goes user, assistant, user…
  return out.reduce((acc, m) => {
    const last = acc[acc.length - 1];
    if (last && last.role === "user" && m.role === "user") last.content += "\n\n" + m.content;
    else acc.push({ ...m });
    return acc;
  }, /** @type {{role: "user" | "assistant", content: string}[]} */ ([]));
}

// ================================================================ carrying a conversation over

/** A message that went out with the introduction or a setup note, without it (a carry-over says the setup once). @param {string} text */
function stripSetup(text) {
  const s = String(text);
  const at = s.indexOf(ASSIST.messageLead);
  if (s.startsWith(ASSIST.lead) && at >= 0) return s.slice(at + ASSIST.messageLead.length).replace(/^\s+/, "");
  if (s.startsWith(ASSIST.setupChangedLead)) { const end = s.indexOf(")\n\n"); if (end >= 0) return s.slice(end + 3); }
  return s;
}

/**
 * When the gateway doesn't hold the conversation (a switch from the Tool lane, a fork, compaction, a session that
 * ended, another Assist model, or no sessions at all): one user message with my setup, the conversation so far and
 * the newest message. When it's too long, the newest messages are kept and how many were left out is said.
 * @param {string} setup ASSIST.setup(context) @param {{role: string, content: string}[]} rendered assistOutbound(chat)
 * @param {number} budget characters
 */
function carryOver(setup, rendered, budget) {
  const newest = rendered[rendered.length - 1];
  const history = rendered.slice(0, -1).map((m) => (m.role === "user" ? "Me" : "You") + ":\n" + stripSetup(m.content).trim());
  let used = setup.length + ASSIST.carryOverLead.length + ASSIST.carryOverEnd.length + stripSetup(newest.content).length + 200;
  /** @type {string[]} */
  const kept = [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (used + history[i].length + 2 > budget) break;
    kept.unshift(history[i]);
    used += history[i].length + 2;
  }
  const left = history.length - kept.length;
  if (!history.length) return [setup, ASSIST.messageLead, stripSetup(newest.content)].join("\n\n");
  return [setup, ASSIST.carryOverLead, ...(left ? [ASSIST.carryOverLeftOut(left)] : []), ...kept, ASSIST.carryOverEnd, stripSetup(newest.content)].join("\n\n");
}

module.exports = { findRequests, parseReply, visibleText, decode, salvage, canonical, fence, resultMessage, requestBlock,
  assistOutbound, carryOver, stripSetup };
