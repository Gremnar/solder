// @ts-check
"use strict";
/**
 * Pins every fixed text the model sees (src/prompt.js). If you changed one on purpose, live-test it
 * against real models, then put the new fingerprint printed by the failing test into PINNED.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { RULES, TOOLS, READ_ONLY, TEXTS, RESULTS, PLAN, STARTERS, SELECTION, CONTEXT, systemPrompt, toolDefinitions, timeNote, ASSIST, assistText } = require("../src/prompt.js");

const PINNED = "b8b85e4ec4394134";

/** Sample arguments for every text that's a function: name → a list of argument lists. */
const SAMPLES = {
  notRunBatch: [[8, 5]], planLeft: [[[{ number: 3, goal: "Update the README" }]], [[{ number: 2, goal: "A" }, { number: 3, goal: "B" }]]], planLeftShown: [[1], [3]], userNote: [["NOTE"]], unknownTool: [["nope", ["a", "b"]]],
  missing: [["edit_file", ["path"]], ["edit_file", ["old_text", "new_text"], ["old_string", "new_string"]]], ignored: [["read_file", ["offset"]], ["read_file", ["offset", "limit", "mode"]]],
  wrongType: [["read_file", "start_line", "integer"], ["search", "regex", "boolean"], ["search", "query", "string"]],
  wrapUp: [[0], [1], [3]], steer: [["STEER"]], titleRequest: [["EXCERPT"]], compactionFocus: [["FOCUS"]], stub: [["SUMMARY"]], resultCut: [[12345]], argumentLeftOut: [[412]],
};
const RESULT_SAMPLES = {
  signatureLeftOut: [[412, 520]], signatureInDiff: [[150]], error: [["E"]], noTool: [["nope"]], missing: [["a.js"]], isFolder: [["src"]], readFolder: [["src"]], tooLarge: [["a.bin", 21]],
  notText: [["a.bin"]], outlineHead: [["a.js", 412], ["b.js", 1]], outlineCapped: [[52]], noOutline: [["a.txt", 3]], notInFile: [["total", "a.js"]], definitions: [["total", 1], ["total", 3]],
  references: [["total", 1, 1], ["total", 1200, 9]], referencesCapped: [[1100]], noLanguageHits: [["total"]], noHitsAtAll: [["total"]],
  notGit: [["src"]], gitFailed: [["bad"]], noChanges: [[""], ["src"]], changedFiles: [[1, false], [7, true]], changedCapped: [[30]],
  newFiles: [[["a.js", "b.js"]]], unsaved: [[["a.js"]]], docsHits: [["pump", 1], ["pump", 10]], docsLoose: [[1, 6]],
  docsNoMatches: [["pump"]], docsBuilding: [[1234]], longLine: [[1, 250000, false], [14, 3400, true]], alsoDefined: [["parse", ["src/b.js 4", "lib/c.js 10"]]], readPart: [[1, 2000, 4100]], folderAgents: [["sub/AGENTS.md", "TEXT"]], noMatches: [["q", ""], ["q", "*.py"]],
  searchCapped: [[200]], noFiles: [["*.x"]], filesCapped: [[300]], manyMatches: [[3, "a.js", [4, 9, 12]]],
  notFound: [["a.js", 0, 0, 0, 0], ["a.js", 28, 34, 2, 3], ["a.js", 5, 9, 1, 1]], nearby: [[["src/a.js", "lib/a.js"], true], [["src/a.ts"], false]],
  folderHas: [[["lib/", "a.js"], 2], [["a.js"], 150]], searchTimedOut: [[30]], searchIncomplete: [[30]], reindented: [["4 spaces", true], ["1 tab", false]], notApplied: [["a.js"]], edited: [["a.js", 1, 1, 5], ["a.js", 3, 0, 9]],
  written: [[true, "a.js", 1], [false, "b.js", 40]], newProblems: [["a.js", ["- line 3: X"], 0], ["a.js", ["- line 3: X"], 2]],
  noProblems: [[""], ["a.js"]], alsoText: [["total"]], pastEnd: [["a.js", 18], ["b.js", 1]], changedOnDisk: [["a.js"]], notChecked: [["src/x.ts"]], notReported: [["src/x.ps1"]], notSaved: [["a.js"]], notWritable: [["a.js"]], sameContent: [["a.js"]], moveExists: [["b.js"]], moveUnsaved: [["a.js"]], moveMentions: [["old-helpers", ["src/app.js:1: require('./old-helpers')"]]], moved: [[false, "a.js", "lib/a.js", null], [true, "src", "backup/src", 12]], moreProblems: [[4]], removeNoTrash: [["big"]], removed: [["a.js", null], ["src", 1], ["src", 1200]],
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
    withDocs: systemPrompt({ workspace: "C:\\work", docs: [{ path: "D:\\Docs", about: "ABOUT" }, { path: "E:\\Specs" }] }),
    severalFolders: systemPrompt({ workspace: "S:\\repo", folders: ["S:\\repo", "C:\\local\\tools", "C:\\local\\site"] }),
    tools: toolDefinitions(),
    starters: STARTERS,
    plan: [PLAN.now([{ goal: "G1", work: "W1", state: "done", notes: "N1" }, { goal: "G2", work: "W2", state: "doing", notes: "" }, { goal: "G3", work: "W3", state: "todo", notes: "" }]),
      PLAN.now([{ goal: "G1", work: "", state: "done", notes: "" }]), PLAN.none, PLAN.badStep(3), PLAN.stub(2, "Read a.js")],
    context: [CONTEXT.workingIn("src"), CONTEXT.openFile("a.js"), CONTEXT.selected("a.js", 1, 2, "js", "X", "```"), CONTEXT.cutShort, CONTEXT.undid("a.js", "Edited a.js")],
    selection: { explain: SELECTION.explain, fix: SELECTION.fix, problems: SELECTION.problems(["- line 3: X"]) },
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
    ["read_file", "symbols", "search", "find_files", "changes", "edit_file", "write_file", "move_item", "remove_item", "problems", "plan"]);
  assert.deepEqual(toolDefinitions(), definitions, "the same every time");
  for (const { type, function: fn } of definitions) {
    assert.equal(type, "function");
    assert.ok(fn.description.length > 20 && fn.description.length < 400, `${fn.name}: a short description`);
    assert.equal(fn.parameters.type, "object");
    for (const [arg, schema] of Object.entries(fn.parameters.properties)) {
      assert.ok(["string", "integer", "boolean", "array"].includes(schema.type), `${fn.name}.${arg}: a type`);
      if (schema.type === "array") assert.ok(schema.items && schema.items.type, `${fn.name}.${arg}: its items' type`);
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
  // Every request resends these: keep the rules under ~700 tokens and the 11 tools under ~1,700.
  assert.ok(RULES.length / 4 < 700, `RULES is ${Math.ceil(RULES.length / 4)} tokens`);
  assert.ok(JSON.stringify(toolDefinitions()).length / 4 < 1700, `the tool definitions are ${Math.ceil(JSON.stringify(toolDefinitions()).length / 4)} tokens`);
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

// ================================================================ the Assist lane, pinned on its own

/** The Assist lane's fingerprint: a change to its texts moves this one, never the Tool lane's (and the reverse). */
const ASSIST_PINNED = "0afbc7dd27e95bda";

function assistEverything() {
  return {
    intro: ASSIST.introduce({ workspace: "C:\work", instructions: [{ path: "AGENTS.md", text: "AGENTS" }], rules: "RULE",
      docs: [{ path: "D:\Docs", about: "ABOUT" }] }, "MESSAGE"),
    bare: ASSIST.introduce({ workspace: "C:\work" }, "MESSAGE"),
    severalFolders: ASSIST.setup({ workspace: "S:\repo", folders: ["S:\repo", "C:\local\tools"] }),
    changed: ASSIST.setupChanged("SETUP"),
    results: [ASSIST.resultOk("read_file a.js"), ASSIST.resultFailed("read_file a.js"), ASSIST.resultClosing],
    carry: [ASSIST.carryOverLead, ASSIST.carryOverLeftOut(1), ASSIST.carryOverLeftOut(4), ASSIST.carryOverEnd],
    repairs: [ASSIST.repair("PROBLEM"), ASSIST.unknownTool("x", ["a", "b"]), ASSIST.cutOff, ASSIST.gaveUp],
    swaps: ASSIST.swaps,
  };
}

test("the Assist lane's texts match their own pinned fingerprint", () => {
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(assistEverything())).digest("hex").slice(0, 16);
  assert.equal(fingerprint, ASSIST_PINNED, `The Assist texts changed. If that was deliberate, live-test them, then set ASSIST_PINNED to "${fingerprint}".`);
});

test("every shared text, as the Assist lane says it, is in first person: none says \"the user\"", () => {
  const all = everything();
  const texts = [...Object.values(all.texts), ...Object.values(all.results), ...all.plan, ...all.context,
    ...Object.values(toolDefinitions()).map((/** @type {any} */ d) => d.function.description)];
  const left = texts.map((t) => assistText(String(t))).filter((t) => /the user/i.test(t));
  assert.deepEqual(left, []);
});
