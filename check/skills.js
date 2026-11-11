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
  const mine = path.join(home, ".solder", "skills");
  const shared = path.join(T, "skills-shared");
  const org = path.join(T, "skills-org");
  for (const dir of [home, shared, org]) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(shared, { recursive: true });
  fs.mkdirSync(org, { recursive: true });
  fs.writeFileSync(path.join(shared, "code_review.md"), "---\nname: x\ndescription: Reviewing a change before it's committed.\n---\n\nRead the diff first.\nSay what's risky.\n");
  fs.writeFileSync(path.join(org, "branching.md"), "When to use: Naming a git branch.\n\nfeature/<ticket>-<slug>\n");
  await settings().update("skillsFolders", undefined, vscode.ConfigurationTarget.Global);
  const realHome = process.env.USERPROFILE;
  process.env.USERPROFILE = home; // "New skill" makes its default folder in the home folder: a throwaway one here
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
    // ---- the command: New skill, with no skills folder yet
    answers = ["PowerShell Scripts", "Writing or changing a PowerShell script."];
    await vscode.commands.executeCommand("solder.newSkill");
    const first = path.join(mine, "powershell_scripts.md");
    check("New skill makes the default folder and the file", fs.existsSync(first) && fs.readFileSync(first, "utf8") === "When to use: Writing or changing a PowerShell script.\n\n",
      fs.existsSync(first) ? fs.readFileSync(first, "utf8") : "no file");
    check("... adds the folder to your settings", JSON.stringify(settings().get("skillsFolders")) === JSON.stringify([mine]), settings().get("skillsFolders"));
    const editor = vscode.window.activeTextEditor;
    check("... and opens it with the cursor where the instructions go", !!editor && editor.document.uri.fsPath.toLowerCase() === first.toLowerCase() && editor.selection.active.line === 2,
      editor ? [editor.document.uri.fsPath, editor.selection.active.line] : "no editor");
    const validate = asked[0].validateInput;
    check("a name that's taken, or has odd characters, is refused as you type", !!validate("powershell scripts") && !!validate("a/b") && !!validate("  ") && validate("new one") === null,
      [validate("powershell scripts"), validate("a/b"), validate("new one")]);
    answers = ["second", undefined]; // Escape at the second question
    await vscode.commands.executeCommand("solder.newSkill");
    check("cancelled at the second question: nothing made", !fs.existsSync(path.join(mine, "second.md")));
    await editor.edit((e) => e.insert(new vscode.Position(2, 0), "Use approved verbs.\nNo aliases.\n"));
    await editor.document.save();

    // ---- the command: Use as Solder skills (the Explorer's menu passes the folder)
    await vscode.commands.executeCommand("solder.useAsSkills", vscode.Uri.file(shared));
    check("Use as Solder skills adds the folder, and says what it found", JSON.stringify(settings().get("skillsFolders")).toLowerCase() === JSON.stringify([mine, shared]).toLowerCase()
      && /now offers the skill in/.test(told[told.length - 1] || ""), [settings().get("skillsFolders"), told[told.length - 1]]);
    await vscode.commands.executeCommand("solder.useAsSkills", vscode.Uri.file(shared));
    check("... a folder isn't added twice", settings().get("skillsFolders").length === 2);

    // ---- a second panel, to send it what the Settings screen sends
    const subscriptions = [];
    const panel = new SolderPanel({ secrets: { get: async () => "", store: async () => {}, delete: async () => {} }, subscriptions, extension: ext,
      globalStorageUri: vscode.Uri.file(path.join(T, "gs-skills")), storageUri: undefined, extensionUri: ext.extensionUri }, { appendLine() {}, show() {} });
    await panel.onMessage({ type: "settings" });
    let view = panel.settingsScreen.view;
    check("Settings lists both skills, with what each is for", view && view.skills.map((s) => s.name).join() === "powershell_scripts,code_review"
      && view.skills[1].when === "Reviewing a change before it's committed." && view.skills.every((s) => s.offered && !s.org && !s.problem), view && view.skills);
    check("... and says where new ones go", view.skillsHome.toLowerCase() === mine.toLowerCase() && view.skillsFolders.length === 2, [view.skillsHome, view.skillsFolders]);

    answers = ["api endpoints", ""];
    await panel.onMessage({ type: "settingsScreen", action: "newSkill" });
    view = panel.settingsScreen.view;
    const third = path.join(mine, "api_endpoints.md");
    check("Settings → New skill makes one, flagged until it says when to use it", fs.existsSync(third) && view.skills.some((s) => s.name === "api_endpoints" && /no instructions/.test(s.problem)),
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
    let offers = panel.items().filter((i) => i.kind === "undoAll");
    check("each task that changed two or more things ends with Undo all", JSON.stringify(offers) === JSON.stringify([{ kind: "undoAll", at: 0, count: 3 }, { kind: "undoAll", at: 8, count: 2 }])
      && fs.readFileSync(path.join(wsRoot, "ua1.txt"), "utf8") === "ONE and more\n" && fs.existsSync(path.join(wsRoot, "ua3.txt")), offers);
    await panel.onMessage({ type: "undoTask", at: 0 });
    offers = panel.items().filter((i) => i.kind === "undoAll");
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

    // ---- /skill: by hand in a new chat, else a message to the model (with a skills folder made first if there's none)
    const { SKILL } = require(path.join(REPO, "src", "prompt.js"));
    /** @type {any[]} */ const sent = [];
    panel.send = async (message) => { sent.push(message); };
    await settings().update("skillsFolders", undefined, vscode.ConfigurationTarget.Global);
    fs.rmSync(path.join(home, ".solder"), { recursive: true, force: true });
    await panel.onMessage({ type: "command", name: "skill", arg: "how we name branches" });
    check("/skill with what it's for makes your skills folder and asks the model", fs.existsSync(mine) && JSON.stringify(settings().get("skillsFolders")) === JSON.stringify([mine])
      && sent.length === 1 && sent[0].text === SKILL.about("how we name branches") && panel.promptContext().skillsFolder.toLowerCase() === mine.toLowerCase(), [sent, settings().get("skillsFolders")]);
    answers = ["by hand", "Doing it by hand."];
    await panel.onMessage({ type: "command", name: "skill", arg: "" });
    check("/skill alone in a new chat asks you for it instead", sent.length === 1 && fs.existsSync(path.join(mine, "by_hand.md")));
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
    await settings().update("skillsFolders", undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await sleep(300);
  }
}
