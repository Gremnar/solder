// @ts-check
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Policy, parseRegFile } = require("../src/policy.js");

const KEY = "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Gremnar\\Solder";
/** UTF-16 text as reg.exe exports it: a multi-string as hex(7) bytes. @param {string[]} items */
const multi = (items) => [...Buffer.from(items.join("\0") + "\0\0", "utf16le")].map((b) => b.toString(16).padStart(2, "0")).join(",");

test("a .reg export: strings (escapes), dwords, multi-strings across lines; other keys and kinds left out", () => {
  const text = [
    "\uFEFFWindows Registry Editor Version 5.00",
    "",
    `[${KEY}]`,
    "\"Endpoint\"=\"https://gw.example.com/v1/chat/completions\"",
    "\"Rules\"=\"Use \\\"PowerShell 7\\\" syntax\\\\style.\"",
    "\"MaxRounds\"=dword:0000001e",
    `"DocsFolders"=hex(7):${multi(["\\\\share\\docs|The API", "C:\\Docs"]).replace(/(.{60},)/g, "$1\\\r\n  ")}`,
    "\"Blob\"=hex:01,02",
    "",
    `[${KEY}\\Sub]`,
    "\"Endpoint\"=\"https://not-this.example.com\"",
  ].join("\r\n");
  const values = parseRegFile(text, KEY);
  assert.equal(values.get("Endpoint"), "https://gw.example.com/v1/chat/completions");
  assert.equal(values.get("Rules"), "Use \"PowerShell 7\" syntax\\style.");
  assert.equal(values.get("MaxRounds"), 30);
  assert.deepEqual(values.get("DocsFolders"), ["\\\\share\\docs|The API", "C:\\Docs"]);
  assert.ok(!values.has("Blob"));
  assert.equal(values.size, 4, "the subkey's values aren't the key's");
});

/** A policy with these values in the two hives. @param {Record<string, any>} machine @param {Record<string, any>} [user] */
async function policyWith(machine, user = {}) {
  const policy = new Policy({ platform: "win32", read: async (key) => {
    const values = /^HKLM/.test(key) ? machine : user;
    return Object.keys(values).length ? new Map(Object.entries(values)) : null;
  } });
  await policy.refresh();
  return policy;
}

/** VS Code's settings, as the user has them. @param {Record<string, any>} values */
function userConfig(values) {
  const updates = [];
  return { updates, get: (/** @type {string} */ name, /** @type {any} */ fallback) => name in values ? values[name] : fallback,
    update: async (/** @type {string} */ name, /** @type {any} */ value) => { updates.push([name, value]); } };
}

test("enforced values win over the user's, computer policy over user policy, and locked ones can't be changed", async () => {
  const policy = await policyWith({ Endpoint: "https://gw.example.com/v1/chat/completions", MaxRounds: 12 }, { MaxRounds: 99, Model: "model-a" });
  const user = userConfig({ endpoint: "https://mine.example.com/v1/chat/completions", maxRounds: 40, effort: "high" });
  const config = policy.wrap(user);
  assert.equal(config.get("endpoint", ""), "https://gw.example.com/v1/chat/completions");
  assert.equal(config.get("maxRounds", 30), 12, "the computer's value, not the user policy's");
  assert.equal(config.get("model", ""), "model-a", "user policy, where the computer sets nothing");
  assert.equal(config.get("effort", "default"), "high", "not enforced: the user's");
  assert.ok(policy.locked("endpoint") && policy.locked("model") && !policy.locked("effort"));
  await config.update("endpoint", "https://other.example.com", 1);
  await config.update("effort", "low", 1);
  assert.deepEqual(user.updates, [["effort", "low"]], "the enforced endpoint isn't written");
  assert.deepEqual(policy.names.sort(), ["endpoint", "maxRounds", "model"]);
});

