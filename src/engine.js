// @ts-check
"use strict";
/**
 * The tool loop for one chat: send, run the calls the model makes, send their results, repeat.
 *
 * No `vscode` here: everything the workspace does goes through a Host, so the loop is tested under
 * plain node with a fake host and a fake gateway. Everything the panel shows arrives as events.
 *
 * A chat is saved in the API's own shape (Solder only talks to tool-calling models):
 *   {role: "user", content, meta: {typed, chips}}
 *   {role: "assistant", content, tool_calls?, meta?: {incomplete?}}
 *   {role: "tool", tool_call_id, content, meta: {name, label, summary, failed, change?, stub?}}
 * Every call is answered by a tool message, even one that never ran, so the history always lines up.
 */

const { Cancelled, sessionId } = require("./gateway.js");
const { READ_ONLY, TEXTS, TOOLS, PLAN, ASSIST, timeNote, toolDefinitions, assistText } = require("./prompt.js");
const { laneOf } = require("./lanes.js");
const { sessionPlan, holdSession, parseReply, visibleText } = require("./assist.js");

/** An Assist reply whose tool request can't be read is asked for again this many times, then the turn stops. */
const MAX_REPAIRS = 2;

const CHARS_PER_TOKEN = 4;
/** Within the chat, the newest results stay whole up to about this many tokens… */
const KEEP_RESULTS_TOKENS = 30_000;
/** …and may run this far past it before the older ones are cut, all at once (a stable prefix for longer). */
const TRIM_SLACK_TOKENS = 10_000;
/** One reply's results together: past this (in characters, scaled by the chat's token ratio), its other reads wait. */
const MAX_BATCH_RESULT_CHARS = 90_000;
/** Compaction runs only when what it can summarise is at least this share of the limit. */
const MIN_COMPACT_SHARE = 0.15;
/** How often the panel hears that a tool call is still being written. */
const DRAFTING_EVERY_MS = 400;
/** The most of /compact's "what to keep" that goes into the summary request. */
const MAX_FOCUS_CHARS = 500;
/** This task's results are cut only past this many times the compaction limit (a runaway task). */
const IN_TASK_CEILING = 1.5;
/** No single result is longer than this (a read is capped lower; this catches everything else). */
const MAX_RESULT_CHARS = 40_000;
/** Earlier turns' write and edit texts longer than this are left out of what's sent. */
const LONG_ARGUMENT_CHARS = 1_500;
/** Results this short are never cut. */
const STUB_MIN_CHARS = 2_000;
/** A finished step's results shorter than this stay (an edit's "Edited a.js" costs less than its stand-in). */
const PLAN_STUB_MIN_CHARS = 400;
/** The most steps a plan keeps. */
const MAX_PLAN_STEPS = 20;
const MAX_BATCH = 5;
const MAX_READ_BATCH = 8;
const WRAP_UP_ROUNDS = 3;
const RETRY_DELAYS_MS = [2000];
/** The chat is named after these answers (Alloy's rhythm: a first guess, then a better one). */
const TITLE_AFTER = [1, 3];
const TITLE_EXCERPT_CHARS = 1_500;
const TITLE_TIMEOUT_MS = 90_000; // before the one resend of a failure the model may have seen

/** @param {string} text */
function estimate(text) {
  return Math.ceil((text || "").length / CHARS_PER_TOKEN);
}

/**
 * @typedef {{role: string, content: string, tool_calls?: any[], tool_call_id?: string, meta?: any}} Stored
 * @typedef {{id: string, title: string, created: number, updated: number, messages: Stored[],
 *            compaction: {through: number, summary: string} | null,
 *            usage: {tokens: number, assistTokens?: number, requests?: number, prompt?: number, output?: number, thinking?: number, side?: number, by?: Record<string, number>},
 *            effort?: string, model?: string, agentsSeen?: string[], tokenRatio?: number, limitHit?: boolean,
 *            titleSource?: "auto" | "user", titledAt?: number}} Chat
 * @typedef {{output: string, summary: string, failed?: boolean, change?: any, keep?: string, ms?: number}} ToolResult
 *   keep: text that rides with the output but isn't output (a folder's AGENTS.md): never cut away
 * @typedef {{
 *   systemPrompt(chat: Chat): Promise<string>,
 *   runTool(name: string, args: any, ctx: {chat: Chat, signal: AbortSignal, edit?: {group: string, more: boolean}}): Promise<ToolResult>,
 *   settleEdits?(group: string): Promise<{path: string, text: string, summary: string}[]>,
 *   needsApproval(name: string, args: any): string | null,
 *   save(chat: Chat): Promise<void>,
 * }} Host
 * @typedef {{model: string, effort?: string, compactAt: number, maxRounds: number, modelAllowed?: ((id: string) => boolean) | null}} Settings
 */

class Engine {
  /**
   * @param {{client: any, host: Host, settings: () => Settings, onEvent: (event: any) => void,
   *          retryDelays?: number[], now?: () => Date}} options
   */
  constructor({ client, host, settings, onEvent, retryDelays = RETRY_DELAYS_MS, now = () => new Date() }) {
    this.client = client;
    this.host = host;
    this.settings = settings;
    this.emit = onEvent;
    this.retryDelays = retryDelays;
    this.now = now;
    /** @type {Map<string, (decision: {decision: string, note?: string}) => void>} */
    this.approvals = new Map();
    /** @type {string[]} */
    this.steers = [];
    this.busy = false;
    /** @type {AbortController | null} */
    this.controller = null;
    /** Tokens the current answer has used, every billed reply counted (empty ones too). */
    this.answerTokens = 0;
  }

  /** Count a reply's tokens (a failed one that was billed too) and show them. @param {Chat} chat @param {any} usage @param {any} credits */
  _spend(chat, usage, credits, free = false, side = false) {
    const used = usage?.total_tokens || ((usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0));
    if (free) {
      // An Assist model's tokens aren't billed: counted apart, and not in what this chat has cost.
      chat.usage.assistTokens = (chat.usage.assistTokens || 0) + used;
      this.emit({ type: "usage", chat: chat.id, answer: this.answerTokens, total: chat.usage.tokens, prompt: 0, credits: credits || null, free: true });
      return;
    }
    this.answerTokens += used;
    chat.usage.tokens += used;
    // Where they went, for Copy diagnostics (tokenReport): summaries and titles apart from the task's own requests.
    const u = /** @type {any} */ (chat.usage);
    if (side) u.side = (u.side || 0) + used;
    else {
      u.requests = (u.requests || 0) + 1;
      u.prompt = (u.prompt || 0) + (usage?.prompt_tokens || 0);
      u.output = (u.output || 0) + (usage?.completion_tokens || 0);
      u.thinking = (u.thinking || 0) + (usage?.completion_tokens_details?.reasoning_tokens || 0);
      // How big the chat is now, as the gateway counted it: the last request and its reply (shown as "in context").
      if (usage?.prompt_tokens) u.context = usage.prompt_tokens + (usage.completion_tokens || 0);
    }
    this.emit({ type: "usage", chat: chat.id, answer: this.answerTokens, total: chat.usage.tokens,
      prompt: usage?.prompt_tokens || 0, credits: credits || null });
  }

  /** A new, empty chat. */
  static newChat() {
    const now = Date.now();
    return { id: now.toString(36) + Math.random().toString(36).slice(2, 8), title: "New chat", created: now,
      updated: now, messages: [], compaction: null, usage: { tokens: 0 } };
  }

  /**
   * /fork: a copy of the chat to carry on in separately. Same history, summary, model and working folder; its own
   * id, title and token count. Its Undo buttons share the original's backups (Undo checks the file first).
   * @param {Chat} chat
   */
  static fork(chat) {
    const fresh = Engine.newChat();
    const copy = JSON.parse(JSON.stringify(chat));
    const base = String(chat.title || "New chat").replace(/ \(fork\)$/, "");
    if (copy.assist) copy.assist = { lost: true, why: "fork", since: Date.now() };
    return { ...copy, id: fresh.id, created: fresh.created, updated: fresh.updated, usage: { tokens: 0 },
      title: `${base} (fork)`, titleSource: "user", forkedFrom: { id: chat.id, title: chat.title } };
  }

  /**
   * /compact: summarise the whole chat now, whatever its size; the next message starts from the summary.
   * @param {Chat} chat @param {string} [focus] what you want the summary to keep in particular
   * @returns {Promise<"done" | "nothing" | "failed" | "stopped">}
   */
  async compactNow(chat, focus = "") {
    /** @type {"done" | "nothing" | "failed" | "stopped"} */
    let result = "stopped";
    await this._run(chat, async (signal) => {
      result = await this._compactIfDue(chat, signal, chat.messages.length, { force: true, focus });
    }, false);
    return result;
  }

