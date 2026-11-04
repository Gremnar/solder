// @ts-check
"use strict";
/**
 * The tools, on VS Code's own APIs: documents (so reads see unsaved edits and edits go through the
 * editor), its bundled ripgrep, findFiles and diagnostics. No shell is ever started.
 * Every change keeps a backup, so each step can be reviewed (VS Code's diff) and undone.
 */
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { RESULTS, TEXTS } = require("./prompt.js");

const MAX_READ_LINES = 2000;
const MAX_OUTPUT_CHARS = 30_000;
const MAX_SEARCH_LINES = 200;
const MAX_FOUND = 300;
const DIAGNOSTICS_WAIT_MS = 2500;
const MAX_OUTLINE = 400;
/** A language server that's still starting answers with nothing: how long to keep asking. */
const OUTLINE_WAITS_MS = [500, 1000, 1500];
/** How long a definition or reference lookup may take before it counts as "found nothing". */
const LOOKUP_MS = 15_000;
const MAX_DEFINITIONS = 5;
const MAX_DEFINITION_LINES = 80;
const MAX_REFERENCES = 100;
const MAX_CHANGED = 200;
const MAX_DIFF_CHARS = 30_000;
/** With no path, the whole diff comes along with the file list when it's this small (saves a call per file). */
const INLINE_DIFF_CHARS = 12_000;
const GIT_MS = 20_000;
/**
 * Every git call starts with these: no pager, no colour, no fsmonitor hook, no optional locks, and (for
 * diffs, see gitDiffArgs) no external diff drivers or textconv filters, so a repository's own config can't
 * make Solder run other programs. Status may still run the clean filters VS Code's own Source Control
 * view runs (Git LFS, say): nothing beyond what VS Code already does.
 */
const GIT_SAFE = ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false",
  "-c", "color.ui=false", "-c", "diff.external="];
const MAX_REMOVE_BACKUP_BYTES = 200 * 1024 * 1024;
const MAX_REMOVE_BACKUP_FILES = 20_000;

class ToolError extends Error {}

