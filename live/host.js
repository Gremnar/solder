// @ts-check
"use strict";
/**
 * A workspace on disk for live tests: Solder's own engine, prompt and edit matching, with the tools that need
 * VS Code stood in for by plain file work. JavaScript files get a real syntax check (problems, and new problems
 * after an edit), so a broken edit shows up as it would in the editor.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");

/** Solder's src folder, with the vscode module stood in for (only its pure helpers are used here). @param {string} src */
function solder(src) {
  const load = /** @type {any} */ (Module)._load;
  /** @type {any} */ (Module)._load = function (/** @type {string} */ request, /** @type {any[]} */ ...rest) {
    if (request === "vscode") {
      return { languages: { onDidChangeDiagnostics: () => ({ dispose() {} }) }, Uri: { file: (/** @type {string} */ fsPath) => ({ fsPath, scheme: "file" }) },
        workspace: {}, window: {}, commands: {}, FileType: { File: 1, Directory: 2 }, SymbolKind: {}, Position: class {}, Range: class {} };
    }
    return load.call(this, request, ...rest);
  };
  return {
    ...require(path.join(src, "engine.js")),
    ...require(path.join(src, "gateway.js")),
    prompt: require(path.join(src, "prompt.js")),
    tools: require(path.join(src, "tools.js")),
    // An older src (a baseline) has no skills.
    skills: fs.existsSync(path.join(src, "skills.js")) ? require(path.join(src, "skills.js")) : null,
  };
}

const READ_LINES = 2000;
const OUTPUT_CHARS = 30_000;
const LONG_LINE = 2000;
const LONG_SHOWN = 1000;
const SEARCH_LINES = 200;

/**
 * @param {string} root the workspace @param {any} S Solder's modules (solder())
 * @param {{beforeEdit?: (ws: Workspace, args: any) => void, overrides?: Record<string, (args: any) => any>}} [hooks]
 * @param {string} [skillsFolder] a skills folder (outside the workspace), offered as Solder offers the user's
 */
function workspaceHost(root, S, hooks = {}, skillsFolder = "") {
  const ws = new Workspace(root, S, hooks, skillsFolder);
  const context = () => {
    if (!skillsFolder) return { workspace: root };
    const skills = S.skills.listSkills([skillsFolder]).filter(S.skills.offered ?? ((/** @type {any} */ s) => s.text)).map(({ name, path: file, when }) => ({ name, path: file, when }));
    return { workspace: root, skills, skillsFolder };
  };
  return { ws, host: {
    async systemPrompt() { return S.prompt.systemPrompt(context()); },
    async assistContext() { return context(); },
    needsApproval: () => null,
    async save() {},
    async runTool(/** @type {string} */ name, /** @type {any} */ args, /** @type {any} */ ctx) { return ws.run(name, args, ctx); },
  } };
}

class Workspace {
  /** @param {string} root @param {any} S @param {any} hooks @param {string} skillsFolder */
  constructor(root, S, hooks, skillsFolder) {
    this.root = root;
    this.S = S;
    this.R = S.prompt.RESULTS;
    this.hooks = hooks;
    this.skillsFolder = skillsFolder;
    /** @type {{name: string, args: any, failed: boolean}[]} */
    this.calls = [];
    this.edits = 0;
    /** The files as the scenario set them up: what `changes` compares with (as git would with the last commit). */
    this.start = new Map(this.files().map((f) => [f, fs.readFileSync(f, "utf8")]));
  }