  /**
   * Your message, then the loop until the model answers.
   * @param {Chat} chat @param {string} text what you typed @param {{context?: string, chips?: string[]}} [extra]
   */
  async ask(chat, text, extra = {}) {
    await this._run(chat, async (signal) => {
      // Saved first, so nothing that fails after this (compaction included) can lose what you typed.
      const content = `${timeNote(this.now())}\n\n${text}` + (extra.context ? `\n\n${extra.context}` : "");
      chat.messages.push({ role: "user", content, meta: { typed: text, chips: extra.chips || [] } });
      delete chat.limitHit;
      if (chat.title === "New chat") chat.title = titleFrom(text);
      await this._save(chat);
      this.emit({ type: "message", chat: chat.id });
    });
  }

  /** Carry on after a failure or a stop, from the last finished step. @param {Chat} chat */
  async resume(chat) {
    await this._run(chat, async (signal) => {
      if (!chat.messages.length) throw new Error("There's nothing to resume.");
      await this._compactIfDue(chat, signal, chat.messages.length);
      const last = chat.messages[chat.messages.length - 1];
      const summarisedAll = !!chat.compaction && chat.compaction.through >= chat.messages.length;
      // Results that say a step was stopped read like "the user said no": say plainly to run them again.
      let tail = chat.messages.length - 1;
      while (tail >= 0 && chat.messages[tail].role === "tool") tail--;
      const stoppedSteps = chat.messages.slice(tail + 1).some((m) => m.content.startsWith(TEXTS.stoppedRunning) || m.content.startsWith(TEXTS.notRunStopped));
      // Stopped at the step limit: a call refused for it would otherwise read as still refused.
      const limited = !!chat.limitHit;
      delete chat.limitHit;
      if (last.role === "assistant" || summarisedAll || stoppedSteps || limited) {
        // It stopped mid-answer (or all of it is in the recap): ask it to carry on, since the history
        // can't end with its own turn.
        const note = limited ? TEXTS.resumeLimit(this.settings().maxRounds) : stoppedSteps ? TEXTS.resumeStopped : TEXTS.resume;
        chat.messages.push({ role: "user", content: `${timeNote(this.now())}\n\n${note}`,
          meta: { typed: "Carry on", resume: true } });
        await this._save(chat);
        this.emit({ type: "message", chat: chat.id });
      }
    });
  }

  /** Stop the reply (a step that's running is stopped too; its result is kept). */
  stop() {
    this.controller?.abort();
    for (const resolve of this.approvals.values()) resolve({ decision: "decline" });
    this.approvals.clear();
  }

  /** Your answer to an approval card. @param {string} id @param {{decision: string, note?: string}} decision */
  decide(id, decision) {
    const resolve = this.approvals.get(id);
    if (resolve) { this.approvals.delete(id); resolve(decision); }
  }

  /**
   * A message typed while it works: it goes with the next result (or, if there's no next step, as the next
   * message). `extra` holds what goes with it, such as a selection from the editor's menu.
   * @param {string} text @param {{context?: string, chips?: string[]}} [extra]
   */
  steer(text, extra = {}) {
    if (text.trim()) this.steers.push({ text: text.trim(), context: extra.context || "", chips: extra.chips || [] });
  }

  /** Take back a queued message before it goes. @param {number} index @returns {string} its text, or "" */
  unsteer(index) {
    return this.steers.splice(index, 1)[0]?.text ?? "";
  }

  /** Queued messages as one: their texts, what goes with them, their chips. */
  _queued() {
    return { text: this.steers.map((s) => s.text).join("\n\n"), context: this.steers.map((s) => s.context).filter(Boolean).join("\n\n"),
      chips: this.steers.flatMap((s) => s.chips) };
  }

  /** @param {Chat} chat @param {(signal: AbortSignal) => Promise<void>} start */
  async _run(chat, start, loop = true) {
    if (this.busy) throw new Error("Solder is already working on a reply.");
    this.busy = true;
    this.steers = [];
    const controller = this.controller = new AbortController();
    this.emit({ type: "busy", chat: chat.id, busy: true });
    this.answerTokens = 0;
    let stopped = false;
    try {
      this._settle(chat, TEXTS.notRunStopped); // a reply that died mid-batch last time
      await start(controller.signal);
      if (loop) await this._loop(chat, controller.signal);
    } catch (error) {
      stopped = error instanceof Cancelled || controller.signal.aborted;
      this._settle(chat, stopped ? TEXTS.notRunStopped : TEXTS.notRunFailed);
      await this._save(chat).catch(() => {});
      if (stopped) {
        this.emit({ type: "stopped", chat: chat.id });
      } else {
        // Resumable even when the allowance is used up: after the reset (or on another model) it carries on.
        const exhausted = !!(error && /** @type {any} */ (error).exhausted);
        this.emit({ type: "error", chat: chat.id, message: error instanceof Error ? error.message : String(error),
          resumable: chat.messages.length > 0, exhausted, credits: /** @type {any} */ (error)?.credits || null });
      }
    } finally {
      this.busy = false;
      this.controller = null;
      this.approvals.clear();
      if (this.steers.length) {
        // Not delivered (the reply ended without another step): sent as the next message, unless you stopped it.
        this.emit({ type: "steer-unsent", chat: chat.id, ...this._queued(), text: this._queued().text, send: !stopped });
        this.steers = [];
      }
      this.emit({ type: "busy", chat: chat.id, busy: false });
    }
  }

  /** @param {Chat} chat @param {AbortSignal} signal */
  async _loop(chat, signal) {
    const settings = this.settings();
    const tools = toolDefinitions();
    let rounds = 0;
    let nudged = false;
    let repairs = 0;
    for (;;) {
      const model = modelOf(chat, settings);
      // Your organization's model filter applies to what's sent, not only to what the picker offers.
      if (settings.modelAllowed && !settings.modelAllowed(model)) throw new Error(`Your organization doesn't allow the model ${model || "(none chosen)"}. Pick another in the model menu.`);
      /** @type {any} */
      let reply;
      /** @type {Stored} */
      let assistant;
      if (laneOf(model, settings) === "assist") {
        // The Assist lane: plain text, the gateway's session, tool requests written in the reply (assist.js).
        const step = await this._assistStep(chat, model, settings, signal, repairs);
        if (step.repair) { repairs++; continue; }
        repairs = 0; // the allowance of asking again is for each request, not the whole turn
        ({ reply, assistant } = step);
      } else {
        // Before every step, not just a new message, so a long task can't run far past the limit. Only
        // earlier turns are summarised: this one's calls carry thought signatures some models check.
        await this._compactIfDue(chat, signal, taskStart(chat));
        trim(chat, settings.compactAt);
        const system = await this.host.systemPrompt(chat);
        const messages = outbound(chat, system);
        const made = breakdown(chat, system, tools); // what this request is made of, as it goes out
        this.emit({ type: "thinking", chat: chat.id });
        reply = await this._patient(chat, { model, messages, tools,
          effort: effortOf(settings.effortLocked ? settings.effort : chat.effort || settings.effort), signal });
        // The server's count over our estimate, so compaction triggers on real tokens (code runs about 30% over).
        const sentEstimate = estimateMessages(messages) + estimate(JSON.stringify(tools));
        if (reply.usage?.prompt_tokens > 0 && sentEstimate > 0) {
          chat.tokenRatio = Math.min(2, Math.max(0.75, reply.usage.prompt_tokens / sentEstimate));
        }
        this._spend(chat, reply.usage, reply.credits);
        attribute(chat, made, reply.usage?.prompt_tokens || Math.round(sentEstimate * (chat.tokenRatio || 1)));
        this.emit({ type: "reply", chat: chat.id, model: modelOf(chat, settings), ms: reply.ms ?? 0, prompt: reply.usage?.prompt_tokens || 0,
          completion: reply.usage?.completion_tokens || 0, finish: reply.finishReason || "", calls: reply.calls.length });
        assistant = { role: "assistant", content: reply.content };
        if (reply.calls.length) {
          const used = new Set(chat.messages.flatMap((m) => (m.tool_calls || []).map((/** @type {any} */ c) => c.id)));
          assistant.tool_calls = reply.calls.map((/** @type {any} */ call) => ({ id: unique(call.id, used), type: "function",
            function: { name: call.name, arguments: call.arguments }, ...(call.extra ? { extra_content: call.extra } : {}) }));
        }
        chat.messages.push(assistant);
      }
      await this._save(chat);
      this.emit({ type: "message", chat: chat.id });
      if (!reply.calls.length) {
        // A weak model sometimes ends a planned task partway, with steps still to do and nothing asked: once per
        // message, it's asked to carry on (or say why it stopped). Not when it asks something: that's a real stop.
        // Its answer after the last reply with calls allowed: the turn ends here, paused (you choose whether to go on).
        const atLimit = rounds >= settings.maxRounds;
        const left = unfinishedSteps(chat);
        if (left.length && !nudged && !atLimit && !asksSomething(reply.content)) {
          nudged = true;
          chat.messages.push({ role: "user", content: `${timeNote(this.now())}\n\n${TEXTS.planLeft(left)}`,
            meta: { typed: TEXTS.planLeftShown(left.length), resume: true, nudge: true } });
          await this._save(chat);
          this.emit({ type: "message", chat: chat.id });
          continue;
        }
        if (atLimit) { chat.limitHit = true; await this._save(chat); }
        this.emit({ type: "done", chat: chat.id, ...(atLimit ? { limit: settings.maxRounds } : {}) });
        this._title(chat);
        return;
      }
      rounds += 1;
      if (rounds > settings.maxRounds) {
        this._settle(chat, TEXTS.notRunLimit);
        chat.limitHit = true;
        await this._save(chat);
        this.emit({ type: "message", chat: chat.id });
        this.emit({ type: "done", chat: chat.id, limit: settings.maxRounds });
        return;
      }
      await this._batch(chat, assistant, reply.finishReason === "length", settings.maxRounds - rounds, signal);
      if (signal.aborted) throw new Cancelled();
    }
  }

