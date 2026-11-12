// @ts-check
"use strict";
/**
 * The chat panel: a webview in Solder's side bar view, and the controller behind it. The webview holds
 * no truth: it renders the state posted here (rebuilt from the saved chat) plus streamed text.
 */
const vscode = require("vscode");
const { config: solderSettings, policy } = require("./config.js");
const { laneOf, assistTwin } = require("./lanes.js");
const fs = require("node:fs");
const path = require("node:path");
const { Engine, labelOf, parseArguments, tokenReport } = require("./engine.js");
const { GatewayClient, GatewayError } = require("./gateway.js");
const { systemPrompt, toolDefinitions, STARTERS, SELECTION, SKILL, CONTEXT } = require("./prompt.js");
const { ChatStore, adoptChats } = require("./store.js");
const { WorkspaceTools, plainNames } = require("./tools.js");
const { SetupWizard } = require("./setup.js");
const { SettingsScreen } = require("./settings.js");
const { Log } = require("./log.js");
const { MAX_SKILLS, offered } = require("./skills.js");
const os = require("node:os");

const MODEL_FILTER_BROKEN = "Your organization's model filter isn't a valid pattern, so no model can be offered. Ask your IT team.";

/**
 * Which models a request may use: any, unless your organization enforces a model filter, when only those it matches
 * (none, if the filter won't read). null when there's no such rule.
 * @returns {((id: string) => boolean) | null}
 */
function modelAllowed() {
  if (!policy.locked("modelFilter")) return null;
  const filter = String(solderSettings().get("modelFilter", "") || "");
  if (!filter) return null;
  try { const pattern = new RegExp(filter, "i"); return (id) => pattern.test(id); } catch { return () => false; }
}

/**
 * Where your skills go when you haven't chosen a folder: %APPDATA%\Solder\skills on Windows (it roams with your
 * profile), ~/.solder/skills elsewhere. The guided setup makes it.
 */
const DEFAULT_SKILLS = () => process.env.APPDATA ? path.join(process.env.APPDATA, "Solder", "skills") : path.join(os.homedir(), ".solder", "skills");

/** A skill's file name from what was typed: lowercase words joined by underscores, .md. @param {string} text */
function skillFileName(text) {
  return String(text).trim().toLowerCase().replace(/\s+/g, "_") + ".md";
}

/** Why a new skill's name won't do, or null. @param {string} text @param {string} folder */
function skillNameProblem(text, folder) {
  const name = skillFileName(text).slice(0, -3);
  if (!name) return "Give it a name.";
  if (!/^[a-z0-9][a-z0-9_-]{0,59}$/.test(name)) return "Letters, digits, spaces, - and _ only (up to 60), like powershell scripts.";
  if (fs.existsSync(path.join(folder, name + ".md"))) return "There's already a skill with that name.";
  return null;
}

const KEY = "solder.apiKey";
const MAX_SELECTION_CHARS = 12_000;
const SHOWN_OUTPUT_CHARS = 6_000;

/** How often the organisation's policy is read again. */
const POLICY_MS = 30 * 60_000;

