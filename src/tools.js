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
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { RESULTS, TEXTS } = require("./prompt.js");
const { DocsIndex, available: docsAvailable, documentText, isOffice, loose } = require("./docs.js");

const MAX_READ_LINES = 2000;
const MAX_OUTPUT_CHARS = 30_000;
const MAX_SEARCH_LINES = 200;
const MAX_FOUND = 300;
const DIAGNOSTICS_WAIT_MS = 2500;
/** Languages that have never reported diagnostics (plain JavaScript, Markdown) get a short wait instead. */
const DIAGNOSTICS_SHORT_MS = 600;
/** problems with a path: how long to wait for the file's diagnostics to arrive (or refresh). */
const PROBLEMS_WAIT_MS = 1500;
const PROBLEMS_COLD_MS = 3000;
/** A definition's code: at most this many characters (a minified line can be enormous). */
const MAX_DEFINITION_CHARS = 8_000;
/** Whole-word text matches added to references the language server didn't count. */
const MAX_EXTRA_MATCHES = 30;
const MAX_OUTLINE = 400;
/** A language server that's still starting answers with nothing: how long to keep asking. */
const OUTLINE_WAITS_MS = [500, 1000, 1500];
/** How long a definition or reference lookup may take before it counts as "found nothing". */
const LOOKUP_MS = 15_000;
const MAX_DEFINITIONS = 5;
const MAX_DEFINITION_LINES = 80;
const MAX_REFERENCES = 100;
const MAX_CHANGED = 200;
/** Lines that still mention a moved file's name, shown with the move. */
const MOVE_MENTIONS = 20;
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
const BACKUP_GONE = "That step's backup was cleared to keep Solder's storage under its limit (Storage limit in the settings), so it can't be undone.";
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
    /** @type {DocsIndex | null | undefined} the docs index, once opened (null: no SQLite here) */
    this._docs = undefined;
    /** Languages whose diagnostics VS Code has reported: an edit there is worth waiting for. */
    this._diagnosed = new Set();
    context.subscriptions?.push(vscode.languages.onDidChangeDiagnostics((event) => {
      for (const uri of event.uris) {
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
        if (doc) this._diagnosed.add(doc.languageId);
      }
    }));
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
    // Inside means inside once links are followed: a link in the workspace can point anywhere.
    const inside = !!root && within(full, root) && within(realPath(full), realPath(root));
    // A network path can hand your Windows sign-in to that server, so only the workspace's own are opened.
    if (!inside && /^(\\\\|\/\/)/.test(full)) throw new ToolError(RESULTS.networkPath);
    return { uri: vscode.Uri.file(full), full, inside, shown: this.shown(full) };
  }

  /**
   * Why a call needs asking about first, or null: removing anything; changes outside the workspace, or to the
   * files that can make programs run (git's and VS Code's); reading outside the workspace and your docs folders.
   */
  needsApproval(/** @type {string} */ name, /** @type {any} */ args) {
    if (name === "move_item") {
      // Anything that leaves the workspace, or lands outside it, is asked about.
      let from, to;
      try { from = this.resolve(args.from); to = this.resolve(args.to); } catch { return null; }
      const risky = runsPrograms(from.full) || runsPrograms(to.full);
      if (risky) return RUNS_PROGRAMS(risky);
      if (from.inside && to.inside) return null;
      return args.copy ? "It copies to or from outside the workspace folder." : "It moves something into or out of the workspace folder.";
    }
    if (name === "read_file" || name === "symbols") {
      if (!args.path) return null;
      let file;
      try { file = this.resolve(args.path); } catch { return null; }
      if (file.inside || this.docsFolders().some((folder) => within(realPath(file.full), realPath(folder.path)))) return null;
      return "It reads a file outside the workspace folder and your docs folders.";
    }
    if (name === "changes" && args.path) {
      let target;
      try { target = this.resolve(args.path); } catch { return null; }
      return target.inside ? null : "It runs git in a folder outside the workspace folder.";
    }
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
      const unsaved = this.dirty(target.full) ? " Its unsaved changes in the editor will be lost." : "";
      return what + (target.inside ? "." : ", outside the workspace folder.") + unsaved;
    }
    if (name !== "write_file" && name !== "edit_file") return null;
    const risky = runsPrograms(target.full);
    if (risky) return RUNS_PROGRAMS(risky);
    if (!target.inside) return "It changes a file outside the workspace folder.";
    // Solder saves what it changes: unsaved typing in that file would be saved along with it.
    if (this.dirty(target.full)) return "This file has unsaved changes in the editor: they'll be saved along with Solder's change.";
    return null;
  }

  /** Whether an open editor has unsaved changes in this file, or in a file inside this folder. @param {string} full */
  dirty(full) {
    return vscode.workspace.textDocuments.some((doc) => doc.isDirty && doc.uri.scheme === "file" && within(doc.uri.fsPath, full));
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
        case "move_item": return await this.moveItem(args);
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
    /** @type {{lineCount: number, lineAt: (index: number) => {text: string}, getText: () => string}} */
    let document;
    if (isOffice(file.full)) {
      // Word, Excel and PowerPoint as the docs index reads them, so its line numbers fit.
      const text = await documentText(file.full).catch(() => null);
      if (text === null) throw new ToolError(RESULTS.notText(file.shown));
      const all = text.split(/\r\n|\r|\n/);
      document = { lineCount: all.length, lineAt: (index) => ({ text: all[index] }), getText: () => text };
    } else {
      try {
        document = await vscode.workspace.openTextDocument(file.uri);
      } catch {
        throw new ToolError(RESULTS.notText(file.shown));
      }
    }
    const total = document.lineCount;
    if (args.start_line > total) return { output: RESULTS.pastEnd(file.shown, total), summary: `Read ${file.shown} · past the end` };
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
    const names = plainNames(vscode.workspace.getConfiguration("solder").get("instructionFiles", ["AGENTS.md"]));
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
    if (!args.name) {
      if (!args.path) throw new ToolError(RESULTS.symbolsNeedsPath);
      return this.outline(args);
    }
    const find = args.find ?? "definition";
    if (find !== "definition" && find !== "references") throw new ToolError(RESULTS.badFind);
    const name = String(args.name).trim();
    if (!args.path) {
      // No file given: VS Code's workspace symbols find where the name is declared.
      const found = await deadline(vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", name), LOOKUP_MS);
      const exact = (Array.isArray(found) ? found : []).filter((s) => s?.name === name && s.location?.uri?.scheme === "file");
      if (!exact.length) return this.textMatches(name, signal);
      args = { ...args, path: exact[0].location.uri.fsPath, line: exact[0].location.range.start.line + 1 };
    }
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
    return find === "definition" ? this.definitions(name, found) : this.references(name, found, signal);
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
      let size = 0;
      let cut = end < last;
      for (let line = first; line <= end; line++) {
        const text = `${line + 1}\t${document.lineAt(line).text}`;
        if (size + text.length > MAX_DEFINITION_CHARS) { lines.push(text.slice(0, Math.max(200, MAX_DEFINITION_CHARS - size))); cut = true; break; }
        lines.push(text);
        size += text.length + 1;
      }
      blocks.push(`${shown} ${first + 1}–${last + 1}:\n${lines.join("\n")}` + (cut ? "\n" + RESULTS.definitionCut : ""));
    }
    return { output: RESULTS.definitions(name, found.length) + "\n\n" + blocks.join("\n\n"),
      summary: `Definition of ${short(name)} · ${found.length === 1 ? this.shown(found[0].uri.fsPath) : found.length + " places"}` };
  }

  /** Every use, one line each, grouped by file. */
  async references(/** @type {string} */ name, /** @type {{uri: vscode.Uri, range: vscode.Range}[]} */ found, /** @type {AbortSignal} */ signal) {
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
    // Language servers miss uses (plain JavaScript through require, dynamic access): whole-word text matches it
    // didn't count go along, labelled, so the list is never silently short.
    const counted = new Set(out.map((line) => line.slice(0, line.indexOf(": "))));
    const extra = (await this.wordMatches(name, signal).catch(() => []))
      .filter((line) => !counted.has(line.slice(0, line.indexOf(":", line.indexOf(":") + 1)))).slice(0, MAX_EXTRA_MATCHES);
    return { output: RESULTS.references(name, count, files.size) + "\n" + out.join("\n")
      + (count > out.length ? "\n" + RESULTS.referencesCapped(count - out.length) : "")
      + (extra.length ? "\n\n" + RESULTS.alsoText(name) + "\n" + extra.join("\n") : ""),
      summary: `Uses of ${short(name)} · ${count} in ${files.size} file${files.size === 1 ? "" : "s"}` };
  }

  /** Whole-word, case-sensitive text matches for a name under the working folder, as path:line:text. */
  async wordMatches(/** @type {string} */ name, /** @type {AbortSignal} */ signal) {
    const root = this.base();
    if (!root) return [];
    const query = "\\b" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b";
    const rg = this.ripgrep();
    return rg ? this.searchWithRipgrep(rg, root, query, true, undefined, signal, true) : this.searchInJs(root, query, true, undefined, true);
  }

  /** No language support answered: whole-word text matches, clearly labelled as such (saves the model a search). */
  async textMatches(/** @type {string} */ name, /** @type {AbortSignal} */ signal) {
    let lines = await this.wordMatches(name, signal);
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
      // A path that's gone (a removed folder): git runs from the nearest folder that's still there.
      while (!fs.existsSync(folder) && path.dirname(folder) !== folder) folder = path.dirname(folder);
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
    const where = target ? target.shown : (this.folder || "");
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
    if (args.docs) return this.searchDocs(String(args.query), signal);
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

  // ----------------------------------------------------------------------- docs --

  /** The docs folders from the user's settings that exist: [{path, about}]. */
  docsFolders() {
    const raw = vscode.workspace.getConfiguration("solder").get("docsFolders", []);
    /** @type {{path: string, about: string}[]} */
    const out = [];
    for (const item of Array.isArray(raw) ? raw : []) {
      const given = typeof item === "string" ? item : item && typeof item === "object" ? String(item.path ?? "") : "";
      const about = item && typeof item === "object" ? String(item.about ?? "").trim() : "";
      if (!given.trim()) continue;
      const full = path.resolve(given.trim().replace(/^~(?=$|[\\/])/, os.homedir()));
      try { if (!fs.statSync(full).isDirectory()) continue; } catch { continue; }
      if (!out.some((folder) => folder.path.toLowerCase() === full.toLowerCase())) out.push({ path: full, about });
    }
    return out;
  }

  /** The docs index's state, for the settings screen. */
  docsState() {
    const folders = this.docsFolders().length;
    const index = folders ? this.docsIndex() : null;
    if (!index) return { available: folders === 0 || this.docsIndex() !== null, folders, indexed: 0, active: false };
    let indexed = 0;
    try { indexed = index.active ? Math.max(index.progress.indexed, index.count()) : index.count(); } catch { indexed = 0; }
    return { available: true, folders, indexed, active: !!index.active };
  }

  /** The docs index (opened on first use), or null when this VS Code's runtime has no SQLite. */
  docsIndex() {
    if (this._docs === undefined) {
      this._docs = docsAvailable() ? new DocsIndex(path.join(this.context.globalStorageUri.fsPath, "docs", "docs.sqlite")) : null;
    }
    return this._docs;
  }

  /**
   * Bring the docs index up to date in the background (on start, and when the folders change). Big
   * folders take a while the first time; searches meanwhile say the index is still being built.
   */
  async refreshDocs() {
    const index = this.docsIndex();
    if (!index) return;
    const folders = this.docsFolders().map((folder) => folder.path);
    if (index.active) { index.active.finally(() => this.refreshDocs()); return; } // the folders changed meanwhile: again after
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Solder: indexing docs" },
      () => index.refresh(folders, { ms: 30 * 60_000 })).then(() => {}, () => {});
  }

  /** The best passages in the docs for a query; a short catch-up of the index first (up to 4 s). */
  async searchDocs(/** @type {string} */ query, /** @type {AbortSignal} */ signal) {
    const folders = this.docsFolders();
    if (!folders.length) throw new ToolError(RESULTS.docsNone);
    const index = this.docsIndex();
    if (!index) throw new ToolError(RESULTS.docsUnavailable);
    const roots = folders.map((folder) => folder.path);
    const stale = roots.some((root) => Date.now() - index.walkedAt(root) > 2 * 60_000);
    const state = index.active ? { files: index.count(), unfinished: true, truncated: false }
      : stale ? await index.refresh(roots, { ms: 4000, signal }) : { files: index.count(), unfinished: false, truncated: false };
    const hits = await index.search(query);
    const notes = [state.unfinished ? RESULTS.docsBuilding(state.files) : "", state.truncated ? RESULTS.docsTruncated : ""].filter(Boolean);
    if (!hits.length) return { output: [RESULTS.docsNoMatches(query), ...notes].join("\n\n"), summary: `Searched docs for "${short(query)}" · no matches` };
    const vague = loose(hits, query);
    const lines = hits.map((hit) => `${hit.path} · ${hit.location}${hit.heading ? ` · ${hit.heading}` : ""}\n  ${hit.excerpt}`);
    return { output: RESULTS.docsHits(query, hits.length) + "\n\n" + lines.join("\n\n")
      + (vague ? "\n\n" + RESULTS.docsLoose(vague.best, vague.of) : "") + (notes.length ? "\n\n" + notes.join("\n") : ""),
      summary: `Searched docs for "${short(query)}" · ${hits.length} passage${hits.length === 1 ? "" : "s"}` };
  }

  /** Lines containing this exact text under a folder (ripgrep, or the JS fallback), as path:line:text. @param {string} root @param {string} text */
  textLines(root, text) {
    const rg = this.ripgrep();
    return rg ? this.searchWithRipgrep(rg, root, text, false, undefined, AbortSignal.timeout(15_000)) : this.searchInJs(root, text, false, undefined);
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
    /** @type {boolean} */ regex, /** @type {string | undefined} */ glob, /** @type {AbortSignal} */ signal, caseSensitive = false) {
    const args = ["--line-number", "--no-heading", "--color", "never", caseSensitive ? "--case-sensitive" : "--smart-case", "--max-columns", "300",
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
        this.searchInJs(root, query, regex, glob, caseSensitive).then(resolve, reject);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 2 && !out) {
          const lines = errors.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
          // ripgrep explains a bad pattern on the lines after "regex parse error:"; keep the explanation.
          if (/regex parse error/i.test(errors)) { reject(new ToolError(RESULTS.badRegex + (lines.length > 1 ? ` (${lines[lines.length - 1].replace(/^error:\s*/i, "")})` : ""))); return; }
          reject(new ToolError(lines[0] || RESULTS.searchFailed));
          return;
        }
        resolve(out.split(/\r?\n/).filter(Boolean).map((line) => line.replace(/^\.[\\/]/, "").replace(/\\/g, "/")));
      });
    });
  }

  /** @returns {Promise<string[]>} */
  async searchInJs(/** @type {string} */ root, /** @type {string} */ query, /** @type {boolean} */ regex,
    /** @type {string | undefined} */ glob, caseSensitive = false) {
    let pattern;
    const flags = caseSensitive || /[A-Z]/.test(query) ? "" : "i";
    try {
      pattern = regex ? new RegExp(query, flags) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
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
    let uris = await vscode.workspace.findFiles(new vscode.RelativePattern(this.base(), globOf(String(args.glob))), undefined, MAX_FOUND + 1);
    // A plain name ("lib") with no files of that name: the folder of that name, if there is one.
    if (!uris.length && !/[*?[\]{}]/.test(String(args.glob))) {
      uris = await vscode.workspace.findFiles(new vscode.RelativePattern(this.base(), globOf(String(args.glob)).replace(/\/+$/, "") + "/**"), undefined, MAX_FOUND + 1);
    }
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
    stale(document, file);
    const text = document.getText();
    const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const old = toEol(String(args.old_text), eol);
    const replacement = toEol(String(args.new_text), eol);
    if (!old) throw new ToolError(RESULTS.emptyOldText);
    if (old === replacement) throw new ToolError(RESULTS.sameText);
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
    await saveOrRevert(document, file, text);
    const removed = lineCount(old);
    const added = lineCount(replacement);
    const problems = await this.newProblems(file, before);
    return { output: RESULTS.edited(file.shown, removed, added, lineOf(text, start)) + problems.text,
      summary: `Edited ${file.shown} · −${removed} +${added}` + problems.summary,
      change: { path: file.full, shown: file.shown, backup, created: false, after: hash(document.getText()) } };
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
    if (exists && hash(previous) === hash(content)) return { output: RESULTS.sameContent(file.shown), summary: `${file.shown} · unchanged` };
    const madeFolder = exists ? "" : firstMissing(path.dirname(file.full));
    if (open) {
      stale(open, file);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(file.uri, new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length)), toEol(content, open.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n"));
      if (!await vscode.workspace.applyEdit(edit)) throw new ToolError(RESULTS.notApplied(file.shown));
      await saveOrRevert(open, file, previous);
    } else {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(file.full)));
      try { await vscode.workspace.fs.writeFile(file.uri, Buffer.from(content, "utf8")); }
      catch { throw new ToolError(RESULTS.notWritable(file.shown)); }
      await vscode.workspace.openTextDocument(file.uri).then(() => {}, () => {}); // lets language servers look
    }
    const lines = lineCount(content);
    const problems = await this.newProblems(file, before);
    return { output: RESULTS.written(exists, file.shown, lines) + problems.text,
      summary: `${exists ? "Wrote" : "Created"} ${file.shown} · ${lines} lines` + problems.summary,
      change: { path: file.full, shown: file.shown, backup, created: !exists, madeFolder,
        after: hash(open ? open.getText() : content) } };
  }

  // ------------------------------------------------------------------- problems --

  async problems(/** @type {any} */ args) {
    /** @type {any[]} */
    let list;
    if (args.path) {
      const file = this.resolve(args.path);
      await this.mustBeFile(file);
      // VS Code only checks open files: open it, and give its language server a moment (a file it hasn't
      // seen yet takes longer: up to 5 s, sooner if its diagnostics arrive).
      // Solder's own reads open files without showing them; language servers like TypeScript's check only shown ones.
      const wasOpen = shownInEditor(file.full);
      const doc = await vscode.workspace.openTextDocument(file.uri).then((d) => d, () => null);
      const reports = !!doc && this._diagnosed.has(doc.languageId);
      const heard = await this.diagnosticsFor(file, wasOpen ? PROBLEMS_WAIT_MS : reports ? PROBLEMS_COLD_MS : DIAGNOSTICS_SHORT_MS);
      list = [[file.uri, vscode.languages.getDiagnostics(file.uri)]];
      // Some language servers (TypeScript's among them) only check files shown in an editor: silence about
      // a file that wasn't open means "not checked", not "no problems".
      if (!wasOpen && !heard && !list[0][1].length) {
        return { output: RESULTS.notChecked(file.shown), summary: `Problems · ${file.shown} not checked` };
      }
    } else {
      list = vscode.languages.getDiagnostics();
    }
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

  /**
   * Wait until this file's diagnostics change (and a moment more), or `ms` pass.
   * @param {any} file @param {number} ms @returns {Promise<boolean>} whether they changed
   */
  diagnosticsFor(file, ms) {
    return new Promise((resolve) => {
      let heard = false;
      const timer = setTimeout(done, ms);
      const listener = vscode.languages.onDidChangeDiagnostics((event) => {
        if (!heard && event.uris.some((uri) => uri.fsPath.toLowerCase() === file.full.toLowerCase())) { heard = true; setTimeout(done, 250); }
      });
      function done() { clearTimeout(timer); listener.dispose(); resolve(heard); }
    });
  }

  /** The file's errors that weren't there before the change (VS Code's language servers need a moment). */
  async newProblems(/** @type {any} */ file, /** @type {Set<string>} */ before) {
    // A language that has never reported diagnostics (plain JavaScript, Markdown) isn't worth the full wait.
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath.toLowerCase() === file.full.toLowerCase());
    await this.diagnosticsFor(file, doc && this._diagnosed.has(doc.languageId) ? DIAGNOSTICS_WAIT_MS : DIAGNOSTICS_SHORT_MS);
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
    const folder = path.join(this.backupsRoot(), chat.id);
    this.pruneSoon();
    fs.mkdirSync(folder, { recursive: true });
    const name = `${Date.now().toString(36)}-${path.basename(file.full)}`;
    const target = path.join(folder, name);
    fs.writeFileSync(target, text, "utf8");
    return target;
  }

  // ------------------------------------------------------------------ move_item --

  /** Move, rename or copy a file or folder; never overwrites. Undo moves it back, or removes the copy. */
  async moveItem(/** @type {any} */ args) {
    const source = this.resolve(args.from);
    const root = this.root();
    let stat;
    try { stat = fs.statSync(source.full); } catch { throw new ToolError(RESULTS.missing(source.shown)); }
    if ((root && path.resolve(source.full).toLowerCase() === path.resolve(root).toLowerCase()) || path.parse(source.full).root === source.full) {
      throw new ToolError(RESULTS.moveRoot);
    }
    const given = String(args.to ?? "").trim();
    let target = this.resolve(given);
    let into = /[\\/]$/.test(given);
    try { if (fs.statSync(target.full).isDirectory()) into = true; } catch { /* a new path */ }
    if (into) target = this.resolve(path.join(target.full, path.basename(source.full)));
    if (path.resolve(target.full).toLowerCase() === path.resolve(source.full).toLowerCase()) throw new ToolError(RESULTS.moveSame);
    const folder = stat.isDirectory();
    if (folder && within(target.full, source.full)) throw new ToolError(RESULTS.moveIntoItself);
    if (fs.existsSync(target.full)) throw new ToolError(RESULTS.moveExists(target.shown));
    // The file on disk is what moves: an editor's unsaved changes would be left behind.
    const dirty = vscode.workspace.textDocuments.find((doc) => doc.isDirty && doc.uri.scheme === "file" && within(doc.uri.fsPath, source.full));
    if (dirty) throw new ToolError(RESULTS.moveUnsaved(this.shown(dirty.uri.fsPath)));
    const copy = !!args.copy;
    const madeFolder = firstMissing(path.dirname(target.full));
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target.full)));
    // Plain file operations, not a rename with import updates: those could change other files Undo doesn't know about.
    if (copy) await vscode.workspace.fs.copy(source.uri, target.uri, { overwrite: false });
    else await vscode.workspace.fs.rename(source.uri, target.uri, { overwrite: false });
    const files = folder ? measure(target.full).files : null;
    // A move breaks whatever used the old path: show the model those lines now, so it fixes them
    // (in live tests a note alone was ignored three times in four).
    let mentions = "";
    if (!copy && root) {
      const name = path.basename(source.full).replace(/\.[^.]+$/, "");
      if (name.length >= 3) {
        const base = this.base();
        const lines = (await this.textLines(base, name).catch(() => []))
          .filter((line) => !within(path.resolve(base, line.slice(0, line.indexOf(":"))), target.full)).slice(0, MOVE_MENTIONS);
        if (lines.length) mentions = "\n\n" + RESULTS.moveMentions(name, lines);
      }
    }
    return { output: RESULTS.moved(copy, source.shown, target.shown, files) + mentions,
      summary: `${copy ? "Copied" : "Moved"} ${source.shown} → ${target.shown}` + (folder ? ` · ${files} file${files === 1 ? "" : "s"}` : ""),
      change: { path: target.full, shown: target.shown, from: source.full, fromShown: source.shown, moved: !copy, copied: copy, folder,
        madeFolder, stamp: folder ? "" : stampOf(target.full) } };
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
      const store = path.join(this.backupsRoot(), chat.id);
      this.pruneSoon();
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
    return { output: RESULTS.removed(target.shown, folder ? files : null), summary: `Removed ${target.shown}` + (folder ? ` · ${files} file${files === 1 ? "" : "s"}` : ""),
      change: { path: target.full, shown: target.shown, backup, removed: true, folder } };
  }

  /** Put a changed file back as it was before the step (or remove one the step created). */
  async undo(/** @type {any} */ change) {
    const uri = vscode.Uri.file(change.path);
    // Undo puts back what the step found; if the file has changed since, that would throw the later work away.
    const changedSince = () => {
      if (change.after) {
        const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath.toLowerCase() === change.path.toLowerCase());
        let now = null;
        try { now = open ? open.getText() : fs.readFileSync(change.path, "utf8"); } catch { now = null; }
        return now !== null && hash(now) !== change.after;
      }
      return !!change.stamp && fs.existsSync(change.path) && stampOf(change.path) !== change.stamp;
    };
    if ((change.after || change.stamp) && changedSince()) throw new Error(`${change.shown} has changed since that step, so undoing it would lose those changes. Use Review to compare, and change it by hand.`);
    if (change.moved) {
      if (fs.existsSync(change.from)) throw new Error(`Something is already at ${change.fromShown}; move it first.`);
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(change.from)));
      await vscode.workspace.fs.rename(uri, vscode.Uri.file(change.from), { overwrite: false });
      removeEmpty(path.dirname(change.path), change.madeFolder);
      return;
    }
    if (change.copied) {
      await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
      removeEmpty(path.dirname(change.path), change.madeFolder);
      return;
    }
    if (change.removed) {
      if (!change.backup) throw new Error("There's no copy to put back (it was too big to keep).");
      if (!fs.existsSync(change.backup)) throw new Error(BACKUP_GONE);
      if (fs.existsSync(change.path)) throw new Error(`Something is already at ${change.shown}; move it first.`);
      fs.cpSync(change.backup, change.path, { recursive: true });
      return;
    }
    if (change.created) {
      await vscode.workspace.fs.delete(uri, { useTrash: true });
      removeEmpty(path.dirname(change.path), change.madeFolder);
      return;
    }
    if (!fs.existsSync(change.backup)) throw new Error(BACKUP_GONE);
    const text = fs.readFileSync(change.backup, "utf8");
    const document = await vscode.workspace.openTextDocument(uri);
    const now = document.getText();
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(now.length)), text);
    if (!await vscode.workspace.applyEdit(edit)) throw new Error("VS Code didn't apply the undo.");
    if (!await document.save() || document.isDirty) {
      const back = new vscode.WorkspaceEdit();
      back.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), now);
      await vscode.workspace.applyEdit(back);
      throw new Error(`VS Code couldn't save ${change.shown}, so it wasn't undone. Save or reload the file, then try again.`);
    }
  }

  /** Where every chat's backups live (one folder per chat). */
  backupsRoot() {
    return path.join(this.context.globalStorageUri.fsPath, "backups");
  }

  /** A chat was deleted: its backups go too (its steps can't be undone any more). @param {string} chatId */
  removeBackups(chatId) {
    if (!/^[\w-]+$/.test(chatId)) return;
    fs.rmSync(path.join(this.backupsRoot(), chatId), { recursive: true, force: true });
  }

  /** Prune soon, but not on every backup: at most once a minute, after the step. */
  pruneSoon() {
    const now = Date.now();
    if (now - (this._pruned ?? 0) < 60_000) return;
    this._pruned = now;
    setTimeout(() => { try { this.pruneBackups(); } catch { /* best effort */ } }, 2000);
  }

  /**
   * Keep backups under the storage limit (solder.storageLimitGB, 5 GB by default; no time limit): past it, the
   * oldest go first, down to 90% of it. An Undo whose backup went says so.
   * @param {number} [limitBytes] the limit (from the setting when left out) @returns {{bytes: number, removed: number}}
   */
  pruneBackups(limitBytes) {
    const limit = limitBytes ?? Math.max(0.1, Number(vscode.workspace.getConfiguration("solder").get("storageLimitGB", 5)) || 5) * 1024 ** 3;
    const root = this.backupsRoot();
    /** @type {{full: string, bytes: number, time: number}[]} */
    const items = [];
    let chats = [];
    try { chats = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { return { bytes: 0, removed: 0 }; }
    for (const chat of chats) {
      const folder = path.join(root, chat.name);
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name);
        try {
          const stat = fs.statSync(full);
          items.push({ full, bytes: entry.isDirectory() ? measure(full).bytes : stat.size, time: stat.mtimeMs });
        } catch { /* gone */ }
      }
    }
    let bytes = items.reduce((sum, item) => sum + item.bytes, 0);
    let removed = 0;
    if (bytes > limit) {
      for (const item of items.sort((a, b) => a.time - b.time)) {
        if (bytes <= limit * 0.9) break;
        try { fs.rmSync(item.full, { recursive: true, force: true }); bytes -= item.bytes; removed++; } catch { /* in use */ }
      }
    }
    return { bytes, removed };
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
      if (/ callback$/.test(name)) continue; // "reduce() callback" and the like: noise
      // Markdown headings come as "string" symbols: their name ("# Demo") says enough.
      const what = kind === "String" ? "" : kind.toLowerCase() + " ";
      out.push(`${"  ".repeat(depth)}${what}${name} ${last > first ? `${first}–${last}` : first}`);
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

