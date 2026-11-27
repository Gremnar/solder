// @ts-check
"use strict";
/**
 * The docs folder walk leaves out what can't be a document: files with a binary extension (build output among them)
 * and folders that say they're a cache (CACHEDIR.TAG, as Rust's target folder has). They're not looked at, not in the
 * index's file list, and not counted toward a folder's limit; one already in an index made before goes on the next
 * refresh.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const docs = require("../src/docs.js");

test("binaries and cache folders are left out of the docs index, and one already in it goes on the next refresh", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "solder-binary-"));
  const root = path.join(base, "work");
  const write = (/** @type {string} */ name, /** @type {string | Buffer} */ data) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), data);
  };
  write("notes.md", "# Pump notes\n\nThe pump runs at 900 rpm.\n");
  write("dist/readme.md", "# Release notes\n\nVersion 2 adds the valve test.\n");
  write("lib/libcore.rlib", Buffer.from([0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e, 0x0a, 0, 1, 2]));
  write("build/app.o", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0]));
  write("target/CACHEDIR.TAG", "Signature: 8a477f597d28d172789f06886806bc55\n");
  write("target/debug/build-notes.md", "# Build notes\n\nThe compressor log says zebra.\n");
  const index = new docs.DocsIndex(path.join(base, "index", "docs.sqlite"));
  await index.refresh([root], { ms: 600_000 });
  const db = /** @type {any} */ (index)._open();
  const listed = () => db.prepare("SELECT key FROM files").all().map((/** @type {any} */ r) => path.basename(String(r.key))).sort();
  assert.deepEqual(listed(), ["notes.md", "readme.md"], "only the documents are in the index's file list");
  assert.equal((await index.search("zebra")).length, 0, "nothing from the cache folder");
  assert.ok((await index.search("pump rpm")).length > 0, "the documents still search");

  // An index made before these rules held a binary: the next full refresh leaves it out.
  const stale = path.join(root, "build", "app.o");
  db.prepare("INSERT INTO files (key, root, stamp) VALUES (?, ?, ?)").run(stale.toLowerCase(), db.prepare("SELECT DISTINCT root FROM files").get().root, "0:0");
  /** @type {any} */ (index).walked = new Map(); // walked again now, not after the usual wait
  await index.refresh([root], { ms: 600_000 });
  assert.deepEqual(listed(), ["notes.md", "readme.md"], "the binary from before is gone");
  index.close();
  fs.rmSync(base, { recursive: true, force: true });
});
