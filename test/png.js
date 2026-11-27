// @ts-check
"use strict";
/**
 * Small PNG images made here, for the tests and the live suite: a plain colour, or digits drawn big enough to read, so
 * whatever a model says it sees can be checked. Node built-ins only (zlib).
 */
const zlib = require("node:zlib");

/** CRC-32, as PNG chunks carry it. */
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
/** @param {Buffer} data */
function crc32(data) {
  let c = 0xffffffff;
  for (const byte of data) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** @param {string} type @param {Buffer} body */
function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/**
 * A PNG of `width`×`height`, each pixel's colour from `pixel`. @param {number} width @param {number} height
 * @param {(x: number, y: number) => number[]} pixel [r, g, b] @returns {Buffer}
 */
function png(width, height, pixel) {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (width * 3 + 1);
    rows[at] = 0; // no filter
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      rows[at + 1 + x * 3] = r; rows[at + 2 + x * 3] = g; rows[at + 3 + x * 3] = b;
    }
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = 8; head[9] = 2; // 8 bits, RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head),
    chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/** Digits 0-9, five by seven. */
const DIGITS = ["01110100011001110101110011000101110", "00100011000010000100001000010001110", "01110100010000100010001000100011111",
  "11111000100010000010000011000101110", "00010001100101010010111110001000010", "11111100001111000001000011000101110",
  "00110010001000011110100011000101110", "11111000010001000100010000100001000", "01110100011000101110100011000101110",
  "01110100011000101111000010001001100"];

/**
 * Digits drawn black on white, `scale` pixels to a dot, with a margin: a number a model can read off the image.
 * @param {string} text digits only @param {number} [scale] @returns {Buffer}
 */
function digitsPng(text, scale = 12) {
  const margin = 2 * scale, width = margin * 2 + text.length * 6 * scale - scale, height = margin * 2 + 7 * scale;
  return png(width, height, (x, y) => {
    const gx = Math.floor((x - margin) / scale), gy = Math.floor((y - margin) / scale);
    const index = Math.floor(gx / 6), column = gx % 6;
    if (x < margin || y < margin || gy >= 7 || index >= text.length || column === 5) return [255, 255, 255];
    return DIGITS[Number(text[index])][gy * 5 + column] === "1" ? [0, 0, 0] : [255, 255, 255];
  });
}

module.exports = { png, digitsPng };
