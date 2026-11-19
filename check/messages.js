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

    // ---- Paste in terminal: into a terminal, never run (no Enter), the clipboard put back
    const typed = [];
    const fakeTerminal = { name: "Solder", show() {}, sendText(text, run) { typed.push([text, run]); }, dispose() {} };
    const pastes = [];
    const restore = [
      stub(own.window, "createTerminal", () => fakeTerminal),
      stub(own.commands, "executeCommand", async (id, ...rest) => { if (id === "workbench.action.terminal.paste") { pastes.push(await own.env.clipboard.readText()); return; } return vscode.commands.executeCommand(id, ...rest); }),
    ];
    try {
      if (!own.window.activeTerminal && !own.window.terminals.length) {
        await panel.onMessage({ type: "pasteInTerminal", text: "Get-ChildItem -Recurse\n\n" });
        check("one line is typed into the terminal without Enter, trailing newlines left off", JSON.stringify(typed) === JSON.stringify([["Get-ChildItem -Recurse", false]]), typed);
        await own.env.clipboard.writeText("what you had copied");
        await panel.onMessage({ type: "pasteInTerminal", text: "$a = 1\nWrite-Output $a\n" });
        check("several lines go through VS Code's own terminal paste (its multi-line warning), still without Enter", JSON.stringify(pastes) === JSON.stringify(["$a = 1\nWrite-Output $a"]), pastes);
        await sleep(1200);
        check("... and your clipboard is put back", await own.env.clipboard.readText() === "what you had copied");
      } else log("SKIP Paste in terminal: this window already has a terminal");
    } finally {
      for (const back of restore) back?.();
    }

    // ---- attachments: a long paste and text files go above the box as chips, then with the message
    {
      const told = [];
      const quiet = stub(own.window, "showInformationMessage", async (text) => { told.push(String(text)); return undefined; });
      const asked2 = [];
      const realAsk = panel.engine.ask;
      panel.engine.ask = async (chat, text, extra) => { asked2.push({ text, extra }); };
      try {
        const dir = path.join(T, "attach");
        fs.mkdirSync(dir, { recursive: true });
        const small = path.join(dir, "app.log");
        const big = path.join(dir, "big.log");
        const binary = path.join(dir, "data.bin");
        fs.writeFileSync(small, Array.from({ length: 50 }, (_, i) => `line ${i + 1}: ok`).join("\r\n") + "\r\n");
        fs.writeFileSync(big, Array.from({ length: 4000 }, (_, i) => `entry ${i + 1}: something happened here`).join("\n"));
        fs.writeFileSync(binary, Buffer.from([1, 2, 0, 3, 0, 0, 4]));
        const log = Array.from({ length: 120 }, (_, i) => `ERR ${i}`).join("\n");
        panel.chat.messages = [];
        panel.chat.compaction = null;

        panel.attachPaste(log + "\n\n");
        check("a long paste becomes an attachment, with how long it is", panel.attachments.length === 1 && panel.attachments[0].lines === 120 && panel.attachments[0].kind === "paste", panel.attachments.map((a) => [a.kind, a.lines]));
        await panel.attachFiles([vscode.Uri.file(small), vscode.Uri.file(big), vscode.Uri.file(binary), vscode.Uri.file(small)]);
        check("text files attach: a short one whole, a long one by its path; a binary one is refused, and none twice",
          JSON.stringify(panel.attachments.map((a) => [a.kind, a.name, a.lines])) === JSON.stringify([["paste", "Pasted", 120], ["file", "app.log", 50], ["path", "big.log", 4000]])
          && /data\.bin isn't a text file/.test(told.join(" ")), [panel.attachments.map((a) => [a.kind, a.name, a.lines]), told]);
        check("... picked but not sent, the long one is still asked about like any file outside the workspace", panel.tools.needsApproval("read_file", { path: big }) !== null
          && panel.tools.needsApproval("read_file", { path: binary }) !== null);
        await panel.onMessage({ type: "removeAttachment", id: panel.attachments[1].id });
        check("an attachment can be taken off again", panel.attachments.length === 2 && panel.attachments.every((a) => a.name !== "app.log"));
        await panel.attachFiles([vscode.Uri.file(small)]);

        await panel.send({ text: "What went wrong?" });
        const sent = asked2[0];
        check("they go with the message: whole text in fences after it, the long file by path", !!sent && sent.text === "What went wrong?"
          && sent.extra.context.includes("(Pasted text, 120 lines:)\n```\nERR 0\n") && sent.extra.context.includes("(Attached file app.log, 50 lines:)\n```\nline 1: ok\nline 2: ok")
          && /\(Attached file .*big\.log, 4,000 lines: too long to send whole\./.test(sent.extra.context) && !sent.extra.context.includes("entry 2000"), sent && sent.extra.context.slice(0, 300));
        check("... as chips on the message, kept with it, and cleared from the box", JSON.stringify(sent.extra.chips.slice(-3)) === JSON.stringify(["Pasted · 120 lines", "big.log · 4,000 lines", "app.log · 50 lines"])
          && sent.extra.attachments.length === 3 && panel.attachments.length === 0, [sent.extra.chips, panel.attachments.length]);
        check("... and once sent, the long one can be read without asking", panel.tools.needsApproval("read_file", { path: big }) === null);

        panel.attachPaste(log);
        await panel.send({ text: "" });
        check("something attached and nothing typed still goes, with a line saying so", asked2.length === 2 && asked2[1].text === "(See what I've attached.)", asked2[1]?.text);
        await panel.send({ text: "" });
        check("nothing attached and nothing typed doesn't", asked2.length === 2);

        // Edit puts a message's attachments back above the box with its words.
        panel.chat.messages = [{ role: "user", content: "(t)\n\nWhat went wrong?\n\n(Pasted text…)", meta: { typed: "What went wrong?", chips: ["Pasted · 120 lines"], attachments: sent.extra.attachments } },
          { role: "assistant", content: "It broke." }];
        posted.length = 0;
        await panel.onMessage({ type: "editMessage", index: 0 });
        check("Edit brings a message's attachments back with its words", panel.attachments.length === 3 && panel.attachments[0].text.startsWith("ERR 0")
          && posted.some((m) => m.type === "editText" && m.text === "What went wrong?"), [panel.attachments.length, posted.filter((m) => m.type === "editText")]);
        panel.attachments = [];
      } finally {
        panel.engine.ask = realAsk;
        quiet?.();
      }
    }

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