class WorkspaceTools {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this.context = context;
    /** @type {string | null | undefined} */
    this._rg = undefined;
    /** Languages whose symbol provider has answered: an empty outline from them is real, not a slow start. */
    this._outlined = new Set();
    /** The chat's working folder, relative to the workspace folder ("" for the workspace folder itself). */
    this.folder = "";
  }

  /** The first workspace folder ("" when none is open). */
  root() {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  }

  /** Where relative paths and searches start: the working folder, or the workspace folder. */
  base() {
    const root = this.root();
    if (!root || !this.folder) return root;
    const full = path.resolve(root, this.folder);
    return within(full, root) && fs.existsSync(full) ? full : root;
  }

  /** @param {string} folder relative to the workspace folder */
  useFolder(folder) { this.folder = folder || ""; }

  /** A path as the model sees it: relative to the working folder when it's in the workspace. @param {string} full */
  shown(full) {
    const root = this.root();
    if (!root || !within(full, root)) return full;
    return path.relative(this.base(), full).split(path.sep).join("/") || ".";
  }

  /** @param {string} given */
  resolve(given) {
    const root = this.root();
    const raw = String(given ?? "").trim().replace(/^["']|["']$/g, "");
    if (!raw) throw new ToolError(RESULTS.noPath);
    const full = path.resolve(this.base() || process.cwd(), raw);
    const inside = !!root && within(full, root);
    return { uri: vscode.Uri.file(full), full, inside, shown: this.shown(full) };
  }

  /** Why a call needs asking about first, or null: removing anything, and changes outside the workspace. */
  needsApproval(/** @type {string} */ name, /** @type {any} */ args) {
    let target;
    try { target = this.resolve(args.path); } catch { return null; }
    if (name === "remove_item") {
      let what = "It deletes this file";
      try {
        if (fs.statSync(target.full).isDirectory()) {
          const { files } = measure(target.full);
          what = `It deletes this folder and the ${files.toLocaleString()} file${files === 1 ? "" : "s"} in it`;
        }
      } catch { return null; } // not there: the tool says so, nothing to ask about
      return what + (target.inside ? "." : ", outside the workspace folder.");
    }
    if (name !== "write_file" && name !== "edit_file") return null;
    return target.inside ? null : "It changes a file outside the workspace folder.";
  }

  /** @param {string} name @param {any} args @param {{chat: any, signal: AbortSignal}} ctx */
  async run(name, args, ctx) {
    try {
      switch (name) {
        case "read_file": return await this.readFile(args, ctx.chat);
        case "symbols": return await this.symbols(args, ctx.signal);
        case "changes": return await this.changes(args, ctx.signal);
        case "search": return await this.search(args, ctx.signal);
        case "find_files": return await this.findFiles(args);
        case "edit_file": return await this.editFile(args, ctx.chat);
        case "write_file": return await this.writeFile(args, ctx.chat);
        case "remove_item": return await this.removeItem(args, ctx.chat);
        case "problems": return await this.problems(args);
        default: throw new ToolError(RESULTS.noTool(name));
      }
    } catch (error) {
      if (error instanceof ToolError) return { output: RESULTS.error(error.message), summary: `${name}: ${error.message}`, failed: true };
      throw error;
    }
  }

  // ------------------------------------------------------------------ read_file --

  async readFile(/** @type {any} */ args, /** @type {any} */ chat) {
    const file = this.resolve(args.path);
    await this.mustBeFile(file);
    let document;
    try {
      document = await vscode.workspace.openTextDocument(file.uri);
    } catch {
      throw new ToolError(RESULTS.notText(file.shown));
    }
    const total = document.lineCount;
    const start = Math.max(1, Math.min(args.start_line || 1, total));
    let end = Math.min(total, args.end_line || start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1);
    if (end < start) end = start;
    const lines = [];
    let size = 0;
    for (let line = start; line <= end; line++) {
      const text = `${line}\t${document.lineAt(line - 1).text}`;
      if (size + text.length > MAX_OUTPUT_CHARS) {
        if (lines.length) { end = line - 1; break; }
        // One line longer than the whole cap (minified code, a data file): its start only.
        lines.push(text.slice(0, MAX_OUTPUT_CHARS) + "\n" + RESULTS.longLine(line, text.length - String(line).length - 1));
        end = line;
        break;
      }
      lines.push(text);
      size += text.length + 1;
    }
    const partial = start > 1 || end < total;
    let output = (partial ? RESULTS.readPart(start, end, total) + "\n" : "") + lines.join("\n");
    if (!document.getText().length) output = RESULTS.readEmpty;
    // A folder's AGENTS.md rides along as `keep`, so it stays when this result is later cut.
    const agents = this.nestedAgents(file, chat);
    return { output, summary: `Read ${file.shown}` + (partial ? ` · lines ${start}–${end} of ${total}` : ` · ${total} lines`),
      ...(agents ? { keep: agents } : {}) };
  }

  /** The first read in a folder with its own AGENTS.md brings that file along (the nearest one wins). */
  nestedAgents(/** @type {any} */ file, /** @type {any} */ chat) {
    const root = this.root();
    if (!file.inside || !root) return "";
    const names = vscode.workspace.getConfiguration("solder").get("instructionFiles", ["AGENTS.md"]);
    chat.agentsSeen = chat.agentsSeen || [];
    let folder = path.dirname(file.full);
    const notes = [];
    while (folder.toLowerCase().startsWith(root.toLowerCase() + path.sep)) {
      for (const name of names) {
        const candidate = path.join(folder, name);
        const key = candidate.toLowerCase();
        if (chat.agentsSeen.includes(key) || !fs.existsSync(candidate)) continue;
        chat.agentsSeen.push(key);
        try {
          const text = fs.readFileSync(candidate, "utf8").slice(0, 20_000).trim();
          if (text) notes.push(RESULTS.folderAgents(path.relative(root, candidate).split(path.sep).join("/"), text));
        } catch { /* unreadable: skip */ }
      }
      folder = path.dirname(folder);
    }
    return notes.join("\n\n");
  }

  // -------------------------------------------------------------------- symbols --

  /** The outline, or (with a name) its definition or references. */
  async symbols(/** @type {any} */ args, /** @type {AbortSignal} */ signal) {
    if (!args.name) return this.outline(args);
    const find = args.find ?? "definition";
    if (find !== "definition" && find !== "references") throw new ToolError(RESULTS.badFind);
    const name = String(args.name).trim();
    const file = this.resolve(args.path);
    await this.mustBeFile(file);
    let document;
    try { document = await vscode.workspace.openTextDocument(file.uri); } catch { throw new ToolError(RESULTS.notText(file.shown)); }
    const symbols = await this.symbolsOf(document); // also gives a cold language server its moment
    const position = positionOf(document, symbols, name, args.line);
    if (!position) throw new ToolError(RESULTS.notInFile(name, file.shown));
    const command = find === "definition" ? "vscode.executeDefinitionProvider" : "vscode.executeReferenceProvider";
    const found = locations(await deadline(vscode.commands.executeCommand(command, document.uri, position), LOOKUP_MS));
    if (!found.length) return this.textMatches(name, signal);
    return find === "definition" ? this.definitions(name, found) : this.references(name, found);
  }

  /** Definitions with their code (the whole symbol when VS Code knows its extent, capped). */
  async definitions(/** @type {string} */ name, /** @type {{uri: vscode.Uri, range: vscode.Range}[]} */ found) {
    const blocks = [];
    for (const place of found.slice(0, MAX_DEFINITIONS)) {
      const shown = this.shown(place.uri.fsPath);
      if (place.uri.scheme !== "file") { blocks.push(`${shown} ${place.range.start.line + 1}`); continue; }
      let document;
      try { document = await vscode.workspace.openTextDocument(place.uri); } catch { blocks.push(`${shown} ${place.range.start.line + 1}`); continue; }
      const extent = enclosing(await this.symbolsOf(document), place.range.start.line) ?? place.range;
      const first = Math.min(extent.start.line, place.range.start.line);
      const last = Math.min(Math.max(extent.end.line, place.range.end.line), document.lineCount - 1);
      const end = Math.min(last, first + MAX_DEFINITION_LINES - 1);
      const lines = [];
      for (let line = first; line <= end; line++) lines.push(`${line + 1}\t${document.lineAt(line).text}`);
      blocks.push(`${shown} ${first + 1}–${last + 1}:\n${lines.join("\n")}` + (end < last ? "\n" + RESULTS.definitionCut : ""));
    }
    return { output: RESULTS.definitions(name, found.length) + "\n\n" + blocks.join("\n\n"),
      summary: `Definition of ${short(name)} · ${found.length === 1 ? this.shown(found[0].uri.fsPath) : found.length + " places"}` };
  }

  /** Every use, one line each, grouped by file. */
  async references(/** @type {string} */ name, /** @type {{uri: vscode.Uri, range: vscode.Range}[]} */ found) {
    /** @type {Map<string, {uri: vscode.Uri, lines: number[]}>} */
    const files = new Map();
    for (const place of found) {
      const key = place.uri.toString();
      const entry = files.get(key) ?? { uri: place.uri, lines: [] };
      if (!entry.lines.includes(place.range.start.line)) entry.lines.push(place.range.start.line);
      files.set(key, entry);
    }
    const out = [];
    let count = 0;
    for (const { uri, lines } of files.values()) {
      let document = null;
      try { if (uri.scheme === "file") document = await vscode.workspace.openTextDocument(uri); } catch { /* listed without text */ }
      for (const line of lines.sort((a, b) => a - b)) {
        count++;
        if (out.length >= MAX_REFERENCES) continue;
        const text = document && line < document.lineCount ? document.lineAt(line).text.trim().slice(0, 200) : "";
        out.push(`${this.shown(uri.fsPath)}:${line + 1}: ${text}`);
      }
    }
    return { output: RESULTS.references(name, count, files.size) + "\n" + out.join("\n")
      + (count > out.length ? "\n" + RESULTS.referencesCapped(count - out.length) : ""),
      summary: `Uses of ${short(name)} · ${count} in ${files.size} file${files.size === 1 ? "" : "s"}` };
  }

  /** No language support answered: whole-word text matches, clearly labelled as such (saves the model a search). */
  async textMatches(/** @type {string} */ name, /** @type {AbortSignal} */ signal) {
    const root = this.base();
    const query = "\\b" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b";
    const rg = this.ripgrep();
    let lines = root ? (rg ? await this.searchWithRipgrep(rg, root, query, true, undefined, signal)
      : await this.searchInJs(root, query, true, undefined)) : [];
    if (!lines.length) return { output: RESULTS.noHitsAtAll(name), summary: `${short(name)} · not found` };
    const more = lines.length > MAX_SEARCH_LINES;
    lines = lines.slice(0, MAX_SEARCH_LINES);
    return { output: RESULTS.noLanguageHits(name) + "\n" + lines.join("\n") + (more ? "\n\n" + RESULTS.searchCapped(MAX_SEARCH_LINES) : ""),
      summary: `${short(name)} · ${lines.length}${more ? "+" : ""} text matches` };
  }

  // -------------------------------------------------------------------- changes --

  /** What's changed in git since the last commit: the files, or one file's or folder's diff. */
  async changes(/** @type {any} */ args, /** @type {AbortSignal} */ signal) {
    if (!this.root()) throw new ToolError(RESULTS.noWorkspace);
    const target = args.path ? this.resolve(args.path) : null;
    let folder = this.base();
    if (target) {
      let stat;
      try { stat = fs.statSync(target.full); } catch { stat = null; }
      folder = stat?.isDirectory() ? target.full : path.dirname(target.full);
    }
    const git = this.gitPath();
    let top;
    try {
      top = (await runGit(git, folder, ["rev-parse", "--show-toplevel"], signal)).trim();
    } catch (error) {
      const e = /** @type {any} */ (error);
      if (e.code === "ENOENT" || e.code === "EACCES" || e.code === "EPERM") throw new ToolError(RESULTS.noGit);
      if (/not a git repository/i.test(e.message)) throw new ToolError(RESULTS.notGit(target ? target.shown : this.shown(folder)));
      throw new ToolError(RESULTS.gitFailed(e.message));
    }
    const scope = target ? target.full : this.base();
    const spec = path.relative(top, scope).split(path.sep).join("/");
    const pathspec = ["--", spec && spec !== "." ? spec : "."];
    const where = target ? target.shown : (this.folder ? this.shown(this.base()) : "");
    const hasHead = await runGit(git, top, ["rev-parse", "--verify", "--quiet", "HEAD"], signal).then(() => true, () => false);
    const fail = (/** @type {any} */ error) => { throw new ToolError(RESULTS.gitFailed(error.message)); };
    const entries = parseStatus(await runGit(git, top, ["status", "--porcelain=v1", "-z", "--untracked-files=all", ...pathspec], signal).catch(fail));
    const unsaved = vscode.workspace.textDocuments
      .filter((doc) => doc.isDirty && doc.uri.scheme === "file" && within(doc.uri.fsPath, scope)).map((doc) => this.shown(doc.uri.fsPath));
    const tail = (unsaved.length ? "\n\n" + RESULTS.unsaved(unsaved) : "") + (hasHead ? "" : "\n\n" + RESULTS.noCommits);
    if (!entries.length) return { output: RESULTS.noChanges(where) + tail, summary: "Changes · none" };
    const fullOf = (/** @type {string} */ file) => path.join(top, ...file.split("/"));
    const fresh = entries.filter((entry) => entry.state === "new").map((entry) => this.shown(fullOf(entry.path)));
    if (!target) {
      /** @type {Map<string, string>} */
      const counts = new Map();
      if (hasHead) {
        const numstat = await runGit(git, top, ["diff", "--numstat", "--no-ext-diff", "--no-textconv", "-z", "HEAD", ...pathspec], signal).catch(() => "");
        for (const [file, count] of parseNumstat(numstat)) counts.set(file, count);
      }
      const lines = entries.slice(0, MAX_CHANGED).map((entry) =>
        `${this.shown(fullOf(entry.path))} · ${entry.label}${counts.has(entry.path) ? " · " + counts.get(entry.path) : ""}`);
      const diff = hasHead ? await runGit(git, top, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-U3", "HEAD", ...pathspec], signal).catch(() => "") : "";
      const inline = diff.trim() && diff.length <= INLINE_DIFF_CHARS ? "\n\n" + diff.trim() : "";
      return { output: RESULTS.changedFiles(entries.length, !!inline) + "\n" + lines.join("\n")
        + (entries.length > MAX_CHANGED ? "\n" + RESULTS.changedCapped(entries.length - MAX_CHANGED) : "") + inline + tail,
        summary: `Changes · ${entries.length} file${entries.length === 1 ? "" : "s"}` };
    }
    let diff = hasHead ? await runGit(git, top, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-U3", "HEAD", ...pathspec], signal).catch(fail) : "";
    if (diff.length > MAX_DIFF_CHARS) diff = diff.slice(0, MAX_DIFF_CHARS) + "\n" + TEXTS.resultCut(diff.length - MAX_DIFF_CHARS);
    const parts = [diff.trim(), fresh.length ? RESULTS.newFiles(fresh) : ""].filter(Boolean);
    return { output: (parts.join("\n\n") || RESULTS.noChanges(where)) + tail,
      summary: `Changes in ${target.shown} · ${entries.length} file${entries.length === 1 ? "" : "s"}` };
  }

  /** The git VS Code itself uses (its git extension found it), or git on the PATH. */
  gitPath() {
    try {
      const api = vscode.extensions.getExtension("vscode.git")?.exports?.getAPI?.(1);
      if (api?.git?.path) return String(api.git.path);
    } catch { /* not active yet, or turned off */ }
    return process.platform === "win32" ? "git.exe" : "git";
  }

  async outline(/** @type {any} */ args) {
    const file = this.resolve(args.path);
    await this.mustBeFile(file);
    let document;
    try {
      document = await vscode.workspace.openTextDocument(file.uri); // opening it wakes its language support
    } catch {
      throw new ToolError(RESULTS.notText(file.shown));
    }
    const symbols = await this.symbolsOf(document);
    const entries = outlineEntries(symbols, (kind) => vscode.SymbolKind[kind] ?? "Symbol");
    if (!entries.length) {
      return { output: RESULTS.noOutline(file.shown, document.lineCount), summary: `Outline of ${file.shown} · none` };
    }
    const shown = entries.slice(0, MAX_OUTLINE);
    const more = entries.length - shown.length;
    return { output: RESULTS.outlineHead(file.shown, document.lineCount) + "\n" + shown.join("\n")
      + (more > 0 ? "\n" + RESULTS.outlineCapped(more) : ""),
      summary: `Outline of ${file.shown} · ${entries.length} entr${entries.length === 1 ? "y" : "ies"}` };
  }

  /** The document's symbols from VS Code's providers, giving a cold language server a few seconds. */
  async symbolsOf(/** @type {vscode.TextDocument} */ document) {
    const ready = this._outlined.has(document.languageId) || document.languageId === "plaintext";
    for (let attempt = 0; ; attempt++) {
      /** @type {any} */
      let result;
      try {
        result = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", document.uri);
      } catch { result = undefined; }
      if (Array.isArray(result) && result.length) {
        this._outlined.add(document.languageId);
        return result;
      }
      if (ready || attempt >= OUTLINE_WAITS_MS.length) return [];
      await new Promise((resolve) => setTimeout(resolve, OUTLINE_WAITS_MS[attempt]));
    }
  }

  // --------------------------------------------------------------------- search --

  async search(/** @type {any} */ args, /** @type {AbortSignal} */ signal) {
    const root = this.base();
    if (!root) throw new ToolError(RESULTS.noWorkspace);
    const rg = this.ripgrep();
    const query = String(args.query);
    let lines = rg ? await this.searchWithRipgrep(rg, root, query, !!args.regex, args.glob, signal)
      : await this.searchInJs(root, query, !!args.regex, args.glob);
    const count = lines.length;
    if (!count) {
      return { output: RESULTS.noMatches(query, args.glob || ""), summary: `Searched "${short(query)}" · no matches` };
    }
    let note = "";
    if (count > MAX_SEARCH_LINES) {
      lines = lines.slice(0, MAX_SEARCH_LINES);
      note = "\n\n" + RESULTS.searchCapped(MAX_SEARCH_LINES);
    }
    return { output: lines.join("\n") + note, summary: `Searched "${short(query)}" · ${count > MAX_SEARCH_LINES ? MAX_SEARCH_LINES + "+" : count} lines` };
  }

  /** VS Code's own rg.exe, or null (then a JS search is used). */
  ripgrep() {
    if (this._rg !== undefined) return this._rg;
    const app = vscode.env.appRoot;
    const exe = process.platform === "win32" ? "rg.exe" : "rg";
    const candidates = [
      path.join(app, "node_modules.asar.unpacked", "@vscode", "ripgrep-universal", "bin", `${process.platform}-${process.arch}`, exe),
      path.join(app, "node_modules.asar.unpacked", "@vscode", "ripgrep", "bin", exe),
      path.join(app, "node_modules", "@vscode", "ripgrep", "bin", exe),
    ];
    this._rg = candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
    return this._rg;
  }

  /** @returns {Promise<string[]>} */
  searchWithRipgrep(/** @type {string} */ rg, /** @type {string} */ root, /** @type {string} */ query,
    /** @type {boolean} */ regex, /** @type {string | undefined} */ glob, /** @type {AbortSignal} */ signal) {
    const args = ["--line-number", "--no-heading", "--color", "never", "--smart-case", "--max-columns", "300",
      "--max-columns-preview", "--max-filesize", "5M", "--max-count", "50", "--no-messages"];
    if (!regex) args.push("--fixed-strings");
    if (glob) args.push("--glob", String(glob));
    args.push("--regexp", query, "--", ".");
    return new Promise((resolve, reject) => {
      const child = spawn(rg, args, { cwd: root, windowsHide: true, signal });
      let out = "";
      let errors = "";
      child.stdout.on("data", (chunk) => { if (out.length < 2_000_000) out += chunk; });
      child.stderr.on("data", (chunk) => { errors += chunk; });
      const timer = setTimeout(() => child.kill(), 30_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        if (signal.aborted) { reject(new ToolError(RESULTS.stopped)); return; }
        this._rg = null; // blocked or missing: fall back from now on
        this.searchInJs(root, query, regex, glob).then(resolve, reject);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 2 && !out) { reject(new ToolError(errors.trim().split("\n")[0] || RESULTS.searchFailed)); return; }
        resolve(out.split(/\r?\n/).filter(Boolean).map((line) => line.replace(/^\.[\\/]/, "").replace(/\\/g, "/")));
      });
    });
  }

  /** @returns {Promise<string[]>} */
  async searchInJs(/** @type {string} */ root, /** @type {string} */ query, /** @type {boolean} */ regex,
    /** @type {string | undefined} */ glob) {
    let pattern;
    try {
      pattern = regex ? new RegExp(query, /[A-Z]/.test(query) ? "" : "i")
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), /[A-Z]/.test(query) ? "" : "i");
    } catch (error) {
      throw new ToolError(RESULTS.badRegex);
    }
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(root, globOf(glob || "**/*")), undefined, 5000);
    const lines = [];
    for (const uri of files) {
      let text;
      try {
        if (fs.statSync(uri.fsPath).size > 1_000_000) continue;
        text = fs.readFileSync(uri.fsPath, "utf8");
      } catch { continue; }
      if (text.includes("\u0000")) continue;
      const shown = this.shown(uri.fsPath);
      text.split(/\r?\n/).forEach((line, index) => {
        if (lines.length <= MAX_SEARCH_LINES && pattern.test(line)) lines.push(`${shown}:${index + 1}:${line.slice(0, 300)}`);
      });
      if (lines.length > MAX_SEARCH_LINES) break;
    }
    return lines;
  }

  // ----------------------------------------------------------------- find_files --

  async findFiles(/** @type {any} */ args) {
    if (!this.root()) throw new ToolError(RESULTS.noWorkspace);
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(this.base(), globOf(String(args.glob))), undefined, MAX_FOUND + 1);
    const shown = uris.map((uri) => this.shown(uri.fsPath)).sort((a, b) => a.localeCompare(b));
    if (!shown.length) return { output: RESULTS.noFiles(args.glob), summary: `Found no ${args.glob}` };
    const more = shown.length > MAX_FOUND;
    return { output: shown.slice(0, MAX_FOUND).join("\n") + (more ? "\n\n" + RESULTS.filesCapped(MAX_FOUND) : ""),
      summary: `Found ${more ? MAX_FOUND + "+" : shown.length} file${shown.length === 1 ? "" : "s"} · ${args.glob}` };
  }

  // ------------------------------------------------------------------ edit_file --

  async editFile(/** @type {any} */ args, /** @type {any} */ chat) {
    const file = this.resolve(args.path);
    await this.mustBeFile(file);
    const document = await vscode.workspace.openTextDocument(file.uri);
    const text = document.getText();
    const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const old = toEol(String(args.old_text), eol);
    const replacement = toEol(String(args.new_text), eol);
    if (!old) throw new ToolError(RESULTS.emptyOldText);
    let start = -1;
    let length = old.length;
    const count = occurrences(text, old);
    if (count === 1) start = text.indexOf(old);
    else if (count > 1) {
      const lines = positions(text, old).map((index) => lineOf(text, index));
      throw new ToolError(RESULTS.manyMatches(count, file.shown, lines.slice(0, 10)));
    } else {
      const loose = looseMatch(text, old, eol);
      if (!loose) throw new ToolError(notFound(file.shown, text, old, eol));
      [start, length] = loose;
    }
    const before = problemKeys(file.uri);
    const backup = await this.backup(chat, file, text);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(file.uri, new vscode.Range(document.positionAt(start), document.positionAt(start + length)), replacement);
    if (!await vscode.workspace.applyEdit(edit)) throw new ToolError(RESULTS.notApplied(file.shown));
    await document.save();
    const removed = old.split(eol).length;
    const added = replacement ? replacement.split(eol).length : 0;
    const problems = await this.newProblems(file, before);
    return { output: RESULTS.edited(file.shown, removed, added, lineOf(text, start)) + problems.text,
      summary: `Edited ${file.shown} · −${removed} +${added}` + problems.summary,
      change: { path: file.full, shown: file.shown, backup, created: false } };
  }

  // ----------------------------------------------------------------- write_file --

  async writeFile(/** @type {any} */ args, /** @type {any} */ chat) {
    const file = this.resolve(args.path);
    const content = String(args.content);
    let exists = false;
    try {
      const stat = await vscode.workspace.fs.stat(file.uri);
      if (stat.type & vscode.FileType.Directory) throw new ToolError(RESULTS.isFolder(file.shown));
      exists = true;
    } catch (error) { if (error instanceof ToolError) throw error; }
    const open = vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath.toLowerCase() === file.full.toLowerCase());
    const previous = exists ? (open ? open.getText() : fs.readFileSync(file.full, "utf8")) : "";
    const backup = exists ? await this.backup(chat, file, previous) : "";
    const before = exists ? problemKeys(file.uri) : new Set();
    if (open) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(file.uri, new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length)), toEol(content, open.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n"));
      if (!await vscode.workspace.applyEdit(edit)) throw new ToolError(RESULTS.notApplied(file.shown));
      await open.save();
    } else {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(file.full)));
      await vscode.workspace.fs.writeFile(file.uri, Buffer.from(content, "utf8"));
      await vscode.workspace.openTextDocument(file.uri).then(() => {}, () => {}); // lets language servers look
    }
    const lines = content ? content.split(/\r?\n/).length : 0;
    const problems = await this.newProblems(file, before);
    return { output: RESULTS.written(exists, file.shown, lines) + problems.text,
      summary: `${exists ? "Wrote" : "Created"} ${file.shown} · ${lines} lines` + problems.summary,
      change: { path: file.full, shown: file.shown, backup, created: !exists } };
  }

  // ------------------------------------------------------------------- problems --

  async problems(/** @type {any} */ args) {
    const list = args.path ? [[this.resolve(args.path).uri, vscode.languages.getDiagnostics(this.resolve(args.path).uri)]]
      : vscode.languages.getDiagnostics();
    const lines = [];
    for (const [uri, diagnostics] of /** @type {any[]} */ (list)) {
      for (const d of diagnostics) {
        if (d.severity > vscode.DiagnosticSeverity.Warning) continue;
        lines.push(`${this.shown(uri.fsPath)}:${d.range.start.line + 1}:${d.range.start.character + 1} ` +
          `${d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning"}: ${d.message.split("\n")[0]}` + (d.source ? ` (${d.source})` : ""));
      }
    }
    const errors = lines.filter((line) => / error: /.test(line)).length;
    if (!lines.length) return { output: RESULTS.noProblems(args.path || ""), summary: "Problems · none" };
    const shown = lines.slice(0, 100);
    return { output: shown.join("\n") + (lines.length > 100 ? "\n\n" + RESULTS.moreProblems(lines.length - 100) : ""),
      summary: `Problems · ${errors} error${errors === 1 ? "" : "s"}, ${lines.length - errors} warning${lines.length - errors === 1 ? "" : "s"}` };
  }

  /** The file's errors that weren't there before the change (VS Code's language servers need a moment). */
  async newProblems(/** @type {any} */ file, /** @type {Set<string>} */ before) {
    await new Promise((resolve) => {
      const timer = setTimeout(done, DIAGNOSTICS_WAIT_MS);
      const listener = vscode.languages.onDidChangeDiagnostics((event) => {
        if (event.uris.some((uri) => uri.fsPath.toLowerCase() === file.full.toLowerCase())) setTimeout(done, 250);
      });
      function done() { clearTimeout(timer); listener.dispose(); resolve(undefined); }
    });
    const fresh = vscode.languages.getDiagnostics(file.uri)
      .filter((d) => d.severity === vscode.DiagnosticSeverity.Error && !before.has(keyOf(d)));
    if (!fresh.length) return { text: "", summary: "" };
    const lines = fresh.slice(0, 10).map((d) => `- line ${d.range.start.line + 1}: ${d.message.split("\n")[0]}` + (d.source ? ` (${d.source})` : ""));
    return { text: RESULTS.newProblems(file.shown, lines, fresh.length - 10),
      summary: ` · ${fresh.length} new problem${fresh.length === 1 ? "" : "s"}` };
  }

  // -------------------------------------------------------------- undo / review --

  /** Keep the file's text from before a change. @returns {Promise<string>} the backup's path */
  async backup(/** @type {any} */ chat, /** @type {any} */ file, /** @type {string} */ text) {
    const folder = path.join(this.context.globalStorageUri.fsPath, "backups", chat.id);
    fs.mkdirSync(folder, { recursive: true });
    const name = `${Date.now().toString(36)}-${path.basename(file.full)}`;
    const target = path.join(folder, name);
    fs.writeFileSync(target, text, "utf8");
    return target;
  }

  // ---------------------------------------------------------------- remove_item --

  async removeItem(/** @type {any} */ args, /** @type {any} */ chat) {
    const target = this.resolve(args.path);
    const root = this.root();
    let stat;
    try { stat = fs.statSync(target.full); } catch { throw new ToolError(RESULTS.missing(target.shown)); }
    if ((root && path.resolve(target.full).toLowerCase() === path.resolve(root).toLowerCase()) || path.parse(target.full).root === target.full) {
      throw new ToolError(RESULTS.removeRoot);
    }
    const folder = stat.isDirectory();
    const { files, bytes } = folder ? measure(target.full) : { files: 1, bytes: stat.size };
    // A copy first, so Undo can put it back (the Recycle Bin isn't there on every drive).
    let backup = "";
    if (bytes <= MAX_REMOVE_BACKUP_BYTES && files <= MAX_REMOVE_BACKUP_FILES) {
      const store = path.join(this.context.globalStorageUri.fsPath, "backups", chat.id);
      fs.mkdirSync(store, { recursive: true });
      backup = path.join(store, `${Date.now().toString(36)}-${path.basename(target.full)}`);
      fs.cpSync(target.full, backup, { recursive: true });
    }
    try {
      await vscode.workspace.fs.delete(target.uri, { recursive: true, useTrash: true });
    } catch {
      if (!backup) throw new ToolError(RESULTS.removeNoTrash(target.shown));
      await vscode.workspace.fs.delete(target.uri, { recursive: true, useTrash: false });
    }
    return { output: RESULTS.removed(target.shown, folder ? files : null), summary: `Removed ${target.shown}` + (folder ? ` · ${files} files` : ""),
      change: { path: target.full, shown: target.shown, backup, removed: true, folder } };
  }

  /** Put a changed file back as it was before the step (or remove one the step created). */
  async undo(/** @type {any} */ change) {
    const uri = vscode.Uri.file(change.path);
    if (change.removed) {
      if (!change.backup || !fs.existsSync(change.backup)) throw new Error("There's no copy to put back (it was too big to keep).");
      if (fs.existsSync(change.path)) throw new Error(`Something is already at ${change.shown}; move it first.`);
      fs.cpSync(change.backup, change.path, { recursive: true });
      return;
    }
    if (change.created) {
      await vscode.workspace.fs.delete(uri, { useTrash: true });
      return;
    }
    const text = fs.readFileSync(change.backup, "utf8");
    const document = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    if (!await vscode.workspace.applyEdit(edit)) throw new Error("VS Code didn't apply the undo.");
    await document.save();
  }

  /** VS Code's diff: before the step ↔ the file now. */
  async review(/** @type {any} */ change) {
    const now = vscode.Uri.file(change.path);
    const before = change.backup ? vscode.Uri.file(change.backup) : vscode.Uri.parse("untitled:" + path.basename(change.path) + " (new)");
    await vscode.commands.executeCommand("vscode.diff", before, now, `${change.shown} (before ↔ after Solder's step)`, { preview: true });
  }

  async mustBeFile(/** @type {any} */ file) {
    let stat;
    try { stat = await vscode.workspace.fs.stat(file.uri); } catch { throw new ToolError(RESULTS.missing(file.shown)); }
    if (stat.type & vscode.FileType.Directory) throw new ToolError(RESULTS.readFolder(file.shown));
    if (stat.size > 20 * 1024 * 1024) throw new ToolError(RESULTS.tooLarge(file.shown, Math.round(stat.size / 1048576)));
  }
}

