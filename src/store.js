// @ts-check
"use strict";
/**
 * Chats saved as one JSON file each, in Solder's global storage, each marked with its home: the workspace folder it
 * was started in. A window lists the chats whose home is one of its folders, so adding a folder to the window (which
 * makes it a different workspace to VS Code) doesn't hide them, and a chat follows its folder into any window.
 */
const fs = require("node:fs");
const path = require("node:path");

/** A home as it's compared: one form per folder, whatever the case or a trailing slash. @param {string | undefined} home */
function homeKey(home) {
  return home ? path.resolve(home).toLowerCase() : "";
}

class ChatStore {
  /**
   * @param {string} folder Solder's global storage (its chats are in folder/chats)
   * @param {{homes?: () => string[], homeOf?: (chat: any) => string}} [scope] the window's folders ([] for none),
   *   and the home a new chat gets
   */
  constructor(folder, scope = {}) {
    this.folder = path.join(folder, "chats");
    fs.mkdirSync(this.folder, { recursive: true });
    this.homes = scope.homes || (() => []);
    this.homeOf = scope.homeOf || (() => "");
    /** The last pass over the folder, kept for a moment (see all). @type {{at: number, items: any[]} | null} */
    this.listed = null;
    /** @type {Map<string, any>} whole chats, once opened */
    this.cache = new Map();
    /** @type {Map<string, Promise<void>>} each chat's save in progress, so the next waits for it */
    this.saving = new Map();
    /** Chats deleted in this window: a save that was waiting (or writing) when one went doesn't bring it back. */
    this.removed = new Set();
    /** @type {Map<string, {stamp: string, summary: any}>} each file's list entry, until the file changes */
    this.summaries = new Map();
  }

  /** This window's chats, newest first: {id, title, updated, pinned, archived, project}. */
  list() {
    const homes = new Set(this.homes().map(homeKey));
    if (!homes.size) homes.add(""); // no folder open: the chats started with none
    return this.all().filter((summary) => homes.has(homeKey(summary.home)))
      .map(({ id, title, updated, pinned, archived, project }) => ({ id, title, updated, pinned, archived, project }));
  }

  /**
   * Every chat there is, newest first, whichever window it was started in: a project's chats are found by the
   * project they name, not by the window. {id, title, updated, pinned, archived, home, project}
   */
  all() {
    // One pass over the folder serves a whole redraw (which asks three times), and the next for a moment: where the
    // profile's storage is on a network drive, every chat file is a round trip. Anything this store saves or removes
    // throws it away at once; a chat changed by another window shows a moment later.
    if (this.listed && Date.now() - this.listed.at < 1000) return this.listed.items.slice();
    const found = [];
    for (const name of fs.readdirSync(this.folder)) {
      if (!name.endsWith(".json")) continue;
      const summary = this.summary(name);
      if (summary) found.push(summary);
    }
    found.sort((a, b) => b.updated - a.updated);
    this.listed = { at: Date.now(), items: found };
    return found.slice();
  }

  /** A file's list entry, read again only when the file changed (the chats of every workspace live here). @param {string} name */
  summary(name) {
    let stat;
    try { stat = fs.statSync(path.join(this.folder, name)); } catch { return null; }
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    const known = this.summaries.get(name);
    if (known && known.stamp === stamp) return known.summary;
    const chat = this.cache.get(name.slice(0, -5)) ?? this.read(name.slice(0, -5));
    const summary = chat ? { id: chat.id, title: chat.title, updated: chat.updated, pinned: !!chat.pinned, archived: !!chat.archived,
      home: chat.home ?? "", project: typeof chat.project === "string" ? chat.project : "" } : null;
    this.summaries.set(name, { stamp, summary });
    return summary;
  }

  /** @param {string} id */
  load(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const chat = this.read(id);
    if (chat) this.cache.set(id, chat);
    return chat;
  }

