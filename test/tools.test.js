// @ts-check
"use strict";
// The parts of src/tools.js that don't need a running VS Code, with a stand-in for the vscode module.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const KINDS = ["File", "Module", "Namespace", "Package", "Class", "Method", "Property", "Field", "Constructor", "Enum",
  "Interface", "Function", "Variable", "Constant", "String", "Number", "Boolean", "Array", "Object", "Key", "Null",
  "EnumMember", "Struct", "Event", "Operator", "TypeParameter"];
class Position { constructor(/** @type {number} */ line, /** @type {number} */ character) { this.line = line; this.character = character; } }
const SymbolKind = Object.fromEntries(KINDS.flatMap((name, index) => [[name, index], [index, name]]));
const load = /** @type {any} */ (Module)._load;
/** @type {any} */ (Module)._load = function (/** @type {string} */ request, /** @type {any[]} */ ...rest) {
  return request === "vscode" ? { SymbolKind, Position, Uri: { file: (/** @type {string} */ fsPath) => ({ fsPath, scheme: "file" }) }, languages: { onDidChangeDiagnostics: () => ({ dispose() {} }) }, workspace: { textDocuments: [] } } : load.call(this, request, ...rest);
};
const { outlineEntries, parseStatus, parseNumstat, runGit, locations, positionOf } = require("../src/tools.js");

const at = (/** @type {number} */ start, /** @type {number} */ end) => ({ start: { line: start - 1 }, end: { line: end - 1 } });
const kind = (/** @type {number} */ k) => SymbolKind[k];
const NUL = String.fromCharCode(0);

test("an outline lists classes, methods and functions in file order, nested, with line ranges", () => {
  const symbols = [
    { name: "main", kind: SymbolKind.Function, range: at(205, 230), children: [
      { name: "local", kind: SymbolKind.Variable, range: at(206, 206) },
      { name: "helper", kind: SymbolKind.Function, range: at(210, 220) }] },
    { name: "App", kind: SymbolKind.Class, range: at(12, 200), children: [
      { name: "config", kind: SymbolKind.Property, range: at(14, 14) },
      { name: "start", kind: SymbolKind.Method, range: at(20, 45), children: [
        { name: "x", kind: SymbolKind.Constant, range: at(21, 21) },
        { name: "deep", kind: SymbolKind.Function, range: at(30, 40), children: [
          { name: "deeper", kind: SymbolKind.Function, range: at(31, 32) }] }] }] },
  ];
  assert.deepEqual(outlineEntries(symbols, kind), [
    "class App 12–200",
    "  property config 14",
    "  method start 20–45",
    "    function deep 30–40",
    "function main 205–230",
    "  function helper 210–220",
  ]);
});

test("flat symbol lists (SymbolInformation) work too, and odd names are tidied", () => {
  const symbols = [
    { name: "b", kind: SymbolKind.Function, location: { range: at(9, 12) } },
    { name: "  Heading\nwith a break ", kind: SymbolKind.String, location: { range: at(1, 8) } },
    { name: "", kind: SymbolKind.Function, location: { range: at(20, 21) } },
    { name: "no range", kind: SymbolKind.Function },
  ];
  assert.deepEqual(outlineEntries(symbols, kind), ["Heading with a break 1–8", "function b 9–12", "function (unnamed) 20–21"]);
});

test("a symbol's position: the given line, else where the outline declares it, else its first whole-word use", () => {
  const text = ["const total = 1; // subtotal", "function sum(a) { return total + a; }", "function total2() {}", "  total();"];
  const document = /** @type {any} */ ({ lineCount: text.length, lineAt: (/** @type {number} */ i) => ({ text: text[i] }) });
  const declared = [{ name: "total", kind: SymbolKind.Function, range: at(4, 4), selectionRange: at(4, 4) }];
  assert.deepEqual(positionOf(document, [], "total", 2), new Position(1, 25));
  assert.deepEqual(positionOf(document, declared, "total"), new Position(3, 2));
  assert.deepEqual(positionOf(document, [], "total"), new Position(0, 6), "not inside subtotal or total2");
  assert.equal(positionOf(document, [], "missing"), null);
});

test("Location and LocationLink results come out the same, without repeats", () => {
  const uri = { toString: () => "file:///a.js", fsPath: "a.js", scheme: "file" };
  const found = locations([{ uri, range: at(3, 3) }, { uri, range: at(3, 3) },
    { targetUri: uri, targetRange: at(10, 20), targetSelectionRange: at(10, 10) }]);
  assert.equal(found.length, 2);
  assert.equal(found[1].range.end.line, 19, "a link's whole target range, so the body can be shown");
  assert.deepEqual(locations(undefined), []);
});

test("git status and numstat output are read right: staged, unstaged, new, renamed, deleted, binary", () => {
  const status = parseStatus(["M  a.js", " M b.js", "MM c.js", "?? new.js", "R  d2.js", "d.js", " D e.js", "UU f.js", ""].join(NUL));
  assert.deepEqual(status.map((e) => [e.path, e.label]), [["a.js", "modified (staged)"], ["b.js", "modified"],
    ["c.js", "modified (staged and unstaged)"], ["new.js", "new, not in git yet"], ["d2.js", "renamed from d.js (staged)"],
    ["e.js", "deleted"], ["f.js", "conflicted"]]);
  assert.deepEqual(parseNumstat(["12\t3\ta.js", "-\t-\tlogo.png", "1\t1\t", "old.js", "new.js", ""].join(NUL)),
    [["a.js", "+12 −3"], ["logo.png", "binary"], ["new.js", "+1 −1"]]);
});

