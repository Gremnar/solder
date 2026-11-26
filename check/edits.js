// @ts-nocheck
"use strict";
// One of Solder's checks inside a real VS Code: run with `node check/run.js edits` (see check/README.md).
// Runs inside a real VS Code extension host: edit_file's indentation shift, misses with the file's lines, and one
// problems check for several edits to a file in a reply; a file with no tab checked in a background tab; an edit and a
// write in one reply settled together.
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
// The repo this file is in, and the throwaway folder check/run.js made for this run.
const REPO = path.resolve(__dirname, "..");
const T = process.env.SOLDER_CHECK_DIR || path.join(require("node:os").tmpdir(), "solder-check");
const LOG = path.join(T, "edits.log");
const log = (...a) => fs.appendFileSync(LOG, a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ") + "\n");
const check = (name, ok, detail = "") => log(ok ? "PASS" : "FAIL", name, detail);

exports.run = async function () {
  fs.writeFileSync(LOG, `=== edits ${new Date().toISOString()}\n`);
  try { await main(); } catch (e) { log("!!! harness", String(e && e.stack || e)); }
  log("=== end");
};

async function main() {
  const { WorkspaceTools } = require(path.join(REPO, "src", "tools.js"));
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const tools = new WorkspaceTools({ globalStorageUri: vscode.Uri.file(path.join(T, "gs")), subscriptions: [] });
  const chat = { id: "c1", messages: [] };
  const file = path.join(ws, "calc.ts");
  const start = "export function total(items: number[]): number {\n    let sum = 0;\n    for (const item of items) {\n        if (item > 0) {\n            sum += item;\n        }\n    }\n    return sum;\n}\n";
  fs.writeFileSync(file, start);
  const run = (args, edit) => tools.run("edit_file", { path: "calc.ts", ...args }, { chat, signal: AbortSignal.timeout(30000), edit });
  // Warm TypeScript up on the file (it's checked in a tab).
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), { preview: false });
  await tools.problems({ path: "calc.ts" });

  // A. old_text 4 spaces short throughout; new_text written at the same (wrong) depth.
  let r = await run({ old_text: "    if (item > 0) {\n        sum += item;\n    }", new_text: "    if (item > 0 && item < 100) {\n        sum += item;\n    }" });
  log("A:", r.output);
  const a = fs.readFileSync(file, "utf8");
  check("A: shifted edit applied at the file's depth", !r.failed && a.includes("        if (item > 0 && item < 100) {\n            sum += item;\n        }"), a);
  check("A: says so", /indented 4 spaces less/.test(r.output));
  // Uneven indentation: refused, with the lines.
  r = await run({ old_text: "for (const item of items) {\n  if (item > 0 && item < 100) {", new_text: "x" });
  log("A2:", r.output);
  check("A2: uneven refused with the file's lines", r.failed && /closest place is around lines \d+-\d+/.test(r.output) && /\n3\t    for \(const item of items\) \{/.test(r.output));

  // P. Show diff on an approval card: what it shows is what the edit then makes, and looking changes nothing.
  {
    const own = require("node:module").createRequire(path.join(REPO, "src", "tools.js"))("vscode");
    const real = own.commands.executeCommand;
    const shown = [];
    own.commands.executeCommand = async (id, ...rest) => { if (id === "vscode.diff") { shown.push(rest); return undefined; } return real.call(own.commands, id, ...rest); };
    const text = async (uri) => (await vscode.workspace.openTextDocument(uri)).getText();
    const other = path.join(ws, "preview.ps1");
    const was = "function Get-Total {\r\n    param([int[]]$Items)\r\n    $sum = 0\r\n    foreach ($item in $Items) { $sum += $item }\r\n    return $sum\r\n}\r\n";
    fs.writeFileSync(other, was);
    try {
      // old_text written two spaces short, as a model does: the preview works it out the way the edit will.
      const edit = { path: "preview.ps1", old_text: "  $sum = 0\n  foreach ($item in $Items) { $sum += $item }", new_text: "  $sum = 0\n  foreach ($item in $Items) { if ($item -gt 0) { $sum += $item } }" };
      const why = await tools.previewChange("edit_file", edit);
      const proposed = shown[0] ? await text(shown[0][1]) : "";
      check("P: Show diff opens the file beside the file as the edit would leave it, and changes nothing", why === "" && shown.length === 1 && shown[0][0].fsPath.toLowerCase() === other.toLowerCase()
        && shown[0][1].scheme === "solder-preview" && /now ↔ if you allow this/.test(shown[0][2]) && fs.readFileSync(other, "utf8") === was && proposed.includes("if ($item -gt 0)"), [why, shown.length, proposed.slice(0, 120)]);
      const done = await tools.run("edit_file", edit, { chat, signal: AbortSignal.timeout(30000) });
      check("P: ... and that is exactly what the edit then makes (line endings and depth included)", !done.failed && fs.readFileSync(other, "utf8") === proposed && proposed.includes("\r\n    foreach"), [done.output, JSON.stringify(proposed).slice(0, 160)]);
      const miss = await tools.previewChange("edit_file", { path: "preview.ps1", old_text: "not in the file", new_text: "x" });
      check("P: an edit that wouldn't go through says so, with why, and opens nothing", /wouldn't go through as it stands: /.test(miss) && shown.length === 1, miss.slice(0, 160));
      shown.length = 0;
      const fresh = await tools.previewChange("write_file", { path: "brand-new.ps1", content: "Write-Output 'hi'\n" });
      check("P: a file that would be new is shown against nothing, and isn't made", fresh === "" && shown.length === 1 && await text(shown[0][0]) === "" && await text(shown[0][1]) === "Write-Output 'hi'\n"
        && /\(new ↔ if you allow this\)/.test(shown[0][2]) && !fs.existsSync(path.join(ws, "brand-new.ps1")), shown[0]?.[2]);
      shown.length = 0;
      await tools.previewChange("write_file", { path: "preview.ps1", content: "replaced\n" });
      check("P: a write over a file is shown against the file as it is", shown.length === 1 && shown[0][0].scheme === "file" && await text(shown[0][1]) === "replaced\n" && fs.readFileSync(other, "utf8") === proposed);
      check("P: a move has nothing to show side by side, and says so", /nothing to show side by side/.test(await tools.previewChange("move_item", { from: "preview.ps1", to: "p2.ps1" })));
    } finally {
      own.commands.executeCommand = real;
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), { preview: false });
    }
  }

  // C. Two edits in one reply: the first breaks the file (an undefined name), the second fixes it. Nothing reported.
  let began = Date.now();
  const r1 = await run({ old_text: "    let sum = 0;", new_text: "    let sum = zero;" }, { group: "g1", more: true });
  const r2 = await run({ old_text: "    return sum;", new_text: "    const zero = 0;\n    return sum;" }, { group: "g1", more: false });
  log("C1:", r1.output, "|", r2.output, `(${Date.now() - began} ms)`);
  // `zero` used before it's declared is still an error in TS: so the last edit DOES report it, from the first's change.
  check("C: the first edit didn't wait or report", r1.output.split("\n").length === 1);
  check("C: the last reports the problem the pair left", /New problem|zero/.test(r2.output), r2.output);
  // Now a pair where the second really fixes it.
  fs.writeFileSync(file, start);
  await new Promise((res) => setTimeout(res, 1500));
  began = Date.now();
  const s1 = await run({ old_text: "    let sum = 0;", new_text: "    let sum = start;" }, { group: "g2", more: true });
  const s2 = await run({ old_text: "export function total(items: number[]): number {", new_text: "export function total(items: number[], start = 0): number {" }, { group: "g2", more: false });
  log("C2:", s1.output, "|", s2.output, `(${Date.now() - began} ms)`);
  check("C2: a break the later edit fixes is never reported", !/problem/i.test(s1.output + s2.output), s1.output + " | " + s2.output);
  // A waiting check whose later edit failed: settled.
  fs.writeFileSync(file, start);
  await new Promise((res) => setTimeout(res, 1500));
  const t1 = await run({ old_text: "    let sum = 0;", new_text: "    let sum = missing;" }, { group: "g3", more: true });
  const t2 = await run({ old_text: "not in the file", new_text: "x" }, { group: "g3", more: false });
  const left = await tools.settleEdits("g3");
  log("C3:", t1.output, "|", t2.output, "|", left);
  check("C3: settled after the failed later edit", left.length === 1 && /missing/.test(left[0].text), JSON.stringify(left));
  check("C3: nothing left over", (await tools.settleEdits("g3")).length === 0);

  // D. Edits to several files in one reply: none waits for its own check; all are checked together at the end, and a
  // break one file's edit fixes in another is never reported.
  const other = path.join(ws, "tax.ts");
  fs.writeFileSync(file, start);
  fs.writeFileSync(other, "import { total } from \"./calc\";\nexport function withTax(items: number[]): number {\n    return total(items) * 1.2;\n}\n");
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(other), { preview: false });
  await tools.problems({ path: "tax.ts" });
  await new Promise((res) => setTimeout(res, 1500));
  began = Date.now();
  // calc.ts gains a parameter that tax.ts doesn't pass yet (an error in tax.ts), then tax.ts passes it; a third edit leaves a real error.
  const d1 = await tools.run("edit_file", { path: "calc.ts", old_text: "export function total(items: number[]): number {", new_text: "export function total(items: number[], rate: number): number {" }, { chat, signal: AbortSignal.timeout(30000), edit: { group: "g4", more: true } });
  const d2 = await tools.run("edit_file", { path: "tax.ts", old_text: "    return total(items) * 1.2;", new_text: "    return total(items, 1.2) * nope;" }, { chat, signal: AbortSignal.timeout(30000), edit: { group: "g4", more: true } });
  const waited = Date.now() - began;
  const both = await tools.settleEdits("g4");
  log("D:", d1.output, "|", d2.output, "|", JSON.stringify(both), `(edits ${waited} ms, all ${Date.now() - began} ms)`);
  check("D: neither edit waited for its own check or reported anything", d1.output.split("\n").length === 1 && d2.output.split("\n").length === 1 && waited < 2000, `${waited} ms`);
  check("D: the files are checked together at the end: the error that's left is found, in its file", both.length === 1 && both[0].path === "tax.ts" && /nope/.test(both[0].text), JSON.stringify(both));
  check("D: ... and the break the second edit fixed (a missing argument) isn't reported", !/Expected 2 arguments/.test(JSON.stringify(both)), JSON.stringify(both));

  // E. A file with no tab: TypeScript checks only files in one, so the check opens it in a background tab, says the
  // errors as found now (nothing checked it before the change), and closes the tab again.
  const tabNames = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.label);
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), { preview: false });
  const startTabs = JSON.stringify(tabNames());
  const closed = path.join(ws, "closed.ts");
  fs.writeFileSync(closed, "export const c: number = 1;\n");
  began = Date.now();
  const e1 = await tools.run("edit_file", { path: "closed.ts", old_text: "= 1;", new_text: "= notDefinedAnywhere;" }, { chat, signal: AbortSignal.timeout(30000) });
  log("E:", e1.output, `(${Date.now() - began} ms)`);
  check("E: an edit that breaks a .ts file with no tab is reported", /notDefinedAnywhere/.test(e1.output) && /wasn't checked before your change/.test(e1.output), e1.output);
  check("E: ... the view as it was, no tab left open", JSON.stringify(tabNames()) === startTabs && vscode.window.activeTextEditor?.document.fileName.toLowerCase() === file.toLowerCase(), JSON.stringify(tabNames()));

  // F. One reply that edits a file and writes another: neither waits for its own check; the reply's check settles
  // both once, in background tabs that are closed again.
  fs.writeFileSync(path.join(ws, "f1.ts"), "export const f: number = 1;\n");
  began = Date.now();
  const f1 = await tools.run("edit_file", { path: "f1.ts", old_text: "= 1;", new_text: "= missingOne;" }, { chat, signal: AbortSignal.timeout(30000), edit: { group: "g5", more: true } });
  const f2 = await tools.run("write_file", { path: "f2.ts", content: "export const g: number = missingTwo;\n" }, { chat, signal: AbortSignal.timeout(30000), edit: { group: "g5", more: true } });
  const quick = Date.now() - began;
  const mixed = await tools.settleEdits("g5");
  log("F:", f1.output, "|", f2.output, "|", JSON.stringify(mixed), `(changes ${quick} ms, all ${Date.now() - began} ms)`);
  check("F: neither change waited for its own check", f1.output.split("\n").length === 1 && f2.output.split("\n").length === 1 && quick < 2000, `${quick} ms`);
  check("F: the reply's check found both files' errors", mixed.length === 2 && /missingOne/.test(mixed.find((m) => m.path === "f1.ts")?.text || "")
    && /missingTwo/.test(mixed.find((m) => m.path === "f2.ts")?.text || ""), JSON.stringify(mixed));
  check("F: ... once", (await tools.settleEdits("g5")).length === 0);
  check("F: ... and no tab left open", JSON.stringify(tabNames()) === startTabs, JSON.stringify(tabNames()));

  // G. read_file of a wrong folder (VS Code's own findFiles): the one file of that name is read; two of them, the error.
  fs.mkdirSync(path.join(ws, "g", "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "g", "src", "greetOnly.js"), "function greet() {}\n");
  const g1 = await tools.run("read_file", { path: "greetOnly.js" }, { chat, signal: AbortSignal.timeout(30000) });
  log("G:", g1.output.split("\n")[0], "|", g1.summary);
  check("G: the one file of that name is read, and said so", !g1.failed && /^greetOnly\.js isn't at that path; this is g\/src\/greetOnly\.js/.test(g1.output) && /^Read g\/src\/greetOnly\.js/.test(g1.summary), g1.output);
  fs.mkdirSync(path.join(ws, "g", "lib"), { recursive: true });
  fs.writeFileSync(path.join(ws, "g", "lib", "greetOnly.js"), "x\n");
  const g2 = await tools.run("read_file", { path: "greetOnly.js" }, { chat, signal: AbortSignal.timeout(30000) });
  check("G: two of that name: the error, with both suggested", g2.failed && /doesn't exist/.test(g2.output) && /g\/lib\/greetOnly\.js/.test(g2.output), g2.output);

  // H. A subfolder's AGENTS.md: a search (VS Code's ripgrep) brings it; an edit there in the same reply waits; the next reply's goes through.
  fs.mkdirSync(path.join(ws, "h", "plant"), { recursive: true });
  fs.writeFileSync(path.join(ws, "h", "plant", "AGENTS.md"), "Every new function gets `// Owner: plant-ops` above it.\n");
  fs.writeFileSync(path.join(ws, "h", "plant", "pumpH.js"), "function startPumpH(id) {\n  return id;\n}\n");
  const hChat = { id: "c-h", messages: [{ role: "user", content: "go" }, { role: "assistant", content: "" }] };
  const h1 = await tools.run("search", { query: "startPumpH" }, { chat: hChat, signal: AbortSignal.timeout(30000) });
  check("H: a search brings the folder's rules", /Owner: plant-ops/.test(h1.keep || ""), JSON.stringify(h1));
  const hEdit = { path: "h/plant/pumpH.js", old_text: "  return id;", new_text: "  return id + 1;" };
  const h2 = await tools.run("edit_file", hEdit, { chat: hChat, signal: AbortSignal.timeout(30000) });
  check("H: an edit in the same reply waits", h2.failed && /hadn't seen them/.test(h2.output) && /return id;/.test(fs.readFileSync(path.join(ws, "h", "plant", "pumpH.js"), "utf8")), h2.output);
  hChat.messages.push({ role: "tool", content: "…" }, { role: "assistant", content: "" });
  const h3 = await tools.run("edit_file", hEdit, { chat: hChat, signal: AbortSignal.timeout(30000) });
  check("H: the next reply's goes through", !h3.failed && /return id \+ 1;/.test(fs.readFileSync(path.join(ws, "h", "plant", "pumpH.js"), "utf8")), h3.output);
}
