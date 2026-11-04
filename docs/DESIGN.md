# Solder: design

Solder is a **lean coding agent in a VS Code side panel**. It talks to an OpenAI-compatible Chat Completions endpoint that supports tool calling: a corporate gateway, a local server, anything that speaks the format. It is meant for technical users who live in VS Code and want an agent beside the editor that does focused work with as few tokens as possible.

It's the sibling of **Alloy**, a general Windows assistant. Solder keeps Alloy's engine lessons ([LESSONS.md](LESSONS.md)) and leaves out everything VS Code already does.

## What it is, and what it isn't

| Solder does | Solder leaves out (VS Code or Alloy covers it) |
|---|---|
| A chat panel in the side bar, with streaming answers | A file tree, file previews and an editor: VS Code has them |
| 9 tools: read, symbols, search, find, changes, edit, write, remove, problems | Running commands (no shell at all), OneNote, reminders, Excel, the Brain, web fetch |
| Edits you can review in VS Code's diff and undo per step | General-assistant chat and long-term memory |
| Follows `AGENTS.md`, plus a few simple rules you set | Skills, notes and project folders |
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
| `read_file` | path, start_line?, end_line? | `workspace.openTextDocument` (it sees **unsaved** edits), with line numbers. 2,000 lines or 30k characters at most per read | none |
| `symbols` | path, name?, find?, line? | With only a path, the outline from `vscode.executeDocumentSymbolProvider`: classes, functions and methods, nested, with line ranges (400 entries at most; a cold language server gets a few seconds). With a name, `executeDefinitionProvider` (the definition's whole body, from the outline's extent) or `executeReferenceProvider` (one line per use, 100 at most). Solder finds the name's position itself, because models are bad at columns. With no language support, it gives whole-word text matches, labelled as such | none |
| `search` | query, regex?, glob? | VS Code's bundled ripgrep (see below), JS fallback | none |
| `find_files` | glob | `workspace.findFiles`, which respects `files.exclude` and `.gitignore` | none |
| `changes` | path? | `git` started directly: one fixed program, no shell. It uses the path VS Code's git extension found, with `--no-ext-diff --no-textconv`, no pager, no fsmonitor and no optional locks, so a repo's config can't make Solder run other programs. With no path: status plus line counts, and the diff when it's 12k characters or less. With a path: that file's or folder's diff against HEAD. New files are listed, and unsaved editor changes are flagged | none |
| `edit_file` | path, old_text, new_text | one `WorkspaceEdit`, then save. `old_text` must be unique. Keeps the file's line endings. Accepts a match that differs only in trailing whitespace | none (Undo kept) |
| `write_file` | path, content | create or overwrite through `WorkspaceEdit`, then save | none inside the workspace; asks outside it |
| `problems` | path? | `languages.getDiagnostics` (errors and warnings, capped) | none |

Details that matter:
- **After every edit or write, include the file's new problems.** Wait up to about 2 s for `onDidChangeDiagnostics` on that file, then add any new errors to the result: "New problems in app.ts: 42: Cannot find name 'x'". This is the biggest token saver available. The model sees a broken edit at once instead of running a build to find out.
- **Ripgrep.** VS Code ships `rg.exe` inside its install. In 1.141 it is at `<appRoot>/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/win32-x64/rg.exe`; older builds have `@vscode/ripgrep/bin/rg.exe`. Probe both from `vscode.env.appRoot`. If neither exists, or policy blocks it, fall back to a JS search over `findFiles` with size caps. Output: `path:line: text`, at most 200 matches.
- **No shell (decided 2026-11-04).** Solder never starts PowerShell or any other shell, so Constrained Language mode, AppLocker and endpoint security have nothing to trip over, and the model can't fall into script loops (Alloy's worst token burns). It checks its work through `problems`, and says what to build or test for the user to run. If running things is missed later, add narrow, read-only tools that start one program directly (`git diff`, `git status`), never a general shell.
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
  - **Approval cards** (only for a change outside the workspace) show the file and a preview, with Allow and Decline, and an optional note sent back to the model.
- **Composer**
  - A text box. Enter sends; Shift+Enter adds a new line.
  - Context chips: selection, active file and problems, each removable.
  - The **model picker** and **effort picker** (Low / Medium / High; collapses to the chosen word and opens on hover) beside **Send**.
  - Typing while the model works queues a **steer** that goes with the next result.
  - **Stop** ends the reply. **Resume** continues after a failure from the last finished step.
- **Status bar:** this chat's tokens and the allowance left (`2.1M left · resets 4h`). The tooltip breaks it down per answer.
- **Chats:** a list per workspace (new, rename, delete), saved as JSON in `workspaceStorage`.
- **Theme:** VS Code's own CSS variables (`--vscode-*`), so it matches every theme. No CDN, no web fonts.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `solder.endpoint` | "" | the full `/chat/completions` URL |
| `solder.modelsEndpoint` | "" | worked out from the endpoint when empty |
| API key | — | **SecretStorage** (`Solder: Set API key`), never in settings |
| `solder.model` | "" | picked from `/models` |
| `solder.modelFilter` | "" | a regex: only models matching it are offered (for example, only tool-capable ones) |
| `solder.modelNames` | {} | `{ "<id>": "<short name>" }` for the picker. Deployments set this privately or by policy |
| `solder.effort` | "default" | per chat in the picker; "default" sends nothing |
| `solder.compactAtTokens` | 100,000 | 30,000 at least; see Decisions |
| `solder.rules` | "" | plain lines added to the system prompt |
| `solder.instructionFiles` | ["AGENTS.md"] | |
| `solder.maxRounds` | 30 | replies with tool calls per answer |

**Workspace Trust.** Set `capabilities.untrustedWorkspaces: { supported: false }`, so Solder only runs in trusted folders.

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
