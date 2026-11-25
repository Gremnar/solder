// @ts-check
"use strict";
/**
 * Solder's entry point: the chat panel in its own side bar view, the commands, and the connection
 * check (it lists the models, then makes one tool round trip with a pretend tool, from inside the
 * extension host: what matters behind a corporate proxy).
 */
const vscode = require("vscode");
const { config: solderSettings, policy } = require("./config.js");
const { GatewayClient, GatewayError } = require("./gateway.js");
const { laneOf, probeTools, withAssist } = require("./lanes.js");
const { SolderPanel, KEY } = require("./panel.js");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const FEEDBACK_TO = "support@gremnar.com";
const FEEDBACK_SUBJECT = "VS Code Solder extension feedback or support";

/**
 * Read-only mode is how Solder starts, from 0.2.11. Someone who set Solder up before then already had it changing files:
 * once, their changes stay on (an update never puts anyone back in read-only mode). A fresh install has no endpoint of
 * its own and no key, so it starts read-only.
 * @param {vscode.ExtensionContext} context
 */
async function keepChanges(context) {
  const DONE = "readOnlySettled";
  if (context.globalState.get(DONE)) return;
  try {
    const raw = vscode.workspace.getConfiguration("solder");
    const set = raw.inspect("readOnly");
    const chosen = set && (set.globalValue !== undefined || set.workspaceValue !== undefined || set.workspaceFolderValue !== undefined);
    // Signs of Solder having been used here before read-only mode: a saved key, or saved chats. An endpoint alone
    // isn't one (a new profile can come with it filled in), and such a profile starts read-only like any other.
    let chats = false;
    try { chats = fs.readdirSync(path.join(context.globalStorageUri.fsPath, "chats")).some((name) => name.endsWith(".json")); } catch { chats = false; }
    const before = chats || !!(await context.secrets.get(KEY));
    if (!chosen && before && !policy.locked("readOnly")) await raw.update("readOnly", false, vscode.ConfigurationTarget.Global);
  } catch { /* left as it is: read-only */ }
  await context.globalState.update(DONE, true);
}

