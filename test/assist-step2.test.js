// @ts-check
"use strict";
/**
 * The Assist lane, step 2: a carry-over that's too long shortens earlier turns first, keeps the request being worked on
 * and what must be kept, then leaves out the oldest; tool output reaches the model as it is, Solder's own words in
 * first person.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { assistOutbound, sessionPlan, holdSession, wouldLeaveOut, resultMessage } = require("../src/assist.js");
const { ASSIST, TEXTS, RESULTS, assistText } = require("../src/prompt.js");

const resultText = (/** @type {any} */ m, earlier = false) => m.meta?.stub ? (earlier ? TEXTS.stub(m.meta.summary) : TEXTS.stub(m.meta.summary)) + (m.meta.keep ? "\n\n" + m.meta.keep : "") : m.content;
const context = { workspace: "C:\\w" };
const setupChars = ASSIST.setup(context).length;
/** Settings whose carry-over holds about `chars` characters beyond the setup. @param {number} chars */
const budget = (chars) => ({ assistCarryTokens: Math.ceil((setupChars + chars) / 4) });
const rawCall = (/** @type {string} */ prose, /** @type {any} */ args) => `${prose}\n\n\`\`\`tool\n${JSON.stringify(args)}\n\`\`\``;
const assistant = (/** @type {string} */ id, /** @type {string} */ prose, /** @type {any} */ args) => ({ role: "assistant", content: prose,
  meta: { lane: "assist", raw: rawCall(prose, args) }, tool_calls: [{ id, type: "function", function: { name: args.tool, arguments: JSON.stringify({ ...args, tool: undefined }) } }] });
const tool = (/** @type {string} */ id, /** @type {string} */ name, /** @type {string} */ content, /** @type {any} */ meta = {}) =>
  ({ role: "tool", tool_call_id: id, content, meta: { name, label: `${name} x`, summary: `${name} done`, ...meta } });

const SKILL = "Skill: tidy\n\nKEEP-THE-SKILL: always tidy imports.";
const STEER = TEXTS.steer("STEER-TEXT: and the tests too");

/** A chat: a first task with a big write and a big read, a skill read, older chatter, then the task in progress. */
function chat({ chatter = 0, currentRead = 0, endWithAnswer = false } = {}) {
  /** @type {any[]} */
  const messages = [
    { role: "user", content: "(time)\n\nFIRST-REQUEST: write big.js", meta: { sent: ASSIST.introduce(context, "(time)\n\nFIRST-REQUEST: write big.js") } },
    assistant("w1", "Writing.", { tool: "write_file", path: "big.js", content: "W".repeat(20_000) }),
    tool("w1", "write_file", "Created big.js (400 lines)."),
    assistant("k1", "Reading the skill.", { tool: "read_file", path: "C:\\Skills\\tidy.md" }),
    tool("k1", "read_file", RESULTS.skillRead("tidy", 0) + "\n\n" + SKILL, { keep: SKILL }),
    assistant("r0", "Reading.", { tool: "read_file", path: "old.js" }),
    tool("r0", "read_file", "O".repeat(10_000), { summary: "Read old.js · 300 lines" }),
    { role: "assistant", content: "Done with the first task." },
  ];
  for (let n = 0; n < chatter; n++) messages.push({ role: "user", content: `(time)\n\nchat ${n} ` + "c".repeat(1500) }, { role: "assistant", content: `reply ${n} ` + "a".repeat(1500) });
  messages.push({ role: "user", content: "(time)\n\nCURRENT-REQUEST: fix c.js" });
  if (currentRead) {
    messages.push(assistant("r1", "Reading c.", { tool: "read_file", path: "c.js" }), tool("r1", "read_file", "R".repeat(currentRead)));
    messages.push(assistant("r2", "Reading d.", { tool: "read_file", path: "d.js" }), tool("r2", "read_file", "1\tconst d = 1;\n\n" + STEER, { keep: STEER, steer: "STEER-TEXT" }));
  }
  if (endWithAnswer) messages.push({ role: "assistant", content: "Fixed c.js." });
  return { messages, compaction: null, assist: /** @type {any} */ (null) };
}

const carried = (/** @type {any} */ c, /** @type {any} */ settings) => {
  const plan = sessionPlan(c, "model-b", settings, context, resultText);
  assert.equal(plan.kind, "carry_over");
  return { plan, text: plan.messages[0].content };
};

test("carry-over: too long, earlier turns are shortened first (their long write texts and results), and nothing else is left out", () => {
  const c = chat();
  const { text } = carried(c, budget(9_000));
  assert.ok(!/earlier messages? (is|are) left out here/.test(text), "no message left out");
  assert.ok(!text.includes("W".repeat(100)), "the earlier write's text isn't sent again");
  assert.ok(text.includes('"tool":"write_file"') && text.includes('"path":"big.js"'), "the request itself is still there");
  assert.ok(text.includes(assistText(TEXTS.argumentsLeftOut)), "its result says its text was left out");
  assert.ok(!text.includes("O".repeat(100)) && text.includes(TEXTS.stub("Read old.js · 300 lines")), "the earlier long result is a stand-in");
  assert.ok(text.includes("KEEP-THE-SKILL") && text.includes("FIRST-REQUEST") && text.endsWith("CURRENT-REQUEST: fix c.js"));
  // Room for all of it: sent whole, as ever.
  const whole = carried(chat(), budget(100_000)).text;
  assert.ok(whole.includes("W".repeat(20_000)) && whole.includes("O".repeat(10_000)));
  // wouldLeaveOut agrees: shortened, nothing is left out.
  assert.equal(wouldLeaveOut(chat({ endWithAnswer: true }), "model-b", budget(9_000), context, resultText), null);
});

