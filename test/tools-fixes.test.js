// @ts-check
"use strict";
// Fixes in src/tools.js found in review (0.3.14): write_file's order and stat failures, Undo's hash after a save,
// an old_text of only a line number, ripgrep's output and start failures, git conflicts, a drive root's AGENTS.md.
// A stand-in for the vscode module with open documents, edits and saves, enough for write_file and edit_file.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** @type {any[]} the open documents */
const docs = [];
/** @type {{stat: ((uri: any) => any) | null, onDiagnostics: (() => void) | null}} */
const hooks = { stat: null, onDiagnostics: null };
class Range { constructor(/** @type {number} */ start, /** @type {number} */ end) { this.start = start; this.end = end; } }
class WorkspaceEdit {
  constructor() { /** @type {any[]} */ this.ops = []; }
  replace(/** @type {any} */ uri, /** @type {Range} */ range, /** @type {string} */ text) { this.ops.push({ kind: "replace", uri, range, text }); }
  createFile(/** @type {any} */ uri, /** @type {any} */ options) { this.ops.push({ kind: "create", uri, options }); }
}
const same = (/** @type {any} */ a, /** @type {string} */ b) => a.fsPath.toLowerCase() === b.toLowerCase();
/** An open, saved document of a file, as VS Code has it. @param {string} full @param {string} [text] its text (else the disk's) */
function openDoc(full, text) {
  const doc = {
    uri: { fsPath: full, scheme: "file" }, languageId: "plaintext", isDirty: false, eol: 1, text: text ?? fs.readFileSync(full, "utf8"),
    getText() { return this.text; },
    positionAt(/** @type {number} */ offset) { return offset; },
    async save() { fs.writeFileSync(full, this.text); this.isDirty = false; return true; },
  };
  docs.push(doc);
  return doc;
}
const vscodeStub = {
  Uri: { file: (/** @type {string} */ fsPath) => ({ fsPath, scheme: "file" }) },
  FileType: { File: 1, Directory: 2 }, EndOfLine: { LF: 1, CRLF: 2 }, DiagnosticSeverity: { Error: 0, Warning: 1 },
  Range, WorkspaceEdit, env: { appRoot: "" },
  RelativePattern: class { constructor(/** @type {string} */ base, /** @type {string} */ pattern) { this.base = base; this.pattern = pattern; } },
  languages: {
    onDidChangeDiagnostics: () => { hooks.onDiagnostics?.(); return { dispose() {} }; },
    getDiagnostics: () => [],
  },
  workspace: {
    textDocuments: docs,
    getConfiguration: () => ({ get: (/** @type {string} */ _key, /** @type {any} */ fallback) => fallback }),
    fs: {
      stat: async (/** @type {any} */ uri) => {
        if (hooks.stat) return hooks.stat(uri);
        let st;
        try { st = fs.statSync(uri.fsPath); } catch (error) {
          // As VS Code's FileSystemError says it.
          if (/** @type {any} */ (error).code === "ENOENT") throw Object.assign(new Error("no file"), { code: "FileNotFound", name: "EntryNotFound (FileSystemError)" });
          throw error;
        }
        return { type: st.isDirectory() ? 2 : 1, size: st.size };
      },
      writeFile: async (/** @type {any} */ uri, /** @type {Buffer} */ bytes) => fs.writeFileSync(uri.fsPath, bytes),
      createDirectory: async (/** @type {any} */ uri) => { fs.mkdirSync(uri.fsPath, { recursive: true }); },
    },
    // VS Code's file search takes a moment (and finds nothing here: the walk does).
    findFiles: async () => { await new Promise((resolve) => setTimeout(resolve, 50)); return []; },
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
const { WorkspaceTools, ToolError, planEdit, parseStatus } = require("../src/tools.js");
const { RESULTS } = require("../src/prompt.js");
const NUL = String.fromCharCode(0);

/** A workspace in a new folder, with no documents open. */
function workspace(/** @type {string} */ name) {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), `solder-${name}-`));
  const tools = new WorkspaceTools(/** @type {any} */ ({ globalStorageUri: { fsPath: path.join(top, ".store") }, subscriptions: [] }));
  tools.roots = () => [top];
  /** @type {any} */ (tools)._pruned = Date.now(); // no pruning timer left running
  docs.length = 0;
  hooks.stat = null;
  hooks.onDiagnostics = null;
  const backups = () => { try { return fs.readdirSync(path.join(top, ".store", "backups", "c1")); } catch { return []; } };
  return { top, tools, backups, done: () => fs.rmSync(top, { recursive: true, force: true }) };
}
const chat = { id: "c1" };

