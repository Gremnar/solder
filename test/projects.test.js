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

test("your switches for skills in a project are kept with the list: set, kept across restarts, taken away, and only true or false is read back", () => inTemp((base) => {
  const file = path.join(base, "storage", "projects.json");
  const folder = path.join(base, "Proj");
  fs.mkdirSync(folder);
  createProject(folder);
  const list = new ProjectList(file);
  list.setSwitch(folder, "PS_Scripts", false);
  assert.deepEqual(list.switches(folder), {}, "a folder that isn't on the list has none");
  list.add(folder);
  list.setSwitch(folder, " PS_Scripts ", false);
  list.setSwitch(folder, "sql_style", true);
  assert.deepEqual({ ...new ProjectList(file).switches(folder.toUpperCase()) }, { ps_scripts: false, sql_style: true }, "by lower-case name, however the folder is spelt");
  list.setSwitch(folder, "ps_scripts", null);
  assert.deepEqual({ ...new ProjectList(file).switches(folder) }, { sql_style: true });
  assert.equal(fs.existsSync(path.join(folder, ".solder", "project.json")) && Object.keys(JSON.parse(fs.readFileSync(path.join(folder, ".solder", "project.json"), "utf8"))).join(), "name", "nothing about switches goes in the project's folder");
  fs.writeFileSync(file, JSON.stringify({ projects: [{ path: folder, skills: { a: true, b: "yes", c: 0, " D ": false, "": true } }, { path: folder + "2", skills: [true] }] }));
  assert.deepEqual({ ...new ProjectList(file).switches(folder) }, { a: true, d: false });
  assert.deepEqual({ ...new ProjectList(file).switches(folder + "2") }, {});
  list.remove(folder);
  assert.deepEqual(list.switches(folder), {});
}));
