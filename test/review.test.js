// @ts-check
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { netChanges, describe } = require("../src/review.js");

const W = path.resolve("C:/work");
const at = (/** @type {string} */ name) => path.join(W, name);
const edit = (/** @type {string} */ name, /** @type {string} */ backup) => ({ path: at(name), shown: name, backup, created: false, after: "h" });
const made = (/** @type {string} */ name) => ({ path: at(name), shown: name, backup: "", created: true });
const moved = (/** @type {string} */ from, /** @type {string} */ to, folder = false) => ({ path: at(to), shown: to, from: at(from), fromShown: from, moved: true, copied: false, folder });
const copied = (/** @type {string} */ from, /** @type {string} */ to) => ({ path: at(to), shown: to, from: at(from), fromShown: from, moved: false, copied: true, folder: false });
const removed = (/** @type {string} */ name, /** @type {string} */ backup, folder = false) => ({ path: at(name), shown: name, backup, removed: true, folder });
const brief = (/** @type {any[]} */ entries) => entries.map((e) => `${e.kind} ${e.shown} <${e.before ? path.basename(e.before) : "-"}>` + (e.fromShown ? ` from ${e.fromShown}` : ""));

test("a turn's changes, one entry a file: many edits to a file are one, against the copy from before the first", () => {
  const entries = netChanges([edit("a.js", "b1"), edit("b.js", "b2"), edit("a.js", "b3"), edit("a.js", "b4")]);
  assert.deepEqual(brief(entries), ["edited a.js <b1>", "edited b.js <b2>"]);
  assert.deepEqual(brief(netChanges([made("new.js"), edit("new.js", "b1")])), ["added new.js <->"], "made, then edited: still new");
  assert.deepEqual(netChanges([]), []);
  assert.deepEqual(netChanges([null, {}, { path: 3 }]), [], "records that aren't changes are passed over");
});

test("moved, copied and removed: each file ends as what happened to it in the end", () => {
  // Moved and nothing else: no diff, a line saying so.
  let entries = netChanges([moved("old.js", "lib/new.js")]);
  assert.deepEqual(brief(entries), ["moved lib/new.js <-> from old.js"]);
  assert.equal(describe(entries[0]), "Moved old.js to lib/new.js");
  // Edited, then moved: it's at its new place, against the copy from before the edit.
  assert.deepEqual(brief(netChanges([edit("a.js", "b1"), moved("a.js", "lib/a.js")])), ["edited lib/a.js <b1> from a.js"]);
  // Moved, then edited: against the file as it was moved.
  assert.deepEqual(brief(netChanges([moved("a.js", "lib/a.js"), edit("lib/a.js", "b2")])), ["edited lib/a.js <b2> from a.js"]);
  // A folder moved after files in it were edited: they're found under its new name.
  entries = netChanges([edit("src/a.js", "b1"), edit("src/deep/b.js", "b2"), moved("src", "lib", true)]);
  assert.deepEqual(brief(entries).sort(), ["edited lib/a.js <b1>", "edited lib/deep/b.js <b2>", "moved lib <-> from src"].sort());
  assert.equal(entries.find((e) => e.kind === "moved")?.folder, true);
  assert.equal(path.resolve(entries.find((e) => e.shown === "lib/deep/b.js")?.path || ""), at("lib/deep/b.js"));
  // A copy is something new.
  assert.deepEqual(brief(netChanges([copied("a.js", "a-copy.js")])), ["added a-copy.js <->"]);
  // Removed: against its copy. Edited then removed: against the copy from before the edit.
  assert.deepEqual(brief(netChanges([removed("gone.js", "r1")])), ["removed gone.js <r1>"]);
  assert.deepEqual(brief(netChanges([edit("a.js", "b1"), removed("a.js", "r1")])), ["removed a.js <b1>"]);
  // Made and removed in the same turn: nothing to show. Removed and written again: a change to what it was.
  assert.deepEqual(netChanges([made("tmp.js"), edit("tmp.js", "b1"), removed("tmp.js", "r1")]), []);
  assert.deepEqual(brief(netChanges([removed("a.js", "r1"), made("a.js")])), ["edited a.js <r1>"]);
  // A folder removed takes what the turn changed inside it out of the list.
  entries = netChanges([edit("old/a.js", "b1"), made("old/b.js"), removed("old", "r9", true)]);
  assert.deepEqual(brief(entries), ["removed old <r9>"]);
  assert.equal(describe(entries[0]), "Removed the folder old");
});

test("the same file under another spelling is the same file", () => {
  const entries = netChanges([edit("Src/App.js", "b1"), { path: at("src/app.js").toUpperCase(), shown: "src/app.js", backup: "b2", created: false }]);
  assert.equal(entries.length, 1);
  assert.equal(path.basename(String(entries[0].before)), "b1");
});
