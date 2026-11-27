// @ts-nocheck
"use strict";
// One of Solder's checks inside a real VS Code: run with `node check/run.js fixes` (see check/README.md).
// The 2026-11-25 bug hunt's fixes that need a real VS Code: write_file's new and binary files, a Settings screen or the
// guided setup closed while a save is still going, model listings that come back out of order, the status bar after
// switching chats, and a chat whose folder isn't in this window.
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
let REPO = path.resolve(__dirname, "..");
const T = process.env.SOLDER_CHECK_DIR || path.join(require("node:os").tmpdir(), "solder-check");
const LOG = path.join(T, "fixes.log");
const log = (...a) => fs.appendFileSync(LOG, a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ") + "\n");
const check = (name, ok, detail = "") => log(ok ? "PASS" : "FAIL", name, typeof detail === "string" ? detail : JSON.stringify(detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async function () {
  fs.writeFileSync(LOG, `=== fixes ${new Date().toISOString()}\n`);
  try { await Promise.race([main(), sleep(90000).then(() => log("!!! timed out: something is waiting for an answer"))]); } catch (e) { log("!!! harness", String(e && e.stack || e)); }
  log("=== end");
};

/** A promise and its resolve, for answers that come back when the check says. */
function later() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

async function main() {
  const ext = vscode.extensions.getExtension("gremnar.solder");
  await ext.activate();
  check("activates", ext.isActive);
  const loaded = Object.keys(require.cache).filter((key) => /[\\/]src[\\/]policy\.js$/i.test(key));
  if (loaded.length) REPO = path.dirname(path.dirname(loaded[0]));
  const { SolderPanel } = require(path.join(REPO, "src", "panel.js"));
  const { Engine } = require(path.join(REPO, "src", "engine.js"));
  const own = require("node:module").createRequire(path.join(REPO, "src", "panel.js"))("vscode");
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const told = [];
  const oldInfo = own.window.showInformationMessage;
  own.window.showInformationMessage = async (text) => { told.push(String(text)); return undefined; };
  try {
    const panel = new SolderPanel({ secrets: { get: async () => "", store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }) }, subscriptions: [], extension: ext,
      globalStorageUri: vscode.Uri.file(path.join(T, "gs-fixes")), storageUri: undefined, extensionUri: ext.extensionUri }, { appendLine() {}, show() {} });
    panel.view = { webview: { postMessage: () => Promise.resolve(true) }, visible: true };
    const tools = panel.tools;
    const chat = { id: "fx1", messages: [] };

    // ---- write_file: a file that isn't there yet is made (VS Code's own "not found" is recognised as new), and Undo
    // takes it away again; a binary file is refused as one, not with an error from inside.
    const made = path.join(ws, "fx-made-new.txt");
    try { fs.rmSync(made); } catch { /* not there */ }
    let r = await tools.run("write_file", { path: "fx-made-new.txt", content: "made here\n" }, { chat, signal: AbortSignal.timeout(30000) });
    check("write_file makes a file that isn't there yet", !r.failed && fs.existsSync(made) && fs.readFileSync(made, "utf8") === "made here\n", r.output);
    const binary = path.join(ws, "fx-data.bin");
    fs.writeFileSync(binary, Buffer.from([0, 1, 2, 3, 0, 255]));
    r = await tools.run("write_file", { path: "fx-data.bin", content: "text\n" }, { chat, signal: AbortSignal.timeout(30000) });
    check("write_file over a binary file is refused cleanly, and the file is left as it was", r.failed && !/TypeError|ERR_INVALID/.test(r.output) && fs.readFileSync(binary).length === 6, r.output);

    // ---- Settings closed while a save is still going: no error, the setting saved.
    {
      const screen = panel.settingsScreen;
      await screen.open("rules");
      let threw = null;
      const going = screen.handle({ action: "set", field: "rules", value: "Use PowerShell 7." }).catch((e) => { threw = e; });
      screen.close();
      await going;
      check("Settings closed while a field saves: no error, and the setting is saved", !threw && own.workspace.getConfiguration("solder").get("rules") === "Use PowerShell 7.", String(threw));
      await own.workspace.getConfiguration("solder").update("rules", undefined, own.ConfigurationTarget.Global);
    }

    // ---- The guided setup cancelled while its address is saved: no error, and it stays closed.
    {
      await panel.setup.start();
      let threw = null;
      const going = panel.setup.handle({ endpoint: "http://127.0.0.1:9/v1/chat/completions" }).catch((e) => { threw = e; });
      await panel.setup.handle({ action: "cancel" });
      await going;
      check("the guided setup cancelled while a step saves: no error, and it stays closed", !threw && panel.setup.view === null, String(threw));
    }

    // ---- Two model listings, the older answering last: the newer one's models stay.
    {
      await own.workspace.getConfiguration("solder").update("endpoint", "http://127.0.0.1:9/v1/chat/completions", own.ConfigurationTarget.Global);
      await sleep(300); // the change event's own listing goes first
      const answers = [later(), later()];
      let asked = 0;
      panel.client = () => ({ models: () => answers[asked++].promise });
      const first = panel.refreshModels();
      await sleep(50);
      const second = panel.refreshModels();
      await sleep(50);
      answers[1].resolve(["model-new"]);
      await second;
      answers[0].resolve(["model-old"]);
      await first;
      check("model listings answered out of order: the newest one's models are shown", asked === 2 && JSON.stringify(panel.models.map((m) => m.id)) === JSON.stringify(["model-new"]), [asked, panel.models]);
      delete panel.client;
      await own.workspace.getConfiguration("solder").update("endpoint", undefined, own.ConfigurationTarget.Global);
    }

    // ---- The status bar follows the chat shown.
    {
      panel.chat = Engine.newChat();
      panel.chat.usage.tokens = 50_000;
      panel.post();
      const before = panel.statusBar.text;
      await panel.onMessage({ type: "new" });
      check("the status bar shows the chat that's open: a new chat's, not the last one's", /50k/.test(before) && !/50k/.test(panel.statusBar.text), [before, panel.statusBar.text]);
    }

    // ---- A chat whose folder isn't in this window's workspace isn't sent (it would work in this window's folder).
    {
      const away = Engine.newChat();
      away.folder = path.join(T, "fx-elsewhere");
      fs.mkdirSync(away.folder, { recursive: true });
      panel.chat = away;
      told.length = 0;
      await panel.send({ text: "change the script" });
      check("a chat whose folder isn't in this window: not sent, and you're told why", !panel.engine.busy && away.messages.length === 0 && told.some((t) => /isn't in this window's workspace/.test(t)), told);
    }

    // ---- /pet: off until asked for; a name picks one, "corner" gives or takes its corner, anything else is explained.
    {
      panel.chat = Engine.newChat();
      const states = [];
      panel.view = { webview: { postMessage: (m) => { if (m.type === "state") states.push(m); return Promise.resolve(true); } }, visible: true };
      const last = () => states[states.length - 1].pet;
      panel.post();
      check("the pet is off until asked for", last() && last().on === false && last().pet === "bit" && last().corner === true, last());
      await panel.command("pet", "");
      check("/pet shows it", last().on === true && last().pet === "bit", last());
      await panel.command("pet", "Flux");
      check("/pet flux picks that one", last().on === true && last().pet === "flux", last());
      await panel.command("pet", "corner");
      check("/pet corner takes its corner away, and gives it back", last().corner === false, last());
      await panel.command("pet", "corner");
      check("/pet corner gives it back", last().corner === true && last().on === true, last());
      told.length = 0;
      const before = states.length;
      await panel.command("pet", "dragon");
      check("/pet with a name it doesn't have says what it takes, and changes nothing", told.some((t) => /bit, flux, wisp, corner, on or off/.test(t)) && states.length === before && last().pet === "flux", told);
      await panel.command("pet", "");
      check("/pet again hides it, and it's remembered which one it was", last().on === false && last().pet === "flux", last());
      await panel.command("pet", "wisp");
      check("picking one shows it", last().on === true && last().pet === "wisp", last());
      await panel.command("pet", "off");
      // The page: the pet's script is loaded under the page's nonce, from Solder's own folder.
      const page = panel.html({ asWebviewUri: (uri) => uri, cspSource: "vscode-webview:" }, vscode.Uri.joinPath(ext.extensionUri, "media"));
      const nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(page);
      check("the panel's page loads the pet's script under its nonce, with no placeholder left",
        !!nonce && page.includes(`<script nonce="${nonce[1]}" src="`) && /src="[^"]*media\/pet[.]js"><\/script>/.test(page) && !page.includes("{{"), page.slice(-400));
    }
  } finally {
    own.window.showInformationMessage = oldInfo;
  }
}
