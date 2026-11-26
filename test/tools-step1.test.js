// @ts-check
"use strict";
// src/tools.js: backups that never share a name, whole-name matches for $variables and hyphenated names, search
// in one file or folder (an attached file outside the workspace) and files_only, and the problems check after a
// change: a closed file checked in a background tab, a note where nothing checks a kind of file, write_file in a
// reply's grouped check. A stand-in for the vscode module with documents, tabs and diagnostics.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const uriOf = (/** @type {string} */ fsPath) => ({ fsPath, scheme: "file", toString: () => "file:" + fsPath.toLowerCase() });
const LANGUAGES = /** @type {Record<string, string>} */ ({ ".ts": "typescript", ".js": "javascript", ".ps1": "powershell", ".md": "markdown", ".txt": "plaintext", ".log": "log", ".st": "plaintext" });
/** @type {any[]} the open documents */
const docs = [];
/** @type {any[]} the editor tabs */
const tabs = [];
/** @type {string[]} files opened in a tab by Solder (vscode.open) */
const opened = [];
/** @type {Map<string, any[]>} diagnostics by file (lower case) */
const diagnostics = new Map();
/** @type {Set<(event: any) => void>} */
const listeners = new Set();
/** A language server, as the tests want it: what happens when a file opens in a tab, or is saved. */
const hooks = { /** @type {((full: string) => void) | null} */ onTab: null, /** @type {((full: string) => void) | null} */ onSave: null,
  /** @type {(() => void) | null} */ onGet: null };
const same = (/** @type {any} */ a, /** @type {string} */ b) => a.fsPath.toLowerCase() === b.toLowerCase();
class Range { constructor(/** @type {number} */ start, /** @type {number} */ end) { this.start = start; this.end = end; } }
class Position { constructor(/** @type {number} */ line, /** @type {number} */ character) { this.line = line; this.character = character; } }
class WorkspaceEdit {
  constructor() { /** @type {any[]} */ this.ops = []; }
  replace(/** @type {any} */ uri, /** @type {Range} */ range, /** @type {string} */ text) { this.ops.push({ kind: "replace", uri, range, text }); }
  createFile(/** @type {any} */ uri, /** @type {any} */ options) { this.ops.push({ kind: "create", uri, options }); }
}
/** @param {string} full */
function openDoc(full) {
  const doc = {
    uri: uriOf(full), languageId: LANGUAGES[path.extname(full).toLowerCase()] ?? "plaintext", isDirty: false, eol: 1, text: fs.readFileSync(full, "utf8"),
    lineCount: 0,
    getText() { return this.text; },
    lineAt(/** @type {number} */ i) { return { text: this.text.split("\n")[i] }; },
    positionAt(/** @type {number} */ offset) { return offset; },
    async save() { fs.writeFileSync(full, this.text); this.isDirty = false; setTimeout(() => hooks.onSave?.(full), 10); return true; },
  };
  docs.push(doc);
  return doc;
}
/** A language server reports the file's problems (an empty list too). @param {string} full @param {string[]} errors */
function report(full, errors) {
  diagnostics.set(full.toLowerCase(), errors.map((message, line) => ({ severity: 0, message, source: "ts", range: { start: { line, character: 0 } } })));
  for (const listener of [...listeners]) listener({ uris: [uriOf(full)] });
}
const vscodeStub = {
  Uri: { file: uriOf }, Position, Range, WorkspaceEdit,
  FileType: { File: 1, Directory: 2 }, EndOfLine: { LF: 1, CRLF: 2 }, DiagnosticSeverity: { Error: 0, Warning: 1 }, env: { appRoot: "" },
  RelativePattern: class { constructor(/** @type {string} */ base, /** @type {string} */ pattern) { this.base = base; this.pattern = pattern; } },
  languages: {
    onDidChangeDiagnostics: (/** @type {any} */ listener) => { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; },
    getDiagnostics: (/** @type {any} */ uri) => { hooks.onGet?.(); return diagnostics.get(uri.fsPath.toLowerCase()) ?? []; },
  },
  window: {
    activeTextEditor: undefined,
    tabGroups: {
      all: [{ tabs }],
      close: async (/** @type {any[]} */ list) => { for (const tab of list) tabs.splice(tabs.indexOf(tab), 1); },
    },
  },
  commands: {
    executeCommand: async (/** @type {string} */ id, /** @type {any} */ uri) => {
      if (id !== "vscode.open") return undefined;
      tabs.push({ input: { uri: uriOf(uri.fsPath) }, isDirty: false });
      opened.push(uri.fsPath);
      setTimeout(() => hooks.onTab?.(uri.fsPath), 10);
      return undefined;
    },
  },
  workspace: {
    textDocuments: docs,
    getConfiguration: () => ({ get: (/** @type {string} */ _key, /** @type {any} */ fallback) => fallback }),
    fs: {
      stat: async (/** @type {any} */ uri) => {
        let st;
        try { st = fs.statSync(uri.fsPath); } catch { throw Object.assign(new Error("no file"), { code: "FileNotFound" }); }
        return { type: st.isDirectory() ? 2 : 1, size: st.size };
      },
      writeFile: async (/** @type {any} */ uri, /** @type {Buffer} */ bytes) => fs.writeFileSync(uri.fsPath, bytes),
      createDirectory: async (/** @type {any} */ uri) => { fs.mkdirSync(uri.fsPath, { recursive: true }); },
      delete: async (/** @type {any} */ uri) => { fs.rmSync(uri.fsPath, { recursive: true, force: true }); },
    },
    findFiles: async () => [],
    openTextDocument: async (/** @type {any} */ uri) => docs.find((d) => same(d.uri, uri.fsPath)) ?? openDoc(uri.fsPath),
    applyEdit: async (/** @type {WorkspaceEdit} */ edit) => {
      for (const op of edit.ops) {
        const doc = docs.find((d) => same(d.uri, op.uri.fsPath));
        if (op.kind === "replace") { doc.text = doc.text.slice(0, op.range.start) + op.text + doc.text.slice(op.range.end); doc.isDirty = true; }
        else { fs.writeFileSync(op.uri.fsPath, op.options.contents); if (doc) { doc.text = fs.readFileSync(op.uri.fsPath, "utf8"); doc.isDirty = false; } }
      }
      return true;
    },
  },
};
const load = /** @type {any} */ (Module)._load;
/** @type {any} */ (Module)._load = function (/** @type {string} */ request, /** @type {any[]} */ ...rest) {
  return request === "vscode" ? vscodeStub : load.call(this, request, ...rest);
};
const { WorkspaceTools, positionOf } = require("../src/tools.js");
const { RESULTS, TOOLS, CONTEXT } = require("../src/prompt.js");

