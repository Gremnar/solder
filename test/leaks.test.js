// @ts-check
"use strict";
/**
 * This repo is public: no deployment's model ids, model-name patterns or session field names may go in it (they
 * belong in user settings or policy). This test fails on any. Its own words are built from pieces, so it doesn't
 * trip on itself.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const WORDS = [["gem", "ini-\\d"], ["with", "tools"], ["gemini", "_enter", "prise"], ["assist", "_token"]].map((parts) => parts.join(""));
const PATTERN = new RegExp(WORDS.join("|"), "i");

/** Every text file under a folder. @param {string} dir @returns {string[]} */
function files(dir) {
  /** @type {string[]} */
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "results" && entry.name !== "node_modules") out.push(...files(full)); }
    else if (/\.(js|md|json|admx|adml|html|css|txt)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

test("no deployment's model ids or session names in the public repo", () => {
  const found = [];
  for (const folder of ["src", "test", "docs", "live", "policy", "media", "build"]) {
    for (const file of files(path.join(ROOT, folder))) {
      fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, index) => {
        if (PATTERN.test(line)) found.push(`${path.relative(ROOT, file)}:${index + 1}`);
      });
    }
  }
  for (const file of ["README.md", "CHANGELOG.md", "package.json"]) {
    fs.readFileSync(path.join(ROOT, file), "utf8").split(/\r?\n/).forEach((line, index) => { if (PATTERN.test(line)) found.push(`${file}:${index + 1}`); });
  }
  assert.deepEqual(found, []);
});
