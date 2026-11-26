// @ts-check
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ChatStore } = require("../src/store.js");

const chat = (/** @type {string} */ id, /** @type {any} */ more = {}) =>
  ({ id, title: id, created: 1, updated: 1, messages: [{ role: "user", content: "hi" }], compaction: null, usage: { tokens: 0 }, ...more });
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a chats folder that can't be listed for a moment gives the last good list, and never caches 'no chats'", async () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "solder-store-fix-"));
  const real = fs.readdirSync;
  try {
    const store = new ChatStore(top);
    await store.save(chat("a1", { updated: 2 }));
    await store.save(chat("b1", { updated: 1 }));
    assert.deepEqual(store.all().map((c) => c.id), ["a1", "b1"]);
    store.listed = null;
    /** @type {any} */ (fs).readdirSync = () => { throw Object.assign(new Error("gone"), { code: "EIO" }); };
    assert.deepEqual(store.all().map((c) => c.id), ["a1", "b1"], "no throw: the last good list");
    assert.equal(store.listed, null, "the failure isn't cached");
    fs.readdirSync = real;
    await store.save(chat("c1", { updated: 3 }));
    assert.deepEqual(store.all().map((c) => c.id), ["c1", "a1", "b1"], "listed again once it can be");
    // A store that never listed: nothing, rather than a throw.
    const fresh = new ChatStore(top);
    /** @type {any} */ (fs).readdirSync = () => { throw Object.assign(new Error("gone"), { code: "EIO" }); };
    assert.deepEqual(fresh.all(), []);
  } finally { fs.readdirSync = real; fs.rmSync(top, { recursive: true, force: true }); }
});

test("a late save of a chat deleted in this window doesn't bring it back into the window", async () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "solder-store-fix-"));
  try {
    const store = new ChatStore(top);
    const c = chat("b1");
    await store.save(c);
    store.remove("b1");
    c.title = "A title that came late";
    await store.save(c);
    assert.equal(store.held("b1"), null);
    assert.equal(store.load("b1"), null);
    assert.equal(fs.existsSync(path.join(top, "chats", "b1.json")), false);
    assert.deepEqual(store.all(), []);
  } finally { fs.rmSync(top, { recursive: true, force: true }); }
});

test("deleting the last turn keeps turns another window added meanwhile; with none, the file goes as before", async () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "solder-store-fix-"));
  try {
    const chats = path.join(top, "chats");
    // Nothing done elsewhere: the file goes.
    const plain = new ChatStore(top);
    const p = chat("p1");
    await plain.save(p);
    p.messages = [];
    await plain.save(p);
    assert.equal(fs.existsSync(path.join(chats, "p1.json")), false, "an ordinary last-turn delete removes the file");

    // Window B added a turn after A last saw the chat; A then deletes its last turn.
    const a = new ChatStore(top);
    const b = new ChatStore(top);
    await a.save(chat("c1", { title: "Work" }));
    const theirs = /** @type {any} */ (b.load("c1"));
    await tick();
    theirs.messages.push({ role: "assistant", content: "B's newer work" });
    await b.save(theirs);
    const mine = /** @type {any} */ (a.held("c1"));
    mine.messages = [];
    await a.save(mine);
    assert.equal(fs.existsSync(path.join(chats, "c1.json")), false, "A's delete stands");
    const kept = fs.readdirSync(chats).filter((name) => name !== "c1.json").map((name) => JSON.parse(fs.readFileSync(path.join(chats, name), "utf8")))
      .find((item) => item.messages.some((/** @type {any} */ m) => m.content === "B's newer work"));
    assert.ok(kept, "B's newer turn is kept, as a copy of the chat");
    assert.match(kept.title, /\(from another window\)$/);

    // A window that knew the chat empty, and another window wrote turns to it since: they become this chat's, not deleted.
    const c = new ChatStore(top);
    const d = new ChatStore(top);
    await c.save(chat("e1"));
    const dc = /** @type {any} */ (d.load("e1"));
    const cc = /** @type {any} */ (c.held("e1"));
    cc.messages = [];
    await c.save(cc);                                     // C deletes its last turn: the file goes
    assert.equal(fs.existsSync(path.join(chats, "e1.json")), false);
    dc.messages.push({ role: "assistant", content: "D went on" });
    await d.save(dc);                                     // D went on in it: written again, as before
    cc.pinned = true;
    await c.save(cc);                                     // C saves its empty copy again (a pin)
    const onDisk = JSON.parse(fs.readFileSync(path.join(chats, "e1.json"), "utf8"));
    assert.equal(onDisk.messages.length, 2, "D's turns stay");
    assert.equal(onDisk.pinned, true, "and what C set is kept on them");
    assert.equal(cc.messages.length, 2, "C's chat now has them");
  } finally { fs.rmSync(top, { recursive: true, force: true }); }
});