class SolderPanel {
  /** @param {vscode.ExtensionContext} context */
  /** @param {vscode.ExtensionContext} context @param {{appendLine: (line: string) => void}} [channel] */
  constructor(context, channel = { appendLine() {} }) {
    this.context = context;
    this.log = new Log(channel);
    this.tools = new WorkspaceTools(context);
    // Chats live in the global storage, each with its home folder: a window shows its folders' chats.
    this.store = new ChatStore(context.globalStorageUri.fsPath, { homes: () => this.tools.roots(),
      homeOf: (/** @type {any} */ chat) => (chat.folder && path.isAbsolute(chat.folder) && this.tools.rootOf(chat.folder)) || this.tools.root() });
    if (context.storageUri) {
      try { adoptChats(context.storageUri.fsPath, this.store, this.tools.root()); } catch { /* the old ones stay where they were */ }
    }
    /** @type {vscode.WebviewView | null} */
    this.view = null;
    /** @type {any} */
    this.chat = Engine.newChat();
    /** @type {{id: string, name: string}[]} */
    this.models = [];
    this.modelsProblem = "";
    this.live = "";        // the answer streaming in
    this.status = "";      // "Thinking…", "Retrying…"
    this.running = "";     // the call that's running
    this.runningSince = 0; // when it started
    /** @type {any[]} */
    this.approvals = [];
    /** @type {any} */
    this.error = null;
    this.errorChat = "";   // the chat the error is about
    this.runId = "";       // the chat a task runs (or last ran) in: the state above is its
    /** @type {any} */
    this.runChat = null;
    this.awayDone = "";    // a task that finished while another chat was open
    /** @type {any} */
    this.credits = null;
    this.answerTokens = 0;
    this.setup = new SetupWizard(context, KEY, () => this.post(), { skills: () => this.tools.skills().filter(offered).length,
      // Your skills folder, ready (and in the setting) once setup is done, so New skill and /skill need no folder picking.
      skillsHome: async () => {
        if (policy.locked("skillsFolders") || this.skillsFolder()) return;
        try { fs.mkdirSync(DEFAULT_SKILLS(), { recursive: true }); await this.addSkillsFolder(DEFAULT_SKILLS()); } catch { /* made later, when it's needed */ }
      } });
    // Docs search by meaning: embeddings from the same gateway, and what they cost in the log.
    this.tools.embedder = (/** @type {string} */ model, /** @type {string[]} */ input, /** @type {AbortSignal | undefined} */ signal) =>
      this.client().embed({ model, input, signal });
    this.tools.onDocsLog = (/** @type {string} */ line) => this.log.write(line);
    this.settingsScreen = new SettingsScreen(context, KEY, { models: () => this.models, docs: () => this.tools.docsState(),
      skills: () => this.tools.skills(), skillsHome: () => this.skillsFolder() || DEFAULT_SKILLS(), newSkill: () => this.newSkill(), createSkill: (/** @type {string} */ name, /** @type {string} */ when) => this.createSkill(name, when),
      deleteSkill: (/** @type {string} */ name) => this.deleteSkill(name), orgSkillsFolders: () => this.tools.skillsFolders(policy.orgSkills()),
      policyChanged: () => { this.policyChanged(); },
      testEmbedding: async (/** @type {string} */ model) => {
        const { vectors, tokens } = await this.client().embed({ model, input: ["A test passage from Solder's settings."], signal: AbortSignal.timeout(30_000) });
        return { dims: vectors[0].length, tokens };
      },
      refreshDocs: (/** @type {boolean} */ ask) => { if (ask) this.tools.embedDeclinedAt = 0; this.tools.refreshDocs(); }, refreshModels: () => this.refreshModels() }, () => this.post());
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBar.command = "solder.focus";
    context.subscriptions.push(this.statusBar);
    this.engine = new Engine({ client: { reply: (/** @type {any} */ request) => this.client().reply(request) },
      host: this.host(), settings: () => this.settings(), onEvent: (event) => this.onEvent(event) });
    const last = this.store.list().find((c) => !c.archived);
    if (last) this.chat = this.store.load(last.id) ?? this.chat;
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.postEditor()),
      vscode.window.onDidChangeTextEditorSelection(() => this.postEditor()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("solder")) { this._client = null; this.refreshModels(); }
        if (event.affectsConfiguration("solder.docsFolders") || event.affectsConfiguration("solder.docsSearch")
          || event.affectsConfiguration("solder.embeddingModel")) this.tools.refreshDocs();
      }),
    );
    // The organisation's policy, read again every so often (Group Policy refreshes about every 90 minutes).
    const reread = setInterval(() => policy.refresh().then((changed) => { if (changed) this.policyChanged(); }, () => {}), POLICY_MS);
    context.subscriptions.push({ dispose: () => clearInterval(reread) });
    // Old backups are pruned to the storage limit a little after start, and after new ones.
    const prune = setTimeout(() => { try { this.tools.pruneBackups(); } catch { /* best effort */ } }, 30_000);
    context.subscriptions.push({ dispose: () => clearTimeout(prune) });
    // The docs index catches up in the background, a little after start (it's only read when searched).
    const timer = setTimeout(() => this.tools.refreshDocs(), 15_000);
    context.subscriptions.push({ dispose: () => clearTimeout(timer) });
    this.updateStatusBar();
  }

  /** @param {vscode.WebviewView} view */
  resolveWebviewView(view) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((message) => this.onMessage(message).catch((error) =>
      vscode.window.showErrorMessage(`Solder: ${error instanceof Error ? error.message : error}`)));
    view.onDidChangeVisibility(() => { if (view.visible) this.post(); });
    this.refreshModels();
  }

  // ------------------------------------------------------------------ the host --

  host() {
    return {
      systemPrompt: async () => systemPrompt(this.promptContext()),
      // The same facts, for an Assist model's introduction (which says them in its own words).
      assistContext: async () => this.promptContext(),
      runTool: (/** @type {string} */ name, /** @type {any} */ args, /** @type {any} */ ctx) => this.tools.run(name, args, ctx),
      settleEdits: (/** @type {string} */ group) => this.tools.settleEdits(group),
      needsApproval: (/** @type {string} */ name, /** @type {any} */ args) => this.tools.needsApproval(name, args),
      save: (/** @type {any} */ chat) => this.store.save(chat),
    };
  }

  /** What the model is told about the workspace, for either lane: folders, instruction files, rules, docs, skills. */
  promptContext() {
    return { workspace: this.tools.root(), folders: this.tools.roots(), instructions: this.instructions(),
      // The organisation's rules go after the user's, so they read as the more recent instruction.
      rules: [String(solderSettings().get("rules", "") || "").trim(), policy.orgRules].filter(Boolean).join("\n\n"), docs: this.tools.docsFolders(),
      skills: this.tools.skills().filter(offered).slice(0, MAX_SKILLS).map(({ name, path: file, when }) => ({ name, path: file, when })),
      skillsFolder: this.skillsFolder() };
  }

  /** Where a new skill is saved: the user's own first skills folder that's there ("" when they have none, or can't add one). */
  skillsFolder() {
    if (policy.locked("skillsFolders")) return "";
    return this.tools.skillsFolders(solderSettings().own("skillsFolders", []))[0] ?? "";
  }

  /** The user's own skills folders, as the setting holds them. @returns {string[]} */
  ownSkillsFolders() {
    const own = solderSettings().own("skillsFolders", []);
    return (Array.isArray(own) ? own : []).map((/** @type {any} */ item) => String(typeof item === "string" ? item : item?.path ?? "").trim()).filter(Boolean);
  }

  /** Add a folder to the user's skills folders (once). @param {string} folder @returns {Promise<boolean>} whether it could be */
  async addSkillsFolder(folder) {
    if (policy.locked("skillsFolders")) { vscode.window.showInformationMessage("Your organization sets Solder's skills folders."); return false; }
    const own = this.ownSkillsFolders();
    if (!own.some((item) => path.resolve(item).toLowerCase() === path.resolve(folder).toLowerCase())) {
      await solderSettings().update("skillsFolders", [...own, folder], vscode.ConfigurationTarget.Global);
    }
    return true;
  }

  /** New skill, from the command palette or /skill: Settings opens at the Skills tab, with the form to fill in. */
  async newSkill() {
    if (policy.locked("skillsFolders")) { vscode.window.showInformationMessage("Your organization sets Solder's skills, so you can't add your own."); return ""; }
    await vscode.commands.executeCommand("solder.chat.focus");
    await this.settingsScreen.open("skills", { skillForm: true });
    return "";
  }

  /**
   * Make a skill from Settings' form: its name and when to use it, saved in your first skills folder (the default one,
   * made if you have none), then opened to write the instructions. A problem comes back as a sentence, nothing made.
   * @param {string} name @param {string} when @returns {Promise<{file: string} | {problem: string}>}
   */
  async createSkill(name, when) {
    if (policy.locked("skillsFolders")) return { problem: "Your organization sets the skills, so you can't add your own." };
    const folder = this.skillsFolder() || DEFAULT_SKILLS();
    const problem = skillNameProblem(name, folder);
    if (problem) return { problem };
    const sentence = String(when || "").replace(/\s+/g, " ").trim();
    if (!sentence) return { problem: "Say when the model should use it: it's all the model sees until it reads the skill." };
    const file = path.join(folder, skillFileName(name));
    try {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(file, `When to use: ${sentence}\n\n`, { flag: "wx" });
    } catch (error) {
      return { problem: `The skill couldn't be made (${/** @type {any} */ (error)?.code || error}).` };
    }
    if (!(await this.addSkillsFolder(folder))) return { problem: "Your organization sets the skills folders." };
    // Open, with the cursor where the instructions go.
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
    const end = new vscode.Position(editor.document.lineCount - 1, 0);
    editor.selection = new vscode.Selection(end, end);
    return { file };
  }

  /** Delete one of the user's own skills (to the recycle bin), after asking. @param {string} name */
  async deleteSkill(name) {
    const skill = this.tools.skills().find((item) => item.name === name);
    if (!skill) return false;
    // The organization's folders as the listing has them (~ expanded, resolved), so the check can't be dodged.
    const org = this.tools.skillsFolders(policy.orgSkills()).some((folder) => folder.toLowerCase() === path.dirname(skill.path).toLowerCase());
    if (org) { vscode.window.showInformationMessage("That skill comes from your organization."); return false; }
    const pick = await vscode.window.showWarningMessage(`Delete the skill ${skill.name}?`, { modal: true, detail: `${skill.path} goes to the recycle bin.` }, "Delete");
    if (pick !== "Delete") return false;
    try { await vscode.workspace.fs.delete(vscode.Uri.file(skill.path), { useTrash: true }); }
    catch { await vscode.workspace.fs.delete(vscode.Uri.file(skill.path), { useTrash: false }); } // no recycle bin there (a share)
    return true;
  }

  /** The instruction files (AGENTS.md by default) at the top of each workspace folder. */
  instructions() {
    const roots = this.tools.roots();
    const names = plainNames(solderSettings().get("instructionFiles", ["AGENTS.md"]));
    const found = [];
    for (const root of roots) {
      for (const name of names) {
        try {
          const text = fs.readFileSync(path.join(root, name), "utf8").slice(0, 40_000);
          // With several folders, each is named by its folder, so the model knows which one it's for.
          if (text.trim()) found.push({ path: roots.length > 1 ? `${path.basename(root)}/${name}` : name, text });
        } catch { /* not there */ }
      }
    }
    return found;
  }

  settings() {
    const config = solderSettings();
    return { model: config.get("model", ""), effort: config.get("effort", "default"), modelLocked: policy.locked("model"), effortLocked: policy.locked("effort"),
      compactAt: Math.max(30_000, config.get("compactAtTokens", 100_000)), maxRounds: Math.max(1, config.get("maxRounds", 30)),
      toolModels: String(config.get("toolModels", "") || ""), assistModels: (config.get("assistModels", []) || []).map(String), assistSessionBlock: String(config.get("assistSessionBlock", "") || ""),
      modelAllowed: modelAllowed() };
  }

  /**
   * When the Tool models' allowance runs out: the chat's model's Assist twin to switch to (it doesn't use the
   * allowance), if it's on offer and the model isn't locked by policy. null otherwise.
   * @param {any} event the error event @returns {{model: string, name: string} | null}
   */
  switchOffer(event) {
    if (!event.exhausted) return null;
    const settings = this.settings();
    if (settings.modelLocked) return null;
    const chat = event.chat === this.chat.id ? this.chat : this.runChat;
    const twin = assistTwin(String(chat?.model || settings.model || ""), settings, this.models.map((m) => m.id));
    return twin ? { model: twin, name: this.models.find((m) => m.id === twin)?.name || twin } : null;
  }

  /** The organisation's policy changed: the client, the models, the docs folders and what's shown follow it. */
  async policyChanged() {
    this._client = null;
    this.tools.refreshDocs();
    await this.refreshModels();
    this.post();
  }

  /** @type {GatewayClient | null} */
  _client = null;
  client() {
    // Fail closed: while the organisation's policy can't be read, nothing is sent (a client made before included).
    policy.gate();
    if (!this._client) {
      const config = solderSettings();
      this._client = new GatewayClient({ endpoint: config.get("endpoint", ""), apiKey: this._key ?? "" });
    }
    return this._client;
  }

  /** @type {string | undefined} */
  _key = undefined;
  async loadKey() {
    this._key = (await this.context.secrets.get(KEY)) ?? "";
    this._client = null;
  }

  async refreshModels() {
    this.modelsProblem = "";
    try {
      await this.loadKey();
      const config = solderSettings();
      if (!config.get("endpoint", "")) { this.models = []; this.modelsProblem = "setup"; this.post(); return; }
      let ids = await this.client().models();
      const filter = config.get("modelFilter", "");
      if (filter) {
        try { const pattern = new RegExp(filter, "i"); ids = ids.filter((id) => pattern.test(id)); }
        catch {
          // Your own filter that won't read is shown in Settings; your organization's offers nothing (it fails closed).
          if (policy.locked("modelFilter")) { this.models = []; this.modelsProblem = MODEL_FILTER_BROKEN; this.post(); return; }
        }
      }
      /** @type {Record<string, string>} */
      const names = config.get("modelNames", {});
      this.models = ids.map((id) => ({ id, name: names[id] || id }));
    } catch (error) {
      this.models = [];
      this.modelsProblem = error instanceof GatewayError ? error.message : "Couldn't list the models.";
    }
    this.post();
  }

  // ------------------------------------------------------------- engine events --

  /** @param {any} event */
  onEvent(event) {
    this.log.event(event);
    if (event.type === "busy" && event.busy) {
      // The task's chat: its state below is that chat's, shown only while it's the one open.
      this.runId = event.chat;
      this.runChat = event.chat === this.chat.id ? this.chat : (this.store.load(event.chat) ?? this.chat);
      this.awayDone = "";
    }
    if (event.chat !== this.runId) { this.post(); return; }
    switch (event.type) {
      case "delta": this.live += event.text; this.status = ""; if (this.chat.id === this.runId) this.postLive(); return;
      case "thinking": this.status = "Thinking…"; this.running = ""; break;
      case "drafting": this.status = draftingLabel(event.calls); break;
      case "retrying": this.live = ""; this.status = event.why === "empty" ? "The reply came back empty; asking again…" : "Connection trouble; trying again…"; break;
      case "compacting": this.status = "Summarising the older part of this chat to save tokens…"; break;
      case "compaction-failed": this.status = "Couldn't summarise the older part of this chat; sending it as it is."; this.compactProblem = event.message || ""; break;
      case "message": this.live = ""; this.running = ""; this.status = ""; break;
      case "running": this.running = event.id; this.runningSince = Date.now(); this.status = ""; break;
      case "titled": break; // the new title goes out with the state below
      case "approval":
        this.approvals.push(event);
        if (this.chat.id !== this.runId) {
          // You're reading another chat: a banner there, and a notification (the task waits for you).
          vscode.window.showInformationMessage(`Solder is waiting for your approval in "${this.runChat?.title ?? "another chat"}".`, "Go back")
            .then((pick) => { if (pick) this.onMessage({ type: "open", id: event.chat }); });
        }
        break;
      case "approval-done": this.approvals = this.approvals.filter((a) => a.id !== event.id); break;
      case "usage": this.answerTokens = event.answer; this.credits = event.credits || this.credits; this.updateStatusBar(); break;
      case "busy":
        if (event.busy) { this.error = null; this.answerTokens = 0; } else {
          this.status = ""; this.live = ""; this.running = ""; this.approvals = [];
          if (this.chat.id !== this.runId) this.awayDone = this.runId; // finished while you were reading another chat
        }
        break;
      case "error": this.error = { message: event.message, resumable: event.resumable, exhausted: event.exhausted, switchTo: this.switchOffer(event) }; this.errorChat = event.chat;
        if (event.credits) { this.credits = event.credits; this.updateStatusBar(); } // a used-up allowance shows as 0 left
        break;
      case "stopped": this.error = { message: "Stopped.", resumable: true, stopped: true }; this.errorChat = event.chat; break;
      // The step limit is a pause Solder chose, not a failure: Continue or Stop here.
      case "done": if (event.limit) { this.error = { message: `Paused after ${event.limit} steps, the limit for one message. The work so far is saved.`, resumable: true, paused: true }; this.errorChat = event.chat; } break;
      case "steer-unsent":
        // Typed while it worked but never delivered: the next message (after a Stop, back into the box instead).
        if (event.send) { setImmediate(() => this.sendQueued(event)); return; }
        this.post();
        if (this.chat.id === this.runId) this.view?.webview.postMessage({ type: "restore", text: event.text });
        return;
    }
    this.post();
  }

  // ------------------------------------------------------------ panel messages --

  /** @param {any} message */
  async onMessage(message) {
    switch (message.type) {
      case "ready": this.post(); this.postEditor(); return;
      case "send": return this.send(message);
      case "starter": return this.start(String(message.id || ""));
      case "command": return this.command(String(message.name || ""), String(message.arg || "").trim());
      case "chatAction": return this.chatAction(String(message.action || ""), String(message.id || ""));
      case "stop": this.engine.stop(); return;
      case "switch-and-resume": {
        // The allowance ran out: this chat (not the default) moves to the Assist twin, which doesn't use it, and carries on.
        if (this.engine.busy || policy.locked("model")) return;
        const target = String(message.model || "");
        if (!this.models.some((m) => m.id === target)) return;
        this.chat.model = target;
        await this.store.save(this.chat);
        this.error = null; this.tools.useFolder(this.chat.folder); this.engine.resume(this.chat); return;
      }
      case "dismiss": this.error = null; this.post(); return;
      case "resume":
        if (this.engine.busy) { vscode.window.showInformationMessage(`Solder is working in "${this.runChat?.title ?? "another chat"}". Resume this one when it's done.`); return; }
        this.error = null; this.tools.useFolder(this.chat.folder); this.engine.resume(this.chat); return;
      case "decide": this.engine.decide(message.id, { decision: message.decision, note: message.note }); return;
      case "unsteer": {
        // Taken back before it went: back into the box, to change or send later.
        const text = this.engine.unsteer(Number(message.index));
        this.post();
        if (text) this.view?.webview.postMessage({ type: "restore", text });
        return;
      }
      case "rename": {
        if (this.chat.title === "New chat" && !this.chat.messages.length) return;
        const title = await vscode.window.showInputBox({ title: "Rename this chat", value: this.chat.title,
          validateInput: (value) => value.trim() ? null : "A chat needs a name." });
        if (!title?.trim()) return;
        this.chat.title = title.trim().slice(0, 120);
        this.chat.titleSource = "user"; // never renamed automatically again
        await this.store.save(this.chat);
        this.post();
        return;
      }
      case "new":
        if (!this.engine.busy) {
          this.awayDone = "";
          const folder = this.chat.folder || "";
          this.chat = Engine.newChat();
          if (folder) this.chat.folder = folder; // a new chat keeps working where you were
          this.error = null;
          this.post();
        }
        return;
      case "open": {
        // While a task runs, any chat can be read; the task's own state shows again when you go back to it.
        const chat = message.id === this.runId && this.runChat ? this.runChat : this.store.load(message.id);
        if (!chat) return;
        this.chat = chat;
        if (chat.id === this.awayDone) this.awayDone = "";
        this.post();
        if (this.engine.busy && chat.id === this.runId && this.live) this.postLive();
        return;
      }
      case "delete": {
        if (this.engine.busy && this.chat.id === this.runId) return;
        const pick = await vscode.window.showWarningMessage(`Delete the chat "${this.chat.title}"?`, { modal: true }, "Delete");
        if (pick !== "Delete") return;
        this.store.remove(this.chat.id);
        this.tools.removeBackups(this.chat.id);
        const next = this.store.list().find((c) => !c.archived);
        this.chat = (next && this.store.load(next.id)) || Engine.newChat();
        this.post();
        return;
      }
      case "model":
        if (policy.locked("model")) { vscode.window.showInformationMessage("Your organization sets the model Solder uses."); return; }
        if (this.engine.busy && this.runId === this.chat.id) { vscode.window.showInformationMessage("Solder can switch models once this reply is done, or press Stop first."); return; }
        this.chat.model = message.id; await this.store.save(this.chat); this.post(); return;
      case "effort":
        if (policy.locked("effort")) { vscode.window.showInformationMessage("Your organization sets the effort Solder uses."); return; }
        this.chat.effort = message.level; await this.store.save(this.chat); this.post(); return;
      case "undo": return this.undo(message.id);
      case "undoTask": return this.undoTask(Number(message.at));
      case "review": {
        const change = this.change(message.id);
        if (change) await this.tools.review(change);
        return;
      }
      case "openFile": return this.openFile(message.path, message.line);
      case "folder": return this.chooseFolder();
      case "clearFolder": return this.setFolder("");
      case "setKey": await vscode.commands.executeCommand("solder.setApiKey"); return;
      case "settings": await this.settingsScreen.open(); return;
      case "settingsScreen": await this.settingsScreen.handle(message); return;
      case "refreshModels": return this.refreshModels();
      case "setup":
        if (message.action === "start") await this.setup.start();
        else {
          await this.setup.handle(message);
          if (!this.setup.view) { this._client = null; await this.refreshModels(); }
        }
        return;
      case "guide": await vscode.commands.executeCommand("solder.openGuide"); return;
      case "feedback": await vscode.commands.executeCommand("solder.feedback"); return;
      case "diagnostics": await vscode.commands.executeCommand("solder.copyDiagnostics"); return;
    }
  }

  /** @param {{text: string, selection?: boolean, file?: boolean}} message */
  /**
   * A slash command typed in the box: /new, /fork, /compact [what to keep], /rename [name], /model [name],
   * /effort [level], /review, /settings. (/help opens the guide from the panel; /model with no name, the model menu.)
   * @param {string} name @param {string} arg
   */
  async command(name, arg) {
    const info = (/** @type {string} */ text) => { vscode.window.showInformationMessage(text); };
    const busy = () => info(`Solder is working on a reply. /${name} can wait until it's done, or press Stop first.`);
    switch (name) {
      case "new": return this.engine.busy ? busy() : this.onMessage({ type: "new" });
      case "fork": {
        if (this.engine.busy) return busy();
        if (!this.chat.messages.length) return info("There's nothing to fork yet: this chat is empty.");
        await this.store.save(this.chat);
        this.chat = Engine.fork(this.chat);
        await this.store.save(this.chat);
        this.error = null;
        this.post();
        return;
      }
      case "compact": {
        if (this.engine.busy) return busy();
        if (!this.chat.messages.length) return info("There's nothing to summarise yet: this chat is empty.");
        this.error = null;
        this.compactProblem = "";
        const result = await this.engine.compactNow(this.chat, arg);
        if (result === "nothing") info("This chat is already summarised: there's nothing new since.");
        else if (result === "failed") {
          vscode.window.showWarningMessage(`Couldn't summarise this chat${this.compactProblem ? ` (${this.compactProblem})` : ""}. It's unchanged.`);
        }
        this.post();
        return;
      }
      case "rename": {
        if (!arg) return this.onMessage({ type: "rename" });
        if (!this.chat.messages.length) return info("A chat can be renamed once it has a message.");
        this.chat.title = arg.slice(0, 120);
        this.chat.titleSource = "user";
        await this.store.save(this.chat);
        this.post();
        return;
      }
      case "model": {
        const wanted = arg.toLowerCase();
        const exact = this.models.filter((m) => m.id.toLowerCase() === wanted || m.name.toLowerCase() === wanted);
        const partial = this.models.filter((m) => m.id.toLowerCase().includes(wanted) || m.name.toLowerCase().includes(wanted));
        const found = exact.length === 1 ? exact[0] : partial.length === 1 ? partial[0] : null;
        if (!found) {
          return info(partial.length > 1 ? `More than one model matches "${arg}": ${partial.slice(0, 6).map((m) => m.name).join(", ")}.`
            : `No model matches "${arg}". Pick one from the model menu beside Send.`);
        }
        return this.onMessage({ type: "model", id: found.id });
      }
      case "effort": {
        const levels = ["default", "low", "medium", "high"];
        const level = arg ? levels.find((l) => l.startsWith(arg.toLowerCase())) : await vscode.window.showQuickPick(levels, { title: "How hard this chat thinks" });
        if (!level) return arg ? info(`Effort is one of: ${levels.join(", ")}.`) : undefined;
        return this.onMessage({ type: "effort", level });
      }
      case "review": {
        if (this.engine.busy) return busy();
        if (!this.chat.messages.length) return this.start("review");
        const starter = STARTERS.find((s) => s.id === "review");
        if (starter) await this.send({ text: starter.prompt });
        return;
      }
      case "skill": {
        if (this.engine.busy) return busy();
        if (policy.locked("skillsFolders")) return info("Your organization sets Solder's skills, so you can't add your own.");
        // Nothing to go on (a new chat, and nothing said about it): made by hand, as Settings' New skill does.
        if (!arg && !this.chat.messages.length) { await this.newSkill(); return; }
        // The model is told where skills go once you have a folder for them: yours is made now if there's none.
        if (!this.skillsFolder()) {
          const folder = DEFAULT_SKILLS();
          try { fs.mkdirSync(folder, { recursive: true }); } catch (error) { return info(`Solder couldn't make your skills folder (${/** @type {any} */ (error)?.code || error}).`); }
          if (!(await this.addSkillsFolder(folder))) return;
        }
        await this.send({ text: arg ? SKILL.about(arg) : SKILL.fromChat });
        return;
      }
      case "settings": await this.settingsScreen.open(arg.toLowerCase()); return;
      default: return info(`There's no /${name} command.`);
    }
  }

  /**
   * From the chats dropdown's right-click menu, on any chat (not only the open one).
   * @param {string} action pin, unpin, rename, fork, archive, unarchive or delete @param {string} id
   */
  async chatAction(action, id) {
    const current = id === this.chat.id;
    // The chat a task runs (or last ran) in is the copy the engine saves: changed anywhere else, its next save would undo it.
    const chat = current ? this.chat : id === this.runId && this.runChat ? this.runChat : this.store.load(id);
    if (!chat) return;
    const busy = () => vscode.window.showInformationMessage("Solder is working on a reply. That can wait until it's done, or press Stop first.");
    switch (action) {
      case "pin": chat.pinned = true; chat.archived = false; break;
      case "unpin": chat.pinned = false; break;
      case "archive": chat.archived = true; chat.pinned = false; break;
      case "unarchive": chat.archived = false; break;
      case "rename": {
        const title = await vscode.window.showInputBox({ title: "Rename this chat", value: chat.title,
          validateInput: (value) => value.trim() ? null : "A chat needs a name." });
        if (!title?.trim()) return;
        chat.title = title.trim().slice(0, 120);
        chat.titleSource = "user";
        break;
      }
      case "fork": {
        if (this.engine.busy) return busy();
        if (!chat.messages.length) return;
        if (current) await this.store.save(chat);
        this.chat = Engine.fork(chat);
        await this.store.save(this.chat);
        this.error = null;
        this.post();
        return;
      }
      case "delete": {
        if (chat.id === this.runId && this.engine.busy) return busy();
        const pick = await vscode.window.showWarningMessage(`Delete the chat "${chat.title}"?`, { modal: true }, "Delete");
        if (pick !== "Delete") return;
        this.store.remove(chat.id);
        this.tools.removeBackups(chat.id);
        if (current) {
          const next = this.store.list().find((c) => !c.archived);
          this.chat = (next && this.store.load(next.id)) || Engine.newChat();
          this.error = null;
        }
        this.post();
        return;
      }
      default: return;
    }
    await this.store.save(chat);
    this.post();
  }

  /** A starter card: its prompt, as your first message, in a chat named after it. @param {string} id */
  async start(id) {
    const starter = STARTERS.find((s) => s.id === id);
    if (!starter || this.engine.busy || this.chat.messages.length) return;
    this.chat.title = starter.title;
    await this.send({ text: starter.prompt });
  }

  /**
   * From the editor's right-click menu, with text selected: "explain" or "fix" sends it (with the selection, and
   * for a fix the problems VS Code shows in it); "add" opens the panel with the selection attached, to ask your own.
   * @param {"explain" | "fix" | "add"} kind
   */
  async fromEditor(kind) {
    const editor = vscode.window.activeTextEditor; // taken before the panel gets focus
    const picked = editor ? this.selectionBlock(editor) : null; // and the selection with it
    if (!editor || !picked) return;
    await vscode.commands.executeCommand("solder.chat.focus");
    if (kind === "add") { this.view?.webview.postMessage({ type: "attachSelection" }); return; }
    let text = kind === "fix" ? SELECTION.fix : SELECTION.explain;
    if (kind === "fix") {
      const range = editor.selection;
      const lines = vscode.languages.getDiagnostics(editor.document.uri)
        .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning && d.range.intersection(range))
        .slice(0, 20).map((d) => `- line ${d.range.start.line + 1}: ${d.message.split("\n")[0]}`);
      if (lines.length) text += "\n\n" + SELECTION.problems(lines);
    }
    await this.send({ text, selection: true, editor, picked });
  }

  /** A queued message that never went with a step: now as a message of its own. @param {any} queued */
  async sendQueued(queued) {
    if (this.engine.busy) { this.engine.steer(queued.text, { context: queued.context, chips: queued.chips }); this.post(); return; }
    this.error = null;
    this.engine.ask(this.runChat ?? this.chat, queued.text, { context: queued.context, chips: queued.chips });
  }

  async send(message) {
    const text = String(message.text || "").trim();
    if (!text) return;
    if (this.awayBusy()) {
      vscode.window.showInformationMessage(`Solder is working in "${this.runChat?.title ?? "another chat"}". Go back to it to add to that task, or send this once it's done.`);
      this.view?.webview.postMessage({ type: "restore", text });
      return;
    }
    if (this.engine.busy) {
      // Busy: it goes with the next step, the selection with it when it came from the menu.
      const picked = message.picked ?? (message.editor ? this.selectionBlock(message.editor) : null);
      this.engine.steer(text, picked ? { context: picked.block, chips: [picked.chip] } : {});
      this.post();
      return;
    }
    if (!this.chat.model && !this.settings().model && this.models[0]) this.chat.model = this.models[0].id;
    const parts = [];
    const chips = [];
    this.tools.useFolder(this.chat.folder);
    for (const note of this.chat.notes || []) parts.push(note);
    if (this.chat.folder) {
      // Where you are, not something to read: the model reads only what the request is about.
      parts.push(CONTEXT.workingIn(this.chat.folder));
    }
    this.chat.notes = [];
    const editor = message.editor ?? vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === "file") {
      const shown = this.tools.shown(editor.document.uri.fsPath);
      const picked = message.picked ?? (message.selection ? this.selectionBlock(editor) : null);
      if (picked) {
        parts.push(picked.block);
        chips.push(picked.chip);
      } else if (message.file) {
        parts.push(CONTEXT.openFile(shown));
        chips.push(path.basename(shown));
      }
    }
    this.error = null;
    this.engine.ask(this.chat, text, { context: parts.join("\n\n"), chips });
  }

  /** The selected text as context for the model, and its chip ("cart.js:12–18"), or null with nothing selected. @param {vscode.TextEditor} editor */
  selectionBlock(editor) {
    if (!editor || editor.selection.isEmpty || editor.document.uri.scheme !== "file") return null;
    this.tools.useFolder(this.chat.folder);
    // As the tools name paths (relative to the working folder, or in full), so the model can use it as it's given.
    const shown = this.tools.shown(editor.document.uri.fsPath);
    const first = editor.selection.start.line + 1;
    const last = editor.selection.end.line + (editor.selection.end.character === 0 ? 0 : 1);
    let selected = editor.document.getText(editor.selection);
    if (selected.length > MAX_SELECTION_CHARS) selected = selected.slice(0, MAX_SELECTION_CHARS) + CONTEXT.cutShort;
    const fence = selected.includes("```") ? "````" : "```";
    return { block: CONTEXT.selected(shown, first, last, editor.document.languageId, selected, fence),
      chip: `${path.basename(shown)}:${first}–${last}` };
  }

  /** Pick the chat's working folder (in the workspace, or added to it). */
  async chooseFolder() {
    const root = this.tools.root();
    if (!root) { vscode.window.showWarningMessage("Solder: open a folder first."); return; }
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
      defaultUri: vscode.Uri.file(this.tools.base()), openLabel: "Work in this folder", title: "Solder: the folder you're working in" });
    if (picked?.[0]) await this.setFolder(picked[0].fsPath);
  }

  /**
   * The working folder: relative paths and searches start there. One outside the workspace can be added to it, as
   * VS Code's File → Add Folder to Workspace does. @param {string} full "" for the whole workspace
   */
  async setFolder(full) {
    if (this.awayBusy()) { vscode.window.showInformationMessage("Solder is working in another chat: change this chat's folder once it's done."); return; }
    const root = this.tools.root();
    let folder = "";
    if (full && root) {
      if (!this.tools.rootOf(full)) {
        const name = path.basename(full) || full;
        const pick = await vscode.window.showInformationMessage(`"${name}" isn't in this window's workspace. Add it, so Solder can work there?`,
          { modal: true, detail: "It's added as another folder of the workspace, as File → Add Folder to Workspace does. Save the workspace (File → Save Workspace As…) to open it this way again." },
          "Add to workspace");
        if (pick !== "Add to workspace") return;
        const count = vscode.workspace.workspaceFolders?.length ?? 0;
        // Watched for, not waited on as an event: in a real VS Code the change event didn't always come.
        const asked = vscode.workspace.updateWorkspaceFolders(count, 0, { uri: vscode.Uri.file(full) });
        for (let waited = 0; asked && !this.tools.rootOf(full) && waited < 10_000; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
        if (!asked || !this.tools.rootOf(full)) {
          vscode.window.showWarningMessage("Solder: VS Code didn't add that folder to the workspace. Try File → Add Folder to Workspace.");
          return;
        }
      }
      // In the main folder: relative to it. In another workspace folder: its full path.
      const relative = path.relative(root, full);
      folder = relative.startsWith("..") || path.isAbsolute(relative) ? path.resolve(full) : relative.split(path.sep).join("/");
    }
    this.chat.folder = folder;
    this.tools.useFolder(this.chat.folder);
    await this.store.save(this.chat);
    this.post();
  }

  /** What support needs to know, with nothing private: versions, the shape of the settings, the recent log. */
  diagnostics() {
    const config = solderSettings();
    const docs = this.tools.docsState();
    const skills = this.tools.skills();
    let backups = 0;
    try { backups = this.tools.pruneBackups(Infinity).bytes; } catch { /* none */ }
    return [
      `Solder ${this.context.extension?.packageJSON?.version ?? ""} · VS Code ${vscode.version} · ${process.platform} ${process.arch} · node ${process.versions.node}`,
      `Organization policy: ${policy.error ? "couldn't be read" : policy.names.length ? policy.names.join(", ") : "none"}` +
        (policy.problems.length ? ` · not used: ${policy.problems.join("; ")}` : ""),
      `Endpoint set: ${config.get("endpoint", "") ? "yes" : "no"} · key saved: ${this._key ? "yes" : "no"} · models listed: ${this.models.length}` +
        (this.modelsProblem ? ` · models problem: ${this.modelsProblem === "setup" ? "not set up" : this.modelsProblem}` : ""),
      `Model: ${this.chat.model || config.get("model", "") || "(none)"} · effort: ${this.chat.effort || config.get("effort", "default")} · compact at: ${config.get("compactAtTokens", 100000)} · max rounds: ${config.get("maxRounds", 30)}`,
      `Docs: ${docs.folders} folder(s), ${docs.indexed} files indexed${docs.active ? ", indexing" : ""}${docs.available ? "" : ", no SQLite"} · backups: ${(backups / 1024 ** 2).toFixed(1)} MB`,
      `Skills: ${this.tools.skillsFolders().length} folder(s), ${skills.length} found, ${Math.min(MAX_SKILLS, skills.filter(offered).length)} offered` +
        (skills.some((skill) => skill.problem) ? `, ${skills.filter((skill) => skill.problem).length} with a problem` : ""),
      `This chat: ${this.chat.messages.length} messages, ${this.chat.usage.tokens} tokens, token ratio ${(this.chat.tokenRatio || 1).toFixed(2)}${this.chat.compaction ? ", compacted" : ""}`,
      "",
      // Numbers only, by kind: what the chat's tokens carried, so the biggest cost is plain.
      ...tokenReport(this.chat, systemPrompt(this.promptContext()), toolDefinitions()),
      "",
      "Recent log:",
      ...this.log.recent(200),
    ].join("\n");
  }

  /** @param {string} id a call's id */
  change(id) {
    return this.chat.messages.find((/** @type {any} */ m) => m.role === "tool" && m.tool_call_id === id)?.meta?.change ?? null;
  }

  /** @param {string} id */
  async undo(id) {
    if (this.awayBusy()) { vscode.window.showInformationMessage("Solder is working in another chat: undo this once it's done, so the two don't change files at once."); return; }
    const message = this.chat.messages.find((/** @type {any} */ m) => m.role === "tool" && m.tool_call_id === id);
    const change = message?.meta?.change;
    if (!change || message.meta.undone) return;
    await this.tools.undo(change);
    message.meta.undone = true;
    // The model is told with your next message, so it doesn't build on a change that's gone.
    this.chat.notes = [...(this.chat.notes || []), CONTEXT.undid(change.shown, message.meta.summary)];
    await this.store.save(this.chat);
    this.post();
  }

  /** A task's messages: from the message that began it (at `start`) up to the next one you typed. @param {number} start */
  taskMessages(start) {
    const messages = this.chat.messages;
    let end = start + 1;
    while (end < messages.length && !(messages[end].role === "user" && !messages[end].meta?.resume)) end++;
    return messages.slice(start, end);
  }

  /**
   * Undo everything a task changed, newest first (so each file goes back through the states it went through), after
   * asking. It stops at the first change that can't be undone (a file edited since), and says how far it got.
   * @param {number} start the index of the message that began the task
   */
  async undoTask(start) {
    if (this.engine.busy) { vscode.window.showInformationMessage("Solder is working: undo a task's changes once it's done, or press Stop first."); return; }
    const first = this.chat.messages[start];
    if (!first || first.role !== "user") return;
    const changed = this.taskMessages(start).filter((/** @type {any} */ m) => m.role === "tool" && m.meta?.change && !m.meta.undone).reverse();
    if (!changed.length) return;
    const names = [...new Set(changed.map((/** @type {any} */ m) => m.meta.change.shown))];
    const pick = await vscode.window.showWarningMessage(`Undo all ${changed.length} changes this task made?`,
      { modal: true, detail: names.slice(0, 12).join("\n") + (names.length > 12 ? `\nand ${names.length - 12} more` : "") }, "Undo all");
    if (pick !== "Undo all") return;
    let done = 0;
    let problem = "";
    for (const message of changed) {
      try { await this.tools.undo(message.meta.change); } catch (error) { problem = error instanceof Error ? error.message : String(error); break; }
      message.meta.undone = true;
      // The model is told with your next message, so it doesn't build on changes that are gone.
      this.chat.notes = [...(this.chat.notes || []), CONTEXT.undid(message.meta.change.shown, message.meta.summary)];
      done++;
    }
    await this.store.save(this.chat);
    this.post();
    if (problem) vscode.window.showWarningMessage(`Solder undid ${done} of ${changed.length} changes, then stopped: ${problem}`);
  }

  /** @param {string} file @param {number} [line] */
  async openFile(file, line) {
    if (!this.awayBusy()) this.tools.useFolder(this.chat.folder); // the running task keeps its folder

    const target = this.tools.resolve(file);
    try {
      const document = await vscode.workspace.openTextDocument(target.uri);
      const position = new vscode.Position(Math.max(0, (line || 1) - 1), 0);
      await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position), preview: true });
    } catch {
      vscode.window.showWarningMessage(`Solder: couldn't open ${file}.`);
    }
  }

  // ------------------------------------------------------------------- posting --

  /** Whether a task is running in a chat other than the one shown. */
  awayBusy() {
    return this.engine.busy && this.chat.id !== this.runId;
  }

  /** Where Solder is working (or waiting for your approval), when it's another chat; or that one finished meanwhile. */
  elsewhere() {
    const title = this.runChat?.title || "another chat";
    if (this.awayBusy()) return { id: this.runId, title, waiting: this.approvals.length > 0 };
    if (this.awayDone && this.awayDone !== this.chat.id) {
      const problem = this.error && this.errorChat === this.awayDone ? this.error.message : "";
      return { id: this.awayDone, title, done: true, problem };
    }
    return null;
  }

  post() {
    if (!this.view) return;
    const chat = this.chat;
    const settings = this.settings();
    const current = (settings.modelLocked ? settings.model : chat.model || settings.model) || "";
    this.view.webview.postMessage({
      type: "state",
      chat: { id: chat.id, title: chat.title, ...this.items(), tokens: chat.usage.tokens, freeTokens: chat.usage.assistTokens || 0,
        context: /** @type {any} */ (chat.usage).context || 0, compactAt: this.settings().compactAt },
      chats: chatList(this.store.list()),
      // Assist models are tagged in the picker: free, slower, and no thinking level.
      models: (this.models.length || !current ? this.models : [{ id: current, name: current }]).map((m) => ({ ...m, assist: laneOf(m.id, settings) === "assist" })),
      assist: laneOf(current, settings) === "assist",
      modelsProblem: this.modelsProblem,
      model: current,
      effort: settings.effortLocked ? settings.effort : chat.effort || settings.effort,
      locks: { model: settings.modelLocked, effort: settings.effortLocked },
      busy: this.engine.busy && !this.awayBusy(),
      elsewhere: this.elsewhere(),
      folder: this.chat.folder || "",
      workspaceName: (vscode.workspace.workspaceFolders || []).map((folder) => folder.name).join(" + "),
      status: this.awayBusy() ? "" : this.status,
      live: this.awayBusy() ? "" : this.live,
      approvals: (this.awayBusy() ? [] : this.approvals).map((a) => ({ id: a.id, label: a.label, reason: a.reason, content: a.name === "write_file" ? String(a.args.content || "").slice(0, 2000) : "" })),
      error: this.error && (!this.errorChat || this.errorChat === chat.id) ? this.error : null,
      answerTokens: this.awayBusy() ? 0 : this.answerTokens,
      credits: this.credits,
      steers: this.awayBusy() ? [] : this.engine.steers.map((s) => s.text),
      workspace: !!this.tools.root(),
      starters: STARTERS.map((s) => ({ id: s.id, title: s.title, blurb: s.blurb })),
      setup: this.setup.view,
      settings: this.setup.view ? null : this.settingsScreen.view,
    });
  }

  postLive() {
    this.view?.webview.postMessage({ type: "live", text: this.live });
  }

  postEditor() {
    const editor = vscode.window.activeTextEditor;
    const file = editor && editor.document.uri.scheme === "file" ? vscode.workspace.asRelativePath(editor.document.uri, false) : "";
    const selection = editor && !editor.selection.isEmpty
      ? `${editor.selection.start.line + 1}–${editor.selection.end.line + (editor.selection.end.character === 0 ? 0 : 1)}` : "";
    this.view?.webview.postMessage({ type: "editor", file, selection });
  }

  /**
   * The saved chat as what the panel shows. A turn (your message, up to the next one you type) that's finished folds
   * its steps into one row (with Undo all), then its answer, then its plan, completed. The turn that's running shows
   * every step as it happens; its plan is in the dock above the box (livePlan), not in the chat.
   * @returns {{items: any[], livePlan: any}}
   */
  items() {
    /** @type {any[]} */
    const flat = [];
    /** @type {Map<string, any>} */
    const steps = new Map();
    const messages = this.chat.messages;
    // The plan is the chat's latest: it belongs to the turn its steps were set in.
    const plan = /** @type {any} */ (this.chat).plan;
    let planAt = "";
    for (const message of messages) for (const call of message.tool_calls || []) {
      if (call.function.name === "plan" && /"steps"\s*:/.test(call.function.arguments || "")) planAt = call.id;
    }
    let turn = -1;
    let planTurn = -1;
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      if (message.role === "user" && !message.meta?.resume) turn = index;
      if (this.chat.compaction && index === this.chat.compaction.through) {
        flat.push({ kind: "note", key: "n" + index, text: "Older messages were summarised here to save tokens.", turn });
      }
      if (message.role === "user") {
        flat.push({ kind: "user", key: "u" + index, text: message.meta?.typed ?? message.content, chips: message.meta?.chips || [], resume: !!message.meta?.resume, turn });
      } else if (message.role === "assistant") {
        if (message.content?.trim()) flat.push({ kind: "answer", text: message.content, incomplete: !!message.meta?.incomplete, turn });
        for (const call of message.tool_calls || []) {
          if (call.function.name === "plan") { if (call.id === planAt) planTurn = turn; continue; }
          const args = parseArguments(call.function.name, call.function.arguments, false).args;
          const step = { kind: "step", id: call.id, name: call.function.name, label: labelOf(call.function.name, args),
            pending: true, path: args.path || "", turn };
          steps.set(call.id, step);
          flat.push(step);
        }
      } else if (message.role === "tool") {
        const step = steps.get(message.tool_call_id);
        if (!step) continue;
        const meta = message.meta || {};
        Object.assign(step, { pending: false, summary: meta.summary, failed: !!meta.failed,
          output: message.content.length > SHOWN_OUTPUT_CHARS ? message.content.slice(0, SHOWN_OUTPUT_CHARS) + "\n…" : message.content,
          change: !!meta.change, created: !!meta.change?.created, removed: !!meta.change?.removed, noDiff: !!(meta.change?.removed || meta.change?.moved || meta.change?.copied), undone: !!meta.undone, steer: meta.steer || "",
          ms: typeof meta.ms === "number" ? meta.ms : null });
      }
    }
    if (this.chat.compaction && this.chat.compaction.through >= messages.length) {
      flat.push({ kind: "note", key: "n" + messages.length, text: "Older messages were summarised here to save tokens.", turn });
    }
    for (const step of steps.values()) {
      if (!step.pending) continue;
      step.running = !this.awayBusy() && step.id === this.running;
      if (step.running) step.since = this.runningSince; // the panel shows a clock on it
    }
    // The turn that's running in this chat now (none when it's done, or when Solder works in another chat).
    const running = this.engine.busy && !this.awayBusy() ? turn : -2;
    const planned = plan?.steps?.length ? plan.steps.map((/** @type {any} */ step) => ({ goal: step.goal, state: step.state, notes: step.notes || "" })) : null;
    /** @type {any[]} */
    const items = [];
    if (this.chat.forkedFrom) items.push({ kind: "note", key: "fork", text: `A copy of "${this.chat.forkedFrom.title}" to carry on in. The original is unchanged.` });
    for (let from = 0; from < flat.length;) {
      const at = flat[from].turn;
      let to = from;
      while (to < flat.length && flat[to].turn === at) to++;
      const segment = flat.slice(from, to);
      from = to;
      if (at === running || at < 0) { items.push(...segment); continue; }
      // A finished turn: your message, its steps (and any words between them) folded, then the answer and the plan.
      // Up to and including your message (a "summarised here" note can come before it).
      const head = segment.findIndex((item) => item.kind === "user" && !item.resume) + 1;
      const lastStep = segment.reduce((found, item, index) => item.kind === "step" ? index : found, -1);
      const answerAt = segment.reduce((found, item, index) => item.kind === "answer" && index > lastStep ? index : found, -1);
      const tail = answerAt >= 0 ? answerAt : segment.length;
      const inner = segment.slice(head, tail);
      const folded = inner.filter((item) => item.kind === "step");
      items.push(...segment.slice(0, head));
      if (folded.length) {
        const changes = folded.filter((item) => item.change && !item.undone).length;
        items.push({ kind: "fold", id: "t" + at, items: inner, steps: folded.length, changes,
          failed: folded.filter((item) => item.failed).length, ms: folded.reduce((sum, item) => sum + (item.ms || 0), 0),
          undoAll: changes >= 2 ? { at, count: changes } : null });
      } else items.push(...inner);
      items.push(...segment.slice(tail));
      if (at === planTurn && planned) items.push({ kind: "plan", id: planAt, active: false, steps: planned });
    }
    return { items, livePlan: running >= 0 && planTurn === running && planned ? planned : null };
  }

  updateStatusBar() {
    const tokens = this.chat.usage.tokens;
    const left = this.credits ? ` · ${compact(this.credits.remaining)} left` : "";
    this.statusBar.text = `$(symbol-misc) ${compact(tokens)}${left}`;
    this.statusBar.tooltip = `Solder: this chat has used ${tokens.toLocaleString()} tokens` +
      (this.answerTokens ? `, the latest answer ${this.answerTokens.toLocaleString()}` : "") +
      (this.credits ? `.\n${this.credits.remaining.toLocaleString()} of ${this.credits.limit.toLocaleString()} left (${this.credits.bucket})` +
        (this.credits.resetSeconds ? `, resets in about ${Math.round(this.credits.resetSeconds / 3600)} h` : "") : "") + ".";
    this.statusBar.show();
  }

  /** @param {vscode.Webview} webview @param {vscode.Uri} media */
  html(webview, media) {
    const nonce = require("node:crypto").randomBytes(18).toString("base64url");
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.js"));
    return fs.readFileSync(path.join(media.fsPath, "panel.html"), "utf8")
      .replace(/\{\{csp\}\}/g, `default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; form-action 'none'; base-uri 'none'; frame-src 'none';`)
      .replace(/\{\{nonce\}\}/g, nonce).replace("{{css}}", css.toString()).replace("{{js}}", js.toString());
  }
}

