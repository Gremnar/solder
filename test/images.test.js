// @ts-check
"use strict";
/**
 * Images for Tool models: what's taken (PNG and JPEG, by their bytes), how they're kept (once, by their content, and
 * read back only by a name Solder gave), and how a chat sends them: as image parts after the message's text, at full
 * detail in the task they came with and low detail after it, with a line in their place when one is gone.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const images = require("../src/images.js");
const { Engine, outbound, breakdown, estimateMessages } = require("../src/engine.js");
const { TEXTS } = require("../src/prompt.js");
const { png, digitsPng } = require("./png.js");

/** The start of a JPEG: its marker, an APP0 segment, then a frame header of `width`×`height`. */
function jpegHead(width, height) {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]);
}

test("PNG and JPEG are told by their bytes, with their size; anything else isn't an image Solder takes", () => {
  assert.deepEqual(images.imageInfo(png(64, 40, () => [255, 0, 0])), { mime: "image/png", ext: "png", width: 64, height: 40 });
  assert.deepEqual(images.imageInfo(jpegHead(1920, 1080)), { mime: "image/jpeg", ext: "jpg", width: 1920, height: 1080 });
  for (const other of [Buffer.from("GIF89a" + "x".repeat(40)), Buffer.from("not an image at all, just words"), Buffer.alloc(3), Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])]) {
    assert.equal(images.imageInfo(other), null);
  }
  assert.equal(images.fromDataUrl("data:image/gif;base64,R0lGOD"), null);
  assert.equal(images.fromDataUrl("javascript:alert(1)"), null);
  assert.ok(images.fromDataUrl("data:image/png;base64," + png(2, 2, () => [0, 0, 0]).toString("base64")));
  assert.equal(images.imageLabel({ name: "Pasted image", width: 1920, height: 1080 }), "Pasted image · 1920×1080");
});

test("an image is kept once, by its content, and read back only by a name Solder gave it", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "solder-images-"));
  const data = digitsPng("4721");
  const first = images.keepImage(folder, data);
  assert.match(first.file, /^[0-9a-f]{24}\.png$/);
  assert.equal(first.mime, "image/png");
  const old = new Date(Date.now() - 1_000_000);
  fs.utimesSync(path.join(folder, first.file), old, old);
  const again = images.keepImage(folder, data);
  assert.equal(again.file, first.file, "the same image is the same file");
  assert.ok(Date.now() - fs.statSync(path.join(folder, first.file)).mtimeMs < 60_000, "its time renewed, so it's kept longer");
  assert.equal(fs.readdirSync(folder).length, 1);
  assert.equal(images.imageUrl(folder, first.file), "data:image/png;base64," + data.toString("base64"));
  // Only a name it gave: a chat file can't point it elsewhere.
  fs.writeFileSync(path.join(folder, "secret.txt"), "not yours");
  for (const name of ["secret.txt", "../secret.png", "..\\" + first.file, "", "ABCDEF0123456789abcdef01.png"]) assert.equal(images.imageUrl(folder, name), null, name);
  assert.equal(images.imageUrl(folder, "0".repeat(24) + ".png"), null, "gone");
  // Not an image, or too big: refused in plain words.
  assert.throws(() => images.keepImage(folder, Buffer.from("hello")), /isn't a PNG or JPEG/);
  const huge = Buffer.concat([png(4, 4, () => [0, 0, 0]), Buffer.alloc(images.MAX_IMAGE_BYTES)]);
  assert.throws(() => images.keepImage(folder, huge), /bigger than/);
  fs.rmSync(folder, { recursive: true, force: true });
});

test("images not attached for 90 days are removed; newer ones and anything else in the folder are left", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "solder-images-"));
  const stale = images.keepImage(folder, png(3, 3, () => [1, 2, 3])).file;
  const fresh = images.keepImage(folder, png(3, 3, () => [4, 5, 6])).file;
  fs.writeFileSync(path.join(folder, "notes.txt"), "mine");
  const long = new Date(Date.now() - images.IMAGES_KEPT_MS - 60_000);
  fs.utimesSync(path.join(folder, stale), long, long);
  fs.utimesSync(path.join(folder, "notes.txt"), long, long);
  images.pruneImages(folder);
  assert.deepEqual(fs.readdirSync(folder).sort(), [fresh, "notes.txt"].sort());
  images.pruneImages(path.join(folder, "none"));
  fs.rmSync(folder, { recursive: true, force: true });
});

/** A chat of two tasks: the first message had one image, the second (the task going now) has two. */
function chatWithImages() {
  const chat = Engine.newChat();
  chat.messages.push(
    { role: "user", content: "What's this error?", meta: { typed: "What's this error?", images: [{ file: "a".repeat(24) + ".png", name: "Pasted image" }] } },
    { role: "assistant", content: "It's a missing file." },
    { role: "user", content: "And these two?", meta: { typed: "And these two?", images: [{ file: "b".repeat(24) + ".png", name: "one.png" }, { file: "c".repeat(24) + ".jpg", name: "two.jpg" }] } });
  return chat;
}

