// @ts-check
"use strict";
const test = require("node:test");
const { signatureBlocks, withoutSignatures } = require("../src/docs.js");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const docs = require("../src/docs.js");

/** A minimal zip (deflated entries), the way Office writes them. @param {Record<string, string>} entries */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text, "utf8");
    const packed = zlib.deflateRawSync(raw);
    const nameBytes = Buffer.from(name, "utf8");
    const crc = zlib.crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const docx = zip({ "word/document.xml": `<?xml version="1.0"?><w:document><w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Wiring</w:t></w:r></w:p>
  <w:p><w:r><w:t xml:space="preserve">The PX-40 pump &amp; valve </w:t></w:r><w:r><w:t>schematic</w:t></w:r><w:r><w:tab/><w:t>rev B</w:t></w:r></w:p>
  <w:p><w:r><w:t></w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Limits</w:t></w:r></w:p>
  <w:p><w:r><w:t>Max 40 &#x2103;</w:t></w:r></w:p></w:body></w:document>` });
const xlsx = zip({
  "xl/workbook.xml": `<workbook><sheets><sheet name="Registers" sheetId="1" r:id="rId1"/><sheet r:id="rId2" name="Empty" sheetId="2"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="x"/><Relationship Target="/xl/worksheets/sheet2.xml" Id="rId2"/></Relationships>`,
  "xl/sharedStrings.xml": `<sst><si><t>Address</t></si><si><t>Name</t></si><si><r><t>FB_</t></r><r><t>CTRL</t></r></si></sst>`,
  "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2"><v>16</v></c><c r="B2" t="s"><v>2</v></c><c r="C2" t="b"><v>1</v></c></row>
    <row r="3"><c r="A3" t="inlineStr"><is><t>0x20</t></is></c><c r="B3"/></row></sheetData></worksheet>`,
  "xl/worksheets/sheet2.xml": `<worksheet><sheetData/></worksheet>`,
});
const pptx = zip({
  "ppt/slides/slide10.xml": `<p:sld><a:p><a:r><a:t>Last</a:t></a:r></a:p></p:sld>`,
  "ppt/slides/slide2.xml": `<p:sld><a:p><a:r><a:t>FooBus </a:t></a:r><a:r><a:t>timing</a:t></a:r></a:p><a:p></a:p></p:sld>`,
  "ppt/slides/slide1.xml": `<p:sld><a:p><a:r><a:t>Overview</a:t></a:r></a:p></p:sld>`,
});

test("Word, Excel and PowerPoint files come out as text, with headings, sheets and slides", () => {
  assert.equal(docs.officeText(docx, ".docx"), "# Wiring\nThe PX-40 pump & valve schematic\trev B\n## Limits\nMax 40 ℃");
  assert.equal(docs.officeText(xlsx, ".xlsx"), "## Sheet: Registers\nAddress | Name\n16 | FB_CTRL | TRUE\n0x20\n## Sheet: Empty");
  assert.equal(docs.officeText(pptx, ".pptx"), "## Slide 1\nOverview\n## Slide 2\nFooBus timing\n## Slide 10\nLast");
  assert.throws(() => docs.unzip(Buffer.from("not a zip at all, just some text here"), () => true), /not a zip/);
});

test("plain text is read in UTF-8 or UTF-16; binary is skipped", () => {
  assert.equal(docs.decodeText(Buffer.from("﻿hello", "utf8")), "hello");
  assert.equal(docs.decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("héllo", "utf16le")])), "héllo");
  assert.equal(docs.decodeText(Buffer.from([0x89, 0x50, 0x00, 0x01])), null);
});

test("sections: about 1,400 characters, located by lines, a heading starts a new one", () => {
  const text = ["# Intro", "a".repeat(100), "## Setup", ...Array.from({ length: 40 }, (_, i) => `step ${i} ` + "x".repeat(60))].join("\n");
  const pieces = docs.sections(text);
  assert.deepEqual(pieces[0], { location: "lines 1–2", heading: "Intro", body: "# Intro\n" + "a".repeat(100) });
  assert.equal(pieces[1].heading, "Setup");
  assert.match(pieces[1].location, /^lines 3–\d+$/);
  assert.ok(pieces.every((piece) => piece.body.length <= docs.SECTION_CHARS + 100));
  assert.equal(pieces.at(-1).heading, "Setup", "later pieces keep the heading above them");
});

test("queries: words and phrases, any of which may match; hand-written AND/OR/NOT kept", () => {
  assert.equal(docs.matchQuery('pump "valve timing" fb_write'), '"pump" OR "valve timing" OR "fb_write"');
  assert.equal(docs.matchQuery("pump AND valve"), "pump AND valve");
  assert.deepEqual(docs.loose([{ matched: 1 }], "one two three four"), { best: 1, of: 4 }, "a third of four words, rounded down, is one");
  assert.deepEqual(docs.loose([{ matched: 1 }], "one two three four five six"), { best: 1, of: 6 });
  assert.equal(docs.loose([{ matched: 1 }], "two words"), null);
});

test("the index: built, searched (stemmed, ranked, Office included), updated, and folders forgotten", async (t) => {
  if (!docs.available()) { t.skip("no node:sqlite with FTS5 here"); return; }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "solder-docs-"));
  const folder = path.join(base, "docs");
  const other = path.join(base, "other");
  fs.mkdirSync(path.join(folder, "api"), { recursive: true });
  fs.mkdirSync(path.join(folder, "node_modules"), { recursive: true });
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(folder, "api", "foobus.md"), "# FooBus API\nCall fb_open() before fb_write().\n");
  fs.writeFileSync(path.join(folder, "manual.docx"), docx);
  fs.writeFileSync(path.join(folder, "registers.xlsx"), xlsx);
  fs.writeFileSync(path.join(folder, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
  fs.writeFileSync(path.join(folder, "node_modules", "skip.md"), "schematic schematic schematic");
  fs.writeFileSync(path.join(other, "notes.txt"), "an unrelated schematic note");
  const index = new docs.DocsIndex(path.join(base, "index", "docs.sqlite"));
  try {
    const first = await index.refresh([folder, other]);
    assert.deepEqual([first.files, first.unfinished, first.truncated], [5, false, false]);
    let hits = await index.search("schematics");
    assert.deepEqual(hits.map((h) => path.basename(h.path)).sort(), ["manual.docx", "notes.txt"], "stemmed; node_modules skipped");
    const word = hits.find((h) => h.path.endsWith("manual.docx"));
    assert.deepEqual([word?.location, word?.heading], ["lines 1–2", "Wiring"]);
    assert.match(word?.excerpt ?? "", /\[schematic\]/);
    hits = await index.search("fb_write");
    assert.equal(path.basename(hits[0].path), "foobus.md");
    assert.equal((await index.search("FB_CTRL registers"))[0].heading, "Sheet: Registers");

    const again = await index.refresh([folder, other]);
    assert.equal(again.changed, 0, "nothing changed, nothing read again");
    fs.writeFileSync(path.join(folder, "api", "foobus.md"), "# FooBus API\nCall fb_init() first now.\n");
    fs.utimesSync(path.join(folder, "api", "foobus.md"), new Date(), new Date(Date.now() + 5000));
    fs.rmSync(path.join(folder, "registers.xlsx"));
    const third = await index.refresh([folder]);
    assert.equal(third.changed, 1);
    assert.equal((await index.search("fb_write")).length, 0);
    assert.equal((await index.search("fb_init")).length, 1);
    assert.equal((await index.search("FB_CTRL")).length, 0, "a deleted file is gone");
    assert.equal((await index.search("unrelated")).length, 0, "a folder no longer listed is forgotten");
    assert.equal(index.count(), 3);
    assert.deepEqual(await index.search('"unbalanced'), [], "bad FTS syntax falls back to words");
  } finally {
    index.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a refresh that's running doesn't hold up another caller, and a search runs meanwhile", async (t) => {
  if (!docs.available()) { t.skip("no node:sqlite with FTS5 here"); return; }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "solder-docs-"));
  const folder = path.join(base, "docs");
  fs.mkdirSync(folder);
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(folder, `note${i}.md`), `# Note ${i}\nvalve pump ${i}\n`);
  const index = new docs.DocsIndex(path.join(base, "index", "docs.sqlite"));
  try {
    const first = index.refresh([folder]);
    const second = await index.refresh([folder]);
    assert.equal(second.busy, true, "told at once, not made to wait");
    const hits = await index.search("valve");
    assert.ok(Array.isArray(hits), "a search runs while indexing goes on");
    const done = await first;
    assert.equal(done.files, 200);
    assert.ok((await index.search("valve")).length > 0);
    assert.equal(index.progress.indexed, 200);
  } finally {
    index.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a script's digital signature is found and left out: PowerShell, VBScript and JScript marks", () => {
  const base64 = Array.from({ length: 120 }, (_, i) => "# MIIfZwYJKoZIhvcNAQcCoIIfWDCCH1QCAQExCzAJBgUrDgMCGgUAMGkGCisG" + String(i).padStart(4, "A"));
  const ps = ["Write-Host 'hi'", "", "# SIG # Begin signature block", ...base64, "# SIG # End signature block"];
  assert.deepEqual(signatureBlocks(ps), [[3, 122]]);
  assert.equal(withoutSignatures(ps.join("\r\n")), "Write-Host 'hi'\n\n# SIG # Begin signature block\n# SIG # End signature block");
  assert.deepEqual(signatureBlocks(["'' SIG '' Begin signature block", "'' MIIa", "'' SIG '' End signature block"]), [[1, 1]]);
  assert.deepEqual(signatureBlocks(["// SIG // Begin signature block", "// MIIa", "// SIG // End signature block"]), [[1, 1]]);
  assert.deepEqual(signatureBlocks(["# SIG # Begin signature block", "# MIIa"]), [], "no end: not a block");
  assert.equal(withoutSignatures("no signature here"), "no signature here");
});

/**
 * A stand-in embeddings model: each concept is one dimension, and words that mean the same thing share it, so
 * "credential recovery" lands next to "password reset" although they share no word.
 */
const CONCEPTS = [["password", "credential", "passphrase"], ["reset", "recovery", "recover", "restore"], ["printer", "print", "spooler"],
  ["backup", "copy", "robocopy"], ["domain", "netbios", "dns"], ["user", "account"]];
function fakeEmbed(/** @type {string[]} */ texts) {
  const vectors = texts.map((text) => {
    const words = text.toLowerCase().match(/[a-z]+/g) || [];
    return CONCEPTS.map((group) => words.filter((word) => group.includes(word)).length + 0.01);
  });
  return Promise.resolve({ vectors, tokens: texts.join(" ").split(/\s+/).length });
}

test("search by meaning: vectors in the same index, found by meaning, merged with keywords, kept in step with files", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "solder-rag-"));
  const folder = path.join(base, "docs");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "accounts.md"), "# Credential recovery\nHow a user account gets its passphrase restored after a lockout.");
  fs.writeFileSync(path.join(folder, "printers.md"), "# Printers\nRestart the spooler when a print job hangs.");
  fs.writeFileSync(path.join(folder, "backups.md"), "# Backups\nThe nightly robocopy job copies the HR share.");
  const index = new docs.DocsIndex(path.join(base, "index", "docs.sqlite"));
  let calls = 0;
  const embed = { model: "embed-a", fn: (/** @type {string[]} */ texts) => { calls++; return fakeEmbed(texts); } };
  try {
    await index.refresh([folder], { ms: 20_000, embed });
    assert.deepEqual(index.vectorCount("embed-a"), { passages: 3, embedded: 3 });
    assert.ok(index.embedding.tokens > 0, "the gateway's token count is kept");
    // No word in common: keywords alone find nothing; by meaning, the right passage.
    assert.deepEqual(await index.search("password reset"), []);
    const [query] = (await fakeEmbed(["password reset"])).vectors;
    const hits = await index.search("password reset", 10, { vector: query, model: "embed-a" });
    assert.match(hits[0].path, /accounts\.md$/);
    assert.match(hits[0].excerpt, /Credential recovery/);
    // Both rankings: a keyword hit stays near the top, and keeps its highlighted excerpt.
    const [spooler] = (await fakeEmbed(["spooler"])).vectors;
    const both = await index.search("spooler", 10, { vector: spooler, model: "embed-a" });
    assert.match(both[0].path, /printers\.md$/);
    assert.match(both[0].excerpt, /\[spooler\]/);
    // Nothing changed: no requests. A changed file: only its passage again.
    calls = 0;
    await index.refresh([folder], { ms: 20_000, embed });
    assert.equal(calls, 0);
    fs.writeFileSync(path.join(folder, "printers.md"), "# Printers\nClear the queue, then restart the spooler.");
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(folder, "printers.md"), later, later);
    await index.refresh([folder], { ms: 20_000, embed });
    assert.equal(calls, 1);
    assert.deepEqual(index.vectorCount("embed-a"), { passages: 3, embedded: 3 });
    // Another model: the old vectors stay (a model switched by mistake would cost a rebuild); a refusal stops the pass, keywords still work.
    const refusing = { model: "embed-b", fn: () => Promise.reject(new Error("The gateway answered HTTP 403.")) };
    await index.refresh([folder], { ms: 20_000, embed: refusing });
    assert.deepEqual(index.vectorCount("embed-b"), { passages: 3, embedded: 0 });
    assert.deepEqual(index.vectorCount("embed-a").embedded, 3);
    assert.match(index.embedding.error, /403/);
    assert.match((await index.search("spooler"))[0].path, /printers\.md$/);
  } finally {
    index.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("in a script, a # line is a comment, not a heading; a well-filled passage ends at a blank line", () => {
  const fn = (/** @type {number} */ n) => [`# Step ${n}: what this part does`, `function Step${n} {`, ...Array.from({ length: 12 }, (_, i) => `  Write-Host "line ${i} of step ${n}, padded to a realistic length"`), "}", ""];
  const script = [0, 1, 2, 3].flatMap(fn).join("\n");
  const asScript = docs.sections(script, false);
  assert.ok(asScript.every((piece) => piece.heading === ""), "no headings from comments");
  assert.ok(asScript.length <= 4, `${asScript.length} pieces, not one per comment`);
  assert.ok(asScript.every((piece) => /^# Step \d/.test(piece.body) && /\}$/.test(piece.body)), "each piece starts at a function's comment and ends after it");
  const asMarkdown = docs.sections("# One\ntext\n# Two\nmore", true);
  assert.deepEqual(asMarkdown.map((piece) => piece.heading), ["One", "Two"], "in Markdown, # is still a heading");
});

test("an index cut the old way is rebuilt once, and searches return the best 5", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "solder-version-"));
  const folder = path.join(base, "docs");
  fs.mkdirSync(folder);
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(folder, `note${i}.md`), `# Note ${i}\nThe spooler restarts at night.`);
  const file = path.join(base, "index", "docs.sqlite");
  const index = new docs.DocsIndex(file);
  try {
    await index.refresh([folder], { ms: 20_000 });
    assert.equal((await index.search("spooler")).length, 5);
    index._open().exec("PRAGMA user_version = 1"); // as an index from before
    index.close();
    const again = new docs.DocsIndex(file);
    assert.equal(again.count(), 0, "emptied, so every file is read again");
    await again.refresh([folder], { ms: 20_000 });
    assert.equal(again.count(), 8);
    again.close();
  } finally {
    index.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("nothing already embedded is sent again by accident: a re-dated copy, a folder off the list a while, a big run asks", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "solder-keep-"));
  const folder = path.join(base, "scripts");
  fs.mkdirSync(folder);
  const script = (/** @type {number} */ n) => [`# Script ${n}`, ...Array.from({ length: 30 }, (_, i) => `Write-Host "step ${i} of script ${n}, with some padding text"`), ""].join("\n");
  for (let n = 0; n < 4; n++) fs.writeFileSync(path.join(folder, `s${n}.ps1`), script(n) + "\n" + script(n + 10));
  const index = new docs.DocsIndex(path.join(base, "index", "docs.sqlite"));
  let sent = 0;
  const embed = { model: "embed-a", fn: (/** @type {string[]} */ texts) => { sent += texts.length; return fakeEmbed(texts); } };
  try {
    await index.refresh([folder], { ms: 20_000, embed });
    const all = index.vectorCount("embed-a");
    assert.equal(all.embedded, all.passages);
    // Copied again with new dates (a sync tool): same text, so nothing is sent.
    sent = 0;
    const later = new Date(Date.now() + 60_000);
    for (let n = 0; n < 4; n++) fs.utimesSync(path.join(folder, `s${n}.ps1`), later, later);
    await index.refresh([folder], { ms: 20_000, embed });
    assert.equal(sent, 0, "a re-dated copy sends nothing");
    // One part of one file edited: only that passage goes.
    fs.writeFileSync(path.join(folder, "s0.ps1"), script(0) + "\n" + script(99));
    const later2 = new Date(Date.now() + 120_000);
    fs.utimesSync(path.join(folder, "s0.ps1"), later2, later2);
    await index.refresh([folder], { ms: 20_000, embed });
    assert.ok(sent >= 1 && sent < all.passages / 2, `${sent} passages sent for one edit`);
    // The folder off the list (a settings file lost), then back: kept meanwhile, so nothing is sent.
    await index.refresh([], { ms: 20_000, embed });
    assert.equal(index.count(), 0, "not searched while off the list");
    assert.deepEqual(await index.search("script"), []);
    sent = 0;
    await index.refresh([folder], { ms: 20_000, embed });
    assert.equal(sent, 0, "back on the list: nothing sent again");
    assert.equal(index.vectorCount("embed-a").embedded, index.vectorCount("embed-a").passages);
    // A big run asks first; "not now" sends nothing and says it's waiting.
    let asked = null;
    const big = { model: "embed-new", fn: embed.fn, confirm: async (/** @type {number} */ passages, /** @type {number} */ tokens) => { asked = { passages, tokens }; return false; } };
    const many = path.join(base, "many");
    fs.mkdirSync(many);
    for (let n = 0; n < 160; n++) fs.writeFileSync(path.join(many, `m${n}.ps1`), script(n) + "\n" + script(n + 500));
    sent = 0;
    await index.refresh([folder, many], { ms: 60_000, embed: big });
    assert.ok(asked && asked.passages >= 300 && asked.tokens > 0, JSON.stringify(asked));
    assert.equal(sent, 0, "not now: nothing sent");
    assert.deepEqual(index.embedding.waiting, asked);
  } finally {
    index.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
