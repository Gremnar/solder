// @ts-nocheck
"use strict";
// One of Solder's checks inside a real VS Code: run with `node check/run.js readonly` (see check/README.md).
// Runs inside a real VS Code extension host: read-only mode is how a fresh install starts; the panel's Enable tools,
// the guided setup's step and Settings' switch turn changes on (and only Settings turns them off); the ReadOnly
// policy enforces either; an install set up before read-only mode keeps its changes on.
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
let REPO = path.resolve(__dirname, "..");
const T = process.env.SOLDER_CHECK_DIR || path.join(require("node:os").tmpdir(), "solder-check");
const LOG = path.join(T, "readonly.log");
const log = (...a) => fs.appendFileSync(LOG, a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ") + "\n");
const check = (name, ok, detail = "") => log(ok ? "PASS" : "FAIL", name, typeof detail === "string" ? detail : JSON.stringify(detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async function () {
  fs.writeFileSync(LOG, `=== readonly ${new Date().toISOString()}\n`);
  try { await Promise.race([main(), sleep(90000).then(() => log("!!! timed out: something is waiting for an answer"))]); } catch (e) { log("!!! harness", String(e && e.stack || e)); }
  log("=== end");
};

function stub(owner, name, fn) {
  const old = owner[name];
  try { owner[name] = fn; } catch { return null; }
  if (owner[name] !== fn) return null;
  return () => { owner[name] = old; };
}

async function main() {
  const ext = vscode.extensions.getExtension("gremnar.solder");
  await ext.activate();
  check("activates", ext.isActive);
  // The extension's own module instances (the drive letter's case matters to Node's module cache).
  const loaded = Object.keys(require.cache).filter((key) => /[\\/]src[\\/]policy\.js$/i.test(key));
  if (loaded.length) REPO = path.dirname(path.dirname(loaded[0]));
  const { policy } = require(path.join(REPO, "src", "policy.js"));
  const { readOnly } = require(path.join(REPO, "src", "config.js"));
  const { SolderPanel } = require(path.join(REPO, "src", "panel.js"));
  const { keepChanges } = require(path.join(REPO, "src", "extension.js"));
  const raw = () => vscode.workspace.getConfiguration("solder");
  const own = require("node:module").createRequire(path.join(REPO, "src", "panel.js"))("vscode");
  const told = [];
  const undo = [stub(own.window, "showInformationMessage", async (text) => { told.push(String(text)); return undefined; })];
  check("VS Code's prompts can be stood in for", undo.every(Boolean));

  try {
    // ---- a fresh install: read-only
    check("a fresh install starts in read-only mode (no endpoint, no key: nothing to keep)", readOnly() === true && raw().inspect("readOnly").globalValue === undefined,
      raw().inspect("readOnly"));
    const panel = new SolderPanel({ secrets: { get: async () => "", store: async () => {}, delete: async () => {} }, subscriptions: [], extension: ext,
      globalStorageUri: vscode.Uri.file(path.join(T, "gs-readonly")), storageUri: undefined, extensionUri: ext.extensionUri }, { appendLine() {}, show() {} });
    panel.refreshModels = async () => {}; // no gateway here
    let system = await panel.host().systemPrompt();
    check("the model is told it's read-only, and the engine's settings say so", /# Read-only mode/.test(system) && panel.settings().readOnly === true);
    check("... and isn't told how to save a skill", !/To save a new skill/.test(system));

    // ---- the panel's Enable tools
    await panel.onMessage({ type: "allowChanges" });
    system = await panel.host().systemPrompt();
    check("Enable tools turns changes on, in your user settings", readOnly() === false && raw().inspect("readOnly").globalValue === false && !/# Read-only mode/.test(system),
      raw().inspect("readOnly"));

    // ---- Settings: the switch, both ways
    await panel.onMessage({ type: "settings" });
    check("Settings shows changes on", panel.settingsScreen.view?.access === "change", panel.settingsScreen.view?.access);
    await panel.onMessage({ type: "settingsScreen", action: "set", field: "access", value: "read" });
    check("Settings' Read only turns read-only mode on again", readOnly() === true && panel.settingsScreen.view.access === "read" && panel.settingsScreen.view.saved === "access");
    await panel.onMessage({ type: "settingsScreen", action: "set", field: "access", value: "nonsense" });
    check("... an unknown value changes nothing", readOnly() === true);
    await panel.onMessage({ type: "settingsScreen", action: "close" });

    // ---- /skill in read-only mode: the form, not the model
    await panel.onMessage({ type: "command", name: "skill", arg: "" });
    check("/skill in read-only mode opens Settings' New skill form", panel.settingsScreen.view?.skillForm === true);
    await panel.onMessage({ type: "settingsScreen", action: "close" });

    // ---- the guided setup's step
    await panel.setup.start();
    check("the guided setup asks while Solder is read-only", panel.setup.view.steps.includes("changes") && panel.setup.view.readOnly === true, panel.setup.view.steps);
    panel.setup.go("changes");
    await panel.setup.handle({ action: "next" });
    check("Keep read-only leaves it on, and goes on", readOnly() === true && panel.setup.view.step === "done");
    panel.setup.go("changes");
    await panel.setup.handle({ action: "allowChanges" });
    check("Enable tools in setup turns changes on", readOnly() === false && panel.setup.view.step === "done" && panel.setup.view.readOnly === false);
    await panel.setup.handle({ action: "finish" });
    await panel.setup.start();
    check("with changes on, the setup doesn't ask again", !panel.setup.view.steps.includes("changes"), panel.setup.view.steps);
    await panel.setup.handle({ action: "cancel" });

    // ---- the policy
    // Opening Settings reads the registry again (nothing there on this PC): the policy set here is kept meanwhile.
    const refresh = policy.refresh;
    policy.refresh = async () => false;
    policy.apply(new Map([["readonly", 1]]), "");
    check("ReadOnly 1 enforces read-only mode over your setting", readOnly() === true && policy.locked("readOnly"));
    told.length = 0;
    await panel.onMessage({ type: "allowChanges" });
    check("... Enable tools says so and changes nothing", /organization keeps Solder in read-only mode/.test(told[0] || "") && raw().inspect("readOnly").globalValue === false, told);
    await panel.onMessage({ type: "settings" });
    await panel.onMessage({ type: "settingsScreen", action: "set", field: "access", value: "change" });
    check("... Settings' switch is locked", panel.settingsScreen.view.locked.access === true && /organization sets this/.test(panel.settingsScreen.view.notice));
    await panel.onMessage({ type: "settingsScreen", action: "close" });
    await panel.setup.start();
    check("... and the setup doesn't ask", !panel.setup.view.steps.includes("changes"));
    await panel.setup.handle({ action: "cancel" });
    policy.apply(new Map([["readonly", 0]]), "");
    await raw().update("readOnly", true, vscode.ConfigurationTarget.Global);
    check("ReadOnly 0 keeps changes on, whatever your setting", readOnly() === false);
    policy.apply(new Map(), "");
    policy.refresh = refresh;
    await raw().update("readOnly", undefined, vscode.ConfigurationTarget.Global);

    // ---- an install set up before read-only mode keeps its changes on, once
    const state = new Map();
    const context = (key) => ({ globalState: { get: (k) => state.get(k), update: async (k, v) => { state.set(k, v); } }, secrets: { get: async () => key } });
    await keepChanges(context(""));
    check("no endpoint and no key: left read-only (and not asked again)", readOnly() === true && state.get("readOnlySettled") === true);
    state.clear();
    await keepChanges(context("a-key"));
    check("set up before (a key saved): changes stay on", readOnly() === false && raw().inspect("readOnly").globalValue === false);
    await raw().update("readOnly", true, vscode.ConfigurationTarget.Global);
    await keepChanges(context("a-key"));
    check("... only once: read-only chosen later stays", readOnly() === true);
    state.clear();
    await keepChanges(context("a-key"));
    check("... and a choice already made is never overridden", readOnly() === true);
  } finally {
    for (const back of undo) back?.();
    policy.apply(new Map(), "");
    await raw().update("readOnly", undefined, vscode.ConfigurationTarget.Global);
  }
}
