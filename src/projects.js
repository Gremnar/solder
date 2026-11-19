// @ts-check
"use strict";
/**
 * Projects: a folder you work in, with what goes with it kept in the folder itself, so it can be copied, zipped or
 * committed and work the same for someone else:
 *
 *     MyProject\
 *       AGENTS.md              the project's rules (an instruction file, as anywhere)
 *       .solder\
 *         project.json         {"name": "My project", "skills": {"ps_scripts": false}}   its name, and skills switched on or off in it
 *         skills\*.md          skills only this project's chats are offered
 *
 * The folder is the only place a project is kept. Solder itself remembers just which project folders you use
 * (ProjectList: a small JSON file in its own storage), and each chat remembers its project's folder. Chats are not
 * in the folder: they stay in your VS Code profile.
 *
 * A project made by someone else brings instructions written by them (its rules and skills), so one is only used
 * once you've said so: being on your list is that yes. Nothing in a project folder can change a setting; its skill
 * switches say which skills its own chats are offered, and nothing else.
 * No vscode here: tested under node.
 */
const fs = require("node:fs");
const path = require("node:path");
const { listSkills } = require("./skills.js");
const { filesUnder } = require("./zip.js");

const DIR = ".solder";
const FILE = "project.json";
const SKILLS = "skills";
const MAX_NAME_CHARS = 60;
/** What's read of a project's rules file (as the panel reads a workspace's). */
const MAX_RULES_CHARS = 40_000;
const MAX_PROJECT_FILE_BYTES = 64 * 1024;

/** A project folder as its key: the same folder however it's spelt. @param {string} folder */
function projectKey(folder) {
  return path.resolve(String(folder || "")).replace(/[\\/]+$/, "").toLowerCase();
}

/** Where a project's skills are. @param {string} folder */
function skillsFolder(folder) {
  return path.join(folder, DIR, SKILLS);
}

/** Why a project's name won't do, or "". @param {string} name */
function nameProblem(name) {
  const text = String(name ?? "").trim();
  if (!text) return "Give the project a name.";
  if (text.length > MAX_NAME_CHARS) return `A project's name can be up to ${MAX_NAME_CHARS} characters.`;
  if (/[\u0000-\u001f]/.test(text)) return "A project's name is one line of plain text.";
  return "";
}

/** A file that really is in the folder (links followed), so a link by a rule file's name can't bring in another file. */
function ownFile(file, folder) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    const real = fs.realpathSync.native(file).toLowerCase();
    const home = fs.realpathSync.native(folder).toLowerCase().replace(/[\\/]+$/, "");
    return real.startsWith(home + path.sep);
  } catch { return false; }
}

/** Whether a folder is a project (it has a readable .solder\project.json). @param {string} folder */
function isProject(folder) {
  return readName(folder) !== null;
}

/** A project's name from its file: null when the folder isn't a project. @param {string} folder @returns {string | null} */
function readName(folder) {
  const file = path.join(folder, DIR, FILE);
  try {
    if (!ownFile(file, folder) || fs.statSync(file).size > MAX_PROJECT_FILE_BYTES) return null;
    const data = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const name = typeof data.name === "string" ? data.name.replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, MAX_NAME_CHARS) : "";
    return name || path.basename(path.resolve(folder)) || "Project";
  } catch { return null; }
}

/**
 * A project, read from its folder: its name, its rules (the instruction files at its top) and its skills.
 * @param {string} folder @param {string[]} [ruleNames] the instruction file names looked for (plain names)
 * @returns {{path: string, name: string, rules: {name: string, text: string, cut: boolean}[], skills: import("./skills.js").Skill[],
 *            skillsFolder: string} | null} null when the folder isn't a project (any more)
 */
function readProject(folder, ruleNames = ["AGENTS.md"]) {
  const full = path.resolve(folder);
  const name = readName(full);
  if (name === null) return null;
  const rules = [];
  for (const rule of ruleNames) {
    if (!/^[^\\/:]+$/.test(rule) || rule === "." || rule === "..") continue;
    const file = path.join(full, rule);
    if (!ownFile(file, full)) continue;
    try {
      const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
      if (text.trim()) rules.push({ name: rule, text: text.slice(0, MAX_RULES_CHARS), cut: text.length > MAX_RULES_CHARS });
    } catch { /* unreadable: left out */ }
  }
  const skillsAt = skillsFolder(full);
  let skills = [];
  try { if (fs.statSync(skillsAt).isDirectory()) skills = listSkills([skillsAt]); } catch { /* none yet */ }
  return { path: full, name, rules, skills, skillsFolder: skillsAt };
}

/**
 * Make a folder a project (its .solder folder, with its name and a place for skills). A folder that's one already
 * is left exactly as it is. @param {string} folder @param {string} [name] the folder's own name when not given
 * @returns {{path: string, name: string, existed: boolean}}
 */
