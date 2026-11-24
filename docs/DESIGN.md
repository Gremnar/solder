# Solder: design

Solder is a **lean coding agent in a VS Code side panel**. It talks to an OpenAI-compatible Chat Completions endpoint that supports tool calling: a corporate gateway, a local server, anything that speaks the format. It is meant for technical users who live in VS Code and want an agent beside the editor that does focused work with as few tokens as possible.

It's the sibling of **Alloy**, a general Windows assistant. Solder keeps Alloy's engine lessons and leaves out everything VS Code already does.

## What it is, and what it isn't

| Solder does | Solder leaves out (VS Code or Alloy covers it) |
|---|---|
| A chat panel in the side bar, with streaming answers | A file tree, file previews and an editor: VS Code has them |
| 10 tools: read, symbols, search, find, changes, edit, write, move, remove, problems | Running commands (no shell at all), OneNote, reminders, Excel, the Brain, web fetch |
| Edits you can review in VS Code's diff and undo per step | General-assistant chat and long-term memory |
| Follows `AGENTS.md`, a few simple rules you set, and your skills (one `.md` file each, read when a task needs one) | Skills with scripts, notes and project folders |
| Approval before any change outside the workspace | Builds, tests and scripts: it says what to run, and you run it |
| Token meter, allowance left, compaction | Telemetry, accounts, sign-in |

## Hard rules

1. **No npm packages**, not even dev dependencies. Plain JavaScript with `// @ts-check` and JSDoc types: VS Code type-checks it with nothing installed. Runtime code uses Node built-ins and the `vscode` API only. The `.vsix` is built by our own script.
2. **Nothing deployment-specific in the repo.** No company names, gateway addresses, share paths, model names, keys or logs. Deployment settings go in the user's VS Code settings, or in org policy.
3. **Only the configured endpoint is contacted.** No telemetry, no update checks, no CDN fonts, no GitHub. It must work behind a proxy that blocks everything else.
4. **No dependency on Copilot or GitHub.** The panel is Solder's own webview.
5. **Reliability over breadth.** If a feature can't be made extremely reliable, it doesn't ship.
6. **Every model-facing word is deliberate.** The system prompt and tool texts live in one file (`src/prompt.js`), and a test pins them.

## Architecture

```text
VS Code extension host (Node)
├─ src/extension.js     activate(): commands, status bar, the panel provider
├─ src/panel.js         WebviewViewProvider: posts engine events to the webview, takes its messages
├─ src/engine.js        the tool loop (no `vscode` import: tested under plain node)
├─ src/gateway.js       the HTTP client (done, tested)
├─ src/prompt.js        system prompt, tool definitions, every fixed text the model sees
├─ src/store.js         chats saved as JSON per workspace
├─ src/tools.js         the tools, on the vscode API (the Host the engine calls)
└─ media/               panel.html / panel.css / panel.js: plain DOM, strict CSP, no frameworks
```

- **The engine is separate from VS Code.**
  - `engine.js` takes a `Host` interface: `systemPrompt`, `runTool`, `needsApproval`, `save`.
  - It emits events: `delta`, `thinking`, `message`, `running`, `approval`, `usage`, `retrying`, `compacting`, `done`, `stopped`, `error`.
  - Tests drive it with a fake host and a fake gateway.
- **The panel is a client of engine state.** The webview holds no truth: it renders what the extension posts, and it can be rebuilt from the saved chat at any time. VS Code's Agent Host Protocol uses the same split, which keeps a later AHP adapter possible (see [below](#vs-codes-agent-host-protocol-ahp)).
- **Placement.** Contribute a view container to the activity bar. Users can drag it to the secondary side bar, where it stays, and the README says how.

## The tools