/** 12345 → "12.3k". @param {number} n */
/** The chats the dropdown shows: the newest 100 that aren't archived (pinned ones always), and the newest 100 archived. @param {any[]} all */
function chatList(all) {
  const live = all.filter((c) => !c.archived);
  const archived = all.filter((c) => c.archived);
  return [...live.filter((c) => c.pinned), ...live.filter((c) => !c.pinned).slice(0, 100), ...archived.slice(0, 100)];
}

/** What a reply's tool calls are, while they're still being written: "Writing src/app.ps1 · 4.2 KB so far". */
function draftingLabel(/** @type {{name: string, chars: number, path: string}[]} */ calls) {
  const last = calls[calls.length - 1];
  if (!last) return "Thinking…";
  const size = last.chars >= 1024 ? `${(last.chars / 1024).toFixed(1)} KB` : `${last.chars} characters`;
  const what = { write_file: "Writing", edit_file: "Editing", move_item: "Moving", remove_item: "Removing" }[last.name] || "Preparing";
  const target = last.path ? last.path.split(/[\\/]/).slice(-2).join("/") : last.name || "a step";
  const more = calls.length > 1 ? ` (step ${calls.length})` : "";
  return `${what} ${target}${more} · ${size} so far`;
}

function compact(n) {
  return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k" : String(n);
}

module.exports = { SolderPanel, KEY };
