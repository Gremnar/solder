// @ts-check
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writeZip, filesUnder, isZipOutput } = require("../src/zip.js");
const { unzip } = require("../src/docs.js");

test("a folder inside that can't be listed is named among those left out; the folder itself not listed is an error", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "solder-zip-fix-"));
  const real = fs.promises.readdir;
  try {
    const folder = path.join(base, "proj");
    fs.mkdirSync(path.join(folder, "locked"), { recursive: true });
    fs.writeFileSync(path.join(folder, "a.txt"), "a");
    fs.writeFileSync(path.join(folder, "locked", "b.txt"), "b");
    /** @type {any} */ (fs.promises).readdir = async (/** @type {any} */ at, /** @type {any} */ options) => {
      if (String(at).endsWith("locked")) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return real(at, options);
    };
    const listed = await filesUnder(folder, "proj");
    const done = await writeZip(path.join(base, "out.zip"), listed.entries);
    assert.deepEqual([done.files, done.skipped], [1, ["proj/locked"]]);
    assert.deepEqual([...unzip(fs.readFileSync(path.join(base, "out.zip")), () => true).keys()], ["proj/a.txt"]);
    await assert.rejects(filesUnder(path.join(folder, "locked"), "x"), /couldn't be read/);
    await assert.rejects(filesUnder(path.join(base, "no-such"), "x"), /couldn't be read/);
  } finally { fs.promises.readdir = real; fs.rmSync(base, { recursive: true, force: true }); }
});

test("stopping an export, while listing or writing, leaves a zip already there as it was", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "solder-zip-fix-"));
  try {
    const folder = path.join(base, "proj");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "a.txt"), "a");
    const target = path.join(base, "good.zip");
    await writeZip(target, (await filesUnder(folder, "proj")).entries);
    const before = fs.readFileSync(target);
    const stopped = new AbortController();
    stopped.abort();
    await assert.rejects(filesUnder(folder, "proj", { signal: stopped.signal }), /Stopped/);
    await assert.rejects(writeZip(target, [], { signal: stopped.signal }), /Stopped/);
    // Stopped after the last file was written, before the zip takes the name.
    const late = new AbortController();
    await assert.rejects(writeZip(target, [{ name: "x.txt", data: Buffer.from("x") }], { signal: late.signal, onEntry: () => late.abort() }), /Stopped/);
    assert.ok(fs.readFileSync(target).equals(before), "the earlier zip is untouched");
    assert.equal(fs.readdirSync(base).some((name) => name.endsWith(".part")), false, "nothing half-made is left");
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("the zip being written is never put in itself, but a file beside it with a longer name is", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "solder-zip-fix-"));
  try {
    const target = path.join(base, "release.zip");
    fs.writeFileSync(target, "an older zip");
    fs.writeFileSync(`${target}.sha256`, "abc");
    fs.writeFileSync(`${target}.999.part`, "another window's half-made one");
    assert.equal(isZipOutput(target.toUpperCase(), target), true);
    assert.equal(isZipOutput(`${target}.999.part`, target), true);
    assert.equal(isZipOutput(`${target}.sha256`, target), false);
    assert.equal(isZipOutput(path.join(base, "release.zipper", "x"), target), false);
    const listed = await filesUnder(base, "");
    const done = await writeZip(target, listed.entries);
    assert.deepEqual([done.files, done.skipped], [1, []]);
    assert.deepEqual([...unzip(fs.readFileSync(target), () => true).keys()], ["release.zip.sha256"]);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
