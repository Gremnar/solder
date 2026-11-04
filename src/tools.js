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
const { RESULTS } = require("./prompt.js");

const MAX_READ_LINES = 2000;
const MAX_OUTPUT_CHARS = 30_000;
const MAX_SEARCH_LINES = 200;
const MAX_FOUND = 300;
const DIAGNOSTICS_WAIT_MS = 2500;
const MAX_REMOVE_BACKUP_BYTES = 200 * 1024 * 1024;
const MAX_REMOVE_BACKUP_FILES = 20_000;

class ToolError extends Error {}

class WorkspaceTools {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this.context = context;
    /** @type {string | null | undefined} */
    this._rg = undefined;
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

module.exports = { WorkspaceTools, ToolError };