/**
 * The editor's copy of a file it hasn't changed is the disk's; if the disk changed a moment ago and VS Code
 * hasn't caught up, editing that copy would overwrite the change. @param {vscode.TextDocument} document @param {any} file
 */
function stale(document, file) {
  if (document.isDirty) return;
  let disk;
  try { disk = fs.readFileSync(file.full, "utf8"); } catch { return; }
  if (disk.charCodeAt(0) === 0xfeff) disk = disk.slice(1);
  if (disk !== document.getText() && !disk.includes("\uFFFD")) throw new ToolError(RESULTS.changedOnDisk(file.shown));
}

/** Save, or put the editor back as it was and say so: a change only counts once it's on disk. */
async function saveOrRevert(/** @type {vscode.TextDocument} */ document, /** @type {any} */ file, /** @type {string} */ was) {
  if (await document.save() && !document.isDirty) return;
  const back = new vscode.WorkspaceEdit();
  back.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), was);
  await vscode.workspace.applyEdit(back);
  throw new ToolError(RESULTS.notSaved(file.shown));
}

/** @param {string} text */
function hash(text) {
  return crypto.createHash("sha1").update(String(text).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")).digest("hex");
}

/** Whether a file is shown in an editor tab (not just opened by Solder in the background). @param {string} full */
function shownInEditor(full) {
  const key = full.toLowerCase();
  return vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => {
    const input = /** @type {any} */ (tab.input);
    const uri = input?.uri ?? input?.modified;
    return !!uri && uri.scheme === "file" && uri.fsPath.toLowerCase() === key;
  }));
}