/** @param {vscode.ExtensionContext} context */
async function activate(context) {
  // The organisation's policy first: nothing connects before it's known (see policy.js).
  await policy.refresh();
  await keepChanges(context);
  const output = vscode.window.createOutputChannel("Solder");
  const panel = new SolderPanel(context, output);
  // A key saved before Solder kept the gateway with it is the gateway's that's set now: settled here, at the start,
  // before the address can be changed.
  await panel.savedKey.get().catch(() => "");
  // Not set up yet: offer the guided setup once per start (the panel's welcome offers it too).
  panel.setup.needed().then(async (needed) => {
    if (!needed) return;
    const pick = await vscode.window.showInformationMessage("Solder isn't set up yet. It takes a minute: the gateway's address, your key and a model.",
      "Guided setup", "Later");
    if (pick === "Guided setup") await vscode.commands.executeCommand("solder.setup");
  }, () => {});
  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider("solder.chat", panel, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("solder.setApiKey", async () => {
      const key = await vscode.window.showInputBox({ prompt: "The API key for your endpoint", password: true,
        ignoreFocusOut: true });
      if (key === undefined) return;
      await panel.savedKey.save(key);
      vscode.window.showInformationMessage(key.trim() ? "Solder: API key saved." : "Solder: API key removed.");
      await panel.refreshModels();
    }),
    vscode.commands.registerCommand("solder.checkConnection", () => checkConnection(panel.savedKey, output, () => panel.refreshModels())),
    vscode.commands.registerCommand("solder.focus", () => vscode.commands.executeCommand("solder.chat.focus")),
    vscode.commands.registerCommand("solder.setup", async () => {
      await vscode.commands.executeCommand("solder.chat.focus");
      await panel.setup.start();
    }),
    vscode.commands.registerCommand("solder.feedback", async () => {
      // Your own email app, through the system: Solder itself sends nothing. Versions only, nothing from your chats.
      // To your organisation's own address when its policy sets one (read afresh, so a new one applies at once).
      await policy.refresh().catch(() => false);
      const where = policy.feedbackTo(FEEDBACK_TO);
      if ("problem" in where) { vscode.window.showWarningMessage(`Solder: ${where.problem}`); return; }
      const version = context.extension?.packageJSON?.version ?? "";
      const body = `\n\n\n---\nSolder ${version} · VS Code ${vscode.version} · ${process.platform} ${os.release()}\n` +
        "(For a problem: ⋯ → Copy diagnostics in Solder's panel, then paste them here.)\n";
      const link = `mailto:${where.to}?subject=${encodeURIComponent(FEEDBACK_SUBJECT)}&body=${encodeURIComponent(body)}`;
      return vscode.env.openExternal(vscode.Uri.parse(link, true));
    }),
    vscode.commands.registerCommand("solder.copyDiagnostics", async () => {
      await vscode.env.clipboard.writeText(panel.diagnostics());
      vscode.window.showInformationMessage("Solder: diagnostics copied (versions, settings in outline, and the recent log: no paths, code or keys). Paste them into your email.");
    }),
    vscode.commands.registerCommand("solder.showLog", () => output.show(true)),
    vscode.commands.registerCommand("solder.openGuide", () =>
      vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.joinPath(context.extensionUri, "README.md"))),
    vscode.commands.registerCommand("solder.useFolder", async (/** @type {vscode.Uri | undefined} */ uri) => {
      await vscode.commands.executeCommand("solder.chat.focus");
      if (uri) await panel.setFolder(uri.fsPath);
      else await panel.chooseFolder();
    }),
    vscode.commands.registerCommand("solder.explainSelection", () => panel.fromEditor("explain")),
    vscode.commands.registerCommand("solder.fixSelection", () => panel.fromEditor("fix")),
    vscode.commands.registerCommand("solder.addSelection", () => panel.fromEditor("add")),
    vscode.commands.registerCommand("solder.useAsDocs", async (/** @type {vscode.Uri | undefined} */ uri) => {
      const folder = uri?.fsPath ?? (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false,
        openLabel: "Use as Solder docs" }))?.[0]?.fsPath;
      if (!folder) return;
      const about = await vscode.window.showInputBox({ title: "Solder: what's in this docs folder?",
        prompt: "A few words that tell the model when to look here (optional), for example: PX-40 schematics and the FooBus API",
        value: "" });
      if (about === undefined) return; // cancelled
      if (policy.locked("docsFolders")) { vscode.window.showInformationMessage("Your organization sets Solder's docs folders."); return; }
      const config = solderSettings();
      const list = (config.own("docsFolders", []) || []).filter((/** @type {any} */ item) =>
        String(typeof item === "string" ? item : item?.path ?? "").toLowerCase() !== folder.toLowerCase());
      list.push(about.trim() ? { path: folder, about: about.trim() } : folder);
      await config.update("docsFolders", list, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Solder will search ${folder} as docs. It's indexed in the background.`);
    }),
    vscode.commands.registerCommand("solder.useAsSkills", async (/** @type {vscode.Uri | undefined} */ uri) => {
      if (policy.locked("skillsFolders")) { vscode.window.showInformationMessage("Your organization sets Solder's skills folders."); return; }
      const folder = uri?.fsPath ?? (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false,
        openLabel: "Use as Solder skills", title: "Solder: a folder of your skills (one .md file each)" }))?.[0]?.fsPath;
      if (!folder || !(await panel.addSkillsFolder(folder))) return;
      const found = panel.tools.skills().filter((skill) => path.dirname(skill.path).toLowerCase() === path.resolve(folder).toLowerCase()).length;
      vscode.window.showInformationMessage(found ? `Solder now offers the ${found === 1 ? "skill" : `${found} skills`} in ${folder}.`
        : `Solder will offer the skills in ${folder}: there are none yet (each is a .md file starting with "When to use: …").`);
    }),
    vscode.commands.registerCommand("solder.newSkill", () => panel.newSkill()),
    vscode.commands.registerCommand("solder.newChat", async () => {
      await vscode.commands.executeCommand("solder.chat.focus");
      await panel.onMessage({ type: "new" });
    }),
  );
}

