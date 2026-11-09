// @ts-check
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ChatStore, adoptChats } = require("../src/store.js");

const chat = (/** @type {string} */ id, /** @type {any} */ more = {}) =>
  ({ id, title: id, created: 1, updated: 1, messages: [{ role: "user", content: "hi" }], compaction: null, usage: { tokens: 0 }, ...more });

test("a window lists the chats of its folders, whichever window they were started in", async () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "solder-store-"));
  try {
    let roots = ["S:\\repo"];
    const store = new ChatStore(top, { homes: () => roots, homeOf: () => roots[0] });
    await store.save(chat("a1", { updated: 3 }));          // started with the share alone: its home is the share
    roots = ["S:\\repo", "C:\\local"];
    await store.save(chat("b1", { updated: 2, folder: "C:\\local\\lib", home: "C:\\local" }));
    assert.deepEqual(store.list().map((c) => c.id), ["a1", "b1"], "both folders' chats, newest first");
    roots = ["s:\\REPO\\"];
    assert.deepEqual(store.list().map((c) => c.id), ["a1"], "the share alone again: its chat is still there (case and slash aside)");
    roots = [];
    assert.deepEqual(store.list(), [], "no folder open: only chats started with none");
    roots = ["S:\\repo"];
    const loaded = /** @type {any} */ (store.load("a1"));
    loaded.title = "Renamed";
    await store.save(loaded);
    assert.equal(store.list()[0].title, "Renamed", "the list follows a saved change");
  } finally {
    fs.rmSync(top, { recursive: true, force: true });
  }
});

test("chats from a workspace's own storage (0.1.3 and before) are copied in once, as its main folder's", async () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "solder-adopt-"));
  try {
    const old = path.join(top, "workspace-storage");
    fs.mkdirSync(path.join(old, "chats"), { recursive: true });
    fs.writeFileSync(path.join(old, "chats", "old1.json"), JSON.stringify(chat("old1", { updated: 5 })));
    fs.writeFileSync(path.join(old, "chats", "junk.json"), "not json");
    const store = new ChatStore(path.join(top, "global"), { homes: () => ["S:\\repo"] });
    assert.equal(adoptChats(old, store, "S:\\repo"), 1);
    assert.deepEqual(store.list().map((c) => c.id), ["old1"]);
    assert.ok(fs.existsSync(path.join(old, "chats", "old1.json")), "the old file stays");
    assert.equal(adoptChats(old, store, "S:\\repo"), 0, "once only");
  } finally {
    fs.rmSync(top, { recursive: true, force: true });
  }
});

test("saves of one chat made at once all land, the newest last", async () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "solder-saves-"));
  try {
    const store = new ChatStore(top);
    const chat = { id: "c1", title: "t", created: 1, updated: 1, messages: [{ role: "user", content: "hi" }], compaction: null, usage: { tokens: 0 } };
    const saves = [];
    for (let i = 0; i < 8; i++) { chat.title = "title " + i; saves.push(store.save(chat)); }
    await Promise.all(saves);
    const saved = JSON.parse(fs.readFileSync(path.join(top, "chats", "c1.json"), "utf8"));
    assert.equal(saved.title, "title 7");
  } finally {
    fs.rmSync(top, { recursive: true, force: true });
  }
});
