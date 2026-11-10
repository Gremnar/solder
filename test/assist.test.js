// @ts-check
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseReply, visibleText, resultMessage, assistOutbound, carryOver, stripSetup } = require("../src/assist.js");
const { ASSIST, RULES, TOOLS, TEXTS } = require("../src/prompt.js");

/** A reply ending with one tool block. @param {string} payload @param {string} [prose] */
const request = (payload, prose = "Let me check.") => `${prose}\n\n\`\`\`tool\n${payload}\n\`\`\``;
const one = (/** @type {string} */ reply) => parseReply(reply).calls[0];

test("parser: Windows paths with single backslashes, nested arguments, trailing commas", () => {
  assert.deepEqual(one(request(String.raw`{"tool": "read_file", "path": "C:\Work\a.txt"}`)), { name: "read_file", args: { path: "C:\\Work\\a.txt" } });
  assert.deepEqual(one(request(String.raw`{"tool": "read_file", "path": "C:\Users\Me\a.txt"}`)).args.path, "C:\\Users\\Me\\a.txt");
  assert.deepEqual(one(request('{"tool": "edit_file", "arguments": {"path": "a", "old_text": "x", "new_text": "y",}}')).args,
    { path: "a", old_text: "x", new_text: "y" });
});

test("parser: content holding code fences, real newlines, or an unescaped quote (salvaged) still comes through", () => {
  const fenced = one(request('{"tool": "write_file", "path": "n.md", "content": "# Notes\\n\\n```python\\nprint(1)\\n```\\n"}'));
  assert.equal(fenced.args.content, "# Notes\n\n```python\nprint(1)\n```\n");
  const raw = one(request('{"tool": "write_file", "path": "a.ps1", "content": "line one\n\tline two\n"}'));
  assert.equal(raw.args.content, "line one\n\tline two\n");
  const broken = parseReply(request(String.raw`{"tool": "write_file", "path": "C:\Scripts\new.ps1", "content": "Write-Host "hi"\n$x = 1"}`)).calls[0];
  assert.ok(broken.salvaged);
  assert.equal(broken.args.path, "C:\\Scripts\\new.ps1", "a path keeps its \\n");
  assert.equal(broken.args.content, "Write-Host \"hi\"\n$x = 1");
});

test("parser: curly quotes, aliases, camelCase names, the name/arguments and OpenAI shapes", () => {
  assert.deepEqual(one(request("{\u201ctool\u201d: \u201cfind_files\u201d, \u201cglob\u201d: \u201c*.ps1\u201d}")), { name: "find_files", args: { glob: "*.ps1" } });
  assert.deepEqual(one(request('{"tool": "read_file", "file_path": "a.js"}')).args, { path: "a.js" });
  assert.equal(one(request('{"tool": "readFile", "path": "a.js"}')).name, "read_file");
  assert.deepEqual(one(request('{"name": "read_file", "arguments": {"path": "a.js"}}')), { name: "read_file", args: { path: "a.js" } });
  assert.deepEqual(one(request('{"type": "function", "function": {"name": "read_file", "arguments": "{\\"path\\": \\"a.js\\"}"}}')),
    { name: "read_file", args: { path: "a.js" } });
});

test("parser: problems are reported; ordinary code and JSON in an answer are never requests", () => {
  assert.deepEqual(parseReply("Just an answer."), { calls: [], problem: "", unknown: "", found: false, visible: "Just an answer." });
  const oops = parseReply(request("{oops"));
  assert.ok(oops.found && !oops.calls.length && /JSON/.test(oops.problem));
  const unknown = parseReply(request('{"tool": "format_disk"}'));
  assert.equal(unknown.unknown, "format_disk");
  assert.match(parseReply(request('{"tool": "read_file"}')).problem, /read_file needs 'path'/);
  assert.equal(parseReply("```powershell\nGet-Date\n```").found, false);
  assert.equal(parseReply('Your package.json:\n\n```json\n{"name": "my-app", "version": "1.0.0"}\n```').found, false);
  // An unreadable example with prose after it is part of the explanation; one at the end is asked for again.
  assert.equal(parseReply('For example:\n\n```tool\n{oops\n```\n\nThat is how a request looks, roughly.').found, false);
});

test("parser: bare JSON at the end, a forgotten fence, several requests, a repeat, and a cut-off salvaged call", () => {
  assert.equal(one('Reading it.\n{"tool": "read_file", "path": "a.js"}').args.path, "a.js");
  assert.equal(one('Reading it.\n{"tool": "read_file", "path": "a.js"}\nThen I will fix it.').args.path, "a.js");
  const two = parseReply(request('{"tool": "read_file", "path": "a.js"}') + "\n\n" + "```tool\n{\"tool\": \"read_file\", \"path\": \"b.js\"}\n```");
  assert.deepEqual(two.calls.map((c) => c.args.path), ["a.js", "b.js"]);
  const twice = parseReply(request('{"tool": "read_file", "path": "a.js"}') + "\n\n" + "```tool\n{\"tool\": \"read_file\", \"path\": \"a.js\"}\n```");
  assert.equal(twice.calls.length, 1);
  const cut = request(String.raw`{"tool": "write_file", "path": "a.ps1", "content": "Write-Host "hi"`);
  assert.equal(parseReply(cut, { cutOff: true }).calls.length, 0, "a salvaged call cut off at the limit isn't run");
});

