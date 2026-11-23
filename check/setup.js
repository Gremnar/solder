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
  const held = new Map(); // the secret storage: the key, and the gateway it's for
  const make = () => new SolderPanel({ secrets: { get: async (name) => held.get(name), store: async (name, v) => { held.set(name, v); }, delete: async (name) => { held.delete(name); } },
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

    held.set("solder.apiKey", "a-wrong-key");
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

    // ---- embedding waits for Start in Settings, and Stop holds it: no notification to answer in time
    {
      policy.apply(new Map([["endpoint", "https://gateway.invalid/v1/chat/completions"]]), "");
      await raw().update("docsSearch", "hybrid", vscode.ConfigurationTarget.Global);
      await raw().update("embeddingModel", "embed-a", vscode.ConfigurationTarget.Global);
      const tools = again.tools;
      tools.setEmbedState({ held: false, agreed: "" });
      tools.embedToldFor = "";
      const told = [];
      const before = tools.onEmbedWaiting;
      tools.onEmbedWaiting = (passages, tokens) => { told.push([passages, tokens]); };
      try {
        const first = await tools.confirmEmbedding("embed-a", 4210, 1_200_000);
        const second = await tools.confirmEmbedding("embed-a", 4210, 1_200_000);
        check("a big embedding run waits for you: nothing is sent, and you're told once that it's waiting", first === false && second === false && told.length === 1 && told[0][0] === 4210, [first, second, told]);
        await again.onMessage({ type: "settings" });
        await again.onMessage({ type: "settingsScreen", action: "startEmbedding" });
        check("Start in Settings lets it go ahead, and says it carries on with Settings closed", tools.embedState().agreed === "embed-a" && tools.embedState().held === false
          && await tools.confirmEmbedding("embed-a", 4210, 1_200_000) === true && /carries on/.test(again.settingsScreen.view.notice), [tools.embedState(), again.settingsScreen.view.notice]);
        check("... for that model only: another model's big run waits again", await tools.confirmEmbedding("embed-b", 500, 1000) === false);
        await again.onMessage({ type: "settingsScreen", action: "stopEmbedding" });
        check("Stop holds embedding until Start, and says what's kept", tools.embedState().held === true && /stopped/i.test(again.settingsScreen.view.notice), [tools.embedState(), again.settingsScreen.view.notice]);
        const saved = JSON.parse(fs.readFileSync(tools.embedStateFile(), "utf8"));
        tools._embedState = null; // as after a restart
        check("... and both are remembered across restarts", saved.held === true && saved.agreed === "embed-a" && tools.embedState().held === true && tools.embedState().agreed === "embed-a", saved);
        await again.onMessage({ type: "settingsScreen", action: "startEmbedding" });
        check("Start again takes the hold off", tools.embedState().held === false);
      } finally {
        tools.onEmbedWaiting = before;
        tools.setEmbedState({ held: false, agreed: "" });
        await raw().update("docsSearch", undefined, vscode.ConfigurationTarget.Global);
        await raw().update("embeddingModel", undefined, vscode.ConfigurationTarget.Global);
      }
    }

    // ---- the embedding pace: tokens a minute, saved; your organization's is used and locked
    {
      policy.apply(new Map([["endpoint", "https://gateway.invalid/v1/chat/completions"]]), "");
      await again.onMessage({ type: "settings" });
      check("left alone, embedding is paced to 250,000 tokens a minute", again.tools.embedRateSetting() === 250000 && again.settingsScreen.view.embedRate === 250000, again.tools.embedRateSetting());
      await again.onMessage({ type: "settingsScreen", action: "set", field: "embedRate", value: "120,000" });
      check("the pace saves, commas and all, and the docs index is given it", raw().get("embedTokensPerMinute") === 120000 && again.tools.embedRateSetting() === 120000, raw().get("embedTokensPerMinute"));
      await again.onMessage({ type: "settingsScreen", action: "set", field: "embedRate", value: "fast" });
      check("... a value that isn't a whole number of tokens is refused, with why", raw().get("embedTokensPerMinute") === 120000 && /whole number of tokens a minute/.test(again.settingsScreen.view.notice), again.settingsScreen.view.notice);
      await again.onMessage({ type: "settingsScreen", action: "set", field: "embedRate", value: "0" });
      check("... 0 means no limit", raw().get("embedTokensPerMinute") === 0 && again.tools.embedRateSetting() === 0);
      policy.apply(new Map([["endpoint", "https://gateway.invalid/v1/chat/completions"], ["embedtokensperminute", 200000]]), "");
      await again.onMessage({ type: "settings" });
      await again.onMessage({ type: "settingsScreen", action: "set", field: "embedRate", value: "999999" });
      check("your organization's pace: used, shown locked, and not changed by you", again.tools.embedRateSetting() === 200000 && again.settingsScreen.view.locked.embedRate === true && raw().get("embedTokensPerMinute") === 0,
        [again.tools.embedRateSetting(), again.settingsScreen.view.locked.embedRate]);
      policy.apply(new Map([["endpoint", "https://gateway.invalid/v1/chat/completions"]]), "");
      await raw().update("embedTokensPerMinute", undefined, vscode.ConfigurationTarget.Global);
    }

    // ---- the Assist lane's own limits: saved within their ranges; your organization's are used and locked
    {
      policy.apply(new Map([["endpoint", "https://gateway.invalid/v1/chat/completions"]]), "");
      await again.onMessage({ type: "settings" });
      await again.onMessage({ type: "settingsScreen", action: "set", field: "assistMaxRounds", value: "80" });
      await again.onMessage({ type: "settingsScreen", action: "set", field: "assistCarryTokens", value: "600,000" });
      check("Assist max rounds and carry-over save, and the engine is given them", raw().get("assistMaxRounds") === 80 && raw().get("assistCarryTokens") === 600000
        && again.settings().assistMaxRounds === 80 && again.settings().assistCarryTokens === 600000, [raw().get("assistMaxRounds"), raw().get("assistCarryTokens")]);
      await again.onMessage({ type: "settingsScreen", action: "set", field: "assistMaxRounds", value: "500" });
      const tooMany = again.settingsScreen.view.notice;
      await again.onMessage({ type: "settingsScreen", action: "set", field: "assistCarryTokens", value: "5" });
      check("... values outside their ranges are refused, with why", raw().get("assistMaxRounds") === 80 && raw().get("assistCarryTokens") === 600000
        && /between 1 and 200/.test(tooMany) && /between 20,000 and 900,000/.test(again.settingsScreen.view.notice), [tooMany, again.settingsScreen.view.notice]);
      policy.apply(new Map([["endpoint", "https://gateway.invalid/v1/chat/completions"], ["assistmaxrounds", 120], ["assistcarrytokens", 700000]]), "");
      await again.onMessage({ type: "settings" });
      await again.onMessage({ type: "settingsScreen", action: "set", field: "assistMaxRounds", value: "5" });
      check("your organization's Assist limits: used, shown locked, and not changed by you", again.settings().assistMaxRounds === 120 && again.settings().assistCarryTokens === 700000
        && again.settingsScreen.view.locked.assistMaxRounds === true && again.settingsScreen.view.locked.assistCarryTokens === true && raw().get("assistMaxRounds") === 80,
        [again.settings().assistMaxRounds, again.settings().assistCarryTokens, again.settingsScreen.view.locked]);
      policy.apply(new Map([["endpoint", "https://gateway.invalid/v1/chat/completions"]]), "");
      await raw().update("assistMaxRounds", undefined, vscode.ConfigurationTarget.Global);
      await raw().update("assistCarryTokens", undefined, vscode.ConfigurationTarget.Global);
      check("left alone, the defaults: 60 steps, 200,000 tokens", again.settings().assistMaxRounds === 60 && again.settings().assistCarryTokens === 200000);
    }

    // ---- the shared embeddings folder: a full path, saved; your organization's is used and locked
    {
      const shared = path.join(T, "shared-embeddings");
      policy.apply(new Map([["endpoint", "https://gateway.invalid/v1/chat/completions"]]), "");
      await again.onMessage({ type: "settingsScreen", action: "set", field: "embeddingsCache", value: "  " + shared + " " });
      check("the shared embeddings folder saves, and the docs index is given it", raw().get("embeddingsCache") === shared && again.tools.embedCache()?.folder.toLowerCase() === path.resolve(shared).toLowerCase(),
        [raw().get("embeddingsCache"), again.tools.embedCache()?.folder]);
      await again.onMessage({ type: "settingsScreen", action: "set", field: "embeddingsCache", value: "some/relative/folder" });
      check("... a folder that isn't a full path is refused, with why", raw().get("embeddingsCache") === shared && /full path/.test(again.settingsScreen.view.notice), again.settingsScreen.view.notice);
      const theirs = path.join(T, "org-embeddings");
      policy.apply(new Map([["endpoint", "https://gateway.invalid/v1/chat/completions"], ["embeddingscache", theirs]]), "");
      await again.onMessage({ type: "settings" });
      await again.onMessage({ type: "settingsScreen", action: "set", field: "embeddingsCache", value: path.join(T, "mine-instead") });
      check("your organization's shared folder: used, shown locked, and not changed by you", again.tools.embedCache()?.folder.toLowerCase() === path.resolve(theirs).toLowerCase()
        && again.settingsScreen.view.locked.embeddingsCache === true && raw().get("embeddingsCache") === shared, [again.tools.embedCache()?.folder, again.settingsScreen.view.locked.embeddingsCache, raw().get("embeddingsCache")]);
      policy.apply(new Map([["endpoint", "https://gateway.invalid/v1/chat/completions"], ["embeddailybudget", 50000]]), "");
      await again.onMessage({ type: "settings" });
      await again.onMessage({ type: "settingsScreen", action: "set", field: "embeddingsCache", value: "" });
      check("emptied, there's no shared folder", !raw().get("embeddingsCache") && again.tools.embedCache() === null, raw().get("embeddingsCache"));
      await raw().update("embeddingsCache", undefined, vscode.ConfigurationTarget.Global);
    }

    // ---- Settings → Rules: the instruction file is one you make; the button makes it (once) and opens it
    {
      const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
      const file = path.join(ws, "AGENTS.md");
      fs.rmSync(file, { force: true });
      await again.onMessage({ type: "settings" });
      check("Settings says this workspace has no AGENTS.md yet", again.settingsScreen.view.instructionsHere.found.length === 0 && again.settingsScreen.view.instructionsHere.name === "AGENTS.md",
        again.settingsScreen.view.instructionsHere);
      await again.onMessage({ type: "settingsScreen", action: "openInstructions" });
      check("Create makes it, with a few lines on what to write, and opens it", fs.existsSync(file) && /Solder reads this file at the start of every chat/.test(fs.readFileSync(file, "utf8"))
        && (vscode.window.activeTextEditor?.document.uri.fsPath || "").toLowerCase() === file.toLowerCase(), vscode.window.activeTextEditor?.document.uri.fsPath);
      check("... Settings then shows it, and the model is given it", JSON.stringify(again.settingsScreen.view.instructionsHere.found) === JSON.stringify(["AGENTS.md"])
        && again.promptContext().instructions.some((i) => i.path === "AGENTS.md"), again.settingsScreen.view.instructionsHere);
      fs.writeFileSync(file, "Target Windows PowerShell 5.1.\n");
      await again.onMessage({ type: "settingsScreen", action: "openInstructions" });
      check("... and one that's there is opened, never written over", fs.readFileSync(file, "utf8") === "Target Windows PowerShell 5.1.\n");
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      fs.rmSync(file, { force: true });
    }

    // ---- your key goes only to the gateway it was saved for: a new address gets none until it's given its own
    {
      const first = "https://gateway-one.invalid/v1/chat/completions";
      const other = "https://gateway-two.invalid/v1/chat/completions";
      policy.apply(new Map(), "");
      held.clear();
      await raw().update("endpoint", first, vscode.ConfigurationTarget.Global);
      await again.onMessage({ type: "settings" });
      await again.onMessage({ type: "settingsScreen", action: "key", key: " key-for-one " });
      await again.refreshModels();
      check("a key saved in Settings is kept with the gateway that's set, and used for it", held.get("solder.apiKey") === "key-for-one" && held.get("solder.apiKey.gateway") === "https://gateway-one.invalid"
        && again.client().apiKey === "key-for-one" && again.settingsScreen.view.hasKey === true, [...held.entries()].map(([name]) => name));
      await again.onMessage({ type: "settingsScreen", action: "set", field: "endpoint", value: other });
      await again.refreshModels();
      check("another gateway's address entered: the saved key isn't sent there, and Settings says whose it is", again.client().apiKey === "" && again.settingsScreen.view.hasKey === false
        && again.settingsScreen.view.keyElsewhere === true && /another gateway's/.test(again.settingsScreen.view.notice) && again.modelsProblem === "setup",
        [again.client().apiKey === "", again.settingsScreen.view.hasKey, again.settingsScreen.view.notice, again.modelsProblem]);
      check("... and that gateway counts as not set up yet (it needs its own key)", await again.setup.needed() === true);
      await again.setup.start();
      check("... the guided setup shows no key for it either", again.setup.view.hasKey === false && again.setup.view.endpoint === other, again.setup.view.hasKey);
      await again.setup.handle({ action: "cancel" });
      await again.onMessage({ type: "settingsScreen", action: "set", field: "endpoint", value: first });
      await again.refreshModels();
      check("back at its own gateway, the key is there as before", again.client().apiKey === "key-for-one" && again.settingsScreen.view.hasKey === true && again.settingsScreen.view.keyElsewhere === false);
      await again.onMessage({ type: "settingsScreen", action: "set", field: "endpoint", value: other });
      await again.onMessage({ type: "settingsScreen", action: "key", key: "key-for-two" });
      await again.refreshModels();
      check("a key entered for the new gateway is that gateway's", again.client().apiKey === "key-for-two" && held.get("solder.apiKey.gateway") === "https://gateway-two.invalid", held.get("solder.apiKey.gateway"));
      // Your organization's address takes the key with it: the address is theirs to move.
      policy.apply(new Map([["endpoint", "https://gateway.invalid/v1/chat/completions"]]), "");
      await again.refreshModels();
      check("an address your organization sets is sent the key you have", again.client().apiKey === "key-for-two" && held.get("solder.apiKey.gateway") === "https://gateway.invalid", held.get("solder.apiKey.gateway"));
      await raw().update("endpoint", undefined, vscode.ConfigurationTarget.Global);
      held.clear();
      held.set("solder.apiKey", "a-wrong-key");
      await again.onMessage({ type: "settings" });
    }

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
