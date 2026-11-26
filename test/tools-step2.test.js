// @ts-check
"use strict";
// src/tools.js: read_file of a wrong folder reads the one file of that name; folder rules (a subfolder's AGENTS.md)
// come with search and symbols results, and before the first change in that folder. A stand-in for the vscode module.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const uriOf = (/** @type {string} */ fsPath) => ({ fsPath, scheme: "file", toString: () => "file:" + fsPath.toLowerCase() });
/** @type {any[]} the open documents */
const docs = [];
/** @type {any[]} the editor tabs */
const tabs = [];
/** @type {Map<string, any[]>} */
const diagnostics = new Map();
/** @type {Set<(event: any) => void>} */
const listeners = new Set();
const same = (/** @type {any} */ a, /** @type {string} */ b) => a.fsPath.toLowerCase() === b.toLowerCase();
class Range { constructor(/** @type {number} */ start, /** @type {number} */ end) { this.start = start; this.end = end; } }
class Position { constructor(/** @type {number} */ line, /** @type {number} */ character) { this.line = line; this.character = character; } }
class WorkspaceEdit {
  constructor() { /** @type {any[]} */ this.ops = []; }
  replace(/** @type {any} */ uri, /** @type {Range} */ range, /** @type {string} */ text) { this.ops.push({ kind: "replace", uri, range, text }); }
}
/** Every file is checked at once and has no problems. @param {string} full */
function report(full) {
  diagnostics.set(full.toLowerCase(), []);
  for (const listener of [...listeners]) listener({ uris: [uriOf(full)] });
}
/** @param {string} full */
function openDoc(full) {
  const doc = {
    uri: uriOf(full), languageId: "javascript", isDirty: false, eol: 1, text: fs.readFileSync(full, "utf8"),
    get lineCount() { return this.text.split("\n").length; },
    getText() { return this.text; },
    lineAt(/** @type {number} */ i) { return { text: this.text.split("\n")[i] }; },
    positionAt(/** @type {number} */ offset) { return offset; },
    async save() { fs.writeFileSync(full, this.text); this.isDirty = false; setTimeout(() => report(full), 5); return true; },
  };
  docs.push(doc);
  return doc;
}
/** @type {any} the tools module, once loaded (the findFiles stand-in walks with its helpers) */
let T;
const vscodeStub = {
  Uri: { file: uriOf }, Position, Range, WorkspaceEdit,
  FileType: { File: 1, Directory: 2 }, EndOfLine: { LF: 1, CRLF: 2 }, DiagnosticSeverity: { Error: 0, Warning: 1 }, env: { appRoot: "" },
  RelativePattern: class { constructor(/** @type {string} */ base, /** @type {string} */ pattern) { this.base = base; this.pattern = pattern; } },
  languages: {
    onDidChangeDiagnostics: (/** @type {any} */ listener) => { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; },
    getDiagnostics: (/** @type {any} */ uri) => diagnostics.get(uri.fsPath.toLowerCase()) ?? [],
  },
  window: { activeTextEditor: undefined, tabGroups: { all: [{ tabs }], close: async () => {} } },
  commands: {
    executeCommand: async (/** @type {string} */ id, /** @type {any} */ uri) => {
      if (id === "vscode.open") { tabs.push({ input: { uri: uriOf(uri.fsPath) }, isDirty: false }); setTimeout(() => report(uri.fsPath), 5); }
      return undefined; // no language support: symbols falls back to text matches
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
      rename: async (/** @type {any} */ from, /** @type {any} */ to) => fs.renameSync(from.fsPath, to.fsPath),
      copy: async (/** @type {any} */ from, /** @type {any} */ to) => fs.cpSync(from.fsPath, to.fsPath, { recursive: true }),
    },
    // As VS Code's: the files under the pattern's folder whose path matches its glob.
    findFiles: async (/** @type {any} */ pattern, /** @type {any} */ _exclude, /** @type {number} */ max) =>
      T.walkFiles(pattern.base, T.globPattern(pattern.pattern), max ?? 1000).map(uriOf),
    openTextDocument: async (/** @type {any} */ uri) => docs.find((d) => same(d.uri, uri.fsPath)) ?? openDoc(uri.fsPath),
    applyEdit: async (/** @type {WorkspaceEdit} */ edit) => {
      for (const op of edit.ops) {
        const doc = docs.find((d) => same(d.uri, op.uri.fsPath));
        doc.text = doc.text.slice(0, op.range.start) + op.text + doc.text.slice(op.range.end);
        doc.isDirty = true;
      }
      return true;
    },
  },
};
const load = /** @type {any} */ (Module)._load;
/** @type {any} */ (Module)._load = function (/** @type {string} */ request, /** @type {any[]} */ ...rest) {
  return request === "vscode" ? vscodeStub : load.call(this, request, ...rest);
};
T = require("../src/tools.js");
const { WorkspaceTools } = T;
const { RESULTS } = require("../src/prompt.js");