  /**
   * One step on the Assist lane: what to send (sessionPlan: only the new message while the gateway's session holds
   * the chat; else the introduction, or the conversation carried over), the reply, its tool requests parsed into
   * ordinary tool calls (stored as the Tool lane stores them), and the session it came back with. A session that
   * answers 502 has ended: the conversation is carried over once. A request that can't be read is asked for again.
   * @param {Chat} chat @param {string} model @param {any} settings @param {AbortSignal} signal @param {number} repairs
   * @returns {Promise<{repair: true} | {repair?: false, reply: any, assistant: Stored}>}
   */
  async _assistStep(chat, model, settings, signal, repairs) {
    trim(chat, settings.compactAt); // smaller stand-ins for a carry-over; what the session holds is unaffected
    const context = (await this.host.assistContext?.(chat)) || { workspace: "" };
    const block = String(settings.assistSessionBlock || "").trim();
    let plan = sessionPlan(chat, model, settings, context, resultText);
    const send = (/** @type {any} */ p) => this._patient(chat, { model, messages: p.messages, assist: true, session: p.session, sessionBlock: block, signal });
    this.emit({ type: "thinking", chat: chat.id });
    /** @type {any} */
    let reply;
    try {
      reply = await send(plan);
    } catch (error) {
      if (!(plan.kind === "stateful" && /** @type {any} */ (error)?.status === 502)) throw error;
      this.emit({ type: "assist", chat: chat.id, kind: "ended", chars: 0, note: "the session ended (HTTP 502): carrying the conversation over" });
      chat.assist = { lost: true, why: "ended", since: Date.now() };
      plan = sessionPlan(chat, model, settings, context, resultText);
      reply = await send(plan);
    }
    // What actually went out, kept beside what's shown: the history renders as it was sent.
    if (plan.single && (plan.kind === "fresh" || plan.messages[0].content !== (plan.single.meta?.sent ?? plan.single.content))) {
      plan.single.meta = { ...plan.single.meta, sent: plan.messages[0].content };
    }
    this._spend(chat, reply.usage, reply.credits, true);
    const parsed = parseReply(reply.content, { cutOff: reply.finishReason === "length" });
    this.emit({ type: "reply", chat: chat.id, model, ms: reply.ms ?? 0, prompt: reply.usage?.prompt_tokens || 0,
      completion: reply.usage?.completion_tokens || 0, finish: reply.finishReason || "", calls: parsed.calls.length });
    /** @type {Stored} */
    const assistant = { role: "assistant", content: parsed.visible, meta: { lane: "assist", raw: reply.content } };
    if (parsed.calls.length) {
      const used = new Set(chat.messages.flatMap((m) => (m.tool_calls || []).map((/** @type {any} */ c) => c.id)));
      const stamp = Date.now().toString(36);
      assistant.tool_calls = parsed.calls.map((call, n) => ({ id: unique(`assist_${stamp}_${n}`, used), type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) } })); // no extra_content: Assist has no signatures
    }
    chat.messages.push(assistant);
    const note = holdSession(chat, model, plan, reply, sessionId);
    this.emit({ type: "assist", chat: chat.id, kind: plan.kind, chars: plan.messages[0].content.length, note });
    if (!parsed.calls.length && parsed.found) {
      // A request it meant but that can't be used: asked for again (a couple of times), in the user's words.
      if (repairs >= MAX_REPAIRS) { await this._save(chat); throw new Error(ASSIST.gaveUp); }
      const text = reply.finishReason === "length" ? ASSIST.cutOff
        : parsed.unknown ? ASSIST.unknownTool(parsed.unknown, Object.keys(TOOLS)) : ASSIST.repair(parsed.problem || "it couldn't be read");
      chat.messages.push({ role: "user", content: text, meta: { typed: "Asked for the tool request again", resume: true, repair: true } });
      await this._save(chat);
      this.emit({ type: "message", chat: chat.id });
      return { repair: true };
    }
    return { reply: { content: parsed.visible, calls: assistant.tool_calls || [], finishReason: "", usage: reply.usage }, assistant };
  }

  /**
   * Run one reply's calls in order. Each gets its own tool message.
   * @param {Chat} chat @param {Stored} assistant @param {boolean} cutOff @param {number} roundsLeft @param {AbortSignal} signal
   */
  async _batch(chat, assistant, cutOff, roundsLeft, signal) {
    const calls = assistant.tool_calls || [];
    // Up to MAX_READ_BATCH calls run, at most MAX_BATCH of them changes; plan updates don't count.
    let counted = 0;
    let changes = 0;
    const within = calls.map((call) => {
      const name = call.function.name;
      if (name === "plan") return true;
      const change = !READ_ONLY.has(name);
      if (counted >= MAX_READ_BATCH || (change && changes >= MAX_BATCH)) return false;
      counted++;
      if (change) changes++;
      return true;
    });
    const seen = new Set();
    /** @type {string | null} why the rest won't run */
    let skip = null;
    /** @type {Stored[]} */
    const added = [];
    let batchChars = 0;
    const batchLimit = MAX_BATCH_RESULT_CHARS / Math.max(1, chat.tokenRatio || 1);
    // Several edits to one file in a reply: its problems are checked once, after the last of them.
    const group = calls[0]?.id || "";
    const editsTo = calls.map((other) => other.function.name === "edit_file" ? pathKey(argumentsOf(other).path) : "");
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index];
      const name = call.function.name;
      const parsed = parseArguments(name, call.function.arguments, cutOff && index === calls.length - 1);
      const label = labelOf(name, parsed.args);
      /** @type {ToolResult} */
      let result;
      if (signal.aborted) skip = TEXTS.notRunStopped;
      if (skip) {
        result = { output: skip, summary: "Not run: " + label, failed: true };
      } else if (!within[index]) {
        result = { output: TEXTS.notRunBatch(MAX_READ_BATCH, MAX_BATCH), summary: "Not run: " + label, failed: true };
      } else if (READ_ONLY.has(name) && name !== "plan" && batchChars >= batchLimit) {
        result = { output: TEXTS.notRunFull, summary: "Not run: " + label, failed: true };
      } else if (parsed.problem) {
        result = { output: parsed.problem, summary: "Not run: " + label, failed: true };
      } else if (seen.has(fingerprint(name, parsed.args))) {
        result = { output: TEXTS.repeat, summary: "Not run again: " + label, failed: true };
      } else {
        seen.add(fingerprint(name, parsed.args));
        const more = !!editsTo[index] && editsTo.some((other, later) => later > index && within[later] && other === editsTo[index]);
        result = await this._runOne(chat, call.id, name, parsed.args, label, signal, name === "edit_file" ? { group, more } : undefined);
        // Arguments the tool doesn't take were left out: said once, so the next call can drop or rename them.
        if (parsed.ignored?.length) result = { ...result, output: result.output + "\n\n" + TEXTS.ignored(name, parsed.ignored) };
        if (result.failed && !READ_ONLY.has(name) && !signal.aborted) skip = TEXTS.notRun;
        if (signal.aborted) skip = TEXTS.notRunStopped;
      }
      // `keep` (a folder's AGENTS.md, your note) isn't tool output: it survives the result being cut.
      const output = capped(result.output);
      batchChars += output.length;
      /** @type {Stored} */
      const message = { role: "tool", tool_call_id: call.id, content: result.keep ? output + "\n\n" + result.keep : output,
        meta: { name, label, summary: result.summary, failed: !!result.failed, ...(result.keep ? { keep: result.keep } : {}),
          ...(result.ms !== undefined ? { ms: result.ms } : {}),
          ...(result.change ? { change: result.change } : {}),
          ...(result.plan ? { plan: result.plan } : {}) } };
      chat.messages.push(message);
      added.push(message);
      await this._save(chat);
      this.emit({ type: "message", chat: chat.id });
    }
    // A file's problems still waiting (its later edit failed or didn't run) go with its last edit that ran.
    for (const left of this.host.settleEdits ? await this.host.settleEdits(group) : []) {
      const message = [...added].reverse().find((m) => m.meta?.name === "edit_file" && !m.meta.failed
        && editsTo[calls.findIndex((c) => c.id === m.tool_call_id)] === pathKey(left.path));
      if (!message) continue;
      message.content += left.text;
      message.meta.summary += left.summary;
    }
    // Notes ride on the last result: the step limit near, and anything you typed meanwhile.
    const last = added[added.length - 1];
    if (last) {
      const notes = [];
      if (roundsLeft <= WRAP_UP_ROUNDS && !signal.aborted) notes.push(TEXTS.wrapUp(roundsLeft)); // not on a step you stopped
      if (this.steers.length && !signal.aborted) {
        const queued = this._queued();
        const text = queued.text;
        this.steers = [];
        notes.push(TEXTS.steer(queued.context ? `${text}\n\n${queued.context}` : text));
        last.meta.steer = text;
        last.meta.keep = [last.meta.keep, TEXTS.steer(queued.context ? `${text}\n\n${queued.context}` : text)].filter(Boolean).join("\n\n");
        this.emit({ type: "steer-sent", chat: chat.id, text });
      }
      if (notes.length) {
        last.content += "\n\n" + notes.join("\n\n");
        await this._save(chat);
      }
    }
  }

  /** One call: asked about first when it must be, then run. @returns {Promise<ToolResult>} */
  async _runOne(/** @type {Chat} */ chat, /** @type {string} */ id, /** @type {string} */ name, /** @type {any} */ args,
    /** @type {string} */ label, /** @type {AbortSignal} */ signal, /** @type {{group: string, more: boolean} | undefined} */ edit) {
    if (name === "plan") return planStep(chat, id, args); // the engine's own: nothing on disk, nothing to approve
    const reason = this.host.needsApproval(name, args);
    let note = "";
    if (reason) {
      const answer = await new Promise((resolve) => {
        this.approvals.set(id, resolve);
        this.emit({ type: "approval", chat: chat.id, id, name, args, reason, label });
      });
      this.emit({ type: "approval-done", chat: chat.id, id, decision: answer.decision });
      // Stop answers open cards with "decline": that's a stop, not the user saying no.
      if (signal.aborted) return { output: TEXTS.notRunStopped, summary: "Not run: " + label, failed: true };
      note = (answer.note || "").trim();
      if (answer.decision !== "allow") {
        return { output: TEXTS.declined + (note ? "\n\n" + TEXTS.userNote(note) : ""),
          summary: "Declined: " + label + (note ? " · with your note" : ""), failed: true };
      }
    }
    this.emit({ type: "running", chat: chat.id, id, label });
    const began = Date.now();
    let result;
    try {
      const work = this.host.runTool(name, args, edit ? { chat, signal, edit } : { chat, signal });
      // Stop ends the wait for a tool that only looks (a slow search, a cold language server) at once. One that
      // changes files is let finish, so Undo knows what it did.
      result = READ_ONLY.has(name) ? await untilStopped(work, signal) : await work;
      if (result === STOPPED) result = { output: TEXTS.stoppedRunning, summary: label + " · stopped", failed: true };
    } catch (error) {
      result = { output: "Error: " + (error instanceof Error ? error.message : String(error)), summary: label + " failed", failed: true };
    }
    result = { ...result, ms: Date.now() - began };
    this.emit({ type: "ran", chat: chat.id, name, ms: result.ms, failed: !!result.failed, chars: String(result.output || "").length });
    if (note) {
      result = { ...result, keep: [result.keep, TEXTS.userNote(note)].filter(Boolean).join("\n\n"),
        summary: result.summary + " · with your note" };
    }
    return result;
  }

  /**
   * One reply, retrying only what's worth it. The gateway already retried busy answers (429, 503) on its
   * backoff; what's left here is one resend of a failure the model may have seen (a reset, a timeout),
   * and one of an empty reply to a tool result, with a note. Each resend is billed in full, so no more.
   * Once any words have reached the user, nothing is resent: they're kept, and Resume carries on.
   * `side`: not part of the chat (the summary request), so nothing streams to the panel.
   * @param {Chat} chat @param {any} request @param {boolean} [side]
   */
  async _patient(chat, request, side = false) {
    let uncertainTried = false;
    let emptyTried = false;
    for (;;) {
      let shown = "";
      let told = 0;
      let visible = "";
      try {
        return await this.client.reply({ ...request, onText: (/** @type {string} */ text) => {
          shown += text;
          if (side) return;
          if (!request.assist) { this.emit({ type: "delta", chat: chat.id, text }); return; }
          // An Assist reply streams its tool requests as text: only the words before them are shown.
          const now = visibleText(shown, true);
          if (now.length > visible.length && now.startsWith(visible)) { this.emit({ type: "delta", chat: chat.id, text: now.slice(visible.length) }); visible = now; }
        }, onCalls: (/** @type {{name: string, chars: number, path: string}[]} */ calls) => {
          // A tool call being written (a long file can take minutes): the panel says so, a few times a second at most.
          if (side || Date.now() - told < DRAFTING_EVERY_MS) return;
          told = Date.now();
          this.emit({ type: "drafting", chat: chat.id, calls });
        } });
      } catch (error) {
        const e = /** @type {any} */ (error);
        if (e.usage) this._spend(chat, e.usage, e.credits, !!request.assist, !!side); // an empty reply was still billed (an Assist one is free, as ever)
        const stopped = error instanceof Cancelled || request.signal.aborted;
        const partial = e.partial || shown;
        if (partial && !side) {
          chat.messages.push(request.assist ? { role: "assistant", content: visibleText(partial), meta: { incomplete: true, lane: "assist", raw: partial } }
            : { role: "assistant", content: partial, meta: { incomplete: true } });
          throw stopped ? new Cancelled() : error;
        }
        if (stopped) throw new Cancelled();
        const last = request.messages[request.messages.length - 1];
        if (e.empty) {
          // Only after results (not after your own message): on the Assist lane those are inside a user message.
          const afterResults = request.assist ? chat.messages[chat.messages.length - 1]?.role === "tool" : last.role === "tool";
          if (!e.transient || emptyTried || !afterResults) throw error;
          emptyTried = true;
          const note = request.assist ? assistText(TEXTS.emptyReply) : TEXTS.emptyReply;
          request = { ...request, messages: [...request.messages.slice(0, -1), { ...last, content: last.content + note }] };
          this.emit({ type: "retrying", chat: chat.id, why: "empty" });
          continue;
        }
        if (!e.transient || !e.uncertain || e.exhausted || uncertainTried) throw error;
        uncertainTried = true;
        this.emit({ type: "retrying", chat: chat.id, why: e.message });
        await sleep(this.retryDelays[0] ?? 0, request.signal);
      }
    }
  }

  /**
   * Summarise the older part of the chat once it's past the limit. Whole recent turns are kept word for
   * word, up to about a fifth of the limit; the message at `limit` and after (your new one) always is.
   * If the summary request fails, the chat goes on as it is: compaction only saves tokens.
   * With `force` (/compact) it runs whatever the size, keeps nothing word for word, and can be told what to keep.
   * @param {Chat} chat @param {AbortSignal} signal @param {number} limit
   * @param {{force?: boolean, focus?: string}} [options]
   * @returns {Promise<"done" | "skipped" | "nothing" | "failed">}
   */
  async _compactIfDue(chat, signal, limit, options = {}) {
    const force = !!options.force;
    const settings = this.settings();
    const assistLane = laneOf(modelOf(chat, settings), settings) === "assist";
    if (assistLane && !force) return "skipped";
    trim(chat, settings.compactAt);
    const system = await this.host.systemPrompt(chat);
    const ratio = chat.tokenRatio || 1;
    const size = estimateMessages(outbound(chat, system)) + estimate(JSON.stringify(toolDefinitions()));
    if (!force && size * ratio < settings.compactAt) return "skipped";
    const start = chat.compaction ? chat.compaction.through : 0;
    const keep = force ? 0 : settings.compactAt / 5 / ratio; // in estimated tokens
    let cut = limit;
    let kept = 0;
    for (let index = limit - 1; index > start; index--) {
      const message = chat.messages[index];
      kept += sizeOf(message);
      if (kept > keep) break;
      if (message.role === "user" && !message.meta?.resume) cut = index;
    }
    if (cut <= start) return force ? "nothing" : "skipped";
    // Summarising a sliver (a warm-up turn before a huge one) costs a request and saves nothing.
    const summarisable = chat.messages.slice(start, cut).reduce((sum, m) => sum + sizeOf(m), 0) * ratio;
    if (!force && summarisable < settings.compactAt * MIN_COMPACT_SHARE) return "skipped";
    // A summary that failed isn't asked for again before every step of the same task: once per task and model.
    const attempt = `${start}:${cut}:${limit}:${modelOf(chat, settings)}`;
    const failed = (this._compactFailed ??= new Map());
    if (!force && failed.get(chat.id) === attempt) return "skipped";
    const focus = String(options.focus || "").trim().slice(0, MAX_FOCUS_CHARS);
    this.emit({ type: "compacting", chat: chat.id });
    let reply;
    try {
      const transcript = transcriptOf(chat, start, cut, Math.floor(settings.compactAt * CHARS_PER_TOKEN * 0.8));
      const ask = `${TEXTS.compactionTranscript}\n\n${transcript}\n\n${TEXTS.compaction}` + (focus ? `\n\n${TEXTS.compactionFocus(focus)}` : "");
      // An Assist model takes no system message, and a side request there goes whole (not streamed), without a session.
      reply = assistLane
        ? await this._patient(chat, { model: modelOf(chat, settings), signal, assist: true, stream: false, messages: [{ role: "user", content: ask }] }, true)
        : await this._patient(chat, { model: modelOf(chat, settings), signal, effort: undefined, messages: [
          { role: "system", content: TEXTS.compactionSystem }, { role: "user", content: ask }] }, true);
    } catch (error) {
      if (error instanceof Cancelled || signal.aborted) throw new Cancelled();
      this.emit({ type: "compaction-failed", chat: chat.id, message: error instanceof Error ? error.message : String(error) });
      if (!force) failed.set(chat.id, attempt);
      return "failed";
    }
    this._spend(chat, reply.usage, reply.credits, assistLane, true); // free on the Assist lane
    if (!reply.content.trim()) { if (!force) failed.set(chat.id, attempt); return force ? "failed" : "skipped"; }
    chat.compaction = { through: cut, summary: reply.content.trim() };
    // The session no longer matches the chat: the next Assist message starts afresh, with the recap carried over.
    if (chat.assist) chat.assist = { lost: true, why: "compacted", since: Date.now() };
    await this._save(chat);
    this.emit({ type: "compacted", chat: chat.id, through: cut });
    return "done";
  }

  /**
   * Name the chat from what's been said, after its first and third answers: one request of its own,
   * holding only an excerpt (no history, no tools; the model is stateless, so nothing else is needed).
   * Not awaited, silent if it fails, and never once you've renamed the chat yourself.
   * @param {Chat} chat
   */
  _title(chat) {
    const answers = chat.messages.filter((m) => m.role === "assistant" && !m.tool_calls?.length && !m.meta?.incomplete
      && m.content.trim()).length;
    if (chat.titleSource === "user" || !TITLE_AFTER.includes(answers) || (chat.titledAt ?? 0) >= answers) return;
    const excerpt = titleExcerpt(chat.messages);
    if (!excerpt) return;
    chat.titledAt = answers;
    const settings = this.settings();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
    const assistLane = laneOf(modelOf(chat, settings), settings) === "assist";
    Promise.resolve().then(() => this.client.reply({ model: modelOf(chat, settings), signal: controller.signal,
      ...(assistLane ? { assist: true, stream: false } : {}), messages: [{ role: "user", content: TEXTS.titleRequest(excerpt) }] }))
      .then(async (/** @type {any} */ reply) => {
        if (reply.usage) { this._spend(chat, reply.usage, reply.credits, assistLane, true); await this._save(chat); }
        const title = cleanTitle(reply.content || "");
        if (!title || chat.titleSource === "user" || title === chat.title) return;
        chat.title = title;
        chat.titleSource = "auto";
        await this._save(chat);
        this.emit({ type: "titled", chat: chat.id, title });
      })
      .catch(() => {}) // a name isn't worth an error
      .finally(() => clearTimeout(timer));
  }

  /** Answer every call still owed one (a reply that stopped mid-batch). @param {Chat} chat @param {string} why */
  _settle(chat, why) {
    const answered = new Set();
    for (let index = chat.messages.length - 1; index >= 0; index--) {
      const message = chat.messages[index];
      if (message.role === "tool") { answered.add(message.tool_call_id); continue; }
      if (message.role !== "assistant") continue;
      for (const call of message.tool_calls || []) {
        if (answered.has(call.id)) continue;
        const args = parseArguments(call.function.name, call.function.arguments, false).args;
        chat.messages.push({ role: "tool", tool_call_id: call.id, content: why, meta: { name: call.function.name,
          label: labelOf(call.function.name, args), summary: "Not run: " + labelOf(call.function.name, args), failed: true } });
      }
      break; // only the latest reply can be owed answers
    }
  }

  async _save(/** @type {Chat} */ chat) {
    chat.updated = Date.now();
    await this.host.save(chat);
  }
}

