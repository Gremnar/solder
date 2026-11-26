// @ts-check
"use strict";
/**
 * Guided setup in the side bar: the gateway's address, the API key (checked by listing the models), the
 * default model, docs folders, your own rules, and whether Solder may change files (it starts read-only). Everything lands where the settings page and
 * "Set API key" would put it: user settings, and VS Code's secret storage for the key.
 */
const vscode = require("vscode");
const { config: solderSettings, policy, readOnly, allowChanges, modelAllowed, MODEL_FILTER_BROKEN } = require("./config.js");
const { GatewayClient, GatewayError } = require("./gateway.js");
const { laneOf, bestModel, probeTools, withAssist } = require("./lanes.js");

const STEPS = ["endpoint", "key", "model", "docs", "rules", "changes", "done"];
const CHECK_MS = 30_000;

class SetupWizard {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {import("./key.js").SavedKey} key your key, kept with the gateway it's for
   * @param {() => void} changed called whenever what the panel shows changes
   * @param {{skills?: () => number, skillsHome?: () => Promise<void>}} [hooks] skills: how many skills the model is offered
   *   (for the summary); skillsHome: makes your skills folder, if you have none
   */
  constructor(context, key, changed, hooks = {}) {
    this.context = context;
    this.key = key;
    this.changed = changed;
    this.hooks = hooks;
    /** @type {any} what the panel shows, or null when setup isn't running */
    this.view = null;
    /** The tool-calling test (lanes.js), here so a check can stand in for the gateway. */
    this.probe = probeTools;
  }

  /** Whether Solder still needs setting up: no endpoint, or a remote one with no key. */
  async needed() {
    const endpoint = String(solderSettings().get("endpoint", "")).trim();
    if (!endpoint) return true;
    // A key saved for another gateway isn't this one's: this one still needs its own.
    return !(await this.key.get(endpoint)) && !isLocal(endpoint);
  }

  /** Start (or restart) at the first step, with what's already set filled in. */
  async start() {
    await this.hooks.skillsHome?.(); // your skills folder, ready before the summary counts your skills
    const config = solderSettings();
    const key = await this.key.get();
    this.view = {
      step: "", steps: stepsNow(), busy: false, error: "",
      endpoint: String(config.get("endpoint", "")), hasKey: !!key, models: [], model: String(config.get("model", "")),
      docs: docsFrom(config.own("docsFolders", [])), rules: String(config.get("rules", "")), skills: this.hooks.skills?.() ?? 0,
      readOnly: readOnly(),
    };
    this.view.step = this.view.steps[0];
    this.changed();
  }

  /** @param {string} step */
  go(step) {
    this.view.step = step;
    this.view.error = "";
    this.view.busy = false;
    this.changed();
  }