const RULES = "Every new function gets a line `// Owner: plant-ops` right above it.";

/** A workspace in a new folder, nothing open. @param {string} name */
function workspace(name) {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), `solder-${name}-`));
  const ws = path.join(top, "ws");
  fs.mkdirSync(ws);
  const tools = new WorkspaceTools(/** @type {any} */ ({ globalStorageUri: { fsPath: path.join(top, ".store") }, subscriptions: [] }));
  tools.roots = () => [ws];
  /** @type {any} */ (tools)._pruned = Date.now(); // no pruning timer left running
  /** @type {any} */ (tools)._rg = null; // the search without ripgrep: the same everywhere
  docs.length = 0;
  tabs.length = 0;
  diagnostics.clear();
  const write = (/** @type {string} */ rel, /** @type {string} */ text) => {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), text);
  };
  return { top, ws, tools, write, done: () => fs.rmSync(top, { recursive: true, force: true }) };
}

/** A chat in the middle of a reply from the model; reply() starts the next one. */
function newChat() {
  const chat = /** @type {any} */ ({ id: "c2", messages: [{ role: "user", content: "go" }, { role: "assistant", content: "", tool_calls: [] }] });
  const reply = () => { chat.messages.push({ role: "tool", content: "…" }, { role: "assistant", content: "", tool_calls: [] }); };
  return { chat, reply };
}
const signal = new AbortController().signal;
const run = (/** @type {any} */ tools, /** @type {string} */ name, /** @type {any} */ args, /** @type {any} */ chat) => tools.run(name, args, { chat, signal });

// ------------------------------------------------------------------------------------------ the wrong folder --

test("read_file of a wrong folder reads the one file of that name, and says so at the top", async () => {
  const { tools, write, done } = workspace("wrongpath");
  try {
    write("src/greet.js", "function greet(name) {\n  return \"Helo, \" + name;\n}\n");
    const { chat } = newChat();
    const read = await run(tools, "read_file", { path: "greet.js" }, chat);
    assert.ok(!read.failed, read.output);
    assert.equal(read.output.split("\n")[0], RESULTS.readInstead("greet.js", "src/greet.js"));
    assert.match(read.output, /^2\t {2}return "Helo, " \+ name;$/m);
    assert.match(read.summary, /^Read src\/greet\.js/, "the summary names the file read");
    // Another folder, and another case: the same file.
    const other = await run(tools, "read_file", { path: "utils/GREET.JS", start_line: 1, end_line: 1 }, chat);
    assert.equal(other.output.split("\n")[0], RESULTS.readInstead("GREET.JS", "src/greet.js"));
    assert.match(other.output, /^1\tfunction greet/m);
    // A path that's there is read as ever.
    assert.ok(!(await run(tools, "read_file", { path: "src/greet.js" }, chat)).output.includes("isn't at that path"));
  } finally { done(); }
});

test("read_file of a missing path: two of that name, another extension, a change, outside or asked about: the error, as before", async () => {
  const { top, tools, write, done } = workspace("wrongpath2");
  try {
    write("src/greet.js", "a\n");
    write("lib/greet.js", "b\n");
    write("src/dates.ts", "c\n");
    const { chat } = newChat();
    const two = await run(tools, "read_file", { path: "greet.js" }, chat);
    assert.ok(two.failed);
    assert.ok(two.output.startsWith(RESULTS.error(RESULTS.missing("greet.js"))));
    assert.match(two.output, /lib\/greet\.js/, "both are suggested");
    const ext = await run(tools, "read_file", { path: "dates.js" }, chat);
    assert.ok(ext.failed && ext.output.startsWith(RESULTS.error(RESULTS.missing("dates.js"))), "another extension is only suggested");
    fs.rmSync(path.join(top, "ws", "lib"), { recursive: true });
    // One now, but a change never goes to another file.
    const edit = await run(tools, "edit_file", { path: "greet.js", old_text: "a", new_text: "z" }, chat);
    assert.ok(edit.failed && edit.output.startsWith(RESULTS.error(RESULTS.missing("greet.js"))));
    assert.equal(fs.readFileSync(path.join(top, "ws", "src", "greet.js"), "utf8"), "a\n");
    // A path outside the workspace isn't swapped for one in it.
    const outside = await run(tools, "read_file", { path: path.join(top, "elsewhere", "greet.js") }, chat);
    assert.ok(outside.failed);
    // A file whose read would be asked about isn't read in its place.
    const asking = /** @type {any} */ (tools);
    asking.needsApproval = () => "asked";
    const asked = await run(tools, "read_file", { path: "greet.js" }, chat);
    assert.ok(asked.failed && asked.output.startsWith(RESULTS.error(RESULTS.missing("greet.js"))));
    // A folder of that name isn't a file.
    delete asking.needsApproval;
    write("x/notes/keep.txt", "k\n");
    assert.ok((await run(tools, "read_file", { path: "notes" }, chat)).failed);
  } finally { done(); }
});