const STOPPED = Symbol("stopped");

/** A promise's value, or STOPPED as soon as the signal fires (the work goes on, its result unused). @param {Promise<any>} work @param {AbortSignal} signal */
function untilStopped(work, signal) {
  work.catch(() => {}); // if it's left behind, its failure is nobody's
  const stopped = new Promise((resolve) => {
    if (signal.aborted) resolve(STOPPED);
    else signal.addEventListener("abort", () => resolve(STOPPED), { once: true });
  });
  // The work first: a result that's already there wins over a stop that came at the same moment.
  return Promise.race([work, stopped]);
}

/** The chat as the model gets it: the system message, the recap (if compacted), then what's after it. */
function outbound(/** @type {Chat} */ chat, /** @type {string} */ system) {
  /** @type {any[]} */
  const out = [{ role: "system", content: system }];
  let start = 0;
  if (chat.compaction) {
    out.push({ role: "user", content: TEXTS.compaction }, { role: "assistant", content: chat.compaction.summary });
    start = chat.compaction.through;
  }
  const current = lastUser(chat);
  for (const [offset, message] of chat.messages.slice(start).entries()) {
    if (message.role === "user") out.push({ role: "user", content: message.content });
    else if (message.role === "assistant") {
      if (!message.content && !message.tool_calls?.length) continue;
      // An earlier turn's big writes and edits are on disk now: sent again in full they'd cost their
      // size on every step. (This turn's are sent as they came.)
      const calls = start + offset < current ? message.tool_calls?.map(shortCall) : message.tool_calls;
      out.push({ role: "assistant", content: message.content, ...(calls?.length ? { tool_calls: calls } : {}) });
    } else if (message.role === "tool") {
      out.push({ role: "tool", tool_call_id: message.tool_call_id, content: resultText(message) });
    }
  }
  // A recap's kept part may start with results whose calls were summarised away: drop those.
  const offered = new Set(out.flatMap((m) => (m.tool_calls || []).map((/** @type {any} */ c) => c.id)));
  return out.filter((m) => m.role !== "tool" || offered.has(m.tool_call_id));
}

