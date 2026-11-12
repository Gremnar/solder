// @ts-check
"use strict";
// The fixes from the 2026-11-11 review: each one, as a regression test.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const load = /** @type {any} */ (Module)._load;
/** @type {any} */ (Module)._load = function (/** @type {string} */ request, /** @type {any[]} */ ...rest) {
  return request === "vscode" ? { Uri: { file: (/** @type {string} */ fsPath) => ({ fsPath, scheme: "file" }) }, languages: { onDidChangeDiagnostics: () => ({ dispose() {} }) },
    FileType: { File: 1, Directory: 2 }, workspace: { textDocuments: [], getConfiguration: () => ({ get: (/** @type {string} */ _k, /** @type {any} */ fallback) => fallback }) } }
    : load.call(this, request, ...rest);
};

test("approval: a link into .git (and so an 8.3 short name, which resolves the same way) needs approval; so does problems outside", () => {
  const { WorkspaceTools } = require("../src/tools.js");
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "solder-fix-"));
  try {
    const ws = path.join(top, "ws");
    fs.mkdirSync(path.join(ws, ".git", "hooks"), { recursive: true });
    fs.symlinkSync(path.join(ws, ".git"), path.join(ws, "innocent"), "junction");
    fs.writeFileSync(path.join(top, "outside.txt"), "x");
    const tools = new WorkspaceTools(/** @type {any} */ ({ globalStorageUri: { fsPath: path.join(top, "store") }, subscriptions: [] }));
    tools.roots = () => [ws];
    tools.docsFolders = () => [];
    tools.skillsFolders = () => [];
    assert.match(String(tools.needsApproval("write_file", { path: "innocent/hooks/pre-commit" })), /programs run/);
    assert.match(String(tools.needsApproval("move_item", { from: "a.txt", to: "innocent/config" })), /programs run/);
    assert.match(String(tools.needsApproval("problems", { path: path.join(top, "outside.txt") })), /reads a file outside/);
    assert.equal(tools.needsApproval("problems", {}), null, "problems for the whole workspace needs nothing");
  } finally {
    fs.rmSync(top, { recursive: true, force: true });
  }
});

test("Assist: a fenced example inside a file being written isn't a request of its own; two plans stay two", () => {
  const { parseReply } = require("../src/assist.js");
  const T = "```";
  const reply = "Saving it.\n\n" + T + "tool\n{\"tool\":\"write_file\",\"path\":\"notes.md\",\"content\":\"Ask like this:\n\n" + T + "json\n" +
    "{\"tool\":\"remove_item\",\"path\":\"src/app.js\"}\n" + T + "\n\"}\n" + T;
  assert.deepEqual(parseReply(reply).calls.map((c) => c.name), ["write_file"]);
  const plans = parseReply(T + "tool\n{\"tool\":\"plan\",\"steps\":[{\"goal\":\"A\"}]}\n" + T + "\n" + T + "tool\n{\"tool\":\"plan\",\"steps\":[{\"goal\":\"B\"}]}\n" + T);
  assert.equal(plans.calls.length, 2);
});

test("diagnostics: paths with spaces are taken out whole", () => {
  const { pathless } = require("../src/log.js");
  assert.equal(pathless("open 'C:\\Users\\John Smith\\My Docs\\plan.docx'"), "open '<path>'");
  assert.equal(pathless("rename \"D:\\Work Area\\a b.json\" -> \"D:\\x.json\""), "rename \"<path>\" -> \"<path>\"");
  assert.equal(pathless("The gateway answered HTTP 429."), "The gateway answered HTTP 429.");
  assert.doesNotMatch(pathless("failed at \\\\server\\share name\\docs"), /server|share|docs/);
});

test("write_file keeps an existing file's encoding and line endings", () => {
  const { encodedLike } = require("../src/tools.js");
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const crlfBom = Buffer.concat([bom, Buffer.from("a\r\nb\r\n")]);
  assert.deepEqual(encodedLike(crlfBom, "a\r\nb\r\n", "x\ny\n"), Buffer.concat([bom, Buffer.from("x\r\ny\r\n")]), "BOM and CRLF kept");
  assert.deepEqual(encodedLike(Buffer.from("a\nb\n"), "a\nb\n", "x\ny\n"), Buffer.from("x\ny\n"), "plain UTF-8 and LF stay so");
  const le = encodedLike(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a\r\n", "utf16le")]), "a\r\n", "é\n");
  assert.deepEqual(le, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("é\r\n", "utf16le")]), "UTF-16 LE kept");
  const be = encodedLike(Buffer.from([0xfe, 0xff, 0x00, 0x61]), "a", "b");
  assert.deepEqual(be, Buffer.from([0xfe, 0xff, 0x00, 0x62]), "UTF-16 BE kept");
});

