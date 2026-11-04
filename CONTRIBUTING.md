# Working on Solder

Start with [AGENTS.md](AGENTS.md), which has the hard rules and the layout. Then read [docs/DESIGN.md](docs/DESIGN.md), the plan and its decisions, and [docs/LESSONS.md](docs/LESSONS.md), the engine lessons it's built on.

## Rules

- **No npm packages,** not even for development. Plain JavaScript with `// @ts-check` and JSDoc; Node built-ins and the `vscode` API only.
- **Nothing deployment-specific in this repo:**
  - no company or gateway names, addresses, production model names, keys or logs;
  - those go in user settings or org policy.
- **Contact only the configured endpoint.** No telemetry and no other network calls.
- **No shell.** A narrow tool that starts one fixed program, such as `git`, is the most there will ever be.
- **Every model-facing text** lives in `src/prompt.js` and is pinned by `test/prompt.test.js`. Live-test any change to it.

## Build and test

- **Tests:** `node --test`. With no Node installed, use VS Code's own: `$env:ELECTRON_RUN_AS_NODE=1; & "<VS Code>\Code.exe" --test`.
- **Syntax:** `node --check` each changed `src/*.js` and `media/panel.js`.
- **Package:** `node build/vsix.js` writes `solder-<version>.vsix`, using a hand-written zip and no tools. Install it with `code --install-extension solder-<version>.vsix --force`, then reload the window.
- **Development:** open this folder in VS Code and press **F5**.
- **Version numbers** change only for a release.