// ---------------------------------------------------------------- where the tokens go (Copy diagnostics) --

/** What a request is made of. Numbers only ever leave this: no text, no paths. */
const KINDS = /** @type {const} */ ({
  results: "tool results", system: "the system prompt", tools: "the tool definitions", user: "your messages", text: "the model's own text",
  calls: "its tool calls' arguments", signatures: "thought signatures", standIns: "stand-ins for cut results",
  kept: "kept instructions, skills and notes", recap: "the summary of earlier turns",
});

/**
 * The request as outbound() builds it, by kind, in characters.
 * @param {Chat} chat @param {string} system @param {any[]} tools @returns {Record<keyof typeof KINDS, number>}
 */
function breakdown(chat, system, tools) {
  const parts = /** @type {Record<keyof typeof KINDS, number>} */ (Object.fromEntries(Object.keys(KINDS).map((kind) => [kind, 0])));
  parts.system = system.length;
  parts.tools = JSON.stringify(tools).length;
  let start = 0;
  if (chat.compaction) {
    parts.recap = TEXTS.compaction.length + chat.compaction.summary.length;
    start = chat.compaction.through;
  }
  const current = lastUser(chat);
  const offered = new Set();
  for (const [offset, message] of chat.messages.slice(start).entries()) {
    if (message.role === "user") parts.user += message.content.length;
    else if (message.role === "assistant") {
      parts.text += message.content.length;
      for (const call of message.tool_calls || []) {
        const sent = start + offset < current ? shortCall(call) : call;
        const signature = sent.extra_content === undefined ? 0 : JSON.stringify(sent.extra_content).length;
        offered.add(call.id);
        parts.signatures += signature;
        parts.calls += JSON.stringify(sent).length - signature;
      }
    } else if (message.role === "tool" && offered.has(message.tool_call_id)) {
      const sent = resultText(message).length;
      const keep = Math.min(sent, String(message.meta?.keep ?? "").length);
      parts[message.meta?.stub ? "standIns" : "results"] += sent - keep;
      parts.kept += keep;
    }
  }
  return parts;
}

/** A request's prompt tokens, shared out by what it was made of, added to the chat's running totals. */
function attribute(/** @type {Chat} */ chat, /** @type {Record<string, number>} */ made, /** @type {number} */ promptTokens) {
  const total = Object.values(made).reduce((sum, chars) => sum + chars, 0);
  if (!total || !(promptTokens > 0)) return;
  const u = /** @type {any} */ (chat.usage);
  u.by = u.by || {};
  for (const [kind, chars] of Object.entries(made)) u.by[kind] = (u.by[kind] || 0) + promptTokens * chars / total;
}

/**
 * read_file calls for lines the model had already read in the same task, with no change to the file in between:
 * `again` while the first result was still whole in the chat (avoidable), `afterCut` once it had been left out
 * (fair: the stand-in says to). By the paths as the model wrote them, so the same file spelled two ways isn't caught.
 * @param {Chat} chat @returns {{reads: number, again: number, againTokens: number, afterCut: number}}
 */
