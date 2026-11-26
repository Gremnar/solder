// @ts-check
"use strict";
// Edits written with spaces against a file indented with tabs, and the other way round: matched when one tab stands
// for the same number of spaces on every line and that gives one place and one reading; refused as before otherwise.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const load = /** @type {any} */ (Module)._load;
/** @type {any} */ (Module)._load = function (/** @type {string} */ request, /** @type {any[]} */ ...rest) {
  if (request === "vscode") return { languages: { onDidChangeDiagnostics: () => ({ dispose() {} }) }, Uri: {}, workspace: {}, window: {}, commands: {}, SymbolKind: {} };
  return load.call(this, request, ...rest);
};
const { planEdit, ToolError } = require("../src/tools.js");
const { RESULTS } = require("../src/prompt.js");

/** The file's text after the planned edit. @param {string} text @param {any} plan */
const apply = (text, plan) => text.slice(0, plan.found.start) + plan.found.replaced + text.slice(plan.found.start + plan.found.length);

const TABS = "function Get-Thing {\n\tparam([string]$Name)\n\tif ($Name) {\n\t\tWrite-Output $Name\n\t}\n}\n";
const SPACES = "function Get-Thing {\n    param([string]$Name)\n    if ($Name) {\n        Write-Output $Name\n    }\n}\n";

test("old_text with 4 spaces a level, on a file indented with tabs: matched, and new_text written with tabs", () => {
  const plan = planEdit("a.ps1", TABS, {
    old_text: "    if ($Name) {\n        Write-Output $Name\n    }",
    new_text: "    if ($Name) {\n        Write-Output \"Hello, $Name\"\n        return\n    }",
  }, "\n");
  assert.equal(apply(TABS, plan), "function Get-Thing {\n\tparam([string]$Name)\n\tif ($Name) {\n\t\tWrite-Output \"Hello, $Name\"\n\t\treturn\n\t}\n}\n");
  assert.equal(plan.found.note, " " + RESULTS.retabbed(4, true));
});

test("old_text with tabs on a file indented with spaces: the file's own unit, and new_text written with spaces", () => {
  const plan = planEdit("a.ps1", SPACES, { old_text: "\tif ($Name) {\n\t\tWrite-Output $Name\n\t}", new_text: "\tif ($Name) {\n\t\tWrite-Output $Name.Trim()\n\t}" }, "\n");
  assert.equal(apply(SPACES, plan), SPACES.replace("Write-Output $Name\n", "Write-Output $Name.Trim()\n"));
  assert.equal(plan.found.note, " " + RESULTS.retabbed(4, false));
  // A file indented 2 spaces a level: a tab is 2 spaces there.
  const two = "if ($a) {\n  if ($b) {\n    go\n  }\n}\n";
  const again = planEdit("a.ps1", two, { old_text: "\tif ($b) {\n\t\tgo\n\t}", new_text: "\tif ($b) {\n\t\tgo\n\t\tstop\n\t}" }, "\n");
  assert.equal(apply(two, again), "if ($a) {\n  if ($b) {\n    go\n    stop\n  }\n}\n");
  assert.equal(again.found.note, " " + RESULTS.retabbed(2, false));
});

test("converted and then a level off: both notes, new_text moved both ways", () => {
  const deep = "class A {\n\t[void] Go() {\n\t\tif ($x) {\n\t\t\t$y = 1\n\t\t}\n\t}\n}\n";
  const plan = planEdit("a.ps1", deep, { old_text: "if ($x) {\n    $y = 1\n}", new_text: "if ($x) {\n    $y = 2\n}" }, "\n");
  // The first line has no indentation of its own: only the lines under it say what a level is.
  assert.equal(apply(deep, plan), deep.replace("$y = 1", "$y = 2"));
  assert.match(plan.found.note, /one tab for 4 spaces/);
  assert.match(plan.found.note, /indented 2 tabs less/);
});

test("a single line, and CRLF files", () => {
  const plan = planEdit("a.ps1", TABS, { old_text: "        Write-Output $Name", new_text: "        Write-Output $Name.ToUpper()" }, "\n");
  assert.equal(apply(TABS, plan), TABS.replace("Write-Output $Name\n", "Write-Output $Name.ToUpper()\n"));
  const crlf = TABS.replace(/\n/g, "\r\n");
  const win = planEdit("a.ps1", crlf, { old_text: "    if ($Name) {\r\n        Write-Output $Name\r\n    }", new_text: "    if (-not $Name) {\r\n        Write-Output $Name\r\n    }" }, "\r\n");
  assert.equal(apply(crlf, win), crlf.replace("if ($Name)", "if (-not $Name)"));
});

test("read_file's line numbers and tabs for spaces together", () => {
  const plan = planEdit("a.ps1", TABS, { old_text: "3\t    if ($Name) {\n4\t        Write-Output $Name", new_text: "3\t    if ($Name) {\n4\t        Write-Output 1" }, "\n");
  assert.equal(apply(TABS, plan), TABS.replace("Write-Output $Name\n", "Write-Output 1\n"));
  assert.match(plan.found.note, /line numbers/);
  assert.match(plan.found.note, /one tab for 4 spaces/);
});

test("never a guess: uneven or mixed indentation, new_text that can't follow, two readings in two places, a file with no unit", () => {
  const miss = (/** @type {string} */ text, /** @type {string} */ old, /** @type {string} */ next) =>
    assert.throws(() => planEdit("a.ps1", text, { old_text: old, new_text: next }, "\n"), ToolError);
  // 3 spaces: not a whole number of tabs either way.
  miss(TABS, "   if ($Name) {\n      Write-Output $Name\n   }", "x");
  // A tab and spaces mixed in old_text.
  miss(TABS, "\tif ($Name) {\n        Write-Output $Name\n\t}", "x");
  // new_text with an odd indentation, which has no tab form.
  miss(TABS, "    if ($Name) {\n        Write-Output $Name\n    }", "    if ($Name) {\n      Write-Output $Name\n    }");
  // 4 spaces read as one tab is one place, read as two tabs another: no telling which was meant.
  const twice = "a {\n\tx = 1\n}\nb {\n\t\tx = 1\n}\n";
  miss(twice, "    x = 1", "    x = 2");
  // A file indented by 3 spaces here and 4 there has no unit to turn tabs into.
  const odd = "a {\n   b {\n    c\n   }\n}\n";
  miss(odd, "\tb {\n\t\tc\n\t}", "\tb {\n\t\td\n\t}");
  // Each refusal is the usual not-found error, not a different one.
  assert.throws(() => planEdit("a.ps1", twice, { old_text: "    x = 1", new_text: "    x = 2" }, "\n"), (e) => e instanceof ToolError && !/one tab for/.test(e.message));
});

test("what matched before still matches as before", () => {
  const plan = planEdit("a.ps1", TABS, { old_text: "\t\tWrite-Output $Name", new_text: "\t\tWrite-Output 2" }, "\n");
  assert.equal(plan.found.note, "");
  const shifted = planEdit("a.ps1", SPACES, { old_text: "if ($Name) {\n    Write-Output $Name\n}", new_text: "if ($Name) {\n    Write-Output 3\n}" }, "\n");
  assert.equal(shifted.found.note, " " + RESULTS.reindented("4 spaces", true));
});