/**
 * Outline lines from DocumentSymbol trees (nested, indented) or flat SymbolInformation lists, in file
 * order: "  method start 20–45". A function's own variables are left out (noise); nesting stops at
 * three levels. @param {any[]} symbols @param {(kind: number) => string} kindName @returns {string[]}
 */
function outlineEntries(symbols, kindName) {
  /** @type {string[]} */
  const out = [];
  const rangeOf = (/** @type {any} */ symbol) => symbol.range ?? symbol.location?.range;
  const LOCAL = new Set(["Variable", "Constant", "Property", "Field", "Key", "String", "Number", "Boolean", "Array", "Object", "Null"]);
  const BODY = new Set(["Function", "Method", "Constructor"]);
  const walk = (/** @type {any[]} */ list, /** @type {number} */ depth, /** @type {string} */ parent) => {
    const sorted = list.filter((symbol) => symbol && rangeOf(symbol))
      .sort((a, b) => rangeOf(a).start.line - rangeOf(b).start.line);
    for (const symbol of sorted) {
      const kind = String(kindName(symbol.kind));
      if (BODY.has(parent) && LOCAL.has(kind)) continue;
      const range = rangeOf(symbol);
      const first = range.start.line + 1;
      const last = range.end.line + 1;
      const name = String(symbol.name ?? "").replace(/\s+/g, " ").trim().slice(0, 100) || "(unnamed)";
      out.push(`${"  ".repeat(depth)}${kind.toLowerCase()} ${name} ${last > first ? `${first}–${last}` : first}`);
      if (Array.isArray(symbol.children) && symbol.children.length && depth < 2) walk(symbol.children, depth + 1, kind);
    }
  };
  walk(symbols, 0, "");
  return out;
}

