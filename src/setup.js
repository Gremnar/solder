// @ts-check
"use strict";
/**
 * Guided setup in the side bar: the gateway's address, the API key (checked by listing the models), the
 * default model, docs folders and your own rules. Everything lands where the settings page and
 * "Set API key" would put it: user settings, and VS Code's secret storage for the key.
 */
const vscode = require("vscode");
const { config: solderSettings, policy } = require("./config.js");
const { GatewayClient, GatewayError } = require("./gateway.js");

const STEPS = ["endpoint", "key", "model", "docs", "rules", "done"];
const CHECK_MS = 30_000;

class SetupWizard {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {string} keyName the secret's name
   * @param {() => void} changed called whenever what the panel shows changes
   * @param {{skills?: () => number}} [hooks] skills: how many skills the model is offered (for the summary)
   */
  constructor(context, keyName, changed, hooks = {}) {
    this.context = context;
    this.keyName = keyName;
    this.changed = changed;
    this.hooks = hooks;
    /** @type {any} what the panel shows, or null when setup isn't running */
    this.view = null;
  }

  /** Whether Solder still needs setting up: no endpoint, or a remote one with no key. */
  async needed() {
    const endpoint = String(solderSettings().get("endpoint", "")).trim();
    if (!endpoint) return true;
    const key = (await this.context.secrets.get(this.keyName)) ?? "";
    return !key && !isLocal(endpoint);
  }

  /** Start (or restart) at the first step, with what's already set filled in. */
  async start() {
    const config = solderSettings();
    const key = (await this.context.secrets.get(this.keyName)) ?? "";
    this.view = {
      step: "", steps: stepsNow(), busy: false, error: "",
      endpoint: String(config.get("endpoint", "")), hasKey: !!key, models: [], model: String(config.get("model", "")),
      docs: docsFrom(config.own("docsFolders", [])), rules: String(config.get("rules", "")), skills: this.hooks.skills?.() ?? 0,
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
    const after = (/** @type {string} */ step) => view.steps[view.steps.indexOf(step) + 1] || "done";
    const config = solderSettings();
    const save = (/** @type {string} */ name, /** @type {any} */ value) => config.update(name, value, vscode.ConfigurationTarget.Global);
    switch (view.step) {
      case "endpoint": {
        const endpoint = String(message.endpoint || "").trim();
        try { new GatewayClient({ endpoint, apiKey: "" }); } catch (error) { view.error = messageOf(error); this.changed(); return; }
        view.endpoint = endpoint;
        await save("endpoint", endpoint);
        this.go(after("endpoint"));
        return;
      }
      case "key": {
        const typed = String(message.key || "").trim();
        if (action === "skipCheck") { view.models = []; this.go(after("key")); return; }
        if (typed) await this.context.secrets.store(this.keyName, typed);
        const key = typed || ((await this.context.secrets.get(this.keyName)) ?? "");
        view.hasKey = !!key;
        view.busy = true;
        view.error = "";
        this.changed();
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), CHECK_MS);
          let ids;
          policy.gate();
          try { ids = await new GatewayClient({ endpoint: String(config.get("endpoint", "") || view.endpoint), apiKey: key }).models(controller.signal); }
          finally { clearTimeout(timer); }
          const filter = String(config.get("modelFilter", ""));
          if (filter) { try { const pattern = new RegExp(filter, "i"); ids = ids.filter((id) => pattern.test(id)); } catch { /* shown in settings */ } }
          /** @type {Record<string, string>} */
          const names = config.get("modelNames", {}) || {};
          view.models = ids.map((id) => ({ id, name: names[id] || id }));
          if (!view.model || !ids.includes(view.model)) view.model = ids[0] || view.model;
          this.go(after("key"));
        } catch (error) {
          view.busy = false;
          view.error = error instanceof GatewayError && error.name === "Cancelled" ? "The gateway didn't answer within 30 seconds."
            : messageOf(error);
          this.changed();
        }
        return;
      }
      case "model": {
        const model = String(message.model || "").trim();
        if (!model) { view.error = "Choose a model, or type its id."; this.changed(); return; }
        view.model = model;
        await save("model", model);
        this.go(after("model"));
        return;
      }
      case "docs": {
        if (action === "addDocs") {
          const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: true,
            openLabel: "Use as docs", title: "Solder: folders of your own reference docs" });
          for (const uri of picked || []) {
            if (!view.docs.some((/** @type {any} */ d) => d.path.toLowerCase() === uri.fsPath.toLowerCase())) view.docs.push({ path: uri.fsPath, about: "" });
          }
          this.changed();
          return;
        }
        if (action === "removeDocs") { view.docs.splice(Number(message.index), 1); this.changed(); return; }
        const abouts = Array.isArray(message.abouts) ? message.abouts : [];
        view.docs = view.docs.map((/** @type {any} */ d, /** @type {number} */ i) => ({ path: d.path, about: String(abouts[i] ?? d.about ?? "").trim() }));
        await save("docsFolders", view.docs.map((/** @type {any} */ d) => d.about ? { path: d.path, about: d.about } : d.path));
        this.go(after("docs"));
        return;
      }
      case "rules": {
        view.rules = String(message.rules ?? "").trim();
        await save("rules", view.rules);
        this.go(after("rules"));
        return;
      }
    }
  }
}

/** The setup steps, less those the organisation sets (a gateway it enforces needs no asking). */
function stepsNow() {
  return STEPS.filter((step) => !(step === "endpoint" && policy.locked("endpoint")) && !(step === "model" && policy.locked("model"))
    && !(step === "docs" && policy.locked("docsFolders")) && !(step === "rules" && policy.locked("rules")));
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