/** A file's time and size, to tell later whether it changed. @param {string} full */
function stampOf(full) {
  try { const stat = fs.statSync(full); return `${stat.mtimeMs}:${stat.size}`; } catch { return ""; }
}

/** Lines in a piece of text, not counting the empty one after a final newline. @param {string} text */
function lineCount(text) {
  return text ? text.replace(/\r?\n$/, "").split(/\r?\n/).length : 0;
}

/** The highest folder on the way to `folder` that doesn't exist yet ("" if it all does). @param {string} folder */
function firstMissing(folder) {
  let missing = "";
  for (let at = folder; !fs.existsSync(at) && path.dirname(at) !== at; at = path.dirname(at)) missing = at;
  return missing;
}

/** Remove folders a step made, from `from` up to `top`, while they're empty. @param {string} from @param {string} [top] */
function removeEmpty(from, top) {
  if (!top) return;
  for (let at = from; within(at, top); at = path.dirname(at)) {
    try { if (fs.readdirSync(at).length) return; fs.rmdirSync(at); } catch { return; }
    if (at.toLowerCase() === top.toLowerCase()) return;
  }
}

/** Where a change can make programs run: git's settings, hooks and filters, and VS Code's tasks and settings. */
const PROGRAM_FOLDERS = [".git", ".vscode"];
const PROGRAM_FILES = [".gitattributes", ".gitmodules", ".gitconfig"];
const RUNS_PROGRAMS = (/** @type {string} */ what) =>
  `It changes ${what}, where a change can make programs run (git's hooks and filters, VS Code's tasks and settings).`;

