// @ts-check
"use strict";
/** Editing and deleting your messages: what leaves the chat, what stays, and the Assist session after. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { removeTurn, laterMessages } = require("../src/engine.js");
const { sessionPlan, prefixHash } = require("../src/assist.js");

const call = (/** @type {string} */ id, /** @type {string} */ name, /** @type {any} */ args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

/** Three turns: a read, a planned one with a "carry on", and a question. */
function chat() {
  return /** @type {any} */ ({
    id: "c", title: "t", created: 0, updated: 0, compaction: null, usage: { tokens: 0 },
    messages: [
      { role: "user", content: "(time)\n\nfirst", meta: { typed: "first" } },
      { role: "assistant", content: "", tool_calls: [call("a", "read_file", { path: "a.js" })] },
      { role: "tool", tool_call_id: "a", content: "A", meta: {} },
      { role: "assistant", content: "Read it." },
      { role: "user", content: "(time)\n\nsecond, with the wrong paste", meta: { typed: "second, with the wrong paste" } },
      { role: "assistant", content: "", tool_calls: [call("p", "plan", { steps: ["x"] })] },
      { role: "tool", tool_call_id: "p", content: "plan", meta: {} },
      { role: "user", content: "Please carry on", meta: { typed: "Carry on", resume: true } },
      { role: "assistant", content: "Done." },
      { role: "user", content: "(time)\n\nthird", meta: { typed: "third" } },
      { role: "assistant", content: "Answer." },
    ],
    plan: { steps: [{ goal: "x", state: "todo" }] },
  });
}

test("Delete takes out one turn: your message, its steps, its carry-ons and its answer; the turns around it stay", () => {
  const c = chat();
  assert.equal(removeTurn(c, 4), "second, with the wrong paste");
  assert.deepEqual(c.messages.map((/** @type {any} */ m) => m.meta?.typed ?? m.content), ["first", "", "A", "Read it.", "third", "Answer."]);
  assert.equal(c.plan, undefined, "the plan its turn set went with it");
});

test("Edit takes your message and everything after it, and gives back what you typed", () => {
  const c = chat();
  assert.equal(laterMessages(c, 4), 1, "one message of yours comes after it (the carry-on isn't yours)");
  assert.equal(removeTurn(c, 4, true), "second, with the wrong paste");
  assert.equal(c.messages.length, 4);
  assert.equal(c.messages.at(-1).content, "Read it.");
});

test("Not a carry-on, not an answer, and not a message the summary already holds", () => {
  const c = chat();
  assert.equal(removeTurn(c, 7), null, "a carry-on belongs to the turn before");
  assert.equal(removeTurn(c, 3), null, "an answer isn't yours");
  c.compaction = { through: 4, summary: "S" };
  assert.equal(removeTurn(c, 0), null, "summarised");
  assert.equal(c.messages.length, 11, "nothing changed");
  assert.notEqual(removeTurn(c, 4), null, "from the summary point on, it can");
});

test("after a delete, an Assist session that held the removed messages isn't continued: the chat is carried over afresh", () => {
  const c = chat();
  const held = c.messages.length;
  c.assist = { fields: { id: "sess", token: "t" }, model: "model-a", held, heldHash: prefixHash(c.messages, held), told: "x", startedAt: 0 };
  const settings = { assistSessionBlock: "session", compactAt: 100_000 };
  const context = { workspace: "C:\\w" };
  const text = (/** @type {any} */ m) => String(m.content);
  c.messages.push({ role: "user", content: "(time)\n\nfourth", meta: { typed: "fourth" } });
  assert.equal(sessionPlan(c, "model-a", settings, context, text).kind, "stateful", "untouched: the session goes on");
  c.messages.pop();
  removeTurn(c, 4);
  c.messages.push({ role: "user", content: "(time)\n\nfourth", meta: { typed: "fourth" } });
  const plan = sessionPlan(c, "model-a", settings, context, text);
  assert.equal(plan.kind, "carry_over");
  assert.ok(!plan.messages[0].content.includes("wrong paste"), "the deleted message isn't sent");
});