/**
 * Where to ask about `name` in the document: on the given line if it's there, else where an outline
 * symbol of that name is declared, else its first whole-word appearance. null when it isn't there.
 * @param {vscode.TextDocument} document @param {any[]} symbols @param {string} name @param {number} [line]
 */
function positionOf(document, symbols, name, line) {
  if (!name) return null;
  const word = new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`);
  const on = (/** @type {number} */ index) => {
    if (index < 0 || index >= document.lineCount) return null;
    const match = word.exec(document.lineAt(index).text);
    return match ? new vscode.Position(index, match.index) : null;
  };
  if (line) {
    const given = on(line - 1);
    if (given) return given;
  }
  /** @type {any} */
  let declared = null;
  const visit = (/** @type {any[]} */ list) => {
    for (const symbol of list) {
      if (declared) return;
      if (symbol?.name === name) declared = symbol;
      else if (Array.isArray(symbol?.children)) visit(symbol.children);
    }
  };
  visit(symbols);
  const start = declared?.selectionRange?.start ?? declared?.range?.start ?? declared?.location?.range?.start;
  if (start) {
    const at = on(start.line);
    if (at) return at;
  }
  for (let index = 0; index < document.lineCount; index++) {
    const found = on(index);
    if (found) return found;
  }
  return null;
}

/** Location and LocationLink results as {uri, range}, without repeats. @param {any} result */
function locations(result) {
  const list = Array.isArray(result) ? result : result ? [result] : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const uri = item?.targetUri ?? item?.uri;
    const range = item?.targetSelectionRange ?? item?.targetRange ?? item?.range;
    if (!uri || !range) continue;
    const key = `${uri.toString()}#${range.start.line}:${range.start.character}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ uri, range: item?.targetRange && item?.targetSelectionRange ? item.targetRange : range });
  }
  return out;
}

