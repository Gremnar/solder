// @ts-check
"use strict";
// node --test   (or, with no Node installed: $env:ELECTRON_RUN_AS_NODE=1; & code.exe --test test)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const docs = require("../src/docs.js");

/** A stand-in embeddings model: one dimension per concept (as in docs.test.js). */
const CONCEPTS = [["password", "credential", "passphrase"], ["reset", "recovery", "restore"], ["printer", "print", "spooler"],
  ["backup", "copy", "robocopy"]];
/** @param {string[]} texts @param {number | null} [tokens] the gateway's count (null: its own) */
function fakeEmbed(texts, tokens = null) {
  const vectors = texts.map((text) => {
    const words = text.toLowerCase().match(/[a-z]+/g) || [];
    return CONCEPTS.map((group) => words.filter((word) => group.includes(word)).length + 0.01);
  });
  return Promise.resolve({ vectors, tokens: tokens ?? texts.join(" ").split(/\s+/).length });
}

// ---------------------------------------------------------------- 5: two windows, one index file --

test("search by meaning sees another window's reindex: the vectors in memory follow the shared file", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "solder-two-windows-"));
  const folder = path.join(base, "docs");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "accounts.md"), "# Credential recovery\nHow a user account gets its passphrase restored.");
  fs.writeFileSync(path.join(folder, "printers.md"), "# Printers\nRestart the spooler when a print job hangs.");
  fs.writeFileSync(path.join(folder, "backups.md"), "# Backups\nThe nightly robocopy job copies the share.");
  const file = path.join(base, "index", "docs.sqlite");
  const one = new docs.DocsIndex(file);
  const two = new docs.DocsIndex(file);
  const embed = { model: "embed-a", fn: (/** @type {string[]} */ texts) => fakeEmbed(texts) };
  try {
    await one.refresh([folder], { ms: 20_000, embed });
    const [query] = (await fakeEmbed(["print spooler"])).vectors;
    assert.equal(two.nearest(query, "embed-a", 10).length, 3, "window two loads the vectors");
    // Window one drops a file (and its vector): window two's next search mustn't use the old snapshot.
    fs.rmSync(path.join(folder, "printers.md"));
    await one.refresh([folder], { ms: 20_000, embed });
    assert.equal(one.nearest(query, "embed-a", 10).length, 2);
    assert.equal(two.nearest(query, "embed-a", 10).length, 2, "window two sees the change");
    // Nothing changed: the snapshot is kept (the same object).
    const kept = two.loaded;
    two.nearest(query, "embed-a", 10);
    assert.equal(two.loaded, kept);
    // Closed: the snapshot goes with the connection.
    two.close();
    assert.equal(two.loaded, null);
    assert.equal(two.nearest(query, "embed-a", 10).length, 2);
  } finally {
    one.close();
    two.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 6: a gateway that gives no token count --

test("a gateway that sends vectors without a token count still spends from today's budget (four characters a token)", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "solder-no-usage-"));
  const folder = path.join(base, "docs");
  fs.mkdirSync(folder);
  for (let n = 0; n < 40; n++) fs.writeFileSync(path.join(folder, `n${n}.md`), `# Note ${n}\n\nSome text about topic ${n}, long enough to be a passage of its own.\n`);
  const index = new docs.DocsIndex(path.join(base, "index", "docs.sqlite"));
  let spent = 0;
  /** @type {number[]} */
  const batches = [];
  const embed = { model: "embed-a", fn: (/** @type {string[]} */ texts) => fakeEmbed(texts, 0), left: () => 10 - spent,
    spend: (/** @type {number} */ tokens) => { spent += tokens; batches.push(tokens); } };
  try {
    await index.refresh([folder], { ms: 20_000, embed });
    const partway = index.vectorCount("embed-a");
    assert.ok(partway.embedded > 0 && partway.embedded < partway.passages, `one batch, then paused: ${partway.embedded} of ${partway.passages}`);
    assert.equal(index.embedding.paused, true);
    assert.equal(batches.length, 1);
    assert.ok(batches[0] > 32 * 10, `the batch's characters / 4: ${batches[0]}`);
    assert.equal(index.embedding.tokens, 0, "what's shown as the gateway's count stays the gateway's count");
  } finally {
    index.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the gateway's own token count is what's spent when it gives one", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "solder-usage-"));
  const folder = path.join(base, "docs");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "a.md"), "# A\nSome text.");
  const index = new docs.DocsIndex(path.join(base, "index", "docs.sqlite"));
  /** @type {number[]} */
  const batches = [];
  const embed = { model: "embed-a", fn: (/** @type {string[]} */ texts) => fakeEmbed(texts, 7), spend: (/** @type {number} */ tokens) => { batches.push(tokens); } };
  try {
    await index.refresh([folder], { ms: 20_000, embed });
    assert.deepEqual(batches, [7]);
  } finally {
    index.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
