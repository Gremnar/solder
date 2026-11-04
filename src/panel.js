// @ts-check
"use strict";
/**
 * The chat panel: a webview in Solder's side bar view, and the controller behind it. The webview holds
 * no truth: it renders the state posted here (rebuilt from the saved chat) plus streamed text.
 */
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const { Engine, labelOf, parseArguments } = require("./engine.js");
const { GatewayClient, GatewayError } = require("./gateway.js");
const { systemPrompt } = require("./prompt.js");
const { ChatStore } = require("./store.js");
const { WorkspaceTools } = require("./tools.js");

const KEY = "solder.apiKey";
const MAX_SELECTION_CHARS = 12_000;
const SHOWN_OUTPUT_CHARS = 6_000;

class SolderPanel {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this.context = context;
    this.tools = new WorkspaceTools(context);
    this.store = new ChatStore((context.storageUri ?? context.globalStorageUri).fsPath);
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
    /** @type {any[]} */
    this.approvals = [];
    /** @type {any} */
    this.error = null;
    /** @type {any} */
    this.credits = null;
    this.answerTokens = 0;
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBar.command = "solder.focus";
    context.subscriptions.push(this.statusBar);
    this.engine = new Engine({ client: { reply: (/** @type {any} */ request) => this.client().reply(request) },
      host: this.host(), settings: () => this.settings(), onEvent: (event) => this.onEvent(event) });
    const last = this.store.list()[0];
    if (last) this.chat = this.store.load(last.id) ?? this.chat;
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.postEditor()),
      vscode.window.onDidChangeTextEditorSelection(() => this.postEditor()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("solder")) { this._client = null; this.refreshModels(); }
      }),
    );
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
      systemPrompt: async () => systemPrompt({ workspace: this.tools.root(), instructions: this.instructions(),
        rules: vscode.workspace.getConfiguration("solder").get("rules", "") }),
      runTool: (/** @type {string} */ name, /** @type {any} */ args, /** @type {any} */ ctx) => this.tools.run(name, args, ctx),
      needsApproval: (/** @type {string} */ name, /** @type {any} */ args) => this.tools.needsApproval(name, args),
      save: (/** @type {any} */ chat) => this.store.save(chat),
    };
  }

  /** The workspace root's instruction files (AGENTS.md by default). */
  instructions() {
    const root = this.tools.root();
    if (!root) return [];
    const names = vscode.workspace.getConfiguration("solder").get("instructionFiles", ["AGENTS.md"]);
    const found = [];
    for (const name of names) {
      try {
        const text = fs.readFileSync(path.join(root, name), "utf8").slice(0, 40_000);
        if (text.trim()) found.push({ path: name, text });
      } catch { /* not there */ }
    }
    return found;
  }

  settings() {
    const config = vscode.workspace.getConfiguration("solder");
    return { model: config.get("model", ""), effort: config.get("effort", "default"),
      compactAt: Math.max(30_000, config.get("compactAtTokens", 100_000)), maxRounds: Math.max(1, config.get("maxRounds", 30)) };
  }

  /** @type {GatewayClient | null} */
  _client = null;
  client() {
    if (!this._client) {
      const config = vscode.workspace.getConfiguration("solder");
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
      const config = vscode.workspace.getConfiguration("solder");
      if (!config.get("endpoint", "")) { this.models = []; this.modelsProblem = "setup"; this.post(); return; }
      let ids = await this.client().models();
      const filter = config.get("modelFilter", "");
      if (filter) {
        try { const pattern = new RegExp(filter, "i"); ids = ids.filter((id) => pattern.test(id)); } catch { /* shown in settings */ }
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
    if (event.chat !== this.chat.id) {
      if (event.type === "busy") this.post();
      return;
    }
    switch (event.type) {
      case "delta": this.live += event.text; this.status = ""; this.postLive(); return;
      case "thinking": this.status = "Thinking…"; this.running = ""; break;
      case "retrying": this.status = event.why === "empty" ? "The reply came back empty; asking again…" : "Connection trouble; trying again…"; break;
      case "compacting": this.status = "Summarising the older part of this chat to save tokens…"; break;
      case "message": this.live = ""; this.running = ""; break;
      case "running": this.running = event.id; this.status = ""; break;
      case "approval": this.approvals.push(event); break;
      case "approval-done": this.approvals = this.approvals.filter((a) => a.id !== event.id); break;
      case "usage": this.answerTokens = event.answer; this.credits = event.credits || this.credits; this.updateStatusBar(); break;
      case "busy":
        if (event.busy) { this.error = null; this.answerTokens = 0; } else { this.status = ""; this.live = ""; this.running = ""; this.approvals = []; }
        break;
      case "error": this.error = { message: event.message, resumable: event.resumable, exhausted: event.exhausted }; break;
      case "stopped": this.error = { message: "Stopped.", resumable: true, stopped: true }; break;
      case "done": if (event.limit) this.error = { message: `Stopped at the limit of ${event.limit} steps for one message.`, resumable: true }; break;
      case "steer-unsent": this.post(); this.view?.webview.postMessage({ type: "restore", text: event.text }); return;
    }
    this.post();
  }

  // ------------------------------------------------------------ panel messages --

  /** @param {any} message */
  async onMessage(message) {
    switch (message.type) {
      case "ready": this.post(); this.postEditor(); return;
      case "send": return this.send(message);
      case "stop": this.engine.stop(); return;
      case "resume": this.error = null; this.tools.useFolder(this.chat.folder); this.engine.resume(this.chat); return;
      case "decide": this.engine.decide(message.id, { decision: message.decision, note: message.note }); return;
      case "new":
        if (!this.engine.busy) {
          const folder = this.chat.folder || "";
          this.chat = Engine.newChat();
          if (folder) this.chat.folder = folder; // a new chat keeps working where you were
          this.error = null;
          this.post();
        }
        return;
      case "open": {
        if (this.engine.busy) return;
        const chat = this.store.load(message.id);
        if (chat) { this.chat = chat; this.error = null; this.post(); }
        return;
      }
      case "delete": {
        if (this.engine.busy) return;
        const pick = await vscode.window.showWarningMessage(`Delete the chat "${this.chat.title}"?`, { modal: true }, "Delete");
        if (pick !== "Delete") return;
        this.store.remove(this.chat.id);
        const next = this.store.list()[0];
        this.chat = (next && this.store.load(next.id)) || Engine.newChat();
        this.post();
        return;
      }
      case "model": this.chat.model = message.id; await this.store.save(this.chat); this.post(); return;
      case "effort": this.chat.effort = message.level; await this.store.save(this.chat); this.post(); return;
      case "undo": return this.undo(message.id);
      case "review": {
        const change = this.change(message.id);
        if (change) await this.tools.review(change);
        return;
      }
      case "openFile": return this.openFile(message.path, message.line);
      case "folder": return this.chooseFolder();
      case "clearFolder": return this.setFolder("");
      case "setKey": await vscode.commands.executeCommand("solder.setApiKey"); return;
      case "settings": await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:gremnar.solder"); return;
      case "refreshModels": return this.refreshModels();
    }
  }

  /** @param {{text: string, selection?: boolean, file?: boolean}} message */
  async send(message) {
    const text = String(message.text || "").trim();
    if (!text) return;
    if (this.engine.busy) { this.engine.steer(text); this.post(); return; }
    if (!this.chat.model && !this.settings().model && this.models[0]) this.chat.model = this.models[0].id;
    const parts = [];
    const chips = [];
    this.tools.useFolder(this.chat.folder);
    for (const note of this.chat.notes || []) parts.push(note);
    if (this.chat.folder) {
      // Where you are, not something to read: the model reads only what the request is about.
      parts.push(`(I'm working in ${this.chat.folder}: relative paths and searches start there.)`);
    }
    this.chat.notes = [];
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === "file") {
      const shown = vscode.workspace.asRelativePath(editor.document.uri, false);
      if (message.selection && !editor.selection.isEmpty) {
        const first = editor.selection.start.line + 1;
        const last = editor.selection.end.line + (editor.selection.end.character === 0 ? 0 : 1);
        let selected = editor.document.getText(editor.selection);
        if (selected.length > MAX_SELECTION_CHARS) selected = selected.slice(0, MAX_SELECTION_CHARS) + "\n…(cut short)";
        const fence = selected.includes("```") ? "````" : "```";
        parts.push(`(Selected in ${shown}, lines ${first}–${last}:)\n${fence}${editor.document.languageId}\n${selected}\n${fence}`);
        chips.push(`${path.basename(shown)}:${first}–${last}`);
      } else if (message.file) {
        parts.push(`(The file open in my editor, for reference: ${shown}.)`);
        chips.push(path.basename(shown));
      }
    }
    this.error = null;
    this.engine.ask(this.chat, text, { context: parts.join("\n\n"), chips });
  }

  /** Pick the chat's working folder (inside the workspace). */
  async chooseFolder() {
    const root = this.tools.root();
    if (!root) { vscode.window.showWarningMessage("Solder: open a folder first."); return; }
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
      defaultUri: vscode.Uri.file(this.tools.base()), openLabel: "Work in this folder", title: "Solder: the folder you're working in" });
    if (picked?.[0]) await this.setFolder(picked[0].fsPath);
  }

  /** The working folder: relative paths and searches start there. @param {string} full "" for the workspace folder */
  async setFolder(full) {
    const root = this.tools.root();
    let relative = "";
    if (full && root) {
      relative = path.relative(root, full);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        vscode.window.showWarningMessage("Solder: the working folder has to be inside the workspace.");
        return;
      }
    }
    this.chat.folder = relative.split(path.sep).join("/");
    this.tools.useFolder(this.chat.folder);
    await this.store.save(this.chat);
    this.post();
  }

  /** @param {string} id a call's id */
  change(id) {
    return this.chat.messages.find((/** @type {any} */ m) => m.role === "tool" && m.tool_call_id === id)?.meta?.change ?? null;
  }

  /** @param {string} id */
  async undo(id) {
    const message = this.chat.messages.find((/** @type {any} */ m) => m.role === "tool" && m.tool_call_id === id);
    const change = message?.meta?.change;
    if (!change || message.meta.undone) return;
    await this.tools.undo(change);
    message.meta.undone = true;
    // The model is told with your next message, so it doesn't build on a change that's gone.
    this.chat.notes = [...(this.chat.notes || []), `(I undid your change to ${change.shown}: ${message.meta.summary}.)`];
    await this.store.save(this.chat);
    this.post();
  }

  /** @param {string} file @param {number} [line] */
  async openFile(file, line) {
    this.tools.useFolder(this.chat.folder);
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

  post() {
    if (!this.view) return;
    const chat = this.chat;
    const current = chat.model || this.settings().model || "";
    this.view.webview.postMessage({
      type: "state",
      chat: { id: chat.id, title: chat.title, items: this.items(), tokens: chat.usage.tokens },
      chats: this.store.list().slice(0, 50),
      models: this.models.length || !current ? this.models : [{ id: current, name: current }],
      modelsProblem: this.modelsProblem,
      model: current,
      effort: chat.effort || this.settings().effort,
      busy: this.engine.busy,
      folder: this.chat.folder || "",
      workspaceName: vscode.workspace.workspaceFolders?.[0]?.name || "",
      status: this.status,
      live: this.live,
      approvals: this.approvals.map((a) => ({ id: a.id, label: a.label, reason: a.reason, content: a.name === "write_file" ? String(a.args.content || "").slice(0, 2000) : "" })),
      error: this.error,
      answerTokens: this.answerTokens,
      credits: this.credits,
      steers: this.engine.steers.length,
      workspace: !!this.tools.root(),
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

  /** The saved chat as what the panel shows. */
  items() {
    const items = [];
    /** @type {Map<string, any>} */
    const steps = new Map();
    const messages = this.chat.messages;
    for (let index = 0; index < messages.length; index++) {
      if (this.chat.compaction && index === this.chat.compaction.through) {
        items.push({ kind: "note", text: "Older messages were summarised here to save tokens." });
      }
      const message = messages[index];
      if (message.role === "user") {
        items.push({ kind: "user", text: message.meta?.typed ?? message.content, chips: message.meta?.chips || [], resume: !!message.meta?.resume });
      } else if (message.role === "assistant") {
        if (message.content?.trim()) items.push({ kind: "answer", text: message.content, incomplete: !!message.meta?.incomplete });
        for (const call of message.tool_calls || []) {
          const args = parseArguments(call.function.name, call.function.arguments, false).args;
          const step = { kind: "step", id: call.id, name: call.function.name, label: labelOf(call.function.name, args),
            pending: true, path: args.path || "" };
          steps.set(call.id, step);
          items.push(step);
        }
      } else if (message.role === "tool") {
        const step = steps.get(message.tool_call_id);
        if (!step) continue;
        const meta = message.meta || {};
        Object.assign(step, { pending: false, summary: meta.summary, failed: !!meta.failed,
          output: message.content.length > SHOWN_OUTPUT_CHARS ? message.content.slice(0, SHOWN_OUTPUT_CHARS) + "\n…" : message.content,
          change: !!meta.change, created: !!meta.change?.created, removed: !!meta.change?.removed, undone: !!meta.undone, steer: meta.steer || "" });
      }
    }
    for (const step of steps.values()) if (step.pending) step.running = step.id === this.running;
    return items;
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
    const nonce = Array.from({ length: 24 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 62)]).join("");
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.js"));
    return fs.readFileSync(path.join(media.fsPath, "panel.html"), "utf8")
      .replace(/\{\{csp\}\}/g, `default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};`)
      .replace(/\{\{nonce\}\}/g, nonce).replace("{{css}}", css.toString()).replace("{{js}}", js.toString());
  }
}

/** 12345 → "12.3k". @param {number} n */
function compact(n) {
  return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k" : String(n);
}

module.exports = { SolderPanel, KEY };
