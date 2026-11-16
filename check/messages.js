// @ts-nocheck
"use strict";
// One of Solder's checks inside a real VS Code: run with `node check/run.js messages` (see check/README.md).
// Runs inside a real VS Code extension host: Edit and Delete on your messages, with VS Code's own confirm dialog
// (answered here), the chat saved without them, and Edit's text sent back to the box.
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
let REPO = path.resolve(__dirname, "..");
const T = process.env.SOLDER_CHECK_DIR || path.join(require("node:os").tmpdir(), "solder-check");
const LOG = path.join(T, "messages.log");
const log = (...a) => fs.appendFileSync(LOG, a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ") + "\n");
const check = (name, ok, detail = "") => log(ok ? "PASS" : "FAIL", name, typeof detail === "string" ? detail : JSON.stringify(detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async function () {
  fs.writeFileSync(LOG, `=== messages ${new Date().toISOString()}\n`);
  try { await Promise.race([main(), sleep(60000).then(() => log("!!! timed out: something is waiting for an answer"))]); } catch (e) { log("!!! harness", String(e && e.stack || e)); }
  log("=== end");
};

function stub(owner, name, fn) {
  const old = owner[name];
  try { owner[name] = fn; } catch { return null; }
  if (owner[name] !== fn) return null;
  return () => { owner[name] = old; };
}

const call = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

async function main() {
  const ext = vscode.extensions.getExtension("gremnar.solder");
  await ext.activate();
  check("activates", ext.isActive);
  const loaded = Object.keys(require.cache).filter((key) => /[\\/]src[\\/]policy\.js$/i.test(key));
  if (loaded.length) REPO = path.dirname(path.dirname(loaded[0]));
  const { SolderPanel } = require(path.join(REPO, "src", "panel.js"));
  const own = require("node:module").createRequire(path.join(REPO, "src", "panel.js"))("vscode");
  const asked = [];
  let answer;
  const undo = [stub(own.window, "showWarningMessage", async (text, options, ...buttons) => { asked.push({ text: String(text), modal: !!options?.modal, buttons }); return answer; })];
  check("VS Code's prompts can be stood in for", undo.every(Boolean));
  try {
    const panel = new SolderPanel({ secrets: { get: async () => "", store: async () => {}, delete: async () => {} }, subscriptions: [], extension: ext,
      globalStorageUri: vscode.Uri.file(path.join(T, "gs-messages")), storageUri: undefined, extensionUri: ext.extensionUri }, { appendLine() {}, show() {} });
    panel.refreshModels = async () => {};
    const posted = [];
    panel.view = { webview: { postMessage: (m) => { posted.push(m); return Promise.resolve(true); } }, visible: true };
    const fill = () => {
      panel.chat.messages = [
        { role: "user", content: "(t)\n\nfirst", meta: { typed: "first" } },
        { role: "assistant", content: "One." },
        { role: "user", content: "(t)\n\nthe wrong paste", meta: { typed: "the wrong paste" } },
        { role: "assistant", content: "", tool_calls: [call("a", "read_file", { path: "a.js" })] },
        { role: "tool", tool_call_id: "a", content: "A", meta: {} },
        { role: "assistant", content: "Two." },
        { role: "user", content: "(t)\n\nthird", meta: { typed: "third" } },
        { role: "assistant", content: "Three." },
      ];
    };
    fill();
    await panel.store.save(panel.chat);
    const saved = () => panel.store.load(panel.chat.id)?.messages.map((m) => m.meta?.typed ?? m.content) ?? [];

    // ---- Delete: asks, and the answer decides
    answer = undefined;
    await panel.onMessage({ type: "deleteMessage", index: 2 });
    check("Delete asks first (a modal), and Cancel changes nothing", asked.length === 1 && asked[0].modal && /Delete this message and its reply/.test(asked[0].text) && panel.chat.messages.length === 8, asked);
    answer = "Delete";
    await panel.onMessage({ type: "deleteMessage", index: 2 });
    check("Delete takes out the message and its turn, and the chat is saved that way", JSON.stringify(saved()) === JSON.stringify(["first", "One.", "third", "Three."]), saved());

    // ---- Edit: the last message goes without asking; an earlier one asks, naming what goes with it
    asked.length = 0;
    posted.length = 0;
    await panel.onMessage({ type: "editMessage", index: 2 });
    check("Edit on the last message doesn't ask, takes it and its reply, and puts it back in the box", asked.length === 0 && JSON.stringify(saved()) === JSON.stringify(["first", "One."])
      && posted.some((m) => m.type === "editText" && m.text === "third"), [asked, saved(), posted.filter((m) => m.type === "editText")]);
    fill();
    await panel.store.save(panel.chat);
    answer = "Edit";
    await panel.onMessage({ type: "editMessage", index: 0 });
    check("Edit on an earlier message says how many go with it, then takes them all", /The 2 messages after it, and their replies/.test(asked.at(-1)?.text || "") && saved().length === 0, [asked.at(-1), saved()]);

    // ---- what can't be changed
    fill();
    panel.chat.compaction = { through: 2, summary: "S" };
    asked.length = 0;
    await panel.onMessage({ type: "deleteMessage", index: 0 });
    check("a summarised message can't be changed", panel.chat.messages.length === 8 && asked.length === 0);
    await panel.onMessage({ type: "deleteMessage", index: 1 });
    check("... nor a reply (only your messages)", panel.chat.messages.length === 8);
  } finally {
    for (const back of undo) back?.();
  }
}