test("the visible text: what comes before a request; a half-typed fence held back while streaming", () => {
  assert.equal(visibleText(request('{"tool": "find_files", "glob": "*"}', "Looking.")), "Looking.");
  assert.equal(visibleText("Checking now ``", true), "Checking now ");
  assert.equal(visibleText("Checking now ``"), "Checking now ``");
  assert.equal(visibleText("Use `ls` here"), "Use `ls` here");
  assert.equal(visibleText('Writing it now.\n\n```tool\n{"tool": "write_file", "path": "a.ps1", "content": "xx', true), "Writing it now.");
});

test("a result is fenced with more backticks than its output holds, and the closing line comes once", () => {
  const text = resultMessage("read_file x", "a\n````\nb", false, true);
  assert.ok(text.includes("`````\na\n````\nb\n`````"));
  assert.ok(text.endsWith(ASSIST.resultClosing));
  assert.ok(resultMessage("read_file y", "nope", true, false).startsWith(ASSIST.resultFailed("read_file y")));
});

test("the introduction: plain first person, every tool, the user's message last; not the Tool lane's rules", () => {
  const intro = ASSIST.introduce({ workspace: "C:\\work", instructions: [{ path: "AGENTS.md", text: "Use tabs." }], rules: "Be brief.",
    docs: [{ path: "D:\\Docs", about: "the API" }] }, "What's in src?");
  assert.ok(intro.startsWith(ASSIST.lead));
  assert.ok(intro.endsWith(ASSIST.messageLead + "\n\nWhat's in src?"));
  for (const name of Object.keys(TOOLS)) assert.ok(intro.includes(`- ${name}: `), name);
  for (const word of ["SYSTEM", "You are", "[INST"]) assert.ok(!intro.includes(word), word);
  assert.ok(!/the user/i.test(intro), "first person throughout: the user is the one speaking");
  assert.ok(!intro.includes(RULES.slice(0, 80)), "the Tool lane's rules aren't in it");
  assert.ok(intro.includes("Use tabs.") && intro.includes("Be brief.") && intro.includes("D:\\Docs: the API"));
});

/** A stored chat on the native shape, as Solder keeps every chat. */
function storedChat() {
  return { compaction: null, messages: [
    { role: "user", content: "(time)\n\nFix a.js", meta: { sent: ASSIST.introduce({ workspace: "C:\\w" }, "(time)\n\nFix a.js") } },
    { role: "assistant", content: "Reading.", meta: { lane: "assist", raw: request('{"tool": "read_file", "path": "a.js"}', "Reading.") },
      tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.js\"}" } }] },
    { role: "tool", tool_call_id: "c1", content: "1\tconst x = 1;", meta: { name: "read_file", label: "read_file a.js" } },
    { role: "assistant", content: "Fixing both.", tool_calls: [
      { id: "c2", type: "function", function: { name: "edit_file", arguments: "{\"path\":\"a.js\",\"old_text\":\"1\",\"new_text\":\"2\"}" } },
      { id: "c3", type: "function", function: { name: "remove_item", arguments: "{\"path\":\"b.js\"}" } }] },
    { role: "tool", tool_call_id: "c2", content: "Edited a.js", meta: { name: "edit_file", label: "edit_file a.js" } },
    { role: "tool", tool_call_id: "c3", content: TEXTS.declined, meta: { name: "remove_item", label: "remove_item b.js", failed: true } },
    { role: "user", content: "(time)\n\nAnd c.js too" },
  ] };
}

test("rendering: native messages as Assist turns; a batch is one message; first person; never two user messages in a row", () => {
  const turns = assistOutbound(storedChat(), (m) => m.content);
  assert.deepEqual(turns.map((t) => t.role), ["user", "assistant", "user", "assistant", "user"]);
  assert.ok(turns[0].content.startsWith(ASSIST.lead), "the introduction, as it was sent");
  assert.ok(turns[1].content.includes("```tool"), "the model's own words, as it wrote them");
  assert.ok(turns[3].content.includes('"tool":"edit_file"'), "a Tool-lane reply's calls, as tool blocks");
  const results = turns[4].content;
  assert.equal(results.split(ASSIST.resultClosing).length, 2, "the closing line once, on the last result");
  assert.ok(results.includes(ASSIST.resultFailed("remove_item b.js")) && results.includes("I declined this."));
  assert.ok(!/the user/i.test(results));
  assert.ok(results.endsWith("And c.js too"), "the typed message joined after the results");
  // A compacted chat starts with its recap.
  const compacted = { ...storedChat(), compaction: { through: 3, summary: "SUMMARY" } };
  const recap = assistOutbound(compacted, (m) => m.content);
  assert.equal(recap[0].content, TEXTS.compaction);
  assert.equal(recap[1].content, "SUMMARY");
});

test("carrying over: the setup once, the conversation as Me and You, then the new message; the oldest go first when long", () => {
  const setup = ASSIST.setup({ workspace: "C:\\w" });
  const rendered = assistOutbound(storedChat(), (m) => m.content);
  const text = carryOver(setup, rendered, 1_000_000);
  assert.ok(text.startsWith(setup));
  assert.equal(text.split(ASSIST.lead).length, 2, "the introduction isn't repeated from the first message");
  assert.ok(text.includes(ASSIST.carryOverLead) && text.includes("Me:\n(time)\n\nFix a.js") && text.includes("You:\nReading."));
  assert.ok(text.includes(ASSIST.carryOverEnd));
  assert.ok(text.endsWith("And c.js too"));
  const tight = carryOver(setup, rendered, setup.length + 700);
  assert.match(tight, /\(\d earlier messages? (is|are) left out here\.\)/);
  assert.equal(stripSetup(rendered[0].content), "(time)\n\nFix a.js");
});