/** The innermost outline symbol declared on that line (so a definition shows its whole body). @param {any[]} symbols @param {number} line */
function enclosing(symbols, line) {
  /** @type {any} */
  let best = null;
  const visit = (/** @type {any[]} */ list) => {
    for (const symbol of list) {
      const range = symbol?.range ?? symbol?.location?.range;
      if (!range || range.start.line > line || range.end.line < line) continue;
      const declaredAt = (symbol.selectionRange ?? range).start.line;
      if (declaredAt === line) best = range;
      if (Array.isArray(symbol.children)) visit(symbol.children);
    }
  };
  visit(symbols);
  return best;
}

/** A promise's value, or undefined once `ms` pass (a provider that hangs counts as finding nothing). @param {any} promise @param {number} ms */
function deadline(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(undefined); });
  });
}

/**
 * Runs git (one fixed program, never a shell) with GIT_SAFE first. Resolves with stdout; rejects with
 * the first line of stderr (or the spawn error, whose code is ENOENT when git isn't there).
 * @param {string} git @param {string} cwd @param {string[]} args @param {AbortSignal} [signal] @returns {Promise<string>}
 */
function runGit(git, cwd, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(git, [...GIT_SAFE, ...args], { cwd, windowsHide: true, shell: false, signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", GIT_EXTERNAL_DIFF: "" } });
    let out = "";
    let errors = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { if (out.length < 4_000_000) out += chunk; });
    child.stderr.on("data", (chunk) => { if (errors.length < 10_000) errors += chunk; });
    const timer = setTimeout(() => child.kill(), GIT_MS);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(Object.assign(new Error(errors.trim().split(/\r?\n/)[0] || `git stopped (exit ${code})`), { exit: code }));
    });
  });
}

