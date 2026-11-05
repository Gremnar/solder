// @ts-check
"use strict";
/**
 * Keyword search over the user's own docs folders, in a local SQLite full-text index (node:sqlite,
 * which VS Code's runtime ships, with FTS5: BM25 ranking and stemming, so "schematics" finds
 * "schematic"). Ported from Alloy's docsearch. Nothing here talks to the network: the model only sees
 * the passages a search returns, as it would with read_file.
 *
 * What it reads: any plain text (Markdown, HTML, XML, JSON, CSV, logs, code, headers…, in UTF-8 or
 * UTF-16 with a BOM) and Word, Excel and PowerPoint files (.docx, .xlsx, .pptx: zips of XML, read with
 * node:zlib). Not PDFs, images, scans or the old binary .doc/.xls/.ppt.
 *
 * Files are split into sections of about SECTION_CHARS, each located by its lines (as read_file numbers
 * them, Office files included) and the heading above it, and read again only when their time or size
 * changes. No `vscode` here: tested under plain node.
 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const SECTION_CHARS = 1_400;
const MAX_FOLDER_FILES = 20_000;
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_OFFICE_BYTES = 40 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 100 * 1024 * 1024;
const MAX_LINE_CHARS = 4_000;
const MAX_SHEET_ROWS = 20_000;
const RESULT_COUNT = 10;
const SKIP_FOLDERS = new Set([".git", ".svn", ".hg", "node_modules", "__pycache__", ".venv", "venv",
  "$recycle.bin", "system volume information"]);
const OFFICE = new Set([".docx", ".docm", ".dotx", ".xlsx", ".xlsm", ".pptx", ".pptm"]);
/** Never text (the NUL check would skip most of these anyway; this saves reading them). */
const BINARY = new Set([".pdf", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".tif", ".tiff", ".webp", ".heic",
  ".zip", ".7z", ".rar", ".gz", ".tgz", ".bz2", ".xz", ".cab", ".msi", ".exe", ".dll", ".sys", ".so", ".dylib",
  ".bin", ".obj", ".o", ".lib", ".a", ".pdb", ".class", ".jar", ".pyc", ".doc", ".xls", ".ppt", ".msg", ".pst",
  ".mp3", ".mp4", ".wav", ".avi", ".mov", ".mkv", ".ttf", ".otf", ".woff", ".woff2", ".iso", ".img", ".vhd",
  ".vhdx", ".vsix", ".nupkg", ".db", ".sqlite", ".mdb", ".accdb", ".psd", ".dwg"]);

/** Whether this runtime has node:sqlite with FTS5 (VS Code's does; very old ones don't). */
function available() {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE VIRTUAL TABLE t USING fts5(x)");
    db.close();
    return true;
  } catch { return false; }
}

// ------------------------------------------------------------------ reading files --

/**
 * A file's text as Solder reads it: plain text decoded, an Office file converted (headings, sheets and
 * slides as Markdown headings). null when it isn't text Solder can read.
 * @param {string} full @returns {Promise<string | null>}
 */
async function documentText(full) {
  const ext = path.extname(full).toLowerCase();
  const stat = await fs.promises.stat(full);
  if (OFFICE.has(ext)) {
    if (stat.size > MAX_OFFICE_BYTES) return null;
    try { return officeText(await fs.promises.readFile(full), ext); } catch { return null; }
  }
  if (BINARY.has(ext) || stat.size > MAX_TEXT_BYTES) return null;
  return decodeText(await fs.promises.readFile(full));
}

/** Whether read_file should go through documentText (an Office file). @param {string} full */
function isOffice(full) {
  return OFFICE.has(path.extname(full).toLowerCase());
}

/** Bytes as text: UTF-16 with a BOM, else UTF-8; null for binary (a NUL early on). @param {Buffer} data */
function decodeText(data) {
  try {
    if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data.subarray(2));
    if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data.subarray(2));
  } catch { return null; }
  if (data.subarray(0, 8192).includes(0)) return null;
  const text = new TextDecoder("utf-8").decode(data);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * The entries of a zip whose names pass `wanted`, unpacked (stored or deflated; no zip64, no
 * encryption: those throw). @param {Buffer} data @param {(name: string) => boolean} wanted @returns {Map<string, Buffer>}
 */
