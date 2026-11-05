// @ts-check
"use strict";
/**
 * Solder's diagnostics log: names and numbers only (tool names, timings, token counts, HTTP status, finish
 * reasons), never paths, file contents, prompts, keys or endpoints. It shows in the "Solder" output channel and
 * the newest lines are kept for Copy diagnostics, which support emails can carry.
 */
const MAX_LINES = 500;

class Log {
  /** @param {{appendLine: (line: string) => void}} channel */
  constructor(channel) {
    this.channel = channel;
    /** @type {string[]} */
    this.lines = [];
  }

  /** @param {string} line */
  write(line) {
    const stamped = `${new Date().toISOString().slice(11, 19)} ${line}`;
    this.lines.push(stamped);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    this.channel.appendLine(stamped);
  }

  /** One engine event, as a line (or nothing, for the chatty ones). @param {any} event */
  event(event) {
    const n = (/** @type {number} */ x) => Number(x || 0).toLocaleString("en-US");
    const s = (/** @type {number} */ ms) => (Number(ms || 0) / 1000).toFixed(1) + "s";
    switch (event.type) {
      case "reply": this.write(`reply ${event.model} ${s(event.ms)} prompt=${n(event.prompt)} out=${n(event.completion)} finish=${event.finish} calls=${event.calls}`); break;
      case "ran": this.write(`tool ${event.name} ${s(event.ms)} ${event.failed ? "failed" : "ok"} ${n(event.chars)} chars`); break;
      case "retrying": this.write(`retrying (${event.why === "empty" ? "empty reply" : "connection"})`); break;
      case "compacting": this.write("compacting"); break;
      case "compacted": this.write(`compacted through message ${event.through}`); break;
      case "compaction-failed": this.write(`compaction failed: ${event.message}`); break;
      case "approval": this.write(`approval asked for ${event.name}`); break;
      case "approval-done": this.write(`approval ${event.decision}`); break;
      case "stopped": this.write("stopped"); break;
      case "error": this.write(`error: ${event.message}${event.exhausted ? " (allowance used up)" : ""}`); break;
      case "done": this.write(`done${event.limit ? ` (step limit ${event.limit})` : ""}`); break;
      case "titled": this.write("titled"); break;
    }
  }

  /** @param {number} [count] */
  recent(count = 200) {
    return this.lines.slice(-count);
  }
}

module.exports = { Log };
