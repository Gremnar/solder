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

test("the daily embedding budget: counted on the gateway's day, raised for today only, and saved", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "solder-budget-"));
  try {
    let now = new Date("2026-11-17T23:30:00Z");
    const file = path.join(base, "embed-budget.json");
    const budget = new docs.EmbedBudget(file, () => now);
    assert.equal(budget.left(250_000), 250_000);
    budget.spend(200_000);
    assert.equal(budget.left(250_000), 50_000);
    budget.raiseToday(500_000);
    assert.equal(budget.allowed(250_000), 500_000, "raised for today");
    assert.equal(new docs.EmbedBudget(file, () => now).used(), 200_000, "saved, so a restart doesn't reset it");
    now = new Date("2026-11-18T00:05:00Z"); // midnight UTC: a new gateway day
    assert.equal(budget.used(), 0);
    assert.equal(budget.allowed(250_000), 250_000, "today's raise is over");
    assert.equal(budget.left(0), 0, "0: no embedding");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("embedding stops when today's budget is used up, and carries on once there's more", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "solder-budget-run-"));
  const folder = path.join(base, "docs");
  fs.mkdirSync(folder);
  for (let n = 0; n < 40; n++) fs.writeFileSync(path.join(folder, `n${n}.md`), `# Note ${n}\n\nSome text about topic ${n}, long enough to be a passage of its own.\n`);
  const index = new docs.DocsIndex(path.join(base, "index", "docs.sqlite"));
  let left = 10;
  let spent = 0;
  const embed = { model: "embed-a", fn: fakeEmbed, left: () => left - spent, spend: (/** @type {number} */ tokens) => { spent += tokens; } };
  try {
    await index.refresh([folder], { ms: 20_000, embed });
    const partway = index.vectorCount("embed-a");
    assert.ok(partway.embedded > 0 && partway.embedded < partway.passages, `one batch, then paused: ${partway.embedded} of ${partway.passages}`);
    assert.equal(index.embedding.paused, true);
    assert.ok(spent > 0, "what the batch used is counted");
    left = Infinity;
    await index.refresh([folder], { ms: 20_000, embed });
    const all = index.vectorCount("embed-a");
    assert.equal(all.embedded, all.passages, "the rest, once there's room");
    assert.equal(index.embedding.paused, false);
  } finally {
    index.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- shared embeddings --

/** Two PCs' worth: the same docs in two places, an index each, and one shared embeddings folder. */
function sharedSetup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "solder-shared-"));
  const make = (/** @type {string} */ name) => {
    const folder = path.join(base, name, "docs");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "accounts.md"), "# Credential recovery\nHow a user account gets its passphrase restored after a lockout.");
    fs.writeFileSync(path.join(folder, "printers.md"), "# Printers\nRestart the spooler when a print job hangs.");
    fs.writeFileSync(path.join(folder, "backups.md"), "# Backups\nThe nightly robocopy job copies the HR share.");
    return { folder, index: new docs.DocsIndex(path.join(base, name, "index", "docs.sqlite")) };
  };
  const shared = path.join(base, "share", "embeddings");
  return { base, shared, one: make("pc-one"), two: make("pc-two") };
}
/** Every file under a folder, as paths relative to it. @param {string} folder @returns {string[]} */
function filesUnder(folder) {
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
    .map((entry) => path.relative(folder, path.join(entry.parentPath ?? /** @type {any} */ (entry).path, entry.name))).sort();
}

