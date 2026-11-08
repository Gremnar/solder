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
  return request === "vscode" ? { SymbolKind, Position, Uri: { file: (/** @type {string} */ fsPath) => ({ fsPath, scheme: "file" }) }, languages: { onDidChangeDiagnostics: () => ({ dispose() {} }) }, FileType: { File: 1, Directory: 2 },
    workspace: { textDocuments: [], getConfiguration: () => ({ get: (/** @type {string} */ _key, /** @type {any} */ fallback) => fallback }),
      fs: { stat: async (/** @type {any} */ uri) => { const st = fs.statSync(uri.fsPath); return { type: st.isDirectory() ? 2 : 1, size: st.size }; } },
      openTextDocument: async (/** @type {any} */ uri) => {
        const all = fs.readFileSync(uri.fsPath, "utf8").split(/\r\n|\r|\n/);
        return { lineCount: all.length, lineAt: (/** @type {number} */ i) => ({ text: all[i] }), getText: () => all.join("\n") };
      } } } : load.call(this, request, ...rest);
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
    tools.roots = () => [ws];
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

test("read_file shows a signed script with its signature as one line, and later lines keep their numbers", async () => {
  const { WorkspaceTools } = require("../src/tools.js");
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "solder-sig-"));
  try {
    const base64 = Array.from({ length: 150 }, (_, i) => "# MIIfZwYJKoZIhvcNAQcCoIIfWDCCH1QCAQExCzAJBgUrDgMCGgUAMGkGCisG" + String(i).padStart(4, "A"));
    fs.writeFileSync(path.join(top, "run.ps1"), ["Write-Host 'one'", "Write-Host 'two'", "# SIG # Begin signature block", ...base64, "# SIG # End signature block", ""].join("\r\n"));
    const tools = new WorkspaceTools(/** @type {any} */ ({ globalStorageUri: { fsPath: path.join(top, "store") }, subscriptions: [] }));
    tools.roots = () => [top];
    const { output } = await tools.readFile({ path: "run.ps1" }, {});
    const lines = output.split("\n");
    assert.equal(lines.length, 6, output.slice(0, 300));
    assert.equal(lines[2], "3\t# SIG # Begin signature block");
    assert.match(lines[3], /lines 4–153: the file's digital signature, left out/);
    assert.equal(lines[4], "154\t# SIG # End signature block");
    assert.ok(output.length < 400, "about 3,000 tokens of base64 become one line");
  } finally {
    fs.rmSync(top, { recursive: true, force: true });
  }
});

test("a diff's run of signature lines is one line; ordinary comments are left alone", () => {
  const { withoutSignatureLines } = require("../src/tools.js");
  const { RESULTS } = require("../src/prompt.js");
  const sig = (/** @type {string} */ mark, /** @type {number} */ n) => Array.from({ length: n }, (_, i) => mark + "# MIIfZwYJKoZIhvcNAQcCoIIfWDCC" + String(i).padStart(6, "B"));
  const diff = ["@@ -10,8 +10,8 @@", " Write-Host 'done'", ...sig("-", 40), ...sig("+", 40), " # SIG # End signature block"].join("\n");
  assert.equal(withoutSignatureLines(diff), ["@@ -10,8 +10,8 @@", " Write-Host 'done'", "-" + RESULTS.signatureInDiff(40), "+" + RESULTS.signatureInDiff(40), " # SIG # End signature block"].join("\n"));
  const comments = ["+# This is a normal comment", "+# another one here", "+# and a third", "+# and a fourth"].join("\n");
  assert.equal(withoutSignatureLines(comments), comments);
});

