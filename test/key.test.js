// @ts-check
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { SavedKey, gatewayOf } = require("../src/key.js");

/** VS Code's secret storage, as a map. @param {Record<string, string>} [held] */
function secrets(held = {}) {
  const map = new Map(Object.entries(held));
  return { map, get: async (/** @type {string} */ name) => map.get(name), store: async (/** @type {string} */ name, /** @type {string} */ value) => { map.set(name, value); },
    delete: async (/** @type {string} */ name) => { map.delete(name); } };
}

const A = "https://gw-a.example.com/v1/chat/completions";
const B = "https://gw-b.example.com/v1/chat/completions";

test("a gateway is its scheme, host and port: a path, or the case, doesn't make another", () => {
  assert.equal(gatewayOf(A), "https://gw-a.example.com");
  assert.equal(gatewayOf("HTTPS://GW-A.example.com/other/path"), "https://gw-a.example.com");
  assert.notEqual(gatewayOf("https://gw-a.example.com:8443/v1"), gatewayOf(A));
  assert.notEqual(gatewayOf("http://gw-a.example.com/v1"), gatewayOf(A));
  assert.equal(gatewayOf(""), "");
  assert.equal(gatewayOf("not an address"), "");
  assert.equal(gatewayOf("file:///c:/x"), "");
});

test("a key goes only to the gateway it was saved for: a new address gets none until it's given its own", async () => {
  const store = secrets();
  const set = { endpoint: A, trusted: false };
  const key = new SavedKey(store, "k", () => set);
  await key.save("  key-for-a ");
  assert.equal(await key.get(), "key-for-a");
  assert.equal(await key.get("https://gw-a.example.com/v1/models"), "key-for-a", "the same gateway, whatever the path");

  set.endpoint = B; // typed into Settings, or the guided setup
  assert.equal(await key.get(), "", "the old gateway's key isn't sent to the new one");
  assert.equal(await key.elsewhere(), true);
  assert.equal(await key.any(), true);
  assert.equal(await key.get(A), "key-for-a", "and it's still there for its own");

  await key.save("key-for-b");
  assert.equal(await key.get(), "key-for-b");
  assert.equal(await key.elsewhere(), false);
  assert.equal(await key.get(A), "", "one key is kept: it's the new gateway's now");

  await key.save("");
  assert.deepEqual([await key.any(), await key.get(), store.map.size], [false, "", 0], "removed, with what it was for");
});

test("a key saved before the gateway was kept with it is taken as the gateway's that's set, once", async () => {
  const store = secrets({ k: "old-key" });
  const set = { endpoint: A, trusted: false };
  const key = new SavedKey(store, "k", () => set);
  assert.equal(await key.get(), "old-key");
  assert.equal(store.map.get("k.gateway"), "https://gw-a.example.com");
  set.endpoint = B;
  assert.equal(await key.get(), "", "from then on it's that gateway's alone");
});

test("a key saved with no gateway set is the first gateway's; no address, no key", async () => {
  const store = secrets();
  const set = { endpoint: "", trusted: false };
  const key = new SavedKey(store, "k", () => set);
  await key.save("early-key");
  assert.equal(await key.get(), "", "nowhere to send it yet");
  set.endpoint = A;
  assert.equal(await key.get(), "early-key");
  set.endpoint = B;
  assert.equal(await key.get(), "");
});

test("your organization's address takes the key with it; an address of your own doesn't", async () => {
  const store = secrets();
  const set = { endpoint: A, trusted: true };
  const key = new SavedKey(store, "k", () => set);
  await key.save("org-key");
  set.endpoint = B; // the policy's address changed
  assert.equal(await key.get(), "org-key");
  assert.equal(store.map.get("k.gateway"), "https://gw-b.example.com");
  assert.equal(await key.get("https://elsewhere.example.com/v1"), "", "only the address the organization sets");
  set.trusted = false;
  set.endpoint = A;
  assert.equal(await key.get(), "", "without the policy, the key stays where it was last");
});
