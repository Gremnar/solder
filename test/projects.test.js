// @ts-check
"use strict";
/** Projects on disk: a .solder folder in the project's own folder, and the list of project folders you use. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ProjectList, readProject, createProject, renameProject, nearestProject, isProject, nameProblem, projectKey, skillsFolder } = require("../src/projects.js");

/** @param {(base: string) => void} body */
function inTemp(body) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "solder-projects-"));
  try { body(base); } finally { fs.rmSync(base, { recursive: true, force: true }); }
}

test("a new project is a .solder folder in the project's own folder: its name, and a place for skills", () => inTemp((base) => {
  const folder = path.join(base, "Decloning");
  fs.mkdirSync(folder);
  assert.equal(isProject(folder), false);
  const made = createProject(folder);
  assert.deepEqual([made.name, made.existed], ["Decloning", false], "named after its folder unless told otherwise");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, ".solder", "project.json"), "utf8")), { name: "Decloning" });
  assert.ok(fs.statSync(skillsFolder(folder)).isDirectory());
  assert.equal(isProject(folder), true);
  // Made again (someone else's project, opened here): left exactly as it is.
  fs.writeFileSync(path.join(folder, ".solder", "project.json"), JSON.stringify({ name: "SQL decloning", theirs: 1 }));
  assert.deepEqual(createProject(folder, "Other name"), { path: path.resolve(folder), name: "SQL decloning", existed: true });
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, ".solder", "project.json"), "utf8")).theirs, 1);
}));

test("a project is read from its folder: name, rules (its instruction files) and skills; everything relative, so it travels", () => inTemp((base) => {
  const folder = path.join(base, "proj");
  fs.mkdirSync(folder);
  createProject(folder, "My project");
  fs.writeFileSync(path.join(folder, "AGENTS.md"), "Target Windows PowerShell 5.1.\n");
  fs.writeFileSync(path.join(skillsFolder(folder), "deploy_steps.md"), "When to use: Deploying this project.\n\nRun the checks first.\n");
  const project = readProject(folder, ["AGENTS.md", "CLAUDE.md"]);
  assert.equal(project?.name, "My project");
  assert.deepEqual(project?.rules, [{ name: "AGENTS.md", text: "Target Windows PowerShell 5.1.\n", cut: false }]);
  assert.deepEqual(project?.skills.map((s) => [s.name, s.when]), [["deploy_steps", "Deploying this project."]]);
  // Moved somewhere else (unzipped on another PC): the same project.
  const moved = path.join(base, "elsewhere", "copy");
  fs.cpSync(folder, moved, { recursive: true });
  const again = readProject(moved, ["AGENTS.md"]);
  assert.deepEqual([again?.name, again?.rules.length, again?.skills.length], ["My project", 1, 1]);
  assert.equal(again?.skills[0].path, path.join(moved, ".solder", "skills", "deploy_steps.md"));
  assert.equal(readProject(path.join(base, "nothing")), null);
}));

test("rename keeps what else the file holds; names are one line, up to 60 characters", () => inTemp((base) => {
  createProject(base, "One");
  fs.writeFileSync(path.join(base, ".solder", "project.json"), JSON.stringify({ name: "One", future: { x: 1 } }));
  renameProject(base, "  Two  ");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(base, ".solder", "project.json"), "utf8")), { name: "Two", future: { x: 1 } });
  assert.match(nameProblem(""), /Give the project a name/);
  assert.match(nameProblem("x".repeat(61)), /up to 60/);
  assert.equal(nameProblem("SQL decloning (prod)"), "");
  assert.throws(() => renameProject(base, ""), /Give the project a name/);
}));

test("a project file that isn't a project's is not one; a name with odd characters is tidied", () => inTemp((base) => {
  fs.mkdirSync(path.join(base, ".solder"));
  for (const bad of ["not json", "[1,2]", "null", "42"]) {
    fs.writeFileSync(path.join(base, ".solder", "project.json"), bad);
    assert.equal(isProject(base), false, bad);
  }
  fs.writeFileSync(path.join(base, ".solder", "project.json"), JSON.stringify({ name: "Line one\nline two" }));
  assert.equal(readProject(base)?.name, "Line one line two");
  fs.writeFileSync(path.join(base, ".solder", "project.json"), JSON.stringify({ name: 7 }));
  assert.equal(readProject(base)?.name, path.basename(base), "no usable name: the folder's");
}));

