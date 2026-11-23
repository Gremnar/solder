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

/** Two windows over the same storage, and a chat both have open: saved by the first, then loaded by the second. */
async function twoWindows(/** @type {string} */ folder) {
  const a = new ChatStore(folder);
  const b = new ChatStore(folder);
  const mine = { id: "shared1", title: "Fix the build", created: 1, updated: 1, messages: [{ role: "user", content: "one" }, { role: "assistant", content: "two" }], compaction: null, usage: { tokens: 0 } };
  await a.save(mine);
  const theirs = b.load("shared1");
  return { a, b, mine, theirs, onDisk: () => JSON.parse(fs.readFileSync(path.join(folder, "chats", "shared1.json"), "utf8")),
    files: () => fs.readdirSync(path.join(folder, "chats")).sort() };
}

test("two windows, one chat: a window whose copy is behind doesn't write over the other's newer turns", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "solder-two-"));
  try {
    const { a, b, mine, theirs, onDisk, files } = await twoWindows(folder);
    mine.messages.push({ role: "user", content: "three" }, { role: "assistant", content: "four" });
    await a.save(mine);
    // The second window, still holding two messages, pins the chat.
    theirs.pinned = true;
    await b.save(theirs);
    assert.deepEqual([onDisk().messages.length, onDisk().pinned], [4, true], "the pin lands on the chat as it is now");
    assert.equal(theirs.messages.length, 4, "and the window's own copy has the newer turns from then on");
    // The first window didn't see the pin; it renames. Both stay.
    mine.title = "Fix the build, properly";
    mine.titleSource = "user";
    await a.save(mine);
    assert.deepEqual([onDisk().title, onDisk().pinned, onDisk().messages.length], ["Fix the build, properly", true, 4]);
    assert.equal(mine.pinned, true);
    // Each sets the same thing differently: the one that saves last has it, as ever.
    theirs.title = "Mine";
    await b.save(theirs);
    assert.deepEqual([onDisk().title, onDisk().messages.length], ["Mine", 4]);
    assert.deepEqual(files(), ["shared1.json"], "no copy was needed, and no temporary file is left");
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test("two windows, one chat: opening it again gives what the other window saved, and its list entry follows", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "solder-two-"));
  try {
    const { a, b, mine, theirs } = await twoWindows(folder);
    assert.equal(b.load("shared1"), theirs, "unchanged: the window's own copy, not read again");
    assert.equal(b.refresh(theirs), "same");
    mine.messages.push({ role: "user", content: "three" });
    mine.title = "Renamed there";
    await a.save(mine);
    b.listed = null; // (a listing holds good for a second)
    assert.equal(b.all().find((chat) => chat.id === "shared1")?.title, "Renamed there");
    assert.equal(b.refresh(theirs), "changed");
    const again = theirs;
    assert.deepEqual([again.messages.length, again.title], [3, "Renamed there"], "the window's one object for the chat has the file's contents");
    assert.equal(b.refresh(theirs), "same");
    assert.equal(b.load("shared1"), theirs, "and no other copy of it exists in the window");
    assert.equal(a.load("shared1"), mine, "the window that saved it keeps its own");
    // A file whose time moved but whose text didn't (a network drive does this) isn't a change.
    fs.utimesSync(path.join(folder, "chats", "shared1.json"), new Date(), new Date(Date.now() + 60_000));
    assert.equal(b.load("shared1"), again);
    again.pinned = true;
    await b.save(again);
    assert.deepEqual(fs.readdirSync(path.join(folder, "chats")), ["shared1.json"]);
    // A chat not saved yet is nobody else's.
    const fresh = { id: "new1", title: "New chat", messages: [], compaction: null, usage: { tokens: 0 } };
    assert.equal(b.refresh(fresh), "same");
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test("two windows, one chat: deleted in one, a copy that's only behind doesn't bring it back; turns added since do", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "solder-two-"));
  try {
    let { a, b, theirs, files } = await twoWindows(folder);
    a.remove("shared1");
    theirs.pinned = true;
    await b.save(theirs);
    assert.deepEqual(files(), [], "the stale copy's save didn't recreate the chat");
    assert.equal(b.refresh(theirs), "gone", "and the window is told it's gone");
    assert.equal(b.load("shared1"), null);
    theirs.title = "again";
    await b.save(theirs);
    assert.deepEqual(files(), []);

    ({ a, b, theirs, files } = await twoWindows(folder));
    assert.equal(b.refresh(theirs), "same");
    a.remove("shared1");
    assert.equal(b.refresh(theirs), "gone", "seen before anything is saved, too");
    assert.equal(b.load("shared1"), null);

    ({ a, b, theirs, files } = await twoWindows(folder));
    a.remove("shared1");
    theirs.messages.push({ role: "user", content: "still working here" });
    await b.save(theirs);
    assert.deepEqual(files(), ["shared1.json"], "what was added here exists nowhere else, so it's kept");
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test("two windows, one chat: when both added turns, both are kept, the other window's as one copy", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "solder-two-"));
  try {
    const { a, b, mine, theirs, onDisk, files } = await twoWindows(folder);
    mine.messages.push({ role: "user", content: "asked in the first window" });
    mine.assist = { fields: { session: "s1" }, model: "model-a", held: 3 };
    await a.save(mine);
    theirs.messages.push({ role: "user", content: "asked in the second window" });
    await b.save(theirs);
    assert.equal(onDisk().messages.at(-1).content, "asked in the second window", "this window's turns are the chat's");
    const copies = () => files().filter((name) => name !== "shared1.json").map((name) => JSON.parse(fs.readFileSync(path.join(folder, "chats", name), "utf8")));
    assert.equal(copies().length, 1);
    const copy = copies()[0];
    assert.equal(copy.messages.at(-1).content, "asked in the first window");
    assert.deepEqual([copy.title, copy.titleSource, copy.id !== "shared1"], ["Fix the build (from another window)", "user", true]);
    assert.equal(copy.assist.lost, true, "the copy doesn't carry on the other conversation's gateway session");
    b.listed = null;
    assert.equal(b.all().some((chat) => chat.id === copy.id), true, "the copy is in the list");
    // They go on in both: each window keeps one copy of the other's, written again, never one more each time.
    for (let round = 0; round < 3; round++) {
      mine.messages.push({ role: "assistant", content: "first window, round " + round });
      await a.save(mine);
      theirs.messages.push({ role: "assistant", content: "second window, round " + round });
      await b.save(theirs);
    }
    assert.equal(files().length, 3, "the chat, and one copy from each window");
    assert.equal(copies().some((chat) => chat.messages.at(-1).content === "first window, round 2"), true, "the newest of the other window's turns is in the copy");
    assert.equal(files().every((name) => name.endsWith(".json")), true);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
