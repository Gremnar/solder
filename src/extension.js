// @ts-check
"use strict";
/**
 * Solder's entry point: the chat panel in its own side bar view, the commands, and the connection
 * check (it lists the models, then makes one tool round trip with a pretend tool, from inside the
 * extension host: what matters behind a corporate proxy).
 */
const vscode = require("vscode");
const { GatewayClient, GatewayError } = require("./gateway.js");
const { SolderPanel, KEY } = require("./panel.js");

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const output = vscode.window.createOutputChannel("Solder");
  const panel = new SolderPanel(context);
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
      if (key.trim()) await context.secrets.store(KEY, key.trim());
      else await context.secrets.delete(KEY);
      vscode.window.showInformationMessage(key.trim() ? "Solder: API key saved." : "Solder: API key removed.");
      await panel.refreshModels();
    }),
    vscode.commands.registerCommand("solder.checkConnection", () => checkConnection(context, output)),
    vscode.commands.registerCommand("solder.focus", () => vscode.commands.executeCommand("solder.chat.focus")),
    vscode.commands.registerCommand("solder.setup", async () => {
      await vscode.commands.executeCommand("solder.chat.focus");
      await panel.setup.start();
    }),
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
      const config = vscode.workspace.getConfiguration("solder");
      const list = (config.get("docsFolders", []) || []).filter((/** @type {any} */ item) =>
        String(typeof item === "string" ? item : item?.path ?? "").toLowerCase() !== folder.toLowerCase());
      list.push(about.trim() ? { path: folder, about: about.trim() } : folder);
      await config.update("docsFolders", list, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Solder will search ${folder} as docs. It's indexed in the background.`);
    }),
    vscode.commands.registerCommand("solder.newChat", async () => {
      await vscode.commands.executeCommand("solder.chat.focus");
      await panel.onMessage({ type: "new" });
    }),
  );
}

/** @param {vscode.ExtensionContext} context @param {vscode.OutputChannel} output */
async function checkConnection(context, output) {
  const config = vscode.workspace.getConfiguration("solder");
  output.show(true);
  const log = (/** @type {string} */ line) => output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
  let client;
  try {
    client = new GatewayClient({ endpoint: config.get("endpoint", ""),
      apiKey: (await context.secrets.get(KEY)) ?? "" });
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
    const tools = [{ type: "function", function: { name: "read_file", description: "Returns a text file with line numbers.",
      parameters: { type: "object", properties: { path: { type: "string", description: "The file to read." } },
        required: ["path"] } } }];
    /** @type {any[]} */
    const messages = [
      { role: "system", content: "You are a coding agent. Use read_file to look at files; never guess what one says." },
      { role: "user", content: "What does version.txt say? Read it, then tell me in one line." }];
    log(`Asking ${model} to call a tool…`);
    const first = await client.reply({ model, messages, tools });
    log(`Reply in ${first.ms} ms: ${first.calls.length} call(s) ${first.calls.map((c) => c.name).join(", ")}; ` +
      `${first.usage?.total_tokens ?? "?"} tokens${first.credits ? `; ${first.credits.remaining} of ${first.credits.limit} ${first.credits.bucket} left` : ""}`);
    if (!first.calls.length) {
      log("The model answered without calling the tool: tool calling may not be on for this model.");
      return;
    }
    messages.push({ role: "assistant", content: first.content, tool_calls: first.calls.map((call) => ({ id: call.id,
      type: "function", function: { name: call.name, arguments: call.arguments },
      ...(call.extra ? { extra_content: call.extra } : {}) })) });
    for (const call of first.calls) messages.push({ role: "tool", tool_call_id: call.id, content: "1\tcanary WREN-12" });
    const second = await client.reply({ model, messages, tools });
    const used = /WREN-12/.test(second.content);
    log(`Answer in ${second.ms} ms: ${used ? "it used the tool's result" : "it did NOT use the tool's result"}.`);
    vscode.window.showInformationMessage(used ? `Solder: ${model} works, tool calls included.`
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

module.exports = { activate, deactivate };