test("rules come only from the project's own files: a name with a path in it, or a link out of the folder, isn't read", (t) => inTemp((base) => {
  const folder = path.join(base, "proj");
  const outside = path.join(base, "secret.txt");
  fs.mkdirSync(folder);
  createProject(folder);
  fs.writeFileSync(outside, "a secret");
  assert.deepEqual(readProject(folder, ["../secret.txt", "..", "sub/AGENTS.md"])?.rules, []);
  try { fs.symlinkSync(outside, path.join(folder, "AGENTS.md"), "file"); } catch { t.diagnostic("file links aren't allowed here: not tested"); return; }
  assert.deepEqual(readProject(folder, ["AGENTS.md"])?.rules, [], "a link to a file outside the project isn't its rules");
}));

test("the nearest project above a folder is found, so a subfolder of a project is in it", () => inTemp((base) => {
  const project = path.join(base, "scripts", "SQL");
  const deep = path.join(project, "Decloning", "old");
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(nearestProject(deep), "");
  createProject(project);
  assert.equal(nearestProject(deep), path.resolve(project));
  assert.equal(nearestProject(project), path.resolve(project));
  assert.equal(nearestProject(path.join(base, "scripts")), "");
}));

test("the list of projects you use: added once however the folder is spelt, kept across restarts, removed without touching the folder", () => inTemp((base) => {
  const file = path.join(base, "storage", "projects.json");
  const folder = path.join(base, "Proj");
  fs.mkdirSync(folder);
  createProject(folder);
  const list = new ProjectList(file);
  assert.equal(list.has(folder), false);
  assert.equal(list.add(folder), true);
  assert.equal(list.add(folder.toUpperCase() + path.sep), false, "the same folder, spelt another way");
  assert.equal(projectKey(folder), projectKey(folder.toUpperCase() + path.sep));
  assert.deepEqual(new ProjectList(file).paths(), [path.resolve(folder)], "saved");
  list.remove(folder);
  assert.deepEqual(new ProjectList(file).paths(), []);
  assert.equal(isProject(folder), true, "the folder is still a project");
  fs.writeFileSync(file, "not json");
  assert.deepEqual(new ProjectList(file).paths(), [], "an unreadable list is an empty one");
  fs.writeFileSync(file, JSON.stringify({ projects: [{ path: "relative/path" }, { path: 7 }, null, { path: folder }] }));
  assert.deepEqual(new ProjectList(file).paths(), [path.resolve(folder)], "only real folder paths are taken");
}));

test("a project's skill switches are in its own file, so they travel: set, read back, taken away, the rest of the file kept, and only true or false is read", () => inTemp((base) => {
  const { projectSwitches, setProjectSwitch } = require("../src/projects.js");
  const folder = path.join(base, "Proj");
  const file = path.join(folder, ".solder", "project.json");
  fs.mkdirSync(folder);
  assert.deepEqual({ ...projectSwitches(folder) }, {}, "not a project: none");
  assert.throws(() => setProjectSwitch(folder, "x", true), /isn't a project/);
  createProject(folder, "Proj");
  fs.writeFileSync(file, JSON.stringify({ name: "Proj", future: { x: 1 } }));
  setProjectSwitch(folder, " PS_Scripts ", false);
  setProjectSwitch(folder, "sql_style", true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { name: "Proj", future: { x: 1 }, skills: { ps_scripts: false, sql_style: true } });
  // Copied somewhere else (unzipped on another PC): the switches come along.
  const moved = path.join(base, "elsewhere");
  fs.cpSync(folder, moved, { recursive: true });
  assert.deepEqual({ ...projectSwitches(moved) }, { ps_scripts: false, sql_style: true });
  setProjectSwitch(folder, "ps_scripts", null);
  setProjectSwitch(folder, "SQL_Style", null);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { name: "Proj", future: { x: 1 } }, "none left: the key goes");
  assert.equal(readProject(folder)?.name, "Proj");
  fs.writeFileSync(file, JSON.stringify({ name: "Proj", skills: { a: true, b: "yes", c: 0, " D ": false, "": true } }));
  assert.deepEqual({ ...projectSwitches(folder) }, { a: true, d: false });
  fs.writeFileSync(file, JSON.stringify({ name: "Proj", skills: [true] }));
  assert.deepEqual({ ...projectSwitches(folder) }, {});
  // The list of your projects holds folders only.
  const list = new ProjectList(path.join(base, "storage", "projects.json"));
  list.add(folder);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(base, "storage", "projects.json"), "utf8")).projects[0]).sort(), ["added", "path"]);
}));

