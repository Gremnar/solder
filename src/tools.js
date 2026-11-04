// @ts-check
"use strict";
/**
 * The 6 tools, on VS Code's own APIs: documents (so reads see unsaved edits and edits go through the
 * editor), its bundled ripgrep, findFiles and diagnostics. No shell is ever started.
 * Every change keeps a backup, so each step can be reviewed (VS Code's diff) and undone.
 */
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MAX_READ_LINES = 2000;
const MAX_OUTPUT_CHARS = 30_000;
const MAX_SEARCH_LINES = 200;
const MAX_FOUND = 300;
const DIAGNOSTICS_WAIT_MS = 2500;

class ToolError extends Error {}

class WorkspaceTools {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this.context = context;
    /** @type {string | null | undefined} */
    this._rg = undefined;
  }

  /** The first workspace folder ("" when none is open). */
  root() {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  }

  /** @param {string} given */
  resolve(given) {
    const root = this.root();
    const raw = String(given ?? "").trim().replace(/^["']|["']$/g, "");
    if (!raw) throw new ToolError("No path was given.");
    const full = path.resolve(root || process.cwd(), raw);
    const inside = !!root && (full === root || full.toLowerCase().startsWith(root.toLowerCase() + path.sep));
    return { uri: vscode.Uri.file(full), full, inside, shown: inside ? path.relative(root, full).split(path.sep).join("/") || "." : full };
  }

  /** Why a call needs asking about first, or null: only changes outside the workspace folder. */
  needsApproval(/** @type {string} */ name, /** @type {any} */ args) {
    if (name !== "write_file" && name !== "edit_file") return null;
    try {
      return this.resolve(args.path).inside ? null : "It changes a file outside the workspace folder.";
    } catch { return null; }
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
        case "problems": return await this.problems(args);
        default: throw new ToolError(`There's no tool called ${name}.`);
      }
    } catch (error) {
      if (error instanceof ToolError) return { output: "Error: " + error.message, summary: `${name}: ${error.message}`, failed: true };
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
      throw new ToolError(`${file.shown} couldn't be opened as text (it may be a binary file).`);
    }
    const total = document.lineCount;
    const start = Math.max(1, Math.min(args.start_line || 1, total));
    let end = Math.min(total, args.end_line || start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1);
    if (end < start) end = start;
    const lines = [];
    let size = 0;
    for (let line = start; line <= end; line++) {
      const text = `${line}\t${document.lineAt(line - 1).text}`;
      if (size + text.length > MAX_OUTPUT_CHARS && lines.length) { end = line - 1; break; }
      lines.push(text);
      size += text.length + 1;
    }
    const partial = start > 1 || end < total;
    let output = (partial ? `(lines ${start}–${end} of ${total}; ask for a range for more)\n` : "") + lines.join("\n");
    if (!document.getText().length) output = "(the file is empty)";
    const agents = this.nestedAgents(file, chat);
    if (agents) output += "\n\n" + agents;
    return { output, summary: `Read ${file.shown}` + (partial ? ` · lines ${start}–${end} of ${total}` : ` · ${total} lines`) };
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
          if (text) notes.push(`This folder's ${path.relative(root, candidate).split(path.sep).join("/")} says (it applies to files under it):\n${text}`);
        } catch { /* unreadable: skip */ }
      }
      folder = path.dirname(folder);
    }
    return notes.join("\n\n");
  }

  // --------------------------------------------------------------------- search --

  async search(/** @type {any} */ args, /** @type {AbortSignal} */ signal) {
    const root = this.root();
    if (!root) throw new ToolError("No workspace folder is open.");
    const rg = this.ripgrep();
    const query = String(args.query);
    let lines = rg ? await this.searchWithRipgrep(rg, root, query, !!args.regex, args.glob, signal)
      : await this.searchInJs(root, query, !!args.regex, args.glob);
    const count = lines.length;
    if (!count) {
      return { output: `No matches for "${query}"${args.glob ? ` in ${args.glob}` : ""}.`, summary: `Searched "${short(query)}" · no matches` };
    }
    let note = "";
    if (count > MAX_SEARCH_LINES) {
      lines = lines.slice(0, MAX_SEARCH_LINES);
      note = `\n\n(The first ${MAX_SEARCH_LINES} matching lines; narrow the search with glob or a longer query.)`;
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
        if (signal.aborted) { reject(new ToolError("Stopped.")); return; }
        this._rg = null; // blocked or missing: fall back from now on
        this.searchInJs(root, query, regex, glob).then(resolve, reject);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 2 && !out) { reject(new ToolError(errors.trim().split("\n")[0] || "the search failed")); return; }
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
      throw new ToolError("That regular expression isn't valid.");
    }
    const files = await vscode.workspace.findFiles(globOf(glob || "**/*"), undefined, 5000);
    const lines = [];
    for (const uri of files) {
      let text;
      try {
        if (fs.statSync(uri.fsPath).size > 1_000_000) continue;
        text = fs.readFileSync(uri.fsPath, "utf8");
      } catch { continue; }
      if (text.includes("\u0000")) continue;
      const shown = vscode.workspace.asRelativePath(uri, false);
      text.split(/\r?\n/).forEach((line, index) => {
        if (lines.length <= MAX_SEARCH_LINES && pattern.test(line)) lines.push(`${shown}:${index + 1}:${line.slice(0, 300)}`);
      });
      if (lines.length > MAX_SEARCH_LINES) break;
    }
    return lines;
  }

  // ----------------------------------------------------------------- find_files --

  async findFiles(/** @type {any} */ args) {
    if (!this.root()) throw new ToolError("No workspace folder is open.");
    const uris = await vscode.workspace.findFiles(globOf(String(args.glob)), undefined, MAX_FOUND + 1);
    const shown = uris.map((uri) => vscode.workspace.asRelativePath(uri, false)).sort((a, b) => a.localeCompare(b));
    if (!shown.length) return { output: `No files match ${args.glob}.`, summary: `Found no ${args.glob}` };
    const more = shown.length > MAX_FOUND;
    return { output: shown.slice(0, MAX_FOUND).join("\n") + (more ? `\n\n(The first ${MAX_FOUND}; narrow the glob.)` : ""),
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
    if (!old) throw new ToolError("old_text is empty; use write_file to replace a whole file.");
    let start = -1;
    let length = old.length;
    const count = occurrences(text, old);
    if (count === 1) start = text.indexOf(old);
    else if (count > 1) {
      const lines = positions(text, old).map((index) => lineOf(text, index));
      throw new ToolError(`old_text appears ${count} times in ${file.shown} (at lines ${lines.slice(0, 10).join(", ")}); include more surrounding lines to make it unique.`);
    } else {
      const loose = looseMatch(text, old, eol);
      if (!loose) throw new ToolError(notFound(file.shown, text, old, eol));
      [start, length] = loose;
    }
    const before = problemKeys(file.uri);
    const backup = await this.backup(chat, file, text);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(file.uri, new vscode.Range(document.positionAt(start), document.positionAt(start + length)), replacement);
    if (!await vscode.workspace.applyEdit(edit)) throw new ToolError(`VS Code didn't apply the edit to ${file.shown}.`);
    await document.save();
    const removed = old.split(eol).length;
    const added = replacement ? replacement.split(eol).length : 0;
    const problems = await this.newProblems(file, before);
    return { output: `Edited ${file.shown}: replaced ${removed} line${removed === 1 ? "" : "s"} with ${added}, from line ${lineOf(text, start)}.` + problems.text,
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
      if (stat.type & vscode.FileType.Directory) throw new ToolError(`${file.shown} is a folder.`);
      exists = true;
    } catch (error) { if (error instanceof ToolError) throw error; }
    const open = vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath.toLowerCase() === file.full.toLowerCase());
    const previous = exists ? (open ? open.getText() : fs.readFileSync(file.full, "utf8")) : "";
    const backup = exists ? await this.backup(chat, file, previous) : "";
    const before = exists ? problemKeys(file.uri) : new Set();
    if (open) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(file.uri, new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length)), toEol(content, open.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n"));
      if (!await vscode.workspace.applyEdit(edit)) throw new ToolError(`VS Code didn't apply the change to ${file.shown}.`);
      await open.save();
    } else {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(file.full)));
      await vscode.workspace.fs.writeFile(file.uri, Buffer.from(content, "utf8"));
      await vscode.workspace.openTextDocument(file.uri).then(() => {}, () => {}); // lets language servers look
    }
    const lines = content ? content.split(/\r?\n/).length : 0;
    const problems = await this.newProblems(file, before);
    return { output: `${exists ? "Wrote" : "Created"} ${file.shown} (${lines} line${lines === 1 ? "" : "s"}).` + problems.text,
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
        lines.push(`${vscode.workspace.asRelativePath(uri, false)}:${d.range.start.line + 1}:${d.range.start.character + 1} ` +
          `${d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning"}: ${d.message.split("\n")[0]}` + (d.source ? ` (${d.source})` : ""));
      }
    }
    const errors = lines.filter((line) => / error: /.test(line)).length;
    if (!lines.length) return { output: "No errors or warnings" + (args.path ? ` in ${args.path}.` : "."), summary: "Problems · none" };
    const shown = lines.slice(0, 100);
    return { output: shown.join("\n") + (lines.length > 100 ? `\n\n(${lines.length - 100} more)` : ""),
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
    return { text: `\n\nNew problems in ${file.shown} now:\n${lines.join("\n")}` + (fresh.length > 10 ? `\n- and ${fresh.length - 10} more` : ""),
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

  /** Put a changed file back as it was before the step (or remove one the step created). */
  async undo(/** @type {any} */ change) {
    const uri = vscode.Uri.file(change.path);
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
    try { stat = await vscode.workspace.fs.stat(file.uri); } catch { throw new ToolError(`${file.shown} doesn't exist.`); }
    if (stat.type & vscode.FileType.Directory) throw new ToolError(`${file.shown} is a folder; use find_files to list it.`);
    if (stat.size > 20 * 1024 * 1024) throw new ToolError(`${file.shown} is too large to read (${Math.round(stat.size / 1048576)} MB).`);
  }
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
  return `old_text wasn't found in ${shown}.` + (at >= 0
    ? ` Its first line appears at line ${at + 1}, but the lines after it differ: read the file again around there and copy the text exactly.`
    : " Read the file again and copy the text exactly.");
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
