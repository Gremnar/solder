// @ts-check
"use strict";
/**
 * Settings inside the side bar: the same settings the VS Code settings page holds (user scope), plus the
 * API key (secret storage) and the docs index's state, so the everyday ones are a click away.
 */
const vscode = require("vscode");
const { config: solderSettings, policy } = require("./config.js");
const { GatewayClient } = require("./gateway.js");
const { MAX_SKILLS } = require("./skills.js");
const fs = require("node:fs");
const path = require("node:path");

class SettingsScreen {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {string} keyName the secret's name
   * @param {{models: () => {id: string, name: string}[], docs: () => any, refreshDocs: (ask?: boolean) => void, refreshModels: () => Promise<void>,
   *          skills: () => import("./skills.js").Skill[], skillsFolder?: () => string, policyChanged?: () => void,
   *          testEmbedding: (model: string) => Promise<{dims: number, tokens: number}>}} hooks
   * @param {() => void} changed called whenever what the panel shows changes
   */
  constructor(context, keyName, hooks, changed) {
    this.context = context;
    this.keyName = keyName;
    this.hooks = hooks;
    this.changed = changed;
    /** @type {any} what the panel shows, or null when it's closed */
    this.view = null;
    /** @type {any} */
    this.timer = null;
  }

  async open() {
    // Read the policy again; if it changed, the panel follows it too (its connection, models and docs).
    if (await policy.refresh().catch(() => false)) this.hooks.policyChanged?.();
    this.view = { open: true, notice: "", noticeKind: "", checking: false, saved: "", ...(await this.values()) };
    // While it's open, the docs index's progress keeps the screen current, and so do skills added or edited elsewhere.
    clearInterval(this.timer);
    this.timer = setInterval(async () => {
      if (!this.view) return;
      const docs = this.hooks.docs();
      if (JSON.stringify(docs) !== JSON.stringify(this.view.docsStatus)) { this.view.docsStatus = docs; this.changed(); }
      const skills = this.skills();
      if (JSON.stringify(skills) !== JSON.stringify(this.view.skills)) { this.view.skills = skills; this.changed(); }
    }, 1500);
    this.changed();
  }

  close() {
    clearInterval(this.timer);
    this.view = null;
    this.changed();
  }

  async values() {
    const config = solderSettings();
    // The user's own folders (the organisation's are shown apart, and can't be changed here).
    const raw = config.own("docsFolders", []);
    return {
      endpoint: String(config.get("endpoint", "")),
      hasKey: !!((await this.context.secrets.get(this.keyName)) ?? ""),
      model: String(config.get("model", "")),
      models: this.hooks.models(),
      effort: String(config.get("effort", "default")),
      rules: String(config.get("rules", "")),
      instructionFiles: (config.get("instructionFiles", ["AGENTS.md"]) || []).join(", "),
      docs: (Array.isArray(raw) ? raw : []).map((item) => typeof item === "string" ? { path: item, about: "" }
        : { path: String(item?.path ?? ""), about: String(item?.about ?? "") }).filter((d) => d.path),
      docsStatus: this.hooks.docs(),
      docsSearch: String(config.get("docsSearch", "keyword")) === "hybrid" ? "hybrid" : "keyword",
      embeddingModel: String(config.get("embeddingModel", "")),
      compactAt: Number(config.get("compactAtTokens", 100_000)),
      maxRounds: Number(config.get("maxRounds", 30)),
      modelFilter: String(config.get("modelFilter", "")),
      // What the organisation enforces: those fields are shown locked.
      locked: Object.fromEntries([["endpoint", "endpoint"], ["model", "model"], ["effort", "effort"], ["rules", "rules"], ["instructionFiles", "instructionFiles"],
        ["compactAt", "compactAtTokens"], ["maxRounds", "maxRounds"], ["docsSearch", "docsSearch"], ["embeddingModel", "embeddingModel"], ["modelFilter", "modelFilter"]]
        .map(([field, name]) => [field, policy.locked(name)])),
      orgDocs: policy.orgDocs(), docsLocked: policy.locked("docsFolders"), orgRules: policy.orgRules, policyError: policy.error,
      skillsFolders: (config.own("skillsFolders", []) || []).map((/** @type {any} */ item) => String(typeof item === "string" ? item : item?.path ?? "")).filter(Boolean),
      orgSkills: policy.orgSkills(), skillsLocked: policy.locked("skillsFolders"), skills: this.skills(), skillsOffered: MAX_SKILLS,
    };
  }

