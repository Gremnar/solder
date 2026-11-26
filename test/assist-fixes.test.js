// @ts-check
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseReply, decode, wouldLeaveOut, prefixHash } = require("../src/assist.js");

/** A reply ending with one tool block. @param {string} payload @param {string} [prose] */
const request = (payload, prose = "Let me write it.") => `${prose}\n\n\`\`\`tool\n${payload}\n\`\`\``;

test("valid JSON is read as it is: a comma before ] or } inside a string, and an escaped backslash, are kept", () => {
  const content = "const re = /\\d{1,}/;\nconst s = \",]\";\nint[,] grid; // {1,}\nC:\\\\share\\\\Users";
  const parsed = parseReply(request(JSON.stringify({ tool: "write_file", path: "a.js", content })));
  assert.equal(parsed.calls[0].args.content, content);
  // Still forgiven when the JSON really is broken: a trailing comma outside strings goes, the ones inside stay.
  assert.deepEqual(decode('{"a": "x {1,} [2,]", "b": [1, 2, ], }'), { a: "x {1,} [2,]", b: [1, 2] });
  // A broken one (a Windows path) beside an escaped backslash: the escaped pair isn't doubled again.
  assert.deepEqual(decode(String.raw`{"path": "C:\Work\a.txt", "content": "a\\Users"}`), { path: "C:\\Work\\a.txt", content: "a\\Users" });
  assert.equal(decode(String.raw`{"path": "c:\users\me"}`).path, "c:\\users\\me", "a \\u that isn't four hex digits is a path's backslash");
});

test("a Windows path with single backslashes keeps its \\t and \\n; text arguments keep their tabs and line breaks", () => {
  const path = (/** @type {string} */ written) => parseReply(request(`{"tool": "read_file", "path": "${written}"}`)).calls[0].args.path;
  assert.equal(path(String.raw`C:\Users\me\tools\new\build.ps1`), "C:\\Users\\me\\tools\\new\\build.ps1");
  assert.equal(path(String.raw`src\tools\run.ps1`), "src\\tools\\run.ps1", "valid JSON escapes, but no path holds a tab or a CR");
  const move = parseReply(request(String.raw`{"tool": "move_item", "from": "a\new.txt", "to": "b\to\new.txt"}`)).calls[0].args;
  assert.deepEqual(move, { from: "a\\new.txt", to: "b\\to\\new.txt" });
  assert.equal(parseReply(request(String.raw`{"tool": "find_files", "pattern": "src\tests\*.js"}`)).calls[0].args.glob, "src\\tests\\*.js", "an alias of glob too");
  const write = parseReply(request(String.raw`{"tool": "write_file", "file_path": "C:\temp\new.txt", "content": "a\tb\nc"}`)).calls[0].args;
  assert.deepEqual(write, { path: "C:\\temp\\new.txt", content: "a\tb\nc" });
});

test("a broken request is read up to its own closing fence: the next request isn't swallowed into its content", () => {
  const second = "```tool\n" + JSON.stringify({ tool: "write_file", path: "b.txt", content: "bee" }) + "\n```";
  const reply = request(String.raw`{"tool": "write_file", "path": "a.txt", "content": "say "hi" now"}`) + "\n\nAnd the second:\n\n" + second;
  const parsed = parseReply(reply);
  assert.deepEqual(parsed.calls.map((c) => [c.args.path, c.args.content]), [["a.txt", 'say "hi" now'], ["b.txt", "bee"]]);
  assert.ok(parsed.calls[0].salvaged);
  // Right after it, with no words between.
  assert.deepEqual(parseReply(request(String.raw`{"tool": "write_file", "path": "a.txt", "content": "x "y" z"}`) + "\n" + second).calls.map((c) => c.args.content), ['x "y" z', "bee"]);
  // Content holding code fences of its own (real line breaks) is still read whole.
  const fenced = parseReply(request('{"tool": "write_file", "path": "n.md", "content": "Run "this":\n```powershell\nGet-Date\n```\nDone."}')).calls[0];
  assert.equal(fenced.args.content, 'Run "this":\n```powershell\nGet-Date\n```\nDone.');
  // Where it can't be told where the broken one ends (no } before the next request): it's said, not guessed.
  const unclear = parseReply(request(String.raw`{"tool": "write_file", "path": "a.txt", "content": "say "hi" now`) + "\n\n" + second);
  assert.deepEqual([unclear.calls.length, unclear.after], [0, 1]);
  assert.match(unclear.problem, /JSON/);
});

