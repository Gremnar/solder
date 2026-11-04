# Solder

A lean coding agent that lives in a VS Code side panel. It works with any OpenAI-compatible Chat Completions endpoint that supports tool calling.

Solder is for people who want an agent beside the editor, not instead of it:
- **7 tools:** read, search, find, edit, write, run, problems.
- **VS Code's own diff and undo** for every edit.
- **An approval** before every command.
- **Follows `AGENTS.md`**, plus a few rules you set.
- **A token meter** that shows what each answer costs.

**Status: early.** The gateway client and `Solder: Check connection` work. The panel and the agent loop are next. See [docs/DESIGN.md](docs/DESIGN.md) for the plan and [docs/LESSONS.md](docs/LESSONS.md) for the engine lessons it's built on.

## Try the connection check

1. Install the `.vsix`: `code --install-extension solder-0.0.1.vsix`. For development, open this folder and press F5.
2. Settings → Solder: set **Endpoint** (the full `/chat/completions` address).
3. Command palette → **Solder: Set API key**.
4. Command palette → **Solder: Check connection**. It lists the models, then makes one tool round trip and reports each step in the Solder output.

## Rules for changing Solder

- **No npm packages**, not even for development. Plain JavaScript with `// @ts-check` and JSDoc; Node built-ins and the `vscode` API only.
- **Nothing deployment-specific in this repo:** no company or gateway names, addresses, model names, keys or logs. Those go in user settings or org policy, and private notes stay out of the repo (`private/` is ignored).
- **Contact only the configured endpoint.** No telemetry, no other network calls.
- **Every model-facing text** lives in `src/prompt.js` and is pinned by a test.
- **Tests:** `node --test`. With no Node installed, use VS Code's own: `$env:ELECTRON_RUN_AS_NODE=1; & "<VS Code>\Code.exe" --test`.