  /** What's changed since the start, as Solder's changes tool says it: the files, then a diff of each. */
  changes(/** @type {any} */ args) {
    const under = args.path ? this.full(args.path) : this.root;
    const now = this.files().filter((f) => f.startsWith(under));
    const changed = now.filter((f) => this.start.has(f) && this.start.get(f) !== fs.readFileSync(f, "utf8"));
    const added = now.filter((f) => !this.start.has(f) && !f.endsWith(".expect.json"));
    if (!changed.length && !added.length) return { output: this.R.noChanges(args.path ? this.shown(under) : ""), summary: "No changes" };
    const diffs = changed.map((f) => {
      const before = String(this.start.get(f)).split("\n");
      const after = fs.readFileSync(f, "utf8").split("\n");
      const gone = before.filter((l) => !after.includes(l)).map((l) => "-" + l);
      const fresh = after.filter((l) => !before.includes(l)).map((l) => "+" + l);
      return `--- a/${this.shown(f)}\n+++ b/${this.shown(f)}\n${[...gone, ...fresh].slice(0, 200).join("\n")}`;
    });
    return { output: this.R.changedFiles(changed.length, true) + "\n" + changed.map((f) => this.shown(f)).join("\n") + "\n\n" + diffs.join("\n\n") +
      (added.length ? "\n\n" + this.R.newFiles(added.map((f) => this.shown(f))) : ""), summary: `${changed.length + added.length} changed` };
  }

