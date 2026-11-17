// @ts-check
"use strict";
/**
 * The Group Policy templates against the code: every policy writes to the key Solder reads, every value Solder reads
 * has a policy, and every string and box the ADMX names is in the ADML. (A path that lost its backslashes once made
 * two policies write where Solder never looks: this is what would have caught it.)
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SETTINGS, KEYS, ALLOW_USER_DOCS, ALLOW_USER_SKILLS, ORG_RULES, FEEDBACK_ADDRESS } = require("../src/policy.js");

const admx = fs.readFileSync(path.join(__dirname, "..", "policy", "Solder.admx"), "utf8");
const adml = fs.readFileSync(path.join(__dirname, "..", "policy", "en-US", "Solder.adml"), "utf8");
const policies = [...admx.matchAll(/<policy\b[^>]*>[\s\S]*?<\/policy>/g)].map((m) => m[0]);

test("every policy writes to the key Solder reads (HKLM or HKCU, Software\\Policies\\Gremnar\\Solder)", () => {
  assert.ok(policies.length > 0);
  const wanted = KEYS[0].replace(/^HKLM\\/i, "").toLowerCase(); // registry paths ignore case
  for (const policy of policies) {
    const name = /name="([^"]+)"/.exec(policy)?.[1];
    assert.equal(/key="([^"]*)"/.exec(policy)?.[1]?.toLowerCase(), wanted, `${name}'s key`);
  }
});

test("every value Solder reads has a policy that writes it", () => {
  const written = new Set(policies.flatMap((policy) => [...policy.matchAll(/valueName="([^"]+)"/g)].map((m) => m[1])));
  const read = [...Object.values(SETTINGS).map((s) => s.value), ALLOW_USER_DOCS, ALLOW_USER_SKILLS, ORG_RULES, FEEDBACK_ADDRESS];
  for (const value of read) assert.ok(written.has(value), `no policy writes ${value}`);
});

test("every string and presentation the ADMX names is in the ADML", () => {
  const strings = new Set([...adml.matchAll(/<string id="([^"]+)"/g)].map((m) => m[1]));
  const presentations = new Set([...adml.matchAll(/<presentation id="([^"]+)"/g)].map((m) => m[1]));
  for (const [, id] of admx.matchAll(/\$\(string\.([^)]+)\)/g)) assert.ok(strings.has(id), `string ${id}`);
  for (const [, id] of admx.matchAll(/\$\(presentation\.([^)]+)\)/g)) assert.ok(presentations.has(id), `presentation ${id}`);
});