/**
 * @param {import("./key.js").SavedKey} savedKey @param {vscode.OutputChannel} output
 * @param {() => Promise<void>} [refresh] the panel's model list, read again after a model is marked as an Assist model
 */
async function checkConnection(savedKey, output, refresh) {
  const config = solderSettings();
  output.show(true);
  const log = (/** @type {string} */ line) => output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
  let client;
  try {
    policy.gate();
    client = new GatewayClient({ endpoint: config.get("endpoint", ""), apiKey: await savedKey.get() });
  } catch (error) {
    log(`Settings: ${message(error)}`);
    vscode.window.showErrorMessage(`Solder: ${message(error)} (Settings → Solder)`);
    return;
  }
  try {
    log("Listing models…");
    let models = await client.models();
    const filter = config.get("modelFilter", "");
    if (filter) {
      try { const pattern = new RegExp(filter, "i"); models = models.filter((id) => pattern.test(id)); }
      catch { log("The model filter isn't a valid regular expression; showing every model."); }
    }
    log(`${models.length} model(s): ${models.join(", ") || "none"}`);
    const model = config.get("model", "") || (models.length ? await vscode.window.showQuickPick(models,
      { placeHolder: "A model for the tool round trip" }) : "");
    if (!model) return;
    const kinds = { toolModels: String(config.get("toolModels", "") || ""), assistModels: (config.get("assistModels", []) || []).map(String) };
    if (laneOf(model, kinds) === "assist") {
      log(`${model} is set as an Assist model: Solder sends it no tools (it writes its tool requests as text), so there's no tool call to test.`);
      vscode.window.showInformationMessage(`Solder: connected. ${model} is set as an Assist model, so it's used without tool calling.`);
      return;
    }
    log(`Asking ${model} to call a tool…`);
    const probe = await probeTools(client, model);
    const first = probe.first;
    log(`Reply in ${first.ms} ms: ${first.calls.length} call(s) ${first.calls.map((/** @type {any} */ c) => c.name).join(", ")}; ` +
      `${first.usage?.total_tokens ?? "?"} tokens${first.credits ? `; ${first.credits.remaining} of ${first.credits.limit} ${first.credits.bucket} left` : ""}`);
    if (!probe.calls) {
      log("The model answered without calling the tool: tool calling isn't on for it, so it's an Assist model to Solder.");
      const MARK = "Mark as an Assist model";
      const pick = await vscode.window.showWarningMessage(`Solder: ${model} answered without calling the tool, so it looks like an Assist model: one your endpoint serves without tool calling. ` +
        `Solder can still use it, with all its tools, once it's marked as one.`, MARK);
      if (pick !== MARK) return;
      if (policy.locked("assistModels") || policy.locked("toolModels")) { vscode.window.showInformationMessage("Your organization sets which models are which."); return; }
      await config.update("assistModels", withAssist(models, kinds, model), vscode.ConfigurationTarget.Global);
      await refresh?.();
      vscode.window.showInformationMessage(`Solder: ${model} is now an Assist model.`);
      return;
    }
    log(`Answer in ${probe.second.ms} ms: ${probe.used ? "it used the tool's result" : "it did NOT use the tool's result"}.`);
    vscode.window.showInformationMessage(probe.used ? `Solder: ${model} works, tool calls included.`
      : `Solder: ${model} answered but ignored the tool result. See the Solder output.`);
  } catch (error) {
    log(`Failed: ${message(error)}`);
    vscode.window.showErrorMessage(`Solder: ${message(error)}`);
  }
}

/** @param {unknown} error */
function message(error) {
  return error instanceof GatewayError ? error.message : "Something went wrong (see the developer tools console).";
}

function deactivate() {}

module.exports = { activate, deactivate, keepChanges };