  /**
   * The skills found, for the screen: name, when, any problem, whether it's the organisation's, and whether the model is
   * offered it (as the prompt does: those with instructions, up to MAX_SKILLS).
   */
  skills() {
    const org = policy.orgSkills().map((folder) => path.resolve(folder).toLowerCase());
    let offered = 0;
    return this.hooks.skills().map((skill) => ({ name: skill.name, when: skill.when, problem: skill.problem, cut: skill.cut,
      org: org.includes(path.dirname(skill.path).toLowerCase()), offered: !!skill.text && ++offered <= MAX_SKILLS }));
  }

  /** @param {string} text @param {"ok" | "bad" | ""} [kind] */
  notice(text, kind = "") {
    if (!this.view) return;
    this.view.notice = text;
    this.view.noticeKind = kind;
    this.changed();
  }

  /** A message from the settings screen. @param {any} message */
  async handle(message) {
    if (!this.view) return;
    const action = String(message.action || "");
    const config = solderSettings();
    const save = async (/** @type {string} */ name, /** @type {any} */ value, /** @type {string} */ field) => {
      await config.update(name, value, vscode.ConfigurationTarget.Global);
      Object.assign(this.view, await this.values(), { saved: field, notice: "", noticeKind: "" });
      this.changed();
    };
    switch (action) {
      case "close": this.close(); return;
      case "vscodeSettings": await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:gremnar.solder"); return;
      case "set": {
        const field = String(message.field || "");
        const value = message.value;
        if (this.view.locked?.[field]) { this.notice("Your organization sets this.", "bad"); return; }
        if (field === "endpoint") {
          const endpoint = String(value || "").trim();
          if (endpoint) { try { new GatewayClient({ endpoint, apiKey: "" }); } catch (error) { this.notice(messageOf(error), "bad"); return; } }
          await save("endpoint", endpoint, field);
        } else if (field === "model") await save("model", String(value || "").trim(), field);
        else if (field === "effort" && ["default", "low", "medium", "high"].includes(value)) await save("effort", value, field);
        else if (field === "rules") await save("rules", String(value ?? "").trim(), field);
        else if (field === "instructionFiles") {
          await save("instructionFiles", String(value || "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean), field);
        } else if (field === "compactAt") {
          const n = Math.round(Number(value));
          if (!Number.isFinite(n) || n < 30_000) { this.notice("Compact at needs to be 30,000 tokens or more.", "bad"); return; }
          await save("compactAtTokens", n, field);
        } else if (field === "maxRounds") {
          const n = Math.round(Number(value));
          if (!Number.isFinite(n) || n < 1 || n > 100) { this.notice("Max rounds needs to be between 1 and 100.", "bad"); return; }
          await save("maxRounds", n, field);
        } else if (field === "docsSearch" && ["keyword", "hybrid"].includes(value)) await save("docsSearch", value, field);
        else if (field === "embeddingModel") await save("embeddingModel", String(value || "").trim(), field);
        else if (field === "modelFilter") {
          const text = String(value || "").trim();
          try { if (text) new RegExp(text); } catch { this.notice("That model filter isn't a valid regular expression.", "bad"); return; }
          await save("modelFilter", text, field);
        }
        return;
      }
      case "key": {
        const key = String(message.key || "").trim();
        if (key) await this.context.secrets.store(this.keyName, key);
        else await this.context.secrets.delete(this.keyName);
        Object.assign(this.view, await this.values(), { saved: "key" });
        this.notice(key ? "Key saved." : "Key removed.", "ok");
        await this.hooks.refreshModels();
        return;
      }
      case "check": {
        this.view.checking = true;
        this.notice("Checking…");
        try {
          const key = (await this.context.secrets.get(this.keyName)) ?? "";
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 30_000);
          let ids;
          policy.gate();
          try { ids = await new GatewayClient({ endpoint: String(config.get("endpoint", "")), apiKey: key }).models(controller.signal); }
          finally { clearTimeout(timer); }
          this.view.checking = false;
          this.notice(`Connected: the gateway lists ${ids.length} model${ids.length === 1 ? "" : "s"}.`, "ok");
          await this.hooks.refreshModels();
          Object.assign(this.view, { models: this.hooks.models() });
          this.changed();
        } catch (error) {
          this.view.checking = false;
          this.notice(messageOf(error), "bad");
        }
        return;
      }
      case "addDocs": {
        if (this.view.docsLocked) { this.notice("Your organization sets the docs folders.", "bad"); return; }
        const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: true,
          openLabel: "Use as docs", title: "Solder: folders of your own reference docs" });
        if (!picked?.length) return;
        const docs = this.view.docs.slice();
        for (const uri of picked) if (!docs.some((d) => d.path.toLowerCase() === uri.fsPath.toLowerCase())) docs.push({ path: uri.fsPath, about: "" });
        await save("docsFolders", stored(docs), "docs");
        return;
      }
      case "removeDocs": {
        const docs = this.view.docs.slice();
        docs.splice(Number(message.index), 1);
        await save("docsFolders", stored(docs), "docs");
        return;
      }
      case "docsAbout": {
        const docs = this.view.docs.slice();
        const index = Number(message.index);
        if (!docs[index]) return;
        docs[index] = { ...docs[index], about: String(message.value || "").trim() };
        await save("docsFolders", stored(docs), "docs-" + index);
        return;
      }
      case "addSkills": {
        if (this.view.skillsLocked) { this.notice("Your organization sets the skills folders.", "bad"); return; }
        const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: true,
          openLabel: "Use for skills", title: "Solder: folders of your skills (one .md file each)" });
        if (!picked?.length) return;
        const folders = this.view.skillsFolders.slice();
        for (const uri of picked) if (!folders.some((/** @type {string} */ f) => f.toLowerCase() === uri.fsPath.toLowerCase())) folders.push(uri.fsPath);
        await save("skillsFolders", folders, "skills");
        return;
      }
      case "removeSkills": {
        const folders = this.view.skillsFolders.slice();
        folders.splice(Number(message.index), 1);
        await save("skillsFolders", folders, "skills");
        return;
      }
      case "openSkill": {
        const skill = this.hooks.skills().find((s) => s.name === String(message.name || ""));
        if (skill) await vscode.window.showTextDocument(vscode.Uri.file(skill.path), { preview: false });
        return;
      }
      case "newSkill": {
        const folder = this.hooks.skillsFolder?.() ?? "";
        if (!folder) { this.notice(this.view.skillsLocked ? "Your organization sets the skills folders." : "Add a skills folder first.", "bad"); return; }
        const name = await vscode.window.showInputBox({ title: "Solder: a new skill", prompt: `Its name, which is its file's name in ${folder}`,
          placeHolder: "python_scripts", validateInput: (text) => skillNameProblem(text, folder) });
        if (!name) return;
        const file = path.join(folder, name.trim() + ".md");
        try { fs.writeFileSync(file, "When to use: \n\n", { flag: "wx" }); } catch (error) { this.notice(`The skill couldn't be made: ${messageOf(error)}`, "bad"); return; }
        const editor = await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
        // The cursor goes where the sentence on when to use it is written.
        const end = new vscode.Position(0, "When to use: ".length);
        editor.selection = new vscode.Selection(end, end);
        Object.assign(this.view, { skills: this.skills() });
        this.changed();
        return;
      }
      case "reindex": this.hooks.refreshDocs(true); this.notice("Indexing the docs folders in the background.", "ok"); return;
      case "testEmbedding": {
        const model = String(solderSettings().get("embeddingModel", "")).trim();
        if (!model) { this.notice("Type the embeddings model's id first.", "bad"); return; }
        this.notice("Testing the embeddings model…");
        try {
          const { dims, tokens } = await this.hooks.testEmbedding(model);
          this.notice(`It works: ${dims.toLocaleString("en-US")} numbers for each passage${tokens ? `, ${tokens} tokens for that test` : ""}.`, "ok");
        } catch (error) {
          this.notice(messageOf(error), "bad");
        }
        return;
      }
    }
  }
}

/** Why a new skill's name won't do, or null. @param {string} text @param {string} folder */
function skillNameProblem(text, folder) {
  const name = String(text || "").trim();
  if (!name) return "Give it a name.";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/.test(name)) return "Letters, digits, - and _ only, like python_scripts.";
  if (fs.existsSync(path.join(folder, name + ".md"))) return "There's already a skill with that name.";
  return null;
}

/** @param {{path: string, about: string}[]} docs */
function stored(docs) {
  return docs.map((d) => d.about ? { path: d.path, about: d.about } : d.path);
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = { SettingsScreen };
