// @ts-check
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { bracesBalance } = require("../src/paste.js");

test("ordinary PowerShell with balanced braces is wrapped", () => {
  assert.equal(bracesBalance("$n = 1\nif ($n -eq 2) {\n  'two'\n}\nelse {\n  'other'\n}"), true);
  assert.equal(bracesBalance("Get-ChildItem | Where-Object { $_.Length -gt 1kb } | ForEach-Object {\n  $_.Name\n}"), true);
  assert.equal(bracesBalance("try {\n  throw 'x'\n}\ncatch {\n  Write-Warning $_\n}"), true);
  assert.equal(bracesBalance("$h = @{ a = 1; b = @{ c = 2 } }"), true);
  assert.equal(bracesBalance("Get-Date"), true);
});

test("a stray closing brace, or one left open, is not wrapped", () => {
  // The } would close the wrapper early, and the next lines would run as they arrive.
  assert.equal(bracesBalance("Get-Date\n}\nRemove-Item .\\x.txt\n{"), false);
  assert.equal(bracesBalance("}"), false);
  assert.equal(bracesBalance("if ($x) {\n  'never closed'"), false);
});

test("braces inside strings, here-strings and comments don't count", () => {
  assert.equal(bracesBalance("Write-Output '}'\nWrite-Output \"{ not code\""), true);
  assert.equal(bracesBalance("$s = 'it''s } fine'"), true);
  assert.equal(bracesBalance("$t = @'\n}\n}\n'@\n$t"), true);
  assert.equal(bracesBalance("$t = @\"\n{ $name\n\"@\n$t"), true);
  assert.equal(bracesBalance("# a } in a comment\nGet-Date"), true);
  assert.equal(bracesBalance("<# block } comment\n{ #>\nGet-Date"), true);
  assert.equal(bracesBalance("Write-Output `}"), true);
});

test("unsure means not wrapped: open strings and comments, subexpressions in double quotes", () => {
  assert.equal(bracesBalance("Write-Output 'open"), false);
  assert.equal(bracesBalance("Write-Output \"open"), false);
  assert.equal(bracesBalance("$t = @'\nnever closed"), false);
  assert.equal(bracesBalance("<# never closed"), false);
  assert.equal(bracesBalance("\"$(if ($x) { 'a' })\""), false);
});

test("a # inside a word is not a comment, so its braces still count", () => {
  assert.equal(bracesBalance("Write-Output a#}"), false);
});
