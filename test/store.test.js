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

test("a chat that loses all its turns loses its file: the old conversation isn't back after a reload", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "solder-store-"));
  try {
    const store = new ChatStore(folder);
    const chat = { id: "abc123", title: "t", updated: 1, messages: [{ role: "user", content: "secret words" }, { role: "assistant", content: "reply" }], usage: { tokens: 0 } };
    await store.save(chat);
    assert.equal(new ChatStore(folder).load("abc123")?.messages.length, 2);
    chat.messages = [];
    await store.save(chat);
    assert.equal(new ChatStore(folder).load("abc123"), null, "a fresh store finds nothing");
    assert.equal(store.list().some((c) => c.id === "abc123"), false);
    // Typed in again (an edited first message, sent): it's saved as ever.
    chat.messages = [{ role: "user", content: "new words" }];
    await store.save(chat);
    assert.equal(new ChatStore(folder).load("abc123")?.messages[0].content, "new words");
    // A save and an emptying one after the other land in that order.
    const first = store.save(chat);
    chat.messages = [];
    await Promise.all([first, store.save(chat)]);
    assert.equal(new ChatStore(folder).load("abc123"), null);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test("settings a folder's own .vscode files could set are user settings only", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  const properties = manifest.contributes.configuration.properties;
  const open = Object.entries(properties).filter(([, value]) => !["application", "machine"].includes(/** @type {any} */ (value).scope)).map(([name]) => name);
  assert.deepEqual(open, [], "every Solder setting is the user's (application) or this PC's (machine): none can come from a workspace");
});
