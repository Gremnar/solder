# Changelog

## Unreleased

- **Scroll to bottom.** Scroll up in a chat and a round ↓ button appears just above the box; it takes you back to the end.
- **Fix: Done in Settings (or leaving the guided setup) opened the chat at its start.** It now opens at the end, where you left it.

## 0.2.0 (2026-11-06)

- **The plan stays in view while it works.** A compact copy of the checklist sits just above the message box while a task with unfinished steps runs, so it no longer scrolls away as the steps pile up. The card in the chat stays where it was.
- **Plans from two steps up.** The model now sets out a plan for any task of two or more steps, not three.
- **Nothing already embedded is sent again by accident.** A docs folder that drops off the list (removed, or a settings file lost for a while) keeps its index and vectors for 14 days, out of searches, so putting it back costs nothing. Vectors made with another embeddings model are no longer deleted when you switch. A file that looks changed keeps the vectors of its unchanged passages, so a copy with new dates sends nothing and an edit to one function sends one passage. And an embedding run of 300 passages or more now asks first, with its estimated tokens (Embed them, or Not now).

## 0.1.8 (2026-11-06)

- **Plans for longer tasks (an 11th tool, `plan`).** For a task of three or more steps, the model sets out a plan: each step's goal, which you see as a checklist in the chat (done ✓, now, to do), and the details it needs, which only it sees. When it finishes a step it writes notes on what it did and what later steps need, and that step's tool output is then left out of the chat, replaced by the notes, so long tasks stay small and focused.
- **Read other chats while one works.** The chats list opens any chat while Solder is busy in another. A banner there says where it's working, or that it's waiting for your approval (with a notification too), or that it finished, with a button to go back. The task's live text, approvals and messages you queued stay with its own chat; you can't send from another chat until it's done.

## 0.1.7 (2026-11-06)

- **Minified and generated files.** A search that matches inside a very long line (a bundled `extension.js`, minified code, one-line JSON) shows the text around each match instead of the line's first 300 characters, where the match almost never is. `read_file` shows such a line by its first 1,000 characters with a note to search instead of reading it in pieces, then goes on with the next lines. In a live test on a minified bundle, both models got the answer right 4 times in 4 (0 in 4 before), with a quarter of the tokens.

## 0.1.6 (2026-11-05)

- **Docs search by meaning (optional).** Settings → Your docs → **Keywords + meaning**, with your gateway's embeddings model (**Test** checks it). Each passage gets a vector from the gateway, kept in the same local SQLite index; a search ranks passages by meaning as well as by keywords and merges the two, so it finds passages that say the same thing in other words. Only new and changed files are sent again. Each run's token count is in the log. Off by default: it sends your docs' text to the gateway once.
- **Scripts are cut into better passages.** A `#` line starts a new passage only in Markdown and Office files; in a script it's a comment, so commented scripts are no longer split into fragments. Passages also end at a blank line once they're reasonably full, so code tends to break between functions. The docs index is rebuilt once to re-cut existing files.
- **Docs search returns the best 5 passages,** not 10: less to resend with every step.

## 0.1.5 (2026-11-05)

- **Fix: find_files missed files whose name differed in case.** VS Code's file search matches case exactly, even on Windows, so looking for newdomainnetbioscheck.ps1 found nothing when the file was NewDomainNetbiosCheck.ps1. Names now match regardless of case, and when VS Code's file search finds nothing, Solder walks the folder itself before saying there are none. Content search's fallback uses the same.

## 0.1.4 (2026-11-05)

- **Multi-folder workspaces.** Every folder in the window counts as the workspace: searches and file lists cover them all, edits in any of them don't ask, and each folder's AGENTS.md is followed. The working folder can be in any of them; choosing one outside the window offers to add it to the workspace.
- **Chats follow their folder.** They're kept in Solder's global storage, marked with the folder they were started in, so adding a folder to the window (which makes it a new workspace to VS Code) no longer hides them. Existing chats are copied over the first time; the old files are left as they were.

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
