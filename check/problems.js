// @ts-nocheck
"use strict";
// One of Solder's checks inside a real VS Code: run with `node check/run.js problems` (see check/README.md).
// Runs inside a real VS Code extension host: problems on files that aren't open, checked in a background tab.
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
// The repo this file is in, and the throwaway folder check/run.js made for this run.
const REPO = path.resolve(__dirname, "..");
const T = process.env.SOLDER_CHECK_DIR || path.join(require("node:os").tmpdir(), "solder-check");
const LOG = path.join(T, "problems.log");
const log = (...a) => fs.appendFileSync(LOG, a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ") + "\n");
const check = (name, ok, detail = "") => log(ok ? "PASS" : "FAIL", name, detail);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async function () {
  fs.writeFileSync(LOG, `=== problems ${new Date().toISOString()}\n`);
  try { await main(); } catch (e) { log("!!! harness", String(e && e.stack || e)); }
  log("=== end");
};

const tabNames = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.label + (t.isPreview ? " (preview)" : "") + (t.isActive ? " *" : ""));

async function main() {
  const { WorkspaceTools } = require(path.join(REPO, "src", "tools.js"));
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const tools = new WorkspaceTools({ globalStorageUri: vscode.Uri.file(path.join(T, "gs")), subscriptions: [] });
  // What the user is looking at: core.ps1, pinned and active, plus a preview tab of notes.md behind it... make notes.md the preview.
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(ws, "notes.md")), { preview: true });
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(ws, "core.ps1")), { preview: false });
  const t0 = Date.now();
  vscode.languages.onDidChangeDiagnostics((e) => { for (const u of e.uris) log(`    [diag +${Date.now() - t0} ms] ${u.fsPath.split(path.sep).pop()}: ${vscode.languages.getDiagnostics(u).map((d) => d.source + ":" + d.message.slice(0, 50)).join(" | ") || "(none)"}`); });
  await sleep(Number(process.env.WARM || 500));
  log("tabs at start", tabNames());
  const startTabs = JSON.stringify(tabNames());
  for (const [name, round] of [["mod-bad.ps1", 1], ["mod-clean.ps1", 1], ["mod-bad.ps1", 2], ["mod-clean.ps1", 2], ["bad.ts", 1], ["clean.ts", 1], ["bad.ts", 2], ["plain.xyz", 1]]) {
    const began = Date.now();
    let during = "";
    const spy = setInterval(() => { const names = tabNames(); if (names.length > 2 && !during) during = JSON.stringify(names); }, 50);
    const result = await tools.problems({ path: name });
    clearInterval(spy);
    const active = vscode.window.activeTextEditor?.document.fileName.split(path.sep).pop();
    log(`--- ${name} #${round} (${Date.now() - began} ms): ${result.summary}`);
    log("    " + result.output.split("\n")[0].slice(0, 220));
    log("    tab during:", during || "(none seen)");
    check(`${name} #${round}: core.ps1 still in view`, active === "core.ps1", String(active));
    check(`${name} #${round}: tabs as they were afterwards`, JSON.stringify(tabNames()) === startTabs, JSON.stringify(tabNames()));
  }
}
