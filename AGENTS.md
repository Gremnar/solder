# Working on Solder

Solder is a lean coding agent in a VS Code side panel. It talks to any OpenAI-compatible Chat Completions endpoint that supports tool calling. Start by reading `docs/DESIGN.md` (the plan and its decisions) and `docs/LESSONS.md` (the engine lessons it's built on).

## Hard rules

- **No npm packages**, not even dev dependencies. Use plain JavaScript (CommonJS) with `// @ts-check` and JSDoc types, Node built-ins and the `vscode` API only. Don't add a `node_modules`, a bundler or a TypeScript compiler.
- **This repo is public.** Nothing deployment-specific goes in it: no company or gateway names, addresses, model names, rate-limit header names, keys, logs or share paths. Use generic placeholders in tests (`model-a`, `x-ratelimit-*-tokens`). Grep for leaks before every commit.
- **Contact only the configured endpoint.** No telemetry, no CDNs and no other network calls; the webview loads nothing remote.
- **No shell.** Solder reads and edits code; it never starts PowerShell or any other shell, so there is no `run` tool. If running things is ever needed, add a narrow tool that starts one program directly (for example `git diff`), never a general shell.
- **Every model-facing text** lives in `src/prompt.js`. Change it deliberately and live-test any change to it.
- **Reliability over breadth.** If something can't be made extremely reliable, leave it out.

## Layout

| Path | What it is |
|---|---|
| `src/gateway.js` | HTTP client: SSE streaming, tool calls, retries (never resend what may have been billed), rate-limit headers |
| `src/engine.js` | The tool loop. No `vscode` import, so it is tested under plain Node through a `Host` interface |
| `src/prompt.js` | The system prompt, tool definitions and fixed notes |
| `src/tools.js` | The tools on VS Code's APIs: read_file, symbols, search (VS Code's bundled ripgrep, or the docs index), find_files, changes (git), edit_file, write_file, move_item, remove_item, problems. Holds the backups behind Review and Undo. (The 11th, plan, is the engine's own, in engine.js.) |
| `src/panel.js` | The webview view provider and controller: chats, models, working folder, status bar |
| `src/store.js` | Chats as JSON files in the workspace's storage |
| `src/docs.js` | The docs index: node:sqlite FTS5 over the user's docs folders, plain text and Office files (no `vscode`, tested under node) |
| `src/setup.js` | The guided setup in the side bar: endpoint, key (checked by listing models), model, docs folders, rules |
| `src/settings.js` | Settings inside the side bar (⋯ → Settings): the same user settings, the key, and the docs index's live status |
| `media/` | The panel's HTML, CSS and JS: plain DOM, strict CSP, VS Code theme variables, Alloy-style word fade-in |
| `build/vsix.js` | Packages `solder-<version>.vsix` with no tools (a hand-written zip) |

## Checking your work

- **Tests:** `node --test`. With no Node installed, use VS Code's own: `$env:ELECTRON_RUN_AS_NODE=1; & "<VS Code>\Code.exe" --test`.
- **Syntax:** `node --check` every changed `src/*.js` and `media/panel.js`.
- **Install locally:** `node build/vsix.js`, then `code --install-extension solder-0.0.1.vsix --force`. The user reloads the VS Code window.
- **Looking at the panel without VS Code:** serve `media/panel.css` and `media/panel.js` next to a small `index.html` that mocks `acquireVsCodeApi` and the `--vscode-*` CSS variables, and post it `state` / `live` / `editor` messages.
- **Live model tests:** behaviour changes are tried against real models through a local OpenAI-compatible proxy on a spare port, with a throwaway folder. Never touch the user's own running proxy or their data.
- **Version numbers** change only when the user says to cut a release.
