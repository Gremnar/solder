// @ts-check
"use strict";
// Skills: the reader (src/skills.js), and how read_file hands one over (whole, kept, not twice).
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parse, readSkill, listSkills, isSkill, MAX_SKILL_CHARS, MAX_WHEN_CHARS } = require("../src/skills.js");

test("a skill's first line says when to use it; the instructions follow", () => {
  assert.deepEqual(parse("When to use: Writing a PowerShell script.\n\nUse approved verbs.\nTest it first.\n"),
    { when: "Writing a PowerShell script.", text: "Use approved verbs.\nTest it first." });
  assert.deepEqual(parse("﻿when to use:   Fixing   flaky tests\r\n\r\nStep one.\r\n"), { when: "Fixing flaky tests", text: "Step one." });
  assert.deepEqual(parse("Just instructions, no when.\n"), { when: "", text: "Just instructions, no when." });
  assert.deepEqual(parse(""), { when: "", text: "" });
});

test("front matter gives the when as description:, and is left out of the instructions", () => {
  assert.deepEqual(parse("---\nname: ignored\ndescription: Review a pull request.\n---\n\n# Steps\n1. Read it.\n"),
    { when: "Review a pull request.", text: "# Steps\n1. Read it." });
  assert.deepEqual(parse("---\ndescription: \"Quoted: with a colon\"\n---\nBody"), { when: "Quoted: with a colon", text: "Body" });
  assert.deepEqual(parse("---\ndescription: 'It''s quoted'\n---\nBody"), { when: "It's quoted", text: "Body" });
  assert.deepEqual(parse("---\nname: x\ndescription: >-\n  Folded over\n  two lines.\nlicense: MIT\n---\nBody"), { when: "Folded over two lines.", text: "Body" });
  assert.deepEqual(parse("---\nname: x\n---\nWhen to use: From the line instead.\n\nBody"), { when: "From the line instead.", text: "Body" });
  assert.deepEqual(parse("---\ndescription: Front wins.\n---\nWhen to use: The line.\n\nBody"), { when: "Front wins.", text: "Body" },
    "a When line under front matter isn't left in the instructions either");
  assert.equal(parse("--- not front matter\nBody").text, "--- not front matter\nBody");
  assert.equal(parse("When to use: " + "x ".repeat(400)).when.length, MAX_WHEN_CHARS);
});

test("the skills folders: .md files only, the organisation's folder first, a name only once", () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "solder-skills-"));
  try {
    const org = path.join(top, "org");
    const mine = path.join(top, "mine");
    fs.mkdirSync(path.join(org, "sub"), { recursive: true });
    fs.mkdirSync(mine);
    fs.writeFileSync(path.join(org, "Review.md"), "When to use: Reviewing code.\n\nThe org's way.");
    fs.writeFileSync(path.join(org, "notes.txt"), "not a skill");
    fs.writeFileSync(path.join(org, "sub", "deep.md"), "When to use: Never listed.\n\nX");
    fs.writeFileSync(path.join(org, ".hidden.md"), "When to use: Hidden.\n\nX");
    fs.writeFileSync(path.join(mine, "review.md"), "When to use: Mine.\n\nShadowed by the org's.");
    fs.writeFileSync(path.join(mine, "a_first.md"), "No when line here.");
    fs.writeFileSync(path.join(mine, "empty.md"), "When to use: Nothing.\n");
    fs.writeFileSync(path.join(mine, "utf16.md"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("When to use: Notepad's Unicode.\n\nÜnïcode body", "utf16le")]));
    const found = listSkills([org, path.join(top, "missing"), mine]);
    assert.deepEqual(found.map((s) => s.name), ["Review", "a_first", "empty", "utf16"]);
    assert.equal(found[0].text, "The org's way.");
    assert.match(found[1].problem, /no "When to use:" line/);
    assert.equal(found[1].text, "No when line here.");
    assert.match(found[2].problem, /no instructions/);
    assert.deepEqual([found[3].when, found[3].text], ["Notepad's Unicode.", "Ünïcode body"]);
    assert.ok(isSkill([org, mine], path.join(mine, "a_first.md")));
    assert.ok(isSkill([org], path.join(org.toUpperCase(), "Review.md")), "case doesn't matter on Windows paths");
    assert.ok(!isSkill([org, mine], path.join(org, "sub", "deep.md")), "subfolders hold no skills");
    assert.ok(!isSkill([org, mine], path.join(org, "notes.txt")));
    fs.writeFileSync(path.join(mine, "long.md"), "When to use: Long.\n\n" + "y".repeat(MAX_SKILL_CHARS + 50));
    const long = readSkill(path.join(mine, "long.md"));
    assert.equal(long.text.length, MAX_SKILL_CHARS);
    assert.ok(long.cut);
    fs.writeFileSync(path.join(mine, "huge.md"), Buffer.alloc(1024 * 1024 + 1, 0x61));
    assert.match(readSkill(path.join(mine, "huge.md")).problem, /over 1 MB/);
  } finally {
    fs.rmSync(top, { recursive: true, force: true });
  }
});

