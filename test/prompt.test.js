// @ts-check
"use strict";
/**
 * Pins every fixed text the model sees (src/prompt.js). If you changed one on purpose, live-test it
 * against real models, then put the new fingerprint printed by the failing test into PINNED.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { RULES, TOOLS, READ_ONLY, TEXTS, RESULTS, systemPrompt, toolDefinitions, timeNote } = require("../src/prompt.js");

const PINNED = "db377d87864c7119";

/** Sample arguments for every text that's a function: name → a list of argument lists. */
const SAMPLES = {
  notRunBatch: [[5]], userNote: [["NOTE"]], unknownTool: [["nope", ["a", "b"]]], missing: [["edit_file", "path"]],
  wrongType: [["read_file", "start_line", "integer"], ["search", "regex", "boolean"], ["search", "query", "string"]],
  wrapUp: [[0], [1], [3]], steer: [["STEER"]], stub: [["SUMMARY"]],
};
const RESULT_SAMPLES = {
  error: [["E"]], noTool: [["nope"]], missing: [["a.js"]], isFolder: [["src"]], readFolder: [["src"]], tooLarge: [["a.bin", 21]],
  notText: [["a.bin"]], readPart: [[1, 2000, 4100]], folderAgents: [["sub/AGENTS.md", "TEXT"]], noMatches: [["q", ""], ["q", "*.py"]],
  searchCapped: [[200]], noFiles: [["*.x"]], filesCapped: [[300]], manyMatches: [[3, "a.js", [4, 9, 12]]],
  notFound: [["a.js", 0], ["a.js", 7]], notApplied: [["a.js"]], edited: [["a.js", 1, 1, 5], ["a.js", 3, 0, 9]],
  written: [[true, "a.js", 1], [false, "b.js", 40]], newProblems: [["a.js", ["- line 3: X"], 0], ["a.js", ["- line 3: X"], 2]],
  noProblems: [[""], ["a.js"]], moreProblems: [[4]], removeNoTrash: [["big"]], removed: [["a.js", null], ["src", 1], ["src", 1200]],
};

/** @param {Record<string, any>} group @param {Record<string, any[][]>} samples @param {string} name */
function filled(group, samples, name) {
  /** @type {Record<string, string>} */
  const texts = {};
  for (const [key, value] of Object.entries(group)) {
    if (typeof value === "string") { texts[key] = value; continue; }
    assert.ok(samples[key], `${name}.${key} is a function: add sample arguments for it in this test`);
    samples[key].forEach((args, index) => { texts[`${key}#${index}`] = value(...args); });
  }
  return texts;
}

/** Every text, with the functions filled in with fixed sample values. */
function everything() {
  return {
    system: systemPrompt({ workspace: "C:\\work", os: "Windows", instructions: [{ path: "AGENTS.md", text: "AGENTS" }], rules: "RULE" }),
    bare: systemPrompt({ workspace: "C:\\work" }),
    tools: toolDefinitions(),
    texts: filled(TEXTS, SAMPLES, "TEXTS"),
    results: filled(RESULTS, RESULT_SAMPLES, "RESULTS"),
    time: timeNote(new Date(2026, 10, 4, 14, 5)),
  };
}

test("the model-facing texts match the pinned fingerprint", () => {
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(everything())).digest("hex").slice(0, 16);
  assert.equal(fingerprint, PINNED,
    `src/prompt.js changed. If that was deliberate, live-test it, then set PINNED to "${fingerprint}".`);
});

test("the tools: a fixed order, every argument described and typed, required ones defined", () => {
  const definitions = toolDefinitions();
  assert.deepEqual(definitions.map((d) => d.function.name),
    ["read_file", "search", "find_files", "edit_file", "write_file", "remove_item", "problems"]);
  assert.deepEqual(toolDefinitions(), definitions, "the same every time");
  for (const { type, function: fn } of definitions) {
    assert.equal(type, "function");
    assert.ok(fn.description.length > 20 && fn.description.length < 400, `${fn.name}: a short description`);
    assert.equal(fn.parameters.type, "object");
    for (const [arg, schema] of Object.entries(fn.parameters.properties)) {
      assert.ok(["string", "integer", "boolean"].includes(schema.type), `${fn.name}.${arg}: a type`);
      assert.ok(schema.description && schema.description.endsWith("."), `${fn.name}.${arg}: a one-line description`);
    }
    for (const arg of fn.parameters.required) assert.ok(arg in fn.parameters.properties, `${fn.name}: ${arg} is defined`);
  }
  for (const name of READ_ONLY) assert.ok(name in TOOLS, `${name} is a tool`);
  assert.ok(!READ_ONLY.has("edit_file") && !READ_ONLY.has("write_file") && !READ_ONLY.has("remove_item"));
});

test("the rules name every tool, say there's no shell, and stay small", () => {
  for (const name of Object.keys(TOOLS)) assert.ok(RULES.includes(name), `the rules mention ${name}`);
  assert.match(RULES, /can't run commands/);
  assert.match(RULES, /Never guess what a file says/);
  assert.match(RULES, /don't put your reasoning, drafts or second thoughts in it/);
  // Every request resends these: keep the rules under ~600 tokens and the tools under ~1,000.
  assert.ok(RULES.length / 4 < 600, `RULES is ${Math.ceil(RULES.length / 4)} tokens`);
  assert.ok(JSON.stringify(toolDefinitions()).length / 4 < 1000, "the tool definitions grew");
});

test("the system prompt is stable: no time, instructions and rules only when given", () => {
  const plain = systemPrompt({ workspace: "C:\\work" });
  assert.equal(systemPrompt({ workspace: "C:\\work" }), plain);
  assert.ok(plain.startsWith(RULES));
  assert.doesNotMatch(plain, /\d{1,2}:\d{2}|20\d\d/, "no time or date in it");
  assert.doesNotMatch(plain, /Project instructions|The user's rules/);
  assert.match(plain, /There's no project instructions file/, "so the model doesn't go looking for one");
  assert.match(plain, /Workspace folder: C:\\work\./);
  assert.match(systemPrompt({ workspace: "" }), /\(none open\)/);
  assert.match(systemPrompt({ workspace: "C:\\work", rules: "   " }), /your first read there\.$/, "blank rules add nothing");
  const full = systemPrompt({ workspace: "C:\\work", instructions: [{ path: "AGENTS.md", text: "\nUse tabs.\n" }], rules: " Be brief. " });
  assert.doesNotMatch(full, /There's no project instructions file/);
  assert.ok(full.endsWith("# Project instructions (AGENTS.md)\nUse tabs.\n\n# The user's rules\nBe brief."));
});

test("each user message starts with the local date and time", () => {
  assert.equal(timeNote(new Date(2026, 10, 4, 14, 5)), "(Wednesday, 4 November 2026, 14:05)");
  assert.equal(timeNote(new Date(2026, 0, 9, 9, 7)), "(Friday, 9 January 2026, 09:07)");
});

test("the notes read right", () => {
  assert.equal(TEXTS.wrapUp(1), "1 more reply with tool calls left for this message: finish up, then say what's done.");
  assert.match(TEXTS.wrapUp(3), /^3 more replies/);
  assert.match(TEXTS.wrapUp(0), /answer now/);
  assert.equal(TEXTS.wrongType("a", "b", "integer"), "a's b must be a whole number; it wasn't run.");
  assert.match(TEXTS.unknownTool("run", ["read_file", "search"]), /no tool called run\. The tools are: read_file, search\./);
  assert.ok(TEXTS.emptyReply.startsWith("\n\n"), "it's appended to a result");
});
