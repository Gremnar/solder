# Checks in a real VS Code

`node --test` covers what runs under plain Node. These checks cover what only a real VS Code can show: the commands,
the Settings screen's actions, editors and tabs, the language services, and the organization policy as the extension
reads it.

```
node check/run.js              every check
node check/run.js skills       one of them (policy, edits, group1, problems, symbols, skills)
node check/run.js --keep       keep the logs and the throwaway folders
```

- **VS Code:** found where the Windows installer puts it, or at `SOLDER_VSCODE` (the path to its program).
  A VS Code that's waiting to restart for an update can't start a second copy: restart it first.
- **What it touches:** each run makes a folder in the system's temp folder with its own workspace, VS Code profile,
  extensions folder and home folder, and removes it afterwards. Your own settings, chats and skills aren't read or
  changed. The skills check deletes one test skill the way Settings does, so that file lands in the recycle bin.
- **No gateway:** nothing here connects anywhere. What the model would be sent is checked, not sent.
- **How a check works:** VS Code loads the extension from this repo (`--extensionDevelopmentPath`) and runs the
  check's file in its extension host (`--extensionTestsPath`). The file writes `PASS` and `FAIL` lines to a log, and
  `run.js` reads it. Prompts VS Code would show (input boxes, confirmations) are answered by the check.

Two things worth knowing when writing one:

- **Use the extension's own modules.** VS Code loads the extension by a path whose drive letter may differ in case
  from the one you'd write, and Node's module cache goes by the exact path. Requiring `src/policy.js` by another
  spelling gives a second copy the extension never sees. `skills.js` takes the path from `require.cache`.
- **Stand in for prompts on Solder's API object.** Each extension gets its own `vscode` object;
  `createRequire(<repo>/src/panel.js)("vscode")` is Solder's, wherever the check's file lives.

These aren't part of the extension: `build/vsix.js` doesn't package this folder.