// ------------------------------------------------------------------------------------------- folder rules --

/** A workspace with its own AGENTS.md at the top, and one in src/plant. */
function plant(/** @type {string} */ name) {
  const w = workspace(name);
  w.write("AGENTS.md", "Top rules.");
  w.write("src/plant/AGENTS.md", RULES);
  w.write("src/plant/pump.js", "function startPump(id) {\n  return id;\n}\nmodule.exports = { startPump };\n");
  w.write("src/plant/valve.js", "function openValve(id) {\n  return startPump(id);\n}\nmodule.exports = { openValve };\n");
  w.write("src/app.js", "const { startPump } = require(\"./plant/pump\");\nstartPump(1);\n");
  return w;
}

test("a search brings the rules of the folders it found things in, once a chat; the workspace's own aren't sent again", async () => {
  const { tools, done } = plant("rules-search");
  try {
    const { chat } = newChat();
    const found = await run(tools, "search", { query: "startPump" }, chat);
    assert.ok(!found.failed, found.output);
    assert.equal(found.keep, RESULTS.folderAgents("src/plant/AGENTS.md", RULES));
    assert.ok(!String(found.keep).includes("Top rules."), "the workspace's own rules are in the system prompt");
    const again = await run(tools, "search", { query: "openValve", files_only: true }, chat);
    assert.equal(again.keep, undefined, "given once a chat");
    // Nothing found, or a file outside any folder with rules: nothing comes along.
    const fresh = newChat().chat;
    assert.equal((await run(tools, "search", { query: "nothing like it" }, fresh)).keep, undefined);
    assert.equal((await run(tools, "search", { query: "startPump(1)" }, fresh)).keep, undefined);
    // files_only and context_lines name the files too.
    assert.match(String((await run(tools, "search", { query: "openValve", files_only: true }, fresh)).keep), /Owner: plant-ops/);
    const other = newChat().chat;
    assert.match(String((await run(tools, "search", { query: "openValve", context_lines: 1 }, other)).keep), /Owner: plant-ops/);
  } finally { done(); }
});

