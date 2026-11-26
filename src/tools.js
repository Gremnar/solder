// @ts-check
"use strict";
/**
 * The tools, on VS Code's own APIs: documents (so reads see unsaved edits and edits go through the
 * editor), its bundled ripgrep, findFiles and diagnostics. No shell is ever started.
 * Every change keeps a backup, so each step can be reviewed (VS Code's diff) and undone.
 */
const vscode = require("vscode");
const { config: solderSettings } = require("./config.js");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const { RESULTS, TEXTS } = require("./prompt.js");
const { DocsIndex, EmbedBudget, EmbedCache, meaningFloor, available: docsAvailable, documentText, isOffice, loose, SIGNED, signatureBlocks, decodeText } = require("./docs.js");
const skills = require("./skills.js");
const { describe } = require("./review.js");
const { textKind, textOutline, outlineLines, definedIn } = require("./outline.js");

const MAX_READ_LINES = 2000;
const MAX_OUTPUT_CHARS = 30_000;
/** A line longer than this (minified or generated code) is shown by its start only... */
const LONG_LINE_CHARS = 2_000;
/** ...this much of it. */
const LONG_LINE_SHOWN = 1_000;
/** A read of at most this many lines shows long lines whole. */
const NARROW_READ_LINES = 3;
/** In a search, the text either side of a match in a long line, and how many matches a line shows. */
const AROUND_MATCH = 120;
const MATCHES_A_LINE = 3;
/** What ripgrep puts after a long line's first columns. */
const RG_OMITTED = " [... omitted end of long line]";
const MAX_SEARCH_LINES = 200;
const MAX_FOUND = 300;
const DIAGNOSTICS_WAIT_MS = 2500;
/** Languages that have never reported diagnostics (plain JavaScript, Markdown) get a short wait instead. */
const DIAGNOSTICS_SHORT_MS = 600;
/** problems with a path: how long to wait for the file's diagnostics to arrive (or refresh). */
const PROBLEMS_WAIT_MS = 1500;
/** ... and for a file opened just for the check: its language server may be starting (shorter where it never reports). */
const PROBLEMS_COLD_MS = 4000;
const PROBLEMS_UNKNOWN_MS = 2000;
/** A reply's changed files that aren't in a tab are opened in a background tab for their check: at most this many. */
const MAX_CHECK_TABS = 8;
/** Code VS Code itself checks (JavaScript, TypeScript, JSON, CSS): worth a background tab for the check. */
const CODE_FILE = /\.(m?[jt]sx?|c[jt]s|jsonc?|css|scss|less)$/i;
/**
 * Code only an extension checks. A change to one, where nothing has reported problems in its kind of file, says it
 * wasn't checked: silence there isn't "no errors". Plain text, Markdown, JSON, logs and the like get no such note.
 */
const NEEDS_EXTENSION = /\.(ps1|psm1|psd1|bat|cmd|st|scl|xml|sql|py|cs|vb|java|c|h|cc|cpp|hpp|go|rs|rb|php|sh|lua|pl|r|kt|swift|dart)$/i;
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
/** Files a name's text matches are in that Solder's own outline looks through for its definition (no language support). */
const TEXT_LOOKUP_FILES = 20;
/** A file this long that gets no outline from a language at all: that language has none, so it isn't waited for again. */
const SILENT_LINES = 50;
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
 * make Solder run other programs. Status may still run the filters set up for you or the whole PC (Git LFS, say),
 * as VS Code's own Source Control view does; a repository's own filters are switched off (see quietFilters).
 */
const GIT_SAFE = ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false",
  "-c", "color.ui=false", "-c", "diff.external="];
const MAX_REMOVE_BACKUP_BYTES = 200 * 1024 * 1024;
const BACKUP_GONE = "That step's backup was cleared to keep Solder's storage under its limit (Storage limit in the settings), so it can't be undone.";
const MAX_REMOVE_BACKUP_FILES = 20_000;

class ToolError extends Error {
  /** @param {string} message @param {string} [detail] more for the model (such as the file's lines), not for the step's line */
  constructor(message, detail = "") { super(message); this.detail = detail; }
}

/** A missed edit shows at most this many of the file's lines around where it was meant to go. */
const MISS_LINES = 40;
/** ... and old_text found in several places, this many of them, with a line either side. */
const MISS_PLACES = 3;
/** A missing path: at most this many files suggested in its place, found within this long. */
const NEARBY_MAX = 6;
const NEARBY_MS = 3_000;
/** A search or symbols result brings at most this many folder rules files the chat hasn't been given. */
const MAX_RULES_A_RESULT = 2;
/** A folder given as a file: at most this many of its entries listed. */
const FOLDER_ENTRIES_MAX = 100;
/** A content search stops after this long. */
const SEARCH_MS = 30_000;