function createProject(folder, name) {
  const full = path.resolve(folder);
  if (!fs.statSync(full).isDirectory()) throw new Error("That isn't a folder.");
  const had = readName(full);
  if (had !== null) return { path: full, name: had, existed: true };
  const given = String(name ?? "").trim() || path.basename(full) || "Project";
  const problem = nameProblem(given);
  if (problem) throw new Error(problem);
  fs.mkdirSync(skillsFolder(full), { recursive: true });
  writeFile(full, { name: given });
  return { path: full, name: given, existed: false };
}

/** @param {string} folder @param {string} name */
function renameProject(folder, name) {
  const full = path.resolve(folder);
  if (readName(full) === null) throw new Error("That folder isn't a project any more.");
  const problem = nameProblem(name);
  if (problem) throw new Error(problem);
  let data = {};
  try { data = JSON.parse(fs.readFileSync(path.join(full, DIR, FILE), "utf8").replace(/^\uFEFF/, "")) || {}; } catch { data = {}; }
  writeFile(full, { ...(typeof data === "object" && !Array.isArray(data) ? data : {}), name: String(name).trim() });
}

/** Written whole to a temporary file first, so a crash never leaves half a project file. */
function writeFile(folder, data) {
  const file = path.join(folder, DIR, FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(file + ".tmp", file);
}

/**
 * The project a folder is in: the folder itself or the nearest one above it that's a project ("" for none).
 * @param {string} folder @returns {string}
 */
function nearestProject(folder) {
  let at = path.resolve(folder);
  for (let depth = 0; depth < 64; depth++) {
    if (isProject(at)) return at;
    const up = path.dirname(at);
    if (up === at) return "";
    at = up;
  }
  return "";
}

/**
 * Projects in or just under these folders (a window's): each folder itself or the nearest project above it, and the
 * folders directly inside it. Looked for without holding anything up: every step is asynchronous, a few at a time, and
 * it gives up at `ms`. On a network drive, hundreds of folders are hundreds of round trips; done in one go, as this
 * was, that froze the Projects screen for seconds as it opened.
 * @param {string[]} folders @param {{ms?: number, signal?: AbortSignal}} [options] @returns {Promise<{path: string, name: string}[]>}
 */
async function findProjects(folders, options = {}) {
  const until = Date.now() + (options.ms ?? 15_000);
  const over = () => Date.now() > until || !!options.signal?.aborted;
  const marked = async (/** @type {string} */ folder) => {
    try { return (await fs.promises.stat(path.join(folder, DIR, FILE))).isFile(); } catch { return false; }
  };
  /** @type {string[]} */
  const candidates = [];
  for (const folder of folders) {
    if (!folder || over()) continue;
    // The folder, or the nearest one above it that's a project.
    let at = path.resolve(folder);
    for (let depth = 0; depth < 64 && !over(); depth++) {
      if (await marked(at)) { candidates.push(at); break; }
      const up = path.dirname(at);
      if (up === at) break;
      at = up;
    }
    let inside = [];
    try {
      inside = (await fs.promises.readdir(folder, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules").slice(0, 300).map((entry) => path.join(folder, entry.name));
    } catch { inside = []; }
    for (let index = 0; index < inside.length && !over(); index += 16) {
      const batch = inside.slice(index, index + 16);
      const hits = await Promise.all(batch.map(marked));
      batch.forEach((dir, n) => { if (hits[n]) candidates.push(dir); });
    }
  }
  /** @type {{path: string, name: string}[]} */
  const found = [];
  for (const folder of candidates) {
    // Read properly (the file is the folder's own, and says it's a project), each once.
    if (found.some((item) => projectKey(item.path) === projectKey(folder))) continue;
    const name = readName(folder);
    if (name !== null) found.push({ path: path.resolve(folder), name });
  }
  return found;
}

/** Folders left out of a whole-folder export: git's own store and installed packages, which are big and remade elsewhere. */
const EXPORT_SKIP = new Set([".git", "node_modules"]);

/**
 * What goes in a project's export, as entries for a zip, all under the folder's own name (so unzipping gives the
 * folder back). "own": the project's own files alone, its rules (the instruction files at its top) and its .solder
 * folder. "all": everything in the folder but git's store and node_modules. Links and junctions are never followed.
 * @param {string} folder @param {"own" | "all"} what @param {string[]} [ruleNames] @param {{limit?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<{entries: {name: string, file: string}[], tooMany: boolean, top: string}>}
 */
async function exportEntries(folder, what, ruleNames = ["AGENTS.md"], options = {}) {
  const full = path.resolve(folder);
  if (readName(full) === null) throw new Error("That folder isn't a project any more.");
  const top = path.basename(full).replace(/[\\/:*?"<>|]/g, "_") || "project";
  if (what === "all") {
    const listed = await filesUnder(full, top, { skip: (name) => EXPORT_SKIP.has(name.toLowerCase()), limit: options.limit, signal: options.signal });
    return { ...listed, top };
  }
  /** @type {{name: string, file: string}[]} */
  const entries = [];
  for (const rule of ruleNames) {
    if (!/^[^\\/:]+$/.test(rule) || rule === "." || rule === "..") continue;
    const file = path.join(full, rule);
    if (ownFile(file, full)) entries.push({ name: `${top}/${rule}`, file });
  }
  const own = await filesUnder(path.join(full, DIR), `${top}/${DIR}`, { limit: options.limit, signal: options.signal });
  return { entries: [...entries, ...own.entries], tooMany: own.tooMany, top };
}

/**
 * The project folders you use, in the order added: a small JSON file in Solder's own storage. Being on it is your yes
 * to a project's rules and skills. A file that can't be read is an empty list; saving can fail quietly (the list
 * lives on in memory).
 */
class ProjectList {
  /** @param {string} file */
  constructor(file) {
    this.file = file;
    /** @type {{path: string, added: number}[]} */
    this.items = this._load();
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const seen = new Set();
      return (Array.isArray(data?.projects) ? data.projects : [])
        .filter((item) => item && typeof item.path === "string" && item.path.trim() && path.isAbsolute(item.path))
        .map((item) => ({ path: path.resolve(item.path), added: Number(item.added) || 0 }))
        .filter((item) => !seen.has(projectKey(item.path)) && seen.add(projectKey(item.path)));
    } catch { return []; }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + ".tmp", JSON.stringify({ projects: this.items }, null, 2), "utf8");
      fs.renameSync(this.file + ".tmp", this.file);
    } catch { /* kept in memory */ }
  }

  /** @param {string} folder */
  has(folder) { const key = projectKey(folder); return !!folder && this.items.some((item) => projectKey(item.path) === key); }

  /** The folders, in the order added. */
  paths() { return this.items.map((item) => item.path); }

  /** @param {string} folder @returns {boolean} whether it was new */
  add(folder) {
    if (this.has(folder)) return false;
    this.items.push({ path: path.resolve(folder), added: Date.now() });
    this._save();
    return true;
  }

  /** Off the list (the folder and its files are left as they are). @param {string} folder */
  remove(folder) {
    const key = projectKey(folder);
    const before = this.items.length;
    this.items = this.items.filter((item) => projectKey(item.path) !== key);
    if (this.items.length !== before) this._save();
  }
}

const MAX_SWITCHES = 500;
const MAX_SWITCH_NAME = 200;
/**
 * What's in a project's file, as an object: null when the folder isn't a project (no file, not the folder's own, too
 * big, or not an object). @param {string} folder @returns {Record<string, any> | null}
 */
function readData(folder) {
  const file = path.join(folder, DIR, FILE);
  try {
    if (!ownFile(file, folder) || fs.statSync(file).size > MAX_PROJECT_FILE_BYTES) return null;
    const text = fs.readFileSync(file, "utf8");
    const data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch { return null; }
}

/**
 * A project's skill switches: skills switched on or off in this project's chats, whatever they are everywhere else.
 * They're in the project's file, so they travel with it. All they decide is which skills this project's chats are
 * offered: they can't change a setting, and the organization's skills stay on whatever they say.
 * @param {string} folder @returns {Record<string, boolean>} by lower-case skill name ({} when there are none, or it isn't a project)
 */
function projectSwitches(folder) {
  return switchesFrom(readData(path.resolve(folder))?.skills);
}

/**
 * Set a skill's switch in a project, or take it away (null: the skill is as it is everywhere). The rest of the file is
 * kept as it is. @param {string} folder @param {string} name @param {boolean | null} on
 */
function setProjectSwitch(folder, name, on) {
  const full = path.resolve(folder);
  const data = readData(full);
  const skill = String(name).trim().toLowerCase();
  if (!data) throw new Error("That folder isn't a project any more.");
  if (!skill || skill.length > MAX_SWITCH_NAME) return;
  const switches = { ...switchesFrom(data.skills) };
  if (on === null) delete switches[skill];
  else if (Object.keys(switches).length < MAX_SWITCHES || skill in switches) switches[skill] = !!on;
  const next = { ...data };
  if (Object.keys(switches).length) next.skills = switches; else delete next.skills;
  writeFile(full, next);
}

/** The switches in a project's file: names with true or false, nothing else. @param {unknown} value @returns {Record<string, boolean>} */
function switchesFrom(value) {
  /** @type {Record<string, boolean>} */
  const out = Object.create(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [name, on] of Object.entries(value).slice(0, MAX_SWITCHES)) {
    const key = name.trim().toLowerCase();
    if (key && key.length <= MAX_SWITCH_NAME && typeof on === "boolean") out[key] = on;
  }
  return out;
}

module.exports = { ProjectList, projectSwitches, setProjectSwitch, findProjects, exportEntries, projectLabel: readName, readProject, createProject, renameProject, nearestProject, isProject, nameProblem, projectKey, skillsFolder,
  DIR, MAX_NAME_CHARS };