test("an edit isn't refused as 'changed on disk' for mixed line endings, a BOM or UTF-16; a real change still is", () => {
  const { stale } = require("../src/tools.js");
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "solder-stale-"));
  try {
    const file = (/** @type {string} */ name, /** @type {Buffer | string} */ data) => {
      const full = path.join(top, name);
      fs.writeFileSync(full, data);
      return { full, shown: name };
    };
    // What VS Code holds: one kind of line ending, no BOM.
    const editor = (/** @type {string} */ text) => ({ isDirty: false, getText: () => text });
    // A script saved with LF, then signed (the signature block comes with CRLF): VS Code evens it out to one kind.
    const mixed = file("signed.ps1", "Write-Host 'a'\nWrite-Host 'b'\n# SIG # Begin signature block\r\n# MIIa\r\n# SIG # End signature block\r\n");
    assert.doesNotThrow(() => stale(editor("Write-Host 'a'\r\nWrite-Host 'b'\r\n# SIG # Begin signature block\r\n# MIIa\r\n# SIG # End signature block\r\n"), mixed));
    const bom = file("bom.ps1", "\uFEFFWrite-Host 'a'\r\n");
    assert.doesNotThrow(() => stale(editor("Write-Host 'a'\r\n"), bom));
    const utf16 = file("utf16.ps1", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Write-Host 'a'\r\n", "utf16le")]));
    assert.doesNotThrow(() => stale(editor("Write-Host 'a'\r\n"), utf16));
    const changed = file("changed.ps1", "Write-Host 'changed outside'\r\n");
    assert.throws(() => stale(editor("Write-Host 'a'\r\n"), changed), /changed on disk a moment ago/);
    assert.doesNotThrow(() => stale({ isDirty: true, getText: () => "unsaved typing" }, changed), "unsaved changes are the editor's, not stale");
  } finally {
    fs.rmSync(top, { recursive: true, force: true });
  }
});

test("several workspace folders: each is inside; paths in the others are shown in full; the working folder can be in any", () => {
  const { WorkspaceTools } = require("../src/tools.js");
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "solder-roots-"));
  try {
    const share = path.join(top, "share");
    const local = path.join(top, "local");
    const outside = path.join(top, "outside");
    for (const dir of [path.join(share, "src"), path.join(local, "lib"), outside]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(local, "lib", "a.ps1"), "x");
    const tools = new WorkspaceTools(/** @type {any} */ ({ globalStorageUri: { fsPath: path.join(top, "store") }, subscriptions: [] }));
    tools.roots = () => [share, local];
    tools.docsFolders = () => [];
    assert.equal(tools.root(), share, "the first is the main one");
    assert.equal(tools.rootOf(path.join(local, "lib", "a.ps1")), local);
    assert.equal(tools.rootOf(outside), "");
    // No working folder: relative paths start in the main folder; the other folder's files are shown in full.
    assert.equal(tools.resolve("src/x.js").full, path.join(share, "src", "x.js"));
    assert.equal(tools.resolve(path.join(local, "lib", "a.ps1")).inside, true);
    assert.equal(tools.shown(path.join(local, "lib", "a.ps1")), path.join(local, "lib", "a.ps1"));
    assert.equal(tools.resolve(path.join(outside, "b.txt")).inside, false);
    assert.equal(tools.needsApproval("write_file", { path: path.join(local, "lib", "a.ps1") }), null, "no asking in another workspace folder");
    assert.match(String(tools.needsApproval("write_file", { path: path.join(outside, "b.txt") })), /outside the workspace/);
    assert.deepEqual(tools.searchRoots(), [share, local], "searches cover every folder");
    // Working in the other folder (kept as its full path): relative paths and searches start there.
    tools.useFolder(path.join(local, "lib"));
    assert.equal(tools.base(), path.join(local, "lib"));
    assert.equal(tools.resolve("a.ps1").full, path.join(local, "lib", "a.ps1"));
    assert.equal(tools.shown(path.join(local, "lib", "a.ps1")), "a.ps1");
    assert.equal(tools.shown(path.join(share, "src", "x.js")), path.join(share, "src", "x.js"), "the main folder's files, in full from there");
    assert.deepEqual(tools.searchRoots(), [path.join(local, "lib")]);
    // A relative working folder is in the main folder, as before.
    tools.useFolder("src");
    assert.equal(tools.base(), path.join(share, "src"));
  } finally {
    fs.rmSync(top, { recursive: true, force: true });
  }
});

