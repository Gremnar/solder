# Changelog

## 0.1.3 (2026-11-05)

- **The chats list is grouped and has a right-click menu.** Pinned chats come first, then today, the last 7 days, the last 30 days and older; archived chats are folded away at the end. Right-click a chat (or Shift+F10) to pin, rename, fork, archive or delete it.
- **Fix: edits refused as "changed on disk" when nothing had changed.** A file with mixed line endings (such as a script saved with LF, then signed, which adds CRLF lines), a BOM or UTF-16 never matched VS Code's copy, so every edit to it was refused. The check now compares the text, as Undo's does.
- **Signed scripts cost far fewer tokens.** A digital signature block (PowerShell, VBScript, JScript) is one line in what the model reads, in git diffs and in the docs index, instead of about 3,000 tokens of base64. After an edit to a signed file, the model is told the signature is now invalid, so it reminds you to sign it again.
- **A reply that goes quiet says so.** After its words stop (while it writes a tool call, such as a long file), the panel shows Thinking…, then Still working… with a clock. Gateways that stream tool calls show what is being written and how much: Writing scripts/app.ps1 · 14.2 KB so far.

## 0.1.2 (2026-11-05)

- **Slash commands:** type **/** in the box for a list. **/new**, **/fork** (carry on in a copy of this chat), **/compact** (summarise now, optionally saying what to keep), **/rename**, **/model**, **/effort**, **/review**, **/settings** and **/help** (opens the guide).

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