function repeatReads(chat) {
  /** @type {Map<string, {name: string, args: any}>} */
  const calls = new Map();
  /** @type {Map<string, {from: number, to: number, message: Stored}[]>} */
  let seen = new Map();
  const out = { reads: 0, again: 0, againTokens: 0, afterCut: 0 };
  const ratio = chat.tokenRatio || 1;
  for (const message of chat.messages) {
    if (message.role === "user" && !message.meta?.resume) seen = new Map(); // a new task
    for (const call of message.tool_calls || []) calls.set(call.id, { name: call.function?.name, args: argumentsOf(call) });
    if (message.role !== "tool" || message.meta?.failed) continue;
    const call = calls.get(String(message.tool_call_id));
    if (!call) continue;
    if (call.name === "read_file") {
      const key = pathKey(call.args.path);
      if (!key) continue;
      out.reads++;
      // The lines that came back: the summary says when it was part of the file, else all of it.
      const part = /lines ([\d,]+)–([\d,]+) of/.exec(String(message.meta?.summary ?? ""));
      const from = part ? Number(part[1].replace(/,/g, "")) : 1;
      const to = part ? Number(part[2].replace(/,/g, "")) : Infinity;
      const before = seen.get(key) || [];
      // A covering read still whole in the chat makes this one avoidable, whatever older ones were cut.
      const covers = (/** @type {{from: number, to: number}} */ read) => read.from <= from && read.to >= to;
      const first = before.find((read) => covers(read) && !read.message.meta?.stub) ?? before.find(covers);
      if (first?.message.meta?.stub) out.afterCut++;
      else if (first) { out.again++; out.againTokens += Math.round(estimate(message.content) * ratio); }
      seen.set(key, [...before, { from, to, message }]);
    } else if (call.name === "edit_file" || call.name === "write_file" || call.name === "remove_item") seen.delete(pathKey(call.args.path));
    else if (call.name === "move_item") { seen.delete(pathKey(call.args.from)); seen.delete(pathKey(call.args.to)); }
  }
  return out;
}

/**
 * Where a chat's tokens went, as lines for Copy diagnostics: the billed totals, the prompt tokens by what they
 * carried (recorded request by request, so re-sending shows), the next request as it stands, and repeat reads.
 * @param {Chat} chat @param {string} system @param {any[]} tools @returns {string[]}
 */
function tokenReport(chat, system, tools) {
  const n = (/** @type {number} */ x) => Math.round(x || 0).toLocaleString("en-US");
  const u = /** @type {any} */ (chat.usage);
  const table = (/** @type {Record<string, number>} */ amounts) => {
    const total = Object.values(amounts).reduce((sum, x) => sum + x, 0);
    return Object.entries(amounts).filter(([, amount]) => Math.round(amount) > 0).sort((a, b) => b[1] - a[1])
      .map(([kind, amount]) => `  ${(/** @type {any} */ (KINDS)[kind] ?? kind).padEnd(36)} ${n(amount).padStart(11)}  ${String(Math.round(amount / total * 100)).padStart(3)}%`);
  };
  const lines = [];
  if (u.requests) {
    const counted = (u.prompt || 0) + (u.output || 0) + (u.side || 0);
    lines.push(`Where this chat's tokens went: ${n(u.requests)} request${u.requests === 1 ? "" : "s"} · ${n(u.prompt)} in · ${n(u.output)} out` +
      (u.thinking ? ` (${n(u.thinking)} of it thinking)` : "") + (u.side ? ` · ${n(u.side)} on summaries and titles` : "") +
      (chat.usage.tokens - counted > 100 ? ` · ${n(chat.usage.tokens - counted)} from before this was recorded` : ""));
    if (u.by) lines.push("What the tokens in carried, over every request:", ...table(u.by));
  } else if (chat.usage.tokens) lines.push(`Where this chat's tokens went: not recorded (its ${n(chat.usage.tokens)} tokens were used before Solder kept count by kind).`);
  if (u.assistTokens) lines.push(`Assist models (not billed): ${n(u.assistTokens)} tokens, not broken down.`);
  const ratio = chat.tokenRatio || 1;
  const next = Object.fromEntries(Object.entries(breakdown(chat, system, tools)).map(([kind, chars]) => [kind, chars / CHARS_PER_TOKEN * ratio]));
  lines.push(`The next request as it stands, about ${n(Object.values(next).reduce((sum, x) => sum + x, 0))} tokens:`, ...table(next));
  const results = chat.messages.slice(chat.compaction ? chat.compaction.through : 0).filter((m) => m.role === "tool");
  const cut = results.filter((m) => m.meta?.stub).length;
  const reads = repeatReads(chat);
  lines.push(`Results in the chat: ${results.length - cut} whole, ${cut} cut to stand-ins${chat.compaction ? " (earlier turns are summarised)" : ""}.`,
    `Reads: ${reads.reads}` + (reads.again ? ` · ${reads.again} of lines already read in the same task, unchanged and still in the chat (about ${n(reads.againTokens)} tokens each time they're sent)` : " · none repeated while the first was still in the chat") +
    (reads.afterCut ? ` · ${reads.afterCut} again after the first read was cut` : "") + ".");
  return lines;
}

/** A call's arguments, or {} when they aren't JSON. @param {any} call */
function argumentsOf(call) {
  try { const args = JSON.parse(call.function?.arguments || "{}"); return args && typeof args === "object" ? args : {}; } catch { return {}; }
}

/** A path as given, for comparing two calls' (slashes and case aside). @param {unknown} given */
function pathKey(given) {
  return typeof given === "string" ? given.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase() : "";
}

/**
 * The steps still to do of a plan this task has worked on (a plan call since the latest message), else [].
 * @param {Chat} chat @returns {{number: number, goal: string}[]}
 */
function unfinishedSteps(chat) {
  const plan = /** @type {any} */ (chat).plan;
  if (!plan?.steps?.length) return [];
  const since = chat.messages.slice(taskStart(chat));
  if (!since.some((m) => m.role === "tool" && m.meta?.name === "plan" && !m.meta.failed)) return [];
  return plan.steps.map((/** @type {any} */ step, /** @type {number} */ index) => ({ number: index + 1, goal: step.goal, state: step.state }))
    .filter((/** @type {any} */ step) => step.state !== "done").map(({ number, goal }) => ({ number, goal }));
}

