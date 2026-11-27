// @ts-check
"use strict";
/**
 * The docs index forgetting a folder: fast (each file's passages found by an index, not a scan of every passage), a
 * batch at a time with the window free in between, and carried on after a stop. A field report: a folder of 24,000
 * files, unlisted for 14 days, held the extension host for about an hour on every window load.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const docs = require("../src/docs.js");

/** A folder of `count` small text files, each with a few passages. @param {string} at @param {number} count */
function folderOf(at, count) {
  fs.mkdirSync(at, { recursive: true });
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(at, `note${i}.md`), `# Note ${i}\n\nThe pump ${i} runs at ${i * 3} rpm.\n\n# More ${i}\n\nValve ${i} closes at noon.\n`);
  }
  return at;
}

test("an index made before passages had an owner list gets it filled once, and keeps working", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "solder-owners-"));
  const file = path.join(base, "index", "docs.sqlite");
  const folder = folderOf(path.join(base, "docs"), 20);
  let index = new docs.DocsIndex(file);
  await index.refresh([folder]);
  index.close();
  // An older index: no owner list.
  const { DatabaseSync } = require("node:sqlite");
  const raw = new DatabaseSync(file);
  raw.exec("DROP TABLE owners");
  raw.close();
  index = new docs.DocsIndex(file);
  assert.ok((await index.search("pump 7 rpm")).length > 0, "search still finds a passage");
  const db = /** @type {any} */ (index)._open();
  const sections = Number(db.prepare("SELECT count(*) AS n FROM sections").get().n);
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM owners").get().n), sections, "every passage has its owner");
  // A changed file: its old passages are found through the list and replaced.
  fs.writeFileSync(path.join(folder, "note3.md"), "# Note 3\n\nThe pump 3 now runs at 999 rpm.\n");
  const later = Date.now() + 5000;
  fs.utimesSync(path.join(folder, "note3.md"), later / 1000, later / 1000);
  await index.refresh([folder]);
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM owners WHERE key = ?").get(docs.keyOf ? docs.keyOf(path.join(folder, "note3.md")) : path.join(folder, "note3.md").toLowerCase()).n), 1);
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM owners").get().n), Number(db.prepare("SELECT count(*) AS n FROM sections").get().n));
  index.close();
  fs.rmSync(base, { recursive: true, force: true });
});

test("a folder unlisted for 14 days is forgotten a batch at a time, the window free between batches, and carried on after a stop", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "solder-forget-"));
  const file = path.join(base, "index", "docs.sqlite");
  const old = folderOf(path.join(base, "old"), 900);
  const kept = folderOf(path.join(base, "kept"), 5);
  const index = new docs.DocsIndex(file);
  await index.refresh([old, kept], { ms: 600_000 });
  const db = /** @type {any} */ (index)._open();
  const oldKey = db.prepare("SELECT DISTINCT root FROM files").all().map((/** @type {any} */ r) => String(r.root)).find((/** @type {string} */ r) => r.endsWith("old"));
  assert.ok(oldKey, "the old folder is in the index");
  // Unlisted for 15 days.
  db.prepare("UPDATE roots SET seen = ? WHERE root = ?").run(Date.now() - 15 * 24 * 60 * 60 * 1000, oldKey);

  // The window stays free: the longest gap between timer ticks while it forgets is short.
  let last = Date.now();
  let longest = 0;
  const tick = setInterval(() => { const now = Date.now(); longest = Math.max(longest, now - last); last = now; }, 5);
  // A refresh that runs out of time partway: what's done is kept.
  const stop = new AbortController();
  const first = index.refresh([kept], { ms: 600_000, signal: stop.signal });
  setTimeout(() => stop.abort(), 1);
  await first.catch(() => {});
  const left = Number(db.prepare("SELECT count(*) AS n FROM files WHERE root = ?").get(oldKey).n);
  assert.ok(left < 900, `some files were forgotten before the stop (${left} left)`);
  // The next refresh carries on, and finishes.
  await index.refresh([kept], { ms: 600_000 });
  clearInterval(tick);
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM files WHERE root = ?").get(oldKey).n), 0, "the old folder's files are gone");
  assert.equal(db.prepare("SELECT 1 FROM roots WHERE root = ?").get(oldKey), undefined, "and its root");
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM sections").get().n), Number(db.prepare("SELECT count(*) AS n FROM owners").get().n), "no passage left without its owner, or the other way");
  assert.ok((await index.search("pump 2 rpm")).length > 0, "the kept folder still searches");
  assert.ok(longest < 1000, `the window was held for ${longest} ms at most`);
  index.close();
  fs.rmSync(base, { recursive: true, force: true });
});
