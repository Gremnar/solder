// @ts-check
"use strict";
/**
 * A task's changes as one entry a file: what Review all shows (no `vscode`, tested under node).
 *
 * Each step that changes something keeps a record (tools.js: the file, a copy of it from before, whether it was made,
 * moved, copied or removed). A step's own Review compares that step's copy with the file now, so a file edited five
 * times in a turn had five overlapping diffs, and a turn of twenty edits had twenty. Here the records of a turn are
 * folded into what happened to each file in the end: its state before the turn's first change, against the file now.
 */
const path = require("node:path");

/**
 * @typedef {{path: string, shown: string, kind: "edited" | "added" | "removed" | "moved", before: string | null,
 *   from?: string, fromShown?: string, folder?: boolean}} Entry
 *   path: where it is now (or was, when removed). before: the copy from before the turn's first change to it; null
 *   for something new, for a move that changed nothing in it, and when no copy was kept. from: where it was before a
 *   move in this turn.
 */

const keyOf = (/** @type {string} */ file) => path.resolve(file).toLowerCase();
const under = (/** @type {string} */ key, /** @type {string} */ folder) => key === folder || key.startsWith(folder.endsWith(path.sep) ? folder : folder + path.sep);

/**
 * @param {any[]} changes a turn's change records, in the order they were made (undone ones left out)
 * @returns {Entry[]} one for each file or folder the turn left changed, in the order first touched
 */
function netChanges(changes) {
  /** @type {Map<string, Entry>} by where each is now */
  const now = new Map();
  for (const change of changes) {
    if (!change || typeof change.path !== "string") continue;
    const key = keyOf(change.path);
    if (change.moved && typeof change.from === "string") {
      // What this turn already changed at the old place (the file itself, or files in a moved folder) goes with it.
      const old = keyOf(change.from);
      let itself = false;
      for (const [at, entry] of [...now.entries()]) {
        if (!under(at, old)) continue;
        now.delete(at);
        const rest = entry.path.slice(path.resolve(change.from).length);
        entry.path = path.resolve(change.path) + rest;
        entry.shown = String(change.shown) + rest.split(path.sep).join("/");
        if (at === old) { itself = true; entry.from ??= change.from; entry.fromShown ??= change.fromShown; }
        now.set(keyOf(entry.path), entry);
      }
      if (!itself) now.set(key, { path: change.path, shown: change.shown, kind: "moved", before: null, from: change.from, fromShown: change.fromShown, folder: !!change.folder });
      continue;
    }
    if (change.copied) {
      now.set(key, { path: change.path, shown: change.shown, kind: "added", before: null, folder: !!change.folder });
      continue;
    }
    if (change.removed) {
      const had = now.get(key);
      // What the turn changed inside a folder it then removed is gone with the folder.
      for (const at of [...now.keys()]) if (at !== key && under(at, key)) now.delete(at);
      if (had && had.kind === "added") { now.delete(key); continue; } // made and removed in the same turn: nothing happened
      now.set(key, { path: change.path, shown: change.shown, kind: "removed", before: had ? had.before : change.backup || null, folder: !!change.folder,
        ...(had?.from ? { from: had.from, fromShown: had.fromShown } : {}) });
      continue;
    }
    const had = now.get(key);
    if (!had) {
      now.set(key, { path: change.path, shown: change.shown, kind: change.created ? "added" : "edited", before: change.created ? null : change.backup || null });
    } else if (had.kind === "moved") {
      // Moved, then changed: the copy from before this change is the file as it was moved.
      had.kind = "edited";
      had.before = change.backup || null;
    } else if (had.kind === "removed") {
      had.kind = "edited"; // removed, then written again: against what it was before
    }
    // Otherwise its first copy stands: the file before the turn touched it.
  }
  return [...now.values()];
}

/** One line for an entry that has no diff to open (a move that changed nothing, a folder, no copy kept). @param {Entry} entry */
function describe(entry) {
  const what = entry.folder ? "the folder " : "";
  if (entry.kind === "moved") return `Moved ${what}${entry.fromShown || entry.from} to ${entry.shown}`;
  if (entry.kind === "removed") return `Removed ${what}${entry.shown}`;
  if (entry.kind === "added") return `Added ${what}${entry.shown}`;
  return `Changed ${entry.shown}`;
}

module.exports = { netChanges, describe };