  /** A message from the panel's setup card. @param {any} message */
  async handle(message) {
    const view = this.view;
    if (!view) return;
    const action = String(message.action || "");
    if (action === "cancel" || action === "finish") { this.view = null; this.changed(); return; }
    if (action === "back") { this.go(view.steps[Math.max(0, view.steps.indexOf(view.step) - 1)]); return; }
    // The step this message came from. A wait below (a save, a check) can end after setup was closed, restarted or
    // taken Back: what comes back then stays with the step that asked, and doesn't move setup on.
    const step = view.step;
    const current = () => this.view === view && view.step === step;
    const go = (/** @type {string} */ next) => { if (current()) this.go(next); };
    const changed = () => { if (current()) this.changed(); };
    const after = (/** @type {string} */ step) => view.steps[view.steps.indexOf(step) + 1] || "done";
    const config = solderSettings();
    const save = (/** @type {string} */ name, /** @type {any} */ value) => config.update(name, value, vscode.ConfigurationTarget.Global);
    switch (view.step) {
      case "endpoint": {
        const endpoint = String(message.endpoint || "").trim();
        try { new GatewayClient({ endpoint, apiKey: "" }); } catch (error) { view.error = messageOf(error); changed(); return; }
        view.endpoint = endpoint;
        await save("endpoint", endpoint);
        // The key step shows whether this gateway has a key: one saved for another gateway doesn't count, and isn't sent.
        view.hasKey = !!(await this.key.get(endpoint));
        go(after("endpoint"));
        return;
      }
      case "key": {
        const typed = String(message.key || "").trim();
        if (action === "skipCheck") { view.models = []; go(after("key")); return; }
        const gateway = String(config.get("endpoint", "") || view.endpoint);
        if (typed) await this.key.save(typed, gateway);
        const key = typed || await this.key.get(gateway);
        view.hasKey = !!key;
        view.busy = true;
        view.error = "";
        changed();
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), CHECK_MS);
          let ids;
          policy.gate();
          try { ids = await new GatewayClient({ endpoint: gateway, apiKey: key }).models(controller.signal); }
          finally { clearTimeout(timer); }
          const filter = String(config.get("modelFilter", ""));
          if (filter) {
            try { const pattern = new RegExp(filter, "i"); ids = ids.filter((id) => pattern.test(id)); }
            // Your own filter that won't read is shown in Settings; your organization's offers nothing (it fails closed).
            catch { if (policy.locked("modelFilter")) throw new Error(MODEL_FILTER_BROKEN); }
          }
          /** @type {Record<string, string>} */
          const names = config.get("modelNames", {}) || {};
          // Each model's kind: Tool models first, Assist models after them.
          const kinds = { toolModels: String(config.get("toolModels", "") || ""), assistModels: (config.get("assistModels", []) || []).map(String) };
          view.models = ids.map((id) => ({ id, name: names[id] || id, assist: laneOf(id, kinds) === "assist" }))
            .sort((a, b) => Number(a.assist) - Number(b.assist));
          // The choice made for you is a Tool model: an Assist model only if you pick one (or there's nothing else).
          const tools = view.models.filter((/** @type {any} */ m) => !m.assist);
          // Of those, the best by its name (not a lite or mini one; the highest version), so nobody starts on the weakest.
          // A model you already chose stays chosen, whichever kind it is (an Assist model used to be swapped for a Tool one).
          if (!view.model || !ids.includes(view.model)) {
            view.model = bestModel((tools.length ? tools : view.models).map((/** @type {any} */ m) => m.id)) || view.model;
          }
          go(after("key"));
        } catch (error) {
          view.busy = false;
          view.error = error instanceof GatewayError && error.name === "Cancelled" ? "The gateway didn't answer within 30 seconds."
            : messageOf(error);
          changed();
        }
        return;
      }
      case "model": {
        // The model answered without calling a tool: marked as an Assist model, or kept as it is.
        if (action === "markAssist" || action === "keepTool") {
          const offer = view.assistOffer;
          view.assistOffer = null;
          if (action === "markAssist" && offer) {
            if (policy.locked("assistModels") || policy.locked("toolModels")) { view.error = "Your organization sets which models are Assist models."; changed(); return; }
            const kinds = { toolModels: String(config.get("toolModels", "") || ""), assistModels: (config.get("assistModels", []) || []).map(String) };
            await save("assistModels", withAssist(view.models.map((/** @type {any} */ m) => m.id), kinds, offer.model));
            view.models = view.models.map((/** @type {any} */ m) => m.id === offer.model ? { ...m, assist: true } : m);
          }
          go(after("model"));
          return;
        }
        const model = String(message.model || "").trim();
        if (!model) { view.error = "Choose a model, or type its id."; changed(); return; }
        view.model = model;
        await save("model", model);
        // A model listed as a Tool model is asked to call a tool, once: one served without tool calling answers in
        // prose, and would look as if Solder didn't work. Then you're offered to mark it as an Assist model. A model
        // you typed, or one already marked as an Assist model, isn't tested; nor is anything when the test can't run.
        const listed = view.models.find((/** @type {any} */ m) => m.id === model);
        const allowed = modelAllowed();
        if (listed && !listed.assist && !policy.locked("assistModels") && !policy.locked("toolModels") && (!allowed || allowed(model))) {
          view.busy = true;
          view.error = "";
          changed();
          let calls = true;
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), CHECK_MS);
            try {
              policy.gate();
              const endpoint = String(config.get("endpoint", "") || view.endpoint);
              const client = new GatewayClient({ endpoint, apiKey: await this.key.get(endpoint) });
              calls = (await this.probe(client, model, controller.signal)).calls;
            } finally { clearTimeout(timer); }
          } catch { calls = true; } // couldn't tell: as it was
          view.busy = false;
          if (!current()) return; // setup closed, restarted or taken Back meanwhile
          if (!calls) { view.assistOffer = { model, name: listed.name }; changed(); return; }
        }
        go(after("model"));
        return;
      }
      case "docs": {
        if (action === "addDocs") {
          const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: true,
            openLabel: "Use as docs", title: "Solder: folders of your own reference docs" });
          for (const uri of picked || []) {
            if (!view.docs.some((/** @type {any} */ d) => d.path.toLowerCase() === uri.fsPath.toLowerCase())) view.docs.push({ path: uri.fsPath, about: "" });
          }
          changed();
          return;
        }
        if (action === "removeDocs") { view.docs.splice(Number(message.index), 1); changed(); return; }
        const abouts = Array.isArray(message.abouts) ? message.abouts : [];
        view.docs = view.docs.map((/** @type {any} */ d, /** @type {number} */ i) => ({ path: d.path, about: String(abouts[i] ?? d.about ?? "").trim() }));
        await save("docsFolders", view.docs.map((/** @type {any} */ d) => d.about ? { path: d.path, about: d.about } : d.path));
        go(after("docs"));
        return;
      }
      case "rules": {
        view.rules = String(message.rules ?? "").trim();
        await save("rules", view.rules);
        go(after("rules"));
        return;
      }
      case "changes": {
        // Enable tools turns read-only mode off for good; Keep read-only leaves it as it is.
        if (action === "allowChanges") await allowChanges();
        view.readOnly = readOnly();
        go(after("changes"));
        return;
      }
    }
  }
}

/** The setup steps, less those the organisation sets (a gateway it enforces needs no asking). */
function stepsNow() {
  return STEPS.filter((step) => !(step === "endpoint" && policy.locked("endpoint")) && !(step === "model" && policy.locked("model"))
    && !(step === "docs" && policy.locked("docsFolders")) && !(step === "rules" && policy.locked("rules"))
    // Asked only while Solder is read-only and the organization leaves it to you.
    && !(step === "changes" && (policy.locked("readOnly") || !readOnly())));
}

/** @param {string} endpoint */
function isLocal(endpoint) {
  try { return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(endpoint).hostname); } catch { return false; }
}

/** @param {any} raw @returns {{path: string, about: string}[]} */
function docsFrom(raw) {
  return (Array.isArray(raw) ? raw : []).map((item) => typeof item === "string" ? { path: item, about: "" }
    : { path: String(item?.path ?? ""), about: String(item?.about ?? "") }).filter((d) => d.path);
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = { SetupWizard, STEPS };