class WorkspaceTools {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this.context = context;
    /** The skills folder of the project the chat being worked in belongs to ("" for none): its skills are offered there. */
    this.projectSkills = "";
    /** @type {Set<string>} files you attached by path (lower case): read without asking */
    this.attached = new Set();
    /** @type {string | null | undefined} */
    this._rg = undefined;
    /** Languages whose symbol provider has answered: an empty outline from them is real, not a slow start. */
    this._outlined = new Set();
    /** Languages that gave no outline after the whole wait: asked again each time, but not waited for. */
    this._silent = new Set();
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
    /** Edits whose problems check waits for a later edit to the same file in the same reply. @type {Map<string, any>} */
    this._pendingProblems = new Map();
    /** Files already said to be unchecked, each once a task ("task|path"). @type {Set<string>} */
    this._notChecked = new Set();
  }

  /** The first workspace folder ("" when none is open). */
  root() {
    return this.roots()[0] ?? "";
  }

  /** Every folder in the window's workspace (on disk), the first being the main one. */
  roots() {
    return (vscode.workspace.workspaceFolders || []).filter((folder) => folder.uri.scheme === "file").map((folder) => folder.uri.fsPath);
  }

  /** The workspace folder a path is in (the innermost, if they nest), or "". @param {string} full */
  rootOf(full) {
    return this.roots().filter((root) => within(full, root)).sort((a, b) => b.length - a.length)[0] ?? "";
  }

  /**
   * Where relative paths and searches start: the working folder, or the main workspace folder. A working folder
   * in the main folder is kept relative to it; one in another workspace folder, as its full path.
   */
  base() {
    const root = this.root();
    if (!root || !this.folder) return root;
    const full = path.isAbsolute(this.folder) ? path.resolve(this.folder) : path.resolve(root, this.folder);
    return this.rootOf(full) && fs.existsSync(full) ? full : root;
  }

  /** Where a search with no folder of its own looks: the working folder, or every workspace folder. */
  searchRoots() {
    return this.folder ? [this.base()].filter(Boolean) : this.roots();
  }

  /** @param {string} folder relative to the workspace folder */
  useFolder(folder) { this.folder = folder || ""; }

  /**
   * A path as the model sees it: relative to the working folder when it's in the same workspace folder, else its
   * full path (another workspace folder, or outside). @param {string} full
   */
  shown(full) {
    const base = this.base();
    const home = base ? this.rootOf(base) || base : "";
    if (!home || !within(full, home)) return full;
    return path.relative(base, full).split(path.sep).join("/") || ".";
  }

  /** @param {string} given */
  resolve(given) {
    const root = this.root();
    const raw = String(given ?? "").trim().replace(/^["']|["']$/g, "");
    if (!raw) throw new ToolError(RESULTS.noPath);
    const full = path.resolve(this.base() || process.cwd(), raw);
    // Inside means inside one of the workspace's folders once links are followed: a link in it can point anywhere.
    const inside = !!root && this.roots().some((folder) => within(full, folder) && within(realPath(full), realPath(folder)));
    // A network path can hand your Windows sign-in to that server, so only the workspace's own are opened, and those
    // in a docs or skills folder you (or your organisation) set up: compared as written, so no other server is touched.
    if (!inside && isNetwork(full) && !this.referenceFolders().some((folder) => isNetwork(folder) && within(full, folder))) {
      throw new ToolError(RESULTS.networkPath);
    }
    return { uri: vscode.Uri.file(full), full, inside, shown: this.shown(full) };
  }

  /**
   * Why a call needs asking about first, or null: removing anything; changes outside the workspace, to the files
   * that can make programs run (git's and VS Code's), or to what the model follows in later chats (the rules files
   * and a project's .solder folder); reading outside the workspace and your docs folders.
   */
  needsApproval(/** @type {string} */ name, /** @type {any} */ args) {
    if (name === "move_item") {
      // Anything that leaves the workspace, or lands outside it, is asked about.
      let from, to;
      try { from = this.resolve(args.from); to = this.resolve(args.to); } catch { return null; }
      const risky = programRisk(from.full) || programRisk(to.full);
      if (risky) return RUNS_PROGRAMS(risky);
      if (!from.inside || !to.inside) return args.copy ? "It copies to or from outside the workspace folder." : "It moves something into or out of the workspace folder.";
      return this.followed(from.full) || this.followed(to.full) || null;
    }
    if (name === "read_file" || name === "symbols" || name === "problems" || name === "search") {
      if (!args.path || (name === "search" && args.docs)) return null;
      let file;
      try { file = this.resolve(args.path); } catch { return null; }
      if (file.inside || this.inReferenceFolder(file.full)) return null;
      // A file you attached to a message yourself (too long to send whole): reading or searching it is what you asked for.
      if ((name === "read_file" || name === "search") && this.attached.has(file.full.toLowerCase())) return null;
      return name === "search" ? "It searches outside the workspace folder, your docs folders and your skills folders."
        : "It reads a file outside the workspace folder, your docs folders and your skills folders.";
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
    const risky = programRisk(target.full);
    if (risky) return RUNS_PROGRAMS(risky);
    if (!target.inside) return "It changes a file outside the workspace folder.";
    const followed = this.followed(target.full);
    if (followed) return followed;
    // Solder saves what it changes: unsaved typing in that file would be saved along with it.
    if (this.dirty(target.full)) return "This file has unsaved changes in the editor: they'll be saved along with Solder's change.";
    return null;
  }

  /**
   * Why a change to this path is asked about as one the model follows in later chats, or "": a rules file (by the
   * instruction file names in the settings, in any folder), or anything in a project's .solder folder. @param {string} full
   */
  followed(full) {
    const what = followedLater(full, plainNames(solderSettings().get("instructionFiles", ["AGENTS.md"])));
    if (!what) return "";
    return what === PROJECT_FOLDER ? `It changes ${what}, a project's own folder: its skills and skill switches are followed in later chats.`
      : `It changes ${what}, rules the model follows in later chats.`;
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
        // The folder rules of the files a search or symbols result names come with it (a few at most).
        case "symbols": return this.withFolderRules(await this.symbols(args, ctx.signal), ctx.chat, args.path ? [String(args.path)] : []);
        case "changes": return await this.changes(args, ctx.signal);
        case "search": return args.docs ? await this.search(args, ctx.signal) : this.withFolderRules(await this.search(args, ctx.signal), ctx.chat, []);
        case "find_files": return await this.findFiles(args);
        case "edit_file": return await this.editFile(args, ctx.chat, ctx.edit);
        case "write_file": return await this.writeFile(args, ctx.chat, ctx.edit);
        case "remove_item": return await this.removeItem(args, ctx.chat);
        case "move_item": return await this.moveItem(args, ctx.chat);
        case "problems": return await this.problems(args);
        default: throw new ToolError(RESULTS.noTool(name));
      }
    } catch (error) {
      if (error instanceof ToolError) return { output: RESULTS.error(error.message) + (error.detail ? "\n" + error.detail : ""), summary: `${name}: ${error.message}`, failed: true };
      throw error;
    }
  }

  // ------------------------------------------------------------------ read_file --

  async readFile(/** @type {any} */ args, /** @type {any} */ chat) {
    let file = this.resolve(args.path);
    // Not there, and the workspace has just one file of that name: that one is read, and the result says so.
    const instead = await this.onlyOfName(file);
    if (instead) file = instead;
    await this.mustBeFile(file);
    const head = instead ? RESULTS.readInstead(path.basename(String(args.path).trim().replace(/^["']|["']$/g, "")), file.shown) + "\n" : "";
    const read = await this.readResolved(file, args, chat);
    return head ? { ...read, output: head + read.output } : read;
  }

  /**
   * For read_file or symbols of a path that isn't there: the one file in the workspace with that name (any case, the same
   * extension), resolved as any read is, when reading it needs no approval. null when the path is there, when there
   * are none or several, or when the path asked for is outside the workspace. Never used for a change.
   * @param {any} file resolve()'s @returns {Promise<any>}
   */
  async onlyOfName(file) {
    if (!file.inside) return null;
    try { await vscode.workspace.fs.stat(file.uri); return null; } catch { /* not there */ }
    const name = path.basename(file.full);
    if (!name || /[*?[\]{}]/.test(name)) return null;
    /** @type {string[]} */
    const found = [];
    for (const root of this.roots()) {
      try {
        const uris = await deadline(vscode.workspace.findFiles(new vscode.RelativePattern(root, caseless("**/" + name)), "**/node_modules/**", 2), NEARBY_MS);
        if (!Array.isArray(uris)) return null; // it didn't answer in time: another file of that name may be there
        for (const uri of uris) {
          if (!found.some((other) => other.toLowerCase() === uri.fsPath.toLowerCase())) found.push(uri.fsPath);
        }
      } catch { return null; } // the search didn't answer: as today, the error with what it can suggest
      if (found.length > 1) return null;
    }
    if (found.length !== 1 || path.basename(found[0]).toLowerCase() !== name.toLowerCase()) return null;
    let other;
    try { other = this.resolve(found[0]); } catch { return null; }
    if (!other.inside || this.needsApproval("read_file", { path: other.full }) !== null) return null;
    try { if (!fs.statSync(other.full).isFile()) return null; } catch { return null; }
    return other;
  }

  /** read_file, once the file is known to be there. @param {any} file @param {any} args @param {any} chat */
  async readResolved(file, args, chat) {
    const skill = this.readSkill(file.full, chat);
    if (skill) return skill;
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
      // VS Code's copy can be behind the disk without knowing (a network drive's changes often don't reach its
      // watcher): then what's read is the disk's, with nothing written and nothing reloaded.
      const fresh = diskTextIfNewer(/** @type {any} */ (document), file.full);
      if (fresh !== null) {
        const all = fresh.split(/\r\n|\r|\n/);
        document = { lineCount: all.length, lineAt: (index) => ({ text: all[index] }), getText: () => fresh };
      }
    }
    const total = document.lineCount;
    if (args.start_line > total) return { output: RESULTS.pastEnd(file.shown, total), summary: `Read ${file.shown} · past the end` };
    const start = Math.max(1, Math.min(args.start_line || 1, total));
    let end = Math.min(total, args.end_line || start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1);
    /** One to three lines asked for: long ones shown whole (up to the output cap). */
    const narrow = !!args.start_line && !!args.end_line && end - start <= NARROW_READ_LINES - 1;
    if (end < start) end = start;
    const lines = [];
    let size = 0;
    // A digital signature's lines (several thousand tokens of base64) are one line here.
    const signature = SIGNED.test(document.getText())
      ? signatureBlocks(Array.from({ length: total }, (_, index) => document.lineAt(index).text)) : [];
    for (let line = start; line <= end; line++) {
      const block = signature.find(([first, last]) => line - 1 >= first && line - 1 <= last);
      if (block) {
        const note = RESULTS.signatureLeftOut(block[0] + 1, block[1] + 1);
        lines.push(note);
        size += note.length + 1;
        line = block[1] + 1;
        continue;
      }
      const raw = document.lineAt(line - 1).text;
      // A long line is shown by its start (minified code would swamp the chat), unless just a few lines were asked for.
      const text = raw.length > LONG_LINE_CHARS && !narrow
        ? `${line}\t${raw.slice(0, LONG_LINE_SHOWN)}…\n${RESULTS.longLine(line, raw.length, raw.length < MAX_OUTPUT_CHARS - 100)}` : `${line}\t${raw}`;
      if (size + text.length > MAX_OUTPUT_CHARS) {
        if (lines.length) { end = line - 1; break; }
        // One line longer than the whole cap (minified code, a data file): its start only.
        lines.push(text.slice(0, MAX_OUTPUT_CHARS) + "\n" + RESULTS.longLine(line, text.length - String(line).length - 1, false));
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

  /**
   * A skill's file, read: always whole (a range asked for is ignored), without line numbers, and as `keep`, so
   * it stays in the chat when the result is cut. A skill the chat already holds, word
   * for word, isn't sent again. null when the file isn't a skill (or has nothing in it to follow): read as a file.
   * @param {string} full @param {any} chat @returns {{output: string, summary: string, keep?: string} | null}
   */
  readSkill(full, chat) {
    const real = realPath(full);
    if (!skills.isSkill(this.skillsFolders().map(realPath), real)) return null;
    const skill = skills.readSkill(real);
    if (!skill.text) return null;
    const keep = RESULTS.skillText(skill.name, skill.when, skill.text);
    const since = chat?.compaction?.through ?? 0;
    // A result an Assist carry-over had to leave out isn't in the chat the model has: the skill goes again.
    const leftOut = new Set(chat?.assist?.leftOut || []);
    const held = (chat?.messages || []).slice(since).some((/** @type {any} */ m) => m.role === "tool" && !leftOut.has(m.tool_call_id) && String(m.meta?.keep ?? "").includes(keep));
    if (held) return { output: RESULTS.skillAgain(skill.name), summary: `Skill ${skill.name} · already in this chat` };
    return { output: RESULTS.skillRead(skill.name, skill.cut ? skills.MAX_SKILL_CHARS : 0), summary: `Read the skill ${skill.name}`, keep };
  }

  /**
   * Whether the project's skills folder is really inside the project: <project>\.solder\skills, links followed. A
   * junction or link there that leads somewhere else would make that place readable without asking (a skills folder
   * is), so it isn't used, as a rules file that's a link out isn't.
   */
  ownProjectSkills() {
    if (!this.projectSkills) return false;
    try {
      const project = path.dirname(path.dirname(this.projectSkills));
      const real = realPath(this.projectSkills);
      const home = realPath(project);
      return real.toLowerCase() !== home.toLowerCase() && within(real, home);
    } catch { return false; }
  }

  /** The skills folders from the settings (or the list given) that exist, as full paths. @param {unknown} [given] */
  skillsFolders(given) {
    // Your own and your organization's, then the project's (when the chat is in one): a given list is just itself.
    const raw = given ?? [...(solderSettings().get("skillsFolders", []) || []), ...(this.ownProjectSkills() ? [this.projectSkills] : [])];
    /** @type {string[]} */
    const out = [];
    for (const item of Array.isArray(raw) ? raw : []) {
      const given = typeof item === "string" ? item : item && typeof item === "object" ? String(item.path ?? "") : "";
      if (!given.trim()) continue;
      const full = path.resolve(given.trim().replace(/^~(?=$|[\\/])/, os.homedir()));
      try { if (!fs.statSync(full).isDirectory()) continue; } catch { continue; }
      if (!out.some((folder) => folder.toLowerCase() === full.toLowerCase())) out.push(full);
    }
    return out;
  }

  /**
   * The skills the model is told about: in the skills folders, the organisation's first, the project's last.
   * @param {boolean} [withProject] false for your own and your organization's alone (Settings lists those)
   */
  skills(withProject = true) {
    return skills.listSkills(withProject ? this.skillsFolders() : this.skillsFolders(solderSettings().get("skillsFolders", []) || []));
  }

  /** The first read in a folder with its own AGENTS.md brings that file along (the nearest one wins). */
  nestedAgents(/** @type {any} */ file, /** @type {any} */ chat) {
    const root = this.rootOf(file.full);
    if (!file.inside || !root || !chat) return "";
    return giveRules(folderRules(file.full, root, ruleNames()), chat).notes;
  }

  /**
   * A search or symbols result, with the folder rules of the files it names that this chat hasn't been given (at most
   * MAX_RULES_A_RESULT of them: a broad search would bring many; the rest come before a change, see rulesFirst).
   * @param {any} result @param {any} chat @param {string[]} first paths to take first (the file a symbols call named)
   */
  withFolderRules(result, chat, first) {
    if (!result || result.failed || !chat) return result;
    const names = ruleNames();
    /** @type {{key: string, file: string, shown: string}[]} */
    const rules = [];
    const folders = new Set();
    for (const given of [...first, ...namedPaths(String(result.output ?? ""))]) {
      if (folders.size >= 100) break;
      let file;
      try { file = this.resolve(given); } catch { continue; }
      const root = this.rootOf(file.full);
      const folder = path.dirname(file.full).toLowerCase();
      if (!file.inside || !root || folders.has(folder)) continue;
      try { if (!fs.statSync(file.full).isFile()) continue; } catch { continue; }
      folders.add(folder);
      for (const rule of folderRules(file.full, root, names)) if (!rules.some((other) => other.key === rule.key)) rules.push(rule);
    }
    const { notes } = giveRules(rules, chat, MAX_RULES_A_RESULT);
    return notes ? { ...result, keep: [result.keep, notes].filter(Boolean).join("\n\n") } : result;
  }

  /**
   * Before a change (edit, write, a move's destination) in a folder whose rules the model hadn't seen when it wrote
   * the call: the change isn't made, and the rules come back (marked given), so the call is made again with them.
   * Rules given earlier in the same reply count as unseen: that reply's calls were written before them. Rules the
   * chat's record says were given are given, even if compaction has since summarised them (no loop). null: go ahead.
   * @param {any} file resolve()'s @param {any} chat
   */
  rulesFirst(file, chat) {
    const root = this.rootOf(file.full);
    if (!chat || !file.inside || !root) return null;
    // The rules file being changed isn't one to read first.
    const rules = folderRules(file.full, root, ruleNames()).filter((rule) => rule.key !== file.full.toLowerCase());
    const { notes, fresh, pending } = giveRules(rules, chat);
    if (!fresh.length && !pending.length) return null;
    return { output: RESULTS.error(RESULTS.rulesFirst(file.shown, [...fresh, ...pending], fresh.length > 0, pending.length > 0)),
      summary: `Not changed yet: ${file.shown} · its folder's rules first`, failed: true, ...(notes ? { keep: notes } : {}) };
  }

  // -------------------------------------------------------------------- symbols --

  /** The outline, or (with a name) its definition or references. */
  async symbols(/** @type {any} */ args, /** @type {AbortSignal} */ signal) {
    // A path that isn't there, and the workspace has just one file of that name: that one is looked at, as read_file
    // does, and the result says so (it only looks, so nothing can land in the wrong file).
    if (args.path) {
      const instead = await this.onlyOfName(this.resolve(args.path));
      if (instead) {
        const done = await this.symbols({ ...args, path: instead.full }, signal);
        const asked = path.basename(String(args.path).trim().replace(/^["']|["']$/g, ""));
        return { ...done, output: RESULTS.readInstead(asked, instead.shown) + "\n" + done.output };
      }
    }
    if (!args.name) {
      if (!args.path) throw new ToolError(RESULTS.symbolsNeedsPath);
      return this.outline(args);
    }
    const find = args.find ?? "definition";
    if (find !== "definition" && find !== "references") throw new ToolError(RESULTS.badFind);
    const name = plainName(String(args.name));
    /** @type {string[]} other places the name is declared, when none was given */
    let others = [];
    const fromIndex = !args.path;
    if (!args.path) {
      // No file given: VS Code's workspace symbols find where the name is declared.
      const found = await deadline(vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", name), LOOKUP_MS);
      // TypeScript's workspace symbols name functions with their parentheses ("parseRow()").
      const all = (Array.isArray(found) ? found : []).filter((s) => typeof s?.name === "string"
        && s.name.replace(/\s*\(.*\)$/, "") === name && s.location?.uri?.scheme === "file");
      const exact = all.filter((s, i) => all.findIndex((o) => o.location.uri.toString() === s.location.uri.toString()
        && o.location.range.start.line === s.location.range.start.line) === i);
      if (!exact.length) return this.textFallback(name, find, signal);
      // Declared in several places: every definition (up to the cap), or the first's uses with the others named.
      if (exact.length > 1 && find === "definition") return this.definitions(name, exact.map((s) => s.location));
      if (exact.length > 1) others = exact.slice(1, 1 + MAX_DEFINITIONS).map((s) => `${this.shown(s.location.uri.fsPath)} ${s.location.range.start.line + 1}`);
      args = { ...args, path: exact[0].location.uri.fsPath, line: exact[0].location.range.start.line + 1 };
    }
    const file = this.resolve(args.path);
    await this.mustBeFile(file);
    let document;
    try { document = await vscode.workspace.openTextDocument(file.uri); } catch { throw new ToolError(RESULTS.notText(file.shown)); }
    const symbols = await this.symbolsOf(document); // also gives a cold language server its moment
    // No language support: Solder's own outline of the text knows where a function or block starts and ends.
    if (!symbols.length && find === "definition") {
      const own = this.textDefinitions(name, [{ full: file.full, document }]);
      if (own) return own;
    }
    const position = positionOf(document, symbols, name, args.line);
    // Not in the file given: the whole workspace, as with no path (saves a search and a second call).
    if (!position) {
      // The index named a file the name isn't in (it's behind an edit): text matches, not another lookup.
      if (fromIndex) return this.textMatches(name, signal);
      const elsewhere = await this.symbols({ name, find }, signal);
      return { ...elsewhere, output: RESULTS.notInFile(name, file.shown) + "\n\n" + elsewhere.output };
    }
    const command = find === "definition" ? "vscode.executeDefinitionProvider" : "vscode.executeReferenceProvider";
    const found = locations(await deadline(vscode.commands.executeCommand(command, document.uri, position), LOOKUP_MS));
    if (!found.length) return this.textFallback(name, find, signal);
    if (find === "definition") return this.definitions(name, found);
    const uses = await this.references(name, found, signal);
    return others.length ? { ...uses, output: uses.output + "\n\n" + RESULTS.alsoDefined(name, others) } : uses;
  }

  /** A file the model may see without asking: in the workspace, a docs folder or a skills folder (as read_file's approval). @param {string} full */
  mayRead(full) {
    let file;
    try { file = this.resolve(full); } catch { return false; }
    return file.inside || this.inReferenceFolder(file.full);
  }

  /** The docs and skills folders: places set up by you or your organisation, which the model reads without asking. */
  referenceFolders() {
    return [...this.docsFolders().map((folder) => folder.path), ...this.skillsFolders()];
  }

  /** Whether a path is in one of the docs or skills folders (by its real path, so a junction can't lead out). @param {string} full */
  inReferenceFolder(full) {
    const real = realPath(full);
    return this.referenceFolders().some((folder) => within(real, realPath(folder)));
  }

  /** Definitions with their code (the whole symbol when VS Code knows its extent, capped). */
  async definitions(/** @type {string} */ name, /** @type {{uri: vscode.Uri, range: vscode.Range}[]} */ found) {
    const blocks = [];
    for (const place of found.slice(0, MAX_DEFINITIONS)) {
      const shown = this.shown(place.uri.fsPath);
      if (place.uri.scheme !== "file") { blocks.push(`${shown} ${place.range.start.line + 1}`); continue; }
      if (!this.mayRead(place.uri.fsPath)) { blocks.push(`${shown} ${place.range.start.line + 1} ` + RESULTS.outsideNotShown); continue; }
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
      try { if (uri.scheme === "file" && this.mayRead(uri.fsPath)) document = await vscode.workspace.openTextDocument(uri); } catch { /* listed without text */ }
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
    // No lookarounds: ripgrep's own engine has none. The character either side is matched instead (or a line's end).
    const edge = nameChars(name);
    const query = `(?:^|[^${edge}])${escapeRegex(name)}(?:$|[^${edge}])`;
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

  /**
   * No language support answered. For a definition, the files the name appears in that Solder outlines by their text
   * (PowerShell, Structured Text, batch, …): where one defines it, its body. Else whole-word text matches.
   */
  async textFallback(/** @type {string} */ name, /** @type {string} */ find, /** @type {AbortSignal} */ signal) {
    if (find === "definition") {
      const lines = await this.wordMatches(name, signal).catch(() => []);
      const files = [...new Set(lines.map((line) => /^(.+?):\d+:/.exec(line)?.[1] ?? "").filter((p) => p && textKind(p)))].slice(0, TEXT_LOOKUP_FILES);
      /** @type {{full: string, document: vscode.TextDocument}[]} */
      const places = [];
      for (const shown of files) {
        try {
          const file = this.resolve(shown);
          if (!this.mayRead(file.full)) continue;
          places.push({ full: file.full, document: await vscode.workspace.openTextDocument(file.uri) });
        } catch { /* gone, or not text: left out */ }
      }
      const own = this.textDefinitions(name, places);
      if (own) return own;
    }
    return this.textMatches(name, signal);
  }

  /**
   * Where Solder's outline of these files' text defines `name`, with its body (to its end, or to the next definition
   * when its end can't be told), as definitions() shows a language server's; null when none does.
   * @param {string} name @param {{full: string, document: vscode.TextDocument}[]} places
   */
  textDefinitions(name, places) {
    /** @type {{full: string, document: vscode.TextDocument, first: number, last: number}[]} */
    const found = [];
    for (const { full, document } of places) {
      const entries = textOutline(document.getText(), full);
      if (!entries) continue;
      for (const { entry, last } of definedIn(entries, name, full, document.lineCount)) found.push({ full, document, first: entry.start - 1, last: Math.min(last, document.lineCount) - 1 });
    }
    if (!found.length) return null;
    const blocks = [];
    for (const { full, document, first, last } of found.slice(0, MAX_DEFINITIONS)) {
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
      blocks.push(`${this.shown(full)} ${first + 1}–${last + 1}:\n${lines.join("\n")}` + (cut ? "\n" + RESULTS.definitionCut : ""));
    }
    return { output: RESULTS.textDefinitions(name, found.length) + "\n\n" + blocks.join("\n\n"),
      summary: `Definition of ${short(name)} · ${found.length === 1 ? this.shown(found[0].full) : found.length + " places"} (by text)` };
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
    // Literal, so a folder like app/[slug] isn't read as a pattern.
    const pathspec = ["--", spec && spec !== "." ? ":(literal)" + spec : "."];
    const where = target ? target.shown : (this.folder || "");
    const quiet = await quietFilters(git, top, signal);
    const hasHead = await runGit(git, top, ["rev-parse", "--verify", "--quiet", "HEAD"], signal).then(() => true, () => false);
    const fail = (/** @type {any} */ error) => { throw new ToolError(RESULTS.gitFailed(error.message)); };
    const entries = parseStatus(await runGit(git, top, ["status", "--porcelain=v1", "-z", "--untracked-files=all", ...pathspec], signal, quiet).catch(fail));
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
        const numstat = await runGit(git, top, ["diff", "--numstat", "--no-ext-diff", "--no-textconv", "-z", "HEAD", ...pathspec], signal, quiet).catch(() => "");
        for (const [file, count] of parseNumstat(numstat)) counts.set(file, count);
      }
      const lines = entries.slice(0, MAX_CHANGED).map((entry) =>
        `${this.shown(fullOf(entry.path))} · ${entry.label}${counts.has(entry.path) ? " · " + counts.get(entry.path) : ""}`);
      const diff = hasHead ? withoutSignatureLines(await runGit(git, top, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-U3", "HEAD", ...pathspec], signal, quiet).catch(() => "")) : "";
      const inline = diff.trim() && diff.length <= INLINE_DIFF_CHARS ? "\n\n" + diff.trim() : "";
      return { output: RESULTS.changedFiles(entries.length, !!inline) + "\n" + lines.join("\n")
        + (entries.length > MAX_CHANGED ? "\n" + RESULTS.changedCapped(entries.length - MAX_CHANGED) : "") + inline + tail,
        summary: `Changes · ${entries.length} file${entries.length === 1 ? "" : "s"}` };
    }
    let diff = hasHead ? withoutSignatureLines(await runGit(git, top, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-U3", "HEAD", ...pathspec], signal, quiet).catch(fail)) : "";
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
      // No language support for it: Solder's own outline of its text (PowerShell, Structured Text, batch, …), so a big
      // file still needn't be read whole.
      const own = textOutline(document.getText(), file.full);
      const lines = own ? outlineLines(own) : [];
      if (!lines.length) return { output: RESULTS.noOutline(file.shown, document.lineCount), summary: `Outline of ${file.shown} · none` };
      const first = lines.slice(0, MAX_OUTLINE);
      return { output: RESULTS.textOutlineHead(file.shown, document.lineCount) + "\n" + first.join("\n")
        + (lines.length > first.length ? "\n" + RESULTS.outlineCapped(lines.length - first.length) : ""),
        summary: `Outline of ${file.shown} · ${lines.length} entr${lines.length === 1 ? "y" : "ies"} (by text)` };
    }
    const shown = entries.slice(0, MAX_OUTLINE);
    const more = entries.length - shown.length;
    return { output: RESULTS.outlineHead(file.shown, document.lineCount) + "\n" + shown.join("\n")
      + (more > 0 ? "\n" + RESULTS.outlineCapped(more) : ""),
      summary: `Outline of ${file.shown} · ${entries.length} entr${entries.length === 1 ? "y" : "ies"}` };
  }

  /**
   * The document's symbols from VS Code's providers, giving a cold language server a few seconds. A language that
   * gave nothing after the whole wait, for a file Solder outlines by its text or a long one, isn't waited for again in
   * this window (asked once each time still, so one that starts late is used when it does).
   */
  async symbolsOf(/** @type {vscode.TextDocument} */ document) {
    const ready = this._outlined.has(document.languageId) || this._silent.has(document.languageId) || document.languageId === "plaintext";
    for (let attempt = 0; ; attempt++) {
      /** @type {any} */
      let result;
      try {
        result = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", document.uri);
      } catch { result = undefined; }
      if (Array.isArray(result) && result.length) {
        this._outlined.add(document.languageId);
        this._silent.delete(document.languageId);
        return result;
      }
      if (!ready && attempt >= OUTLINE_WAITS_MS.length && (textKind(document.uri.fsPath ?? "") || document.lineCount >= SILENT_LINES)) {
        this._silent.add(document.languageId);
      }
      if (ready || attempt >= OUTLINE_WAITS_MS.length) return [];
      await new Promise((resolve) => setTimeout(resolve, OUTLINE_WAITS_MS[attempt]));
    }
  }

  // --------------------------------------------------------------------- search --

  async search(/** @type {any} */ args, /** @type {AbortSignal} */ signal) {
    if (args.docs) return this.searchDocs(String(args.query), signal);
    const query = String(args.query);
    const filesOnly = !!args.files_only;
    /**
     * Where to look: the folder ripgrep runs in, and what it searches there ("." for all of it). With a path, that
     * file or folder only (an attached file or a paste is outside the workspace), resolved as read_file resolves it.
     * @type {{root: string, target: string}[]}
     */
    let places;
    let where = "";
    if (args.path) {
      const scope = this.resolve(args.path);
      let stat;
      try { stat = fs.statSync(scope.full); } catch { throw new ToolError(RESULTS.missing(scope.shown), await this.nearby(scope)); }
      if (!stat.isDirectory() && isOffice(scope.full)) return this.searchOffice(scope, query, !!args.regex, filesOnly);
      places = [stat.isDirectory() ? { root: scope.full, target: "." } : { root: path.dirname(scope.full), target: path.basename(scope.full) }];
      where = scope.shown;
    } else {
      places = this.searchRoots().map((root) => ({ root, target: "." }));
      if (!places.length) throw new ToolError(RESULTS.noWorkspace);
    }
    const rg = this.ripgrep();
    const base = this.base();
    const limit = filesOnly ? MAX_FOUND : MAX_SEARCH_LINES;
    /** @type {string[]} */
    let lines = [];
    let incomplete = false;
    for (const { root, target } of places) {
      const options = { target, count: filesOnly };
      const found = rg ? await this.searchWithRipgrep(rg, root, query, !!args.regex, args.glob, signal, false, options)
        : await this.searchInJs(root, query, !!args.regex, args.glob, false, options);
      if (/** @type {any} */ (found).incomplete) incomplete = true;
      // ripgrep's paths are relative to where it ran: as the model sees paths, for the other folders.
      lines.push(...(root === base || !rg || /** @type {any} */ (found).shownPaths ? found : found.map((line) => {
        const cut = line.indexOf(":");
        return cut > 0 ? this.shown(path.join(root, line.slice(0, cut))) + line.slice(cut) : line;
      })));
      if (lines.length > limit) break;
    }
    const count = lines.length;
    if (!count) {
      return { output: RESULTS.noMatches(query, [where, args.glob].filter(Boolean).join(", ")), summary: `Searched "${short(query)}" · no matches` };
    }
    let note = incomplete ? "\n\n" + RESULTS.searchIncomplete(SEARCH_MS / 1000) : "";
    if (filesOnly) {
      // Each file once, with how many of its lines match: path (N).
      const files = lines.map((line) => { const cut = line.lastIndexOf(":"); return `${line.slice(0, cut)} (${line.slice(cut + 1)})`; })
        .sort((a, b) => a.localeCompare(b));
      return { output: files.slice(0, MAX_FOUND).join("\n") + (count > MAX_FOUND ? "\n\n" + RESULTS.filesCapped(MAX_FOUND) : "") + note,
        summary: `Searched "${short(query)}" · ${count > MAX_FOUND ? MAX_FOUND + "+" : count} file${count === 1 ? "" : "s"}` };
    }
    // With the lines around each match: read from the files as the editor has them (unsaved changes included).
    const around = Math.min(5, Math.max(0, Math.round(Number(args.context_lines) || 0)));
    if (around) {
      const shown = withContext(lines.slice(0, MAX_SEARCH_LINES), (file) => {
        try {
          const full = this.resolve(file).full;
          const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath.toLowerCase() === full.toLowerCase());
          const text = open ? open.getText() : decodeText(fs.readFileSync(full));
          return text === null ? null : text.split(/\r\n|\r|\n/);
        } catch { return null; }
      }, around, MAX_SEARCH_LINES);
      return { output: shown + (count > MAX_SEARCH_LINES ? "\n\n" + RESULTS.searchCapped(MAX_SEARCH_LINES) : "") + note,
        summary: `Searched "${short(query)}" · ${count > MAX_SEARCH_LINES ? MAX_SEARCH_LINES + "+" : count} matches, with the lines around them` };
    }
    if (count > MAX_SEARCH_LINES) {
      lines = lines.slice(0, MAX_SEARCH_LINES);
      note += "\n\n" + RESULTS.searchCapped(MAX_SEARCH_LINES);
    }
    return { output: lines.join("\n") + note, summary: `Searched "${short(query)}" · ${count > MAX_SEARCH_LINES ? MAX_SEARCH_LINES + "+" : count} lines` };
  }

  // ----------------------------------------------------------------------- docs --

  /** The docs folders from the user's settings that exist: [{path, about}]. */
  docsFolders() {
    const raw = solderSettings().get("docsFolders", []);
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
    const model = this.semantic();
    let meaning = null;
    if (model) {
      try {
        const budget = this.embedBudget();
        meaning = { model, ...index.vectorCount(model), tokens: index.embedding.tokens, error: index.embedding.error, waiting: index.embedding.waiting ?? null,
          held: this.embedState().held, pacing: !!index.embedding.pacing,
          paused: !!index.embedding.paused, free: this.embedFree(), shared: this.embedCache()?.folder || "", reused: index.embedding.reused, given: index.embedding.given,
          sharedProblem: index.embedding.sharedProblem, today: budget.used(), budget: budget.allowed(this.embedBudgetSetting()), raised: budget.raisedToday() !== undefined };
      } catch { meaning = null; }
    }
    return { available: true, folders, indexed, active: !!index.active, meaning };
  }

  /** The docs index (opened on first use), or null when this VS Code's runtime has no SQLite. */
  docsIndex() {
    if (this._docs === undefined) {
      this._docs = docsAvailable() ? new DocsIndex(path.join(this.context.globalStorageUri.fsPath, "docs", "docs.sqlite")) : null;
    }
    return this._docs;
  }

  /** Today's embedding count and budget (a small file beside the index). */
  embedBudget() {
    this._budget ??= new EmbedBudget(path.join(this.context.globalStorageUri.fsPath, "docs", "embed-budget.json"));
    return this._budget;
  }

  /**
   * The shared embeddings folder (the embeddingsCache setting, or your organization's), or null when there's none: a
   * full path, a network share as a rule. Vectors only are read from it and written to it.
   */
  embedCache() {
    const given = String(solderSettings().get("embeddingsCache", "") || "").trim().replace(/^~(?=$|[\\/])/, os.homedir());
    if (!given || !path.isAbsolute(given)) return null;
    const folder = path.resolve(given);
    if (this._embedCache?.folder !== folder) this._embedCache = new EmbedCache(folder);
    return this._embedCache;
  }

  /** The daily embedding budget's setting (your organization's, if it sets one), in tokens. */
  embedBudgetSetting() {
    const value = Number(solderSettings().get("embedDailyBudget", 250_000));
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 250_000;
  }

  /** The embedding rate's setting (your organization's, if it sets one): tokens a minute, 0 for no limit. */
  embedRateSetting() {
    const value = Number(solderSettings().get("embedTokensPerMinute", 250_000));
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 250_000;
  }

  /** A gateway on this PC (a local embeddings server) is free: neither counted nor held to the budget. */
  embedFree() {
    try { return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(String(solderSettings().get("endpoint", ""))).hostname); } catch { return false; }
  }

  /** Raise today's budget by another day's worth, until midnight UTC (Settings → Docs / RAG), and carry on embedding. */
  raiseEmbedBudget() {
    const budget = this.embedBudget();
    budget.raiseToday(budget.allowed(this.embedBudgetSetting()) + Math.max(this.embedBudgetSetting(), 50_000));
    this.refreshDocs();
  }

  /**
   * Bring the docs index up to date in the background (on start, and when the folders change). Big
   * folders take a while the first time; searches meanwhile say the index is still being built.
   */
  async refreshDocs() {
    const index = this.docsIndex();
    if (!index) return;
    const folders = this.docsFolders().map((folder) => folder.path);
    const model = this.semantic();
    // What this run is for. A run started for something else (a folder since removed, search by meaning since turned
    // off, another model, gateway or shared folder) is stopped at once: it sends nothing more of what was withdrawn.
    const held = this.embedState().held;
    const mark = JSON.stringify([folders, model, this.embedCache()?.folder || "", String(solderSettings().get("endpoint", "") || ""), held, this.embedState().agreed]);
    if (index.active) {
      if (this._docsRun && this._docsRun.mark !== mark) this._docsRun.controller.abort();
      // Again after it, once however often that's asked meanwhile.
      if (!this._docsAgain) {
        this._docsAgain = true;
        index.active.catch(() => {}).finally(() => { this._docsAgain = false; this.refreshDocs(); });
      }
      return;
    }
    const controller = new AbortController();
    this._docsRun = { mark, controller };
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: model ? "Solder: indexing docs, with meaning" : "Solder: indexing docs" },
      (progress) => {
        // The status bar counts the passages as they get their vectors; the log has a line every 320 or so.
        let logged = 0;
        const embed = model && this.embedder && !held ? { model, cache: this.embedCache(),
          fn: (/** @type {string[]} */ texts, /** @type {AbortSignal | undefined} */ signal) => this.embedder(model, texts, signal),
          confirm: (/** @type {number} */ passages, /** @type {number} */ tokens) => this.confirmEmbedding(model, passages, tokens),
          // Held to today's embedding budget (a gateway on this PC is free, and isn't).
          left: () => this.embedFree() ? Infinity : this.embedBudget().left(this.embedBudgetSetting()),
          spend: (/** @type {number} */ tokens) => { if (!this.embedFree()) this.embedBudget().spend(tokens); },
          // Paced to the gateway's tokens a minute (a gateway on this PC has no such limit).
          perMinute: () => this.embedFree() ? 0 : this.embedRateSetting(),
          onBatch: () => {
            const { passages, embedded } = index.vectorCount(model);
            progress?.report({ message: `${embedded.toLocaleString("en-US")} of ${passages.toLocaleString("en-US")} passages` });
            if (index.embedding.done - logged >= 320) {
              logged = index.embedding.done;
              this.onDocsLog?.(`docs embeddings: ${embedded.toLocaleString("en-US")} of ${passages.toLocaleString("en-US")} passages · ${index.embedding.runTokens.toLocaleString("en-US")} tokens so far this run`);
            }
          } } : undefined;
        return index.refresh(folders, { ms: 30 * 60_000, embed, signal: controller.signal });
      }).then((/** @type {any} */ result) => {
        if (result?.unread) this.onDocsLog?.(`docs index: ${result.unread.toLocaleString("en-US")} file${result.unread === 1 ? "" : "s"} couldn't be read this time (in use, or the folder didn't answer): kept as indexed, tried again next time`);
      }, () => {});
    if (this._docsRun?.controller === controller) this._docsRun = null;
    const embed = model && this.embedder && !held;
    if (embed) {
      // The big run that was started is done: the next big one (a new folder, another model) waits for you again.
      try {
        const now = index.vectorCount(model);
        if (now.embedded >= now.passages && this.embedState().agreed) this.setEmbedState({ agreed: "" });
      } catch { /* the index is closed */ }
    }
    if (embed) {
      // What it cost, for the log (Copy diagnostics): the gateway's own token count.
      const counts = index.vectorCount(model);
      this.onDocsLog?.(`docs embeddings: ${index.embedding.runTokens.toLocaleString("en-US")} tokens this run · ${counts.embedded.toLocaleString("en-US")} of ${counts.passages.toLocaleString("en-US")} passages` +
        (index.embedding.reused || index.embedding.given ? ` · shared folder: ${index.embedding.reused.toLocaleString("en-US")} passages taken, ${index.embedding.given.toLocaleString("en-US")} given` : "") +
        (index.embedding.sharedProblem ? ` · shared folder not used: ${index.embedding.sharedProblem}` : "") +
        (index.embedding.error ? ` · stopped: ${index.embedding.error}` : ""));
    }
  }

  /**
   * Embedding's two switches, kept across restarts in a small file beside the index: `held` (you pressed Stop:
   * nothing is embedded until you press Start) and `agreed` (the embeddings model whose big run you started: it
   * carries on over as many days as the budget takes, without asking again, until it's done).
   * @returns {{held: boolean, agreed: string}}
   */
  embedState() {
    if (!this._embedState) {
      let saved = {};
      try { saved = JSON.parse(fs.readFileSync(this.embedStateFile(), "utf8")) || {}; } catch { saved = {}; }
      this._embedState = { held: saved.held === true, agreed: typeof saved.agreed === "string" ? saved.agreed : "" };
    }
    return this._embedState;
  }

  embedStateFile() {
    return path.join(this.context.globalStorageUri.fsPath, "docs", "embed-state.json");
  }

  /** @param {{held?: boolean, agreed?: string}} change */
  setEmbedState(change) {
    Object.assign(this.embedState(), change);
    try {
      fs.mkdirSync(path.dirname(this.embedStateFile()), { recursive: true });
      fs.writeFileSync(this.embedStateFile(), JSON.stringify(this._embedState), "utf8");
    } catch { /* kept for this session */ }
  }

  /** Start (Settings → Docs / RAG): embedding goes ahead, a big run included, from now until it's done or you stop it. */
  startEmbedding() {
    this.setEmbedState({ held: false, agreed: this.semantic() });
    const index = this.docsIndex();
    if (index) index.embedding.waiting = null;
    this.refreshDocs();
  }

  /** Stop: the run in progress ends where it is (what it embedded is kept), and nothing more is sent until Start. */
  stopEmbedding() {
    this.setEmbedState({ held: true });
    this._docsRun?.controller.abort();
    this.refreshDocs(); // the keyword index carries on
  }

  /**
   * A big embedding run (a first build, a new model, many new files) waits for you: it can use a real share of a day's
   * allowance. It isn't asked about in a notification that goes away; Settings → Docs / RAG shows what's waiting, with
   * Start, for as long as it waits. You're told once a session that it's there.
   * @param {string} model @param {number} passages @param {number} tokens
   */
  async confirmEmbedding(model, passages, tokens) {
    if (this.embedState().agreed === model) return true;
    if (this.embedToldFor !== model) {
      this.embedToldFor = model;
      this.onEmbedWaiting?.(passages, tokens);
    }
    return false;
  }

  /** The embeddings model when docs search by meaning is on (Settings → Your docs), else "". */
  semantic() {
    const config = solderSettings();
    return config.get("docsSearch", "keyword") === "hybrid" ? String(config.get("embeddingModel", "")).trim() : "";
  }

  /** The best passages in the docs for a query; a short catch-up of the index first (up to 4 s). */
  async searchDocs(/** @type {string} */ query, /** @type {AbortSignal} */ signal) {
    const folders = this.docsFolders();
    if (!folders.length) throw new ToolError(RESULTS.docsNone);
    const index = this.docsIndex();
    if (!index) throw new ToolError(RESULTS.docsUnavailable);
    const roots = folders.map((folder) => folder.path);
    index.setRoots(roots);
    const stale = roots.some((root) => Date.now() - index.walkedAt(root) > 2 * 60_000);
    const state = index.active ? { files: index.count(), unfinished: true, truncated: false }
      : stale ? await index.refresh(roots, { ms: 4000, signal }) : { files: index.count(), unfinished: false, truncated: false };
    // By meaning too, once there are vectors: the query's own vector (one small request), merged with the keyword ranking.
    let meaning = null;
    const model = this.semantic();
    const counts = model && this.embedder ? index.vectorCount(model) : null;
    // Passages without vectors (a file changed or was added since the last run): the background run makes them
    // now, so the next search has them. This one goes on with what's there; keywords find the new text already.
    if (counts && counts.embedded < counts.passages && !index.active) setTimeout(() => this.refreshDocs(), 0);
    if (counts && counts.embedded) {
      try {
        const { vectors, tokens } = await this.embedder(model, [query], AbortSignal.any([signal, AbortSignal.timeout(20_000)]));
        // How near a passage must be to count: Solder's own floor, or yours.
        meaning = { vector: vectors[0], model, floor: meaningFloor(solderSettings().get("meaningFloor", 0)) };
        // Counted, but a search is never held back by the budget. A gateway that gives no count: about four characters
        // a token, as the docs index estimates it.
        if (!this.embedFree()) this.embedBudget().spend(Number(tokens) > 0 ? Number(tokens) : Math.ceil(query.length / 4));
        this.onDocsLog?.(`docs search by meaning · ${tokens} tokens`);
      } catch (error) {
        if (signal.aborted) throw error;
        this.onDocsLog?.(`docs search by meaning failed, keywords only: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const hits = await index.search(query, undefined, meaning);
    // What the best match scored, for tuning the floor by; nothing near enough means the keywords alone answered.
    const near = meaning ? index.lastNearest : null;
    if (near) this.onDocsLog?.(near.kept ? `docs search by meaning · best similarity ${near.best.toFixed(3)} · ${near.kept} at or above the floor (${near.floor})`
      : `docs search by meaning · best similarity ${near.best.toFixed(3)}, below the floor (${near.floor}): keywords only`);
    if (near && !near.kept) meaning = null;
    const notes = [state.unfinished ? RESULTS.docsBuilding(state.files) : "", state.truncated ? RESULTS.docsTruncated : ""].filter(Boolean);
    if (!hits.length) return { output: [RESULTS.docsNoMatches(query), ...notes].join("\n\n"), summary: `Searched docs for "${short(query)}" · no matches` };
    const vague = meaning ? null : loose(hits, query);
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

  /**
   * A Word, Excel or PowerPoint file given as search's path: its text as read_file and the docs index read it, so the
   * line numbers fit read_file's. @param {any} file @param {string} query @param {boolean} regex @param {boolean} filesOnly
   */
  async searchOffice(file, query, regex, filesOnly) {
    const text = await documentText(file.full).catch(() => null);
    if (text === null) throw new ToolError(RESULTS.notText(file.shown));
    const lines = await this.searchInJs(path.dirname(file.full), query, regex, undefined, false, { count: filesOnly, text: { file: file.full, text } });
    if (!lines.length) return { output: RESULTS.noMatches(query, file.shown), summary: `Searched "${short(query)}" · no matches` };
    if (filesOnly) {
      const cut = lines[0].lastIndexOf(":");
      return { output: `${lines[0].slice(0, cut)} (${lines[0].slice(cut + 1)})`, summary: `Searched "${short(query)}" · 1 file` };
    }
    const more = lines.length > MAX_SEARCH_LINES;
    return { output: lines.slice(0, MAX_SEARCH_LINES).join("\n") + (more ? "\n\n" + RESULTS.searchCapped(MAX_SEARCH_LINES) : ""),
      summary: `Searched "${short(query)}" · ${more ? MAX_SEARCH_LINES + "+" : lines.length} lines` };
  }

  /**
   * @param {{target?: string, count?: boolean}} [options] what to search in root ("." for all of it, else one file
   * there), and whether to count each file's matching lines (path:count) instead of listing them
   * @returns {Promise<string[]>}
   */
  searchWithRipgrep(/** @type {string} */ rg, /** @type {string} */ root, /** @type {string} */ query,
    /** @type {boolean} */ regex, /** @type {string | undefined} */ glob, /** @type {AbortSignal} */ signal, caseSensitive = false, options = {}) {
    const target = options.target || ".";
    const one = target !== ".";
    const args = ["--line-number", "--no-heading", "--with-filename", "--color", "never", caseSensitive ? "--case-sensitive" : "--smart-case", "--max-columns", "300",
      "--max-columns-preview", "--no-messages"];
    // A file asked for by name is searched whatever its size, and as far as the line limit (a long log); in a folder,
    // big files are skipped and each file gives at most 50 lines, so one can't crowd out the rest. A count counts all.
    if (!one) args.push("--max-filesize", "5M");
    if (options.count) args.push("--count");
    else args.push("--max-count", one ? String(MAX_SEARCH_LINES + 1) : "50");
    if (!regex) args.push("--fixed-strings");
    // As find_files reads a glob: any case, backslashes as slashes, and a folder (or "folder/") as everything in it.
    if (glob && !one) args.push("--glob-case-insensitive", "--glob", rgGlob(root, String(glob)));
    // Paths printed with "/" (only the paths: a matched line's own backslashes are its text, kept as they are).
    args.push("--path-separator", "/", "--regexp", query, "--", target);
    return new Promise((resolve, reject) => {
      const child = spawn(rg, args, { cwd: root, windowsHide: true, signal });
      let out = "";
      let errors = "";
      let timedOut = false;
      // Whether the spawn failed and the fallback search gives the answer (close then comes too, with nothing).
      let fallingBack = false;
      // A character split between two chunks is decoded whole.
      const outText = new StringDecoder("utf8");
      const errorText = new StringDecoder("utf8");
      child.stdout.on("data", (chunk) => { if (out.length < 2_000_000) out += outText.write(chunk); });
      child.stderr.on("data", (chunk) => { errors += errorText.write(chunk); });
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, SEARCH_MS);
      child.on("error", (error) => {
        clearTimeout(timer);
        fallingBack = true;
        if (signal.aborted) { reject(new ToolError(RESULTS.stopped)); return; }
        this._rg = null; // blocked or missing: fall back from now on
        this.searchInJs(root, query, regex, glob, caseSensitive, options).then((lines) => { /** @type {any} */ (lines).shownPaths = true; resolve(lines); }, reject);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (fallingBack) return;
        if (out.length < 2_000_000) out += outText.end();
        errors += errorText.end();
        if (code === 2 && !out) {
          const lines = errors.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
          // ripgrep explains a bad pattern on the lines after "regex parse error:"; keep the explanation.
          if (/regex parse error/i.test(errors)) { reject(new ToolError(RESULTS.badRegex + (lines.length > 1 ? ` (${lines[lines.length - 1].replace(/^error:\s*/i, "")})` : ""))); return; }
          reject(new ToolError(lines[0] || RESULTS.searchFailed));
          return;
        }
        // Stopped at the time limit: what it found so far isn't the whole answer, and nothing found isn't "none".
        if (timedOut && !out.trim()) { reject(new ToolError(RESULTS.searchTimedOut(SEARCH_MS / 1000))); return; }
        const lines = out.split(/\r?\n/).filter(Boolean).map((line) => line.replace(/^\.[\\/]/, ""));
        const shown = !options.count && lines.some((line) => line.endsWith(RG_OMITTED)) ? aroundLongMatches(lines, root, query, regex, caseSensitive) : lines;
        if (timedOut) /** @type {any} */ (shown).incomplete = true;
        resolve(shown);
      });
    });
  }

  /**
   * The search with no ripgrep. Paths come out as the model sees them.
   * @param {{target?: string, count?: boolean, text?: {file: string, text: string}}} [options] as searchWithRipgrep's;
   * text: search this text, as this file's, instead of reading files
   * @returns {Promise<string[]>}
   */
  async searchInJs(/** @type {string} */ root, /** @type {string} */ query, /** @type {boolean} */ regex,
    /** @type {string | undefined} */ glob, caseSensitive = false, options = {}) {
    let pattern;
    const flags = caseSensitive || /[A-Z]/.test(query) ? "" : "i";
    try {
      pattern = regex ? new RegExp(query, flags) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    } catch (error) {
      throw new ToolError(RESULTS.badRegex);
    }
    const one = options.text ? options.text.file : options.target && options.target !== "." ? path.join(root, options.target) : "";
    const files = one ? [{ fsPath: one }] : await this.listFiles(root, globOf(glob ? rgGlob(root, glob) : "**/*"), 5000);
    const lines = [];
    for (const uri of files) {
      /** @type {string | null} */
      let text;
      if (options.text) text = options.text.text;
      else {
        try {
          // A file asked for by name is read whatever its size (up to read_file's limit), in its own encoding.
          if (fs.statSync(uri.fsPath).size > (one ? 20 * 1024 * 1024 : 1_000_000)) continue;
          text = one ? decodeText(fs.readFileSync(uri.fsPath)) : fs.readFileSync(uri.fsPath, "utf8");
        } catch { continue; }
        if (text === null || text.includes("\u0000")) continue;
      }
      const shown = this.shown(uri.fsPath);
      if (options.count) {
        const matching = text.split(/\r\n|\r|\n/).filter((line) => pattern.test(line)).length;
        if (matching) lines.push(`${shown}:${matching}`);
        if (lines.length > MAX_FOUND) break;
        continue;
      }
      text.split(/\r\n|\r|\n/).forEach((line, index) => {
        if (lines.length <= MAX_SEARCH_LINES && pattern.test(line)) lines.push(`${shown}:${index + 1}:${line.length > 300 ? around(line, pattern) : line}`);
      });
      if (lines.length > MAX_SEARCH_LINES) break;
    }
    return lines;
  }

  // ----------------------------------------------------------------- find_files --

  /**
   * Files under `root` matching a glob, regardless of case. VS Code's file search first (it knows files.exclude);
   * when it finds nothing, a direct walk of the folder (bounded), since on some network shares it came back empty
   * for files that were there. @param {string} root @param {string} glob @param {number} max
   * @returns {Promise<{fsPath: string}[]>}
   */
  async listFiles(root, glob, max) {
    let found = [];
    try { found = await vscode.workspace.findFiles(new vscode.RelativePattern(root, caseless(glob)), undefined, max); } catch { /* walk instead */ }
    if (found.length) return found;
    return walkFiles(root, globPattern(glob), max).map((fsPath) => ({ fsPath }));
  }

  async findFiles(/** @type {any} */ args) {
    const roots = this.searchRoots();
    if (!roots.length) throw new ToolError(RESULTS.noWorkspace);
    const find = async (/** @type {string} */ glob) => {
      const uris = [];
      for (const root of roots) {
        uris.push(...await this.listFiles(root, glob, MAX_FOUND + 1));
        if (uris.length > MAX_FOUND) break;
      }
      return uris;
    };
    let uris = await find(globOf(String(args.glob)));
    // A plain name ("lib") with no files of that name: the folder of that name, if there is one.
    if (!uris.length && !/[*?[\]{}]/.test(String(args.glob))) {
      uris = await find(globOf(String(args.glob)).replace(/\/+$/, "") + "/**");
    }
    const shown = uris.map((uri) => this.shown(uri.fsPath)).sort((a, b) => a.localeCompare(b));
    if (!shown.length) return { output: RESULTS.noFiles(args.glob), summary: `Found no ${args.glob}` };
    const more = shown.length > MAX_FOUND;
    return { output: shown.slice(0, MAX_FOUND).join("\n") + (more ? "\n\n" + RESULTS.filesCapped(MAX_FOUND) : ""),
      summary: `Found ${more ? MAX_FOUND + "+" : shown.length} file${shown.length === 1 ? "" : "s"} · ${args.glob}` };
  }

  // ------------------------------------------------------------------ edit_file --

  /**
   * @param {any} args @param {any} chat
   * @param {{group: string, more: boolean}} [hint] the reply this edit is in, and whether it edits this file again later
   * (then the problems check waits for that last edit, against the file as it was before the first)
   */
  async editFile(args, chat, hint) {
    const { file, document, text, old, found } = await this.plannedEdit(args);
    // A folder with rules the model hadn't seen when it wrote this: they come back, and the edit waits for its next call.
    const rules = this.rulesFirst(file, chat);
    if (rules) return rules;
    const { start, length, replaced } = found;
    const shiftNote = found.note;
    const before = this.baseline(file, hint);
    const backup = await this.backup(chat, file, text);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(file.uri, new vscode.Range(document.positionAt(start), document.positionAt(start + length)), replaced);
    if (!await vscode.workspace.applyEdit(edit)) throw new ToolError(RESULTS.notApplied(file.shown));
    await saveOrRevert(document, file, text);
    // Solder's version is what was saved (a format-on-save included), taken now: typing while the problems check
    // waits below is yours, and Undo then asks rather than throwing it away.
    const after = hash(document.getText());
    const removed = lineCount(old);
    const added = lineCount(replaced);
    const problems = await this.problemsAfter(file, before, hint, chat, String(args.path));
    const result = this._edited(file, after, text, backup, removed, added, start, shiftNote, problems);
    // Every place at once (replace_all): how many, and where, in place of the one range.
    if (found.places) {
      result.output = RESULTS.editedAll(file.shown, found.places.length, found.places.slice(0, 12)) + problems.text + (SIGNED.test(text) ? "\n" + RESULTS.signatureBroken : "");
      result.summary = `Edited ${file.shown} · ${found.places.length} place${found.places.length === 1 ? "" : "s"}` + problems.summary;
    }
    return result;
  }

  /**
   * Where an edit would go and what it would put there, worked out exactly as the edit works it out (it is the edit's
   * own first half): so what a preview shows before you allow a change is what the change then does. Throws what the
   * edit would (no such file, old_text not found or found more than once).
   * @param {any} args
   */
  async plannedEdit(args) {
    const file = this.resolve(args.path);
    await this.mustBeFile(file);
    const document = await vscode.workspace.openTextDocument(file.uri);
    await freshen(document, file);
    const text = document.getText();
    const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    return { file, document, text, eol, ...planEdit(file.shown, text, args, eol) };
  }

  /** An edit's result, once it's made. */
  _edited(/** @type {any} */ file, /** @type {string} */ after, /** @type {string} */ text, /** @type {string} */ backup, /** @type {number} */ removed, /** @type {number} */ added,
    /** @type {number} */ start, /** @type {string} */ shiftNote, /** @type {{text: string, summary: string}} */ problems) {
    return { output: RESULTS.edited(file.shown, removed, added, lineOf(text, start)) + shiftNote + problems.text + (SIGNED.test(text) ? "\n" + RESULTS.signatureBroken : ""),
      summary: `Edited ${file.shown} · −${removed} +${added}` + problems.summary,
      change: { path: file.full, shown: file.shown, backup, created: false, after } };
  }

  // ----------------------------------------------------------------- write_file --

  /** @param {any} args @param {any} chat @param {{group: string, more: boolean}} [hint] as editFile's */
  async writeFile(args, chat, hint) {
    const file = this.resolve(args.path);
    const content = String(args.content);
    let exists = false;
    try {
      const stat = await vscode.workspace.fs.stat(file.uri);
      if (stat.type & vscode.FileType.Directory) throw new ToolError(RESULTS.isFolder(file.shown));
      exists = true;
    } catch (error) {
      if (error instanceof ToolError) throw error;
      // Only a file that's surely not there is a new one: any other failure (a share that didn't answer) might be
      // hiding one, which would then be overwritten with no backup, and Undo would remove it.
      if (!notFoundError(error)) throw new ToolError(RESULTS.notWritable(file.shown));
    }
    const open = vscode.workspace.textDocuments.find((doc) => doc.uri.scheme === "file" && doc.uri.fsPath.toLowerCase() === file.full.toLowerCase());
    // VS Code's copy made the disk's first (as an edit does): the backup, and the "unchanged" check, are of what's there.
    if (open) await freshen(open, file);
    // #5: a file that isn't open is read as its encoding says (UTF-16 included), so its backup is its text.
    const raw = exists && !open ? fs.readFileSync(file.full) : null;
    const previous = exists ? (open ? open.getText() : decodeText(/** @type {Buffer} */ (raw))) : "";
    if (previous === null) throw new ToolError(RESULTS.notText(file.shown)); // a binary file: no text to keep for Undo
    if (exists && hash(previous) === hash(content)) return { output: RESULTS.sameContent(file.shown), summary: `${file.shown} · unchanged` };
    const rules = this.rulesFirst(file, chat); // as an edit's
    if (rules) return rules;
    const backup = exists ? await this.backup(chat, file, previous) : "";
    // A new file had no problems before: every one it has is this change's.
    const before = this.baseline(file, hint, !exists);
    const madeFolder = exists ? "" : firstMissing(path.dirname(file.full));
    /** @type {Buffer | null} what went to disk, for a file that wasn't open */
    let written = null;
    /** @type {string} Solder's version, taken as soon as it's saved (typing during the problems check is yours) */
    let after;
    if (open) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(file.uri, new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length)), toEol(content, open.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n"));
      if (!await vscode.workspace.applyEdit(edit)) throw new ToolError(RESULTS.notApplied(file.shown));
      await saveOrRevert(open, file, previous);
      after = hash(open.getText());
    } else {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(file.full)));
      // A file that's there keeps its encoding (a UTF-8 BOM, which Windows PowerShell 5.1 needs for non-ASCII text, or
      // UTF-16) and its line endings; a new one is UTF-8 as written.
      written = raw ? encodedLike(raw, previous, content) : Buffer.from(content, "utf8");
      try { await vscode.workspace.fs.writeFile(file.uri, written); }
      catch { throw new ToolError(RESULTS.notWritable(file.shown)); }
      after = hash(String(decodeText(written)));
      await vscode.workspace.openTextDocument(file.uri).then(() => {}, () => {}); // lets language servers look
    }
    const lines = lineCount(content);
    const problems = await this.problemsAfter(file, before, hint, chat, String(args.path));
    return { output: RESULTS.written(exists, file.shown, lines) + problems.text + (exists && SIGNED.test(previous) ? "\n" + RESULTS.signatureBroken : ""),
      summary: `${exists ? "Wrote" : "Created"} ${file.shown} · ${lines} lines` + problems.summary,
      change: { path: file.full, shown: file.shown, backup, created: !exists, madeFolder, after } };
  }

  // ------------------------------------------------------------------- problems --

  async problems(/** @type {any} */ args) {
    /** @type {any[]} */
    let list;
    if (args.path) {
      const file = this.resolve(args.path);
      await this.mustBeFile(file);
      // VS Code only checks open files, and some language servers (TypeScript's among them) only ones in a tab.
      // A file that isn't in one is opened in a background tab, which takes neither the view nor the cursor,
      // checked, and closed again.
      const wasOpen = shownInEditor(file.full);
      const doc = await vscode.workspace.openTextDocument(file.uri).then((d) => d, () => null);
      const reports = !!doc && this._diagnosed.has(doc.languageId);
      const waiting = this.diagnosticsFor(file, wasOpen ? PROBLEMS_WAIT_MS : reports ? PROBLEMS_COLD_MS : PROBLEMS_UNKNOWN_MS);
      const tab = wasOpen || !doc ? null : await openInBackground(file);
      const heard = await waiting;
      list = [[file.uri, vscode.languages.getDiagnostics(file.uri)]];
      if (tab) await closeTab(file);
      // A clean file reports nothing (VS Code says nothing when an empty list stays empty), so silence is
      // "no problems" only where this kind of file does get checked.
      if (!wasOpen && !heard && !list[0][1].length) {
        if (!tab) return { output: RESULTS.notChecked(file.shown), summary: `Problems · ${file.shown} not checked` };
        if (!this._diagnosed.has(doc.languageId)) return { output: RESULTS.notReported(file.shown), summary: `Problems · ${file.shown} maybe not checked` };
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

  /**
   * The problems checks still waiting from this reply (its later edit to the file failed or didn't run).
   * @param {string} group @returns {Promise<{path: string, text: string, summary: string}[]>}
   */
  async settleEdits(group) {
    const waiting = [...this._pendingProblems].filter(([, pending]) => pending.group === group);
    for (const [key] of waiting) this._pendingProblems.delete(key);
    const found = await this.checkChanged(waiting.map(([, pending]) => pending));
    return found.map((problems, index) => ({ path: waiting[index][1].given, ...problems })).filter((problems) => problems.text);
  }

  /**
   * A file's problems before a change, to tell the change's own errors from older ones: taken before the reply's
   * first change to it (a later change in the same reply keeps that). `checked` says whether they're worth comparing
   * with: the file was in a tab (where language servers check it), had problems reported, or is new.
   * @param {any} file @param {{group: string, more: boolean}} [hint] @param {boolean} [created] a new file
   * @returns {{keys: Set<string>, checked: boolean}}
   */
  baseline(file, hint, created = false) {
    const waiting = hint && this._pendingProblems.get(file.full.toLowerCase());
    if (waiting && waiting.group === hint.group) return waiting.before;
    if (created) return { keys: new Set(), checked: true };
    const keys = problemKeys(file.uri);
    return { keys, checked: keys.size > 0 || shownInEditor(file.full) };
  }

  /**
   * After a change: its problems check now, or, when the reply changes more files (hint.more), kept for settleEdits,
   * which checks them all together at the end. @param {any} file @param {{keys: Set<string>, checked: boolean}} before
   * @param {{group: string, more: boolean} | undefined} hint @param {any} chat @param {string} given the path as the model gave it
   * @returns {Promise<{text: string, summary: string}>}
   */
  async problemsAfter(file, before, hint, chat, given) {
    const key = file.full.toLowerCase();
    const pending = { group: hint?.group ?? "", before, file, given, task: taskOf(chat) };
    if (hint?.more) { this._pendingProblems.set(key, pending); return { text: "", summary: "" }; }
    this._pendingProblems.delete(key);
    return (await this.checkChanged([pending]))[0];
  }

  /**
   * Changed files' errors, checked all at once (each waits on its own language server). VS Code checks only open
   * files, and some language servers (TypeScript's) only those in a tab: a changed file that isn't in one is opened
   * in a background tab as problems does, up to MAX_CHECK_TABS at a time, and closed again whatever happens.
   * @param {{file: any, before: {keys: Set<string>, checked: boolean}, task: string}[]} entries
   * @returns {Promise<{text: string, summary: string}[]>}
   */
  async checkChanged(entries) {
    let tabs = 0;
    const plans = entries.map((entry) => {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath.toLowerCase() === entry.file.full.toLowerCase());
      const language = doc?.languageId ?? "";
      const reports = this._diagnosed.has(language);
      // Only where something may check it: plain text gets no tab.
      const tab = !!doc && language !== "plaintext" && (reports || CODE_FILE.test(entry.file.full) || NEEDS_EXTENSION.test(entry.file.full))
        && tabs < MAX_CHECK_TABS && !shownInEditor(entry.file.full);
      if (tab) tabs++;
      // A language that has never reported diagnostics (Markdown) isn't worth the full wait; a file opened for the
      // check gives its language server time to start.
      const ms = tab ? (reports ? PROBLEMS_COLD_MS : PROBLEMS_UNKNOWN_MS) : reports ? DIAGNOSTICS_WAIT_MS : DIAGNOSTICS_SHORT_MS;
      return { ...entry, language, tab, ms };
    });
    // Listening first, then the tabs: problems reported as a tab opens aren't missed.
    const heard = plans.map((plan) => this.diagnosticsFor(plan.file, plan.ms));
    /** @type {any[]} */
    const opened = [];
    try {
      for (const plan of plans) if (plan.tab && await openInBackground(plan.file)) opened.push(plan.file);
      const changed = await Promise.all(heard);
      // Read before the tabs close (a closed file's problems may be cleared).
      return plans.map((plan, index) => this.errorsAfter(plan, changed[index]));
    } finally {
      for (const file of opened) await closeTab(file);
    }
  }

  /**
   * A changed file's errors the change brought (all of them, said so, when it wasn't checked before); or, where
   * nothing has ever reported problems in its kind of file, that it wasn't checked, so silence isn't read as none.
   * @param {{file: any, before: {keys: Set<string>, checked: boolean}, task: string, language: string}} plan
   * @param {boolean} heard whether its problems changed during the check
   */
  errorsAfter(plan, heard) {
    const { file, before } = plan;
    const fresh = vscode.languages.getDiagnostics(file.uri)
      .filter((d) => d.severity === vscode.DiagnosticSeverity.Error && !before.keys.has(keyOf(d)));
    if (fresh.length) {
      const lines = fresh.slice(0, 10).map((d) => `- line ${d.range.start.line + 1}: ${d.message.split("\n")[0]}` + (d.source ? ` (${d.source})` : ""));
      const count = `${fresh.length}${before.checked ? " new" : ""} problem${fresh.length === 1 ? "" : "s"}`;
      return { text: (before.checked ? RESULTS.newProblems : RESULTS.problemsNow)(file.shown, lines, fresh.length - 10), summary: ` · ${count}` };
    }
    // Code only an extension checks, in a kind nothing has reported on: once a task for each file.
    if (heard || this._diagnosed.has(plan.language) || !NEEDS_EXTENSION.test(file.full)) return { text: "", summary: "" };
    const noted = `${plan.task}|${file.full.toLowerCase()}`;
    if (this._notChecked.has(noted)) return { text: "", summary: "" };
    if (this._notChecked.size > 1000) this._notChecked.clear();
    this._notChecked.add(noted);
    return { text: RESULTS.changeNotChecked(file.shown), summary: " · not checked for errors" };
  }

  // -------------------------------------------------------------- undo / review --

  /** Keep the file's text from before a change. @returns {Promise<string>} the backup's path */
  async backup(/** @type {any} */ chat, /** @type {any} */ file, /** @type {string} */ text) {
    const folder = path.join(this.backupsRoot(), chat.id);
    this.pruneSoon();
    fs.mkdirSync(folder, { recursive: true });
    // Made only if no file has that name ("wx"): two files of the same name never share one backup.
    for (;;) {
      const target = backupPath(folder, file.full);
      try { fs.writeFileSync(target, text, { encoding: "utf8", flag: "wx" }); return target; }
      catch (error) { if (/** @type {any} */ (error).code !== "EEXIST") throw error; }
    }
  }

  // ------------------------------------------------------------------ move_item --

  /** Move, rename or copy a file or folder; never overwrites. Undo moves it back, or removes the copy. */
  async moveItem(/** @type {any} */ args, /** @type {any} */ chat) {
    const source = this.resolve(args.from);
    const root = this.root();
    let stat;
    try { stat = fs.statSync(source.full); } catch { throw new ToolError(RESULTS.missing(source.shown), await this.nearby(source)); }
    if (this.roots().some((folder) => path.resolve(source.full).toLowerCase() === path.resolve(folder).toLowerCase()) || path.parse(source.full).root === source.full) {
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
    // Where it lands may have rules of its own (names, layout): as an edit's, given first.
    const rules = this.rulesFirst(target, chat);
    if (rules) return rules;
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
        madeFolder, stamp: folder ? (copy ? treeStamp(target.full) : "") : stampOf(target.full) } };
  }

  // ---------------------------------------------------------------- remove_item --

  async removeItem(/** @type {any} */ args, /** @type {any} */ chat) {
    const target = this.resolve(args.path);
    const root = this.root();
    let stat;
    try { stat = fs.statSync(target.full); } catch { throw new ToolError(RESULTS.missing(target.shown), await this.nearby(target)); }
    if (this.roots().some((folder) => path.resolve(target.full).toLowerCase() === path.resolve(folder).toLowerCase()) || path.parse(target.full).root === target.full) {
      throw new ToolError(RESULTS.removeRoot);
    }
    const folder = stat.isDirectory();
    const { files, bytes } = folder ? measure(target.full) : { files: 1, bytes: stat.size };
    // A copy first, so Undo can put it back (the Recycle Bin isn't there on every drive).
    let backup = "";
    // Only a copy that fits under the storage limit: one over it would be pruned straight away, after the delete.
    const limit = Math.max(0.1, Number(solderSettings().get("storageLimitGB", 5)) || 5) * 1024 ** 3;
    if (bytes <= Math.min(MAX_REMOVE_BACKUP_BYTES, limit * 0.5) && files <= MAX_REMOVE_BACKUP_FILES) {
      const store = path.join(this.backupsRoot(), chat.id);
      this.pruneSoon();
      fs.mkdirSync(store, { recursive: true });
      do backup = backupPath(store, target.full); while (fs.existsSync(backup));
      fs.cpSync(target.full, backup, { recursive: true, errorOnExist: true, force: false });
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
        const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath.toLowerCase() === change.path.toLowerCase());
        let now = null;
        try { now = open ? open.getText() : decodeText(fs.readFileSync(change.path)); } catch { now = null; }
        return now !== null && hash(now) !== change.after;
      }
      if (change.copied && change.folder) {
        if (vscode.workspace.textDocuments.some((d) => d.isDirty && d.uri.scheme === "file" && within(d.uri.fsPath, change.path))) return true;
        return !!change.stamp && fs.existsSync(change.path) && treeStamp(change.path) !== change.stamp;
      }
      return !!change.stamp && fs.existsSync(change.path) && stampOf(change.path) !== change.stamp;
    };
    // A move is put back whatever happened since: moving it back loses nothing.
    if ((change.after || change.stamp) && !(change.moved && !change.copied) && changedSince()) throw new Error(`${change.shown} has changed since that step, so undoing it would lose those changes. Use Review to compare, and change it by hand.`);
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
    const limit = limitBytes ?? Math.max(0.1, Number(solderSettings().get("storageLimitGB", 5)) || 5) * 1024 ** 3;
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

  /**
   * A turn's changes in one place: VS Code's changes editor with a diff a file, each from before the turn's first
   * change to it ↔ the file now (one file: a plain diff). What has no diff to show (a move that changed nothing, a
   * folder, a copy from before that's no longer kept) is returned as lines to say.
   * @param {import("./review.js").Entry[]} entries @param {string} title
   * @returns {Promise<{opened: number, notes: string[]}>}
   */
  async reviewAll(entries, title) {
    /** @type {[vscode.Uri, vscode.Uri, vscode.Uri][]} */
    const resources = [];
    /** @type {string[]} */
    const notes = [];
    for (const entry of entries) {
      const file = vscode.Uri.file(entry.path);
      const there = fs.existsSync(entry.path);
      const kept = !!entry.before && fs.existsSync(entry.before);
      if (entry.folder) { notes.push(describe(entry)); continue; }
      if (entry.kind === "moved") { notes.push(describe(entry) + " (nothing in it changed)"); continue; }
      if (entry.kind === "removed") {
        if (kept) resources.push([file, vscode.Uri.file(/** @type {string} */ (entry.before)), emptyDocument(entry.path)]);
        else notes.push(describe(entry) + " (no copy of it was kept)");
        continue;
      }
      if (!there) { notes.push(`${entry.shown} isn't there any more`); continue; }
      if (entry.kind === "added") { resources.push([file, emptyDocument(entry.path), file]); continue; }
      if (kept) resources.push([file, vscode.Uri.file(/** @type {string} */ (entry.before)), file]);
      else notes.push(describe(entry) + " (the copy from before it isn't kept any more)");
      if (entry.from) notes.push(describe({ ...entry, kind: "moved" }));
    }
    if (resources.length === 1) {
      const [file, before, after] = resources[0];
      await vscode.commands.executeCommand("vscode.diff", before, after, `${this.shown(file.fsPath)} (before ↔ after this task)`, { preview: true });
    } else if (resources.length) {
      await vscode.commands.executeCommand("vscode.changes", title, resources);
    }
    return { opened: resources.length, notes };
  }

  /**
   * A change that's waiting for your Allow, shown before it's made: the file as it is ↔ the file as the change would
   * leave it, worked out as the change itself is (plannedEdit). Nothing is changed by looking.
   * @param {string} name @param {any} args @returns {Promise<string>} "" when a diff was opened, else why there's none
   */
  async previewChange(name, args) {
    try {
      if (name === "edit_file") {
        const { file, text, found } = await this.plannedEdit(args);
        const proposed = text.slice(0, found.start) + found.replaced + text.slice(found.start + found.length);
        await vscode.commands.executeCommand("vscode.diff", file.uri, previewDocument(file.full, proposed), `${file.shown} (now ↔ if you allow this)`, { preview: true });
        return "";
      }
      if (name === "write_file") {
        const file = this.resolve(args.path);
        let exists = false;
        try { exists = fs.statSync(file.full).isFile(); } catch { exists = false; }
        await vscode.commands.executeCommand("vscode.diff", exists ? file.uri : emptyDocument(file.full), previewDocument(file.full, String(args.content ?? "")),
          `${file.shown} (${exists ? "now" : "new"} ↔ if you allow this)`, { preview: true });
        return "";
      }
      return "There's nothing to show side by side for this one: the card says what it does.";
    } catch (error) {
      if (error instanceof ToolError) return `This change wouldn't go through as it stands: ${error.message}`;
      return `The change couldn't be shown: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async mustBeFile(/** @type {any} */ file) {
    let stat;
    try { stat = await vscode.workspace.fs.stat(file.uri); } catch { throw new ToolError(RESULTS.missing(file.shown), await this.nearby(file)); }
    if (stat.type & vscode.FileType.Directory) throw new ToolError(RESULTS.readFolder(file.shown), folderEntries(file.full));
    if (stat.size > 20 * 1024 * 1024) throw new ToolError(RESULTS.tooLarge(file.shown, Math.round(stat.size / 1048576)));
  }

  /**
   * A path that doesn't exist: files in the workspace with the same name (any case), or else the same name with
   * another extension, most alike first. Only suggested: nothing is read or changed in their place.
   * @param {any} file @returns {Promise<string>} the suggestion, or ""
   */
  async nearby(file) {
    const name = path.basename(file.full);
    if (!name || /[*?[\]{}]/.test(name)) return "";
    const look = async (/** @type {string} */ glob) => {
      const out = [];
      for (const root of this.roots()) {
        try {
          const found = await deadline(vscode.workspace.findFiles(new vscode.RelativePattern(root, caseless(glob)), "**/node_modules/**", NEARBY_MAX + 1), NEARBY_MS);
          out.push(...(found || []).map((/** @type {any} */ uri) => uri.fsPath));
        } catch { /* nothing to suggest */ }
        if (out.length > NEARBY_MAX) break;
      }
      return out.filter((p) => p.toLowerCase() !== file.full.toLowerCase());
    };
    let found = await look("**/" + name);
    let same = true;
    const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : "";
    if (!found.length && stem) { found = await look("**/" + stem + ".*"); same = false; }
    if (!found.length) return "";
    return RESULTS.nearby(rankNearby(file.full, found).slice(0, NEARBY_MAX).map((p) => this.shown(p)), same);
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
  const edge = nameChars(name);
  const word = new RegExp(`(?<![${edge}])${escapeRegex(name)}(?![${edge}])`);
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
      if (typeof symbol?.name === "string" && symbol.name.replace(/\s*\(.*\)$/, "") === name) declared = symbol;
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

/**
 * The characters that make a match part of a longer name, as a regex class's inside: letters, digits, _ and $ (a
 * PowerShell $variable, JavaScript's $el), and - when the name has one, as PowerShell's commands do (Get-Uptime isn't
 * found inside My-Get-Uptime; total still is in total-1). @param {string} name
 */
function nameChars(name) {
  return name.includes("-") ? "\\w$-" : "\\w$";
}

/** @param {string} text */
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
/**
 * Switches that turn off the filter programs a repository's own config names (filter.<x>.clean, smudge and process:
 * git runs them on its files during status and diff). Filters set up for you or the whole PC (Git LFS) stay: those
 * are yours. A repository's own could be anyone's, in a folder that was copied or cloned in, and Solder runs nothing.
 * @param {string} git @param {string} top the repository @param {AbortSignal} [signal] @returns {Promise<string[]>}
 */
async function quietFilters(git, top, signal) {
  let listed = "";
  // Exit 1 means there are none.
  try { listed = await runGit(git, top, ["config", "--local", "--includes", "-z", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"], signal); } catch { return []; }
  /** @type {string[]} */
  const off = [];
  const drivers = new Set();
  for (const entry of listed.split("\0")) {
    const key = entry.split("\n")[0].trim();
    const driver = /^filter\.(.+)\.(?:clean|smudge|process|required)$/i.exec(key)?.[1];
    if (driver) drivers.add(driver);
  }
  for (const driver of drivers) {
    for (const kind of ["clean", "smudge", "process"]) off.push("-c", `filter.${driver}.${kind}=`);
    off.push("-c", `filter.${driver}.required=false`);
  }
  return off;
}

/** @param {string} git @param {string} cwd @param {string[]} args @param {AbortSignal} [signal] @param {string[]} [extra] more -c switches, before the command */
function runGit(git, cwd, args, signal, extra = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(git, [...GIT_SAFE, ...extra, ...args], { cwd, windowsHide: true, shell: false, signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", GIT_EXTERNAL_DIFF: "" } });
    let out = "";
    let errors = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { if (out.length < 4_000_000) out += chunk; });
    child.stderr.on("data", (chunk) => { if (errors.length < 10_000) errors += chunk; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, GIT_MS);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(Object.assign(new Error(timedOut ? `git took longer than ${GIT_MS / 1000} seconds, so it was stopped`
        : errors.trim().split(/\r?\n/)[0] || `git stopped (exit ${code})`), { exit: code }));
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
    // A merge conflict first: its pairs (AA, DD, AU, UA, DU, UD, UU) would read as added or deleted below.
    const conflicted = x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
    if (conflicted) { out.push({ path: file, state: "changed", label: "conflicted" }); continue; }
    let label = x === "D" || y === "D" ? "deleted" : x === "A" ? "added" : x === "R" || x === "C" ? `renamed from ${parts[index + 1] ?? "?"}` : "modified";
    if (x === "R" || x === "C") index++; // the old name follows
    const staged = x !== " " && x !== "?";
    const unstaged = y !== " " && y !== "?";
    label += staged && unstaged ? " (staged and unstaged)" : staged ? " (staged)" : "";
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
 * The disk's text, when VS Code's copy of a file is unchanged by you and differs from it; else null (the same, or you
 * have unsaved changes, or it isn't text we can compare: another encoding, where VS Code is trusted). Compared as text,
 * the way Undo's check is: VS Code evens out mixed line endings when it opens a file (a script signed after it was
 * saved with LF has CRLF in its signature), and drops the BOM, so bytes never match.
 * @param {{isDirty: boolean, getText: () => string}} document @param {string} full @returns {string | null}
 */
function diskTextIfNewer(document, full) {
  if (document.isDirty) return null;
  let disk;
  try { disk = decodeText(fs.readFileSync(full)); } catch { return null; }
  if (disk === null || disk.includes("\uFFFD")) return null;
  return hash(disk) === hash(document.getText()) ? null : disk;
}

/** How long VS Code is given to catch up with the disk by itself, then to reload when told to. */
const CATCH_UP_MS = 300;
const RELOAD_MS = 3000;

/**
 * Before a change to an open file: VS Code's copy must be the disk's, or the change would be made to old text (and
 * saving it would overwrite what changed on disk). After a change outside VS Code its copy catches up by itself in a
 * moment, when its file watcher says so; on a network drive the watcher often never does, and the copy stayed behind
 * for good (every edit refused, every read the old text). So it's given a moment, then made to reload: the file is
 * written over itself, the same bytes, through VS Code, which reloads its copy of a file it writes this way. Your
 * unsaved changes are never touched (then nothing is compared: VS Code's own save says if the disk changed).
 * @param {vscode.TextDocument} document @param {any} file
 */
async function freshen(document, file) {
  if (diskTextIfNewer(document, file.full) === null) return;
  for (let waited = 0; waited < CATCH_UP_MS; waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (diskTextIfNewer(document, file.full) === null) return;
  }
  try {
    const reload = new vscode.WorkspaceEdit();
    reload.createFile(file.uri, { overwrite: true, contents: fs.readFileSync(file.full) });
    await vscode.workspace.applyEdit(reload);
  } catch { /* said below, if it's still behind */ }
  for (let waited = 0; waited <= RELOAD_MS; waited += 50) {
    if (diskTextIfNewer(document, file.full) === null) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new ToolError(RESULTS.changedOnDisk(file.shown));
}

/**
 * A stat's failure that says for sure there's nothing at the path (VS Code's FileNotFound, or Node's ENOENT; a parent
 * that's a file, too). Anything else (a share that didn't answer in time) says nothing about whether it's there.
 * @param {any} error
 */
function notFoundError(error) {
  const code = error?.code;
  return code === "FileNotFound" || code === "ENOENT" || code === "FileNotADirectory" || code === "ENOTDIR"
    || /^EntryNotFound/.test(String(error?.name ?? ""));
}

/** Save, or put the editor back as it was and say so: a change only counts once it's on disk. */
async function saveOrRevert(/** @type {vscode.TextDocument} */ document, /** @type {any} */ file, /** @type {string} */ was) {
  if (await document.save() && !document.isDirty) return;
  const back = new vscode.WorkspaceEdit();
  back.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), was);
  await vscode.workspace.applyEdit(back);
  throw new ToolError(RESULTS.notSaved(file.shown));
}

/**
 * A name for a backup in a chat's backups folder: the time, a random part, then the file's own name (so Review shows
 * it as that kind of file). The random part keeps apart two files of the same name backed up in the same moment
 * (src/a/config.js and src/b/config.js in one reply). @param {string} folder @param {string} full
 */
function backupPath(folder, full) {
  return path.join(folder, `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}-${path.basename(full)}`);
}

/** Which task a change is in: the chat, and how many messages you've sent in it. @param {any} chat */
function taskOf(chat) {
  return `${chat?.id ?? ""}:${(chat?.messages ?? []).filter((/** @type {any} */ m) => m.role === "user").length}`;
}

/** @param {string} text */
function hash(text) {
  return crypto.createHash("sha1").update(String(text).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")).digest("hex");
}

/** Whether a file is shown in an editor tab (not just opened by Solder in the background). @param {string} full */
/**
 * Open a file in a tab without bringing it forward (the editor in view and the cursor stay where they are). Pinned,
 * so it doesn't replace a preview tab. False when VS Code wouldn't, or brought it forward anyway (then it's closed).
 * @param {any} file @returns {Promise<boolean>}
 */
async function openInBackground(file) {
  const before = vscode.window.activeTextEditor;
  try { await vscode.commands.executeCommand("vscode.open", file.uri, { background: true, preview: false, preserveFocus: true }); }
  catch { return false; }
  const now = vscode.window.activeTextEditor;
  if (before && now && now !== before && now.document.uri.fsPath.toLowerCase() === file.full.toLowerCase()) {
    await closeTab(file); // this VS Code ignored "background": put the view back as it was
    return false;
  }
  return shownInEditor(file.full);
}

/** Close the tabs Solder opened on a file for a check (one with unsaved changes stays). @param {any} file */
async function closeTab(file) {
  const key = file.full.toLowerCase();
  const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => {
    const uri = /** @type {any} */ (tab.input)?.uri;
    return !!uri && uri.scheme === "file" && uri.fsPath.toLowerCase() === key && !tab.isDirty;
  });
  if (tabs.length) await Promise.resolve(vscode.window.tabGroups.close(tabs, true)).catch(() => {});
}

/**
 * A search glob for ripgrep, read as find_files reads one: backslashes as slashes, no leading "./", and a folder
 * ("src", "src/") as everything in it. @param {string} root @param {string} glob
 */
function rgGlob(root, glob) {
  let clean = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (clean.endsWith("/")) return clean + "**";
  if (!/[*?[\]{}]/.test(clean)) {
    try { if (fs.statSync(path.join(root, clean)).isDirectory()) return clean.replace(/\/+$/, "") + "/**"; } catch { /* a file name or pattern */ }
  }
  return clean;
}

/** A folder's own entries for the model, folders marked with "/", capped. @param {string} full @returns {string} */
function folderEntries(full) {
  let entries;
  try { entries = fs.readdirSync(full, { withFileTypes: true }); } catch { return ""; }
  const names = entries.filter((entry) => entry.name !== ".git")
    .map((entry) => entry.name + (entry.isDirectory() ? "/" : ""))
    .sort((a, b) => (b.endsWith("/") ? 1 : 0) - (a.endsWith("/") ? 1 : 0) || a.localeCompare(b));
  if (!names.length) return RESULTS.folderEmpty;
  return RESULTS.folderHas(names.slice(0, FOLDER_ENTRIES_MAX), names.length);
}

function shownInEditor(full) {
  const key = full.toLowerCase();
  return (vscode.window?.tabGroups?.all ?? []).some((group) => group.tabs.some((tab) => {
    const input = /** @type {any} */ (tab.input);
    const uri = input?.uri ?? input?.modified;
    return !!uri && uri.scheme === "file" && uri.fsPath.toLowerCase() === key;
  }));
}

/** A file's time and size, to tell later whether it changed. @param {string} full */
/** A folder's whole tree as one stamp: every file's path, size and time, so any change in it shows. @param {string} full */
function treeStamp(full) {
  const parts = [];
  const walk = (/** @type {string} */ dir, /** @type {string} */ rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (parts.length > 50_000) return;
      const next = path.join(dir, entry.name);
      if (entry.isDirectory()) { parts.push(rel + entry.name + "/"); walk(next, rel + entry.name + "/"); }
      else parts.push(rel + entry.name + ":" + stampOf(next));
    }
  };
  walk(full, "");
  return "tree:" + hash(parts.join("\n"));
}

/**
 * What a file holds, to tell later whether it's been changed: a hash of its content (up to 5 MB; past that, its size).
 * By content, not time, so a file put back as it was (Undo all undoing a later edit first) counts as unchanged.
 * @param {string} full
 */
function stampOf(full) {
  try {
    const stat = fs.statSync(full);
    return stat.size <= 5 * 1024 * 1024 ? "c:" + hash(fs.readFileSync(full).toString("latin1")) : `s:${stat.size}`;
  } catch { return ""; }
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

/**
 * Read-only documents Solder shows beside a file in a diff: an empty one (the "before" of a new file, the "after" of a
 * removed one), and a change as it would be, before you allow it. Registered the first time one is needed.
 */
const PREVIEW_SCHEME = "solder-preview";
/** @type {Map<string, string>} by the document's path part */
const previews = new Map();
let previewsRegistered = false;
let previewCount = 0;

/** A read-only document holding `text`, named after `file` (so it's coloured as that kind of file). @param {string} file @param {string} text */
function previewDocument(file, text) {
  if (!previewsRegistered) {
    previewsRegistered = true;
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, { provideTextDocumentContent: (uri) => previews.get(uri.path) ?? "" });
  }
  const key = `/${text ? `p${++previewCount}` : "empty"}/${path.basename(file)}`;
  if (text) {
    previews.set(key, text);
    // A few are kept (a diff tab left open still shows its text); older ones go.
    for (const old of [...previews.keys()].slice(0, Math.max(0, previews.size - 40))) previews.delete(old);
  }
  return vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: key });
}

/** An empty read-only document, named after `file`. @param {string} file */
function emptyDocument(file) {
  return previewDocument(file, "");
}

/** Where a change can make programs run: git's settings, hooks and filters, and VS Code's tasks and settings. */
const PROGRAM_FOLDERS = [".git", ".vscode"];
const PROGRAM_FILES = [".gitattributes", ".gitmodules", ".gitconfig"];
const WORKSPACE_FILE = ".code-workspace";
const RUNS_PROGRAMS = (/** @type {string} */ what) =>
  `It changes ${what}, where a change can make programs run (git's hooks and filters, VS Code's tasks and settings).`;

/**
 * The git or VS Code folder or file a path is in, as written or once Windows has resolved it: an 8.3 short name
 * (GIT~1 for .git) or a link to it counts too. "" when it's neither. @param {string} full
 */
function programRisk(full) {
  return runsPrograms(full) || runsPrograms(realPath(full));
}

/**
 * The git or VS Code folder or file a path is in, as written, or "". A name's stream suffix (".gitattributes::$DATA",
 * "file:stream") is left out: NTFS writes that to the file itself, so it would otherwise slip past (for a file that
 * isn't there yet, whose real path can't be asked). @param {string} full
 */
function runsPrograms(full) {
  const parts = nameParts(full);
  const folder = parts.slice(0, -1).find((part) => PROGRAM_FOLDERS.includes(part));
  if (folder) return folder;
  const last = parts[parts.length - 1];
  // A workspace file (name.code-workspace) holds the same settings and tasks as .vscode does.
  return PROGRAM_FOLDERS.includes(last) || PROGRAM_FILES.includes(last) || last.endsWith(WORKSPACE_FILE) ? last : "";
}

/** A path's parts, lower-cased, each without a stream suffix. @param {string} full */
function nameParts(full) {
  return path.resolve(full).split(/[\\/]/).map((part) => part.replace(/:.*$/, "").toLowerCase());
}

/** A project's own folder: its name, its skills and its skill switches. */
const PROJECT_FOLDER = ".solder";

/**
 * The rules file a path is, or the project folder it is (or is in): what the model is given as instructions in later
 * chats, so a change there outlasts the chat that made it. As written, or once Windows has resolved it (a short name,
 * a link); "" when it's neither. @param {string} full @param {string[]} names the instruction file names
 */
function followedLater(full, names) {
  for (const given of [full, realPath(full)]) {
    const parts = nameParts(given);
    if (parts.includes(PROJECT_FOLDER)) return PROJECT_FOLDER;
    const name = names.find((candidate) => candidate.toLowerCase() === parts[parts.length - 1]);
    if (name) return name;
  }
  return "";
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

/**
 * Whether an instruction file (AGENTS.md) really is the workspace's own: a file, there, whose real path (links followed)
 * is inside the folder's. A repository can carry a symbolic link by that name pointing anywhere on the disk; following it
 * would send that file to the model as "instructions", with no approval asked. @param {string} full @param {string} folder
 */
function ownFile(full, folder) {
  try { return fs.statSync(full).isFile() && within(realPath(full), realPath(folder)); } catch { return false; }
}

/** The instruction file names from the settings (plain names only). */
function ruleNames() {
  return plainNames(solderSettings().get("instructionFiles", ["AGENTS.md"]));
}

/**
 * The folder rules for a path in a workspace folder: the instruction files of each folder from the path's own up to
 * the workspace folder, not including it (its own are in the system prompt). Nearest first. A folder's own file only
 * (ownFile): a link by that name to elsewhere isn't used. The path itself needn't exist (a new file).
 * @param {string} full @param {string} root @param {string[]} names
 * @returns {{key: string, file: string, shown: string}[]}
 */
function folderRules(full, root, names) {
  /** @type {{key: string, file: string, shown: string}[]} */
  const out = [];
  let folder = path.dirname(full);
  // A drive root (Z:\) already ends in its separator; the root folder itself is never walked (its own is read already).
  const inRoot = (root.endsWith(path.sep) ? root : root + path.sep).toLowerCase();
  while (folder.length > inRoot.length && folder.toLowerCase().startsWith(inRoot)) {
    for (const name of names) {
      const file = path.join(folder, name);
      if (ownFile(file, root)) out.push({ key: file.toLowerCase(), file, shown: path.relative(root, file).split(path.sep).join("/") });
    }
    const up = path.dirname(folder);
    if (up === folder) break;
    folder = up;
  }
  return out;
}

/**
 * Rules given during a reply that's still running, by that reply's message: its calls were written before the model
 * saw them. Kept in memory only: once the reply is over, everything the chat was given counts as seen.
 * @type {WeakMap<object, Set<string>>}
 */
const GIVEN_IN_REPLY = new WeakMap();

/** The reply being run: the chat's last message from the model. @param {any} chat @returns {object | null} */
function currentReply(chat) {
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  for (let index = messages.length - 1; index >= 0; index--) if (messages[index]?.role === "assistant") return messages[index];
  return null;
}

/**
 * Of these folder rules, gives the chat those it hasn't been given (read now, up to `max` with text, and marked given in
 * `chat.agentsSeen`), and says which were given in the reply now running (`pending`). The record is the chat's: what it
 * says was given counts as given, even after compaction summarised the text away.
 * @param {{key: string, file: string, shown: string}[]} rules @param {any} chat @param {number} [max]
 * @returns {{notes: string, fresh: string[], pending: string[]}}
 */
function giveRules(rules, chat, max = Infinity) {
  chat.agentsSeen = Array.isArray(chat.agentsSeen) ? chat.agentsSeen : [];
  const reply = currentReply(chat);
  const inReply = reply ? GIVEN_IN_REPLY.get(reply) : undefined;
  /** @type {string[]} */
  const notes = [];
  /** @type {string[]} */
  const fresh = [];
  /** @type {string[]} */
  const pending = [];
  for (const rule of rules) {
    if (chat.agentsSeen.includes(rule.key)) {
      if (inReply?.has(rule.key)) pending.push(rule.shown);
      continue;
    }
    if (fresh.length >= max) continue;
    let text = "";
    try { text = fs.readFileSync(rule.file, "utf8").slice(0, 20_000).trim(); } catch { /* unreadable: skip */ }
    chat.agentsSeen.push(rule.key);
    if (!text) continue;
    notes.push(RESULTS.folderAgents(rule.shown, text));
    fresh.push(rule.shown);
    if (reply) {
      if (!GIVEN_IN_REPLY.has(reply)) GIVEN_IN_REPLY.set(reply, new Set());
      /** @type {Set<string>} */ (GIVEN_IN_REPLY.get(reply)).add(rule.key);
    }
  }
  return { notes: notes.join("\n\n"), fresh, pending };
}

/**
 * The paths a search or symbols result names at the start of its lines ("path:12:text", "path (3)", "path 4–9:",
 * "path (lines 3–9):"), in order, once each. Some may be nothing of the kind: the caller checks each is a file.
 * @param {string} output @returns {string[]}
 */
function namedPaths(output) {
  /** @type {string[]} */
  const out = [];
  for (const line of output.split("\n").slice(0, 2000)) {
    const match = /^(.+?):\d+[:\s]/.exec(line) || /^(.+?) \(lines \d+–\d+\):$/.exec(line) || /^(.+?) \(\d+\)$/.exec(line)
      || /^(.+?) \d+(?:–\d+)?:?(?: \(|$)/.exec(line);
    const found = match?.[1].trim();
    if (found && !/^\d+\t/.test(found) && !out.includes(found)) out.push(found);
  }
  return out;
}

/** The instruction file names that are plain names (no folders, no ..), so a setting can't point outside. @param {unknown} names */
function plainNames(names) {
  return (Array.isArray(names) ? names : []).filter((name) => typeof name === "string" && /^[^\\/:]+$/.test(name) && name !== "." && name !== "..");
}

/** A diff with each run of signature lines (base64 after a comment mark) as one line. @param {string} diff */
function withoutSignatureLines(diff) {
  // Not keyed on the begin line: a hunk deep inside a re-signed block doesn't show it.
  const lines = diff.split("\n");
  const out = [];
  for (let index = 0; index < lines.length;) {
    let run = index;
    while (run < lines.length && SIGNATURE_LINE.test(lines[run]) && lines[run][0] === lines[index][0]) run++;
    if (run - index >= 4) { out.push(lines[index][0] + RESULTS.signatureInDiff(run - index)); index = run; }
    else { out.push(lines[index]); index++; }
  }
  return out.join("\n");
}
const SIGNATURE_LINE = /^[ +-]\s*(?:#|''|\/\/) [A-Za-z0-9+/=]{16,}\s*$/;

/** Whether `full` is `folder` or inside it. @param {string} full @param {string} folder */
/**
 * New text, written as an existing file was: the same byte-order mark and encoding (UTF-8, UTF-8 with BOM, UTF-16 LE
 * or BE), and its line endings when it used CRLF throughout. @param {Buffer} raw the file as it was
 * @param {string | null} previous its text @param {string} text the new text @returns {Buffer}
 */
function encodedLike(raw, previous, text) {
  const crlf = typeof previous === "string" && previous.includes("\r\n") && !/(^|[^\r])\n/.test(previous);
  const body = crlf ? text.replace(/\r?\n/g, "\r\n") : text;
  if (raw[0] === 0xff && raw[1] === 0xfe) return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, "utf16le")]);
  if (raw[0] === 0xfe && raw[1] === 0xff) {
    const le = Buffer.from(body, "utf16le");
    for (let i = 0; i + 1 < le.length; i += 2) { const b = le[i]; le[i] = le[i + 1]; le[i + 1] = b; }
    return Buffer.concat([Buffer.from([0xfe, 0xff]), le]);
  }
  const bom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  return Buffer.concat([bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(body, "utf8")]);
}

/** A network path (\\server\share or //server/share). @param {string} full */
function isNetwork(full) {
  return /^(\\\\|\/\/)/.test(full);
}

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
/**
 * A search's pattern as a regular expression, as ripgrep reads it: fixed text unless `regex`, and case-insensitive
 * unless asked, or (smart case) the query has a capital. @param {string} query @param {boolean} regex @param {boolean} caseSensitive
 */
function searchPattern(query, regex, caseSensitive) {
  const flags = caseSensitive || /[A-Z]/.test(query) ? "g" : "gi";
  try { return new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags); } catch { return null; }
}

/** A long line as the text around its first few matches: "…before MATCH after… | …". @param {string} line @param {RegExp} pattern */
function around(line, pattern) {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  const pieces = [];
  for (const match of line.matchAll(global)) {
    if (!match[0]) break;
    const start = Math.max(0, (match.index ?? 0) - AROUND_MATCH);
    const end = Math.min(line.length, (match.index ?? 0) + match[0].length + AROUND_MATCH);
    pieces.push((start > 0 ? "…" : "") + line.slice(start, end).trim() + (end < line.length ? "…" : ""));
    if (pieces.length >= MATCHES_A_LINE) break;
  }
  return pieces.length ? pieces.join(" | ") : line.slice(0, 300);
}

/**
 * ripgrep shows a long line's first columns only, where the match usually isn't (minified code): those lines again,
 * as the text around each match, read from the file. @param {string[]} lines "path:line:text" @param {string} root
 * @param {string} query @param {boolean} regex @param {boolean} caseSensitive
 */
function aroundLongMatches(lines, root, query, regex, caseSensitive) {
  // A model's regular expression is never run in JavaScript on a long line: ripgrep's engine is linear, JavaScript's
  // can backtrack for hours on a pattern like (a+)+b, with no way to stop it. Plain text is safe to look for.
  const pattern = regex ? null : searchPattern(query, regex, caseSensitive);
  if (!pattern) return lines.map((line) => line.replace(RG_OMITTED, "…"));
  /** @type {Map<string, string[] | null>} */
  const files = new Map();
  return lines.map((line) => {
    if (!line.endsWith(RG_OMITTED)) return line;
    const found = /^(.+?):(\d+):/.exec(line);
    if (!found) return line.replace(RG_OMITTED, "…");
    const [head, file, number] = found;
    if (!files.has(file)) {
      try { files.set(file, fs.readFileSync(path.resolve(root, file), "utf8").split(/\r\n|\r|\n/)); } catch { files.set(file, null); }
    }
    const text = files.get(file)?.[Number(number) - 1];
    return text === undefined ? line.replace(RG_OMITTED, "…") : head + around(text, pattern);
  });
}

/** 1.2M, 340k, 900. @param {number} n */
function compactCount(n) {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
}

/** A glob that matches regardless of case: each letter as [xX] (outside a [...] class). @param {string} glob */
function caseless(glob) {
  let out = "";
  let inClass = false;
  for (const char of glob) {
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    out += !inClass && /[a-z]/i.test(char) && char.toLowerCase() !== char.toUpperCase() ? `[${char.toLowerCase()}${char.toUpperCase()}]` : char;
  }
  return out;
}

/** A glob as a regular expression over "/"-separated relative paths, regardless of case: ** * ? [..] {a,b}. @param {string} glob */
function globPattern(glob) {
  let out = "";
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      out += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (char === "*") out += "[^/]*";
    else if (char === "?") out += "[^/]";
    else if (char === "[") { const end = glob.indexOf("]", i); if (end < 0) { out += "\\["; continue; } out += "[" + glob.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\") + "]"; i = end; }
    else if (char === "{") { depth++; out += "(?:"; }
    else if (char === "}" && depth) { depth--; out += ")"; }
    else if (char === "," && depth) out += "|";
    else out += char.replace(/[.+^$()|\\]/g, "\\$&");
  }
  // A { left open (**/*.{ts,tsx) is closed, so the pattern always reads.
  return new RegExp("^" + out + ")".repeat(depth) + "$", "i");
}

/** Folders a direct walk never goes into. */
const WALK_SKIP = new Set([".git", "node_modules", "$recycle.bin", "system volume information"]);

/**
 * The files under `root` whose relative path matches, by walking the folder: at most `max` matches, 50,000
 * entries and 10 seconds (a big share stays bounded). @param {string} root @param {RegExp} pattern @param {number} max
 */
function walkFiles(root, pattern, max) {
  const found = [];
  const stack = [root];
  const until = Date.now() + 10_000;
  let entries = 0;
  while (stack.length && found.length < max && entries < 50_000 && Date.now() < until) {
    const folder = /** @type {string} */ (stack.pop());
    let list;
    try { list = fs.readdirSync(folder, { withFileTypes: true }); } catch { continue; }
    for (const entry of list) {
      entries++;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) { if (!WALK_SKIP.has(entry.name.toLowerCase())) stack.push(full); continue; }
      if (!entry.isFile()) continue;
      if (pattern.test(path.relative(root, full).split(path.sep).join("/"))) found.push(full);
      if (found.length >= max) break;
    }
  }
  return found.sort();
}

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
  if (!part) return found; // "" is everywhere, and looking for it would never move on
  for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + 1)) found.push(at);
  return found;
}

function lineOf(/** @type {string} */ text, /** @type {number} */ index) {
  return text.slice(0, index).split("\n").length;
}

/** The same lines with only trailing spaces differing, found exactly once: [start, length] or null. */
/** Where old_text's lines match the file's, trailing spaces aside: the first line of each place (0-based). */
function looseHits(/** @type {string} */ text, /** @type {string} */ old, /** @type {string} */ eol) {
  const lines = text.split(eol);
  const want = old.split(eol).map((line) => line.trimEnd());
  const hits = [];
  for (let i = 0; i + want.length <= lines.length; i++) if (want.every((line, k) => lines[i + k].trimEnd() === line)) hits.push(i);
  return hits;
}

function looseMatch(/** @type {string} */ text, /** @type {string} */ old, /** @type {string} */ eol) {
  const lines = text.split(eol);
  const want = old.split(eol).map((line) => line.trimEnd());
  const hits = looseHits(text, old, eol);
  if (hits.length !== 1) return null;
  const hit = hits[0];
  const start = lines.slice(0, hit).reduce((sum, line) => sum + line.length + eol.length, 0);
  const length = lines.slice(hit, hit + want.length).join(eol).length;
  return [start, length];
}

/**
 * old_text wasn't there: the place in the file most of its lines point to, with the file's lines around it (so the
 * next try can copy them, with no read in between). Each old_text line found in the file (spacing aside) votes for
 * where old_text would start; the place with the most votes wins, if it has at least two (or old_text is one line)
 * and no other place ties with it. Otherwise nothing is shown rather than a guess. @returns {ToolError}
 */
function notFound(/** @type {string} */ shown, /** @type {string} */ text, /** @type {string} */ old, /** @type {string} */ eol) {
  const squash = (/** @type {string} */ line) => line.trim().replace(/\s+/g, " ");
  const lines = text.split(eol);
  const want = old.split(eol).map(squash);
  const counted = want.filter(Boolean).length;
  /** @type {Map<string, number[]>} */
  const where = new Map();
  lines.forEach((line, index) => {
    const key = squash(line);
    if (!key) return;
    const list = where.get(key);
    if (list) list.push(index); else where.set(key, [index]);
  });
  /** @type {Map<number, number>} */
  const votes = new Map();
  want.forEach((line, k) => {
    if (!line) return;
    for (const index of where.get(line) || []) votes.set(index - k, (votes.get(index - k) || 0) + 1);
  });
  let best = -1;
  let most = 0;
  let tied = false;
  for (const [at, count] of votes) {
    if (at <= -want.length || at >= lines.length) continue; // (a place starting above line 1: old_text has a wrong first line)
    if (count > most) { best = at; most = count; tied = false; } else if (count === most) tied = true;
  }
  // One vote is enough when it comes from a line found just once in the file and long enough to mean something.
  const telling = most === 1 && want.some((line, k) => line.length >= 6 && where.get(line)?.length === 1 && where.get(line)?.[0] === best + k);
  if (!most || tied || (most < Math.min(2, counted) && !telling)) return new ToolError(RESULTS.notFound(shown, 0, 0, 0, 0));
  const from = Math.max(0, best - 2);
  const to = Math.min(lines.length, Math.max(best, 0) + want.length + 3, from + MISS_LINES);
  return new ToolError(RESULTS.notFound(shown, from + 1, to, most, counted), numbered(lines, from, to));
}

/**
 * Where old_text goes: exactly (once), then forgiving trailing spaces, then a uniform indentation shift (new_text
 * shifted the same way). A trailing line break on old_text doesn't stop the forgiving matches. Null when none fits.
 * @returns {{start: number, length: number, replaced: string, note: string} | null}
 */
function locate(/** @type {string} */ shown, /** @type {string} */ text, /** @type {string} */ old, /** @type {string} */ replacement, /** @type {string} */ eol) {
  const count = occurrences(text, old);
  if (count === 1) return { start: text.indexOf(old), length: old.length, replaced: replacement, note: "" };
  if (count > 1) {
    const lines = positions(text, old).map((index) => lineOf(text, index));
    throw new ToolError(RESULTS.manyMatches(count, shown, lines.slice(0, 10)), aroundPlaces(text, lines, eol));
  }
  // old_text ending in a line break: match its lines, then take the break after them too.
  let lines = old;
  let swap = replacement;
  let breakAfter = false;
  if (old.endsWith(eol) && old.length > eol.length) {
    lines = old.slice(0, -eol.length);
    if (replacement.endsWith(eol)) swap = replacement.slice(0, -eol.length); else breakAfter = true;
  }
  const grow = (/** @type {number} */ start, /** @type {number} */ length) =>
    breakAfter && text.startsWith(eol, start + length) ? length + eol.length : length;
  const many = looseHits(text, lines, eol);
  if (many.length > 1) throw new ToolError(RESULTS.manyMatches(many.length, shown, many.slice(0, 10).map((i) => i + 1)), aroundPlaces(text, many.map((i) => i + 1), eol));
  const loose = looseMatch(text, lines, eol);
  if (loose) return { start: loose[0], length: grow(loose[0], loose[1]), replaced: swap, note: "" };
  // The same lines, all indented by the same amount more or less (a deep block copied a level off):
  // that shift, and new_text shifted the same way. Anything uneven is refused, with the lines to copy from.
  const moved = shiftedMatch(text, lines, eol);
  const shifted = moved && shiftLines(swap, moved.shift, eol);
  if (!moved || shifted === null) return null;
  return { start: moved.start, length: grow(moved.start, moved.length), replaced: shifted, note: " " + RESULTS.reindented(...describeShift(moved.shift)) };
}

/**
 * An edit worked out against a file's text: where it goes and what goes there, or the ToolError the model is given.
 * One place (old_text once: exactly, then forgiving trailing spaces, then a uniform indentation shift; failing those,
 * old_text copied with read_file's line numbers is tried without them), or with replace_all every place old_text
 * appears, exactly as written (no forgiving there: a loose match in many places is how the wrong text gets changed).
 * The real tool, its preview and the live suite's stand-in all use this, so they can't disagree.
 * @param {string} shown the file, as the model names it @param {string} text @param {any} args old_text, new_text, replace_all
 * @param {string} eol @returns {{old: string, found: {start: number, length: number, replaced: string, note: string, places?: number[]}}}
 */
function planEdit(shown, text, args, eol) {
  const old = toEol(String(args.old_text), eol);
  const replacement = toEol(String(args.new_text), eol);
  if (!old) throw new ToolError(RESULTS.emptyOldText);
  if (old === replacement) throw new ToolError(RESULTS.sameText);
  if (args.replace_all === true || args.replace_all === "true") {
    // Each place in turn, none overlapping the one before (as the replacing below takes them).
    const at = [];
    for (let index = text.indexOf(old); index >= 0; index = text.indexOf(old, index + old.length)) at.push(index);
    if (!at.length) throw notFound(shown, text, withoutLineNumbers(old, eol) ?? old, eol);
    // One stretch of the file, from the first place to the end of the last, with each place replaced in it.
    const end = at[at.length - 1] + old.length;
    return { old, found: { start: at[0], length: end - at[0], replaced: text.slice(at[0], end).split(old).join(replacement), note: "", places: at.map((index) => lineOf(text, index)) } };
  }
  let found = locate(shown, text, old, replacement, eol);
  const plain = withoutLineNumbers(old, eol);
  if (!found) {
    // Only a line number ("12	", a blank line copied from read_file): nothing is left to look for.
    if (plain === "") throw new ToolError(RESULTS.emptyOldText);
    const plainNew = plain === null ? null : numberedLines(replacement, eol);
    if (plain !== null && plainNew === false) throw new ToolError(RESULTS.numberedNewText);
    const again = plain === null ? null : locate(shown, text, plain, plainNew === true ? /** @type {string} */ (withoutLineNumbers(replacement, eol)) : replacement, eol);
    if (again) found = { ...again, note: " " + RESULTS.numbersLeftOut + again.note };
  }
  if (!found) {
    // Written with spaces against a file indented with tabs, or the other way round: one tab for the same number of
    // spaces on every line, new_text changed the same way, when that gives one place and one reading only.
    const plainNew = plain !== null && numberedLines(replacement, eol) === true ? /** @type {string} */ (withoutLineNumbers(replacement, eol)) : replacement;
    const turned = retabbedMatch(shown, text, plain ?? old, plainNew, eol);
    if (turned) found = { ...turned, note: (plain !== null ? " " + RESULTS.numbersLeftOut : "") + turned.note };
  }
  if (!found) throw notFound(shown, text, plain ?? old, eol);
  return { old, found };
}

/**
 * Search matches (path:line:text) with the lines around each: for every file, its stretches of lines (those around
 * matches near each other joined into one), numbered as read_file numbers them. Up to `max` lines in all; the matches
 * left over are counted. A file that can't be read keeps its bare matching lines.
 * @param {string[]} matches @param {(file: string) => string[] | null} linesOf @param {number} around @param {number} max
 */
function withContext(matches, linesOf, around, max) {
  /** @type {Map<string, {lines: number[], bare: string[]}>} */
  const files = new Map();
  for (const match of matches) {
    const parts = /^(.*?):(\d+):/.exec(match);
    if (!parts) continue;
    const entry = files.get(parts[1]) ?? { lines: [], bare: [] };
    entry.lines.push(Number(parts[2]));
    entry.bare.push(match);
    files.set(parts[1], entry);
  }
  /** @type {string[]} */
  const out = [];
  let used = 0;
  let left = 0;
  for (const [file, entry] of files) {
    if (used >= max) { left += entry.lines.length; continue; }
    let text = linesOf(file);
    if (!text) { out.push(entry.bare.join("\n")); used += entry.bare.length; continue; }
    if (text.length > 1 && text[text.length - 1] === "") text = text.slice(0, -1); // the line break that ends the file isn't a line
    // Stretches: each match's lines, joined with the next when they touch or overlap.
    /** @type {[number, number, number][]} first line, last line, matches in it */
    const stretches = [];
    for (const line of [...new Set(entry.lines)].sort((a, b) => a - b)) {
      const from = Math.max(1, line - around);
      const to = Math.min(text.length, line + around);
      const last = stretches[stretches.length - 1];
      if (last && from <= last[1] + 1) { last[1] = Math.max(last[1], to); last[2]++; } else stretches.push([from, to, 1]);
    }
    // A long matching line (minified code) is shown around its match, as search found it, not by its start: that
    // could be thousands of characters before the match.
    /** @type {Map<number, string>} */
    const found = new Map(entry.bare.map((match) => {
      const at = /^(.*?):(\d+):/.exec(match);
      return [Number(at?.[2]), at ? match.slice(at[0].length) : ""];
    }));
    for (const [from, to, count] of stretches) {
      if (used >= max) { left += count; continue; }
      const shown = text.slice(from - 1, to).map((line, k) => `${from + k}\t${line.length <= 300 ? line
        : /^…|…$/.test(found.get(from + k) ?? "") ? /** @type {string} */ (found.get(from + k)) : line.slice(0, 300) + "…"}`);
      out.push(RESULTS.searchAround(file, from, to) + "\n" + shown.join("\n"));
      used += shown.length + 1;
    }
  }
  return out.join("\n\n") + (left ? "\n\n" + RESULTS.searchAroundCapped(left) : "");
}

/** Text copied from read_file with its line numbers ("12\t…" on every line, counting up): without them, else null. */
function withoutLineNumbers(/** @type {string} */ text, /** @type {string} */ eol) {
  const lines = text.split(eol);
  const last = lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  let expect = -1;
  for (let k = 0; k < last; k++) {
    const match = /^(\d+)\t/.exec(lines[k]);
    if (!match) return null;
    const number = Number(match[1]);
    if (expect !== -1 && number !== expect) return null;
    expect = number + 1;
  }
  if (expect === -1) return null;
  return lines.map((line, k) => k < last ? line.replace(/^\d+\t/, "") : line).join(eol);
}

/** new_text alongside a numbered old_text: true when it's numbered throughout, null when not at all, false when mixed. */
function numberedLines(/** @type {string} */ text, /** @type {string} */ eol) {
  if (withoutLineNumbers(text, eol) !== null) return true;
  return text.split(eol).some((line) => /^\d+\t/.test(line)) ? false : null;
}

/**
 * Paths most like a missing one, best first: the same parent folders count most (from the file's own folder up).
 * @param {string} wanted the path asked for @param {string[]} found the candidates' paths @returns {string[]}
 */
function rankNearby(wanted, found) {
  const parts = (/** @type {string} */ p) => p.replace(/\\/g, "/").toLowerCase().split("/").filter(Boolean);
  const want = parts(wanted).slice(0, -1).reverse();
  const score = (/** @type {string} */ candidate) => {
    const have = parts(candidate).slice(0, -1).reverse();
    let same = 0;
    for (const folder of want) if (have.includes(folder)) same++;
    return same;
  };
  return [...new Set(found)].map((p, order) => ({ p, s: score(p), order }))
    .sort((a, b) => b.s - a.s || a.p.length - b.p.length || a.order - b.order).map((x) => x.p);
}

/**
 * The name a lookup means: "parseRow()" is parseRow, and "Parser.parse" (or Parser::parse, Parser#parse) is the
 * member, parse. @param {string} given
 */
function plainName(given) {
  const name = given.trim().replace(/\s*\(.*\)$/, "");
  const member = /^[\w$]+(?:\.|::|#)([\w$]+)$/.exec(name);
  return member ? member[1] : name;
}

/** Lines from..to (0-based, end excluded) as read_file shows them: number, tab, text (a long one cut). */
function numbered(/** @type {string[]} */ lines, /** @type {number} */ from, /** @type {number} */ to) {
  return lines.slice(from, to).map((line, k) => `${from + k + 1}\t${line.length > 300 ? line.slice(0, 300) + "…" : line}`).join("\n");
}

/** old_text found in several places: the first few, a line either side, so the next try can add what's unique. */
function aroundPlaces(/** @type {string} */ text, /** @type {number[]} */ at, /** @type {string} */ eol) {
  const lines = text.split(eol);
  return at.slice(0, MISS_PLACES).map((line) => numbered(lines, Math.max(0, line - 2), Math.min(lines.length, line + 1))).join("\n…\n");
}

/**
 * old_text with every line indented by the same amount more or less than the file's, matching in one place only.
 * @returns {{start: number, length: number, shift: {add?: string, remove?: string}} | null}
 */
function shiftedMatch(/** @type {string} */ text, /** @type {string} */ old, /** @type {string} */ eol) {
  const lines = text.split(eol);
  const want = old.split(eol).map((line) => line.trimEnd());
  const first = want.findIndex((line) => line);
  if (first < 0) return null;
  /** @type {{at: number, shift: any} | null} */
  let hit = null;
  for (let i = 0; i + want.length <= lines.length; i++) {
    const have = lines[i + first].trimEnd();
    if (have.trimStart() !== want[first].trimStart()) continue;
    const shift = shiftBetween(indentOf(want[first]), indentOf(have));
    if (!shift) continue;
    if (!want.every((line, k) => { const there = lines[i + k].trimEnd(); return line ? shiftLine(line, shift) === there : there === ""; })) continue;
    if (hit) return null; // more than one place: not a guess to make
    hit = { at: i, shift };
  }
  if (!hit) return null;
  const start = lines.slice(0, hit.at).reduce((sum, line) => sum + line.length + eol.length, 0);
  return { start, length: lines.slice(hit.at, hit.at + want.length).join(eol).length, shift: hit.shift };
}

function indentOf(/** @type {string} */ line) { return /^[ \t]*/.exec(line)?.[0] ?? ""; }

/** From old_text's indentation to the file's: a prefix to add, or one to take off. Tabs for spaces isn't a shift. */
function shiftBetween(/** @type {string} */ from, /** @type {string} */ to) {
  if (from === to) return null;
  if (to.endsWith(from)) return { add: to.slice(0, to.length - from.length) };
  if (from.endsWith(to)) return { remove: from.slice(0, from.length - to.length) };
  return null;
}

/** @param {string} line @param {{add?: string, remove?: string}} shift @returns {string | null} */
function shiftLine(line, shift) {
  if (shift.add !== undefined) return shift.add + line;
  return line.startsWith(/** @type {string} */ (shift.remove)) ? line.slice(/** @type {string} */ (shift.remove).length) : null;
}

/** new_text shifted as old_text was (blank lines left alone); null when a line can't be. @returns {string | null} */
function shiftLines(/** @type {string} */ text, /** @type {{add?: string, remove?: string}} */ shift, /** @type {string} */ eol) {
  const out = [];
  for (const line of text.split(eol)) {
    if (!line.trim()) { out.push(line); continue; }
    const moved = shiftLine(line, shift);
    if (moved === null) return null;
    out.push(moved);
  }
  return out.join(eol);
}

/**
 * old_text indented with spaces where the file has tabs, or with tabs where it has spaces: found by reading one tab as
 * 4 or 2 spaces (tabs to spaces: the file's own unit only), with new_text's indentation changed the same way. Every
 * indented line of both must convert (no mixes, no odd counts). Several readings that place it differently, or one
 * that matches several places, is a guess, and null, as when nothing matches.
 * @returns {{start: number, length: number, replaced: string, note: string} | null}
 */
function retabbedMatch(/** @type {string} */ shown, /** @type {string} */ text, /** @type {string} */ old, /** @type {string} */ replacement, /** @type {string} */ eol) {
  const indents = old.split(eol).filter((line) => line.trim()).map(indentOf).filter(Boolean);
  if (!indents.length) return null;
  const toTabs = indents.every((indent) => /^ +$/.test(indent));
  if (!toTabs && !indents.every((indent) => /^\t+$/.test(indent))) return null;
  let widths = [4, 2];
  if (!toTabs) {
    // The file's own unit: every line it indents with spaces by a multiple of 4, else of 2.
    const counts = text.split(eol).filter((line) => line.trim()).map(indentOf).filter((indent) => /^ +$/.test(indent)).map((indent) => indent.length);
    widths = !counts.length ? [] : counts.every((n) => n % 4 === 0) ? [4] : counts.every((n) => n % 2 === 0) ? [2] : [];
  }
  /** @type {({width: number, start: number, length: number, replaced: string, note: string} | null)[]} */
  const hits = [];
  for (const width of widths) {
    const was = retabLines(old, eol, width, toTabs);
    if (was === null || was === old) continue;
    const now = retabLines(replacement, eol, width, toTabs);
    let hit;
    try { hit = locate(shown, text, was, now ?? was, eol); } catch { hits.push(null); continue; } // in several places
    if (!hit) continue;
    hits.push(now === null ? null : { width, ...hit }); // new_text that can't be changed the same way: not a guess to make
  }
  if (!hits.length || hits.includes(null)) return null;
  const sure = /** @type {{width: number, start: number, length: number, replaced: string, note: string}[]} */ (hits);
  // Two readings (4 spaces a tab, or 2 and a level less): the one that needs no shift on top, or both the same edit.
  const plain = sure.filter((hit) => !hit.note);
  const pick = sure.length === 1 ? sure[0] : plain.length === 1 ? plain[0]
    : sure.every((hit) => hit.start === sure[0].start && hit.length === sure[0].length && hit.replaced === sure[0].replaced) ? sure[0] : null;
  if (!pick) return null;
  return { start: pick.start, length: pick.length, replaced: pick.replaced, note: " " + RESULTS.retabbed(pick.width, toTabs) + pick.note };
}

/** Each line's leading spaces as tabs (`width` a tab) or its tabs as spaces; blank lines left alone; null when a line can't be. */
function retabLines(/** @type {string} */ text, /** @type {string} */ eol, /** @type {number} */ width, /** @type {boolean} */ toTabs) {
  const out = [];
  for (const line of text.split(eol)) {
    const indent = indentOf(line);
    if (!indent || !line.trim()) { out.push(line); continue; }
    if (toTabs ? !/^ +$/.test(indent) || indent.length % width : !/^\t+$/.test(indent)) return null;
    out.push((toTabs ? "\t".repeat(indent.length / width) : " ".repeat(indent.length * width)) + line.slice(indent.length));
  }
  return out.join(eol);
}

/** @param {{add?: string, remove?: string}} shift @returns {[string, boolean]} the amount, in words, and whether old_text had less */
function describeShift(shift) {
  const chars = shift.add ?? shift.remove ?? "";
  const kind = /^ +$/.test(chars) ? "space" : /^\t+$/.test(chars) ? "tab" : "";
  const amount = kind ? `${chars.length} ${kind}${chars.length === 1 ? "" : "s"}` : "a mix of tabs and spaces";
  return [amount, shift.add !== undefined];
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

module.exports = { folderRules, giveRules, namedPaths, encodedLike, WorkspaceTools, ToolError, plainName, treeStamp, shiftedMatch, shiftLines, looseMatch, notFound, aroundPlaces, locate, withoutLineNumbers, rankNearby, rgGlob, folderEntries, plainNames, ownFile, runsPrograms, followedLater, planEdit, withContext, realPath, withoutSignatureLines, diskTextIfNewer, caseless, globPattern, walkFiles, around, aroundLongMatches, outlineEntries, parseStatus, parseNumstat, runGit, locations, positionOf };
