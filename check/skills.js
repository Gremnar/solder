// @ts-nocheck
"use strict";
// One of Solder's checks inside a real VS Code: run with `node check/run.js skills` (see check/README.md).
// Runs inside a real VS Code extension host: the skills commands and Settings actions (new, open, delete, folders),
// a skill read through the real tools, the policy over the folders, Send feedback's address, and the token report.
const vscode = require("vscode");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
// The repo this file is in, and the throwaway folder check/run.js made for this run.
let REPO = path.resolve(__dirname, "..");
const T = process.env.SOLDER_CHECK_DIR || path.join(require("node:os").tmpdir(), "solder-check");
const LOG = path.join(T, "skills.log");
const log = (...a) => fs.appendFileSync(LOG, a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ") + "\n");
const check = (name, ok, detail = "") => log(ok ? "PASS" : "FAIL", name, typeof detail === "string" ? detail : JSON.stringify(detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async function () {
  fs.writeFileSync(LOG, `=== skills ${new Date().toISOString()}\n`);
  try { await Promise.race([main(), sleep(90000).then(() => log("!!! timed out: something is waiting for an answer"))]); } catch (e) { log("!!! harness", String(e && e.stack || e)); }
  log("=== end");
};

/** Stand in for one of VS Code's own functions; returns how to put it back (null when it can't be replaced). */
function stub(owner, name, fn) {
  const old = owner[name];
  try { owner[name] = fn; } catch { return null; }
  if (owner[name] !== fn) return null;
  return () => { owner[name] = old; };
}

async function main() {
  const ext = vscode.extensions.getExtension("gremnar.solder");
  await ext.activate();
  check("activates", ext.isActive);
  // The path as VS Code loaded the extension from (the drive letter's case matters to Node's module cache):
  // required through it, these are the extension's own module instances, not second copies.
  REPO = ext.extensionPath;
  const loaded = Object.keys(require.cache).filter((key) => /[\\/]src[\\/]policy\.js$/i.test(key));
  log("extension path:", REPO, "· policy.js loaded as:", loaded);
  if (loaded.length) REPO = path.dirname(path.dirname(loaded[0]));
  const { policy } = require(path.join(REPO, "src", "policy.js"));
  check("the extension's own policy module is the one used here (not a second copy)", Object.keys(require.cache).filter((key) => /[\\/]src[\\/]policy\.js$/i.test(key)).length === 1);
  const { config } = require(path.join(REPO, "src", "config.js"));
  const { SolderPanel } = require(path.join(REPO, "src", "panel.js"));
  const { RESULTS } = require(path.join(REPO, "src", "prompt.js"));
  const settings = () => vscode.workspace.getConfiguration("solder");
  // Solder's own copy of the VS Code API (each extension gets its own): the one its prompts go through. From inside
  // the repo it's the same object this file gets; asked for by Solder's path, it's right wherever this file is.
  const own = require("node:module").createRequire(path.join(REPO, "src", "panel.js"))("vscode");
  check("Solder's own API object is reached", typeof own.window.showInputBox === "function");
  const home = path.join(T, "home");
  const appData = path.join(home, "AppData", "Roaming");
  const mine = path.join(appData, "Solder", "skills");
  const shared = path.join(T, "skills-shared");
  const org = path.join(T, "skills-org");
  for (const dir of [home, shared, org]) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(shared, { recursive: true });
  fs.mkdirSync(org, { recursive: true });
  fs.writeFileSync(path.join(shared, "code_review.md"), "---\nname: x\ndescription: Reviewing a change before it's committed.\n---\n\nRead the diff first.\nSay what's risky.\n");
  fs.writeFileSync(path.join(org, "branching.md"), "When to use: Naming a git branch.\n\nfeature/<ticket>-<slug>\n");
  await settings().update("skillsFolders", undefined, vscode.ConfigurationTarget.Global);
  const realHome = process.env.USERPROFILE;
  const realAppData = process.env.APPDATA;
  process.env.USERPROFILE = home; // New skill makes its default folder in AppData: a throwaway one here
  process.env.APPDATA = appData;
  check("the home folder is the throwaway one", os.homedir() === home, os.homedir());

  // VS Code's prompts, answered here.
  /** @type {any[]} */ const asked = [];
  /** @type {string[]} */ const told = [];
  let answers = [];
  const undo = [
    stub(own.window, "showInputBox", async (options) => { asked.push(options); return answers.shift(); }),
    stub(own.window, "showInformationMessage", async (text) => { told.push(String(text)); return undefined; }),
    stub(own.window, "showWarningMessage", async (text, ...rest) => { told.push(String(text)); return rest.find((x) => x === "Delete" || x === "Undo all"); }),
  ];
  check("VS Code's prompts can be stood in for", undo.every(Boolean));

  try {
    // ---- a second panel, to send it what the Settings screen sends
    const subscriptions = [];
    const panel = new SolderPanel({ secrets: { get: async () => "", store: async () => {}, delete: async () => {} }, subscriptions, extension: ext,
      globalStorageUri: vscode.Uri.file(path.join(T, "gs-skills")), storageUri: undefined, extensionUri: ext.extensionUri }, { appendLine() {}, show() {} });

    // ---- New skill: the command opens Settings at the Skills tab with the form; the form makes it
    await panel.newSkill();
    check("New skill opens Settings at the Skills tab, with the form", panel.settingsScreen.view?.tab === "skills" && panel.settingsScreen.view?.skillForm === true, panel.settingsScreen.view?.tab);
    const create = (name, when) => panel.onMessage({ type: "settingsScreen", action: "createSkill", name, when });
    await create("PowerShell Scripts", "Writing or changing a PowerShell script.");
    const first = path.join(mine, "powershell_scripts.md");
    check("Create makes the default folder (in AppData) and the file", fs.existsSync(first) && fs.readFileSync(first, "utf8") === "When to use: Writing or changing a PowerShell script.\n\n",
      fs.existsSync(first) ? fs.readFileSync(first, "utf8") : "no file");
    check("... adds the folder to your settings, and closes the form", JSON.stringify(settings().get("skillsFolders")) === JSON.stringify([mine]) && panel.settingsScreen.view.skillForm === false,
      settings().get("skillsFolders"));
    const editor = vscode.window.activeTextEditor;
    check("... and opens it with the cursor where the instructions go", !!editor && editor.document.uri.fsPath.toLowerCase() === first.toLowerCase() && editor.selection.active.line === 2,
      editor ? [editor.document.uri.fsPath, editor.selection.active.line] : "no editor");
    await create("powershell scripts", "Again.");
    const taken = panel.settingsScreen.view.notice;
    await create("a/b", "Odd.");
    const odd = panel.settingsScreen.view.notice;
    await create("second", "  ");
    const noWhen = panel.settingsScreen.view.notice;
    check("a taken name, odd characters, or no 'when' is refused with why, and nothing is made", /already a skill/.test(taken) && /Letters, digits/.test(odd) && /Say when/.test(noWhen)
      && !fs.existsSync(path.join(mine, "second.md")), [taken, odd, noWhen]);
    await editor.edit((e) => e.insert(new vscode.Position(2, 0), "Use approved verbs.\nNo aliases.\n"));
    await editor.document.save();

    // ---- the command: Use as Solder skills (the Explorer's menu passes the folder)
    await vscode.commands.executeCommand("solder.useAsSkills", vscode.Uri.file(shared));
    check("Use as Solder skills adds the folder, and says what it found", JSON.stringify(settings().get("skillsFolders")).toLowerCase() === JSON.stringify([mine, shared]).toLowerCase()
      && /now offers the skill in/.test(told[told.length - 1] || ""), [settings().get("skillsFolders"), told[told.length - 1]]);
    await vscode.commands.executeCommand("solder.useAsSkills", vscode.Uri.file(shared));
    check("... a folder isn't added twice", settings().get("skillsFolders").length === 2);

    await panel.onMessage({ type: "settings" });
    let view = panel.settingsScreen.view;
    check("Settings lists both skills, with what each is for", view && view.skills.map((s) => s.name).join() === "powershell_scripts,code_review"
      && view.skills[1].when === "Reviewing a change before it's committed." && view.skills.every((s) => s.offered && !s.org && !s.problem), view && view.skills);
    check("... and says where new ones go", view.skillsHome.toLowerCase() === mine.toLowerCase() && view.skillsFolders.length === 2, [view.skillsHome, view.skillsFolders]);

    await create("api endpoints", "Adding an API endpoint.");
    view = panel.settingsScreen.view;
    const third = path.join(mine, "api_endpoints.md");
    check("Settings' form makes another, flagged until it has instructions", fs.existsSync(third) && view.skills.some((s) => s.name === "api_endpoints" && /no instructions/.test(s.problem)),
      view.skills.find((s) => s.name === "api_endpoints"));
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await panel.onMessage({ type: "settingsScreen", action: "openSkill", name: "code_review" });
    check("clicking a skill opens its file", (vscode.window.activeTextEditor?.document.uri.fsPath || "").toLowerCase() === path.join(shared, "code_review.md").toLowerCase(),
      vscode.window.activeTextEditor?.document.uri.fsPath);
    await panel.onMessage({ type: "settingsScreen", action: "deleteSkill", name: "api_endpoints" });
    check("deleting a skill asks first, then it's gone (from the list too)", !fs.existsSync(third) && /Delete the skill api_endpoints\?/.test(told.join("\n"))
      && !panel.settingsScreen.view.skills.some((s) => s.name === "api_endpoints"), told.slice(-2));

    // ---- what the model is told, and a skill read through the real tools
    const context = panel.promptContext();
    check("the prompt lists the skills and where to save a new one", context.skills.map((s) => s.name).join() === "powershell_scripts,code_review"
      && context.skillsFolder.toLowerCase() === mine.toLowerCase(), context);
    check("reading a skill needs no approval; changing one does", panel.tools.needsApproval("read_file", { path: first }) === null
      && /outside the workspace/.test(String(panel.tools.needsApproval("write_file", { path: first }))));
    const chat = { messages: [] };
    const read = await panel.tools.run("read_file", { path: first, start_line: 1, end_line: 1 }, { chat, signal: AbortSignal.timeout(20000) });
    check("a skill read comes back whole and kept, whatever range was asked", read.output === RESULTS.skillRead("powershell_scripts", 0)
      && read.keep === "Skill: powershell_scripts\nWhen to use: Writing or changing a PowerShell script.\n\nUse approved verbs.\nNo aliases.", read);
    const front = await panel.tools.run("read_file", { path: path.join(shared, "code_review.md") }, { chat, signal: AbortSignal.timeout(20000) });
    check("front matter is read for the when, and left out of the instructions", front.keep === "Skill: code_review\nWhen to use: Reviewing a change before it's committed.\n\nRead the diff first.\nSay what's risky.", front.keep);
    const plain = await panel.tools.run("read_file", { path: path.join(T, "ws", "notes.md") }, { chat, signal: AbortSignal.timeout(20000) });
    check("another .md file is read as a file", !plain.keep && /^1\t/.test(plain.output), plain.summary);

    // ---- diagnostics: numbers only
    const diagnostics = panel.diagnostics();
    check("Copy diagnostics counts the skills and breaks the next request down", /Skills: 2 folder\(s\), 2 found, 2 offered/.test(diagnostics)
      && /The next request as it stands, about [\d,]+ tokens:/.test(diagnostics) && /the tool definitions\s+[\d,]+\s+\d+%/.test(diagnostics), diagnostics.split("\n").slice(4, 14).join(" | "));
    check("... with no path or skill text in it", !diagnostics.includes(mine) && !diagnostics.includes("approved verbs") && !/powershell_scripts/.test(diagnostics));

    // ---- the organization's skills (as if read from the registry)
    // Through policy.read, so reading the policy again (as opening Settings does) finds the same.
    const realRead = policy.read;
    const enforce = async (values) => { policy.read = async (key) => /^HKLM/.test(key) && values ? new Map(Object.entries(values)) : null; await policy.refresh(); };
    await enforce({ SkillsFolders: [org] });
    check("enforced skills folders replace yours, and lock them", JSON.stringify(config().get("skillsFolders", [])) === JSON.stringify([org]) && policy.locked("skillsFolders"));
    check("... the model is offered only those, with nowhere to save a new one", panel.promptContext().skills.map((s) => s.name).join() === "branching" && panel.promptContext().skillsFolder === "",
      panel.promptContext());
    const before = fs.readdirSync(mine).length;
    answers = ["sneaky", "x"];
    await vscode.commands.executeCommand("solder.newSkill");
    await vscode.commands.executeCommand("solder.useAsSkills", vscode.Uri.file(path.join(T, "ws")));
    check("... New skill and Use as Solder skills say so and change nothing", fs.readdirSync(mine).length === before && settings().get("skillsFolders").length === 2
      && told.slice(-2).every((t) => /Your organization sets/.test(t)), told.slice(-2));
    await panel.onMessage({ type: "settings" });
    check("... Settings shows them as the organization's, locked", panel.settingsScreen.view.skillsLocked && panel.settingsScreen.view.skills.every((s) => s.org), panel.settingsScreen.view.skills);
    await panel.onMessage({ type: "settingsScreen", action: "deleteSkill", name: "branching" });
    check("... and an organization's skill can't be deleted", fs.existsSync(path.join(org, "branching.md")));
    await enforce({ SkillsFolders: [org], AllowUserSkills: 1 });
    check("with AllowUserSkills, yours are offered after the organization's", panel.promptContext().skills.map((s) => s.name).join() === "branching,powershell_scripts,code_review"
      && panel.promptContext().skillsFolder.toLowerCase() === mine.toLowerCase(), panel.promptContext().skills.map((s) => s.name));
    policy.read = realRead;
    await policy.refresh();

    // ---- Settings → remove a folder: its files stay
    await panel.onMessage({ type: "settings" });
    await panel.onMessage({ type: "settingsScreen", action: "removeSkills", index: 1 });
    check("removing a folder stops using it, and leaves its files", JSON.stringify(settings().get("skillsFolders")) === JSON.stringify([mine]) && fs.existsSync(path.join(shared, "code_review.md")));

    // ---- a file with no "When to use" in a skills folder: flagged in Settings, not offered to the model
    fs.writeFileSync(path.join(mine, "README.md"), "Notes about this folder, not a skill.\n");
    await panel.onMessage({ type: "settings" });
    const readme = panel.settingsScreen.view.skills.find((s) => s.name === "README");
    check("a file with no When to use line is flagged, and the model isn't told about it", !!readme && !readme.offered && /isn't told about it/.test(readme.problem)
      && !panel.promptContext().skills.some((s) => s.name === "README") && panel.promptContext().skills.some((s) => s.name === "powershell_scripts"), readme);
    fs.rmSync(path.join(mine, "README.md"));

    // ---- Undo all: everything a task changed, put back together
    const wsRoot = path.join(T, "ws");
    fs.writeFileSync(path.join(wsRoot, "ua1.txt"), "one\n");
    fs.writeFileSync(path.join(wsRoot, "ua2.txt"), "two\n");
    fs.rmSync(path.join(wsRoot, "ua3.txt"), { force: true });
    let callNo = 0;
    const change = async (name, args) => {
      const id = "ua" + (++callNo);
      const result = await panel.tools.run(name, args, { chat: panel.chat, signal: AbortSignal.timeout(20000) });
      panel.chat.messages.push({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
        { role: "tool", tool_call_id: id, content: result.output, meta: { name, summary: result.summary, failed: !!result.failed, ...(result.change ? { change: result.change } : {}) } });
      return result;
    };
    panel.chat.messages.length = 0;
    panel.chat.notes = []; // a chat saved by an earlier run of this check may have some
    panel.chat.messages.push({ role: "user", content: "task one" });
    await change("edit_file", { path: "ua1.txt", old_text: "one", new_text: "ONE" });
    await change("edit_file", { path: "ua1.txt", old_text: "ONE", new_text: "ONE and more" });
    await change("write_file", { path: "ua3.txt", content: "new file\n" });
    panel.chat.messages.push({ role: "assistant", content: "Done." }, { role: "user", content: "task two" });
    await change("edit_file", { path: "ua2.txt", old_text: "two", new_text: "TWO" });
    await change("edit_file", { path: "ua2.txt", old_text: "TWO", new_text: "TWO again" });
    panel.chat.messages.push({ role: "assistant", content: "Done too." });
    // Each finished turn folds into one row; the row carries Undo all when two or more changes can be undone.
    const folds = () => panel.items().items.filter((i) => i.kind === "fold");
    let offers = folds().map((f) => f.undoAll).filter(Boolean);
    const shown = panel.items().items.map((i) => i.kind);
    check("a finished turn folds its steps into one row, between your message and the answer", JSON.stringify(shown) === JSON.stringify(["user", "fold", "answer", "user", "fold", "answer"])
      && folds()[0].steps === 3 && folds()[0].changes === 3 && folds()[0].items.every((i) => i.kind === "step"), shown);
    check("each turn that changed two or more things has Undo all", JSON.stringify(offers) === JSON.stringify([{ at: 0, count: 3 }, { at: 8, count: 2 }])
      && fs.readFileSync(path.join(wsRoot, "ua1.txt"), "utf8") === "ONE and more\n" && fs.existsSync(path.join(wsRoot, "ua3.txt")), offers);
    await panel.onMessage({ type: "undoTask", at: 0 });
    offers = folds().map((f) => f.undoAll).filter(Boolean);
    check("Undo all asks, then puts every file back (two edits to one file, and a new file gone)", fs.readFileSync(path.join(wsRoot, "ua1.txt"), "utf8") === "one\n"
      && !fs.existsSync(path.join(wsRoot, "ua3.txt")) && /Undo all 3 changes this task made\?/.test(told.join("\n")) && offers.length === 1 && offers[0].at === 8
      && (panel.chat.notes || []).length === 3 && fs.readFileSync(path.join(wsRoot, "ua2.txt"), "utf8") === "TWO again\n", [fs.readFileSync(path.join(wsRoot, "ua1.txt"), "utf8"), offers, (panel.chat.notes || []).length]);
    // The other task's file is changed by hand: nothing of it is undone, and it says why.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    fs.writeFileSync(path.join(wsRoot, "ua2.txt"), "TWO again, then edited by hand\n");
    await sleep(600);
    await panel.onMessage({ type: "undoTask", at: 8 });
    check("a file changed since is left alone, and Undo all says how far it got", fs.readFileSync(path.join(wsRoot, "ua2.txt"), "utf8") === "TWO again, then edited by hand\n"
      && /undid 0 of 2 changes, then stopped: .*has changed since/.test(told[told.length - 1] || ""), told[told.length - 1]);
    panel.chat.messages.length = 0;
    panel.chat.notes = [];
    for (const name of ["ua1.txt", "ua2.txt"]) fs.rmSync(path.join(wsRoot, name), { force: true });

    // ---- the plan: in the dock while its turn runs, then once, completed, at the end of the turn
    panel.chat.messages.push({ role: "user", content: "plan it" },
      { role: "assistant", content: "", tool_calls: [{ id: "pl1", type: "function", function: { name: "plan", arguments: JSON.stringify({ steps: [{ goal: "A" }, { goal: "B" }] }) } }] },
      { role: "tool", tool_call_id: "pl1", content: "Plan", meta: { name: "plan", summary: "Plan" } },
      { role: "assistant", content: "", tool_calls: [{ id: "rd1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "notes.md" }) } }] },
      { role: "tool", tool_call_id: "rd1", content: "1\t# Notes", meta: { name: "read_file", summary: "Read notes.md" } },
      { role: "assistant", content: "Both done." });
    panel.chat.plan = { steps: [{ goal: "A", state: "done", notes: "" }, { goal: "B", state: "done", notes: "" }] };
    const finished = panel.items();
    check("a finished turn's plan comes once, after its answer, and not in the dock", JSON.stringify(finished.items.map((i) => i.kind)) === JSON.stringify(["user", "fold", "answer", "plan"])
      && finished.livePlan === null, finished.items.map((i) => i.kind));
    const realBusy = Object.getOwnPropertyDescriptor(panel.engine, "busy");
    panel.engine.busy = true; // as if the turn were still running, in this chat
    panel.runId = panel.chat.id;
    const live = panel.items();
    check("while its turn runs, the plan is only in the dock, and the steps aren't folded", !live.items.some((i) => i.kind === "plan" || i.kind === "fold")
      && Array.isArray(live.livePlan) && live.livePlan.length === 2, [live.items.map((i) => i.kind), live.livePlan]);
    if (realBusy) Object.defineProperty(panel.engine, "busy", realBusy); else panel.engine.busy = false;
    panel.chat.messages.length = 0;
    panel.chat.plan = undefined;

    // ---- the step limit: a pause with Continue and Stop here, not an error
    panel.runId = panel.chat.id; // the chat the turn ran in
    panel.onEvent({ type: "done", chat: panel.chat.id, limit: 30 });
    check("a turn stopped at the step limit is a pause, and Stop here clears it", panel.error?.paused === true && /^Paused after 30 steps/.test(panel.error.message), panel.error);
    await panel.onMessage({ type: "dismiss" });
    check("... Stop here clears it", panel.error === null);

    // ---- Settings: opened at a tab, and the fields the Advanced tab gained
    await panel.onMessage({ type: "command", name: "settings", arg: "Skills" });
    check("/settings skills opens Settings at that tab", panel.settingsScreen.view.tab === "skills", panel.settingsScreen.view.tab);
    const set = (field, value) => panel.onMessage({ type: "settingsScreen", action: "set", field, value });
    await set("toolModels", "-tools$");
    await set("assistSessionBlock", "session");
    await set("storageLimit", "2.5");
    check("Tool models, the Assist session block and the storage limit save from Settings", settings().get("toolModels") === "-tools$"
      && settings().get("assistSessionBlock") === "session" && settings().get("storageLimitGB") === 2.5 && panel.settingsScreen.view.storageLimit === 2.5,
      [settings().get("toolModels"), settings().get("assistSessionBlock"), settings().get("storageLimitGB")]);
    await set("toolModels", "([");
    await set("storageLimit", "0");
    check("... and a bad pattern or limit is refused, with why", settings().get("toolModels") === "-tools$" && settings().get("storageLimitGB") === 2.5
      && /storage limit needs/.test(panel.settingsScreen.view.notice), panel.settingsScreen.view.notice);
    for (const name of ["toolModels", "assistSessionBlock", "storageLimitGB"]) await settings().update(name, undefined, vscode.ConfigurationTarget.Global);

    // ---- Advanced → Kinds of model: every model starts a Tool model; an arrow moves one across
    // No gateway here: the model list stays as set (a settings change would otherwise ask the gateway for it again).
    const realRefresh = panel.refreshModels;
    panel.refreshModels = async () => {};
    panel.models = [{ id: "model-a", name: "Model A" }, { id: "model-a-tools", name: "Model A (tools)" }];
    await panel.onMessage({ type: "settings" });
    check("every model starts as a Tool model", panel.settingsScreen.view.kinds.every((m) => !m.assist) && panel.settingsScreen.view.kinds.length === 2, panel.settingsScreen.view.kinds);
    await panel.onMessage({ type: "settingsScreen", action: "moveModel", name: "model-a", index: 1 });
    check("moving one makes it an Assist model, saved as the Assist models list", JSON.stringify(settings().get("assistModels")) === JSON.stringify(["model-a"])
      && panel.settingsScreen.view.kinds.find((m) => m.id === "model-a").assist === true, settings().get("assistModels"));
    const { laneOf, assistTwin } = require(path.join(REPO, "src", "lanes.js"));
    check("... which the engine follows, with model-a as the Tool model's twin", laneOf("model-a", panel.settings()) === "assist" && laneOf("model-a-tools", panel.settings()) === "tool"
      && assistTwin("model-a-tools", panel.settings(), ["model-a", "model-a-tools"]) === "model-a");
    await panel.onMessage({ type: "settingsScreen", action: "moveModel", name: "model-a", index: 0 });
    check("... and back", (settings().get("assistModels") || []).length === 0, settings().get("assistModels"));
    await settings().update("assistModels", undefined, vscode.ConfigurationTarget.Global);
    panel.models = [];
    panel.refreshModels = realRefresh;

    // ---- an enforced model filter applies to what's sent, and one that won't read offers nothing
    await enforce({ ModelFilter: "^model-a$" });
    check("an enforced filter refuses another model", panel.settings().modelAllowed?.("model-b") === false && panel.settings().modelAllowed?.("model-a") === true);
    await enforce({ ModelFilter: "model-(a|b" });
    check("... and one that won't read allows none (it fails closed), and is reported", panel.settings().modelAllowed?.("model-a") === false
      && policy.problems.some((p) => /ModelFilter/.test(p)), policy.problems);
    policy.read = realRead;
    await policy.refresh();

    // ---- /skill: by hand in a new chat, else a message to the model (with a skills folder made first if there's none)
    const { SKILL } = require(path.join(REPO, "src", "prompt.js"));
    /** @type {any[]} */ const sent = [];
    panel.send = async (message) => { sent.push(message); };
    await settings().update("skillsFolders", undefined, vscode.ConfigurationTarget.Global);
    fs.rmSync(path.join(home, ".solder"), { recursive: true, force: true });
    await panel.onMessage({ type: "command", name: "skill", arg: "how we name branches" });
    check("/skill with what it's for makes your skills folder and asks the model", fs.existsSync(mine) && JSON.stringify(settings().get("skillsFolders")) === JSON.stringify([mine])
      && sent.length === 1 && sent[0].text === SKILL.about("how we name branches") && panel.promptContext().skillsFolder.toLowerCase() === mine.toLowerCase(), [sent, settings().get("skillsFolders")]);
    await panel.onMessage({ type: "command", name: "skill", arg: "" });
    check("/skill alone in a new chat opens Settings' New skill form instead", sent.length === 1 && panel.settingsScreen.view?.skillForm === true, panel.settingsScreen.view?.tab);
    panel.chat.messages.push({ role: "user", content: "x" }, { role: "assistant", content: "y" });
    await panel.onMessage({ type: "command", name: "skill", arg: "" });
    check("/skill alone after a task asks the model to save how it was done", sent.length === 2 && sent[1].text === SKILL.fromChat, sent[1]);
    panel.chat.messages.length = 0;
    await enforce({ SkillsFolders: [org] });
    await panel.onMessage({ type: "command", name: "skill", arg: "anything" });
    check("/skill says so when the organization sets the skills", sent.length === 2 && /Your organization sets/.test(told[told.length - 1] || ""), told[told.length - 1]);
    policy.read = realRead;
    await policy.refresh();

    // ---- Send feedback: Solder's address, the organization's, or nothing
    /** @type {string[]} */ const opened = [];
    const external = stub(own.env, "openExternal", async (uri) => { opened.push(uri.toString(true)); return true; });
    if (!external) log("SKIP feedback: vscode.env.openExternal can't be stood in for");
    else {
      const read = policy.read;
      try {
        policy.read = async () => null;
        await vscode.commands.executeCommand("solder.feedback");
        check("feedback goes to Solder's support with no policy", /^mailto:support@gremnar\.com\?subject=/.test(opened[0] || ""), (opened[0] || "").slice(0, 60));
        policy.read = async (key) => /^HKLM/.test(key) ? new Map([["FeedbackAddress", "solder-feedback@corp.example.com"]]) : null;
        await vscode.commands.executeCommand("solder.feedback");
        check("... to the organization's address when its policy sets one", /^mailto:solder-feedback@corp\.example\.com\?subject=/.test(opened[1] || "") && opened.length === 2, (opened[1] || "").slice(0, 70));
        policy.read = async (key) => /^HKLM/.test(key) ? new Map([["FeedbackAddress", "x@corp.example.com?cc=out@elsewhere.example"]]) : null;
        await vscode.commands.executeCommand("solder.feedback");
        check("... and nowhere when that address isn't usable", opened.length === 2 && /isn't a usable email address/.test(told[told.length - 1] || ""), told[told.length - 1]);
        policy.read = async () => { throw new Error("blocked"); };
        await vscode.commands.executeCommand("solder.feedback");
        check("... or when the policy can't be read", opened.length === 2 && /couldn't be read/.test(told[told.length - 1] || ""), told[told.length - 1]);
      } finally {
        policy.read = read;
        await policy.refresh();
        external();
      }
      check("the policy is back as it was on this PC", policy.error === "" && policy.feedbackAddress === null, [policy.error, policy.names]);
    }
    for (const item of subscriptions) { try { item.dispose(); } catch { /* best effort */ } }
  } finally {
    for (const back of undo) back?.();
    process.env.USERPROFILE = realHome;
    process.env.APPDATA = realAppData;
    await settings().update("skillsFolders", undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await sleep(300);
  }
}
