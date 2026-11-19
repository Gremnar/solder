// @ts-nocheck
"use strict";
// One of Solder's checks inside a real VS Code: run with `node check/run.js projects` (see check/README.md).
// Runs inside a real VS Code extension host: a project is a folder with a .solder folder; its chats work in it and get
// its rules and skills (other chats don't); a project someone else set up is asked about first; the title's dropdown
// and the Projects screen show the right chats; renaming and removing; an organization that sets the skills.
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
let REPO = path.resolve(__dirname, "..");
const T = process.env.SOLDER_CHECK_DIR || path.join(require("node:os").tmpdir(), "solder-check");
const LOG = path.join(T, "projects.log");
const log = (...a) => fs.appendFileSync(LOG, a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ") + "\n");
const check = (name, ok, detail = "") => log(ok ? "PASS" : "FAIL", name, typeof detail === "string" ? detail : JSON.stringify(detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async function () {
  fs.writeFileSync(LOG, `=== projects ${new Date().toISOString()}\n`);
  try { await Promise.race([main(), sleep(90000).then(() => log("!!! timed out: something is waiting for an answer"))]); } catch (e) { log("!!! harness", String(e && e.stack || e)); }
  log("=== end");
};

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
  const loaded = Object.keys(require.cache).filter((key) => /[\\/]src[\\/]policy\.js$/i.test(key));
  if (loaded.length) REPO = path.dirname(path.dirname(loaded[0]));
  const { policy } = require(path.join(REPO, "src", "policy.js"));
  const { SolderPanel } = require(path.join(REPO, "src", "panel.js"));
  const { Engine } = require(path.join(REPO, "src", "engine.js"));
  const own = require("node:module").createRequire(path.join(REPO, "src", "panel.js"))("vscode");
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const mine = path.join(ws, "decloning");
  const theirs = path.join(ws, "shared-proj");
  for (const dir of [mine, theirs, path.join(T, "gs-projects")]) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(mine, { recursive: true });
  fs.mkdirSync(path.join(theirs, ".solder", "skills"), { recursive: true });
  fs.writeFileSync(path.join(theirs, ".solder", "project.json"), JSON.stringify({ name: "Shared tooling" }));
  fs.writeFileSync(path.join(theirs, ".solder", "skills", "their_way.md"), "When to use: Anything in this project.\n\nDo it their way.\n");
  fs.writeFileSync(path.join(theirs, "AGENTS.md"), "Their rules.\n");

  const asked = [];
  let answer;
  const undo = [stub(own.window, "showWarningMessage", async (text, options, ...buttons) => { asked.push({ text: String(text), detail: options?.detail || "", buttons }); return answer; }),
    stub(own.window, "showInformationMessage", async () => undefined)];
  check("VS Code's prompts can be stood in for", undo.every(Boolean));
  const refresh = policy.refresh;
  policy.refresh = async () => false;
  try {
    const panel = new SolderPanel({ secrets: { get: async () => "", store: async () => {}, delete: async () => {} }, subscriptions: [], extension: ext,
      globalStorageUri: vscode.Uri.file(path.join(T, "gs-projects")), storageUri: undefined, extensionUri: ext.extensionUri }, { appendLine() {}, show() {} });
    panel.refreshModels = async () => {};
    const posted = [];
    panel.view = { webview: { postMessage: (m) => { posted.push(m); return Promise.resolve(true); } }, visible: true };
    const state = () => { posted.length = 0; panel.post(); return posted.filter((m) => m.type === "state").at(-1); };

    // ---- a new project: the folder gets a .solder folder, and it's on your list
    await panel.addProject(mine);
    check("New project makes the folder a project (.solder, a place for skills), named after it, and opens its page",
      fs.existsSync(path.join(mine, ".solder", "project.json")) && fs.statSync(path.join(mine, ".solder", "skills")).isDirectory()
      && panel.projects.has(mine) && panel.projectsView?.page.toLowerCase() === mine.toLowerCase() && asked.length === 0, [panel.projects.paths(), panel.projectsView]);
    let s = state();
    check("... the Projects screen lists it, with its page", s.projects.projects.length === 1 && s.projects.projects[0].name === "decloning" && s.projects.page?.name === "decloning"
      && s.projects.page.rules.length === 0 && s.projects.page.skills.length === 0, s.projects);
    check("... and a project found in this window that isn't yours yet is offered, not used", s.projects.found.length === 0 || s.projects.found.every((f) => f.name !== "decloning"), s.projects.found);

    // ---- its rules and a skill, made from its page
    await panel.onMessage({ type: "projectRules", path: mine });
    const rules = path.join(mine, "AGENTS.md");
    check("Rules: the project's AGENTS.md is made (in the project's folder) and opened", fs.existsSync(rules) && (vscode.window.activeTextEditor?.document.uri.fsPath || "").toLowerCase() === rules.toLowerCase());
    fs.writeFileSync(rules, "Target SQL Server 2019. Never drop a database.\n");
    await panel.onMessage({ type: "projectSkillNew", path: mine, name: "restore steps", when: "Restoring a database copy." });
    const skillFile = path.join(mine, ".solder", "skills", "restore_steps.md");
    check("New skill on the page goes in the project's own skills folder, not yours", fs.existsSync(skillFile)
      && JSON.stringify(vscode.workspace.getConfiguration("solder").get("skillsFolders") || []).toLowerCase().indexOf("decloning") < 0, vscode.workspace.getConfiguration("solder").get("skillsFolders"));
    fs.writeFileSync(skillFile, "When to use: Restoring a database copy.\n\nTake the tail-log backup first.\n");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    s = state();
    check("... and the page shows the rules and the skill in full, to read", s.projects.page.rules[0]?.text.includes("Never drop a database") && s.projects.page.skills[0]?.name === "restore_steps"
      && s.projects.page.skills[0].text.includes("tail-log backup"), s.projects.page);

    // ---- a chat in the project: its folder, its rules, its skills
    await panel.newProjectChat(mine);
    const chat = panel.chat;
    check("New chat in the project works in its folder, and the screen closes", chat.project?.toLowerCase() === mine.toLowerCase() && chat.folder === "decloning" && panel.projectsView === null, [chat.project, chat.folder]);
    let context = panel.promptContext(chat);
    check("the model gets the project's rules, named by where they are", context.instructions.some((i) => i.path === "decloning/AGENTS.md" && i.text.includes("Never drop a database")), context.instructions.map((i) => i.path));
    check("... and its skill, with yours", context.skills.some((k) => k.name === "restore_steps" && k.path.toLowerCase() === skillFile.toLowerCase()), context.skills.map((k) => k.name));
    check("... the rules file isn't brought along again by the first read in that folder", (chat.agentsSeen || []).includes(rules.toLowerCase()));
    check("... reading the project's skill needs no approval, and comes back as a skill", panel.tools.needsApproval("read_file", { path: skillFile }) === null);
    const plain = Engine.newChat();
    panel.useChat(plain);
    context = panel.promptContext(plain);
    check("a chat that isn't in the project gets neither", !context.instructions.some((i) => i.path.startsWith("decloning/")) && !context.skills.some((k) => k.name === "restore_steps"),
      [context.instructions.map((i) => i.path), context.skills.map((k) => k.name)]);
    panel.useChat(chat);
    await panel.onMessage({ type: "settings" });
    check("Settings → Skills lists your own skills, not the open chat's project's", !panel.settingsScreen.view.skills.some((k) => k.name === "restore_steps"), panel.settingsScreen.view.skills.map((k) => k.name));
    await panel.onMessage({ type: "settingsScreen", action: "close" });

    // ---- the lists: the title's dropdown is the project's chats; the screen groups them
    chat.messages.push({ role: "user", content: "restore it", meta: { typed: "restore it" } }, { role: "assistant", content: "Done." });
    chat.title = "Restore the copy";
    await panel.store.save(chat);
    plain.messages.push({ role: "user", content: "hello", meta: { typed: "hello" } }, { role: "assistant", content: "Hi." });
    plain.title = "Just a question";
    await panel.store.save(plain);
    s = state();
    const grouped = (/** @type {any} */ st) => st.chats.map((/** @type {any} */ c) => c.title + (c.project ? " @" + (st.projectList.find((/** @type {any} */ p) => p.key === c.project)?.name ?? "?") : "")).sort().join();
    check("the dropdown gets every chat marked with its project, the projects to group them by, and the chip names this chat's", grouped(s) === "Just a question,Restore the copy @decloning" && s.project?.name === "decloning" && s.project.key === s.projectList[0]?.key && s.projectList[0].missing === false, [grouped(s), s.project, s.projectList]);
    await panel.onMessage({ type: "new" });
    check("New chat (the + button) is in no project, and not in the project's folder", !panel.chat.project && !panel.chat.folder && panel.chat.id !== chat.id && state().project === null && panel.tools.projectSkills === "", [panel.chat.project, panel.chat.folder, panel.tools.projectSkills]);
    await panel.onMessage({ type: "open", id: plain.id });
    s = state();
    check("in a chat with no project, the dropdown has the same chats and no project chip", grouped(s) === "Just a question,Restore the copy @decloning" && s.project === null, grouped(s));
    await panel.onMessage({ type: "projects" });
    s = state();
    check("the Projects screen groups them: the project with its chat, the rest under other chats", s.projects.projects[0].chats.map((c) => c.title).join() === "Restore the copy"
      && s.projects.other.map((c) => c.title).join() === "Just a question" && s.projects.page === null, s.projects);
    await panel.onMessage({ type: "open", id: chat.id });
    check("opening a chat from the screen closes it", panel.projectsView === null && panel.chat.id === chat.id);

    // ---- a project someone else set up: asked about first
    await panel.onMessage({ type: "projects" });
    s = state();
    check("a project in this window that isn't yours yet is listed as found", s.projects.found.some((f) => f.name === "Shared tooling"), s.projects.found);
    asked.length = 0;
    answer = undefined;
    await panel.addProject(theirs);
    check("taking it on asks first, saying what it brings; no means it isn't used", asked.length === 1 && /Use the project "Shared tooling"\?/.test(asked[0].text) && /rules and 1 skill/.test(asked[0].detail)
      && !panel.projects.has(theirs), asked);
    const outsider = Engine.newChat();
    outsider.project = theirs;
    check("... a chat naming a project that isn't on your list gets nothing from it", !panel.promptContext(outsider).skills.some((k) => k.name === "their_way") && panel.projectOf(outsider) === null);
    answer = "Use project";
    await panel.addProject(theirs);
    check("... yes puts it on your list, as it was made (nothing in its folder is changed)", panel.projects.has(theirs) && JSON.parse(fs.readFileSync(path.join(theirs, ".solder", "project.json"), "utf8")).name === "Shared tooling");
    panel.useChat(outsider);
    check("... and its chats then get its rules and skills", panel.promptContext(outsider).skills.some((k) => k.name === "their_way") && panel.promptContext(outsider).instructions.some((i) => i.text.includes("Their rules")));

    // ---- skills on and off: everywhere (Settings), and in one project (its page)
    const config = () => vscode.workspace.getConfiguration("solder");
    const ownSkills = path.join(T, "own-skills-" + Date.now());
    fs.mkdirSync(ownSkills, { recursive: true });
    fs.writeFileSync(path.join(ownSkills, "own_way.md"), ["When to use: Doing it my way.", "", "My way.", ""].join("\n"));
    const foldersBefore = config().get("skillsFolders");
    undo.push(() => { fs.rmSync(ownSkills, { recursive: true, force: true }); });
    try {
      await config().update("skillsFolders", [ownSkills], vscode.ConfigurationTarget.Global);
      await config().update("skillsOff", undefined, vscode.ConfigurationTarget.Global);
      const offered = (/** @type {any} */ c) => { panel.useChat(c); return panel.promptContext(c).skills.map((/** @type {any} */ k) => k.name).sort().join(); };
      const switchesIn = () => JSON.stringify(JSON.parse(fs.readFileSync(path.join(mine, ".solder", "project.json"), "utf8")).skills ?? {});
      check("to start with, every skill is on: yours in every chat, the project's in its own", offered(plain) === "own_way" && offered(chat) === "own_way,restore_steps", [offered(plain), offered(chat)]);
      await panel.onMessage({ type: "settings", tab: "skills" });
      await panel.onMessage({ type: "settingsScreen", action: "skillSwitch", name: "own_way" });
      check("a skill switched off in Settings isn't named to the model anywhere, and the setting holds its name", offered(plain) === "" && offered(chat) === "restore_steps"
        && JSON.stringify(config().get("skillsOff")) === '["own_way"]' && panel.settingsScreen.view.skills.find((k) => k.name === "own_way")?.on === false,
        [offered(plain), offered(chat), config().get("skillsOff"), panel.settingsScreen.view.skills]);
      check("... it's still a skill when read by its path (off only means not offered)", panel.tools.needsApproval("read_file", { path: path.join(ownSkills, "own_way.md") }) === null);
      await panel.onMessage({ type: "settingsScreen", action: "close" });
      await panel.onMessage({ type: "projectSkillSwitch", path: mine, name: "own_way", on: true });
      await panel.onMessage({ type: "projects", path: mine });
      s = state();
      check("switched on in one project, it's offered in that project's chats only; the page says so", offered(plain) === "" && offered(chat) === "own_way,restore_steps"
        && s.projects.page.yours.some((k) => k.name === "own_way" && k.on === true && k.everywhere === false), [offered(plain), offered(chat), s.projects.page.yours]);
      await panel.onMessage({ type: "projectSkillSwitch", path: mine, name: "restore_steps", on: false });
      s = state();
      check("a project's own skill can be switched off there too", offered(chat) === "own_way" && s.projects.page.skills.some((k) => k.name === "restore_steps" && k.on === false), [offered(chat), s.projects.page.skills]);
      check("... the switches are in the project's own file (so they travel with it), beside its name", switchesIn() === '{"own_way":true,"restore_steps":false}'
        && JSON.parse(fs.readFileSync(path.join(mine, ".solder", "project.json"), "utf8")).name === "decloning", switchesIn());
      await panel.onMessage({ type: "projectSkillSwitch", path: mine, name: "restore_steps", on: true });
      check("... and a switch put back to what the skill is everywhere is taken away", switchesIn() === '{"own_way":true}' && offered(chat) === "own_way,restore_steps", switchesIn());
      await panel.onMessage({ type: "projectSkillSwitch", path: theirs + "-not-mine", name: "own_way", on: false });
      await panel.onMessage({ type: "projectSkillSwitch", path: mine, name: "no_such_skill", on: false });
      check("a switch for a folder that isn't your project, or a skill that isn't there, does nothing", switchesIn() === '{"own_way":true}' && !fs.existsSync(path.join(theirs + "-not-mine", ".solder")));
      await panel.onMessage({ type: "settings", tab: "skills" });
      await panel.onMessage({ type: "settingsScreen", action: "skillSwitch", name: "own_way" });
      check("switched on again in Settings, it's back everywhere and the setting is empty", offered(plain) === "own_way" && !(config().get("skillsOff") || []).length, [offered(plain), config().get("skillsOff")]);
      await panel.onMessage({ type: "settingsScreen", action: "close" });
      await panel.onMessage({ type: "projects" });
    } finally {
      await config().update("skillsFolders", foldersBefore && foldersBefore.length ? foldersBefore : undefined, vscode.ConfigurationTarget.Global);
      await config().update("skillsOff", undefined, vscode.ConfigurationTarget.Global);
    }
    panel.useChat(outsider);

    // ---- light edits: the name; and removing it from your list
    await panel.onMessage({ type: "projectRename", path: mine, name: "SQL decloning" });
    s = state();
    check("renaming saves the name in the project's own file", JSON.parse(fs.readFileSync(path.join(mine, ".solder", "project.json"), "utf8")).name === "SQL decloning"
      && s.projects.projects.some((p) => p.name === "SQL decloning"), s.projects.projects.map((p) => p.name));
    await panel.onMessage({ type: "projectRename", path: mine, name: "  " });
    check("... an empty name is refused, with why", /Give the project a name/.test(panel.projectsView.notice));
    asked.length = 0;
    answer = "Remove";
    await panel.removeProject(mine);
    s = state();
    check("Remove takes it off your list after asking, leaves its folder alone, and its chats go to other chats", !panel.projects.has(mine) && fs.existsSync(skillFile) && fs.existsSync(rules)
      && /Remove "SQL decloning" from your projects\?/.test(asked[0]?.text || "") && s.projects.other.some((c) => c.title === "Restore the copy"), [asked, s.projects.other]);
    panel.useChat(chat);
    check("... and they stop getting its skills", !panel.promptContext(chat).skills.some((k) => k.name === "restore_steps"));

    // ---- an organization that sets the skills leaves no room for a project's
    panel.useChat(outsider);
    policy.apply(new Map([["skillsfolders", [path.join(T, "no-such-org-skills")]]]), "");
    panel.useChat(outsider);
    check("with the skills set by your organization, a project's skills aren't offered", !panel.promptContext(outsider).skills.some((k) => k.name === "their_way"));
    policy.apply(new Map(), "");
  } finally {
    for (const back of undo) back?.();
    policy.apply(new Map(), "");
    policy.refresh = refresh;
    for (const dir of [mine, theirs]) fs.rmSync(dir, { recursive: true, force: true });
  }
}