test("file names match regardless of case (VS Code's findFiles doesn't, even on Windows), and the walk finds them too", () => {
  const { caseless, globPattern, walkFiles } = require("../src/tools.js");
  assert.equal(caseless("**/*net*.ps1"), "**/*[nN][eE][tT]*.[pP][sS]1");
  assert.equal(caseless("src/[A-C]x.js"), "[sS][rR][cC]/[A-C][xX].[jJ][sS]", "a [...] class is left as it is");
  const cases = [
    ["**/*newdomainnetbioscheck*", "Scripts/AD/Checks/NewDomainNetbiosCheck.ps1", true],
    ["**/newdomainnetbioscheck.ps1", "a/b/c/NewDomainNetBIOSCheck.PS1", true],
    ["**/*.{ps1,psm1}", "x/y.psm1", true],
    ["src/*.js", "src/a/b.js", false],
    ["**/test_?.py", "t/test_1.py", true],
    ["**/*.ps1", "a.ps1", true],
    ["**/*.ps1", "a.ps1.bak", false],
  ];
  for (const [glob, file, expected] of cases) assert.equal(globPattern(glob).test(file), expected, glob + " vs " + file);
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "solder-walk-"));
  try {
    fs.mkdirSync(path.join(top, "Scripts", "AD", "Checks"), { recursive: true });
    fs.mkdirSync(path.join(top, "node_modules", "x"), { recursive: true });
    fs.writeFileSync(path.join(top, "Scripts", "AD", "Checks", "NewDomainNetbiosCheck.ps1"), "x");
    fs.writeFileSync(path.join(top, "node_modules", "x", "newdomainnetbioscheck.ps1"), "x");
    const found = walkFiles(top, globPattern("**/*newdomainnetbioscheck*"), 10).map((file) => path.relative(top, file).split(path.sep).join("/"));
    assert.deepEqual(found, ["Scripts/AD/Checks/NewDomainNetbiosCheck.ps1"], "node_modules is skipped");
  } finally {
    fs.rmSync(top, { recursive: true, force: true });
  }
});

test("minified code: a search shows the text around each match in a long line; read_file shows a long line's start only", async () => {
  const { WorkspaceTools, around, aroundLongMatches } = require("../src/tools.js");
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "solder-min-"));
  try {
    let bundle = "var a=1;";
    for (let i = 0; i < 3000; i++) bundle += `function f${i}(){return ${i}}`;
    bundle += 'vscode.commands.registerCommand("ext.hello",()=>{});' + "x".repeat(400) + 'vscode.commands.registerCommand("ext.bye",()=>{});';
    fs.writeFileSync(path.join(top, "extension.js"), bundle + "\nconsole.log(1)\n");
    // What ripgrep printed: the line's first columns, and its mark. Solder shows the matches instead.
    const shown = aroundLongMatches(["extension.js:1:var a=1;function f0(){return 0} [... omitted end of long line]"], top, "registerCommand", false, false);
    assert.match(shown[0], /^extension\.js:1:…/);
    assert.match(shown[0], /registerCommand\("ext\.hello"/);
    assert.match(shown[0], /registerCommand\("ext\.bye"/);
    assert.ok(shown[0].length < 700, `${shown[0].length} characters, not the whole line`);
    assert.equal(around("short line with a hit", /hit/i), "short line with a hit");
    // read_file: the long line by its start (with the note), and the next lines too.
    const tools = new WorkspaceTools(/** @type {any} */ ({ globalStorageUri: { fsPath: path.join(top, "store") }, subscriptions: [] }));
    tools.roots = () => [top];
    const { output } = await tools.readFile({ path: "extension.js" }, {});
    assert.ok(output.length < 1600, `${output.length} characters`);
    assert.match(output, /line 1 is [\d,]+ characters long, more than one read can show/);
    assert.match(output, /\n2\tconsole\.log\(1\)/, "the lines after it are still read");
    // A long line that isn't huge (a long string, a Markdown paragraph): shown by its start in a wide read, with
    // how to see it whole; whole in a read of just that line.
    const long = "Write-Host '" + "word ".repeat(700) + "end of the line'";
    fs.writeFileSync(path.join(top, "long.ps1"), "# a script\n" + long + "\n# after\n");
    const wide = await tools.readFile({ path: "long.ps1" }, {});
    assert.match(wide.output, /line 2 is [\d,]+ characters long, so only its start is shown\. To see it whole, read just that line \(start_line and end_line 2\)/);
    assert.ok(!wide.output.includes("end of the line"));
    const one = await tools.readFile({ path: "long.ps1", start_line: 2, end_line: 2 }, {});
    assert.ok(one.output.includes("end of the line'"), "the whole line");
    assert.ok(!/characters long/.test(one.output));
  } finally {
    fs.rmSync(top, { recursive: true, force: true });
  }
});

