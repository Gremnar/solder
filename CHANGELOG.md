# Changelog

## Unreleased

- **Slash commands:** type **/** in the box for a list. **/new**, **/fork** (carry on in a copy of this chat), **/compact** (summarise now, optionally saying what to keep), **/rename**, **/model**, **/effort**, **/review**, **/settings** and **/help**.

## 0.1.1 (2026-11-04)

- Out of preview.

## 0.1.0 (2026-11-04): the first release

Solder is a lean coding agent in VS Code's side bar. It works with any OpenAI-compatible Chat Completions endpoint that supports tool calling.

- **Ten tools, and no shell:**
  - `read_file`: also reads Word, Excel and PowerPoint files;
  - `symbols`: an outline, a definition, and the places a name is used;
  - `search`: the workspace, or your own docs folders;
  - `find_files`;
  - `changes`: what's changed in git;
  - `edit_file` and `write_file`;
  - `move_item`: move, rename or copy;
  - `remove_item`;
  - `problems`.
- **Every edit can be reviewed and undone.** Solder asks before it:
  - deletes anything;
  - changes a file outside the workspace, or one with unsaved changes;
  - changes git's or VS Code's own files;
  - reads a file outside the workspace and your docs folders.
- **Your docs:** a local full-text index of your own reference folders, covering plain text and Office files, kept on your PC.
- **Made for a metered gateway:**
  - old tool output is cut down to short stand-ins;
  - the older part of a long chat is summarised;
  - busy answers are retried, and nothing that may have been billed is sent again;
  - when the daily allowance runs out, Resume carries on once it resets.
- **The panel:**
  - colours from your VS Code theme;
  - streaming answers;
  - step lines with times;
  - queued messages;
  - starter cards;
  - guided setup;
  - settings inside the panel;
  - saved chats that are named for you.
- **From the editor:** right-click a selection and choose **Solder → Explain this**, **Fix this** or **Add to chat**.
- **Privacy:**
  - Solder contacts only your endpoint: no telemetry;
  - the key is kept in VS Code's secret storage;
  - Undo's backups are capped by **Storage limit** (5 GB by default);
  - **⋯ → Copy diagnostics** copies a log with no file contents or keys, for support.
