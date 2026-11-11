// @ts-nocheck
"use strict";
// One of Solder's checks inside a real VS Code: run with `node check/run.js edits` (see check/README.md).
// Runs inside a real VS Code extension host: edit_file's indentation shift, misses with the file's lines, and one
// problems check for several edits to a file in a reply.
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
}