/** The git or VS Code folder or file a path is in, or "". @param {string} full */
function runsPrograms(full) {
  const parts = path.resolve(full).split(/[\\/]/).map((part) => part.toLowerCase());
  const folder = parts.slice(0, -1).find((part) => PROGRAM_FOLDERS.includes(part));
  if (folder) return folder;
  const last = parts[parts.length - 1];
  return PROGRAM_FOLDERS.includes(last) || PROGRAM_FILES.includes(last) ? last : "";
}

/**
 * A path with its links followed: the real path of the nearest part that exists, plus the rest (for a file
 * that isn't there yet). @param {string} full
 */
function realPath(full) {
  const rest = [];
  for (let at = path.resolve(full); ;) {
    try { return path.join(fs.realpathSync.native(at), ...rest.reverse()); } catch { /* not there yet */ }
    const up = path.dirname(at);
    if (up === at) return path.resolve(full);
    rest.push(path.basename(at));
    at = up;
  }
}

/** The instruction file names that are plain names (no folders, no ..), so a setting can't point outside. @param {unknown} names */
function plainNames(names) {
  return (Array.isArray(names) ? names : []).filter((name) => typeof name === "string" && /^[^\\/:]+$/.test(name) && name !== "." && name !== "..");
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

module.exports = { WorkspaceTools, ToolError, plainNames, runsPrograms, realPath, outlineEntries, parseStatus, parseNumstat, runGit, locations, positionOf };