function unzip(data, wanted) {
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 65_557); at--) {
    if (data.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new Error("not a zip file");
  const count = data.readUInt16LE(end + 10);
  let at = data.readUInt32LE(end + 16);
  if (at === 0xffffffff || count === 0xffff) throw new Error("zip64 isn't supported");
  /** @type {Map<string, Buffer>} */
  const out = new Map();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > data.length || data.readUInt32LE(at) !== 0x02014b50) throw new Error("a damaged zip file");
    const flags = data.readUInt16LE(at + 8);
    const method = data.readUInt16LE(at + 10);
    const packed = data.readUInt32LE(at + 20);
    const size = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    const local = data.readUInt32LE(at + 42);
    const name = data.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (!wanted(name)) continue;
    if (flags & 1) throw new Error("an encrypted file");
    total += size;
    if (total > MAX_UNZIPPED_BYTES) throw new Error("too large unpacked");
    if (local + 30 > data.length || data.readUInt32LE(local) !== 0x04034b50) throw new Error("a damaged zip file");
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    const body = data.subarray(start, start + packed);
    if (method === 0) out.set(name, body);
    else if (method === 8) out.set(name, zlib.inflateRawSync(body, { maxOutputLength: Math.max(size, 1) + 1024 }));
  }
  return out;
}

/** XML text with its entities decoded. @param {string} text */
function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity) => {
    const lower = entity.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return "\"";
    if (lower === "apos") return "'";
    const code = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    try { return String.fromCodePoint(code); } catch { return whole; }
  });
}

/** A tag's attributes, whatever their order. @param {string} tag @returns {Record<string, string>} */
function attributes(tag) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[match[1]] = decode(match[2]);
  return out;
}

/** The text of every <tag>…</tag> in `xml`, joined. @param {string} xml @param {string} tag */
function textsOf(xml, tag) {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "g");
  return [...xml.matchAll(pattern)].map((match) => decode(match[1])).join("");
}

/** A .docx, .xlsx or .pptx as text. @param {Buffer} data @param {string} ext */
function officeText(data, ext) {
  if (ext.startsWith(".doc")) return wordText(unzip(data, (name) => name === "word/document.xml"));
  if (ext.startsWith(".xls")) return excelText(unzip(data, (name) => name.startsWith("xl/") && name.endsWith(".xml") || name.endsWith(".rels")));
  return slidesText(unzip(data, (name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)));
}

/** Word: one line per paragraph, headings as Markdown headings, tabs kept. @param {Map<string, Buffer>} files */
function wordText(files) {
  const xml = files.get("word/document.xml")?.toString("utf8") ?? "";
  const lines = [];
  for (const [paragraph] of xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)) {
    const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(paragraph)?.[1] ?? "";
    const level = /^heading\s?(\d)$/i.exec(style)?.[1] ?? (/^title$/i.test(style) ? "1" : "");
    let text = "";
    for (const match of paragraph.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:(?:br|cr)\/>/g)) {
      text += match[1] !== undefined ? decode(match[1]) : match[0].startsWith("<w:tab") ? "\t" : " ";
    }
    text = text.replace(/[  ]+$/, "");
    if (text.trim()) lines.push(level ? "#".repeat(Number(level)) + " " + text.trim() : text);
  }
  return lines.join("\n");
}