test("a block holding a list of requests runs each, in order; one that can't be used stops there and is said", () => {
  const list = (/** @type {any[]} */ items) => parseReply(request(JSON.stringify(items)));
  let parsed = list([{ tool: "read_file", path: "a.js" }, { tool: "read_file", path: "b.js" }, { tool: "find_files", glob: "*.md" }]);
  assert.deepEqual(parsed.calls.map((c) => c.args.path || c.args.glob), ["a.js", "b.js", "*.md"]);
  assert.deepEqual([parsed.problem, parsed.after], ["", 0]);
  parsed = list([{ tool: "read_file", path: "a.js" }, { tool: "read_file" }, { tool: "read_file", path: "c.js" }]);
  assert.deepEqual([parsed.calls.map((c) => c.args.path), parsed.problem, parsed.after], [["a.js"], "read_file needs 'path'", 1]);
  parsed = list([{ tool: "read_file", path: "a.js" }, { tool: "read_file", path: "a.js" }]);
  assert.equal(parsed.calls.length, 1, "a repeat still runs once");
  // A list after another block: in order, after it.
  const two = parseReply(request('{"tool": "read_file", "path": "x.js"}') + "\n\n```tool\n" + JSON.stringify([{ tool: "read_file", path: "y.js" }, { tool: "read_file", path: "z.js" }]) + "\n```");
  assert.deepEqual(two.calls.map((c) => c.args.path), ["x.js", "y.js", "z.js"]);
});

test("a switch back to the same Assist model: its session counts only while it still holds the chat as stored", () => {
  const resultText = (/** @type {any} */ m) => m.content;
  const settings = { assistSessionBlock: "test_session", assistCarryTokens: 10_000 };
  const context = { workspace: "C:\\work" };
  const make = () => {
    const chat = { messages: /** @type {any[]} */ ([]), compaction: null, assist: /** @type {any} */ (null) };
    for (let turn = 0; turn < 30; turn++) {
      chat.messages.push({ role: "user", content: `request ${turn} ` + "x".repeat(200) }, { role: "assistant", content: `answer ${turn} ` + "y".repeat(3800) });
    }
    chat.assist = { fields: { session: "s1" }, model: "model-b", held: chat.messages.length, heldHash: prefixHash(chat.messages, chat.messages.length) };
    return chat;
  };
  assert.equal(wouldLeaveOut(make(), "model-b", settings, context, resultText), null, "it holds the chat: nothing carried over");
  // The Tool lane answered in between: the session never saw it.
  const tooled = make();
  tooled.messages.push({ role: "user", content: "more" }, { role: "assistant", content: "a Tool-lane answer" });
  assert.ok(wouldLeaveOut(tooled, "model-b", settings, context, resultText));
  // A message it saw was edited, or one was removed.
  const edited = make();
  edited.messages[4].content = "changed";
  assert.ok(wouldLeaveOut(edited, "model-b", settings, context, resultText));
  const removed = make();
  removed.messages.splice(58, 2);
  assert.ok(wouldLeaveOut(removed, "model-b", settings, context, resultText));
  // A reply that failed partway doesn't count as one it never saw.
  const partial = make();
  partial.messages.push({ role: "user", content: "more" }, { role: "assistant", content: "half", meta: { incomplete: true } });
  assert.equal(wouldLeaveOut(partial, "model-b", settings, context, resultText), null);
});