/**
 * git status --porcelain=v1 -z, as {path, state, label}: state "new" for untracked files.
 * @param {string} text @returns {{path: string, state: string, label: string}[]}
 */
function parseStatus(text) {
  const parts = text.split("\0");
  const out = [];
  for (let index = 0; index < parts.length; index++) {
    const entry = parts[index];
    if (entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const file = entry.slice(3);
    if (x === "?" && y === "?") { out.push({ path: file, state: "new", label: "new, not in git yet" }); continue; }
    if (x === "!" && y === "!") continue;
    let label = x === "D" || y === "D" ? "deleted" : x === "A" ? "added" : x === "R" || x === "C" ? `renamed from ${parts[index + 1] ?? "?"}`
      : x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D") ? "conflicted" : "modified";
    if (x === "R" || x === "C") index++; // the old name follows
    const staged = x !== " " && x !== "?";
    const unstaged = y !== " " && y !== "?";
    if (label !== "conflicted") label += staged && unstaged ? " (staged and unstaged)" : staged ? " (staged)" : "";
    out.push({ path: file, state: x === "D" || y === "D" ? "deleted" : "changed", label });
  }
  return out;
}

/** git diff --numstat -z: path → "+12 −3" ("binary" for binary files). @param {string} text @returns {[string, string][]} */
function parseNumstat(text) {
  const parts = text.split("\0");
  /** @type {[string, string][]} */
  const out = [];
  for (let index = 0; index < parts.length; index++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[index]);
    if (!match) continue;
    let file = match[3];
    if (!file) { index += 2; file = parts[index]; } // a rename: "", then the old and new names
    out.push([file, match[1] === "-" ? "binary" : `+${match[1]} −${match[2]}`]);
  }
  return out;
}