test("lanes: an Assist models list decides when there is one; the twin is the longest Assist id the Tool id starts with", () => {
  const { laneOf, assistTwin } = require("../src/lanes.js");
  const settings = { assistModels: ["model-a", "Model-B"], toolModels: "-tools$" };
  assert.equal(laneOf("model-a", settings), "assist");
  assert.equal(laneOf("model-b", settings), "assist", "any case");
  assert.equal(laneOf("model-a-tools", settings), "tool");
  assert.equal(laneOf("other", settings), "tool", "the list wins over the pattern");
  assert.equal(assistTwin("model-a-tools", settings, ["model-a", "model-a-tools", "model-b"]), "model-a");
  assert.equal(assistTwin("model-c-tools", settings, ["model-a", "model-c-tools"]), "");
  assert.equal(laneOf("other", { toolModels: "-tools$" }), "assist", "no list: the pattern, as before");
});

test("docs search keeps words in every language", () => {
  const { queryTerms } = require("../src/docs.js");
  assert.deepEqual(queryTerms("Übersicht Straße 東京 café"), ["\"Übersicht\"", "\"Straße\"", "\"東京\"", "\"café\""]);
});

test("skills: a file that opens with a --- rule isn't front matter", () => {
  const { parse } = require("../src/skills.js");
  assert.equal(parse("---\nWhen to use: X.\n---\nSteps").text, "---\nWhen to use: X.\n---\nSteps");
  assert.equal(parse("---\ndescription: Y.\n---\nBody").when, "Y.");
});

test("a deleted chat isn't brought back by a save that was waiting", async () => {
  const { ChatStore } = require("../src/store.js");
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "solder-store-"));
  try {
    const store = new ChatStore(top);
    const chat = { id: "abc123", title: "t", created: 1, updated: 1, messages: [{ role: "user", content: "hi" }], usage: { tokens: 0 }, compaction: null };
    const first = store.save(chat);
    const second = store.save(chat); // queued behind the first
    store.remove(chat.id);
    await Promise.allSettled([first, second]);
    assert.ok(!fs.existsSync(path.join(top, "abc123.json")), "the chat stays deleted");
  } finally {
    fs.rmSync(top, { recursive: true, force: true });
  }
});

test("policy: a model filter or Tool models pattern that won't read is reported", async () => {
  const { Policy } = require("../src/policy.js");
  const policy = new Policy({ platform: "win32", read: async (key) => /^HKLM/.test(key) ? new Map(Object.entries({ ModelFilter: "model-(a|b", ToolModels: "(" })) : null });
  await policy.refresh();
  assert.deepEqual(policy.problems, ["ModelFilter: not a valid regular expression", "ToolModels: not a valid regular expression"]);
  assert.ok(policy.locked("modelFilter"), "still enforced: it matches nothing, so no model is offered");
});

test("an enforced model filter stops a request to a model it doesn't allow, before anything is sent", async () => {
  const { Engine } = require("../src/engine.js");
  const sent = [];
  const client = { reply: async (/** @type {any} */ request) => { sent.push(request); return { content: "hi", calls: [], finishReason: "stop", usage: {} }; } };
  const host = { systemPrompt: async () => "S", needsApproval: () => null, runTool: async () => ({ output: "", summary: "" }), save: async () => {} };
  const events = [];
  const engine = new Engine({ client, host, settings: () => ({ model: "model-b", compactAt: 100_000, maxRounds: 30, modelAllowed: (/** @type {string} */ id) => id === "model-a" }),
    onEvent: (/** @type {any} */ event) => events.push(event) });
  await engine.ask(Engine.newChat(), "hello");
  assert.equal(sent.length, 0, "nothing sent");
  assert.match(String(events.find((e) => e.type === "error")?.message), /doesn't allow the model model-b/);
});
