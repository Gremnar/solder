// @ts-nocheck
"use strict";
// One of Solder's checks inside a real VS Code: run with `node check/run.js group1` (see check/README.md).
// Runs inside a real VS Code extension host: missing paths, folder reads, search globs, and the new edit_file paths.
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
// The repo this file is in, and the throwaway folder check/run.js made for this run.
const REPO = path.resolve(__dirname, "..");
const T = process.env.SOLDER_CHECK_DIR || path.join(require("node:os").tmpdir(), "solder-check");
const LOG = path.join(T, "group1.log");
const log = (...a) => fs.appendFileSync(LOG, a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ") + "\n");
const check = (name, ok, detail = "") => log(ok ? "PASS" : "FAIL", name, detail);

exports.run = async function () {
  fs.writeFileSync(LOG, `=== group1 ${new Date().toISOString()}\n`);
  try { await main(); } catch (e) { log("!!! harness", String(e && e.stack || e)); }
  log("=== end");
};

async function main() {
  const { WorkspaceTools } = require(path.join(REPO, "src", "tools.js"));
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const g = path.join(ws, "g1");
  fs.rmSync(g, { recursive: true, force: true });
  fs.mkdirSync(path.join(g, "Scripts", "lib"), { recursive: true });
  fs.mkdirSync(path.join(g, "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(g, "Scripts", "lib", "Get-Report.ps1"), "function Get-Report {\n    param([int]$Days = 1)\n    Write-Output \"report $Days\"\n}\n");
  fs.writeFileSync(path.join(g, "Scripts", "Deploy.ps1"), "# deploy\n. \"$PSScriptRoot\\lib\\Get-Report.ps1\"\nGet-Report -Days 7\n");
  fs.writeFileSync(path.join(g, "node_modules", "x", "Get-Report.ps1"), "# not this one\n");
  fs.writeFileSync(path.join(g, "notes.txt"), "Get-Report notes\n");
  const tools = new WorkspaceTools({ globalStorageUri: vscode.Uri.file(path.join(T, "gs")), subscriptions: [] });
  const chat = { id: "c1", messages: [] };
  const ctx = { chat, signal: AbortSignal.timeout(60000) };
  const run = (name, args) => tools.run(name, args, ctx);

  // A missing path: the file of that name is suggested (any case), node_modules left out.
  let r = await run("read_file", { path: "g1/Scripts/get-report.ps1" });
  log("missing:", r.output);
  check("missing path suggests the real one", r.failed && /Files with that name: g1\/Scripts\/lib\/Get-Report\.ps1\./.test(r.output) && !/node_modules/.test(r.output));
  r = await run("read_file", { path: "g1/Deploy.txt" });
  log("other ext:", r.output);
  check("same name, another extension", /another extension: g1\/Scripts\/Deploy\.ps1/.test(r.output));
  r = await run("edit_file", { path: "g1/lib/Get-Report.ps1", old_text: "x", new_text: "y" });
  check("edit_file on a missing path suggests too", r.failed && /Files with that name/.test(r.output), r.output);
  // A folder: its entries.
  r = await run("read_file", { path: "g1/Scripts" });
  log("folder:", r.output);
  check("folder read lists it", /is a folder, not a file\.\nIt holds: lib\/, Deploy\.ps1\./.test(r.output));

  // Search globs: any case, backslashes, a folder name.
  for (const glob of ["g1/scripts/*.ps1", "g1\\Scripts\\*.ps1", "g1/Scripts", "g1/scripts/"]) {
    r = await tools.search({ query: "Get-Report -Days", glob }, ctx.signal);
    check(`search glob ${glob}`, /g1\/Scripts\/Deploy\.ps1:3:/.test(r.output), r.output.slice(0, 200));
  }

  // edit_file: old_text copied with read_file's line numbers.
  const file = path.join(g, "Scripts", "lib", "Get-Report.ps1");
  r = await run("edit_file", { path: "g1/Scripts/lib/Get-Report.ps1", old_text: "2\t    param([int]$Days = 1)\n3\t    Write-Output \"report $Days\"", new_text: "2\t    param([int]$Days = 7)\n3\t    Write-Output \"report $Days\"" });
  log("numbers:", r.output);
  check("line numbers taken out and the edit applied", !r.failed && /line numbers in it; they were left out/.test(r.output) && fs.readFileSync(file, "utf8").includes("$Days = 7)\n    Write-Output"), fs.readFileSync(file, "utf8"));
  // A miss whose first line is the wrong one: the closest lines are shown.
  r = await run("edit_file", { path: "g1/Scripts/lib/Get-Report.ps1", old_text: "function Get-Reports {\n    param([int]$Days = 7)\n    Write-Output \"report $Days\"", new_text: "x" });
  log("miss:", r.output);
  check("a wrong first line still finds the place", r.failed && /closest place is around lines 1-5 \(2 of its 3 lines match there\)/.test(r.output) && /\n1\tfunction Get-Report \{/.test(r.output));
  fs.rmSync(g, { recursive: true, force: true });
}