  /** @param {string} id */
  read(id) {
    try {
      const chat = JSON.parse(fs.readFileSync(this.file(id), "utf8"));
      if (!chat || !Array.isArray(chat.messages)) return null;
      chat.usage = chat.usage || { tokens: 0 };
      chat.compaction = chat.compaction || null;
      return chat;
    } catch { return null; }
  }

  /** Written to a temporary file first, so a crash mid-save never leaves half a chat. @param {any} chat */
  async save(chat) {
    this.cache.set(chat.id, chat);
    if (!chat.messages.length) {
      // An empty chat isn't worth a file; one that had turns and lost them all (deleted, or its first message being
      // edited) loses its file too, in its turn, or the old conversation would be back after a reload.
      const before = this.saving.get(chat.id) || Promise.resolve();
      const gone = before.catch(() => {}).then(() => fs.promises.rm(this.file(chat.id), { force: true })).catch(() => {}).then(() => { this.listed = null; });
      this.listed = null;
      this.summaries.delete(chat.id + ".json");
      this.saving.set(chat.id, gone);
      gone.finally(() => { if (this.saving.get(chat.id) === gone) this.saving.delete(chat.id); });
      return gone;
    }
    if (chat.home === undefined) chat.home = this.homeOf(chat);
    // One chat's saves run one after another (a title saved meanwhile would race for the same temporary file);
    // each writes the chat as it is when its turn comes, so the newest state is what lands.
    const prior = this.saving.get(chat.id) || Promise.resolve();
    const mine = prior.catch(() => {}).then(async () => {
      if (this.removed.has(chat.id)) return; // deleted while this save waited: it doesn't come back
      const target = this.file(chat.id);
      const temporary = target + ".tmp";
      await fs.promises.writeFile(temporary, JSON.stringify(chat), "utf8");
      if (this.removed.has(chat.id)) { await fs.promises.rm(temporary, { force: true }); return; }
      await fs.promises.rename(temporary, target);
      this.listed = null;
    });
    this.listed = null;
    this.saving.set(chat.id, mine);
    mine.finally(() => { if (this.saving.get(chat.id) === mine) this.saving.delete(chat.id); }).catch(() => {});
    return mine;
  }

  /** @param {string} id */
  remove(id) {
    this.removed.add(id);
    this.listed = null;
    this.cache.delete(id);
    this.summaries.delete(id + ".json");
    fs.rmSync(this.file(id), { force: true });
  }

  /** @param {string} id */
  file(id) {
    if (!/^[a-z0-9]+$/i.test(id)) throw new Error("Not a chat id.");
    return path.join(this.folder, id + ".json");
  }
}

/**
 * Chats a workspace kept in its own storage (Solder 0.1.3 and before), copied into the store once and marked as
 * `home`'s. The old files stay where they were. @param {string} old the workspace's storage @param {ChatStore} store
 * @param {string} home @returns {number} how many were copied
 */
function adoptChats(old, store, home) {
  const from = path.join(old, "chats");
  const marker = path.join(from, "moved.txt");
  if (!home || path.resolve(from).toLowerCase() === path.resolve(store.folder).toLowerCase()) return 0;
  if (!fs.existsSync(from) || fs.existsSync(marker)) return 0;
  let copied = 0;
  for (const name of fs.readdirSync(from)) {
    if (!/^[a-z0-9]+\.json$/i.test(name)) continue;
    const target = path.join(store.folder, name);
    if (fs.existsSync(target)) continue;
    try {
      const chat = JSON.parse(fs.readFileSync(path.join(from, name), "utf8"));
      if (!chat || !Array.isArray(chat.messages)) continue;
      if (chat.home === undefined) chat.home = home;
      fs.writeFileSync(target, JSON.stringify(chat), "utf8");
      copied++;
    } catch { /* unreadable: left where it is */ }
  }
  fs.writeFileSync(marker, "Solder copied these chats to its global storage, where it keeps them now. These files are left as they were.\n");
  return copied;
}

module.exports = { ChatStore, adoptChats, homeKey };
