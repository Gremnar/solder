// @ts-nocheck
"use strict";
// One of Solder's checks inside a real VS Code: run with `node check/run.js setup` (see check/README.md).
// Runs inside a real VS Code extension host: a first start where your organization sets the gateway but you have no
// key yet is setup to do (the guided setup starts, at the key), not a connection error; a key that's there but
// wrong is still a connection problem, with the guided setup on offer.
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
let REPO = path.resolve(__dirname, "..");
const T = process.env.SOLDER_CHECK_DIR || path.join(require("node:os").tmpdir(), "solder-check");
const LOG = path.join(T, "setup.log");
const log = (...a) => fs.appendFileSync(LOG, a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ") + "\n");
const check = (name, ok, detail = "") => log(ok ? "PASS" : "FAIL", name, typeof detail === "string" ? detail : JSON.stringify(detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async function () {
  fs.writeFileSync(LOG, `=== setup ${new Date().toISOString()}\n`);
  try { await Promise.race([main(), sleep(60000).then(() => log("!!! timed out: something is waiting for an answer"))]); } catch (e) { log("!!! harness", String(e && e.stack || e)); }
  log("=== end");
};

/** A webview view that records what's posted to it. */
function fakeView() {
  const posted = [];
  return { posted, visible: true, webview: { options: {}, html: "", cspSource: "vscode-resource:", asWebviewUri: (uri) => uri,
    onDidReceiveMessage: () => ({ dispose() {} }), postMessage: (m) => { posted.push(m); return Promise.resolve(true); } },
    onDidChangeVisibility: () => ({ dispose() {} }) };
}

async function main() {
  const ext = vscode.extensions.getExtension("gremnar.solder");
  await ext.activate();
  check("activates", ext.isActive);
  const loaded = Object.keys(require.cache).filter((key) => /[\\/]src[\\/]policy\.js$/i.test(key));
  if (loaded.length) REPO = path.dirname(path.dirname(loaded[0]));
  const { policy } = require(path.join(REPO, "src", "policy.js"));
  const { SolderPanel } = require(path.join(REPO, "src", "panel.js"));
  const refresh = policy.refresh;
  policy.refresh = async () => false; // the policy set here stays (there's none in this PC's registry)
  let key = "";
  const make = () => new SolderPanel({ secrets: { get: async () => key, store: async (_, v) => { key = v; }, delete: async () => { key = ""; } },
    subscriptions: [], extension: ext, globalStorageUri: vscode.Uri.file(path.join(T, "gs-setup")), storageUri: undefined,
    extensionUri: ext.extensionUri }, { appendLine() {}, show() {} });
  try {
    // An address no one answers at: nothing here may reach a real gateway.
    policy.apply(new Map([["endpoint", "https://gateway.invalid/v1/chat/completions"]]), "");
    const panel = make();
    panel.resolveWebviewView(fakeView());
    for (let i = 0; i < 100 && !panel.setup.view; i++) await sleep(50);
    check("your organization's gateway and no key: the guided setup starts by itself", !!panel.setup.view && panel.modelsProblem === "setup",
      { setup: !!panel.setup.view, problem: panel.modelsProblem });
    check("... at the key (the gateway is your organization's, so it isn't asked)", panel.setup.view?.step === "key" && !panel.setup.view.steps.includes("endpoint"),
      panel.setup.view?.steps);
    await panel.setup.handle({ action: "cancel" });
    await panel.refreshModels();
    check("... and Not now leaves the 'Set up Solder' card, not a connection error", panel.modelsProblem === "setup", panel.modelsProblem);

    key = "a-wrong-key";
    await panel.refreshModels();
    check("a key that's there is tried: a failure then is a connection problem, as before", panel.modelsProblem && panel.modelsProblem !== "setup", panel.modelsProblem);
    const again = make();
    again.resolveWebviewView(fakeView());
    await sleep(1500);
    check("... and the guided setup doesn't start by itself then", !again.setup.view);

    // ---- the daily embedding budget, in Settings → Docs / RAG
    const raw = () => vscode.workspace.getConfiguration("solder");
    await again.onMessage({ type: "settings" });
    await again.onMessage({ type: "settingsScreen", action: "set", field: "embedBudget", value: "100,000" });
    check("the daily budget saves, commas and all", raw().get("embedDailyBudget") === 100000 && again.settingsScreen.view.embedBudget === 100000, raw().get("embedDailyBudget"));
    await again.onMessage({ type: "settingsScreen", action: "set", field: "embedBudget", value: "lots" });
    check("... a value that isn't a whole number of tokens is refused, with why", raw().get("embedDailyBudget") === 100000 && /whole number of tokens/.test(again.settingsScreen.view.notice));
    const budget = again.tools.embedBudget();
    budget.raiseToday(null);
    await again.onMessage({ type: "settingsScreen", action: "raiseEmbedBudget" });
    check("Raise for today raises today's budget, until midnight UTC", budget.raisedToday() === 200000 && /Raised for today/.test(again.settingsScreen.view.notice), budget.raisedToday());
    budget.raiseToday(null);
    policy.apply(new Map([["endpoint", "https://gateway.invalid/v1/chat/completions"], ["embeddailybudget", 50000]]), "");
    await again.onMessage({ type: "settingsScreen", action: "raiseEmbedBudget" });
    await again.onMessage({ type: "settingsScreen", action: "set", field: "embedBudget", value: "999" });
    check("your organization's budget: used, locked, and not raised for the day", again.tools.embedBudgetSetting() === 50000 && budget.raisedToday() === undefined
      && raw().get("embedDailyBudget") === 100000, [again.tools.embedBudgetSetting(), budget.raisedToday()]);
    await raw().update("embedDailyBudget", undefined, vscode.ConfigurationTarget.Global);

    // ---- your organization's Tool models pattern: Kinds of model is shown by it, and locked
    await raw().update("assistModels", ["model-a-tools"], vscode.ConfigurationTarget.Global);
    again.models = [{ id: "model-a-tools", name: "A" }, { id: "model-a", name: "A (Assist)" }];
    policy.apply(new Map([["endpoint", "https://gateway.invalid/v1/chat/completions"], ["toolmodels", "-tools$"]]), "");
    await again.onMessage({ type: "settings" });
    const kinds = again.settingsScreen.view.kinds;
    check("an enforced Tool models pattern sorts Kinds of model, over the user's own list", JSON.stringify(kinds.map((k) => [k.id, k.assist])) === JSON.stringify([["model-a-tools", false], ["model-a", true]]), kinds);
    await again.onMessage({ type: "settingsScreen", action: "moveModel", name: "model-a", index: 0 });
    check("... and it's locked: a move is refused, with why", again.settingsScreen.view.locked.kinds === true && /organization sets which models/.test(again.settingsScreen.view.notice)
      && JSON.stringify(raw().get("assistModels")) === JSON.stringify(["model-a-tools"]), again.settingsScreen.view.notice);
    await raw().update("assistModels", undefined, vscode.ConfigurationTarget.Global);
  } finally {
    policy.apply(new Map(), "");
    policy.refresh = refresh;
  }
}