test("write_file to an open file changed on disk unnoticed: the disk's text is what's backed up and compared", async () => {
  const { top, tools, backups, done } = workspace("stale");
  try {
    const full = path.join(top, "a.txt");
    fs.writeFileSync(full, "old\n");
    openDoc(full);
    fs.writeFileSync(full, "changed on disk\n"); // VS Code never heard (a network drive)
    const result = await tools.writeFile({ path: "a.txt", content: "written\n" }, chat);
    assert.equal(fs.readFileSync(result.change.backup, "utf8"), "changed on disk\n", "Undo puts back what was there");
    assert.equal(fs.readFileSync(full, "utf8"), "written\n");
    // The stale text again: it isn't "unchanged", the disk has something else.
    fs.writeFileSync(full, "changed again\n");
    const again = await tools.writeFile({ path: "a.txt", content: "written\n" }, chat);
    assert.ok(again.change, again.output);
    assert.equal(fs.readFileSync(again.change.backup, "utf8"), "changed again\n");
    assert.equal(backups().length, 2);
  } finally { done(); }
});

test("write_file: unchanged content leaves no backup behind; a binary file is refused cleanly", async () => {
  const { top, tools, backups, done } = workspace("binary");
  try {
    fs.writeFileSync(path.join(top, "same.txt"), "same\n");
    const same = await tools.writeFile({ path: "same.txt", content: "same\n" }, chat);
    assert.equal(same.output, RESULTS.sameContent("same.txt"));
    assert.deepEqual(backups(), []);
    fs.writeFileSync(path.join(top, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d]));
    await assert.rejects(tools.writeFile({ path: "logo.png", content: "text" }, chat),
      (error) => error instanceof ToolError && error.message === RESULTS.notText("logo.png"));
    assert.deepEqual(backups(), []);
    assert.equal(fs.readFileSync(path.join(top, "logo.png"))[4], 0, "not written");
  } finally { done(); }
});

test("write_file: a stat that fails for another reason than 'not found' writes nothing (no unbacked overwrite)", async () => {
  const { top, tools, backups, done } = workspace("flaky");
  try {
    const full = path.join(top, "kept.txt");
    fs.writeFileSync(full, "keep me\n");
    hooks.stat = () => { throw Object.assign(new Error("the network name is no longer available"), { code: "Unknown" }); };
    await assert.rejects(tools.writeFile({ path: "kept.txt", content: "new\n" }, chat),
      (error) => error instanceof ToolError && error.message === RESULTS.notWritable("kept.txt"));
    assert.equal(fs.readFileSync(full, "utf8"), "keep me\n");
    assert.deepEqual(backups(), []);
    // Node's ENOENT (as some file systems say it) is a new file, as VS Code's FileNotFound is.
    hooks.stat = () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); };
    const made = await tools.writeFile({ path: "new.txt", content: "hi\n" }, chat);
    assert.equal(made.change.created, true);
    hooks.stat = null;
    const fresh = await tools.writeFile({ path: "sub/newer.txt", content: "hi\n" }, chat);
    assert.equal(fresh.change.created, true);
    assert.equal(fs.readFileSync(path.join(top, "sub", "newer.txt"), "utf8"), "hi\n");
  } finally { done(); }
});

test("typing during the problems check after a save isn't Solder's: Undo refuses instead of erasing it", async () => {
  const { top, tools, done } = workspace("typing");
  try {
    const full = path.join(top, "b.txt");
    fs.writeFileSync(full, "one\ntwo\n");
    const doc = openDoc(full);
    // You type while the problems check waits (the check listens for diagnostics then).
    const typing = () => { hooks.onDiagnostics = () => { hooks.onDiagnostics = null; doc.text += "typed\n"; doc.isDirty = true; }; };
    typing();
    const edited = await tools.editFile({ path: "b.txt", old_text: "two", new_text: "TWO" }, chat);
    assert.equal(doc.text, "one\nTWO\ntyped\n");
    await assert.rejects(tools.undo(edited.change), /has changed since that step/);
    await doc.save();
    typing();
    const written = await tools.writeFile({ path: "b.txt", content: "all new\n" }, chat);
    assert.equal(doc.text, "all new\ntyped\n");
    await assert.rejects(tools.undo(written.change), /has changed since that step/);
  } finally { done(); }
});