test("docs folders: the organisation's alone, or with the user's own when AllowUserDocsFolders is on", async () => {
  const only = await policyWith({ DocsFolders: ["\\\\share\\docs|The API", "C:\\Specs"] });
  const user = userConfig({ docsFolders: ["D:\\Mine", { path: "C:\\specs", about: "dup" }] });
  assert.deepEqual(only.wrap(user).get("docsFolders", []), [{ path: "\\\\share\\docs", about: "The API" }, { path: "C:\\Specs", about: "" }]);
  assert.ok(only.locked("docsFolders"));
  const both = await policyWith({ DocsFolders: ["\\\\share\\docs|The API", "C:\\Specs"], AllowUserDocsFolders: 1 });
  assert.deepEqual(both.wrap(user).get("docsFolders", []).map((/** @type {any} */ d) => d.path), ["\\\\share\\docs", "C:\\Specs", "D:\\Mine"],
    "the user's added after, a folder already in the organisation's not twice");
  assert.ok(!both.locked("docsFolders"));
  assert.deepEqual(both.wrap(user).own("docsFolders", []), ["D:\\Mine", { path: "C:\\specs", about: "dup" }]);
});

test("values of the wrong kind aren't used (and are reported), but a malformed gateway is still enforced", async () => {
  const policy = await policyWith({ Effort: "extreme", MaxRounds: "lots", Endpoint: "not a url", ModelNames: "{\"model-a\": \"A\"}", OrgRules: ["Line one.", "Line two."] });
  const config = policy.wrap(userConfig({ effort: "low", maxRounds: 30, endpoint: "https://mine.example.com/v1/chat/completions" }));
  assert.equal(config.get("effort", "default"), "low");
  assert.equal(config.get("maxRounds", 30), 30);
  assert.equal(config.get("endpoint", ""), "not a url", "the user's own gateway isn't used instead");
  assert.deepEqual(config.get("modelNames", {}), { "model-a": "A" });
  assert.equal(policy.orgRules, "Line one.\nLine two.");
  assert.deepEqual(policy.problems, ["Effort: not a usable choice", "MaxRounds: not a usable number"]);
});

test("a policy that can't be read fails closed; off Windows there's none", async () => {
  const broken = new Policy({ platform: "win32", read: async () => { throw new Error("reg.exe couldn't run: EACCES"); } });
  await broken.refresh();
  assert.match(broken.error, /couldn't be read \(reg\.exe couldn't run: EACCES\), so Solder won't connect/);
  const mac = new Policy({ platform: "darwin", read: async () => { throw new Error("not called"); } });
  await mac.refresh();
  assert.equal(mac.error, "");
  assert.equal(mac.names.length, 0);
  // Read again after a fix: the error clears, and refresh says it changed.
  let fail = true;
  const later = new Policy({ platform: "win32", read: async () => { if (fail) throw new Error("x"); return null; } });
  await later.refresh();
  fail = false;
  assert.equal(await later.refresh(), true);
  assert.equal(later.error, "");
});

test("the gate: nothing connects while the policy can't be read", async () => {
  const broken = new Policy({ platform: "win32", read: async () => { throw new Error("x"); } });
  await broken.refresh();
  assert.throws(() => broken.gate(), /couldn't be read/);
  const fine = await policyWith({});
  assert.doesNotThrow(() => fine.gate());
});

test("reg.exe: a key that isn't there is no policy; one that can't be exported fails closed (even with TEMP pointed away)",
  { skip: process.platform !== "win32" }, async () => {
    const { readKey } = require("../src/policy.js");
    assert.equal(await readKey("HKCU\\SOFTWARE\\SolderNoSuchPolicyKey"), null);
    const temp = process.env.TEMP;
    const tmp = process.env.TMP;
    try {
      process.env.TEMP = process.env.TMP = "C:\\this-folder-does-not-exist-solder";
      await assert.rejects(readKey("HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer"), /couldn't export it/);
      assert.equal(await readKey("HKCU\\SOFTWARE\\SolderNoSuchPolicyKey"), null, "and a missing key is still just missing");
    } finally {
      process.env.TEMP = temp;
      process.env.TMP = tmp;
    }
  });
