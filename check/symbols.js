// @ts-nocheck
"use strict";
// One of Solder's checks inside a real VS Code: run with `node check/run.js symbols` (see check/README.md).
// Runs inside a real VS Code extension host: symbols with no path, for a name declared in two files.
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
// The repo this file is in, and the throwaway folder check/run.js made for this run.
const REPO = path.resolve(__dirname, "..");
const T = process.env.SOLDER_CHECK_DIR || path.join(require("node:os").tmpdir(), "solder-check");
const LOG = path.join(T, "symbols.log");
const log = (...a) => fs.appendFileSync(LOG, a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ") + "\n");
const check = (name, ok, detail = "") => log(ok ? "PASS" : "FAIL", name, detail);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async function () {
  fs.writeFileSync(LOG, `=== symbols ${new Date().toISOString()}\n`);
  try { await main(); } catch (e) { log("!!! harness", String(e && e.stack || e)); }
  log("=== end");
};

async function main() {
  const { WorkspaceTools } = require(path.join(REPO, "src", "tools.js"));
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
  fs.mkdirSync(path.join(ws, "sym"), { recursive: true });
  fs.writeFileSync(path.join(ws, "sym", "csv.ts"), "export function parseRow(line: string): string[] {\n  return line.split(\",\");\n}\n");
  fs.writeFileSync(path.join(ws, "sym", "tsv.ts"), "export function parseRow(line: string): string[] {\n  return line.split(\"\\t\");\n}\n");
  fs.writeFileSync(path.join(ws, "sym", "use.ts"), "import { parseRow } from \"./csv\";\nexport const cells = parseRow(\"a,b\");\n");
  fs.writeFileSync(path.join(ws, "sym", "only.ts"), "export function onlyOnce(): number {\n  return 1;\n}\n");
  fs.writeFileSync(path.join(ws, "sym", "parser.ts"), "export class Parser {\n  parse(text: string): string {\n    return text.trim();\n  }\n}\n");
  fs.writeFileSync(path.join(ws, "sym", "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }));
  const tools = new WorkspaceTools({ globalStorageUri: vscode.Uri.file(path.join(T, "gs")), subscriptions: [] });
  const signal = AbortSignal.timeout(60000);
  // Wake TypeScript up, and give its project a moment to load every file.
  for (const f of ["csv.ts", "tsv.ts", "use.ts", "only.ts"]) await vscode.workspace.openTextDocument(path.join(ws, "sym", f));
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(ws, "sym", "use.ts")));
  await tools.symbols({ path: "sym/use.ts" }, signal);
  for (let i = 0; i < 20; i++) { const f = await vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", "parseRow"); log("probe", i, (f || []).length, JSON.stringify((f || []).map((x) => ({ name: x.name, kind: x.kind, uri: x.location && x.location.uri && x.location.uri.toString(), loc: Object.keys(x.location || {}) })))); if ((f || []).length >= 2) break; await sleep(1000); }
  await sleep(4000);
  const def = await tools.symbols({ name: "parseRow" }, signal);
  log("definition:", def.summary, "\n" + def.output);
  check("both definitions shown", /sym\/csv\.ts/.test(def.output) && /sym\/tsv\.ts/.test(def.output) && /split\(","\)/.test(def.output) && /split\("\\t"\)/.test(def.output));
  const refs = await tools.symbols({ name: "parseRow", find: "references" }, signal);
  log("references:", refs.summary, "\n" + refs.output);
  check("references name the other definition", /also defined in sym\/(csv|tsv)\.ts \d+/.test(refs.output));
  const one = await tools.symbols({ name: "onlyOnce" }, signal);
  log("single:", one.summary);
  check("a single definition is as before", /only\.ts/.test(one.output) && !/also defined/.test(one.output));
  const wrong = await tools.symbols({ name: "parseRow", path: "sym/only.ts" }, signal);
  log("wrong file:", wrong.summary, "\n" + wrong.output.slice(0, 400));
  check("wrong file: looked across the workspace", /in sym\/only\.ts as a whole word, so the whole workspace was looked in instead/.test(wrong.output) && /defined in 2 places/.test(wrong.output));
  const parens = await tools.symbols({ name: "parseRow()" }, signal);
  check("a name with parentheses", /defined in 2 places/.test(parens.output), parens.summary);
  const method = await tools.symbols({ name: "Parser.parse" }, signal);
  log("method:", method.summary, "\n" + method.output.slice(0, 300));
  check("Class.method finds the method", /sym\/parser\.ts/.test(method.output) && /return text\.trim\(\)/.test(method.output));

  // 0.2.6: a definition outside the workspace (and docs folders) is named, not shown.
  const outside = path.join(T, "outside");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.ts"), "export function secretSauce(): string {\n  return \"the recipe\";\n}\n");
  fs.writeFileSync(path.join(ws, "sym", "useout.ts"), "import { secretSauce } from \"../../outside/secret\";\nexport const s = secretSauce();\n");
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(ws, "sym", "useout.ts")));
  await sleep(3000);
  const out = await tools.symbols({ name: "secretSauce", path: "sym/useout.ts" }, signal);
  log("outside:", out.summary, "\n" + out.output.slice(0, 400));
  check("an outside definition is named, not shown", /secret\.ts 1 \(outside the workspace/.test(out.output) && !/the recipe/.test(out.output), out.output.slice(0, 300));

  // 0.2.6: undoing a copied folder that's been changed since is refused.
  fs.mkdirSync(path.join(ws, "copysrc"), { recursive: true });
  fs.writeFileSync(path.join(ws, "copysrc", "a.txt"), "one");
  const chat = { id: "c-undo", messages: [] };
  const copied = await tools.run("move_item", { from: "copysrc", to: "copydst", copy: true }, { chat, signal });
  check("folder copied", !copied.failed && fs.existsSync(path.join(ws, "copydst", "a.txt")), copied.output);
  fs.writeFileSync(path.join(ws, "copydst", "a.txt"), "one, and later work");
  let refused = "";
  try { await tools.undo(copied.change); } catch (e) { refused = String(e.message); }
  check("undo of a changed copy is refused", /has changed since/.test(refused) && fs.existsSync(path.join(ws, "copydst", "a.txt")), refused);
  const again = await tools.run("move_item", { from: "copysrc", to: "copydst2", copy: true }, { chat, signal });
  let undone = "";
  try { await tools.undo(again.change); } catch (e) { undone = String(e.message); }
  check("undo of an unchanged copy works", !undone && !fs.existsSync(path.join(ws, "copydst2")), undone);
  fs.rmSync(path.join(ws, "copysrc"), { recursive: true, force: true });
  fs.rmSync(path.join(ws, "copydst"), { recursive: true, force: true });
}