/** A reply that ends on a question for the user (its last lines ask something). @param {string} text */
function asksSomething(text) {
  // Only the prose counts: a ? in code, inline code or a URL isn't a question.
  const prose = String(text || "").replace(/```[\s\S]*?(```|$)/g, "").replace(/`[^`\n]*`/g, "").replace(/\bhttps?:\/\/\S+/g, "");
  const lines = prose.split("\n").map((line) => line.trim()).filter(Boolean);
  return /\?/.test(lines.slice(-2).join(" "));
}

/** The model a chat uses: its own choice, unless the organisation enforces one. @param {Chat} chat @param {any} settings */
function modelOf(chat, settings) {
  return settings.modelLocked ? settings.model : chat.model || settings.model;
}

/**
 * Where the current task started: the latest message you typed. Resume's and the plan nudge's "carry on" go on the
 * same task, so its results keep their in-task protection and it isn't summarised partway. @param {Chat} chat
 */
function taskStart(chat) {
  for (let index = chat.messages.length - 1; index >= 0; index--) {
    if (chat.messages[index].role === "user" && !chat.messages[index].meta?.resume) return index;
  }
  return 0;
}

/** Where the current turn starts, as the API counts turns: the latest user message (Resume's included). @param {Chat} chat */
function lastUser(chat) {
  for (let index = chat.messages.length - 1; index >= 0; index--) if (chat.messages[index].role === "user") return index;
  return 0;
}

/** Arguments a write or edit no longer needs in full (they're in the file). */
const LONG_ARGUMENTS = { write_file: ["content"], edit_file: ["old_text", "new_text"] };

/** A call from an earlier turn with its long text arguments replaced by a note. @param {any} call */
function shortCall(call) {
  const fields = LONG_ARGUMENTS[/** @type {keyof LONG_ARGUMENTS} */ (call.function?.name)];
  if (!fields || (call.function.arguments || "").length <= LONG_ARGUMENT_CHARS) return call;
  let args;
  try { args = JSON.parse(call.function.arguments); } catch { return call; }
  if (!args || typeof args !== "object") return call;
  let changed = false;
  for (const field of fields) {
    if (typeof args[field] === "string" && args[field].length > LONG_ARGUMENT_CHARS) {
      args[field] = TEXTS.argumentLeftOut(args[field].split("\n").length);
      changed = true;
    }
  }
  return changed ? { ...call, function: { ...call.function, arguments: JSON.stringify(args) } } : call;
}

/**
 * The plan tool: set the steps, or mark one done. Kept on the chat (chat.plan), with the calls where each step began
 * and ended, so trim() can leave a finished step's results out. @param {Chat} chat @param {string} id @param {any} args
 * @returns {ToolResult}
 */
function planStep(chat, id, args) {
  const plan = /** @type {any} */ (chat).plan;
  if (Array.isArray(args.steps) && args.steps.length) {
    const before = new Map((plan?.steps || []).map((/** @type {any} */ step) => [String(step.goal).trim().toLowerCase(), step]));
    const steps = args.steps.slice(0, MAX_PLAN_STEPS).map((/** @type {any} */ given) => {
      const goal = String(given?.goal ?? "").trim().slice(0, 200) || "(a step)";
      const old = before.get(goal.toLowerCase()); // a step already done stays done; the one being done keeps where it began
      const work = String(given?.work ?? "").trim().slice(0, 2000);
      if (old && old.state === "done") return { ...old, goal };
      if (old && old.state === "doing") return { ...old, goal, work: work || old.work };
      return { goal, work, state: "todo", notes: "" };
    });
    /** @type {any} */ (chat).plan = { steps };
    const next = steps.find((step) => step.state !== "done");
    if (next) { next.startCall = next.state === "doing" && next.startCall ? next.startCall : id; next.state = "doing"; }
  }
  const current = /** @type {any} */ (chat).plan;
  if (args.done !== undefined && args.done !== null) {
    if (!current) return { output: PLAN.none, summary: "Plan · none yet", failed: true };
    const index = Math.round(Number(args.done)) - 1;
    const step = current.steps[index];
    if (!step) return { output: PLAN.badStep(current.steps.length), summary: "Plan · no such step", failed: true };
    step.state = "done";
    step.notes = String(args.notes ?? "").trim().slice(0, 1500);
    // The step ends where the reply that finishes it begins: its other calls may already be the next step's.
    const reply = [...chat.messages].reverse().find((m) => m.role === "assistant" && m.tool_calls?.some((c) => c.id === id));
    step.endCall = reply?.tool_calls?.[0]?.id || id;
    step.startCall ??= id;
    const next = current.steps.find((/** @type {any} */ other) => other.state === "todo");
    // The next step begins just after the last result before this reply, so this reply's other calls are its.
    const at = reply ? chat.messages.lastIndexOf(reply) : -1;
    const before = at > 0 ? chat.messages.slice(0, at).reverse().find((m) => m.role === "tool" && m.tool_call_id) : null;
    if (next && !current.steps.some((/** @type {any} */ other) => other.state === "doing")) { next.state = "doing"; next.startCall = before?.tool_call_id || id; }
  }
  if (!current) return { output: PLAN.none, summary: "Plan · none yet", failed: true };
  const done = current.steps.filter((/** @type {any} */ step) => step.state === "done").length;
  // What this result holds, so a later one that holds all of it can stand in for it (supersedePlans).
  const snapshot = { goals: current.steps.map((/** @type {any} */ step) => step.goal.toLowerCase()),
    done: current.steps.filter((/** @type {any} */ step) => step.state === "done").map((/** @type {any} */ step) => [step.goal.toLowerCase(), step.notes]) };
  return { output: PLAN.now(current.steps), summary: `Plan · ${done} of ${current.steps.length} done`, plan: snapshot };
}

/**
 * Finished steps' results, left out (sticky): those after the call that began the step, up to the one that ended it.
 * The newest reply's results are never cut, as everywhere: the model hasn't seen them yet. @param {Chat} chat @param {Set<Stored>} fresh
 */
function trimFinishedSteps(chat, fresh) {
  const plan = /** @type {any} */ (chat).plan;
  if (!plan) return false;
  /** @type {Map<string, number>} */
  const at = new Map();
  chat.messages.forEach((message, index) => { if (message.role === "tool" && message.tool_call_id) at.set(message.tool_call_id, index); });
  let cut = false;
  plan.steps.forEach((/** @type {any} */ step, /** @type {number} */ number) => {
    if (step.state !== "done" || !step.startCall || !step.endCall) return;
    const from = at.get(step.startCall);
    const to = at.get(step.endCall);
    if (from === undefined || to === undefined) return;
    for (let index = from + 1; index < to; index++) {
      const message = chat.messages[index];
      if (message.role !== "tool" || message.meta?.stub || message.meta?.name === "plan" || fresh.has(message)) continue;
      if (message.content.length <= PLAN_STUB_MIN_CHARS) continue;
      message.meta = { ...message.meta, stub: true, stepDone: number + 1 };
      cut = true;
    }
  });
  return cut;
}

/**
 * Older plan results that the newest one holds all of (each of their goals, and each done step with the same notes):
 * a short stand-in, as every plan call returns the whole plan. One the newest doesn't cover (a re-plan that dropped
 * a step) stays whole. @param {Chat} chat @param {number} start
 */
function supersedePlans(chat, start) {
  const plans = chat.messages.slice(start).filter((m) => m.role === "tool" && m.meta?.name === "plan" && !m.meta.failed && m.meta.plan);
  const newest = plans[plans.length - 1];
  if (!newest) return false;
  const goals = new Set(newest.meta.plan.goals);
  const notes = new Map(newest.meta.plan.done);
  let cut = false;
  for (const older of plans.slice(0, -1)) {
    if (older.meta.planOld) continue;
    const held = older.meta.plan.goals.every((/** @type {string} */ goal) => goals.has(goal))
      && older.meta.plan.done.every((/** @type {[string, string]} */ [goal, note]) => notes.get(goal) === note);
    if (!held) continue;
    older.meta = { ...older.meta, stub: true, planOld: true };
    cut = true;
  }
  return cut;
}

/** A result as the model gets it: whole, or (once cut) its stand-in plus what must be kept. @param {Stored} message */
function resultText(message) {
  if (message.meta?.planOld) return PLAN.superseded + (message.meta.keep ? "\n\n" + message.meta.keep : "");
  if (message.meta?.stub && message.meta.stepDone) return PLAN.stub(message.meta.stepDone, message.meta.summary) + (message.meta.keep ? "\n\n" + message.meta.keep : "");
  if (!message.meta?.stub) return message.content;
  return TEXTS.stub(message.meta.summary) + (message.meta.keep ? "\n\n" + message.meta.keep : "");
}

/**
 * Cut older large results to one-line stand-ins once the chat's results pass the budget (sticky).
 * Earlier tasks' results are cut past KEEP_RESULTS_TOKENS. This task's stay whole: cutting them mid-task made
 * models that re-read what was cut go round in circles (an A/B run: 0 of 5 finished, against 5 of 5 left whole,
 * for about the same tokens). Only a runaway task, past IN_TASK_CEILING × the compaction limit, has its oldest
 * results cut; the newest two steps' results are never cut, as the model reads across a step or two.
 */
function trim(/** @type {Chat} */ chat, compactAt = 100_000) {
  const start = chat.compaction ? chat.compaction.through : 0;
  let latest = chat.messages.length - 1;
  while (latest >= start && chat.messages[latest].role === "tool") latest--;
  const turn = lastUser(chat);
  for (let index = latest - 1; index > Math.max(start, turn); index--) {
    if (chat.messages[index].role === "assistant" && chat.messages[index].tool_calls?.length) { latest = index; break; }
  }
  const fresh = new Set(chat.messages.slice(latest + 1));
  // Older states of a plan the newest holds all of: nothing is lost by leaving them out.
  const superseded = supersedePlans(chat, start);
  const ratio = chat.tokenRatio || 1;
  const thisTask = new Set(chat.messages.slice(Math.max(start, taskStart(chat))));
  const ceiling = compactAt * IN_TASK_CEILING;
  // A planned task trims as any task does: what it read stays whole (cutting it mid-task makes models read it again).
  // Only once this task's results pass the in-task ceiling are finished steps' results cut, first, their notes standing in.
  const inTask = chat.messages.filter((m) => thisTask.has(m) && m.role === "tool" && !m.meta?.stub).reduce((sum, m) => sum + estimate(m.content), 0) * ratio;
  const finished = inTask > ceiling && trimFinishedSteps(chat, new Set(chat.messages.slice(newestReply(chat) + 1)));
  const stepped = finished || superseded;
  const results = chat.messages.slice(start).filter((m) => m.role === "tool" && !m.meta?.stub);
  const whole = results.reduce((sum, m) => sum + estimate(m.content), 0) * ratio;
  if (whole <= KEEP_RESULTS_TOKENS + TRIM_SLACK_TOKENS) return stepped;
  let kept = 0;
  let cut = false;
  for (let index = results.length - 1; index >= 0; index--) {
    const message = results[index];
    kept += estimate(message.content) * ratio;
    const budget = thisTask.has(message) ? ceiling : KEEP_RESULTS_TOKENS;
    if (!fresh.has(message) && kept > budget && message.content.length > STUB_MIN_CHARS) {
      message.meta.stub = true;
      cut = true;
    }
  }
  return cut || stepped;
}

/** Where the newest reply (with calls) is: its results come after it, unseen by the model so far. @param {Chat} chat */
function newestReply(chat) {
  let index = chat.messages.length - 1;
  while (index >= 0 && chat.messages[index].role === "tool") index--;
  return index;
}

/** A tool's output, capped (head and tail) so no single result can swamp the chat. @param {string} text */
function capped(text) {
  if (text.length <= MAX_RESULT_CHARS) return text;
  const head = Math.floor(MAX_RESULT_CHARS * 0.8);
  const tail = MAX_RESULT_CHARS - head;
  return text.slice(0, head) + "\n\n" + TEXTS.resultCut(text.length - head - tail) + "\n\n" + text.slice(-tail);
}

/** A call's arguments checked against its definition. */
function parseArguments(/** @type {string} */ name, /** @type {string} */ text, /** @type {boolean} */ cutOff) {
  const definition = Object.hasOwn(TOOLS, name) ? TOOLS[/** @type {keyof TOOLS} */ (name)] : null;
  if (!definition) return { args: {}, problem: TEXTS.unknownTool(name, Object.keys(TOOLS)) };
  let args;
  try {
    if (cutOff && !(text && text.trim())) return { args: {}, problem: TEXTS.cutOff };
    args = text && text.trim() ? JSON.parse(text) : {};
  } catch {
    return { args: {}, problem: cutOff ? TEXTS.cutOff : TEXTS.badArguments };
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return { args: {}, problem: TEXTS.badArguments };
  const [, properties, required] = definition;
  // Every missing argument at once, and any the tool doesn't take (old_string for old_text): one retry, not several.
  const ignored = Object.keys(args).filter((arg) => !Object.hasOwn(/** @type {any} */ (properties), arg));
  const absent = required.filter((arg) => args[arg] === undefined || args[arg] === null
    || (arg !== "new_text" && arg !== "content" && args[arg] === ""));
  if (absent.length) return { args, ignored, problem: TEXTS.missing(name, absent, ignored) };
  for (const [arg, value] of Object.entries(args)) {
    const schema = /** @type {any} */ (properties)[arg];
    if (!schema || value === null || value === undefined) continue;
    const type = schema.type;
    let ok = type === "integer" ? Number.isInteger(value) || (typeof value === "string" && /^\d+$/.test(value))
      : type === "boolean" ? typeof value === "boolean" || value === "true" || value === "false"
      : type === "array" ? Array.isArray(value) || (typeof value === "string" && /^\s*\[/.test(value))
      : typeof value === "string" || typeof value === "number";
    if (!ok) return { args, problem: TEXTS.wrongType(name, arg, type) };
    if (type === "integer" && typeof value === "string") args[arg] = Number(value);
    if (type === "boolean" && typeof value === "string") args[arg] = value === "true";
    if (type === "array" && typeof value === "string") {
      // Some models send a list as JSON text: read it, or say so.
      try { args[arg] = JSON.parse(value); } catch { return { args, problem: TEXTS.wrongType(name, arg, type) }; }
      if (!Array.isArray(args[arg])) return { args, problem: TEXTS.wrongType(name, arg, type) };
    }
    if (type === "string" && typeof value === "number") args[arg] = String(value);
  }
  return { args, ignored, problem: "" };
}

/** An id not used yet in this chat (some servers number calls call_0, call_1… every turn). @param {string} id @param {Set<string>} used */
function unique(id, used) {
  let out = id;
  for (let n = 2; used.has(out); n++) out = `${id}_${n}`;
  used.add(out);
  return out;
}

/** A call's identity for spotting repeats: the same arguments in any key order. @param {string} name @param {any} args */
function fingerprint(name, args) {
  return name + "\u0000" + JSON.stringify(Object.keys(args).sort().map((key) => [key, args[key]]));
}

/** A short label for a step line: "read_file src/a.js". */
function labelOf(/** @type {string} */ name, /** @type {any} */ args) {
  const what = args.name ? `${args.name}${args.find === "references" ? " (uses)" : ""} in ${args.path}`
    : args.from ? `${args.from} → ${args.to ?? "?"}` : args.docs ? `docs: ${args.query}` : args.path || args.glob || args.query || "";
  const shown = String(what).replace(/\s+/g, " ").trim();
  return shown ? `${name} ${shown.length > 80 ? shown.slice(0, 79) + "…" : shown}` : name;
}

/** The start of a chat for naming it: what you typed and the start of each answer (no tools, no files). @param {Stored[]} messages */
function titleExcerpt(messages) {
  const lines = [];
  let used = 0;
  for (const message of messages) {
    let text = "";
    let speaker = "";
    let cap = 0;
    if (message.role === "user" && !message.meta?.resume) { text = message.meta?.typed ?? message.content; speaker = "Me"; cap = 600; }
    else if (message.role === "assistant" && !message.tool_calls?.length && message.content.trim()) { text = message.content; speaker = "Assistant"; cap = 300; }
    else continue;
    text = text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (text.length > cap) text = text.slice(0, cap) + "…";
    const room = TITLE_EXCERPT_CHARS - used;
    if (room <= 40) break;
    const line = `${speaker}: ${text}`.slice(0, room);
    lines.push(line);
    used += line.length;
  }
  return lines.join("\n");
}

/** A usable title from the model's reply (two to eight words, no quotes or "Title:"), or "" to keep the old one. @param {string} reply */
function cleanTitle(reply) {
  let line = reply.split(/\r?\n/).find((l) => l.trim()) ?? "";
  line = line.replace(/^\s*(?:(?:#+|\*+|_+)\s*|title\s*:\s*)+/i, "");
  line = line.trim().replace(/^[*_`"'“”‘’]+|[*_`"'“”‘’]+$/g, "").trim();
  line = line.replace(/[.!?:;,]+$/, "").replace(/\s+/g, " ").trim();
  const words = line ? line.split(" ").length : 0;
  return line && line.length <= 60 && words >= 1 && words <= 8 ? line : "";
}