test("git runs as one fixed program with the safe options, in a real repository", async (t) => {
  const git = process.platform === "win32" ? "git.exe" : "git";
  const ok = await runGit(git, os.tmpdir(), ["--version"]).then(() => true, () => false);
  if (!ok) { t.skip("no git here"); return; }
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "solder-git-"));
  const who = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
  try {
    const run = (/** @type {string[]} */ args) => runGit(git, repo, args);
    await run(["init", "-q"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    await run(["add", "a.txt"]);
    await run([...who, "commit", "-q", "-m", "a"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
    fs.writeFileSync(path.join(repo, "b.txt"), "new\n");
    // A repository that asks for an external diff program and a textconv filter: neither may run.
    fs.writeFileSync(path.join(repo, ".gitattributes"), "*.txt diff=evil\n");
    await run(["config", "diff.evil.command", "this-program-does-not-exist"]);
    await run(["config", "diff.evil.textconv", "this-program-does-not-exist"]);
    const status = parseStatus(await run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]));
    assert.deepEqual(status.map((e) => e.path).sort(), [".gitattributes", "a.txt", "b.txt"]);
    const diff = await run(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-U3", "HEAD", "--", "a.txt"]);
    assert.match(diff, /^\+two$/m);
    await assert.rejects(runGit(git, os.tmpdir(), ["rev-parse", "--show-toplevel"]), /not a git repository/i);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("backups stay under the storage limit, oldest first; a deleted chat's backups go with it", () => {
  const { WorkspaceTools } = require("../src/tools.js");
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "solder-store-"));
  try {
    const tools = new WorkspaceTools(/** @type {any} */ ({ globalStorageUri: { fsPath: store }, subscriptions: [] }));
    const root = tools.backupsRoot();
    const put = (/** @type {string} */ chat, /** @type {string} */ name, /** @type {number} */ bytes, /** @type {number} */ age) => {
      fs.mkdirSync(path.join(root, chat), { recursive: true });
      const file = path.join(root, chat, name);
      fs.writeFileSync(file, Buffer.alloc(bytes));
      const when = new Date(Date.now() - age * 1000);
      fs.utimesSync(file, when, when);
    };
    put("c1", "oldest.js", 4000, 300);
    put("c1", "older.js", 4000, 200);
    put("c2", "newer.js", 4000, 100);
    put("c2", "newest.js", 4000, 10);
    const result = tools.pruneBackups(10_000);
    assert.equal(result.removed, 2, "down to 90% of the limit, oldest first");
    assert.ok(!fs.existsSync(path.join(root, "c1", "oldest.js")) && !fs.existsSync(path.join(root, "c1", "older.js")));
    assert.ok(fs.existsSync(path.join(root, "c2", "newest.js")));
    assert.equal(tools.pruneBackups(10_000).removed, 0, "under the limit: nothing goes");
    tools.removeBackups("c2");
    assert.ok(!fs.existsSync(path.join(root, "c2")));
    tools.removeBackups("../escape"); // not a chat id: ignored
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("asked first: git's and VS Code's files, links out of the workspace, reads outside it; plain instruction names only", () => {
  const { WorkspaceTools, plainNames, runsPrograms } = require("../src/tools.js");
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "solder-safe-"));
  try {
    const ws = path.join(top, "ws");
    const outside = path.join(top, "outside");
    fs.mkdirSync(path.join(ws, ".git"), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "s");
    fs.writeFileSync(path.join(ws, "a.js"), "a");
    fs.symlinkSync(outside, path.join(ws, "out"), "junction");
    const tools = new WorkspaceTools(/** @type {any} */ ({ globalStorageUri: { fsPath: path.join(top, "store") }, subscriptions: [] }));
    tools.root = () => ws;
    tools.docsFolders = () => [];
    const ask = (/** @type {string} */ name, /** @type {any} */ args) => tools.needsApproval(name, args);
    assert.equal(ask("write_file", { path: "a.js" }), null);
    assert.match(String(ask("write_file", { path: ".git/config" })), /\.git, where a change can make programs run/);
    assert.match(String(ask("edit_file", { path: ".gitattributes" })), /programs run/);
    assert.match(String(ask("write_file", { path: ".VSCode/tasks.json" })), /\.vscode/);
    assert.match(String(ask("move_item", { from: "a.js", to: ".git/hooks/pre-commit" })), /programs run/);
    assert.match(String(ask("write_file", { path: "out/.bashrc" })), /outside the workspace/, "a junction out of the workspace is outside");
    assert.equal(tools.resolve("out/secret.txt").inside, false);
    assert.equal(ask("read_file", { path: "a.js" }), null);
    assert.match(String(ask("read_file", { path: path.join(outside, "secret.txt") })), /reads a file outside/);
    tools.docsFolders = () => [{ path: outside }];
    assert.equal(ask("read_file", { path: path.join(outside, "secret.txt") }), null, "docs folders are read freely");
    assert.match(String(ask("changes", { path: outside })), /runs git in a folder outside/);
    assert.throws(() => tools.resolve("\\\\server\\share\\a.txt"), /Network paths/);
    assert.equal(runsPrograms(path.join(ws, "src", "git.js")), "");
    assert.deepEqual(plainNames(["AGENTS.md", "../../.ssh/id_rsa", "sub/X.md", "C:x", "..", "CLAUDE.md", 3]), ["AGENTS.md", "CLAUDE.md"]);
  } finally {
    fs.rmSync(top, { recursive: true, force: true });
  }
});
