// @ts-nocheck
"use strict";
// One of Solder's checks inside a real VS Code: run with `node check/run.js stale` (see check/README.md).
// Runs inside a real VS Code extension host: a file changed outside VS Code that VS Code never hears about (as on a
// network drive: watching is turned off for one folder here to make that state). Its open copy stays behind for good;
// reads must give the disk's text without writing anything, and edits must reload it and go through, not lock.
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const REPO = path.resolve(__dirname, "..");
const T = process.env.SOLDER_CHECK_DIR || path.join(require("node:os").tmpdir(), "solder-check");
const LOG = path.join(T, "stale.log");
const log = (...a) => fs.appendFileSync(LOG, a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ") + "\n");
const check = (name, ok, detail = "") => log(ok ? "PASS" : "FAIL", name, typeof detail === "string" ? detail : JSON.stringify(detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async function () {
  fs.writeFileSync(LOG, `=== stale ${new Date().toISOString()}\n`);
  try { await Promise.race([main(), sleep(120000).then(() => log("!!! timed out"))]); } catch (e) { log("!!! harness", String(e && e.stack || e)); }
  log("=== end");
};

async function main() {
  const { WorkspaceTools } = require(path.join(REPO, "src", "tools.js"));
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const dir = path.join(ws, "unwatched");
  fs.mkdirSync(dir, { recursive: true });
  await vscode.workspace.getConfiguration("files").update("watcherExclude", { "**/unwatched/**": true, "**/unwatched": true }, vscode.ConfigurationTarget.Global);
  await sleep(2500); // the watcher restarts with the new excludes
  const tools = new WorkspaceTools({ globalStorageUri: vscode.Uri.file(path.join(T, "gs-stale")), subscriptions: [] });
  const chat = { id: "c1", messages: [] };
  const run = (name, args) => tools.run(name, args, { chat, signal: AbortSignal.timeout(30000) });

  /** A file open in a tab, then changed on disk without VS Code hearing of it. */
  const behind = async (name, first, then, shown = true) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, first);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    if (shown) await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
    fs.writeFileSync(file, then);
    await sleep(2500);
    return { file, doc };
  };

  // ---- the state itself: VS Code's copy stays behind
  const a = await behind("a.ps1", "Write-Host 'one'\r\nWrite-Host 'two'\r\n", "Write-Host 'one'\r\nWrite-Host 'two'\r\n# signed outside VS Code\r\n");
  check("the state: VS Code's copy stays behind the disk, unchanged by you", !a.doc.getText().includes("signed") && !a.doc.isDirty);

  // ---- read_file: the disk's text, and nothing written
  const before = fs.statSync(a.file).mtimeMs;
  let r = await run("read_file", { path: "unwatched/a.ps1" });
  check("read_file gives the disk's text, not VS Code's old copy", !r.failed && r.output.includes("signed outside VS Code"), r.output);
  check("... without writing the file", fs.statSync(a.file).mtimeMs === before);

  // ---- edit_file: reloads, then edits what's on disk (it used to refuse every time)
  r = await run("edit_file", { path: "unwatched/a.ps1", old_text: "Write-Host 'two'", new_text: "Write-Host 'TWO'" });
  const after = fs.readFileSync(a.file, "utf8");
  check("edit_file goes through: VS Code's copy is reloaded first", !r.failed, r.output);
  check("... what changed outside is kept, the edit is made, line endings as they were", after === "Write-Host 'one'\r\nWrite-Host 'TWO'\r\n# signed outside VS Code\r\n", after);
  check("... and VS Code's copy is the disk's again, saved", a.doc.getText().includes("signed outside VS Code") && a.doc.getText().includes("'TWO'") && !a.doc.isDirty);
  r = await run("edit_file", { path: "unwatched/a.ps1", old_text: "Write-Host 'one'", new_text: "Write-Host 'ONE'" });
  check("... and the next edit just works", !r.failed && fs.readFileSync(a.file, "utf8").startsWith("Write-Host 'ONE'"), r.output);

  // ---- again after another outside change (signed again after each edit, as happens)
  fs.writeFileSync(a.file, fs.readFileSync(a.file, "utf8") + "# signed again\r\n");
  await sleep(1500);
  r = await run("edit_file", { path: "unwatched/a.ps1", old_text: "# signed again", new_text: "# signed again, then edited" });
  check("a second outside change is handled the same way", !r.failed && fs.readFileSync(a.file, "utf8").endsWith("# signed again, then edited\r\n"), r.output);

  // ---- write_file on a stale open copy
  const b = await behind("b.txt", "first\n", "first\nsecond, outside\n");
  r = await run("write_file", { path: "unwatched/b.txt", content: "all new\n" });
  check("write_file goes through on a copy that was behind", !r.failed && fs.readFileSync(b.file, "utf8") === "all new\n" && b.doc.getText() === "all new\n" && !b.doc.isDirty, r.output);

  // ---- a copy open with no tab (Solder opened it to read)
  const c = await behind("c.txt", "one\n", "one\ntwo, outside\n", false);
  r = await run("edit_file", { path: "unwatched/c.txt", old_text: "two, outside", new_text: "two" });
  check("a copy with no tab is reloaded too", !r.failed && fs.readFileSync(c.file, "utf8") === "one\ntwo\n", r.output);

  // ---- your unsaved changes are never reloaded away
  const d = await behind("d.txt", "mine\n", "mine\ntheirs, outside\n");
  const typing = new vscode.WorkspaceEdit();
  typing.insert(vscode.Uri.file(d.file), new vscode.Position(0, 0), "unsaved typing\n");
  await vscode.workspace.applyEdit(typing);
  r = await run("read_file", { path: "unwatched/d.txt" });
  check("with unsaved changes, read_file shows your copy (what an edit would change)", !r.failed && r.output.includes("unsaved typing"), r.output);
  r = await run("edit_file", { path: "unwatched/d.txt", old_text: "mine", new_text: "MINE" });
  check("... and an edit never throws your unsaved text away", d.doc.getText().includes("unsaved typing"), [r.failed, r.output, d.doc.getText()]);
  await vscode.commands.executeCommand("workbench.action.files.revert").then(() => {}, () => {});
}
