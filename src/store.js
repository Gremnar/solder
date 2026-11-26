// @ts-check
"use strict";
/**
 * Chats saved as one JSON file each, in Solder's global storage, each marked with its home: the workspace folder it
 * was started in. A window lists the chats whose home is one of its folders, so adding a folder to the window (which
 * makes it a different workspace to VS Code) doesn't hide them, and a chat follows its folder into any window.
 *
 * Every VS Code window has its own store over the same files, and a chat can be open in two of them. So a window
 * remembers each chat's file as it last read or wrote it, and looks again before using or saving its copy:
 * - a chat another window changed is read again when it's next opened here;
 * - a save from a copy that's behind (a pin, a rename, a model picked) is made to the chat as the file has it now,
 *   so the turns added in the other window stay;
 * - a copy that's only behind doesn't bring back a chat the other window deleted;
 * - when both windows added turns, both are kept: this window's under the chat's name, the other's as a copy.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/** What you set on a chat, apart from what's said in it: carried onto the other window's turns when a copy is behind. */
const SETTABLE = ["title", "titleSource", "titledAt", "pinned", "archived", "model", "effort", "folder", "project", "notes", "pasteUnasked"];

const sha = (/** @type {string} */ text) => crypto.createHash("sha1").update(text).digest("hex");
/** What's said in a chat, as one value to compare: its messages and its summary. @param {any} chat */
const bodyOf = (chat) => sha(JSON.stringify([chat.messages, chat.compaction ?? null]));
const same = (/** @type {any} */ a, /** @type {any} */ b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** A file's stamp: "" when it isn't there, null when that can't be told (a drive that didn't answer). @param {string} file */
function stampOf(file) {
  try { const stat = fs.statSync(file); return `${stat.mtimeMs}:${stat.size}`; }
  catch (error) { return /** @type {any} */ (error)?.code === "ENOENT" ? "" : null; }
}

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
    /** The last pass that could list the folder: what's shown while it can't be (see all). @type {any[]} */
    this.lastListed = [];
    /** @type {Map<string, any>} whole chats, once opened */
    this.cache = new Map();
    /** @type {Map<string, Promise<void>>} each chat's save in progress, so the next waits for it */
    this.saving = new Map();
    /** Chats deleted in this window: a save that was waiting (or writing) when one went doesn't bring it back. */
    this.removed = new Set();
    /** @type {Map<string, {stamp: string, summary: any}>} each file's list entry, until the file changes */
    this.summaries = new Map();
    /**
     * Each chat's file as this window last read or wrote it: its stamp ("" for no file), its text and what's said in
     * it as hashes, and what was set on it. What another window did since is told from these.
     * @type {Map<string, {stamp: string, hash: string, body: string, set: Record<string, any>}>}
     */
    this.known = new Map();
    /** @type {Map<string, string>} by chat: the copy that holds another window's turns, when both added some */
    this.copies = new Map();
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
    let names;
    // The folder can't be listed just now (a profile on a network drive): the last good list, never "no chats".
    try { names = fs.readdirSync(this.folder); } catch { return this.lastListed.slice(); }
    const found = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const summary = this.summary(name);
      if (summary) found.push(summary);
    }
    found.sort((a, b) => b.updated - a.updated);
    this.listed = { at: Date.now(), items: found };
    this.lastListed = found;
    return found.slice();
  }

  /** A file's list entry, read again only when the file changed (the chats of every workspace live here). @param {string} name */
  summary(name) {
    let stat;
    try { stat = fs.statSync(path.join(this.folder, name)); } catch { return null; }
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    const known = this.summaries.get(name);
    if (known && known.stamp === stamp) return known.summary;
    // This window's own copy when the file is as it left it; the file's, when another window wrote it since.
    const id = name.slice(0, -5);
    const mine = this.cache.get(id);
    const chat = mine && (this.saving.has(id) || this.known.get(id)?.stamp === stamp) ? mine : this.read(id) ?? mine;
    const summary = chat ? { id: chat.id, title: chat.title, updated: chat.updated, pinned: !!chat.pinned, archived: !!chat.archived,
      home: chat.home ?? "", project: typeof chat.project === "string" ? chat.project : "" } : null;
    this.summaries.set(name, { stamp, summary });
    return summary;
  }

  /**
   * A chat, as this window has it, or as its file has it when another window changed it since (null when it was
   * deleted there, or was never saved). A window has one object for a chat, for as long as it's open: a chat read
   * again is that same object with the file's contents, so whoever holds it has the chat as it is now, and no older
   * copy is left anywhere to be saved by mistake. @param {string} id
   */
  load(id) {
    const mine = this.cache.get(id);
    // In this window's hands (a save under way), or its file is as this window left it: its own copy.
    if (mine && (this.saving.has(id) || !this.changedElsewhere(id))) return mine;
    const stamp = stampOf(this.file(id));
    const text = this.text(id);
    let chat = text === null ? null : parse(text);
    if (chat) {
      if (mine) {
        for (const key of Object.keys(mine)) delete mine[key];
        chat = Object.assign(mine, chat);
      }
      this.cache.set(id, chat);
      this.known.set(id, { stamp: stamp ?? "", hash: sha(/** @type {string} */ (text)), body: bodyOf(chat), set: settable(chat) });
    } else if (mine && text === null && stamp === "") {
      // Deleted in another window: gone here too.
      this.cache.delete(id);
      this.known.delete(id);
    } else if (mine) return mine; // it couldn't be read just now: as this window has it
    return chat;
  }

  /**
   * Brings the chat a window is showing up to date: "same" when its file is as this window left it; "changed" when
   * another window changed it since (the chat, the same object, now has the file's contents); "gone" when it was
   * deleted there. @param {any} chat @returns {"same" | "changed" | "gone"}
   */
  refresh(chat) {
    if (this.removed.has(chat.id)) return "gone";
    // Not one of this store's (new, and not saved yet), or in this window's hands: as it is.
    if (this.cache.get(chat.id) !== chat || this.saving.has(chat.id) || !this.changedElsewhere(chat.id)) return "same";
    return this.load(chat.id) ? "changed" : this.cache.has(chat.id) ? "same" : "gone";
  }

  /** A chat as this window holds it, without looking at its file (the one a task here is working in). @param {string} id */
  held(id) {
    return this.cache.get(id) ?? null;
  }

  /** Whether a chat's file isn't as this window last read or wrote it: changed, or deleted, by another. @param {string} id */
  changedElsewhere(id) {
    const file = this.file(id);
    const stamp = stampOf(file);
    if (stamp === null) return false; // can't tell: as this window has it
    const known = this.known.get(id);
    if (!known) return stamp !== "";
    if (stamp === known.stamp) return false;
    if (stamp === "") return true;
    // A stamp alone can move (a network drive can give a file's time differently later): only other text is a change.
    const text = this.text(id);
    if (text === null) return false;
    if (sha(text) !== known.hash) return true;
    known.stamp = stamp;
    return false;
  }

  /** A chat's file as text, or null. @param {string} id */
  text(id) {
    try { return fs.readFileSync(this.file(id), "utf8"); } catch { return null; }
  }

  /** @param {string} id */
  read(id) {
    const text = this.text(id);
    return text === null ? null : parse(text);
  }

  /** Written to a temporary file first, so a crash mid-save never leaves half a chat. @param {any} chat */
  async save(chat) {
    // Deleted in this window: a late save (a title arriving afterwards) doesn't bring it back, here or on disk.
    if (this.removed.has(chat.id)) return;
    this.cache.set(chat.id, chat);
    if (!chat.messages.length) {
      // An empty chat isn't worth a file; one that had turns and lost them all (deleted, or its first message being
      // edited) loses its file too, in its turn, or the old conversation would be back after a reload. What another
      // window did since is settled first, as for any save: turns it added are kept (as a copy, when this window took
      // turns away; as this chat's, when this window had none to lose), never deleted with it.
      const before = this.saving.get(chat.id) || Promise.resolve();
      const gone = before.catch(() => {}).then(async () => {
        if (this.removed.has(chat.id)) return;
        // Settling failed (the other window's turns couldn't be kept): the file stays as it is.
        if (!(await this.settle(chat).catch(() => false))) return;
        if (chat.messages.length) { // the other window's turns, now this chat's (or turns added here meanwhile)
          if (chat.home === undefined) chat.home = this.homeOf(chat);
          return this.write(chat);
        }
        await fs.promises.rm(this.file(chat.id), { force: true }).catch(() => {});
        this.listed = null;
        this.known.set(chat.id, { stamp: "", hash: "", body: bodyOf(chat), set: settable(chat) });
      }).catch(() => {});
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
      // What another window did to this chat since this one read or wrote it, settled first.
      if (!(await this.settle(chat))) return;
      await this.write(chat);
    });
    this.listed = null;
    this.saving.set(chat.id, mine);
    mine.finally(() => { if (this.saving.get(chat.id) === mine) this.saving.delete(chat.id); }).catch(() => {});
    return mine;
  }

  /** The chat written to its file, once settled. @param {any} chat */
  async write(chat) {
    const target = this.file(chat.id);
    // A temporary file of this window's own: two windows saving the same chat don't write into each other's.
    const temporary = `${target}.${process.pid}.tmp`;
    const text = JSON.stringify(chat);
    const body = bodyOf(chat);
    const set = settable(chat);
    await fs.promises.writeFile(temporary, text, "utf8");
    if (this.removed.has(chat.id)) { await fs.promises.rm(temporary, { force: true }); return; }
    await fs.promises.rename(temporary, target);
    this.known.set(chat.id, { stamp: stampOf(target) ?? "", hash: sha(text), body, set });
    this.listed = null;
  }

  /**
   * Before a save: what another window did to the chat's file since this window read or wrote it.
   * - Nothing, or only what was set on it there (a pin, a name): this window's copy is saved as it is.
   * - It added turns, and this window didn't: this window's copy becomes the file's chat, with what was set here kept
   *   (the object itself is changed, so whoever holds it has the newer turns).
   * - Both added turns: the other window's are kept as a copy of the chat, and this window's are saved.
   * - It deleted the chat: a copy that's only behind isn't saved (false), so the chat stays deleted; turns added
   *   here since are saved, since they exist nowhere else.
   * @param {any} chat @returns {Promise<boolean>} whether to go on and save
   */
  async settle(chat) {
    const known = this.known.get(chat.id);
    const target = this.file(chat.id);
    const stamp = stampOf(target);
    if (!known || stamp === null || stamp === known.stamp) return true;
    const mineAdded = bodyOf(chat) !== known.body;
    if (stamp === "") {
      if (mineAdded || !known.stamp) return true;
      // Deleted there, and nothing new here: deleted here too, as if it had been done in this window.
      this.removed.add(chat.id);
      this.cache.delete(chat.id);
      this.known.delete(chat.id);
      this.listed = null;
      return false;
    }
    let text;
    try { text = await fs.promises.readFile(target, "utf8"); } catch { return true; }
    if (sha(text) === known.hash) { known.stamp = stamp; return true; }
    const theirs = parse(text);
    if (!theirs) return true;
    if (bodyOf(theirs) === known.body) {
      // Only something set there (a pin, a name): kept, where this window didn't set the same thing itself.
      for (const name of SETTABLE) {
        if (!same(chat[name], known.set[name]) || same(theirs[name], known.set[name])) continue;
        if (theirs[name] === undefined) delete chat[name]; else chat[name] = theirs[name];
      }
      return true;
    }
    if (!mineAdded) {
      const mine = settable(chat);
      for (const key of Object.keys(chat)) delete chat[key];
      Object.assign(chat, theirs);
      for (const name of SETTABLE) {
        if (same(mine[name], known.set[name])) continue;
        if (mine[name] === undefined) delete chat[name]; else chat[name] = mine[name];
      }
      return true;
    }
    // One copy per chat holds the other window's turns: written again if they go on there, never one more each time.
    let id = this.copies.get(chat.id);
    if (!id) {
      id = Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
      this.copies.set(chat.id, id);
    }
    const copy = { ...theirs, id, title: `${String(theirs.title || "New chat").replace(/ \(from another window\)$/, "").slice(0, 96)} (from another window)`, titleSource: "user" };
    // A gateway's session goes on with one conversation: the copy starts its own.
    if (copy.assist) copy.assist = { lost: true, why: "fork", since: Date.now() };
    const temporary = `${this.file(id)}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporary, JSON.stringify(copy), "utf8");
    await fs.promises.rename(temporary, this.file(id));
    this.listed = null;
    return true;
  }

  /** @param {string} id */
  remove(id) {
    this.removed.add(id);
    this.listed = null;
    this.cache.delete(id);
    this.known.delete(id);
    this.summaries.delete(id + ".json");
    fs.rmSync(this.file(id), { force: true });
  }

  /** @param {string} id */
  file(id) {
    if (!/^[a-z0-9]+$/i.test(id)) throw new Error("Not a chat id.");
    return path.join(this.folder, id + ".json");
  }
}

/** A chat from its file's text, or null when it isn't one. @param {string} text */
function parse(text) {
  try {
    const chat = JSON.parse(text);
    if (!chat || !Array.isArray(chat.messages)) return null;
    chat.usage = chat.usage || { tokens: 0 };
    chat.compaction = chat.compaction || null;
    return chat;
  } catch { return null; }
}

/** What's set on a chat (see SETTABLE), to compare later. @param {any} chat @returns {Record<string, any>} */
function settable(chat) {
  return Object.fromEntries(SETTABLE.map((name) => [name, chat[name]]));
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