test("shared embeddings: what one PC embedded, another takes from the folder without asking the gateway; a changed file is embedded again", async () => {
  const { base, shared, one, two } = sharedSetup();
  let calls = 0;
  const embedWith = (/** @type {any} */ cache) => ({ model: "embed-a", cache, fn: (/** @type {string[]} */ texts) => { calls++; return fakeEmbed(texts); } });
  try {
    await one.index.refresh([one.folder], { ms: 20_000, embed: embedWith(new docs.EmbedCache(shared)) });
    assert.deepEqual(one.index.vectorCount("embed-a"), { passages: 3, embedded: 3 });
    assert.equal(calls, 1, "the first PC embeds them");
    const files = filesUnder(shared);
    assert.equal(files.length, 3, "one file per indexed file, put there in the same run");
    assert.ok(files.every((file) => /^embed-a-[0-9a-f]{8}[\\/][0-9a-f]{2}[\\/][0-9a-f]{64}\.vec$/.test(file)), files.join());
    assert.equal(one.index.embedding.given, 3);
    for (const file of files) {
      const text = fs.readFileSync(path.join(shared, file)).toString("latin1");
      assert.doesNotMatch(text, /passphrase|spooler|robocopy|accounts\.md/i, "numbers only: no text, no file names");
    }

    // The second PC: the same files somewhere else. Nothing is sent to the gateway, nothing counts against the budget.
    let spent = 0;
    let asked = 0;
    await two.index.refresh([two.folder], { ms: 20_000, embed: { ...embedWith(new docs.EmbedCache(shared)), spend: (/** @type {number} */ n) => { spent += n; },
      confirm: async () => { asked++; return true; } } });
    assert.deepEqual(two.index.vectorCount("embed-a"), { passages: 3, embedded: 3 });
    assert.deepEqual([calls, spent, asked, two.index.embedding.reused, two.index.embedding.tokens], [1, 0, 0, 3, 0]);
    const query = (await fakeEmbed(["password reset"])).vectors[0];
    const hits = await two.index.search("password reset", 10, { vector: query, model: "embed-a" });
    assert.equal(hits[0]?.path.endsWith("accounts.md"), true, "and they find by meaning as the first PC's do");

    // A file that changed is a different file: embedded here, and shared in its turn; the others aren't sent again.
    fs.writeFileSync(path.join(two.folder, "printers.md"), "# Printers\nRestart the spooler when a print job hangs, then print a test page.");
    await two.index.refresh([two.folder], { ms: 20_000, embed: embedWith(new docs.EmbedCache(shared)) });
    assert.equal(calls, 2);
    assert.equal(filesUnder(shared).length, 4);
    // Another model's vectors are kept apart.
    await two.index.refresh([two.folder], { ms: 20_000, embed: { ...embedWith(new docs.EmbedCache(shared)), model: "embed-b" } });
    assert.equal(calls, 3, "embed-b has nothing in the folder yet");
    assert.equal(filesUnder(shared).filter((file) => file.startsWith("embed-b-")).length, 3);
  } finally {
    one.index.close();
    two.index.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("shared embeddings: a PC that embedded before the folder was set gives what it has; no folder, or one that can't be used, changes nothing", async () => {
  const { base, shared, one, two } = sharedSetup();
  let calls = 0;
  const embed = { model: "embed-a", fn: (/** @type {string[]} */ texts) => { calls++; return fakeEmbed(texts); } };
  try {
    await one.index.refresh([one.folder], { ms: 20_000, embed });
    assert.equal(filesUnder(shared).length, 0);
    await one.index.refresh([one.folder], { ms: 20_000, embed: { ...embed, cache: new docs.EmbedCache(shared) } });
    assert.deepEqual([calls, filesUnder(shared).length, one.index.embedding.given], [1, 3, 3], "given without embedding anything again");
    await one.index.refresh([one.folder], { ms: 20_000, embed: { ...embed, cache: new docs.EmbedCache(shared) } });
    assert.equal(one.index.embedding.given, 3, "and not given twice");

    // A folder that can't be made (its parent is a file): embedding goes on through the gateway, and the problem is kept.
    const blocked = path.join(base, "a-file");
    fs.writeFileSync(blocked, "x");
    const cache = new docs.EmbedCache(path.join(blocked, "embeddings"));
    await two.index.refresh([two.folder], { ms: 20_000, embed: { ...embed, cache } });
    assert.deepEqual(two.index.vectorCount("embed-a"), { passages: 3, embedded: 3 });
    assert.equal(calls, 2);
    assert.ok(cache.off && two.index.embedding.sharedProblem, "left alone after a few failures, and said");
  } finally {
    one.index.close();
    two.index.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("shared embeddings: a file in the folder is used only if all of it is right", async () => {
  const { base, shared, one, two } = sharedSetup();
  try {
    await one.index.refresh([one.folder], { ms: 20_000, embed: { model: "embed-a", cache: new docs.EmbedCache(shared), fn: fakeEmbed } });
    const files = filesUnder(shared).map((file) => path.join(shared, file));
    const good = fs.readFileSync(files[0]);
    assert.equal(docs.unpackShared(good, 1)?.length, 1);
    assert.equal(docs.unpackShared(good, 2), null, "another number of passages");
    assert.equal(docs.unpackShared(good, 1, 99), null, "another length of vector than this PC's");
    assert.equal(docs.unpackShared(good.subarray(0, good.length - 1), 1), null, "cut short");
    assert.equal(docs.unpackShared(Buffer.concat([good, Buffer.alloc(4)]), 1), null, "too long");
    const flipped = Buffer.from(good);
    flipped[20] ^= 0xff;
    assert.equal(docs.unpackShared(flipped, 1), null, "a changed byte fails the checksum");
    assert.equal(docs.unpackShared(Buffer.from("not a vectors file at all, just some text that is long enough to pass the size check"), 1), null);
    // Not-a-number inside a file whose checksum is right (made on purpose): refused all the same.
    const nan = Buffer.alloc(4);
    nan.writeFloatLE(NaN);
    assert.equal(docs.unpackShared(/** @type {Buffer} */ (docs.packShared([Buffer.concat([nan, Buffer.alloc(8)])])), 1), null);
    assert.equal(docs.unpackShared(/** @type {Buffer} */ (docs.packShared([Buffer.alloc(12)])), 1), null, "all zeros");
    assert.equal(docs.packShared([Buffer.alloc(8), Buffer.alloc(12)]), null, "vectors of different lengths aren't written");
    assert.equal(docs.packShared([]), null);

    // Every shared file damaged: the second PC embeds through the gateway as if the folder were empty.
    for (const file of files) fs.writeFileSync(file, Buffer.concat([fs.readFileSync(file).subarray(0, 30), Buffer.from("garbage")]));
    let calls = 0;
    await two.index.refresh([two.folder], { ms: 20_000, embed: { model: "embed-a", cache: new docs.EmbedCache(shared), fn: (/** @type {string[]} */ texts) => { calls++; return fakeEmbed(texts); } } });
    assert.deepEqual([calls, two.index.embedding.reused, two.index.vectorCount("embed-a").embedded], [1, 0, 3]);
    assert.throws(() => new docs.EmbedCache(shared).fileOf("embed-a", "../../outside"), /not a passages hash/);
    assert.match(docs.EmbedCache.modelFolder("../..\\evil/model:1"), /^[A-Za-z0-9._-]+-[0-9a-f]{8}$/);
    assert.doesNotMatch(docs.EmbedCache.modelFolder(".."), /^\./);
  } finally {
    one.index.close();
    two.index.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("search by meaning has a floor: a question about nothing in the docs brings back nothing, not its nearest noise", async () => {
  const { base, one } = sharedSetup();
  try {
    await one.index.refresh([one.folder], { ms: 20_000, embed: { model: "embed-a", fn: fakeEmbed } });
    const related = (await fakeEmbed(["password reset"])).vectors[0];
    const unrelated = (await fakeEmbed(["zebra xylophone"])).vectors[0];
    // Related: well above any floor, and found though it shares no word with the passage.
    const found = await one.index.search("password reset", 10, { vector: related, model: "embed-a" });
    assert.equal(found[0]?.path.endsWith("accounts.md"), true);
    assert.ok(one.index.lastNearest.best > 0.8 && one.index.lastNearest.kept >= 1, JSON.stringify(one.index.lastNearest));
    // Unrelated: with no floor every passage "matches" (the old behaviour); with one just above its best, none does.
    const noise = await one.index.search("zebra xylophone", 10, { vector: unrelated, model: "embed-a", floor: 0 });
    assert.equal(noise.length, 3, "no floor: the nearest passages come back whatever they are");
    const best = one.index.lastNearest.best;
    assert.ok(best > 0 && best < 0.8, String(best));
    const none = await one.index.search("zebra xylophone", 10, { vector: unrelated, model: "embed-a", floor: best + 0.01 });
    assert.deepEqual(none, []);
    assert.deepEqual([one.index.lastNearest.kept, one.index.lastNearest.floor], [0, best + 0.01], "what the best was is kept, for the log");
    // Nothing near enough in meaning leaves the keyword ranking as it would be alone.
    const keyword = await one.index.search("spooler", 10, { vector: unrelated, model: "embed-a", floor: 0.999 });
    assert.deepEqual(keyword.map((hit) => path.basename(hit.path)), ["printers.md"]);
    assert.deepEqual(one.index.nearest(related, "embed-a", 5, 0.5).map(([, similarity]) => similarity >= 0.5), [true], "only passages at or above the floor");
  } finally {
    one.index.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the floor is one number for every embeddings model, and the setting overrides it", () => {
  const { meaningFloor, MEANING_FLOOR } = docs;
  assert.equal(MEANING_FLOOR, 0.58);
  // The setting: a number above 0 and up to 1 is the floor; 0 (the default) and anything odd leave Solder's own.
  assert.equal(meaningFloor(0.7), 0.7);
  assert.equal(meaningFloor(1), 1);
  for (const odd of [0, -1, 1.5, "high", null, undefined, NaN]) assert.equal(meaningFloor(odd), 0.58, String(odd));
});

test("embedding is paced to a rate of tokens a minute: each batch takes the time its tokens are worth; Stop ends a wait at once", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "solder-pace-"));
  const folder = path.join(base, "docs");
  fs.mkdirSync(folder);
  for (let i = 0; i < 70; i++) fs.writeFileSync(path.join(folder, `note-${String(i).padStart(2, "0")}.md`), `# Note ${i}\nThe printer on floor ${i} needs its spooler restarted.`);
  const make = (/** @type {string} */ name) => new docs.DocsIndex(path.join(base, name, "docs.sqlite"));
  const stamps = [];
  const embedder = (/** @type {number} */ tokens) => async (/** @type {string[]} */ texts) => { stamps.push(Date.now()); return { vectors: (await fakeEmbed(texts)).vectors, tokens }; };
  const fast = make("fast");
  const paced = make("paced");
  const stopped = make("stopped");
  const counted = make("counted");
  try {
    // No rate: three batches (32, 32, 6) as fast as they go.
    let began = Date.now();
    await fast.refresh([folder], { ms: 20_000, embed: { model: "embed-a", fn: embedder(100) } });
    assert.deepEqual(fast.vectorCount("embed-a"), { passages: 70, embedded: 70 });
    const unpaced = Date.now() - began;

    // 100 tokens a batch at 60,000 a minute: 100 ms a batch, so the three take about 300 ms, and no two start closer.
    stamps.length = 0;
    began = Date.now();
    await paced.refresh([folder], { ms: 20_000, embed: { model: "embed-a", fn: embedder(100), perMinute: () => 60_000 } });
    const took = Date.now() - began;
    assert.deepEqual(paced.vectorCount("embed-a"), { passages: 70, embedded: 70 });
    assert.equal(stamps.length, 3);
    assert.ok(stamps[1] - stamps[0] >= 90 && stamps[2] - stamps[1] >= 90, `batches started ${stamps[1] - stamps[0]} and ${stamps[2] - stamps[1]} ms apart`);
    assert.ok(took >= 280 && took > unpaced, `paced ${took} ms, unpaced ${unpaced} ms`);
    assert.equal(paced.embedding.pacing, false, "not left marked as waiting");

    // A gateway that reports no usage is paced by the text's size (four characters a token), not let through at full speed.
    stamps.length = 0;
    began = Date.now();
    await counted.refresh([folder], { ms: 20_000, embed: { model: "embed-a", fn: embedder(0), perMinute: () => 600_000 } });
    assert.ok(Date.now() - began >= 100, `with no usage reported it still waited (${Date.now() - began} ms)`);

    // A rate so low the wait would be minutes: Stop ends it at once, with what was embedded kept.
    const controller = new AbortController();
    began = Date.now();
    const once = embedder(100_000);
    const thenStop = async (/** @type {string[]} */ texts) => { setTimeout(() => controller.abort(), 150); return once(texts); }; // Stop, a moment into the wait
    await stopped.refresh([folder], { ms: 20_000, signal: controller.signal, embed: { model: "embed-a", fn: thenStop, perMinute: () => 1000 } });
    assert.ok(Date.now() - began < 3000, `stopped in ${Date.now() - began} ms`);
    assert.equal(stopped.vectorCount("embed-a").embedded, 32, "the first batch is kept; the rest waits for the next run");
  } finally {
    for (const index of [fast, paced, stopped, counted]) index.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