test("old_text that is only a line number (a blank line copied from read_file) is refused at once, not looked for", () => {
  const text = "one\n\ntwo\n";
  const started = Date.now();
  assert.throws(() => planEdit("a.js", text, { old_text: "12\t", new_text: "x" }, "\n"),
    (error) => error instanceof ToolError && error.message === RESULTS.emptyOldText);
  assert.throws(() => planEdit("a.js", text, { old_text: "12\t", new_text: "x", replace_all: true }, "\n"), ToolError);
  assert.ok(Date.now() - started < 1000);
  // The same characters really in the file (a tab-separated line) are still found.
  assert.equal(planEdit("a.tsv", "a\n12\tb\n", { old_text: "12\t", new_text: "13\t" }, "\n").found.start, 2);
});

test("git status: every merge conflict pair is a conflict, not added or deleted", () => {
  const pairs = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"];
  const status = parseStatus([...pairs.map((xy) => `${xy} ${xy}.js`), "A  added.js", " D gone.js", ""].join(NUL));
  assert.deepEqual(status.map((e) => [e.path, e.label]), [...pairs.map((xy) => [`${xy}.js`, "conflicted"]),
    ["added.js", "added (staged)"], ["gone.js", "deleted"]]);
});

test("a workspace that is a drive root still brings a subfolder's AGENTS.md along", (t) => {
  if (process.platform !== "win32") { t.skip("drive roots are Windows'"); return; }
  const { top, tools, done } = workspace("driveroot");
  try {
    const drive = path.parse(top).root; // C:\
    const sub = path.join(top, "sub");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, "AGENTS.md"), "Sub folder rule: tabs only.");
    fs.writeFileSync(path.join(sub, "f.js"), "x\n");
    tools.roots = () => [drive];
    const notes = tools.nestedAgents({ full: path.join(sub, "f.js"), inside: true }, { agentsSeen: [] });
    assert.match(notes, /Sub folder rule: tabs only\./);
  } finally { done(); }
});

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

test("ripgrep's lines keep their text as found: backslashes in it, and characters split between chunks", async (t) => {
  const rg = findRipgrep();
  if (!rg) { t.skip("no VS Code ripgrep here"); return; }
  const { top, tools, done } = workspace("rg");
  try {
    fs.mkdirSync(path.join(top, "sub"));
    fs.writeFileSync(path.join(top, "sub", "a.txt"), 'out = "C:\\Temp\\out.txt"\n');
    const lines = await tools.searchWithRipgrep(rg, top, "Temp", false, undefined, AbortSignal.timeout(15_000));
    assert.deepEqual(lines, ['sub/a.txt:1:out = "C:\\Temp\\out.txt"']);
    // Enough two-byte characters that ripgrep's output comes in many chunks, some ending mid-character.
    for (let i = 0; i < 40; i++) {
      fs.writeFileSync(path.join(top, `f${i}.txt`), Array.from({ length: 50 }, (_, k) => "é".repeat(100 + ((i + k) % 7)) + " mark").join("\n") + "\n");
    }
    const many = await tools.searchWithRipgrep(rg, top, "mark", false, undefined, AbortSignal.timeout(15_000));
    assert.equal(many.length, 40 * 50);
    assert.ok(many.every((line) => !line.includes("\uFFFD")), "no character garbled");
  } finally { done(); }
});

test("ripgrep that can't start: the first search gives the fallback's answer, not nothing", async () => {
  const { top, tools, done } = workspace("norg");
  try {
    fs.writeFileSync(path.join(top, "x.js"), "say hello\n");
    const lines = await tools.searchWithRipgrep(path.join(top, "no-such-rg.exe"), top, "hello", false, undefined, AbortSignal.timeout(15_000));
    assert.deepEqual([...lines], ["x.js:1:say hello"]);
    assert.equal(/** @type {any} */ (tools)._rg, null, "falls back from now on");
  } finally { done(); }
});