test("carry-over: the task's own request, its steers and kept skills stay, while the oldest and the task's big reads go", () => {
  const c = chat({ chatter: 10, currentRead: 30_000 });
  const { plan, text } = carried(c, budget(12_000));
  assert.ok(text.includes("CURRENT-REQUEST: fix c.js"), "the request being worked on");
  assert.ok(text.includes("KEEP-THE-SKILL"), "the skill read in an earlier turn");
  assert.ok(text.includes("STEER-TEXT"), "the steer");
  assert.ok(!text.includes("R".repeat(100)), "the task's big read went");
  assert.ok(text.includes(TEXTS.stub("read_file done")) || !text.includes("Reading c."), "or what's left of it is a stand-in");
  assert.ok(!text.includes("FIRST-REQUEST"), "the oldest went");
  assert.match(text, /\(\d+ earlier messages? (is|are) left out here\.\)/);
  assert.ok(text.length < (setupChars + 12_000) * 1.05, `within the budget: ${text.length - setupChars}`);
  assert.deepEqual(plan.leftOut, [], "every kept text went");
  // The request comes before what followed it.
  assert.ok(text.indexOf("CURRENT-REQUEST") < text.indexOf("STEER-TEXT"));
});

test("wouldLeaveOut agrees with what a carry-over would leave out", () => {
  const c = chat({ chatter: 10, endWithAnswer: true });
  const settings = budget(12_000);
  const told = wouldLeaveOut(c, "model-b", settings, context, resultText);
  assert.ok(told && told.left > 0 && told.first, JSON.stringify(told));
  c.messages.push({ role: "user", content: "(time)\n\nnext" });
  const { plan } = carried(c, settings);
  assert.equal(plan.left, told.left);
});

test("carry-over: a kept skill that can't fit is left out, said, and recorded so it can be read again", () => {
  const big = "Skill: huge\n\n" + "s".repeat(20_000);
  const c = chat({ chatter: 2 });
  c.messages.splice(4, 1, tool("k1", "read_file", RESULTS.skillRead("huge", 0) + "\n\n" + big, { keep: big }));
  const { plan, text } = carried(c, budget(4_000));
  assert.ok(!text.includes("s".repeat(1000)));
  assert.ok(text.includes("CURRENT-REQUEST"));
  assert.deepEqual(plan.leftOut, ["k1"]);
  holdSession(c, "model-b", plan, { session: { fields: { session: "s1" } } }, () => "s1");
  assert.deepEqual(c.assist.leftOut, ["k1"], "kept with the session that holds the carried conversation");
  const lost = chat({ chatter: 2 });
  lost.messages.splice(4, 1, tool("k1", "read_file", "x", { keep: big }));
  const again = carried(lost, budget(4_000)).plan;
  holdSession(lost, "model-b", again, {}, () => "");
  assert.deepEqual(lost.assist.leftOut, ["k1"], "and with no session at all");
  // Room for it: nothing is recorded.
  const fits = carried(chat(), budget(100_000)).plan;
  assert.deepEqual(fits.leftOut, []);
});

// ---------------------------------------------------------------- 5. tool output as it is

test("assist rendering: file text, search hits and a line's trailing tab reach the model unchanged; Solder's own words are in first person", () => {
  const fileText = "11\t// Solder says: The user declined this.\n12\tThe user declined this.\n13\tAsk the user to save it first.\n14\tconst end = 1;\t";
  const hits = "src/prompt.js:212:  declined: \"The user declined this.\",\nsrc/prompt.js:213:The user's note: keep";
  const c = { compaction: null, messages: [
    { role: "user", content: "go" },
    { role: "assistant", content: "", tool_calls: ["1", "2", "3", "4", "5", "6"].map((id) => ({ id, type: "function", function: { name: "read_file", arguments: "{}" } })) },
    tool("1", "read_file", fileText),
    tool("2", "search", hits),
    tool("3", "remove_item", TEXTS.declined + "\n\n" + TEXTS.userNote("tell the user to sign it again"), { failed: true }),
    tool("4", "move_item", RESULTS.error(RESULTS.moveUnsaved("a.js")), { failed: true }),
    tool("5", "edit_file", RESULTS.edited("a.ps1", 1, 1, 3) + "\n" + RESULTS.signatureBroken + "\n\n" + STEER),
    tool("6", "symbols", `src/far.js 12 ${RESULTS.outsideNotShown}`),
  ] };
  const text = assistOutbound(c, resultText)[2].content;
  assert.ok(text.includes(fileText + "\n```"), "the file's lines as they are, its last line's tab too");
  assert.ok(text.includes(hits), "search hits as they are");
  assert.ok(text.includes("I declined this.\n\nMy note: tell the user to sign it again"), "your note is your own words, as you wrote them");
  assert.ok(text.includes("Error: a.js has unsaved changes in the editor. Ask me to save it first."));
  assert.ok(text.includes("remind me to sign it again") && text.includes("Also, a message from me while you were working:\n\nSTEER-TEXT"));
  assert.ok(text.includes("src/far.js 12 (outside the workspace and your docs folders, so not shown: read_file it to see it, which asks me first)"));
  // Trailing line breaks are still trimmed before the closing fence.
  assert.equal(resultMessage("read_file a.js", "1\tx\t\n\n", false, false), `${ASSIST.resultOk("read_file a.js")}\n\n\`\`\`\n1\tx\t\n\`\`\``);
});