test("edit_file's matching: one uniform indentation shift is forgiven, and new_text shifted with it; anything else isn't", () => {
  const { shiftedMatch, shiftLines, looseMatch } = require("../src/tools.js");
  const file = "function a() {\n    if (x) {\n        call(1);\n        call(2);\n    }\n}\n";
  // old_text two spaces short on every line
  const old = "  if (x) {\n      call(1);";
  assert.equal(looseMatch(file, old, "\n"), null);
  const hit = shiftedMatch(file, old, "\n");
  assert.ok(hit);
  assert.equal(file.slice(hit.start, hit.start + hit.length), "    if (x) {\n        call(1);");
  assert.deepEqual(hit.shift, { add: "  " });
  assert.equal(shiftLines("  if (y) {\n\n      call(3);", hit.shift, "\n"), "    if (y) {\n\n        call(3);");
  // too deep: taken off; a new_text line that can't lose it is refused
  const deep = shiftedMatch(file, "      if (x) {\n          call(1);", "\n");
  assert.deepEqual(deep && deep.shift, { remove: "  " });
  assert.equal(shiftLines(" x", deep.shift, "\n"), null);
  // uneven, tabs for spaces, or in two places: no guess
  assert.equal(shiftedMatch(file, "  if (x) {\n        call(1);", "\n"), null);
  assert.equal(shiftedMatch(file, "\tif (x) {\n\t\tcall(1);", "\n"), null);
  assert.equal(shiftedMatch("  a\n  b\n    a\n    b\n", "a\nb", "\n"), null);
  // tabs, one level short
  const tabs = "x {\n\t\tdo();\n\t\tthen();\n}\n";
  assert.deepEqual(shiftedMatch(tabs, "\tdo();\n\tthen();", "\n")?.shift, { add: "\t" });
});

test("a missed edit shows the file's lines around where it was meant to go; several places show each", () => {
  const { notFound, aroundPlaces } = require("../src/tools.js");
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
  lines[29] = "    target();";
  const error = notFound("a.js", lines.join("\n"), "target();\nnot there", "\n");
  assert.match(error.message, /first line appears at line 30, .*Lines 28-34 as they are now/);
  assert.equal(error.detail.split("\n")[0], "28\tline 28");
  assert.equal(error.detail.split("\n")[2], "30\t    target();");
  assert.equal(error.detail.split("\n").length, 7);
  const none = notFound("a.js", lines.join("\n"), "nowhere", "\n");
  assert.equal(none.detail, "");
  assert.match(none.message, /Read the file again/);
  assert.equal(aroundPlaces("a\nx\nb\nx\nc", [2, 4], "\n"), "1\ta\n2\tx\n3\tb\n…\n3\tb\n4\tx\n5\tc");
});