| Tool | Arguments | Built on | Approval |
|---|---|---|---|
| `read_file` | path, start_line?, end_line? | `workspace.openTextDocument` (it sees **unsaved** edits), with line numbers. 2,000 lines or 30k characters at most per read. Word, Excel and PowerPoint files are read as the docs index converts them, so their line numbers match the docs search | none |
| `symbols` | path, name?, find?, line? | With only a path, the outline from `vscode.executeDocumentSymbolProvider`: classes, functions and methods, nested, with line ranges (400 entries at most; a cold language server gets a few seconds). With a name, `executeDefinitionProvider` (the definition's whole body, from the outline's extent) or `executeReferenceProvider` (one line per use, 100 at most). Solder finds the name's position itself, because models are bad at columns. With no language support, it gives whole-word text matches, labelled as such | none |
| `search` | query, regex?, glob?, docs? | VS Code's bundled ripgrep (see below), JS fallback. With `docs: true`, the user's docs folders instead (see below) | none |
| `find_files` | glob | `workspace.findFiles`, which respects `files.exclude` and `.gitignore` | none |
| `changes` | path? | `git` started directly: one fixed program, no shell. It uses the path VS Code's git extension found, with `--no-ext-diff --no-textconv`, no pager, no fsmonitor and no optional locks, so a repo's config can't make Solder run other programs. With no path: status plus line counts, and the diff when it's 12k characters or less. With a path: that file's or folder's diff against HEAD. New files are listed, and unsaved editor changes are flagged | none |
| `edit_file` | path, old_text, new_text | one `WorkspaceEdit`, then save. `old_text` must be unique. Keeps the file's line endings. Accepts a match that differs only in trailing whitespace | none (Undo kept); asks as `write_file` does |
| `write_file` | path, content | create or overwrite through `WorkspaceEdit`, then save | none inside the workspace; asks outside it, and for git's and VS Code's own files, a rules file and a project's `.solder` folder |
| `move_item` | from, to, copy? | `workspace.fs.rename` or `copy` (plain file operations, not a rename with import updates, which would change files Undo doesn't cover). `to` that's a folder, or ends with `/`, means into it; missing folders are created; it never overwrites, and refuses a file with unsaved editor changes. After a move it lists up to 20 lines that still mention the old name, so the model fixes them (a note alone was ignored three times in four). Undo moves it back, or removes the copy | asks when anything leaves or enters the workspace, and for the same files as `write_file` |
| `problems` | path? | `languages.getDiagnostics` (errors and warnings, capped) | none |

Details that matter:
- **After every edit or write, include the file's new problems.** Wait up to about 2 s for `onDidChangeDiagnostics` on that file, then add any new errors to the result: "New problems in app.ts: 42: Cannot find name 'x'". This is the biggest token saver available. The model sees a broken edit at once instead of running a build to find out.
- **Ripgrep.** VS Code ships `rg.exe` inside its install. In 1.141 it is at `<appRoot>/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/win32-x64/rg.exe`; older builds have `@vscode/ripgrep/bin/rg.exe`. Probe both from `vscode.env.appRoot`. If neither exists, or policy blocks it, fall back to a JS search over `findFiles` with size caps. Output: `path:line: text`, at most 200 matches.
- **No plan tool (decided 2026-11-16).** Solder had a `plan` tool (a checklist the model set and ticked off). An A/B on six multi-step scenarios, three runs each on two models, passed 36/36 both ways, but without plans the same work cost 36% and 53% fewer tokens, with about half the requests: the cost was the extra round trips to set and update it. Frontier models keep to a task without one. Old chats' plan calls are left out of what's sent.
- **Paste in terminal (decided 2026-11-17).** A shell's code block in an answer (powershell, bash, cmd and the like) has **Paste in terminal** beside Copy: the code goes into VS Code's terminal for the user to run. It's the user's action, and Solder still runs nothing: nothing presses Enter (trailing newlines are dropped); one line is typed in, several go through VS Code's own terminal paste, which warns before a multi-line paste where the shell would run each line as it arrives. Within the organization's AI policy, approved by the user.
- **No shell (decided 2026-11-04).** Solder never starts PowerShell or any other shell, so Constrained Language mode, AppLocker and endpoint security have nothing to trip over, and the model can't fall into script loops (Alloy's worst token burns). It checks its work through `problems`, and says what to build or test for the user to run. If running things is missed later, add narrow, read-only tools that start one program directly (`git diff`, `git status`), never a general shell.
- **Docs search** (`src/docs.js`, ported from Alloy's docsearch).
  - **Where:** the user's `solder.docsFolders`, a per-user setting, are indexed in a local SQLite FTS5 index: `node:sqlite`, which VS Code's runtime ships, with porter stemming and BM25 ranking.
  - **How files are split:** into sections of about 1,400 characters, each located by its lines and the heading above it. A file is read again only when its time or size changes.
  - **What's read:**
    - any plain text in UTF-8 or UTF-16 with a BOM, skipping files with a NUL byte;
    - `.docx`, `.xlsx` and `.pptx`, which are zips of XML, read with `node:zlib`.
  - **What's not:** PDFs, images and the old binary Office formats.
  - **Indexing:** in the background, 15 s after start and when the folders change, yielding between files. Before a search, a catch-up of up to 4 s runs if a folder hasn't been walked for 2 minutes.
  - **Failing to read isn't "empty", and failing to list isn't "deleted"** (2026-11-22). A file that can't be read (open in another program, a share that dropped) keeps its passages, its vectors and its old stamp, so it's read again next time. A folder that wouldn't list, a file that wouldn't stat, or the docs folder itself not answering: nothing known under it is forgotten. Only what a walk could look at and didn't find is taken as gone. Otherwise one bad moment on a network share cost passages that had been paid to embed.
  - **What the model gets:** results are the 10 best passages, with path, lines, heading and a bracketed excerpt. The model then reads the lines it needs with `read_file`.
  - **Restraint:** Alloy's "loose matches" note when the best hits share a third or fewer of the query's words, and a "try once with other words, else carry on" note when nothing matches.
  - **The system prompt:** it lists the folders and the user's one-line description of each.
- **Skills** (`src/skills.js`, decided 2026-11-09). Alloy's skills, without their tools.
  - **What one is:** a `.md` file directly in a skills folder, named after the skill, whose first line is `When to use: …`. A front-matter `description:` (Claude's and Codex's `SKILL.md`) is read too, never written. No folder skills: they exist to ship scripts, and Solder runs nothing.
  - **How the model gets them:** both lanes' prompts list each skill (name, file, when; up to 50) and, when the user has a folder of their own, where to save a new one (offered rarely, saved only when they agree). There's no `read_skill` or `create_skill`: the model reads a skill with `read_file` and saves one with `write_file`, which asks, as the folder is outside the workspace.
  - **The read:** a file that's a skill comes back whole (any range ignored, no line numbers, up to 20,000 characters) as `keep`, so cutting old results leaves it in the chat (Alloy's lesson: a skill read must stay whole). If the chat already holds that text since the last compaction, a short "already read" goes back instead.
  - **Folders:** `solder.skillsFolders` (per user, scope `machine`), and the `SkillsFolders` and `AllowUserSkills` policies, as for docs. Skills folders are read without asking, like docs folders, and a network path is opened inside a docs or skills folder that's set up (compared as written).
  - **Making one:** **New skill…** (Settings, and the `solder.newSkill` command) asks the name and when to use it, then opens the file. With no folder of the user's yet, it makes `~/.solder/skills` and adds it to the setting, so the first skill needs no folder picking. The prompt says where to save a skill only once the user has a folder: someone who never uses skills pays no tokens for them.
  - **/skill:** sends a fixed message (`SKILL` in prompt.js) asking the model to save how the chat's task was done, or a skill for what follows the command; it makes the default folder first, so the prompt says where to save. Alone in a new chat it runs New skill… instead.
  - **Live tests:** `skill-follow`, `skill-plan`, `skill-save`, `skill-unneeded`, `skill-command` (a task, then /skill's message) and `skill-about` in `live/scenarios.js`, on two models and both lanes.
- **Settings in tabs** (`renderSettings` in `media/panel.js`). Connection, Docs, Skills, Rules and Advanced: one tab is drawn at a time, the tab bar is sticky in the scrolling area, and Done lives in the top bar so it never scrolls away. The open tab is the panel's own state (it reopens where you left it); `/settings <tab>` opens at one. A dot on a tab marks something to look at. Tab-list keys: the arrows, Home and End.
- **Where the tokens went** (`breakdown`, `attribute` and `tokenReport` in `engine.js`). Each Tool-lane request's prompt tokens are shared out by what the request was made of (results, system prompt, tool definitions, signatures, stand-ins, kept text and so on, by their share of its characters) and added to `chat.usage.by`, so re-sending shows up as it's paid. Copy diagnostics prints those totals, the next request as it stands, and reads that repeated lines still whole in the chat. Numbers only, as the rest of the log.
- **Undo.** Before the first change a step makes to a file, keep its text (in memory and in `globalStorageUri/backups`). The step's **Undo** restores it. **Review** opens `vscode.diff(backup, current)`. VS Code's own Ctrl+Z also works, because edits go through the editor.
- **Paths.** Everything resolves against the workspace folder. Writes outside it ask first. Reads outside it are allowed but shown in the step line.

## Context the model gets

- **System prompt:** a short set of rules (draft below), then:
  1. **`AGENTS.md`** at the workspace root, if there is one. When a task touches files in a subfolder that has its own `AGENTS.md`, that file is added to the result of the first read in that folder ("This folder's AGENTS.md says: …"). This follows the agents.md convention: the nearest file wins.
  2. **The user's rules:** the `solder.rules` setting, a few plain lines. It can be set by org policy.
  3. **The workspace:** its folder and the OS.

  It stays the same from request to request: no time and no file listing.
- **Each user message** starts with `(date, time)`. Then come any context chips the user kept: the **selection** (file and lines plus the text), the **active file** (path only; the model reads it if it needs to), and **problems** (the current errors in the active file).
- **Instruction files.** The `solder.instructionFiles` setting defaults to `["AGENTS.md"]`. Users can add `CLAUDE.md`, `.github/copilot-instructions.md` and so on.

### System prompt

The prompt is in `src/prompt.js` (`RULES`). It's about 450 tokens before `AGENTS.md`, and it tells the model it can't run commands: when something needs building or testing, it says what to run.

## The panel

- **Transcript**
  - Your messages and the model's answers, with Markdown rendered by our own small, safe renderer: an escape-first port of Alloy's. No `innerHTML` of model text without escaping.
  - **Step lines:** one per call, with an icon, a summary and the time. Click one to expand its output. Edits get **Review** and **Undo**.
  - **Approval cards** (removing anything; a change outside the workspace, to a file with unsaved changes, to git's and VS Code's own files, or to a rules file or a project's `.solder` folder; a read outside the workspace and docs folders) show the file and a preview, with Allow and Decline, and an optional note sent back to the model.
- **Composer**
  - A text box. Enter sends; Shift+Enter adds a new line.
  - Context chips: selection, active file and problems, each removable.
  - The **model picker** and **effort picker** (Low / Medium / High; collapses to the chosen word and opens on hover) beside **Send**.
  - Typing while the model works queues a **steer** that goes with the next result.
  - **Stop** ends the reply. **Resume** continues after a failure from the last finished step.
- **Status bar:** this chat's tokens and the allowance left (`2.1M left · resets 4h`). The tooltip breaks it down per answer.
- **Chats:** a list per workspace (new, rename, delete), saved as JSON in Solder's global storage, one file a chat (`src/store.js`).
  - **Every window has its own copy of a chat it has opened, over the same file** (decided 2026-11-22). A window remembers each chat's file as it last read or wrote it (stamp, a hash of its text, a hash of what's said in it, and what was set on it), and looks again before using or saving its copy. Changed in another window: read again when the window gets focus or the chat is acted on. A save from a copy that's behind (a pin, a name, a model) is made to the chat as the file has it, so the other window's turns stay. A copy that's only behind doesn't bring back a chat deleted elsewhere. When both windows added turns, this window's are saved under the chat and the other's are kept as one copy, "(from another window)". No lock is used: every case that was found needed no race, only a window writing back the whole of what it started with.
  - **The project list is the same** (`ProjectList`): the file is the list, read again (at most once a second) before it's used and always before it's changed, since being on it is the yes to a project's rules.
- **Projects** (`src/projects.js`, decided 2026-11-18). A project is a folder; chats are grouped by it and share its folder, rules and skills.
  - **The folder is the only source of truth.** `.solder\project.json` holds the name, `.solder\skills\*.md` the project's own skills, and its rules are the instruction files at its root (`AGENTS.md`). Nothing about a project's contents is kept anywhere else, so copying or zipping the folder shares the whole project. Paths inside are relative, so it works wherever it's put.
  - **Solder keeps only a list of project folders** (`projects.json` in global storage), and each chat remembers its project's folder. Chats stay in the profile: they aren't the project's to share.
  - **Being on the list is the yes.** A folder that's already a project (someone else set it up) is offered, never just used: its rules and skills are instructions the model follows, so there's a prompt first, and nothing of it reaches a chat before that.
  - **The model changes a project's files only after asking** (decided 2026-11-22). A rules file (any folder's) and everything under `.solder` are what later chats are given as instructions, so an edit, write, move or copy there shows an approval card, as a change to `.vscode` does. Otherwise one chat that read a hostile file could rewrite the rules, add a skill or flip a skill switch, and every later chat (and whoever the project is shared with) would follow it with nobody having agreed. A `.code-workspace` file asks too: it holds the same settings and tasks as `.vscode`. What you do yourself on the Projects screen and in Settings isn't asked about.
  - **A project file can't change settings.** `project.json` is read for a name and its skill switches, and nothing else. Approvals, read-only mode, the endpoint and the policy are never a project's to set. When policy sets the skills and users can't add their own, a project's skills aren't offered.
  - **Skill switches travel with the project.** A skill can be off everywhere (the `skillsOff` setting, the user's), and on or off in one project whatever it is elsewhere: those switches are in `project.json` (`skills`: names with true or false), so a shared project brings them. They decide only which skills that project's chats are offered, they apply only once the project is on your list (the trust prompt names them), and the organization's skills have no switch.
  - **Export, not a named folder.** A project's files stay in `.solder`, whatever the project is called: putting the name in the folder's name would make renaming a folder rename, and the name isn't always a legal one. What gets passed around is the export: one zip named after the project (`src/zip.js`), holding its own files or the whole folder. Import is left to Windows: unzip, open the folder, and the trust prompt does the rest. Solder writes zips and never unpacks one into a folder.
  - **Its own screen.** The Projects screen (in the chat's place, as Settings is) lists projects with their chats, and a project's page shows its rules and skills in full. They're read there and edited in the editor, which is better at it; the page only renames the project and makes or deletes files.
- **Theme:** VS Code's own CSS variables (`--vscode-*`), so it matches every theme. No CDN, no web fonts.

## What's resent every step

Decided 2026-11-18, after six reviewers were asked for the one change that would save the most. Cost is chat size times round trips, so text that rides along on every step is the expensive kind.

- **Attachments have an inline budget** (`MAX_INLINE_CHARS`, 40,000 characters a message, in the order attached). Past it they go by path: a file from where it is, a paste from a copy saved in global storage (`pastes\<hash of the text>.txt`, kept 90 days). The model reads ranges with `read_file`, without asking, once the message is sent. A user message is never trimmed, so whole text was resent for the life of the task: one allowed paste was the whole compaction limit.
- **Chips show the cost before Send:** an estimate at four characters a token, or "by path". No request is made for it.
- **A read covered by a later read is cut** (`supersedeReads`, in the task in progress only). The newer copy is right after it and holds the same lines, or the right ones after an edit. This is the one cut that can't cause the re-read loop the A/B run found: nothing the model can still want is gone. Its stand-in says to use the later copy, not to read again. A result that carries something kept (a skill, a folder's instruction file) is never cut this way, nor is one whose would-be replacement came back capped.

## Shared embeddings

Decided 2026-11-18.

Embedding the same docs on every PC spends the same tokens each time, against a daily budget. A shared folder (`embeddingsCache`, or the `EmbeddingsCache` policy) lets one PC's work serve the rest.

- **One file per indexed file,** named by a hash of the embeddings model and the exact text of the file's passages, in order. The same file on another PC, wherever it's kept, gives the same name; a changed file gives another. So there's no index to keep in step, and nothing to lock.
- **Written whole, then renamed.** A reader never sees half a file, and two PCs writing the same file write the same bytes. No database on the share: SQLite over a network share isn't safe with several writers.
- **Numbers only.** No text, no paths, no file names. The vectors are still derived from the docs, so the folder is for people who may read them, and the docs say so.
- **Read with suspicion.** A file is used only if its header, counts, size and checksum agree, every number is finite, and the vectors are the length this PC's are. What's read only ever ranks the reader's own passages: a bad file can spoil a search's order, not put text in front of the model.
- **Never needed.** Every read and write is asynchronous and timed (a share that's away can hang a synchronous call for a long time). After three failures in a row the folder is left alone for the run, and embedding goes through the gateway as before.
- **Both ways, every run.** Before the gateway is asked (and before the cost prompt), files with missing vectors take the folder's. Files that are fully embedded here and not known to be there are put there, so a PC that embedded before the folder was set fills it.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `solder.endpoint` | "" | the full `/chat/completions` URL |
| `solder.modelsEndpoint` | "" | worked out from the endpoint when empty |
| API key | — | **SecretStorage** (`Solder: Set API key`), never in settings. Kept with the gateway it was saved for (scheme, host and port, `src/key.js`) and sent nowhere else: a new address gets no key until it's given one, since the models are listed the moment an address is saved. A policy-set address takes the key along |
| `solder.model` | "" | picked from `/models` |
| `solder.modelFilter` | "" | a regex: only models matching it are offered (for example, only tool-capable ones) |
| `solder.modelNames` | {} | `{ "<id>": "<short name>" }` for the picker. Deployments set this privately or by policy |
| `solder.effort` | "default" | per chat in the picker; "default" sends nothing |
| `solder.compactAtTokens` | 100,000 | 30,000 at least; see Decisions |
| `solder.rules` | "" | plain lines added to the system prompt |
| `solder.instructionFiles` | ["AGENTS.md"] | |
| `solder.docsFolders` | [] | per user (scope `machine`): paths, or `{path, about}`. The setting's description lists the file types that are searched. Also set with **Use as Solder docs** on a folder in the Explorer |
| `solder.skillsFolders` | [] | per user (scope `machine`): folders of skills, one `.md` file each; a new one is saved in the first |
| `solder.skillsOff` | [] | the names of skills switched off everywhere (Settings → Skills); a project's own switches are in its `project.json` |
| `solder.meaningFloor` | 0 | how similar a passage must be to a docs search to count; 0 is Solder's own, 0.58 (`MEANING_FLOOR` in `src/docs.js`, where the measurement is noted) |
| `solder.embeddingsCache` | "" | a folder where PCs share docs embeddings (see Shared embeddings) |
| `solder.maxRounds` | 30 | replies with tool calls per answer |
| `solder.assistMaxRounds` | 60 | the same on the Assist lane, whose tokens aren't billed (decided 2026-11-19: that lane isn't trimmed or compacted by itself either) |
| `solder.assistCarryTokens` | 200,000 | how much of a chat a carry-over to an Assist model holds, at four characters a token; its own setting because it follows the Assist models' context, not Compact at |

**Workspace Trust.** Set `capabilities.untrustedWorkspaces: { supported: false }`, so Solder only runs in trusted folders.

**Two lanes (Tool and Assist models).** The `solder.toolModels` pattern sends matching models down the **Tool lane**: a system prompt, native tool calls, and the whole chat on every request. Every other model goes down the **Assist lane**, which has no system prompt and no tools, and works like this:
- **Calls:** the model asks for a tool by writing a JSON block in its reply. `src/assist.js` parses those blocks into ordinary tool calls before they're stored.
- **Storage:** chats are stored the same way on both lanes, so batching, approvals and Undo don't change.
- **Batches aren't limited, on either lane** (decided 2026-11-23). Every call in a reply runs, up to a guard of 50 against a reply gone wrong. There was a limit of 8 (and of 5 changes before that); models send fifteen or twenty edits for a refactor, and refusing the ones past the limit only cost a step each time, with the whole chat resent on the Tool lane. A change that fails still stops the rest, and a reply's reads together are still held to `MAX_BATCH_RESULT_CHARS`. The Tool lane's prompt still suggests up to 8 reads in a reply: that's advice about what's worth reading at once on a billed lane, no longer a limit.
- **A reply cut off partway carries on by itself, once** (decided 2026-11-23). On the Tool lane a failed request is resent once, but only while nothing of the reply has been shown, since a resend is billed. An Assist reply nearly always starts with words (they're how it explains a step), so that resend almost never applied, and every dropped stream needed a click on Resume. Now the engine does what Resume does: the part that arrived stays in the chat, marked incomplete, and "carry on" is sent in the same session. One for each cut: a second cut straight after shows the error. Never after a Stop, a used-up allowance, or a failure that would only repeat.
- **Rendering:** each lane renders the stored chat its own way.
- **Sessions:** `sessionPlan` sends only each new message while the gateway's session holds the chat. Otherwise it sends the introduction (`ASSIST` in prompt.js), or carries the conversation over inside one user message.
- **The texts:** the two lanes' model-facing texts are separate, and each is pinned by its own test.
- **When the allowance runs out:** on a Tool model, the panel offers to switch the chat to its Assist twin.

**Organization policy (Group Policy, Intune).** Every setting above can be enforced. The guide for admins is [POLICY.md](POLICY.md).
- **Why Solder reads its own keys:** VS Code only applies policies to extension settings listed in its own product.json, which leaves out third-party extensions.
- **The keys:** values under `HKLM` and then `HKCU`, each `\SOFTWARE\Policies\Gremnar\Solder`. Computer policy wins over user policy. A value that's there locks its setting.
- **Reading them:** `src/policy.js` runs `reg.exe export` (directly, with no shell) and parses the UTF-16 `.reg` file. `src/config.js` wraps VS Code's settings, so every read sees the policy.
- **Failing closed:** if the policy can't be read, nothing is sent.
- **Policies that aren't settings:**
  - `AllowUserDocsFolders` adds the user's own docs folders to the enforced ones, and `AllowUserSkills` their own skills folders.
  - `OrgRules` is added after the user's rules, so it reads as the more recent instruction.
  - `FeedbackAddress` replaces Solder's support address in Send feedback. It fails closed: an unusable address, or a policy that can't be read, opens nothing (never Solder's address instead).
- **The API key is never set by policy:** every local user can read the Policies keys.
- **A possible later addition, only if an organization asks:** limiting what Solder can do (for example, no edits, or no writes outside the workspace) by policy.

## Packaging and the Marketplace

- **Build.** `node build/vsix.js` writes `solder-<version>.vsix`. A `.vsix` is a zip that holds:
  - `extension.vsixmanifest`;
  - `[Content_Types].xml`;
  - `extension/` (package.json, src, media, README, LICENSE, the icon).

  `node:zlib` has `deflateRawSync` and `crc32`, so the zip writer is about 120 lines with no packages. `@vscode/vsce` is not needed.
- **Marketplace (publisher `gremnar`).**
  - Upload the `.vsix` through the publisher management page.
  - `package.json` needs `publisher: "gremnar"`, `name: "solder"`, `engines.vscode`, `license`, `repository`, a 128 px `icon`, `categories: ["AI", "Programming Languages"]` and the `extensionKind` `["workspace"]`.
  - Marketplace publishing scans the package. Keep it small and free of binaries.
- **Behind a proxy that blocks the Marketplace,** installs don't update automatically. Ship the same `.vsix` through your own channel and install with `code --install-extension solder-x.y.z.vsix`. Org policy can pin it with `extensions.allowed` (allow `gremnar.solder`).
- **Tests run with no Node installed:** `ELECTRON_RUN_AS_NODE=1` and VS Code's own `Code.exe` run `--test`.

## VS Code's Agent Host Protocol (AHP)

Research as of November 2026:

**What it is**
- Since about 1.129, VS Code runs agent harnesses (Copilot, plus adapters for Claude and Codex) in a separate **Agent Host** process.
- The chat UI and the Agents window talk to that host over **AHP**: JSON-RPC, a message port when local, WebSocket when remote.
- AHP gives clients a synchronized view of session state, built from immutable state, pure reducers and write-ahead reconciliation.
- Microsoft published the spec under MIT and positions it beside LSP and DAP. There are client libraries in TypeScript (npm), Rust, Go, Kotlin, Swift and .NET.
- Third-party hosts already exist: pi-ahp and ahpd, both over WebSocket.
- Commands: `code agent host` runs a standalone host, and `chat.agentHost.enabled` turns it on.

**Can Solder use it today? Not as its foundation.**
- **No documented way to register a third-party harness** with VS Code's built-in Agent Host or chat UI. The documented adapters are Microsoft's own: Copilot, Claude, Codex.
- **It is Copilot-centred and still rolling out.** One report says managed or sandboxed enterprise setups *require* the Copilot harness for full chat sessions.
- **The TypeScript client is an npm package.** That breaks rule 1, although the protocol itself could be implemented by hand.
- Remote mode is WebSocket networking, which our proxy situation makes unattractive.

**How it still shapes Solder**
- The engine is written as a **host-independent session** that emits events and holds state the panel only renders, which is AHP's own model.
- If VS Code later documents third-party harnesses (watch the AHP repo and the VS Code release notes), Solder's engine can be wrapped as an AHP adapter. The panel would then become optional: the session could show in VS Code's own chat, the Agents window and remote clients.
- Until then, our own webview is the only route with no Copilot dependency, and it works behind any proxy.

**Also considered.**
- VS Code's built-in "bring your own key" / custom-endpoint model providers (`chatLanguageModels.json`) can point Copilot Chat at an OpenAI-compatible endpoint.
- That gives a full agent for free, but:
  - parts need a GitHub account;
  - the proxy blocks GitHub;
  - its agent prompts and tool sets are far heavier than a metered allowance can carry;
  - we'd lose every gateway-specific fix.

  Not our route; worth re-checking now and then.

Sources:
- [Agent Host architecture](https://code.visualstudio.com/docs/agents/concepts/agent-host)
- [microsoft/agent-host-protocol](https://github.com/microsoft/agent-host-protocol)
- [AHP implementations](https://microsoft.github.io/agent-host-protocol/guide/implementations.html)
- [Agent harnesses](https://code.visualstudio.com/docs/agents/run/agent-harnesses)
- [Self-hosting issue #311105](https://github.com/microsoft/vscode/issues/311105)
- [VS Code language models (BYOK)](https://code.visualstudio.com/docs/agent-customization/language-models)

## Build order

| Phase | Done when |
|---|---|
| **0: Connection** (started: `src/gateway.js` done and tested; `Solder: Check connection` scaffolded) | On a work PC, `Solder: Check connection` lists models and makes one tool round trip **from inside the extension host**, through the proxy |
| **1: MVP** | Panel, chat, the 6 tools, approvals, Undo/Review, AGENTS.md, saved chats, status-bar meter. Engine tests with a fake host and gateway; live test over a local test proxy |
| **2: Token discipline** | Result trimming, compaction, problems after edits, steer, Resume, allowance-exhausted message |
| **3: Polish** | Model names, effort picker, context chips, the step clock on High, keyboard shortcuts |
| **4: Ship** | `build/vsix.js`, icon, README for the Marketplace, first upload to `gremnar` |

## Decisions

Made 2026-11-04.

1. **Compaction at 100k tokens** by default, configurable from 30k up. Alloy's 225k is too high when every step resends the whole chat.
2. **No shell at all:** Solder only reads and edits code. (Before this, the plan was PowerShell 5.1 by default with pwsh supported.)
3. **Tool-calling models only** in v1. A text-protocol lane for models without tool calling waits until usage asks for it.
4. **License:** MIT.

## Still open

- **Icon** for the Marketplace (`gremnar.solder`, display name "Solder").
