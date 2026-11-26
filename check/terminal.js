// @ts-nocheck
"use strict";
// One of Solder's checks inside a real VS Code: run with `node check/run.js terminal` (see check/README.md).
// Paste in terminal into a real Windows PowerShell: several lines go in as one command (`. { … }`), wait for Enter,
// and run as a script would, an `else` on its own line included. Pasted line by line, PowerShell runs the `if { }`
// as soon as its line ends, and the `else` line then fails on its own.
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
let REPO = path.resolve(__dirname, "..");
const T = process.env.SOLDER_CHECK_DIR || path.join(require("node:os").tmpdir(), "solder-check");
const LOG = path.join(T, "terminal.log");
const log = (...a) => fs.appendFileSync(LOG, a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ") + "\n");
const check = (name, ok, detail = "") => log(ok ? "PASS" : "FAIL", name, typeof detail === "string" ? detail : JSON.stringify(detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async function () {
  fs.writeFileSync(LOG, `=== terminal ${new Date().toISOString()}\n`);
  try { await Promise.race([main(), sleep(90000).then(() => log("!!! timed out: something is waiting for an answer"))]); } catch (e) { log("!!! harness", String(e && e.stack || e)); }
  log("=== end");
};

/** A file the terminal wrote, or null. */
const read = (file) => { try { return fs.readFileSync(file, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\n$/, ""); } catch { return null; } };
async function until(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(200); } return fn(); }

async function main() {
  const ext = vscode.extensions.getExtension("gremnar.solder");
  await ext.activate();
  check("activates", ext.isActive);
  if (process.platform !== "win32") { log("NOTE Windows PowerShell is only on Windows: nothing to check here"); return; }
  const loaded = Object.keys(require.cache).filter((key) => /[\\/]src[\\/]policy\.js$/i.test(key));
  if (loaded.length) REPO = path.dirname(path.dirname(loaded[0]));
  const { SolderPanel } = require(path.join(REPO, "src", "panel.js"));
  const own = require("node:module").createRequire(path.join(REPO, "src", "panel.js"))("vscode");
  const warned = [];
  const old = own.window.showWarningMessage;
  own.window.showWarningMessage = async (text) => { warned.push(String(text)); return undefined; };
  const term = vscode.window.createTerminal({ name: "PowerShell", shellPath: "powershell.exe", shellArgs: ["-NoLogo", "-NoProfile"] });
  try {
    const panel = new SolderPanel({ secrets: { get: async () => "", store: async () => {}, delete: async () => {} }, subscriptions: [], extension: ext,
      globalStorageUri: vscode.Uri.file(path.join(T, "gs-terminal")), storageUri: undefined, extensionUri: ext.extensionUri }, { appendLine() {}, show() {} });
    panel.refreshModels = async () => {};
    term.show(false);
    const shell = await until(() => term.state?.shell, 15000);
    if (shell !== "pwsh") { log(`NOTE VS Code didn't say this terminal is PowerShell (it said ${shell}): Paste in terminal goes in line by line there, as before`); return; }
    await sleep(2500); // the prompt, ready for input
    const enter = () => term.sendText("", true); // you, pressing Enter

    const ran = path.join(T, "if-else.txt");
    await panel.onMessage({ type: "pasteInTerminal", text: `$n = 1\nif ($n -eq 2) {\n    'two' | Set-Content '${ran}'\n}\nelse {\n    'else ran' | Set-Content '${ran}'\n}\n` });
    await sleep(2500);
    check("several lines into PowerShell: nothing runs before Enter, and nothing is asked", read(ran) === null && warned.length === 0, [read(ran), warned]);
    enter();
    check("... Enter runs it as one command: an else on its own line works", await until(() => read(ran), 8000) === "else ran", String(read(ran)));

    const kept = path.join(T, "kept.txt");
    await panel.onMessage({ type: "pasteInTerminal", text: "$solderKept = 'still here'\n$null = 0" });
    enter();
    await sleep(1500);
    term.sendText(`$solderKept | Set-Content '${kept}'`, true);
    check("... in your session, so its variables are still there afterwards", await until(() => read(kept), 8000) === "still here", String(read(kept)));

    const here = path.join(T, "here.txt");
    await panel.onMessage({ type: "pasteInTerminal", text: `$text = @'\nline one\n\n    line three\n'@\n$text | Set-Content '${here}'` });
    enter();
    check("... a here-string keeps its blank line and indent", await until(() => read(here), 8000) === "line one\n\n    line three", String(read(here)));
  } finally {
    own.window.showWarningMessage = old;
    term.dispose();
  }
}
