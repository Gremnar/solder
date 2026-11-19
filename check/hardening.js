// @ts-nocheck
"use strict";
// One of Solder's checks inside a real VS Code: run with `node check/run.js hardening` (see check/README.md).
// Runs inside a real VS Code extension host. The fixes from the 0.3.0 bug hunt that only show in a real window:
// a running task keeps its folder when you try to send from another chat; a file attached by its path is read without
// asking only once it's sent, and only in that chat; attachments stay with their chat; a chat works in its own folder
// whichever window opens it; a project's skills folder that's a link out of the project isn't used; git doesn't run a
// repository's own filter programs; Paste in terminal takes control characters out; a fresh profile stays read-only.
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
let REPO = path.resolve(__dirname, "..");
const T = process.env.SOLDER_CHECK_DIR || path.join(require("node:os").tmpdir(), "solder-check");
const LOG = path.join(T, "hardening.log");
const log = (...a) => fs.appendFileSync(LOG, a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ") + "\n");
const check = (name, ok, detail = "") => log(ok ? "PASS" : "FAIL", name, typeof detail === "string" ? detail : JSON.stringify(detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async function () {
  fs.writeFileSync(LOG, `=== hardening ${new Date().toISOString()}\n`);
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
  const { SolderPanel, withoutControls } = require(path.join(REPO, "src", "panel.js"));
  const { keepChanges } = require(path.join(REPO, "src", "extension.js"));
  const { readOnly } = require(path.join(REPO, "src", "config.js"));
  const { Engine } = require(path.join(REPO, "src", "engine.js"));
  const own = require("node:module").createRequire(path.join(REPO, "src", "panel.js"))("vscode");
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const raw = () => vscode.workspace.getConfiguration("solder");
  const made = [path.join(ws, "alpha"), path.join(ws, "beta"), path.join(ws, "linked-proj"), path.join(ws, "third_party"), path.join(T, "gs-hardening"), path.join(T, "outside-hardening")];
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  for (const dir of [made[0], made[1], made[5]]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(ws, "alpha", "sample.txt"), "alpha\n");
  fs.writeFileSync(path.join(ws, "beta", "sample.txt"), "beta\n");

  const told = [];
  const undo = [stub(own.window, "showWarningMessage", async () => undefined), stub(own.window, "showInformationMessage", async (text) => { told.push(String(text)); return undefined; })];
  const refresh = policy.refresh;
  policy.refresh = async () => false;
  try {
    const panel = new SolderPanel({ secrets: { get: async () => "", store: async () => {}, delete: async () => {} }, subscriptions: [], extension: ext,
      globalStorageUri: vscode.Uri.file(path.join(T, "gs-hardening")), storageUri: undefined, extensionUri: ext.extensionUri }, { appendLine() {}, show() {} });
    panel.refreshModels = async () => {};
    const posted = [];
    panel.view = { webview: { postMessage: (m) => { posted.push(m); return Promise.resolve(true); } }, visible: true };
    const asked = [];
    panel.engine.ask = async (chat, text, extra) => { asked.push({ chat, text, extra }); if (extra?.attachments?.length) chat.messages.push({ role: "user", content: text, meta: { typed: text, attachments: extra.attachments } }); };
    const where = (name) => panel.tools.resolve(name).full.toLowerCase();

    // ---- a running task keeps its folder: a send from another chat is refused before anything is prepared
    const a = Engine.newChat();
    a.folder = "alpha";
    const b = Engine.newChat();
    b.folder = "beta";
    panel.chat = a;
    panel.useChat(a);
    check("a chat's relative paths are in its folder", where("sample.txt") === path.join(ws, "alpha", "sample.txt").toLowerCase(), where("sample.txt"));
    panel.engine.busy = true;
    panel.runId = a.id;
    panel.runChat = a;
    panel.chat = b; // you open another chat while the task runs
    panel.attachPaste(Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n"));
    posted.length = 0;
    await panel.send({ text: "do this in beta" });
    check("Send from another chat while a task runs is refused, and your words go back in the box", asked.length === 0 && /Solder is working in/.test(told.join(" "))
      && posted.some((m) => m.type === "restore" && m.text === "do this in beta"), [asked.length, told, posted.filter((m) => m.type === "restore")]);
    check("... and the running task's paths are still in its own folder", where("sample.txt") === path.join(ws, "alpha", "sample.txt").toLowerCase(), where("sample.txt"));
    panel.selectionBlock({ selection: { isEmpty: false, start: { line: 0 }, end: { line: 1, character: 0 } }, document: { uri: vscode.Uri.file(path.join(ws, "beta", "sample.txt")), getText: () => "beta", languageId: "plaintext" } });
    panel.useChat(b);
    check("... whatever else the other chat does meanwhile", where("sample.txt") === path.join(ws, "alpha", "sample.txt").toLowerCase(), where("sample.txt"));
    check("... and what's attached there stays there, unsent", panel.attachments.length === 1 && (panel.drafts.get(a.id) || []).length === 0);
    panel.engine.busy = false;
    panel.useChat(b);
    check("once the task is done, the open chat's folder is used", where("sample.txt") === path.join(ws, "beta", "sample.txt").toLowerCase(), where("sample.txt"));
    panel.attachments = [];

    // ---- attachments belong to their chat; a file sent by its path is read without asking from then, in that chat only
    const big = path.join(T, "outside-hardening", "big.log");
    fs.writeFileSync(big, Array.from({ length: 4000 }, (_, i) => `entry ${i + 1}: something happened here`).join("\n"));
    const asks = () => panel.tools.needsApproval("read_file", { path: big }) !== null;
    panel.chat = a;
    panel.useChat(a);
    check("a file outside the workspace is asked about", asks());
    await panel.attachFiles([vscode.Uri.file(big)]);
    check("picked (too long to send whole, so by its path), it's still asked about: nothing is sent yet", panel.attachments[0]?.kind === "path" && asks(), panel.attachments.map((x) => x.kind));
    await panel.onMessage({ type: "removeAttachment", id: panel.attachments[0].id });
    check("... taken off again, it's asked about as ever", panel.attachments.length === 0 && asks());
    await panel.attachFiles([vscode.Uri.file(big)]);
    panel.chat = b;
    check("another chat doesn't have this chat's unsent attachment", panel.attachments.length === 0);
    panel.chat = a;
    await panel.send({ text: "what's in the log?" });
    check("sent with a message, the task reads it without asking", asked.length === 1 && !asks() && panel.attachments.length === 0, [asked.length, panel.attachments.length]);
    panel.chat = b;
    panel.useChat(b);
    check("... in that chat only: another chat is asked", asks());
    panel.chat = a;
    panel.useChat(a);
    check("... and back in the chat it was sent in, it still isn't", !asks());
    a.messages = [];
    panel.useChat(a);
    check("... until the message it went with is gone (deleted, or edited away)", asks());

    // ---- what's attached goes whole only up to a budget; the rest by its path; each chip says what it costs
    {
      const state = () => { posted.length = 0; panel.post(); return posted.filter((m) => m.type === "state").at(-1); };
      const lines = (mark, count) => Array.from({ length: count }, (_, i) => `${mark} ${i}: ${"x".repeat(40)}`).join("\n");
      const first = lines("first", 600); // about 30,000 characters each
      const second = lines("second", 600);
      const e = Engine.newChat();
      panel.chat = e;
      panel.useChat(e);
      panel.attachPaste(first);
      panel.attachPaste(second);
      const file = path.join(T, "outside-hardening", "notes.txt");
      fs.writeFileSync(file, lines("note", 100));
      await panel.attachFiles([vscode.Uri.file(file)]);
      let chips = state().attachments;
      check("each chip says what it costs: about how many tokens sent whole, or that it goes by its path",
        chips.length === 3 && chips[0].byPath === false && Math.abs(chips[0].tokens - first.length / 4) < 2 && chips[1].byPath === true && chips[1].tokens === 0
        && chips[2].byPath === false && chips[2].tokens > 1000, chips.map((c) => [c.label, c.tokens, c.byPath]));
      asked.length = 0;
      await panel.send({ text: "what do these say?" });
      const context = asked[0]?.extra.context || "";
      const saved = /It's saved as (.+?\.txt)\. Read the parts you need/.exec(context)?.[1] || "";
      check("sent: what fits goes whole, in the order attached; the paste that doesn't is saved and goes by its path",
        context.includes("first 0: ") && context.includes("note 0: ") && !context.includes("second 0: ") && /\(Pasted text, 600 lines: too long to send whole\./.test(context)
        && !!saved && fs.existsSync(saved) && fs.readFileSync(saved, "utf8") === second, [context.length, saved]);
      check("... about a budget's worth of text went, not all of it", context.length < 40_000 + 2_000 && context.length > 30_000, context.length);
      check("... the saved paste is in Solder's own storage, and the task reads it without asking", saved.toLowerCase().startsWith(path.join(T, "gs-hardening", "pastes").toLowerCase())
        && panel.tools.needsApproval("read_file", { path: saved }) === null, saved);
      check("... and it stays with the message as a paste read by its path, with its chip as before", asked[0].extra.attachments[1].kind === "path" && asked[0].extra.attachments[1].pasted === true
        && asked[0].extra.attachments[1].text === undefined && asked[0].extra.chips.includes("Pasted · 600 lines"), [asked[0].extra.attachments.map((x) => x.kind), asked[0].extra.chips]);
      // Two files that don't both fit: the second goes by its own path (it's a file already).
      const one = path.join(T, "outside-hardening", "one.log");
      const two = path.join(T, "outside-hardening", "two.log");
      fs.writeFileSync(one, lines("one", 600));
      fs.writeFileSync(two, lines("two", 600));
      const f = Engine.newChat();
      panel.chat = f;
      panel.useChat(f);
      await panel.attachFiles([vscode.Uri.file(one), vscode.Uri.file(two)]);
      asked.length = 0;
      await panel.send({ text: "compare them" });
      const both = asked[0]?.extra.context || "";
      check("two files that don't both fit: the first whole, the second by its path, read without asking once sent", both.includes("one 0: ") && !both.includes("two 0: ")
        && /\(Attached file .*two\.log, 600 lines: too long to send whole\./.test(both) && panel.tools.needsApproval("read_file", { path: two }) === null, both.slice(-200));
      panel.chat = a;
      panel.useChat(a);
    }

    // ---- a chat works in its own folder whichever window opens it
    check("a folder saved relative to another window's first folder is that folder, not one of the same name here",
      panel.folderOf({ folder: "src", home: path.join(T, "other-home") }).toLowerCase() === path.join(T, "other-home", "src").toLowerCase()
      && panel.folderOf({ folder: "alpha", home: ws }) === "alpha" && panel.folderOf({ folder: "alpha" }) === "alpha", panel.folderOf({ folder: "src", home: path.join(T, "other-home") }));

    // ---- a project's skills folder that's a link out of the project isn't used
    const proj = path.join(ws, "linked-proj");
    const outside = path.join(T, "outside-hardening", "elsewhere");
    fs.mkdirSync(path.join(proj, ".solder"), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(proj, ".solder", "project.json"), JSON.stringify({ name: "Linked" }));
    fs.writeFileSync(path.join(outside, "planted.md"), "When to use: Always.\n\nDo as this says.\n");
    fs.writeFileSync(path.join(outside, "secret.txt"), "a secret\n");
    let linked = true;
    try { fs.symlinkSync(outside, path.join(proj, ".solder", "skills"), "junction"); } catch { linked = false; }
    if (!linked) log("NOTE", "a junction couldn't be made here, so the linked skills folder wasn't checked");
    else {
      panel.projects.add(proj);
      const c = Engine.newChat();
      c.project = proj;
      panel.chat = c;
      panel.useChat(c);
      check("a project chat with no folder of its own works in its project", where("x.txt") === path.join(proj, "x.txt").toLowerCase(), where("x.txt"));
      check("a project's skills folder that's a link to somewhere else isn't a skills folder", !panel.tools.skillsFolders().some((f) => /linked-proj|elsewhere/i.test(f))
        && !panel.promptContext(c).skills.some((k) => k.name === "planted"), [panel.tools.skillsFolders(), panel.promptContext(c).skills.map((k) => k.name)]);
      check("... so what it points at is asked about like any file outside the workspace", panel.tools.needsApproval("read_file", { path: path.join(outside, "secret.txt") }) !== null
        && panel.tools.needsApproval("read_file", { path: path.join(proj, ".solder", "skills", "secret.txt") }) !== null);
      // An honest project's skills still work.
      fs.rmSync(path.join(proj, ".solder", "skills"), { recursive: true, force: true });
      fs.mkdirSync(path.join(proj, ".solder", "skills"));
      fs.writeFileSync(path.join(proj, ".solder", "skills", "honest.md"), "When to use: Here.\n\nFine.\n");
      panel.useChat(c);
      check("a real skills folder in the project is used as before", panel.promptContext(c).skills.some((k) => k.name === "honest")
        && panel.tools.needsApproval("read_file", { path: path.join(proj, ".solder", "skills", "honest.md") }) === null, panel.promptContext(c).skills.map((k) => k.name));
      panel.projects.remove(proj);
    }

    // ---- git: a repository's own filter programs aren't run
    const repo = path.join(ws, "third_party", "lib");
    let git = true;
    try {
      fs.mkdirSync(repo, { recursive: true });
      const run = (...args) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
      run("init", "-q");
      run("config", "user.email", "t@example.com");
      run("config", "user.name", "t");
      fs.writeFileSync(path.join(repo, "f.txt"), "one\n");
      run("add", "f.txt");
      run("commit", "-q", "-m", "one");
      run("config", "filter.x.clean", "sh -c 'echo RAN > ../ran.txt; cat'");
      run("config", "filter.x.required", "true");
      fs.writeFileSync(path.join(repo, ".gitattributes"), "*.txt filter=x\n");
    } catch (e) { git = false; log("NOTE", "git couldn't set up a repository here, so its filters weren't checked: " + String(e && e.message || e).split("\n")[0]); }
    if (git) {
      const marker = path.join(ws, "third_party", "ran.txt");
      const later = new Date(Date.now() + 3600_000);
      fs.utimesSync(path.join(repo, "f.txt"), later, later); // its index entry is stale now: git looks at the file again
      execFileSync("git", ["status", "--porcelain"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
      const runsUnguarded = fs.existsSync(marker);
      fs.rmSync(marker, { force: true });
      const again = new Date(Date.now() + 7200_000);
      fs.utimesSync(path.join(repo, "f.txt"), again, again);
      fs.appendFileSync(path.join(repo, "f.txt"), "two\n");
      const d = Engine.newChat();
      panel.chat = d;
      panel.useChat(d);
      const result = await panel.tools.run("changes", { path: "third_party/lib" }, { chat: d, signal: AbortSignal.timeout(30000) }).catch((e) => ({ output: "ERROR " + String(e && e.message || e) }));
      if (!runsUnguarded) log("NOTE", "plain git didn't run the filter here either, so this shows only that the changes tool works in such a repository");
      check("the changes tool shows a nested repository's changes without running the programs its config names", !fs.existsSync(marker) && /f\.txt/.test(String(result.output)) && !/^ERROR/.test(String(result.output)),
        [fs.existsSync(marker), String(result.output).slice(0, 200)]);
    }

    // ---- the right-click menu on a file's name in an answer
    {
      panel.engine.busy = false;
      panel.chat = a;
      panel.useChat(a);
      const clip = own.env.clipboard;
      const had = await clip.readText();
      const revealed = [];
      const real = own.commands.executeCommand;
      const back = stub(own.commands, "executeCommand", async (id, ...rest) => { if (id === "revealFileInOS") { revealed.push(rest[0]?.fsPath); return; } return real.call(own.commands, id, ...rest); });
      try {
        await panel.onMessage({ type: "pathAction", action: "copy", path: "sample.txt:12", shown: "sample.txt" });
        check("Copy on a file's name copies the name as shown", await clip.readText() === "sample.txt", await clip.readText());
        await panel.onMessage({ type: "pathAction", action: "copyPath", path: "sample.txt:12", shown: "sample.txt" });
        check("Copy as path copies its full path, in the chat's folder, without the line number", (await clip.readText()).toLowerCase() === path.join(ws, "alpha", "sample.txt").toLowerCase(), await clip.readText());
        await panel.onMessage({ type: "pathAction", action: "reveal", path: "sample.txt", shown: "sample.txt" });
        await panel.onMessage({ type: "pathAction", action: "reveal", path: "no-such-file.txt", shown: "no-such-file.txt" });
        check("Show in Explorer shows a file that's there, and only that", revealed.length === 1 && String(revealed[0]).toLowerCase() === path.join(ws, "alpha", "sample.txt").toLowerCase(), revealed);
        await clip.writeText("untouched");
        await panel.onMessage({ type: "pathAction", action: "something-else", path: "sample.txt", shown: "sample.txt" });
        check("an action that isn't one of the four does nothing", await clip.readText() === "untouched" && revealed.length === 1);
      } finally {
        back?.();
        await clip.writeText(had);
      }
    }

    // ---- Paste in terminal: nothing a shell reads as a key press
    const C = (code) => String.fromCharCode(code);
    check("control characters are taken out of what's pasted in the terminal (tab and new line stay)",
      withoutControls("ls" + C(15) + " -la" + C(27) + "[201~" + C(21) + C(127) + "\tx\r\ny" + C(13) + "z" + C(0x9b)) === "ls -la[201~\tx\ny\nz", JSON.stringify(withoutControls("ls" + C(15) + " -la" + C(27) + "[201~" + C(21) + C(127) + "\tx\r\ny" + C(13) + "z")));

    // ---- a fresh profile stays read-only, even with the gateway's address already in its settings
    const state = new Map();
    const context = (key, storage) => ({ globalState: { get: (k) => state.get(k), update: async (k, v) => { state.set(k, v); } }, secrets: { get: async () => key },
      globalStorageUri: vscode.Uri.file(storage) });
    const before = { readOnly: raw().inspect("readOnly").globalValue, endpoint: raw().inspect("endpoint").globalValue };
    try {
      await raw().update("readOnly", undefined, vscode.ConfigurationTarget.Global);
      await raw().update("endpoint", "https://gateway.invalid/v1/chat/completions", vscode.ConfigurationTarget.Global);
      const fresh = path.join(T, "gs-hardening", "fresh-profile");
      fs.mkdirSync(fresh, { recursive: true });
      await keepChanges(context("", fresh));
      check("only an endpoint in the settings (no key, no chats): read-only, as any new install", readOnly() === true && raw().inspect("readOnly").globalValue === undefined, raw().inspect("readOnly"));
      state.clear();
      fs.mkdirSync(path.join(fresh, "chats"), { recursive: true });
      fs.writeFileSync(path.join(fresh, "chats", "abc.json"), "{}");
      await keepChanges(context("", fresh));
      check("chats saved before read-only mode came in: changes stay on", readOnly() === false);
    } finally {
      await raw().update("readOnly", before.readOnly, vscode.ConfigurationTarget.Global);
      await raw().update("endpoint", before.endpoint, vscode.ConfigurationTarget.Global);
    }

    // ---- settings held to their ranges where they're used
    const ranges = panel.settings();
    check("the step limit and Compact at are within their ranges, whatever the setting says", ranges.maxRounds >= 1 && ranges.maxRounds <= 100 && ranges.compactAt >= 30_000 && ranges.compactAt <= 2_000_000, [ranges.maxRounds, ranges.compactAt]);
    check("no Solder setting can be set by a workspace", Object.entries(ext.packageJSON.contributes.configuration.properties).every(([, value]) => ["application", "machine"].includes(value.scope)));
  } finally {
    for (const back of undo) back?.();
    policy.refresh = refresh;
    // A repository's files are read-only, and VS Code's own git may still be looking at it: tried a few times, then left.
    for (const dir of made) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* the check's folder goes with the run */ } }
  }
}