test("a message's images go after its text: full detail in the task going now, low detail in earlier ones", () => {
  const chat = chatWithImages();
  const asked = [];
  const out = outbound(chat, "SYSTEM", (image) => { asked.push(image.file); return `data:image/png;base64,${image.file.slice(0, 4)}`; });
  assert.deepEqual(out[1].content, [{ type: "text", text: "What's this error?" }, { type: "image_url", image_url: { url: "data:image/png;base64,aaaa", detail: "low" } }]);
  assert.equal(out[2].content, "It's a missing file.");
  assert.deepEqual(out[3].content, [{ type: "text", text: "And these two?" },
    { type: "image_url", image_url: { url: "data:image/png;base64,bbbb" } }, { type: "image_url", image_url: { url: "data:image/png;base64,cccc" } }]);
  assert.equal(asked.length, 3);
  // A message with no images is plain text, as ever.
  const plain = Engine.newChat();
  plain.messages.push({ role: "user", content: "hi", meta: { typed: "hi" } });
  assert.equal(outbound(plain, "S", () => { throw new Error("not asked"); })[1].content, "hi");
});

test("an image that's gone is a line in the message's text, not an error; with none left the text goes alone", () => {
  const chat = chatWithImages();
  const out = outbound(chat, "SYSTEM", (image) => (image.name === "two.jpg" ? "data:image/jpeg;base64,AAAA" : null));
  assert.equal(out[1].content, "What's this error?\n\n" + TEXTS.imageGone("Pasted image"));
  assert.deepEqual(out[3].content, [{ type: "text", text: "And these two?\n\n" + TEXTS.imageGone("one.png") },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } }]);
});

test("images count toward a request's size as what they cost, and Copy diagnostics shows them as their own kind", () => {
  const chat = chatWithImages();
  const out = outbound(chat, "SYSTEM");
  const without = outbound({ ...chat, messages: chat.messages.map((m) => ({ ...m, meta: { ...m.meta, images: [] } })) }, "SYSTEM");
  assert.equal(estimateMessages(out) - estimateMessages(without), images.IMAGE_TOKENS_LOW + 2 * images.IMAGE_TOKENS);
  const made = breakdown(chat, "SYSTEM", []);
  assert.equal(made.images, (images.IMAGE_TOKENS_LOW + 2 * images.IMAGE_TOKENS) * 4);
});

test("your message keeps its images, and the request has them; a host with no images to give says each is gone", async () => {
  const sent = [];
  const chat = Engine.newChat();
  const host = { systemPrompt: async () => "SYSTEM", runTool: async () => ({ output: "", summary: "" }), needsApproval: () => null, save: async () => {},
    imageUrl: (/** @type {any} */ image) => `data:image/png;base64,${image.file.slice(0, 2)}` };
  const engine = new Engine({ client: { reply: async (/** @type {any} */ request) => { sent.push(JSON.parse(JSON.stringify(request.messages))); return { content: "A red square.", calls: [], finishReason: "stop", usage: { prompt_tokens: 1200, completion_tokens: 5 }, credits: null }; } },
    host, settings: () => ({ model: "model-a", compactAt: 100_000, maxRounds: 30 }), onEvent: () => {} });
  await engine.ask(chat, "What colour?", { images: [{ file: "d".repeat(24) + ".png", name: "Pasted image", width: 64, height: 64 }] });
  assert.equal(chat.messages[0].meta.images.length, 1, "kept with the message (its name only, not the image)");
  assert.ok(!JSON.stringify(chat).includes("base64"), "the chat holds no image data");
  const user = sent[0].find((/** @type {any} */ m) => m.role === "user");
  assert.deepEqual(user.content.slice(1), [{ type: "image_url", image_url: { url: "data:image/png;base64,dd" } }]);

  const bare = new Engine({ client: { reply: async (/** @type {any} */ request) => { sent.push(JSON.parse(JSON.stringify(request.messages))); return { content: "ok", calls: [], finishReason: "stop", usage: { total_tokens: 10 }, credits: null }; } },
    host: { ...host, imageUrl: undefined }, settings: () => ({ model: "model-a", compactAt: 100_000, maxRounds: 30 }), onEvent: () => {} });
  const other = Engine.newChat();
  await bare.ask(other, "Look", { images: [{ file: "e".repeat(24) + ".png", name: "chart.png" }] });
  const looked = sent.flat().find((/** @type {any} */ m) => m.role === "user" && String(m.content).includes("Look"));
  assert.match(looked.content, /chart\.png, but it isn't available any more/);
});