/** Excel: "## Sheet: name", then one line per row, cells separated by " | ". @param {Map<string, Buffer>} files */
function excelText(files) {
  const read = (/** @type {string} */ name) => files.get(name)?.toString("utf8") ?? "";
  const shared = [...read("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => textsOf(match[1], "t"));
  /** @type {Map<string, string>} */
  const targets = new Map();
  for (const [tag] of read("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\s[^>]*>/g)) {
    const a = attributes(tag);
    if (a.Id && a.Target) targets.set(a.Id, a.Target.startsWith("/") ? a.Target.slice(1) : "xl/" + a.Target.replace(/^\.\//, ""));
  }
  const out = [];
  for (const [tag] of read("xl/workbook.xml").matchAll(/<sheet\s[^>]*>/g)) {
    const a = attributes(tag);
    const target = targets.get(a["r:id"] ?? "");
    const xml = target ? read(target) : "";
    if (!xml) continue;
    out.push(`## Sheet: ${a.name ?? "?"}`);
    let rows = 0;
    for (const [, row] of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (++rows > MAX_SHEET_ROWS) break;
      const cells = [];
      for (const match of row.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const type = attributes(match[1]).t ?? "";
        const body = match[2] ?? "";
        const value = decode(/<v>([^<]*)<\/v>/.exec(body)?.[1] ?? "");
        cells.push(type === "s" ? shared[Number(value)] ?? "" : type === "inlineStr" ? textsOf(body, "t")
          : type === "b" ? (value === "1" ? "TRUE" : "FALSE") : value);
      }
      while (cells.length && !cells[cells.length - 1].trim()) cells.pop();
      if (cells.some((cell) => cell.trim())) out.push(cells.join(" | ").replace(/\s*\n\s*/g, " "));
    }
  }
  return out.join("\n");
}

/** PowerPoint: "## Slide n", then one line per paragraph. @param {Map<string, Buffer>} files */
function slidesText(files) {
  const names = [...files.keys()].sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]));
  const out = [];
  for (const name of names) {
    out.push(`## Slide ${/(\d+)\.xml$/.exec(name)?.[1]}`);
    const xml = files.get(name)?.toString("utf8") ?? "";
    for (const [paragraph] of xml.matchAll(/<a:p>[\s\S]*?<\/a:p>/g)) {
      const text = textsOf(paragraph, "a:t").trim();
      if (text) out.push(text);
    }
  }
  return out.join("\n");
}

/**
 * Pieces of about SECTION_CHARS, each with where it is ("lines 12–40", as read_file numbers them) and
 * the heading above it. A Markdown heading (which Office files are converted to) starts a new piece.
 * @param {string} text @returns {{location: string, heading: string, body: string}[]}
 */
function sections(text) {
  const lines = text.split(/\r\n|\r|\n/);
  /** @type {{location: string, heading: string, body: string}[]} */
  const out = [];
  let current = [];
  let size = 0;
  let start = 1;
  let heading = "";
  let pieceHeading = "";
  const flush = (/** @type {number} */ end) => {
    const body = current.join("\n").trim();
    if (body) out.push({ location: end > start ? `lines ${start}–${end}` : `line ${start}`, heading: pieceHeading, body });
    current = [];
    size = 0;
  };
  lines.forEach((raw, index) => {
    const line = raw.length > MAX_LINE_CHARS ? raw.slice(0, MAX_LINE_CHARS) : raw;
    const title = /^#{1,6}\s+(.+)$/.exec(line)?.[1];
    if ((title && size > 0) || size + line.length > SECTION_CHARS) flush(index);
    if (!current.length) { start = index + 1; pieceHeading = title ? title.trim() : heading; }
    if (title) heading = title.trim();
    current.push(line);
    size += line.length + 1;
  });
  flush(lines.length);
  return out;
}

// ------------------------------------------------------------------------ queries --

/** A search's words and quoted phrases as FTS5 strings; null when combined by hand with AND/OR/NOT. @param {string} text */
function queryTerms(text) {
  const trimmed = text.trim();
  if (/\b(AND|OR|NOT)\b/.test(trimmed)) return null;
  /** @type {string[]} */
  const terms = [];
  for (const [, phrase, word] of trimmed.matchAll(/"([^"]*)"|([\w$][\w$.\-\\:]*)/gu)) {
    const term = phrase !== undefined ? (phrase.match(/[\w$][\w$.\-\\:]*/gu) ?? []).join(" ") : word;
    const quoted = `"${term}"`;
    if (term && !terms.includes(quoted)) terms.push(quoted);
  }
  return terms;
}

/** A search as typed, as an FTS5 query: any of its words or phrases may match (more of them rank first). @param {string} text */
function matchQuery(text) {
  const terms = queryTerms(text);
  return terms === null ? text.trim() : terms.join(" OR ");
}

// -------------------------------------------------------------------------- index --

class DocsIndex {
  /** @param {string} file where the index lives */
  constructor(file) {
    this.file = file;
    /** @type {any} */
    this.db = null;
    /**
     * The refresh that's running, if any: only one at a time. Searches never wait for it: each file is
     * written in one synchronous transaction, so between files the index is always whole.
     * @type {Promise<any> | null}
     */
    this.active = null;
    /** What the running refresh has done so far (for the settings screen). */
    this.progress = { indexed: 0, changed: 0 };
    /** @type {Map<string, number>} when each folder was last looked at (walked, in full or as far as allowed) */
    this.walked = new Map();
  }

  _open() {
    if (this.db) return this.db;
    const { DatabaseSync } = require("node:sqlite");
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const create = () => {
      const db = new DatabaseSync(this.file);
      db.exec(`PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS files(key TEXT PRIMARY KEY, root TEXT NOT NULL, stamp TEXT NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS sections USING fts5(key UNINDEXED, path UNINDEXED, location UNINDEXED,
          heading, body, tokenize = 'porter unicode61');`);
      return db;
    };
    try {
      this.db = create();
    } catch {
      // A damaged index is only a cache: start it again.
      for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(this.file + suffix, { force: true });
      this.db = create();
    }
    return this.db;
  }

  close() {
    try { this.db?.close(); } catch { /* already closed */ }
    this.db = null;
  }

  /** How many files the index holds. */
  count() {
    return Number(this._open().prepare("SELECT count(*) AS n FROM files").get().n);
  }

  /**
   * Bring the index up to date for these folders, for at most `ms` (what's left is done next time).
   * Folders no longer listed are forgotten. Yields between files, so the extension host stays responsive.
   * @param {string[]} roots @param {{ms?: number, signal?: AbortSignal}} [options]
   * @returns {Promise<{files: number, changed: number, unfinished: boolean, truncated: boolean}>}
   */
  refresh(roots, { ms = 60_000, signal } = {}) {
    // Already running: say so at once instead of waiting (a search goes on with what's indexed).
    if (this.active) return Promise.resolve({ files: this.count(), changed: 0, unfinished: true, truncated: false, busy: true });
    this.progress = { indexed: 0, changed: 0 };
    this.active = this._refresh(roots, ms, signal).finally(() => { this.active = null; });
    return this.active;
  }

  /** @param {string[]} roots @param {number} ms @param {AbortSignal | undefined} signal */
  async _refresh(roots, ms, signal) {
    {
      const db = this._open();
      const stop = Date.now() + ms;
      const late = () => Date.now() > stop || !!signal?.aborted;
      const keys = roots.map((root) => keyOf(root));
      for (const { root } of db.prepare("SELECT DISTINCT root FROM files").all()) {
        if (!keys.includes(String(root))) this._forget(db, "root = ?", String(root));
      }
      const result = { files: 0, changed: 0, unfinished: false, truncated: false };
      for (const root of roots) {
        const rootKey = keyOf(root);
        const known = new Map(db.prepare("SELECT key, stamp FROM files WHERE root = ?").all(rootKey)
          .map((row) => [String(row.key), String(row.stamp)]));
        const seen = new Set();
        const walk = await listFiles(root, late);
        if (walk.truncated) result.truncated = true;
        for (const file of walk.files) {
          if (late()) { result.unfinished = true; break; }
          const key = keyOf(file.full);
          seen.add(key);
          const stamp = `${Math.round(file.mtime)}:${file.size}`;
          if (known.get(key) === stamp) continue;
          let text = null;
          try { text = await documentText(file.full); } catch { text = null; }
          db.exec("BEGIN");
          try {
            db.prepare("DELETE FROM sections WHERE key = ?").run(key);
            const add = db.prepare("INSERT INTO sections (key, path, location, heading, body) VALUES (?, ?, ?, ?, ?)");
            for (const piece of text ? sections(text) : []) add.run(key, file.full, piece.location, piece.heading, piece.body);
            db.prepare("INSERT OR REPLACE INTO files (key, root, stamp) VALUES (?, ?, ?)").run(key, rootKey, stamp);
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          result.changed++;
          this.progress.changed = result.changed;
          await new Promise((resolve) => setImmediate(resolve));
        }
        if (walk.complete && !result.unfinished) {
          // Only a full walk can tell what's gone.
          for (const key of known.keys()) if (!seen.has(key)) this._forget(db, "key = ?", key);
        } else if (!walk.truncated) {
          result.unfinished = true;
        }
        // Looked at now, even if not all of it (a huge folder stops at the cap): not walked again for a while.
        this.walked.set(rootKey, Date.now());
        result.files += Number(db.prepare("SELECT count(*) AS n FROM files WHERE root = ?").get(rootKey).n);
        this.progress.indexed = result.files;
        if (late()) { result.unfinished = true; break; }
      }
      return result;
    }
  }

  /** @param {any} db @param {string} where @param {string} value */
  _forget(db, where, value) {
    const gone = db.prepare(`SELECT key FROM files WHERE ${where}`).all(value).map((row) => String(row.key));
    const remove = db.prepare("DELETE FROM sections WHERE key = ?");
    for (const key of gone) remove.run(key);
    db.prepare(`DELETE FROM files WHERE ${where}`).run(value);
  }

  /** When this folder was last walked in full (0: never). @param {string} root */
  walkedAt(root) {
    return this.walked.get(keyOf(root)) ?? 0;
  }

  /**
   * The best-matching sections, best first, each with how many of the search's words it has.
   * @param {string} query @param {number} [limit]
   * @returns {Promise<{path: string, location: string, heading: string, excerpt: string, matched: number}[]>}
   */
  search(query, limit = RESULT_COUNT) {
    return (async () => {
      const expression = matchQuery(query);
      if (!expression) return [];
      const db = this._open();
      const sql = "SELECT rowid, path, location, heading, snippet(sections, 4, '[', ']', '…', 24) AS excerpt "
        + "FROM sections WHERE sections MATCH ? ORDER BY bm25(sections, 0, 0, 0, 2.0, 1.0) LIMIT ?";
      let rows;
      try {
        rows = db.prepare(sql).all(expression, limit);
      } catch {
        // FTS5 syntax that isn't quite right: its words instead.
        const words = matchQuery(query.replace(/["()*^]|\b(AND|OR|NOT)\b/g, " "));
        rows = words ? db.prepare(sql).all(words, limit) : [];
      }
      /** @type {Map<number, number>} */
      const counts = new Map(rows.map((row) => [Number(row.rowid), 0]));
      const terms = queryTerms(query);
      if (counts.size && terms) {
        const marks = [...counts.keys()].map(() => "?").join(",");
        const which = db.prepare(`SELECT rowid FROM sections WHERE sections MATCH ? AND rowid IN (${marks})`);
        for (const term of terms) {
          for (const row of which.all(term, ...counts.keys())) counts.set(Number(row.rowid), (counts.get(Number(row.rowid)) ?? 0) + 1);
        }
      }
      return rows.map((row) => ({ path: String(row.path), location: String(row.location), heading: String(row.heading ?? ""),
        excerpt: String(row.excerpt).replace(/\s+/g, " ").trim(), matched: counts.get(Number(row.rowid)) ?? 0 }));
    })();
  }
}

/**
 * (the most words any hit has, how many the search had) when even the best hits have only a third of
 * them, so they're likely about something else; null when they match better, or under three words.
 * @param {{matched: number}[]} hits @param {string} query
 */
function loose(hits, query) {
  const terms = queryTerms(query);
  if (!hits.length || !terms || terms.length < 3) return null;
  const best = Math.max(...hits.map((hit) => hit.matched));
  return best <= Math.max(1, Math.floor(terms.length / 3)) ? { best, of: terms.length } : null;
}

/** The index's key for a path: full, with Windows' case folded. @param {string} full */
function keyOf(full) {
  const resolved = path.resolve(full);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * The files under a folder (skipping .git, node_modules and the like), up to MAX_FOLDER_FILES.
 * @param {string} root @param {() => boolean} late
 * @returns {Promise<{files: {full: string, size: number, mtime: number}[], complete: boolean, truncated: boolean}>}
 */
async function listFiles(root, late) {
  /** @type {{full: string, size: number, mtime: number}[]} */
  const files = [];
  const stack = [root];
  let truncated = false;
  while (stack.length) {
    if (late()) return { files, complete: false, truncated };
    const folder = /** @type {string} */ (stack.pop());
    let entries;
    try { entries = await fs.promises.readdir(folder, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_FOLDERS.has(entry.name.toLowerCase())) stack.push(full);
        continue;
      }
      if (!entry.isFile() || entry.name.startsWith("~$")) continue; // ~$ is an Office lock file
      if (files.length >= MAX_FOLDER_FILES) return { files, complete: false, truncated: true };
      try {
        const stat = await fs.promises.stat(full);
        files.push({ full, size: stat.size, mtime: stat.mtimeMs });
      } catch { /* gone, or not allowed */ }
    }
  }
  return { files, complete: true, truncated };
}

module.exports = { DocsIndex, available, documentText, isOffice, decodeText, unzip, officeText, sections, queryTerms,
  matchQuery, loose, SECTION_CHARS, MAX_FOLDER_FILES };
