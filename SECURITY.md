# Security

## Reporting a problem

Email **support@gremnar.com**, with "Solder security" in the subject. Please don't open a public issue for a security problem. Include:
- what you found and how to reproduce it;
- the Solder and VS Code versions: **⋯ → Copy diagnostics** in the panel has both, and nothing private.

Expect a reply within a few days. A fix ships in the next release, credited to you if you'd like.

## What Solder does and doesn't do

- **Network:** it contacts only the endpoint you configure. There's no telemetry and no update check, and the panel loads nothing remote: a strict Content Security Policy allows only Solder's own script and style.
- **No shell:**
  - Solder never runs commands or programs you or the model choose;
  - the one program it starts itself is `git`, for the `changes` tool. It's run directly, not through a shell, with fixed read-only arguments, and with the pager, fsmonitor, external diff tools and text conversion turned off;
  - git still applies the filters set in a repository's own `.git/config`, as it does for VS Code's own git support. That's why Solder asks before changing anything under `.git` and `.gitattributes`.
- **What it asks before doing:**
  - deleting anything;
  - changing a file outside the workspace, or one with unsaved editor changes;
  - changing git's or VS Code's own files (`.git`, `.vscode`, `.gitattributes`, `.gitmodules`), where a change can make programs run;
  - reading a file outside the workspace and your docs folders;
  - running git in a folder outside the workspace.

  Every other change can be reviewed and undone.
- **Links and network paths:** a path counts as inside the workspace only if it's still inside once links and junctions are followed. Network paths (`\\server\share`) outside the workspace aren't opened.
- **Settings a workspace can't change:** the endpoint and the model filter are per-machine settings, so a folder's `.vscode/settings.json` can't send your key or code elsewhere. Instruction files are plain file names only.
- **Workspace Trust:** Solder doesn't run in Restricted Mode.
- **Your key:** it's kept in VS Code's secret storage, never in settings, and never written to the log or diagnostics.
- **Your data:** chats, Undo's backups and the docs index stay on your PC, in VS Code's storage for Solder.
- **What reaches the endpoint:** your messages, and what the tools return: file contents Solder reads, search results and docs passages. Treat it as you would any service you send code to.

## Prompt injection

A file or doc that Solder reads can contain text written to steer the model. Solder's defences:
- the approvals above;
- Review and Undo;
- no shell.

None of those can make a model's judgement safe, so review the changes it makes in code you don't trust.
