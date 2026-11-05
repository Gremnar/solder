// @ts-check
"use strict";
/** Chats saved as one JSON file each, in the workspace's own storage (or the global one with no folder open). */
const fs = require("node:fs");
const path = require("node:path");

class ChatStore {
  /** @param {string} folder */
  constructor(folder) {
    this.folder = path.join(folder, "chats");
    fs.mkdirSync(this.folder, { recursive: true });
    /** @type {Map<string, any>} */
    this.cache = new Map();
  }

  /** Newest first: {id, title, updated, pinned, archived}. */
  list() {
    const found = [];
    for (const name of fs.readdirSync(this.folder)) {
      if (!name.endsWith(".json")) continue;
      const chat = this.load(name.slice(0, -5));
      if (chat) found.push({ id: chat.id, title: chat.title, updated: chat.updated, pinned: !!chat.pinned, archived: !!chat.archived });
    }
    return found.sort((a, b) => b.updated - a.updated);
  }

  /** @param {string} id */
  load(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    try {
      const chat = JSON.parse(fs.readFileSync(this.file(id), "utf8"));
      if (!chat || !Array.isArray(chat.messages)) return null;
      chat.usage = chat.usage || { tokens: 0 };
      chat.compaction = chat.compaction || null;
      this.cache.set(id, chat);
      return chat;
    } catch { return null; }
  }

  /** Written to a temporary file first, so a crash mid-save never leaves half a chat. @param {any} chat */
  async save(chat) {
    this.cache.set(chat.id, chat);
    if (!chat.messages.length) return; // an empty chat isn't worth a file
    const target = this.file(chat.id);
    const temporary = target + ".tmp";
    await fs.promises.writeFile(temporary, JSON.stringify(chat), "utf8");
    await fs.promises.rename(temporary, target);
  }

  /** @param {string} id */
  remove(id) {
    this.cache.delete(id);
    fs.rmSync(this.file(id), { force: true });
  }

  /** @param {string} id */
  file(id) {
    if (!/^[a-z0-9]+$/i.test(id)) throw new Error("Not a chat id.");
    return path.join(this.folder, id + ".json");
  }
}

module.exports = { ChatStore };
