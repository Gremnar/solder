// @ts-check
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createProject, renameProject, setProjectSwitch, readProject, ownSkillsFolder, skillsFolder } = require("../src/projects.js");

test("renaming a project changes its name alone, and a read that fails stops it rather than writing the name over the rest", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "solder-proj-fix-"));
  const real = fs.readFileSync;
  try {
    const folder = path.join(base, "Proj");
    fs.mkdirSync(folder);
    createProject(folder, "Proj");
    setProjectSwitch(folder, "ps_scripts", false);
    const file = path.join(folder, ".solder", "project.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), extra: { kept: 1 } }));
    // The file reads once, then not (a share dropping for a moment).
    let reads = 0;
    /** @type {any} */ (fs).readFileSync = function (/** @type {any} */ at, /** @type {any[]} */ ...rest) {
      if (String(at).endsWith("project.json") && ++reads > 1) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      return real.call(this, at, ...rest);
    };
    renameProject(folder, "New name");
    fs.readFileSync = real;
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { name: "New name", skills: { ps_scripts: false }, extra: { kept: 1 } });
    // It can't be read at all: nothing written.
    /** @type {any} */ (fs).readFileSync = function (/** @type {any} */ at, /** @type {any[]} */ ...rest) {
      if (String(at).endsWith("project.json")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      return real.call(this, at, ...rest);
    };
    assert.throws(() => renameProject(folder, "Other"), /isn't a project any more/);
    fs.readFileSync = real;
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).name, "New name");
    assert.throws(() => renameProject(folder, ""), /Give the project a name/);
  } finally { fs.readFileSync = real; fs.rmSync(base, { recursive: true, force: true }); }
});

test("a project's skills folder that's a junction out of the project lists no skills, and isn't the project's own", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "solder-proj-fix-"));
  try {
    const folder = path.join(base, "Proj");
    fs.mkdirSync(folder);
    createProject(folder, "Proj");
    fs.writeFileSync(path.join(skillsFolder(folder), "mine.md"), "When to use: Mine.\n\nBody.\n");
    assert.deepEqual(readProject(folder)?.skills.map((s) => s.name), ["mine"]);
    assert.equal(ownSkillsFolder(folder), skillsFolder(path.resolve(folder)));

    const outside = path.join(base, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "evil.md"), "When to use: Anything.\n\nBody.\n");
    fs.rmSync(skillsFolder(folder), { recursive: true });
    assert.equal(ownSkillsFolder(folder), skillsFolder(path.resolve(folder)), "not made yet, inside the project's own .solder: its own");
    try { fs.symlinkSync(outside, skillsFolder(folder), "junction"); } catch { t.skip("a junction couldn't be made here"); return; }
    assert.deepEqual(readProject(folder)?.skills, [], "the junction's files aren't the project's skills");
    assert.equal(ownSkillsFolder(folder), null);

    // A junction to a folder inside the project is still the project's (as the model's tools have it).
    fs.rmSync(skillsFolder(folder));
    const inner = path.join(folder, "skills-here");
    fs.mkdirSync(inner);
    fs.writeFileSync(path.join(inner, "inner.md"), "When to use: Inner.\n\nBody.\n");
    fs.symlinkSync(inner, skillsFolder(folder), "junction");
    assert.deepEqual(readProject(folder)?.skills.map((s) => s.name), ["inner"]);
    assert.ok(ownSkillsFolder(folder));

    // .solder itself a junction out: a skills folder not made yet there isn't the project's own either.
    const other = path.join(base, "Other");
    fs.mkdirSync(other);
    const elsewhere = path.join(base, "elsewhere-solder");
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(other, ".solder"), "junction");
    assert.equal(ownSkillsFolder(other), null);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
