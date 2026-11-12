// @ts-check
"use strict";
/**
 * Skills: instructions for a kind of task, one Markdown file each, named after the skill (python_scripts.md),
 * in the skills folders (the user's, and any the organisation sets). The model is told each skill's name, path
 * and when to use it; it reads one with read_file before starting a task it covers, and that read comes back
 * whole and stays in the chat (see WorkspaceTools.readFile). There's no skill tool: read_file is enough.
 *
 * A skill says when to use it on its first line:
 *
 *     When to use: Writing or changing a PowerShell script.
 *
 *     The instructions...
 *
 * (Alloy's one-file skills are the same.) A file that starts with a front-matter block (---) gives it as
 * description: instead, as Claude's and Codex's SKILL.md files do; the block is left out of what the model reads.
 *
 * Only .md files directly in a skills folder are skills: no subfolders, no scripts (Solder runs nothing).
 * Every call reads the folders afresh, so a skill added or edited counts from the next message.
 * No vscode here: tested under node.
 */
const fs = require("node:fs");
const path = require("node:path");

const SUFFIX = ".md";
const WHEN_LEAD = "when to use:";
/** Skills named to the model; past this, the rest are left out of the list (and flagged in Settings). */
const MAX_SKILLS = 50;
/** A "when" longer than this is shortened in the list. */
const MAX_WHEN_CHARS = 300;
/** What the model reads of a skill: it stays in the chat for every later request, so it's kept short. */
const MAX_SKILL_CHARS = 20_000;
/** A file bigger than this isn't read at all (it isn't a skill someone wrote). */
const MAX_FILE_BYTES = 1024 * 1024;

/**
 * @typedef {{name: string, when: string, text: string, path: string, cut: boolean, problem: string}} Skill
 *   when: "" when the file doesn't say (the skill is still listed, by name); text: the instructions, front
 *   matter and When line left out, at most MAX_SKILL_CHARS; cut: the file was longer than that;
 *   problem: why it can't be used, or a warning for Settings ("" when there's none)
 */

/**
 * A skill file's text: when to use it, and its instructions.
 * @param {string} raw @returns {{when: string, text: string}}
 */
function parse(raw) {
  let text = String(raw).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  let when = "";
  // Front matter: a --- line, then lines up to the next --- line, every one of them "key: value" (or indented, or
  // blank): a skill that just opens with a --- rule isn't front matter.
  const front = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (front && front[1].split("\n").every((line) => !line.trim() || /^\s/.test(line) || /^[A-Za-z_][\w-]*\s*:/.test(line))) {
    when = frontDescription(front[1]);
    text = text.slice(front[0].length);
  }
  text = text.replace(/^\s*\n/, "");
  const first = text.split("\n", 1)[0];
  if (first.trim().toLowerCase().startsWith(WHEN_LEAD)) {
    if (!when) when = first.trim().slice(WHEN_LEAD.length);
    text = text.slice(first.length);
  }
  return { when: oneLine(when), text: text.trim() };
}

/** The description: in a front-matter block, plain, quoted, or folded over the lines below it. @param {string} block */
function frontDescription(block) {
  const lines = block.split("\n");
  const at = lines.findIndex((line) => /^description\s*:/i.test(line));
  if (at < 0) return "";
  let value = lines[at].replace(/^description\s*:/i, "").trim();
  if (/^[>|][+-]?$/.test(value) || value === "") {
    // A block scalar (> or |), or the value on the indented lines below.
    const more = [];
    for (const line of lines.slice(at + 1)) {
      if (!/^\s+\S/.test(line) && line.trim() !== "") break;
      more.push(line.trim());
    }
    value = more.join(" ");
  }
  const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
  return quoted ? quoted[2].replace(quoted[1] === "'" ? /''/g : /\\"/g, quoted[1]) : value;
}

/** @param {string} text */
function oneLine(text) {
  const line = String(text).replace(/\s+/g, " ").trim();
  return line.length > MAX_WHEN_CHARS ? line.slice(0, MAX_WHEN_CHARS - 1).trimEnd() + "…" : line;
}

/** A skill's name, from its file's: the name without .md. @param {string} file */
function nameOf(file) {
  return path.basename(file).slice(0, -SUFFIX.length).trim();
}

/** Whether a folder entry is a skill's file by its name: .md, and not hidden or a temporary file. @param {string} entry */
function isSkillFile(entry) {
  return entry.toLowerCase().endsWith(SUFFIX) && entry.length > SUFFIX.length && !/^[.~]/.test(entry);
}

/**
 * One skill file, read. A file that can't be read (or is far too big) comes back with a problem and no text.
 * @param {string} file the full path @returns {Skill}
 */
function readSkill(file) {
  const name = nameOf(file);
  /** @type {Skill} */
  const skill = { name, when: "", text: "", path: file, cut: false, problem: "" };
  let raw;
  try {
    const size = fs.statSync(file).size;
    if (size > MAX_FILE_BYTES) return { ...skill, problem: "It's over 1 MB, so it isn't read: a skill should be a page or two." };
    raw = fs.readFileSync(file);
  } catch (error) {
    return { ...skill, problem: `It can't be read (${/** @type {any} */ (error)?.code || "error"}).` };
  }
  // UTF-16 with its byte-order mark (Notepad's "Unicode"), otherwise UTF-8.
  const decoded = raw[0] === 0xff && raw[1] === 0xfe ? raw.toString("utf16le") : raw.toString("utf8");
  const { when, text } = parse(decoded);
  const cut = text.length > MAX_SKILL_CHARS;
  return { ...skill, when, text: cut ? text.slice(0, MAX_SKILL_CHARS) : text, cut,
    problem: !text ? "It has no instructions." : !when ? "It has no \"When to use:\" line, so the model isn't told about it. Add one as its first line." : "" };
}

/**
 * Every skill in these folders, in folder order, then by name. A name that's in an earlier folder too (the
 * organisation's come first) is left out. Folders that aren't there are skipped.
 * @param {string[]} folders full paths @returns {Skill[]}
 */
function listSkills(folders) {
  /** @type {Skill[]} */
  const found = [];
  const names = new Set();
  for (const folder of folders) {
    let entries;
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { continue; }
    const files = entries.filter((entry) => entry.isFile() && isSkillFile(entry.name)).map((entry) => entry.name)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    for (const entry of files) {
      const key = nameOf(entry).toLowerCase();
      if (!key || names.has(key)) continue;
      names.add(key);
      found.push(readSkill(path.join(folder, entry)));
    }
  }
  return found;
}

/**
 * The skill a file is, if it's one: a .md file directly in one of the skills folders. Paths are compared as
 * given (callers pass real paths, so a junction can't make something else look like a skill).
 * @param {string[]} folders @param {string} file @returns {boolean}
 */
function isSkill(folders, file) {
  if (!isSkillFile(path.basename(file))) return false;
  const parent = path.dirname(file).toLowerCase();
  return folders.some((folder) => path.resolve(folder).toLowerCase() === parent);
}

/**
 * Whether the model is told about a skill: it has instructions, and says when to use it. A file with no "when" is
 * left out (a README or notes in the same folder would otherwise be offered by name); it's still read as a skill
 * when asked for by path, and Settings says what's missing.
 * @param {Skill} skill
 */
function offered(skill) {
  return !!skill.text && !!skill.when;
}

module.exports = { offered, parse, readSkill, listSkills, isSkill, nameOf, MAX_SKILLS, MAX_WHEN_CHARS, MAX_SKILL_CHARS, MAX_FILE_BYTES };