/** A workspace in a new folder, nothing open, and a folder outside it (where pastes are kept). */
function workspace(/** @type {string} */ name) {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), `solder-${name}-`));
  const ws = path.join(top, "ws");
  const outside = path.join(top, "pastes");
  fs.mkdirSync(ws);
  fs.mkdirSync(outside);
  const tools = new WorkspaceTools(/** @type {any} */ ({ globalStorageUri: { fsPath: path.join(top, ".store") }, subscriptions: [] }));
  tools.roots = () => [ws];
  /** @type {any} */ (tools)._pruned = Date.now(); // no pruning timer left running
  docs.length = 0;
  tabs.length = 0;
  opened.length = 0;
  diagnostics.clear();
  hooks.onTab = null;
  hooks.onSave = null;
  hooks.onGet = null;
  return { top, ws, outside, tools, done: () => fs.rmSync(top, { recursive: true, force: true }) };
}
const chat = { id: "c1", messages: [{ role: "user", content: "go" }] };

/** VS Code's own ripgrep, when VS Code is installed where it usually is. */
function findRipgrep() {
  const homes = [path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code"), path.join(process.env.ProgramFiles || "", "Microsoft VS Code")];
  for (const home of homes) {
    let entries = [];
    try { entries = fs.readdirSync(home); } catch { continue; }
    for (const name of ["", ...entries]) {
      const rg = path.join(home, name, "resources", "app", "node_modules", "@vscode", "ripgrep", "bin", "rg.exe");
      if (fs.existsSync(rg)) return rg;
    }
  }
  return null;
}
const RG = findRipgrep();
/** Both searches: VS Code's ripgrep (when it's here) and the fallback with none. */
const ENGINES = /** @type {[string, string | null][]} */ ([...(RG ? [["ripgrep", RG]] : []), ["no ripgrep", null]]);

// ------------------------------------------------------------------------------------------------------ backups --

test("two files of the same name changed in the same moment each keep their own backup, and each Undo puts back its own", async () => {
  const { ws, tools, done } = workspace("backups");
  const realNow = Date.now;
  try {
    for (const folder of ["a", "b"]) {
      fs.mkdirSync(path.join(ws, "src", folder), { recursive: true });
      fs.writeFileSync(path.join(ws, "src", folder, "config.js"), `module.exports = "${folder}";\n`);
      fs.writeFileSync(path.join(ws, "src", folder, "old.txt"), `old ${folder}\n`);
    }
    hooks.onTab = (file) => report(file, []);
    Date.now = () => 1_800_000_000_000; // the same millisecond for every change
    const a = await tools.writeFile({ path: "src/a/config.js", content: "A\n" }, chat);
    const b = await tools.writeFile({ path: "src/b/config.js", content: "B\n" }, chat);
    assert.notEqual(a.change.backup, b.change.backup);
    assert.equal(fs.readFileSync(a.change.backup, "utf8"), 'module.exports = "a";\n');
    assert.equal(fs.readFileSync(b.change.backup, "utf8"), 'module.exports = "b";\n');
    assert.ok(path.basename(a.change.backup).endsWith("-config.js"), "Review still shows it as that kind of file");
    // Removed in the same moment too.
    const ra = await tools.removeItem({ path: "src/a/old.txt" }, chat);
    const rb = await tools.removeItem({ path: "src/b/old.txt" }, chat);
    assert.notEqual(ra.change.backup, rb.change.backup);
    Date.now = realNow;
    await tools.undo(a.change);
    await tools.undo(b.change);
    await tools.undo(ra.change);
    await tools.undo(rb.change);
    assert.equal(fs.readFileSync(path.join(ws, "src", "a", "config.js"), "utf8"), 'module.exports = "a";\n');
    assert.equal(fs.readFileSync(path.join(ws, "src", "b", "config.js"), "utf8"), 'module.exports = "b";\n');
    assert.equal(fs.readFileSync(path.join(ws, "src", "a", "old.txt"), "utf8"), "old a\n");
    assert.equal(fs.readFileSync(path.join(ws, "src", "b", "old.txt"), "utf8"), "old b\n");
  } finally { Date.now = realNow; done(); }
});

test("an Undo from before still works: a stored backup path is a full path, whatever its name", async () => {
  const { ws, tools, top, done } = workspace("oldbackup");
  try {
    fs.writeFileSync(path.join(ws, "x.txt"), "now\n");
    const store = path.join(top, ".store", "backups", "c1");
    fs.mkdirSync(store, { recursive: true });
    const old = path.join(store, "lz8k2-x.txt"); // as backups were named before
    fs.writeFileSync(old, "before\n");
    const { createHash } = require("node:crypto");
    await tools.undo({ path: path.join(ws, "x.txt"), shown: "x.txt", backup: old, created: false, after: createHash("sha1").update("now\n").digest("hex") });
    assert.equal(fs.readFileSync(path.join(ws, "x.txt"), "utf8"), "before\n");
  } finally { done(); }
});

// -------------------------------------------------------------------------------------------- whole-name matches --

for (const [engine, rg] of ENGINES) {
  test(`symbols' text matches (${engine}): a PowerShell $variable is found; a hyphenated name isn't found inside a longer one`, async () => {
    const { ws, tools, done } = workspace("words");
    try {
      fs.writeFileSync(path.join(ws, "up.ps1"), [
        "param($ComputerName)",
        "Write-Host $ComputerName",
        "$ComputerNameList = @()",
        "function My-Get-Uptime { }",
        "Get-Uptime -ComputerName $ComputerName",
        "$x = $total-1",
        "$subtotal = 2",
      ].join("\n") + "\n");
      /** @type {any} */ (tools)._rg = rg;
      const lines = async (/** @type {string} */ name) => (await tools.wordMatches(name, AbortSignal.timeout(15_000))).map((line) => Number(line.split(":")[1])).sort((a, b) => a - b);
      assert.deepEqual(await lines("$ComputerName"), [1, 2, 5]);
      assert.deepEqual(await lines("Get-Uptime"), [5], "not inside My-Get-Uptime");
      assert.deepEqual(await lines("My-Get-Uptime"), [4]);
      assert.deepEqual(await lines("$total"), [6], "a name with no hyphen still ends at one");
      assert.deepEqual(await lines("ComputerName"), [5], "a parameter's use (-ComputerName); a $variable is a name of its own");
    } finally { done(); }
  });
}

test("a symbol's position: a $variable and a hyphenated name are found whole, not inside a longer name", () => {
  const text = ["function My-Get-Uptime {}", "Get-Uptime", "$ComputerNameList = 1", "Write-Host $ComputerName"];
  const document = /** @type {any} */ ({ lineCount: text.length, lineAt: (/** @type {number} */ i) => ({ text: text[i] }) });
  assert.deepEqual(positionOf(document, [], "Get-Uptime"), new Position(1, 0));
  assert.deepEqual(positionOf(document, [], "$ComputerName"), new Position(3, 11));
});

// ----------------------------------------------------------------------------------------- search's path, files_only --

test("search's schema takes path and files_only, and the attached and pasted notes say to search the path", () => {
  const [description, properties] = TOOLS.search;
  assert.ok(/one file or folder/.test(description));
  assert.equal(/** @type {any} */ (properties).path.type, "string");
  assert.equal(/** @type {any} */ (properties).files_only.type, "boolean");
  assert.ok(/search with this path/.test(CONTEXT.attachedPath("big.log", 5000)));
  assert.ok(/search with this path/.test(CONTEXT.pastedPath("C:\\store\\pastes\\a.txt", 5000)));
});

for (const [engine, rg] of ENGINES) {
  test(`search with a path (${engine}): an attached file outside the workspace, a folder, files_only; a missing path says so`, async () => {
    const { ws, outside, tools, done } = workspace("searchpath");
    try {
      /** @type {any} */ (tools)._rg = rg;
      const log = path.join(outside, "abc.txt");
      fs.writeFileSync(log, Array.from({ length: 5000 }, (_, i) => i === 4210 ? "ERROR 42: pump failed" : `line ${i + 1} ok`).join("\r\n") + "\r\n");
      fs.mkdirSync(path.join(ws, "src"));
      fs.writeFileSync(path.join(ws, "src", "a.js"), "pump();\nconst pump = 1;\nother();\n");
      fs.writeFileSync(path.join(ws, "src", "b.js"), "pump();\n");
      fs.writeFileSync(path.join(ws, "notes.md"), "the pump\n");
      const signal = AbortSignal.timeout(15_000);
      // The workspace alone doesn't have it: before, a path was dropped and this came back as the answer.
      assert.equal((await tools.run("search", { query: "ERROR 42" }, /** @type {any} */ ({ chat, signal }))).output, RESULTS.noMatches("ERROR 42", ""));
      const found = await tools.run("search", { query: "ERROR 42", path: log }, /** @type {any} */ ({ chat, signal }));
      assert.equal(found.output, `${log}:4211:ERROR 42: pump failed`);
      // A folder: only what's in it.
      const inSrc = await tools.run("search", { query: "pump", path: "src" }, /** @type {any} */ ({ chat, signal }));
      assert.deepEqual(inSrc.output.split("\n").sort(), ["src/a.js:1:pump();", "src/a.js:2:const pump = 1;", "src/b.js:1:pump();"]);
      // files_only: each file once, with its count of matching lines.
      const files = await tools.run("search", { query: "pump", files_only: true }, /** @type {any} */ ({ chat, signal }));
      assert.equal(files.output, "notes.md (1)\nsrc/a.js (2)\nsrc/b.js (1)");
      const one = await tools.run("search", { query: "ok", path: log, files_only: true }, /** @type {any} */ ({ chat, signal }));
      assert.equal(one.output, `${log} (4999)`);
      // More matching lines in one file than 50: as many as the line limit, then said to be capped.
      const many = await tools.run("search", { query: "ok", path: log }, /** @type {any} */ ({ chat, signal }));
      assert.equal(many.output.split("\n").filter((line) => line.startsWith(log)).length, 200);
      assert.ok(many.output.endsWith(RESULTS.searchCapped(200)));
      const gone = await tools.run("search", { query: "x", path: "nope.log" }, /** @type {any} */ ({ chat, signal }));
      assert.ok(gone.failed && gone.output.startsWith(RESULTS.error(RESULTS.missing("nope.log"))), gone.output);
      const none = await tools.run("search", { query: "absent", path: "src" }, /** @type {any} */ ({ chat, signal }));
      assert.equal(none.output, RESULTS.noMatches("absent", "src"));
    } finally { done(); }
  });
}

test("search with a path is asked about as read_file is: an attached file, the workspace and docs need no asking; a network path is refused", async () => {
  const { ws, outside, tools, done } = workspace("searchask");
  try {
    const log = path.join(outside, "abc.txt");
    fs.writeFileSync(log, "x\n");
    assert.equal(tools.needsApproval("search", { query: "x" }), null);
    assert.equal(tools.needsApproval("search", { query: "x", path: "src" }), null);
    assert.equal(tools.needsApproval("search", { query: "x", path: path.join(ws, "a.js") }), null);
    assert.match(String(tools.needsApproval("search", { query: "x", path: log })), /outside the workspace/);
    assert.match(String(tools.needsApproval("search", { query: "x", path: outside })), /outside the workspace/);
    tools.attached.add(log.toLowerCase());
    assert.equal(tools.needsApproval("search", { query: "x", path: log }), null, "attached: what you asked for");
    assert.match(String(tools.needsApproval("search", { query: "x", path: outside })), /outside/, "its folder isn't attached");
    assert.equal(tools.needsApproval("search", { query: "x", path: log, docs: true }), null);
    const network = await tools.run("search", { query: "x", path: "\\\\server\\share\\a.log" }, /** @type {any} */ ({ chat, signal: AbortSignal.timeout(5000) }));
    assert.equal(network.output, RESULTS.error(RESULTS.networkPath));
  } finally { done(); }
});

// ------------------------------------------------------------------------------------ the problems check after a change --

test("an edit that breaks a file not open in a tab: checked in a background tab, the errors said honestly, the tab closed", async () => {
  const { ws, tools, done } = workspace("closed");
  try {
    const full = path.join(ws, "calc.ts");
    fs.writeFileSync(full, "export const a = 1;\n");
    // TypeScript checks a file only once it's in a tab.
    hooks.onTab = (file) => report(file, ["Cannot find name 'zero'."]);
    const result = await tools.editFile({ path: "calc.ts", old_text: "1", new_text: "zero" }, chat);
    assert.deepEqual(opened, [full], "opened in a background tab");
    assert.deepEqual(tabs, [], "and closed again");
    assert.ok(result.output.includes(RESULTS.problemsNow("calc.ts", ["- line 1: Cannot find name 'zero'. (ts)"], -9)), result.output);
    assert.ok(result.summary.endsWith(" · 1 problem"), result.summary);
  } finally { done(); }
});

test("an edit to a file in a tab: only the errors it brought, against what was there before", async () => {
  const { ws, tools, done } = workspace("intab");
  try {
    const full = path.join(ws, "calc.ts");
    fs.writeFileSync(full, "export const a = 1;\nlet old = nope;\n");
    tabs.push({ input: { uri: uriOf(full) }, isDirty: false });
    report(full, ["Cannot find name 'nope'."]);
    hooks.onSave = (file) => report(file, ["Cannot find name 'nope'.", "Cannot find name 'zero'."]);
    const result = await tools.editFile({ path: "calc.ts", old_text: "= 1", new_text: "= zero" }, chat);
    assert.deepEqual(opened, [], "no second tab");
    assert.equal(tabs.length, 1, "the user's tab stays");
    assert.ok(result.output.includes(RESULTS.newProblems("calc.ts", ["- line 2: Cannot find name 'zero'. (ts)"], -9)), result.output);
  } finally { done(); }
});

test("a kind of file nothing checks: said once a task for each file, so silence isn't taken as no errors; plain text and Markdown say nothing", async () => {
  const { ws, tools, done } = workspace("unchecked");
  try {
    fs.writeFileSync(path.join(ws, "run.ps1"), "Write-Host 1\n");
    fs.writeFileSync(path.join(ws, "notes.md"), "# a\n");
    fs.writeFileSync(path.join(ws, "notes.txt"), "a\n");
    const task = { id: "c9", messages: [{ role: "user", content: "fix it" }] };
    const first = await tools.editFile({ path: "run.ps1", old_text: "1", new_text: "2" }, task);
    assert.ok(first.output.endsWith(RESULTS.changeNotChecked("run.ps1")), first.output);
    const again = await tools.editFile({ path: "run.ps1", old_text: "2", new_text: "3" }, task);
    assert.ok(!again.output.includes("wasn't checked"), "once a task");
    task.messages.push({ role: "assistant", content: "done" }, { role: "user", content: "and again" });
    const next = await tools.writeFile({ path: "run.ps1", content: "Write-Host 4\n" }, task);
    assert.ok(next.output.endsWith(RESULTS.changeNotChecked("run.ps1")), "a new task: said again");
    for (const file of ["notes.md", "notes.txt"]) {
      const quiet = await tools.writeFile({ path: file, content: "b\n" }, task);
      assert.ok(!/checked/.test(quiet.output), quiet.output);
    }
    // Once its kind has reported problems somewhere, silence is "no errors" again.
    report(path.join(ws, "run.ps1"), []);
    hooks.onTab = (file) => report(file, []);
    const known = await tools.editFile({ path: "run.ps1", old_text: "4", new_text: "5" }, { id: "c10", messages: [] });
    assert.ok(!/checked/.test(known.output), known.output);
  } finally { done(); }
});

test("a reply that edits one file and writes another: neither waits, and the reply's check settles both once, against before the first change", async () => {
  const { ws, tools, done } = workspace("group");
  try {
    const calc = path.join(ws, "calc.ts");
    const tax = path.join(ws, "tax.ts");
    fs.writeFileSync(calc, "export const a = 1;\n");
    fs.writeFileSync(tax, "export const t = 2;\n");
    hooks.onTab = (file) => report(file, file === calc ? ["Cannot find name 'zero'."] : ["Cannot find name 'rate'."]);
    const began = Date.now();
    const e = await tools.run("edit_file", { path: "calc.ts", old_text: "1", new_text: "zero" }, /** @type {any} */ ({ chat, signal: AbortSignal.timeout(10_000), edit: { group: "g1", more: true } }));
    const w = await tools.run("write_file", { path: "tax.ts", content: "export const t = rate;\n" }, /** @type {any} */ ({ chat, signal: AbortSignal.timeout(10_000), edit: { group: "g1", more: true } }));
    const w2 = await tools.run("write_file", { path: "tax.ts", content: "export const t = rate * 2;\n" }, /** @type {any} */ ({ chat, signal: AbortSignal.timeout(10_000), edit: { group: "g1", more: true } }));
    assert.ok(Date.now() - began < 500, "no change waited for its own check");
    for (const r of [e, w, w2]) assert.equal(r.output.split("\n").length, 1, r.output);
    assert.deepEqual(opened, [], "nothing opened yet");
    const settled = await tools.settleEdits("g1");
    assert.deepEqual(settled.map((s) => s.path).sort(), ["calc.ts", "tax.ts"]);
    assert.ok(settled.find((s) => s.path === "tax.ts")?.text.includes("rate"));
    assert.deepEqual(opened.sort(), [calc, tax].sort(), "each opened once");
    assert.deepEqual(tabs, []);
    assert.deepEqual(await tools.settleEdits("g1"), [], "settled once");
  } finally { done(); }
});

test("a new file written in a reply: every error in it is the change's, said as new", async () => {
  const { tools, done } = workspace("newfile");
  try {
    hooks.onTab = (file) => report(file, ["Cannot find name 'q'."]);
    const made = await tools.writeFile({ path: "made.ts", content: "export const m = q;\n" }, chat);
    assert.ok(made.output.includes(RESULTS.newProblems("made.ts", ["- line 1: Cannot find name 'q'. (ts)"], -9)), made.output);
  } finally { done(); }
});

test("at most 8 background tabs a reply; every one closed, even when the check fails", async () => {
  const { ws, tools, done } = workspace("cap");
  try {
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(ws, `f${i}.ts`), `export const v${i} = 1;\n`);
    hooks.onTab = (file) => report(file, []);
    for (let i = 0; i < 10; i++) {
      await tools.run("edit_file", { path: `f${i}.ts`, old_text: "1", new_text: "2" }, /** @type {any} */ ({ chat, signal: AbortSignal.timeout(10_000), edit: { group: "g2", more: true } }));
    }
    await tools.settleEdits("g2");
    assert.equal(opened.length, 8);
    assert.deepEqual(tabs, []);
    // A check that throws: its tab is closed all the same.
    opened.length = 0;
    hooks.onTab = (file) => { hooks.onGet = () => { throw new Error("language service gone"); }; report(file, []); };
    await assert.rejects(tools.editFile({ path: "f0.ts", old_text: "2", new_text: "3" }, chat), /language service gone/);
    assert.equal(opened.length, 1);
    assert.deepEqual(tabs, [], "closed after the failure");
  } finally { done(); }
});