test("a broad search brings at most two folders' rules; the rest come before a change there", async () => {
  const { tools, write, done } = workspace("rules-many");
  try {
    for (const folder of ["a", "b", "c"]) {
      write(`${folder}/AGENTS.md`, `Rules of ${folder}.`);
      write(`${folder}/x.js`, "const marker = 1;\n");
    }
    const { chat, reply } = newChat();
    const found = await run(tools, "search", { query: "marker" }, chat);
    assert.equal((String(found.keep).match(/This folder's/g) || []).length, 2);
    assert.ok(!String(found.keep).includes("Rules of c."));
    reply();
    const edit = await run(tools, "edit_file", { path: "c/x.js", old_text: "marker = 1", new_text: "marker = 2" }, chat);
    assert.ok(edit.failed);
    assert.match(String(edit.keep), /Rules of c\./);
  } finally { done(); }
});

test("symbols brings the rules of the folders its answer is in", async () => {
  const { tools, done } = plant("rules-symbols");
  try {
    const { chat } = newChat();
    const uses = await run(tools, "symbols", { name: "openValve" }, chat);
    assert.ok(!uses.failed, uses.output);
    assert.equal(uses.keep, RESULTS.folderAgents("src/plant/AGENTS.md", RULES));
    const fresh = newChat().chat;
    const outline = await run(tools, "symbols", { path: "src/plant/pump.js", name: "startPump" }, fresh);
    assert.match(String(outline.keep), /Owner: plant-ops/, "the file it was asked about");
  } finally { done(); }
});

test("the first change in a folder with rules the model hasn't seen isn't made: the rules come back, and the next call goes through", async () => {
  const { ws, tools, done } = plant("rules-edit");
  try {
    const { chat, reply } = newChat();
    const args = { path: "src/plant/pump.js", old_text: "  return id;", new_text: "  return id + 1;" };
    const first = await run(tools, "edit_file", args, chat);
    assert.ok(first.failed);
    assert.equal(first.output, RESULTS.error(RESULTS.rulesFirst("src/plant/pump.js", ["src/plant/AGENTS.md"], true, false)));
    assert.equal(first.keep, RESULTS.folderAgents("src/plant/AGENTS.md", RULES));
    assert.match(fs.readFileSync(path.join(ws, "src", "plant", "pump.js"), "utf8"), /return id;/, "not changed");
    // Another change in that folder in the same reply was written before the rules came: it waits too, without them again.
    const write = await run(tools, "write_file", { path: "src/plant/meter.js", content: "function read() {}\n" }, chat);
    assert.ok(write.failed && write.keep === undefined);
    assert.equal(write.output, RESULTS.error(RESULTS.rulesFirst("src/plant/meter.js", ["src/plant/AGENTS.md"], false, true)));
    assert.ok(!fs.existsSync(path.join(ws, "src", "plant", "meter.js")));
    // A change elsewhere goes ahead.
    assert.ok(!(await run(tools, "edit_file", { path: "src/app.js", old_text: "startPump(1);", new_text: "startPump(2);" }, chat)).failed);
    reply();
    const second = await run(tools, "edit_file", args, chat);
    assert.ok(!second.failed, second.output);
    assert.match(fs.readFileSync(path.join(ws, "src", "plant", "pump.js"), "utf8"), /return id \+ 1;/);
    assert.ok(!(await run(tools, "write_file", { path: "src/plant/meter.js", content: "// Owner: plant-ops\nfunction read() {}\n" }, chat)).failed);
  } finally { done(); }
});

test("rules given by a read in an earlier reply, or by the chat's record after compaction, don't stop a change", async () => {
  const { ws, tools, done } = plant("rules-seen");
  try {
    const { chat, reply } = newChat();
    const read = await run(tools, "read_file", { path: "src/plant/pump.js" }, chat);
    assert.equal(read.keep, RESULTS.folderAgents("src/plant/AGENTS.md", RULES));
    // The same reply: the edit was written before the read's rules came.
    const now = await run(tools, "edit_file", { path: "src/plant/pump.js", old_text: "  return id;", new_text: "  return -id;" }, chat);
    assert.ok(now.failed && now.keep === undefined);
    reply();
    assert.ok(!(await run(tools, "edit_file", { path: "src/plant/pump.js", old_text: "  return id;", new_text: "  return -id;" }, chat)).failed);
    // A chat whose record says they were given (the text since summarised away): given, no loop.
    const compacted = /** @type {any} */ ({ id: "c3", agentsSeen: [path.join(ws, "src", "plant", "AGENTS.md").toLowerCase()],
      compaction: { through: 2, summary: "S" }, messages: [{ role: "user", content: "go" }, { role: "assistant", content: "" }] });
    assert.ok(!(await run(tools, "write_file", { path: "src/plant/new.js", content: "// Owner: plant-ops\nfunction x() {}\n" }, compacted)).failed);
  } finally { done(); }
});

test("a new file in a new folder under rules, a move into it, and the rules file itself", async () => {
  const { ws, tools, write, done } = plant("rules-new");
  try {
    write("loose.js", "const loose = 1;\n");
    const { chat, reply } = newChat();
    const made = await run(tools, "write_file", { path: "src/plant/deep/new.js", content: "x\n" }, chat);
    assert.ok(made.failed && /Owner: plant-ops/.test(String(made.keep)));
    assert.ok(!fs.existsSync(path.join(ws, "src", "plant", "deep")), "no folder made either");
    const other = newChat();
    const moved = await run(tools, "move_item", { from: "loose.js", to: "src/plant/loose.js" }, other.chat);
    assert.ok(moved.failed && /Owner: plant-ops/.test(String(moved.keep)));
    assert.ok(fs.existsSync(path.join(ws, "loose.js")), "not moved");
    other.reply();
    assert.ok(!(await run(tools, "move_item", { from: "loose.js", to: "src/plant/loose.js" }, other.chat)).failed);
    // Changing the rules file itself doesn't wait for it (that change is asked about anyway).
    const rules = newChat().chat;
    assert.ok(!(await run(tools, "write_file", { path: "src/plant/AGENTS.md", content: RULES + "\nMore.\n" }, rules)).failed);
    // Nor does a change at the top, whose rules are the system prompt's; nor one with no folder rules at all.
    assert.ok(!(await run(tools, "write_file", { path: "top.js", content: "y\n" }, rules)).failed);
    reply();
    assert.ok(!(await run(tools, "write_file", { path: "src/plant/deep/new.js", content: "x\n" }, chat)).failed);
  } finally { done(); }
});

test("the paths a search or symbols result names", () => {
  assert.deepEqual(T.namedPaths([
    "src/a.js:3:const x = 1;", "src/b.js (4)", "lib/c.js 10–20:", "10\tcode: 1", "C:\\w\\d.js 4 (outside the workspace)",
    "src/e.js (lines 3–9):", "4\tline", "src/a.js:9:again", "C:\\w\\f.js:2: use",
  ].join("\n")), ["src/a.js", "src/b.js", "lib/c.js", "C:\\w\\d.js", "src/e.js", "C:\\w\\f.js"]);
});

// ------------------------------------------------------------------------------- the live tests' stand-ins --

test("the live host's tools do the same: the one file of that name is read, folder rules come with a search and before a change", async () => {
  const { solder, workspaceHost } = require("../live/host.js");
  const { ws, write, done } = plant("rules-live");
  try {
    write("src/greet.js", "function greet() {}\n");
    const S = solder(path.join(__dirname, "..", "src"));
    const { host } = workspaceHost(ws, S);
    const { chat, reply } = newChat();
    const read = await host.runTool("read_file", { path: "greet.js" }, { chat });
    assert.equal(read.output.split("\n")[0], RESULTS.readInstead("greet.js", "src/greet.js"));
    assert.match(read.summary, /^Read src\/greet\.js/);
    const found = await host.runTool("search", { query: "startPump" }, { chat });
    assert.equal(found.keep, RESULTS.folderAgents("src/plant/AGENTS.md", RULES));
    const edit = { path: "src/plant/pump.js", old_text: "  return id;", new_text: "  return id + 1;" };
    const first = await host.runTool("edit_file", edit, { chat });
    assert.ok(first.failed && first.keep === undefined, "given in this reply: waits, without the rules again");
    reply();
    assert.ok(!(await host.runTool("edit_file", edit, { chat })).failed);
    const other = newChat().chat;
    const made = await host.runTool("write_file", { path: "src/plant/new.js", content: "x\n" }, { chat: other });
    assert.ok(made.failed && /Owner: plant-ops/.test(String(made.keep)));
    const readThere = await host.runTool("read_file", { path: "src/plant/valve.js" }, { chat: newChat().chat });
    assert.match(String(readThere.keep), /Owner: plant-ops/, "a read brings them too");
  } finally { done(); }
});

test("the folder-rules scenarios' checks: the owner line above the new function passes, without it fails", () => {
  const { SCENARIOS } = require("../live/scenarios.js");
  const edit = SCENARIOS.find((/** @type {any} */ s) => s.name === "folder-rules-edit");
  const made = SCENARIOS.find((/** @type {any} */ s) => s.name === "folder-rules-new-file");
  const { ws, done } = workspace("rules-checks");
  try {
    const files = /** @type {Record<string, string>} */ ({});
    edit.setup((/** @type {string} */ rel, /** @type {string} */ text) => { files[rel] = text; });
    assert.match(files["src/plant/AGENTS.md"], /Owner: plant-ops/);
    const read = (/** @type {string} */ rel) => { if (!(rel in files)) throw new Error("no file"); return files[rel]; };
    const load = (/** @type {string} */ rel) => {
      const full = path.join(ws, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, files[rel]);
      delete require.cache[require.resolve(full)];
      return require(full);
    };
    const pump = files["src/plant/pump.js"];
    files["src/plant/pump.js"] = pump.replace("\nfunction pumpState", "\n// Owner: plant-ops\nfunction stopPump(id) {\n  return \"stopped \" + id;\n}\n\nfunction pumpState")
      .replace("pumpState };", "pumpState, stopPump };");
    assert.equal(edit.check({ read, load }), "");
    files["src/plant/pump.js"] = pump.replace("\nfunction pumpState", "\nfunction stopPump(id) {\n  return \"stopped \" + id;\n}\n\nfunction pumpState")
      .replace("pumpState };", "pumpState, stopPump };");
    assert.match(edit.check({ read, load }), /no `\/\/ Owner: plant-ops` line/);
    assert.equal(made.check({ read, load }), "no src/plant/valve.js");
    files["src/plant/valve.js"] = "// Owner: plant-ops\nfunction openValve(id) {\n  return \"open \" + id;\n}\nmodule.exports = { openValve };\n";
    assert.equal(made.check({ read, load }), "");
    files["src/plant/valve.js"] = "function openValve(id) {\n  return \"open \" + id;\n}\nmodule.exports = { openValve };\n";
    assert.match(made.check({ read, load }), /no `\/\/ Owner: plant-ops` line/);
  } finally { done(); }
});