// read_file on a skill, with a stand-in for the vscode module (as test/tools.test.js does).
const load = /** @type {any} */ (Module)._load;
/** @type {any} */ (Module)._load = function (/** @type {string} */ request, /** @type {any[]} */ ...rest) {
  return request === "vscode" ? { Uri: { file: (/** @type {string} */ fsPath) => ({ fsPath, scheme: "file" }) }, languages: { onDidChangeDiagnostics: () => ({ dispose() {} }) }, FileType: { File: 1, Directory: 2 },
    workspace: { textDocuments: [], getConfiguration: () => ({ get: (/** @type {string} */ _key, /** @type {any} */ fallback) => fallback }),
      fs: { stat: async (/** @type {any} */ uri) => { const st = fs.statSync(uri.fsPath); return { type: st.isDirectory() ? 2 : 1, size: st.size }; } },
      openTextDocument: async (/** @type {any} */ uri) => {
        const all = fs.readFileSync(uri.fsPath, "utf8").split(/\r\n|\r|\n/);
        return { lineCount: all.length, lineAt: (/** @type {number} */ i) => ({ text: all[i] }), getText: () => all.join("\n") };
      } } } : load.call(this, request, ...rest);
};

test("read_file hands over a skill whole and kept, needs no approval, and doesn't send it twice", async () => {
  const { WorkspaceTools } = require("../src/tools.js");
  const { RESULTS } = require("../src/prompt.js");
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "solder-skillread-"));
  try {
    const ws = path.join(top, "ws");
    const folder = path.join(top, "skills");
    fs.mkdirSync(ws);
    fs.mkdirSync(path.join(folder, "sub"), { recursive: true });
    const file = path.join(folder, "ps_scripts.md");
    fs.writeFileSync(file, "When to use: Writing PowerShell.\n\nLine one.\nLine two.\nLine three.\n");
    fs.writeFileSync(path.join(folder, "sub", "helper.txt"), "a\nb\n");
    const tools = new WorkspaceTools(/** @type {any} */ ({ globalStorageUri: { fsPath: path.join(top, "store") }, subscriptions: [] }));
    tools.roots = () => [ws];
    tools.docsFolders = () => [];
    tools.skillsFolders = () => [folder];
    assert.equal(tools.needsApproval("read_file", { path: file }), null, "skills folders are read freely");
    assert.equal(tools.needsApproval("read_file", { path: path.join(folder, "sub", "helper.txt") }), null);
    assert.match(String(tools.needsApproval("write_file", { path: file })), /outside the workspace/, "changing a skill still asks");
    tools.skillsFolders = () => [];
    assert.match(String(tools.needsApproval("read_file", { path: file })), /reads a file outside/);
    tools.skillsFolders = () => [folder];

    /** @type {any} */
    const chat = { messages: [] };
    const first = await tools.run("read_file", { path: file, start_line: 2, end_line: 2 }, { chat, signal: new AbortController().signal });
    assert.equal(first.keep, "Skill: ps_scripts\nWhen to use: Writing PowerShell.\n\nLine one.\nLine two.\nLine three.", "whole, whatever range was asked");
    assert.equal(first.output, RESULTS.skillRead("ps_scripts", 0));
    assert.doesNotMatch(first.keep, /^\d+\t/m, "no line numbers");

    chat.messages.push({ role: "tool", content: first.output + "\n\n" + first.keep, meta: { keep: first.keep } });
    const again = await tools.run("read_file", { path: file }, { chat, signal: new AbortController().signal });
    assert.equal(again.output, RESULTS.skillAgain("ps_scripts"));
    assert.equal(again.keep, undefined);

    // Changed since: sent again. Summarised away: sent again.
    fs.writeFileSync(file, "When to use: Writing PowerShell.\n\nLine one, changed.\n");
    assert.match(String((await tools.run("read_file", { path: file }, { chat, signal: new AbortController().signal })).keep), /changed/);
    fs.writeFileSync(file, "When to use: Writing PowerShell.\n\nLine one.\nLine two.\nLine three.\n");
    chat.compaction = { through: 1, summary: "S" };
    assert.ok((await tools.run("read_file", { path: file }, { chat, signal: new AbortController().signal })).keep);

    // A network path is opened only inside a network folder that's set up as docs or skills, compared as written.
    assert.throws(() => tools.resolve("\\\\server\\share\\skills\\a.md"), /Network paths/);
    tools.skillsFolders = () => ["\\\\server\\share\\skills"];
    assert.equal(tools.resolve("\\\\server\\share\\skills\\a.md").inside, false);
    assert.throws(() => tools.resolve("\\\\server\\share\\skills\\..\\secret.txt"), /Network paths/);
    assert.throws(() => tools.resolve("\\\\server\\share\\skillset\\a.md"), /Network paths/);
    assert.throws(() => tools.resolve("\\\\evil\\share\\skills\\a.md"), /Network paths/);
    tools.skillsFolders = () => [folder];

    // Not a skill: a file in a subfolder, and a skill file with nothing to follow, are read as files.
    const plain = await tools.run("read_file", { path: path.join(folder, "sub", "helper.txt") }, { chat, signal: new AbortController().signal });
    assert.match(plain.output, /^1\ta$/m);
    fs.writeFileSync(path.join(folder, "blank.md"), "When to use: Nothing yet.\n");
    const blank = await tools.run("read_file", { path: path.join(folder, "blank.md") }, { chat, signal: new AbortController().signal });
    assert.equal(blank.keep, undefined);
    assert.match(blank.output, /^1\tWhen to use/m);
  } finally {
    fs.rmSync(top, { recursive: true, force: true });
  }
});