/** Whether `full` is `folder` or inside it. @param {string} full @param {string} folder */
function within(full, folder) {
  const a = path.resolve(full).toLowerCase();
  const b = path.resolve(folder).toLowerCase();
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/** How many files and bytes a folder holds (counting stops at a limit). @param {string} folder */
function measure(folder) {
  let files = 0;
  let bytes = 0;
  const stack = [folder];
  while (stack.length && files <= MAX_REMOVE_BACKUP_FILES * 5) {
    const current = /** @type {string} */ (stack.pop());
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        files += 1;
        try { bytes += fs.statSync(full).size; } catch { /* gone */ }
      }
    }
  }
  return { files, bytes };
}

/** A bare pattern like *.json matches anywhere, as people mean it. @param {string} glob */
function globOf(glob) {
  const clean = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  return clean.includes("/") ? clean : "**/" + clean;
}

function toEol(/** @type {string} */ text, /** @type {string} */ eol) {
  return text.replace(/\r\n/g, "\n").replace(/\n/g, eol);
}

function occurrences(/** @type {string} */ text, /** @type {string} */ part) {
  return positions(text, part).length;
}

function positions(/** @type {string} */ text, /** @type {string} */ part) {
  const found = [];
  for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + 1)) found.push(at);
  return found;
}

