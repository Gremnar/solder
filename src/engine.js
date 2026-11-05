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

const { Cancelled } = require("./gateway.js");
const { READ_ONLY, TEXTS, TOOLS, timeNote, toolDefinitions } = require("./prompt.js");

const CHARS_PER_TOKEN = 4;
/** Within the chat, the newest results stay whole up to about this many tokens… */
const KEEP_RESULTS_TOKENS = 30_000;
/** …and may run this far past it before the older ones are cut, all at once (a stable prefix for longer). */
const TRIM_SLACK_TOKENS = 10_000;
/** One reply's results together: past this (in characters, scaled by the chat's token ratio), its other reads wait. */
const MAX_BATCH_RESULT_CHARS = 90_000;
/** Compaction runs only when what it can summarise is at least this share of the limit. */
const MIN_COMPACT_SHARE = 0.15;
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
 *            compaction: {through: number, summary: string} | null, usage: {tokens: number},
 *            effort?: string, model?: string, agentsSeen?: string[], tokenRatio?: number,
 *            titleSource?: "auto" | "user", titledAt?: number}} Chat
 * @typedef {{output: string, summary: string, failed?: boolean, change?: any, keep?: string, ms?: number}} ToolResult
 *   keep: text that rides with the output but isn't output (a folder's AGENTS.md): never cut away
 * @typedef {{
 *   systemPrompt(chat: Chat): Promise<string>,
 *   runTool(name: string, args: any, ctx: {chat: Chat, signal: AbortSignal}): Promise<ToolResult>,
 *   needsApproval(name: string, args: any): string | null,
 *   save(chat: Chat): Promise<void>,
 * }} Host
 * @typedef {{model: string, effort?: string, compactAt: number, maxRounds: number}} Settings
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
  _spend(chat, usage, credits) {
    const used = usage?.total_tokens || ((usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0));
    this.answerTokens += used;
    chat.usage.tokens += used;
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
      const stoppedSteps = chat.messages.slice(tail + 1).some((m) => m.content === TEXTS.stoppedRunning || m.content.startsWith(TEXTS.notRunStopped));
      if (last.role === "assistant" || summarisedAll || stoppedSteps) {
        // It stopped mid-answer (or all of it is in the recap): ask it to carry on, since the history
        // can't end with its own turn.
        chat.messages.push({ role: "user", content: `${timeNote(this.now())}\n\n${stoppedSteps ? TEXTS.resumeStopped : TEXTS.resume}`,
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
          resumable: chat.messages.length > 0, exhausted });
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
    for (;;) {
      // Before every step, not just a new message, so a long task can't run far past the limit. Only
      // earlier turns are summarised: this one's calls carry thought signatures some models check.
      await this._compactIfDue(chat, signal, lastUser(chat));
      trim(chat, settings.compactAt);
      const system = await this.host.systemPrompt(chat);
      const messages = outbound(chat, system);
      this.emit({ type: "thinking", chat: chat.id });
      const reply = await this._patient(chat, { model: chat.model || settings.model, messages, tools,
        effort: effortOf(chat.effort || settings.effort), signal });
      // The server's count over our estimate, so compaction triggers on real tokens (code runs about 30% over).
      const sentEstimate = estimateMessages(messages) + estimate(JSON.stringify(tools));
      if (reply.usage?.prompt_tokens > 0 && sentEstimate > 0) {
        chat.tokenRatio = Math.min(2, Math.max(0.75, reply.usage.prompt_tokens / sentEstimate));
      }
      this._spend(chat, reply.usage, reply.credits);
      this.emit({ type: "reply", chat: chat.id, model: chat.model || settings.model, ms: reply.ms ?? 0, prompt: reply.usage?.prompt_tokens || 0,
        completion: reply.usage?.completion_tokens || 0, finish: reply.finishReason || "", calls: reply.calls.length });
      /** @type {Stored} */
      const assistant = { role: "assistant", content: reply.content };
      if (reply.calls.length) {
        const used = new Set(chat.messages.flatMap((m) => (m.tool_calls || []).map((/** @type {any} */ c) => c.id)));
        assistant.tool_calls = reply.calls.map((/** @type {any} */ call) => ({ id: unique(call.id, used), type: "function",
          function: { name: call.name, arguments: call.arguments }, ...(call.extra ? { extra_content: call.extra } : {}) }));
      }
      chat.messages.push(assistant);
      await this._save(chat);
      this.emit({ type: "message", chat: chat.id });
      if (!reply.calls.length) {
        this.emit({ type: "done", chat: chat.id });
        this._title(chat);
        return;
      }
      rounds += 1;
      if (rounds > settings.maxRounds) {
        this._settle(chat, TEXTS.notRunLimit);
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
   * Run one reply's calls in order. Each gets its own tool message.
   * @param {Chat} chat @param {Stored} assistant @param {boolean} cutOff @param {number} roundsLeft @param {AbortSignal} signal
   */
  async _batch(chat, assistant, cutOff, roundsLeft, signal) {
    const calls = assistant.tool_calls || [];
    const limit = calls.slice(0, MAX_READ_BATCH).every((call) => READ_ONLY.has(call.function.name)) ? MAX_READ_BATCH : MAX_BATCH;
    const seen = new Set();
    /** @type {string | null} why the rest won't run */
    let skip = null;
    /** @type {Stored[]} */
    const added = [];
    let batchChars = 0;
    const batchLimit = MAX_BATCH_RESULT_CHARS / Math.max(1, chat.tokenRatio || 1);
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
      } else if (index >= limit) {
        result = { output: TEXTS.notRunBatch(limit), summary: "Not run: " + label, failed: true };
      } else if (READ_ONLY.has(name) && batchChars >= batchLimit) {
        result = { output: TEXTS.notRunFull, summary: "Not run: " + label, failed: true };
      } else if (parsed.problem) {
        result = { output: parsed.problem, summary: "Not run: " + label, failed: true };
      } else if (seen.has(fingerprint(name, parsed.args))) {
        result = { output: TEXTS.repeat, summary: "Not run again: " + label, failed: true };
      } else {
        seen.add(fingerprint(name, parsed.args));
        result = await this._runOne(chat, call.id, name, parsed.args, label, signal);
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
          ...(result.change ? { change: result.change } : {}) } };
      chat.messages.push(message);
      added.push(message);
      await this._save(chat);
      this.emit({ type: "message", chat: chat.id });
    }
    // Notes ride on the last result: the step limit near, and anything you typed meanwhile.
    const last = added[added.length - 1];
    if (last) {
      const notes = [];
      if (roundsLeft <= WRAP_UP_ROUNDS) notes.push(TEXTS.wrapUp(roundsLeft));
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
    /** @type {string} */ label, /** @type {AbortSignal} */ signal) {
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
      const work = this.host.runTool(name, args, { chat, signal });
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
      try {
        return await this.client.reply({ ...request, onText: (/** @type {string} */ text) => {
          shown += text;
          if (!side) this.emit({ type: "delta", chat: chat.id, text });
        } });
      } catch (error) {
        const e = /** @type {any} */ (error);
        if (e.usage) this._spend(chat, e.usage, e.credits); // an empty reply was still billed
        const stopped = error instanceof Cancelled || request.signal.aborted;
        const partial = e.partial || shown;
        if (partial && !side) {
          chat.messages.push({ role: "assistant", content: partial, meta: { incomplete: true } });
          throw stopped ? new Cancelled() : error;
        }
        if (stopped) throw new Cancelled();
        const last = request.messages[request.messages.length - 1];
        if (e.empty) {
          if (!e.transient || emptyTried || last.role !== "tool") throw error;
          emptyTried = true;
          request = { ...request, messages: [...request.messages.slice(0, -1), { ...last, content: last.content + TEXTS.emptyReply }] };
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
    const focus = String(options.focus || "").trim().slice(0, MAX_FOCUS_CHARS);
    this.emit({ type: "compacting", chat: chat.id });
    let reply;
    try {
      const transcript = transcriptOf(chat, start, cut, Math.floor(settings.compactAt * CHARS_PER_TOKEN * 0.8));
      reply = await this._patient(chat, { model: chat.model || settings.model, signal, effort: undefined, messages: [
        { role: "system", content: TEXTS.compactionSystem },
        { role: "user", content: `${TEXTS.compactionTranscript}\n\n${transcript}\n\n${TEXTS.compaction}` +
          (focus ? `\n\n${TEXTS.compactionFocus(focus)}` : "") }] }, true);
    } catch (error) {
      if (error instanceof Cancelled || signal.aborted) throw new Cancelled();
      this.emit({ type: "compaction-failed", chat: chat.id, message: error instanceof Error ? error.message : String(error) });
      return "failed";
    }
    this._spend(chat, reply.usage, reply.credits);
    if (!reply.content.trim()) return force ? "failed" : "skipped";
    chat.compaction = { through: cut, summary: reply.content.trim() };
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
    Promise.resolve().then(() => this.client.reply({ model: chat.model || settings.model, signal: controller.signal,
      messages: [{ role: "user", content: TEXTS.titleRequest(excerpt) }] }))
      .then(async (/** @type {any} */ reply) => {
        if (reply.usage) { this._spend(chat, reply.usage, reply.credits); await this._save(chat); }
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

/** Where the current turn starts: the latest message you typed (or Resume's "carry on"). @param {Chat} chat */
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

/** A result as the model gets it: whole, or (once cut) its stand-in plus what must be kept. @param {Stored} message */
function resultText(message) {
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
  const results = chat.messages.slice(start).filter((m) => m.role === "tool" && !m.meta?.stub);
  const ratio = chat.tokenRatio || 1;
  const whole = results.reduce((sum, m) => sum + estimate(m.content), 0) * ratio;
  if (whole <= KEEP_RESULTS_TOKENS + TRIM_SLACK_TOKENS) return false;
  const fresh = new Set(chat.messages.slice(latest + 1));
  const thisTask = new Set(chat.messages.slice(Math.max(start, turn)));
  const ceiling = compactAt * IN_TASK_CEILING;
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
  return cut;
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
  for (const arg of required) {
    if (args[arg] === undefined || args[arg] === null || (arg !== "new_text" && arg !== "content" && args[arg] === "")) {
      return { args, problem: TEXTS.missing(name, arg) };
    }
  }
  for (const [arg, value] of Object.entries(args)) {
    const schema = /** @type {any} */ (properties)[arg];
    if (!schema || value === null || value === undefined) continue;
    const type = schema.type;
    let ok = type === "integer" ? Number.isInteger(value) || (typeof value === "string" && /^\d+$/.test(value))
      : type === "boolean" ? typeof value === "boolean" || value === "true" || value === "false"
      : typeof value === "string" || typeof value === "number";
    if (!ok) return { args, problem: TEXTS.wrongType(name, arg, type) };
    if (type === "integer" && typeof value === "string") args[arg] = Number(value);
    if (type === "boolean" && typeof value === "string") args[arg] = value === "true";
    if (type === "string" && typeof value === "number") args[arg] = String(value);
  }
  return { args, problem: "" };
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
    + estimate(JSON.stringify(message.tool_calls || "")) + 4;
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

module.exports = { Engine, outbound, trim, parseArguments, labelOf, estimate, transcriptOf, cleanTitle, titleExcerpt,
  KEEP_RESULTS_TOKENS, TRIM_SLACK_TOKENS };
