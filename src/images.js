// @ts-check
"use strict";
/**
 * Images you paste or attach, for Tool models (Assist models read text only). Each is kept once in Solder's own
 * storage, named by its content, and a chat holds only that name: the image goes to the model as a data URL as each
 * request is made. PNG and JPEG only (the panel turns anything else into one of those before it gets here).
 *
 * What one costs, measured on a gateway: about 1,100 prompt tokens whatever its size (it's scaled down there), and
 * about 280 with detail "low". A Tool model is sent the whole chat with every step, so an image is paid for again
 * each step: it goes at full detail in the task it came with, and at low detail after that.
 *
 * No vscode: tested under plain node.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/** The biggest image file Solder takes. The panel makes a big screenshot smaller first, so this is rarely met. */
const MAX_IMAGE_BYTES = 8_000_000;
/** About what an image costs in a request, in tokens: at full detail, and at low detail. */
const IMAGE_TOKENS = 1_100;
const IMAGE_TOKENS_LOW = 300;
/** Images are kept this long after they were last attached, as saved pastes are (a chat that old has long been summarised). */
const IMAGES_KEPT_MS = 90 * 24 * 60 * 60 * 1000;
/** A kept image's name: 24 hex characters of its SHA-256, and its kind. Nothing else is read from the folder. */
const NAME = /^[0-9a-f]{24}\.(png|jpg)$/;

/**
 * What an image file is, from its first bytes: PNG or JPEG, and its size in pixels. Null for anything else.
 * @param {Buffer} data @returns {{mime: "image/png" | "image/jpeg", ext: "png" | "jpg", width: number, height: number} | null}
 */
function imageInfo(data) {
  if (!Buffer.isBuffer(data) || data.length < 24) return null;
  if (data.readUInt32BE(0) === 0x89504e47 && data.readUInt32BE(4) === 0x0d0a1a0a && data.toString("latin1", 12, 16) === "IHDR") {
    const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
    return width > 0 && height > 0 ? { mime: "image/png", ext: "png", width, height } : null;
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    // The frame header (SOF0–SOF15, but not DHT, JPG or DAC, which share the range) holds its size.
    let at = 2;
    while (at + 4 <= data.length) {
      if (data[at] !== 0xff) return null;
      const marker = data[at + 1];
      if (marker === 0xff) { at++; continue; } // fill
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; } // no length
      if (marker === 0xd9 || marker === 0xda) return null; // the end, or the picture itself, before any frame header
      const length = data.readUInt16BE(at + 2);
      if (length < 2) return null;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (at + 9 > data.length) return null;
        const height = data.readUInt16BE(at + 5), width = data.readUInt16BE(at + 7);
        return width > 0 && height > 0 ? { mime: "image/jpeg", ext: "jpg", width, height } : null;
      }
      at += 2 + length;
    }
  }
  return null;
}

/** An image the panel sends, as a data URL: its bytes, or null when it isn't a PNG or JPEG one. @param {string} url */
function fromDataUrl(url) {
  const found = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(url ?? ""));
  return found ? Buffer.from(found[1], "base64") : null;
}

/**
 * Keeps an image in `folder` (once: the same image again is the same file, its time renewed) and says what it is.
 * Throws a plain-words Error when it isn't one Solder can send.
 * @param {string} folder @param {Buffer} data
 * @returns {{file: string, mime: string, width: number, height: number, bytes: number}}
 */
function keepImage(folder, data) {
  const info = imageInfo(data);
  if (!info) throw new Error("it isn't a PNG or JPEG image");
  if (data.length > MAX_IMAGE_BYTES) throw new Error(`it's bigger than ${MAX_IMAGE_BYTES / 1_000_000} MB`);
  const file = crypto.createHash("sha256").update(data).digest("hex").slice(0, 24) + "." + info.ext;
  const full = path.join(folder, file);
  fs.mkdirSync(folder, { recursive: true });
  if (fs.existsSync(full)) {
    const now = new Date();
    try { fs.utimesSync(full, now, now); } catch { /* kept anyway */ }
  } else {
    fs.writeFileSync(full + ".part", data);
    fs.renameSync(full + ".part", full);
  }
  return { file, mime: info.mime, width: info.width, height: info.height, bytes: data.length };
}

/**
 * A kept image as the model is sent it (a data URL), or null when it's gone or isn't what its name says. Only a name
 * Solder gave is read, so a chat file can't point it anywhere else. @param {string} folder @param {string} file
 */
function imageUrl(folder, file) {
  if (!NAME.test(String(file ?? ""))) return null;
  let data;
  try { data = fs.readFileSync(path.join(folder, file)); } catch { return null; }
  const info = imageInfo(data);
  if (!info || data.length > MAX_IMAGE_BYTES || !file.endsWith("." + info.ext)) return null;
  return `data:${info.mime};base64,${data.toString("base64")}`;
}

/** Kept images no chat can still need (not attached for IMAGES_KEPT_MS) are removed. @param {string} folder @param {number} [now] */
function pruneImages(folder, now = Date.now()) {
  let names;
  try { names = fs.readdirSync(folder); } catch { return; }
  for (const name of names) {
    const full = path.join(folder, name);
    try {
      const stale = name.endsWith(".part") ? now - fs.statSync(full).mtimeMs > 24 * 60 * 60 * 1000 : NAME.test(name) && now - fs.statSync(full).mtimeMs > IMAGES_KEPT_MS;
      if (stale) fs.rmSync(full, { force: true });
    } catch { /* gone meanwhile */ }
  }
}

/** An image's chip: "Pasted image · 1920×1080". @param {{name: string, width?: number, height?: number}} image */
function imageLabel(image) {
  return image.width && image.height ? `${image.name} · ${image.width}×${image.height}` : image.name;
}

module.exports = { MAX_IMAGE_BYTES, IMAGE_TOKENS, IMAGE_TOKENS_LOW, IMAGES_KEPT_MS, imageInfo, fromDataUrl, keepImage, imageUrl, pruneImages, imageLabel };