function lineOf(/** @type {string} */ text, /** @type {number} */ index) {
  return text.slice(0, index).split("\n").length;
}

/** The same lines with only trailing spaces differing, found exactly once: [start, length] or null. */
function looseMatch(/** @type {string} */ text, /** @type {string} */ old, /** @type {string} */ eol) {
  const lines = text.split(eol);
  const want = old.split(eol).map((line) => line.trimEnd());
  if (!want.length) return null;
  let hit = null;
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (want.every((line, k) => lines[i + k].trimEnd() === line)) {
      if (hit !== null) return null;
      hit = i;
    }
  }
  if (hit === null) return null;
  const start = lines.slice(0, hit).reduce((sum, line) => sum + line.length + eol.length, 0);
  const length = lines.slice(hit, hit + want.length).join(eol).length;
  return [start, length];
}

function notFound(/** @type {string} */ shown, /** @type {string} */ text, /** @type {string} */ old, /** @type {string} */ eol) {
  const first = old.split(eol).find((line) => line.trim());
  const at = first ? text.split(eol).findIndex((line) => line.trim() === first.trim()) : -1;
  return RESULTS.notFound(shown, at + 1);
}

function keyOf(/** @type {vscode.Diagnostic} */ d) {
  return `${d.severity}|${d.message}|${d.source ?? ""}`;
}

function problemKeys(/** @type {vscode.Uri} */ uri) {
  return new Set(vscode.languages.getDiagnostics(uri).map(keyOf));
}

function short(/** @type {string} */ text, limit = 40) {
  const line = String(text).replace(/\s+/g, " ").trim();
  return line.length > limit ? line.slice(0, limit - 1) + "…" : line;
}

module.exports = { WorkspaceTools, ToolError, outlineEntries, parseStatus, parseNumstat, runGit, locations, positionOf };
