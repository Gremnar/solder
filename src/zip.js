// @ts-check
"use strict";
/**
 * Writes a plain zip file (deflate, UTF-8 names, no zip64), one entry at a time, straight to disk: what a project's
 * Export makes. Each file is read, packed and written before the next is touched, so a big folder doesn't have to fit
 * in memory; only the list of entries is kept, for the directory at the end.
 *
 * Its limits are the plain zip format's: 65,535 entries, and 4 GB for any one file and for the whole archive. Past
 * them it stops with an error and removes what it wrote. No vscode here: tested under node.
 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const MAX_ENTRIES = 65_535;
const MAX_BYTES = 0xffffffff;

/** CRC-32 as zip wants it (worked out here: not every Node that VS Code ships has zlib.crc32). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** @param {Buffer} data */
function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** @param {Date} d */
function dosTime(d) {
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return (((year - 1980) << 25) | ((d.getMonth() + 1) << 21) | (d.getDate() << 16) | (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) >>> 0;
}

/** @param {Buffer} data @returns {Promise<Buffer>} */
function deflate(data) {
  return new Promise((resolve, reject) => zlib.deflateRaw(data, { level: 6 }, (error, packed) => error ? reject(error) : resolve(packed)));
}

/**
 * Write a zip. Each entry is a name inside the archive (forward slashes, no leading slash, no ".." part) and either
 * the file to read or the bytes themselves. A file that can't be read is left out and named in `skipped`.
 * @param {string} target the zip to write (written beside itself first, then renamed, so a half-made zip never has its name)
 * @param {{name: string, file?: string, data?: Buffer}[]} entries
 * @param {{signal?: AbortSignal, onEntry?: (done: number, of: number) => void}} [options]
 * @returns {Promise<{files: number, bytes: number, skipped: string[]}>} bytes: the zip's size
 */
async function writeZip(target, entries, options = {}) {
  if (entries.length > MAX_ENTRIES) throw new Error(`That's ${entries.length.toLocaleString("en-US")} files: more than one zip file can hold (65,535).`);
  const temporary = `${target}.${process.pid}.part`;
  const out = await fs.promises.open(temporary, "w");
  /** @type {Buffer[]} */
  const centrals = [];
  /** @type {string[]} */
  const skipped = [];
  let offset = 0;
  let files = 0;
  try {
    for (let index = 0; index < entries.length; index++) {
      if (options.signal?.aborted) throw new Error("Stopped.");
      const entry = entries[index];
      const name = String(entry.name).split("\\").join("/");
      if (!name || name.startsWith("/") || name.split("/").some((part) => part === ".." || part === "")) throw new Error(`Not a name for inside a zip: ${entry.name}`);
      let data;
      let when = new Date();
      try {
        if (entry.data) data = entry.data;
        else {
          const stat = await fs.promises.stat(String(entry.file));
          if (stat.size > MAX_BYTES) throw new Error("over 4 GB");
          when = stat.mtime;
          data = await fs.promises.readFile(String(entry.file));
        }
      } catch { skipped.push(name); continue; }
      const packed = await deflate(data);
      const stored = packed.length >= data.length; // already packed (an image, another zip): kept as it is
      const body = stored ? data : packed;
      const label = Buffer.from(name, "utf8");
      if (label.length > 0xffff) { skipped.push(name); continue; }
      if (offset + 30 + label.length + body.length > MAX_BYTES) throw new Error("That's more than 4 GB, which one zip file can't hold.");
      const crc = crc32(data);
      const time = dosTime(when);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);              // version needed
      local.writeUInt16LE(0x0800, 6);          // UTF-8 names
      local.writeUInt16LE(stored ? 0 : 8, 8);  // stored, or deflate
      local.writeUInt32LE(time, 10);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(label.length, 26);
      await out.write(Buffer.concat([local, label]));
      await out.write(body);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(stored ? 0 : 8, 10);
      central.writeUInt32LE(time, 12);
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(body.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(label.length, 28);
      central.writeUInt32LE(offset, 42);
      centrals.push(central, label);
      offset += 30 + label.length + body.length;
      files++;
      options.onEntry?.(index + 1, entries.length);
    }
    const directory = Buffer.concat(centrals);
    if (offset + directory.length > MAX_BYTES) throw new Error("That's more than 4 GB, which one zip file can't hold.");
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files, 8);
    end.writeUInt16LE(files, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    await out.write(Buffer.concat([directory, end]));
    await out.close();
    await fs.promises.rename(temporary, target);
    return { files, bytes: offset + directory.length + 22, skipped };
  } catch (error) {
    await out.close().catch(() => {});
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * The files under a folder, to go in a zip under `prefix`: real files only (a link or junction is left out, so the
 * zip holds what's in the folder and nothing it points at), folders named in `skip` left out, as many as `limit`.
 * @param {string} folder @param {string} prefix the name inside the zip for the folder itself ("" for none)
 * @param {{skip?: (name: string, full: string) => boolean, limit?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<{entries: {name: string, file: string}[], tooMany: boolean}>} in name order
 */
async function filesUnder(folder, prefix, options = {}) {
  const limit = options.limit ?? MAX_ENTRIES;
  /** @type {{name: string, file: string}[]} */
  const entries = [];
  let tooMany = false;
  /** @param {string} at @param {string} inside */
  const walk = async (at, inside) => {
    if (tooMany || options.signal?.aborted) return;
    let listed;
    try { listed = await fs.promises.readdir(at, { withFileTypes: true }); } catch { return; }
    listed.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const item of listed) {
      if (tooMany) return;
      const full = path.join(at, item.name);
      const name = inside ? `${inside}/${item.name}` : item.name;
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        if (options.skip?.(item.name, full)) continue;
        await walk(full, name);
      } else if (item.isFile()) {
        if (entries.length >= limit) { tooMany = true; return; }
        entries.push({ name, file: full });
      }
    }
  };
  await walk(folder, prefix);
  return { entries, tooMany };
}

module.exports = { writeZip, filesUnder, crc32 };
