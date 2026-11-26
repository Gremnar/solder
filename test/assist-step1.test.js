// @ts-check
"use strict";
/** promisesAction: an Assist reply with no request that only says what it will do next. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { promisesAction } = require("../src/assist.js");

test("promisesAction: replies that said what they'd do and sent nothing (as saved live runs ended)", () => {
  for (const reply of [
    "I’ll inspect `processOrders` and the surrounding logging style before making the change.",
    "I’ll inspect the two files’ outlines and locate the functions and their callers.",
    "I’ll check the five files first, then make the requested changes.",
    "I’ll locate `totalPrice` and its usages first, then rename it and add a comment at its definition.",
    "I'll find the occurrences under `src`, then rename the setting while preserving the `--max-retries` flag.",
    "Let me first read the config.",
    "I'm going to update the README now.",
    "The definition is in a.js.\n\nNext I'll edit the callers.",
    "I’ll search the pasted log for indications of what stopped.I’ll check for stop-related messages first.",
  ]) assert.ok(promisesAction(reply), reply);
});

test("promisesAction: answers, questions, reports, offers and code are not promises", () => {
  for (const reply of [
    "",
    "Fixed the typo in `src/greet.js`: the greeting now says “Hello”.",
    "Done. I'll leave the rest as it is.",
    "Updated `src/orders.js`. I'll check nothing else.",
    "Renamed it everywhere.",
    "Should I update the tests? I'll wait.",
    "If you want, I'll add a test for it.",
    "Let me know if I should rename the callers too.",
    "Please save `src/limits.js` if it has unsaved changes, then let me know. I’ll retry the edit afterward.",
    "Would you like me to change it? I can.",
    "I'll show you:\n\n```js\nconst a = 1;\n```",
    "The function returns the total. It's used in three places.",
    "I'll explain how it works: it reads the file once.", // not a step in the workspace
    "I'll inspect it. " + "x".repeat(450), // too long to be only a promise
    "I'll check the logs, then I'll tell you what I found. It reads the file. It caches it. Then it returns.", // the last sentence isn't one
  ]) assert.ok(!promisesAction(reply), reply);
});