function titleFrom(/** @type {string} */ text) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? line.slice(0, 59) + "…" : line || "New chat";
}

/** "default" sends nothing. @param {string | undefined} value */
function effortOf(value) {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function estimateMessages(/** @type {any[]} */ messages) {
  return messages.reduce((sum, m) => sum + estimate(m.content) + estimate(JSON.stringify(m.tool_calls || "")) + 4, 0);
}

/** One stored message's size as it's sent (a cut result as its stand-in). @param {Stored} message */
function sizeOf(message) {
  return estimate(message.role === "tool" ? resultText(message) : message.content)
    + estimate(JSON.stringify(message.tool_calls?.map(shortCall) || "")) + 4; // as earlier turns' calls are sent
}

/**
 * The older part of a chat as plain text, for the summary request. What you said (and the earlier
 * summary) is never dropped to make room; tool calls and results are shortened, and if it's still too
 * long the oldest steps go first. @param {Chat} chat @param {number} start @param {number} end @param {number} budget
 */
function transcriptOf(chat, start, end, budget) {
  /** @type {{text: string, yours: boolean}[]} */
  const parts = [];
  const short = (/** @type {string} */ text, /** @type {number} */ max) =>
    text.length > max ? text.slice(0, Math.floor(max * 0.8)) + "\n…(shortened)…\n" + text.slice(-Math.floor(max * 0.2)) : text;
  if (chat.compaction) parts.push({ text: `(Summary of what came before:)\n${chat.compaction.summary}`, yours: true });
  for (const message of chat.messages.slice(start, end)) {
    if (message.role === "user") parts.push({ text: `Me: ${short(message.content, 6000)}`, yours: true });
    else if (message.role === "assistant") {
      if (message.content.trim()) parts.push({ text: `You: ${short(message.content.trim(), 3000)}`, yours: false });
      for (const call of message.tool_calls || []) {
        parts.push({ text: `You called ${call.function.name} ${short(call.function.arguments, 600)}`, yours: false });
      }
    } else if (message.role === "tool") {
      const whole = !message.meta?.stub && message.content.length <= 1500;
      parts.push({ text: `Result: ${message.meta?.stub ? `(${message.meta.summary})` : short(message.content, 1500)}`, yours: false });
      // A cut or shortened result may have lost your note or a folder's instructions: they go in on their own.
      if (message.meta?.keep && !whole) parts.push({ text: message.meta.keep, yours: true });
    }
  }
  let total = parts.reduce((sum, part) => sum + part.text.length + 2, 0);
  for (let index = 0; index < parts.length && total > budget; index++) {
    if (parts[index].yours) continue;
    total -= parts[index].text.length - 1;
    parts[index].text = "…";
  }
  let text = parts.filter((part, index) => part.text !== "…" || parts[index - 1]?.text !== "…").map((part) => part.text).join("\n\n");
  if (text.length > budget) text = "…(the earliest part is left out)…\n\n" + text.slice(-budget); // only your own words left
  return text;
}

/** @param {number} ms @param {AbortSignal} signal */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Cancelled()); }, { once: true });
  });
}

module.exports = { Engine, outbound, trim, parseArguments, labelOf, estimate, transcriptOf, cleanTitle, titleExcerpt, breakdown, repeatReads, tokenReport,
  KEEP_RESULTS_TOKENS, TRIM_SLACK_TOKENS };