test("a project's export: its own files or the whole folder, under the folder's name, links never followed; the zip reads back whole", async (t) => {
  const { exportEntries, findProjects } = require("../src/projects.js");
  const { writeZip, crc32 } = require("../src/zip.js");
  const { unzip } = require("../src/docs.js");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "solder-export-"));
  try {
    const folder = path.join(base, "Script tests");
    fs.mkdirSync(path.join(folder, "src", "deep"), { recursive: true });
    fs.mkdirSync(path.join(folder, ".git"), { recursive: true });
    fs.mkdirSync(path.join(folder, "node_modules", "x"), { recursive: true });
    createProject(folder, "Script tests");
    fs.writeFileSync(path.join(folder, "AGENTS.md"), "Rules.\n");
    fs.writeFileSync(path.join(folder, "CLAUDE.md"), "More rules.\n");
    fs.writeFileSync(path.join(skillsFolder(folder), "run_tests.md"), "When to use: Running the tests.\n\nRun them.\n");
    fs.writeFileSync(path.join(folder, "src", "a.ps1"), "Write-Host 'a'\n".repeat(500));
    fs.writeFileSync(path.join(folder, "src", "deep", "ünï.txt"), "ünïcode\n");
    fs.writeFileSync(path.join(folder, "src", "empty.txt"), "");
    fs.writeFileSync(path.join(folder, ".git", "config"), "[core]\n");
    fs.writeFileSync(path.join(folder, "node_modules", "x", "index.js"), "x\n");
    const outside = path.join(base, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "a secret\n");
    let linked = true;
    try { fs.symlinkSync(outside, path.join(folder, "src", "link"), "junction"); } catch { linked = false; t.diagnostic("a junction couldn't be made here: links not tested"); }

    const own = await exportEntries(folder, "own", ["AGENTS.md", "CLAUDE.md", "../outside/secret.txt", "NONE.md"]);
    assert.deepEqual(own.entries.map((e) => e.name), ["Script tests/AGENTS.md", "Script tests/CLAUDE.md", "Script tests/.solder/project.json", "Script tests/.solder/skills/run_tests.md"]);
    const all = await exportEntries(folder, "all");
    const names = all.entries.map((e) => e.name);
    assert.ok(names.includes("Script tests/src/a.ps1") && names.includes("Script tests/src/deep/ünï.txt") && names.includes("Script tests/.solder/project.json"));
    assert.ok(!names.some((name) => /\/\.git\/|\/node_modules\//.test(name)), "git's store and installed packages stay out");
    assert.ok(!names.some((name) => name.includes("secret") || name.includes("/link")), "a link out of the folder isn't followed" + (linked ? "" : " (not tested here)"));
    assert.equal((await exportEntries(folder, "all", undefined, { limit: 2 })).tooMany, true);
    await assert.rejects(exportEntries(outside, "own"), /isn't a project/);

    const target = path.join(base, "Script tests.solder.zip");
    const done = await writeZip(target, [...all.entries, { name: "Script tests/gone.txt", file: path.join(folder, "gone.txt") }]);
    assert.deepEqual([done.files, done.skipped], [all.entries.length, ["Script tests/gone.txt"]], "a file that can't be read is left out and named");
    assert.equal(done.bytes, fs.statSync(target).size);
    const back = unzip(fs.readFileSync(target), () => true);
    assert.deepEqual([...back.keys()].sort(), [...names].sort());
    for (const entry of all.entries) assert.ok(back.get(entry.name).equals(fs.readFileSync(entry.file)), entry.name);
    assert.equal(fs.readdirSync(base).some((name) => name.endsWith(".part")), false, "nothing half-made is left");
    assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926, "the standard check value");
    // Names that would land outside where the zip is unpacked are refused, and no file is left behind.
    const bad = path.join(base, "bad.zip");
    await assert.rejects(writeZip(bad, [{ name: "../evil.txt", data: Buffer.from("x") }]), /Not a name for inside a zip/);
    await assert.rejects(writeZip(bad, [{ name: "/abs.txt", data: Buffer.from("x") }]), /Not a name for inside a zip/);
    assert.equal(fs.existsSync(bad) || fs.readdirSync(base).some((name) => name.startsWith("bad.zip")), false);

    // Looking for projects in a window's folders: the folder itself or one above it, and the folders just inside it.
    const inner = path.join(base, "Second");
    fs.mkdirSync(path.join(inner, "sub"), { recursive: true });
    createProject(inner, "Second one");
    fs.mkdirSync(path.join(base, "plain"));
    const found = await findProjects([base, path.join(inner, "sub"), path.join(base, "no-such-folder")]);
    assert.deepEqual(found.map((p) => p.name).sort(), ["Script tests", "Second one"], "each once, however it was reached");
    assert.deepEqual(await findProjects([base], { ms: -1 }), [], "out of time: nothing, rather than holding anything up");
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