  full(/** @type {string} */ p) { return path.resolve(this.root, String(p || "").replace(/\\/g, "/")); }
  shown(/** @type {string} */ full) { return path.relative(this.root, full).split(path.sep).join("/"); }
  files() {
    /** @type {string[]} */
    const out = [];
    const walk = (/** @type {string} */ dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const f = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(f); else out.push(f);
      }
    };
    walk(this.root);
    return out.sort();
  }

  /** @param {string} name @param {any} args @param {any} [ctx] the engine's (its chat) */
  async run(name, args, ctx) {
    let result;
    try {
      const own = this.hooks.overrides?.[name];
      // A skill's file goes through Solder's own read (whole, kept, not twice), as it does in VS Code.
      const skill = name === "read_file" && this.skillsFolder && args?.path
        ? this.S.tools.WorkspaceTools.prototype.readSkill.call({ skillsFolders: () => [this.skillsFolder] }, this.full(args.path), ctx?.chat) : null;
      result = skill ?? (own ? await own.call(this, args) : await this.tool(name, args));
    } catch (error) {
      const e = /** @type {any} */ (error);
      result = e instanceof this.S.tools.ToolError
        ? { output: this.R.error(e.message) + (e.detail ? "\n" + e.detail : ""), summary: `${name}: ${e.message}`, failed: true }
        : { output: "Error: " + (e?.message || String(e)), summary: name, failed: true };
    }
    this.calls.push({ name, args, failed: !!result.failed });
    return result;
  }

  /** @param {string} name @param {any} args */
  async tool(name, args) {
    switch (name) {
      case "read_file": return this.readFile(args);
      case "search": return this.search(args);
      case "find_files": return this.findFiles(args);
      case "edit_file": return this.editFile(args);
      case "write_file": return this.writeFile(args);
      case "problems": return this.problems(args);
      case "symbols": return this.symbols(args);
      case "changes": return this.changes(args);
      default: return { output: this.R.error(`${name} isn't available in this test.`), summary: name, failed: true };
    }
  }

  /** A path that must be a file: as Solder says when it isn't (with the files most like it). */
  mustBeFile(/** @type {string} */ given) {
    const full = this.full(given);
    const shown = this.shown(full);
    let stat;
    try { stat = fs.statSync(full); } catch {
      throw new this.S.tools.ToolError(this.R.missing(shown), this.nearby(full));
    }
    if (stat.isDirectory()) throw new this.S.tools.ToolError(this.R.readFolder(shown), this.S.tools.folderEntries(full));
    return { full, shown };
  }

  nearby(/** @type {string} */ full) {
    const name = path.basename(full).toLowerCase();
    const all = this.files();
    let found = all.filter((f) => path.basename(f).toLowerCase() === name);
    let same = true;
    const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : "";
    if (!found.length && stem) { found = all.filter((f) => path.basename(f).toLowerCase().startsWith(stem + ".")); same = false; }
    if (!found.length) return "";
    return this.R.nearby(this.S.tools.rankNearby(full, found).slice(0, 6).map((f) => this.shown(f)), same);
  }

  readFile(/** @type {any} */ args) {
    const { full, shown } = this.mustBeFile(args.path);
    const lines = fs.readFileSync(full, "utf8").replace(/\r\n/g, "\n").split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const total = lines.length;
    if (args.start_line > total) return { output: this.R.pastEnd(shown, total), summary: "past the end" };
    const start = Math.max(1, Math.min(args.start_line || 1, total));
    let end = Math.min(total, args.end_line || start + READ_LINES - 1, start + READ_LINES - 1);
    const narrow = !!args.start_line && !!args.end_line && end - start <= 2;
    const out = [];
    let size = 0;
    for (let n = start; n <= end; n++) {
      const raw = lines[n - 1];
      const text = raw.length > LONG_LINE && !narrow ? `${n}\t${raw.slice(0, LONG_SHOWN)}…\n${this.R.longLine(n, raw.length, raw.length < OUTPUT_CHARS - 100)}` : `${n}\t${raw}`;
      if (size + text.length > OUTPUT_CHARS) {
        if (out.length) { end = n - 1; break; }
        out.push(text.slice(0, OUTPUT_CHARS) + "\n" + this.R.longLine(n, raw.length, false));
        end = n;
        break;
      }
      out.push(text);
      size += text.length + 1;
    }
    const partial = start > 1 || end < total;
    return { output: (partial ? this.R.readPart(start, end, total) + "\n" : "") + out.join("\n"), summary: `Read ${shown}` };
  }

  search(/** @type {any} */ args) {
    const query = String(args.query ?? "");
    let re;
    try {
      const sensitive = /[A-Z]/.test(query);
      re = new RegExp(args.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), sensitive ? "" : "i");
    } catch { throw new this.S.tools.ToolError(this.R.badRegex); }
    const glob = args.glob ? String(args.glob).trim().replace(/\\/g, "/").replace(/^\.\//, "") : "";
    const pattern = glob ? this.S.tools.globPattern(glob.includes("/") ? glob : "**/" + glob) : null;
    const hits = [];
    for (const f of this.files()) {
      const rel = this.shown(f);
      if (pattern && !pattern.test(rel) && !(glob && !/[*?[\]{}]/.test(glob) && rel.toLowerCase().startsWith(glob.replace(/\/+$/, "").toLowerCase() + "/"))) continue;
      const text = fs.readFileSync(f, "utf8");
      if (text.includes("\0")) continue;
      text.replace(/\r\n/g, "\n").split("\n").forEach((line, i) => {
        if (re.test(line)) hits.push(`${rel}:${i + 1}:${line.length > 300 ? this.S.tools.around(line, re) : line}`);
      });
    }
    if (!hits.length) return { output: this.R.noMatches(query, args.glob || ""), summary: "no matches" };
    return { output: hits.slice(0, SEARCH_LINES).join("\n") + (hits.length > SEARCH_LINES ? "\n\n" + this.R.searchCapped(SEARCH_LINES) : ""), summary: `${hits.length} lines` };
  }

  findFiles(/** @type {any} */ args) {
    const glob = String(args.glob ?? "*").trim().replace(/\\/g, "/").replace(/^\.\//, "");
    const pattern = this.S.tools.globPattern(glob.includes("/") ? glob : "**/" + glob);
    let found = this.files().map((f) => this.shown(f)).filter((rel) => pattern.test(rel));
    if (!found.length && !/[*?[\]{}]/.test(glob)) {
      const folder = glob.replace(/\/+$/, "").toLowerCase();
      found = this.files().map((f) => this.shown(f)).filter((rel) => rel.toLowerCase().startsWith(folder + "/") || rel.toLowerCase().includes("/" + folder + "/"));
    }
    if (!found.length) return { output: this.R.noFiles(args.glob), summary: "none" };
    return { output: found.slice(0, 300).join("\n") + (found.length > 300 ? "\n\n" + this.R.filesCapped(300) : ""), summary: `${found.length} files` };
  }

  editFile(/** @type {any} */ args) {
    const { full, shown } = this.mustBeFile(args.path);
    this.hooks.beforeEdit?.(this, args);
    const raw = fs.readFileSync(full, "utf8");
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const toEol = (/** @type {string} */ t) => String(t).replace(/\r\n/g, "\n").replace(/\n/g, eol);
    const old = toEol(args.old_text);
    const replacement = toEol(args.new_text);
    const T = this.S.tools;
    if (!old) throw new T.ToolError(this.R.emptyOldText);
    if (old === replacement) throw new T.ToolError(this.R.sameText);
    let found = T.locate(shown, raw, old, replacement, eol);
    if (!found) {
      const plain = T.withoutLineNumbers(old, eol);
      const newPlain = plain === null ? null : T.withoutLineNumbers(replacement, eol) !== null ? true : replacement.split(eol).some((l) => /^\d+\t/.test(l)) ? false : null;
      if (plain !== null && newPlain === false) throw new T.ToolError(this.R.numberedNewText);
      const again = plain === null ? null : T.locate(shown, raw, plain, newPlain === true ? T.withoutLineNumbers(replacement, eol) : replacement, eol);
      if (again) found = { ...again, note: " " + this.R.numbersLeftOut + again.note };
    }
    if (!found) throw T.notFound(shown, raw, old, eol);
    const before = this.syntaxProblems(full, raw);
    const text = raw.slice(0, found.start) + found.replaced + raw.slice(found.start + found.length);
    fs.writeFileSync(full, text);
    this.edits++;
    const lineAt = raw.slice(0, found.start).split(eol).length;
    const removed = old.split(eol).length - (old.endsWith(eol) ? 1 : 0);
    const added = found.replaced ? found.replaced.split(eol).length - (found.replaced.endsWith(eol) ? 1 : 0) : 0;
    return { output: this.R.edited(shown, removed, added, lineAt) + found.note + this.newProblems(full, shown, before), summary: `Edited ${shown}` };
  }

  writeFile(/** @type {any} */ args) {
    const full = this.full(args.path);
    const shown = this.shown(full);
    const existed = fs.existsSync(full);
    if (existed && fs.statSync(full).isDirectory()) throw new this.S.tools.ToolError(this.R.isFolder(shown));
    const before = existed ? this.syntaxProblems(full, fs.readFileSync(full, "utf8")) : [];
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const content = String(args.content ?? "");
    fs.writeFileSync(full, content);
    this.edits++;
    return { output: this.R.written(existed, shown, content.split("\n").length) + this.newProblems(full, shown, before), summary: `Wrote ${shown}` };
  }

  /** A JavaScript file's syntax error, as a problems line. @param {string} full @param {string} text @returns {string[]} */
  syntaxProblems(full, text) {
    if (!/\.(c|m)?js$/i.test(full)) return [];
    try {
      new vm.Script("(function (exports, require, module, __filename, __dirname) {" + text.replace(/^#!.*/, "") + "\n})", { filename: full });
      return [];
    } catch (error) {
      const e = /** @type {any} */ (error);
      const line = /:(\d+)\s*$/m.exec(String(e.stack || "").split("\n")[0])?.[1];
      return [`- line ${line || "?"}: ${e.message} (js)`];
    }
  }

  newProblems(/** @type {string} */ full, /** @type {string} */ shown, /** @type {string[]} */ before) {
    const now = this.syntaxProblems(full, fs.readFileSync(full, "utf8")).filter((p) => !before.includes(p));
    return now.length ? this.R.newProblems(shown, now, 0) : "";
  }

  problems(/** @type {any} */ args) {
    const targets = args.path ? [this.mustBeFile(args.path).full] : this.files().filter((f) => /\.(c|m)?js$/i.test(f));
    const lines = [];
    for (const f of targets) {
      for (const p of this.syntaxProblems(f, fs.readFileSync(f, "utf8"))) lines.push(`${this.shown(f)}:${p.replace(/^- line (\S+): (.*) \(js\)$/, "$1:1 error: $2 (js)")}`);
    }
    if (!lines.length) return { output: this.R.noProblems(args.path || ""), summary: "Problems · none" };
    return { output: lines.join("\n"), summary: `Problems · ${lines.length}` };
  }

  /** Definitions and uses for JavaScript, by declaration patterns (a stand-in for a language server). */
  symbols(/** @type {any} */ args) {
    const all = this.files().filter((f) => /\.(c|m)?js$/i.test(f));
    if (!args.name) {
      const { full, shown } = this.mustBeFile(args.path);
      const lines = fs.readFileSync(full, "utf8").replace(/\r\n/g, "\n").split("\n");
      const entries = [];
      lines.forEach((line, i) => {
        const m = /^\s*(?:export\s+)?(?:async\s+)?(function|class)\s+([\w$]+)/.exec(line) || /^\s*(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/.exec(line);
        if (!m) return;
        const kind = m.length === 3 ? m[1] : "function";
        const name = m.length === 3 ? m[2] : m[1];
        entries.push(`${kind} ${name} ${i + 1}–${blockEnd(lines, i) + 1}`);
      });
      if (!entries.length) return { output: this.R.noOutline(shown, lines.length), summary: "Outline · none" };
      return { output: this.R.outlineHead(shown, lines.length) + "\n" + entries.join("\n"), summary: `Outline of ${shown}` };
    }
    const name = this.S.tools.plainName(String(args.name));
    const decl = new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?(?:function\\s+${esc(name)}\\b|class\\s+${esc(name)}\\b|(?:const|let|var)\\s+${esc(name)}\\s*=|${esc(name)}\\s*\\([^)]*\\)\\s*\\{)`);
    const word = new RegExp(`(?<![\\w$])${esc(name)}(?![\\w$])`);
    let note = "";
    if (args.path) {
      const { full, shown } = this.mustBeFile(args.path);
      if (!word.test(fs.readFileSync(full, "utf8"))) note = this.R.notInFile(name, shown) + "\n\n";
    }
    if ((args.find ?? "definition") === "references") {
      const uses = [];
      for (const f of all) fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n").split("\n").forEach((line, i) => { if (word.test(line)) uses.push(`${this.shown(f)}:${i + 1}: ${line.trim()}`); });
      if (!uses.length) return { output: note + this.R.noHitsAtAll(name), summary: "no uses" };
      const files = new Set(uses.map((u) => u.split(":")[0])).size;
      return { output: note + this.R.references(name, uses.length, files) + "\n" + uses.join("\n"), summary: `Uses of ${name}` };
    }
    const blocks = [];
    for (const f of all) {
      const lines = fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n").split("\n");
      lines.forEach((line, i) => {
        if (!decl.test(line) || blocks.length >= 5) return;
        const end = Math.min(blockEnd(lines, i), i + 149);
        blocks.push(`${this.shown(f)} ${i + 1}–${end + 1}:\n` + lines.slice(i, end + 1).map((l, k) => `${i + k + 1}\t${l}`).join("\n"));
      });
    }
    if (!blocks.length) return { output: note + this.R.noHitsAtAll(name), summary: "not found" };
    return { output: note + this.R.definitions(name, blocks.length) + "\n\n" + blocks.join("\n\n"), summary: `Definition of ${name}` };
  }
}

function esc(/** @type {string} */ s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Where the block that opens on line i ends (by counting braces; i itself when there's none). */
function blockEnd(/** @type {string[]} */ lines, /** @type {number} */ i) {
  let depth = 0;
  let opened = false;
  for (let k = i; k < lines.length; k++) {
    for (const ch of lines[k].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "")) {
      if (ch === "{") { depth++; opened = true; } else if (ch === "}") depth--;
    }
    if (opened && depth <= 0) return k;
    if (!opened && k > i + 2) return i;
  }
  return lines.length - 1;
}

module.exports = { solder, workspaceHost };
