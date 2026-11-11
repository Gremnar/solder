# Changelog

## Unreleased

- **Skills.** A skill is your instructions for a kind of task, in one Markdown file named after it, whose first line says when to use it (`When to use: Writing or changing a PowerShell script.`); a front-matter `description:`, as in Claude's and Codex's `SKILL.md` files, works too. Add folders of them in **Settings → Your skills** (or the **Skills folders** setting). The model is told each skill's name, file and when to use it, and reads one before a task it covers, with read_file: no new tool, no approval to read, and the skill comes back whole (no line numbers, whatever range was asked) and stays in the chat when old results are cut or its plan step is done. A skill the chat still holds isn't sent twice. Settings lists the skills found, flags one with no "When to use" line, and makes a new one with **New skill…**; ask the model to save one and it writes it to your first skills folder, after asking. Up to 50 skills are offered, and 20,000 characters of each are read.
- **Making and managing skills.** **New skill…** (in Settings, and as **Solder: New skill** in the command palette) asks a skill's name and when to use it, then opens the file to write; with no skills folder yet it makes one, `.solder\skills` in your home folder. Settings lists your skills first, each with ✕ to delete it (to the recycle bin, after asking). **Use as Solder skills** on a folder in the Explorer adds a folder you already have, and the guided setup's summary mentions skills.
- **Settings in tabs.** The settings screen was one long page; it's now five tabs (Connection, Docs, Skills, Rules, Advanced) that stay in view as you scroll, with **Done** in the bar at the top. A dot marks a tab that wants a look (no gateway or key yet, a skill with a problem). The Advanced tab gains **Tool models**, **Assist session block** and **Undo's storage limit**, which were only in VS Code's settings before. `/settings skills` opens Settings at a tab.
- **Undo all.** A task that changed two or more things ends with **Undo all N changes**: after asking, it puts every file back, newest change first. It stops at a file you've changed since, and says how far it got.
- **Settings in the top bar.** A Settings button sits beside ⋯ (it was inside the ⋯ menu).
- **A file with no "When to use" line isn't offered as a skill.** A README or notes in a skills folder was offered to the model by name; now Settings flags it and the model isn't told about it.
- **/skill.** After a task you'll do again, `/skill` has the model write up how it was done as a skill (it asks before saving); `/skill` with what it's for writes one from that; in a new chat with nothing typed it asks you for the skill by hand. Your skills folder is made if you have none.
- **Where a chat's tokens went.** Copy diagnostics now breaks a chat's tokens down, in numbers only: requests, tokens in and out (and how much of the output was thinking, when the gateway says), what the tokens in carried over every request (tool results, the system prompt, the tool definitions, thought signatures, stand-ins, kept instructions), what the next request holds, and how many reads repeated lines still in the chat. Recorded from this version on.
- **Fix:** an Assist model's empty reply that came with a token count was added to the chat's billed tokens; Assist tokens are free, and are now counted as such there too.
- **Organization skills.** The `SkillsFolders` policy gives every user the same skills (from a share if you like), and `AllowUserSkills` lets them add folders of their own beside them. Both are in the ADMX templates.
- **Organization feedback address.** The `FeedbackAddress` policy sends **Send feedback** to your organization's own address instead of Solder's support, so feedback that may mention your code stays inside. It fails closed: an address that isn't usable, or a policy that can't be read, opens nothing rather than falling back to Solder's address. In the ADMX templates, under Support.
- **Docs and skills folders on a share now work.** Network paths are opened inside the docs and skills folders you or your organization set up (compared as written, so no other server is contacted), as well as in the workspace. Before, a passage in a docs folder on a share couldn't be read.

## 0.2.8 (2026-11-09)

- **Assist models (a second kind of model).** Some gateways offer, beside the usual Tool models (system prompt, native tool calls), Assist models that take plain text only and keep the conversation in a session of their own. Set **Tool models** to a pattern for your Tool models' ids, and every other model is an Assist model: Solder introduces your workspace and its tools in plain first person, the model asks for tools by writing a request in its reply (read leniently: Windows paths, broken JSON in a long file, a forgotten fence), and steps, approvals, Review and Undo work as always. With **Assist session block** set, only each new message is sent while the gateway's session holds the chat; otherwise, and whenever it doesn't (a switch, a fork, compaction, a session that ended), the conversation is carried over in one message. Assist tokens are shown as free. Both settings can be enforced by policy.
- **Switch and carry on when the allowance runs out.** On a Tool model whose Assist twin is on offer, the used-up message offers **Switch to … and resume**: the chat moves to the Assist model, which doesn't use the allowance, and the task carries on where it stopped.
- In the picker, Assist models are tagged **Assist**, and the effort control is hidden for them (they take no thinking level).
- The Marketplace page now leads with what organizations get (Group Policy and Intune control).

## 0.2.7 (2026-11-09)

- **Fix: the status bar showed a per-minute limit as the allowance left.** A gateway that reports several allowances (a daily one and a per-minute one, say) had the emptiest shown, which just after a big request is the per-minute one. What’s shown as left is now the allowance with the longest window. The emptiest still decides whether a refusal means “used up” (a per-minute limit at 0 is only a moment’s wait).

## 0.2.6 (2026-11-08)

A bug-fix round: 18 bugs found by five independent reviews, each checked against the code before it was fixed.

- **Organization policy really fails closed now.** A `reg.exe` export that failed for any reason other than a missing key (access denied, or a temp folder that can’t be written, which a user could arrange) read as “no policy”: now Solder asks `reg.exe query` whether the key is there, and if it is, doesn’t connect. Check connection (in Settings, the guided setup and the command) now honours a policy that can’t be read, and a connection made before a policy change no longer survives it (opening Settings applies the change at once).
- **edit_file:** old_text that loosely matches two places is refused as ambiguous instead of being matched somewhere else by its indentation; a missed edit copied with line numbers, or with a wrong extra first line, still shows the closest lines.
- **Undo:** overwriting a UTF-16 file that wasn’t open (Windows PowerShell 5’s default) no longer saves a garbled backup; undoing a copied folder is refused if anything in the copy has changed since; a git diff view of a file is no longer mistaken for the file (wrong backups, false “changed on disk”).
- **symbols** no longer loops when VS Code’s index names a file the name has left, and a definition or use outside the workspace and docs folders is named but not shown (reading it asks first, as read_file does).
- **search:** without ripgrep, a folder glob (`src`, `src/`) finds what’s in it; and with several workspace folders, a ripgrep that fails to start no longer doubles the paths.
- **The engine:** Resume’s and the plan nudge’s “carry on” continue the same task (its results keep their protection, and it isn’t summarised partway); the nudge isn’t put off by a `?` in code or a URL; the model can’t be switched while its task runs (its thought signatures belong to the running model); a read in the reply that finishes a plan step, and the step in progress at a re-plan, now leave the chat with their step.
- **Chats:** saves of one chat made at the same moment no longer collide on one temporary file.

## 0.2.5 (2026-11-08)

- **Settings an organization enforces (Group Policy and Intune).** Every setting can be set and locked for users, under `HKLM` or `HKCUSOFTWAREPoliciesGremnarSolder` (computer policy wins). A value that’s there is used instead of the user’s own setting, and its field in Settings is locked and marked “Set by your organization”; guided setup skips what’s set; an enforced model or effort also locks the picker and /model and /effort. Two more: `AllowUserDocsFolders` lets users add docs folders of their own beside the organization’s, and `OrgRules` adds rules after the user’s own, for every chat. If the policy can’t be read, Solder doesn’t connect. ADMX and ADML templates are in `policy/` and attached to each release; the guide is docs/POLICY.md. The API key is never set by policy.

## 0.2.4 (2026-11-07)

- **A task that stops with plan steps left is asked to carry on, once.** A weak model sometimes ends a planned task partway, with steps still to do and nothing asked. Solder now sends one short message listing the steps left (“please carry on, or if you stopped on purpose, say so”), shown in the chat as “Carry on (the plan had N steps left)”. Not when the reply asks you something, not twice for one message, and not for a plan from an earlier message. In the live suite it caught one such stop in a 12-module task, which then finished correctly.
- **A live test suite** (`live/`, for contributors): 14 scenarios on throwaway workspaces, run against any OpenAI-compatible endpoint and checked by running the result, with a table of passes, tokens and requests beside a baseline run. See live/README.md.

## 0.2.3 (2026-11-07)

- **symbols looks across the workspace when the name isn’t in the file given,** and says so, instead of an error asking for another try; and it reads “parseRow()” and “Parser.parse” as the names they mean. In a live test, both models answered from that one call, 4 times in 4.
- **A missed edit finds the closest lines by voting.** Each line of old_text found in the file points to where old_text would start; the place most of them point to is shown (“2 of its 3 lines match there”), so a generic first line (a closing brace) no longer shows the wrong function, and a wrong first line no longer shows nothing. When it’s a tie, nothing is shown rather than a guess. In a live test with the first line changed under the model, both models fixed the edit straight from those lines, 4 times in 4.
- **old_text copied with read_file’s line numbers** (“12	…”) is matched without them, as a last try, and the model is told. A trailing line break on old_text no longer stops the forgiving matches.
- **A wrong path names the files that exist.** A path that isn’t there gets the files of that name in the workspace (any case, node_modules aside, most alike first), or the same name with another extension; a folder given as a file lists what’s in it. Only suggested: nothing is read or changed in their place.
- **Plan calls don’t count toward the calls one reply can run,** and a reply can now run up to 8 calls with at most 5 of them changes (it was 5 for any reply with a change in it). A plan update alongside 8 reads no longer drops the last read.
- **An older plan result is left out once the newest holds all of it** (every plan call returns the whole plan, so a long task carried many copies). One a re-plan dropped something from stays whole.
- **Every argument problem in one message.** A call missing several arguments says so at once, and arguments a tool doesn’t take are named (old_string for old_text), instead of being dropped silently.
- **Search globs read as find_files reads them:** any case, backslashes, and a folder name as everything in it. A search stopped at its time limit is no longer reported as “no matches”.
- **A failed automatic summary isn’t asked for again before every step of the same task,** and compaction sizes earlier turns as they’re actually sent.

## 0.2.2 (2026-11-07)

- **No text alongside tool calls.** The model now goes straight to its calls (you see each step), writing only to ask you something or flag a surprise. Less visible text in a chat also gives a model less to copy when it starts thinking out loud.
- **Reads it already knows it needs go out together,** up to 8 in one reply, instead of one per reply: each extra reply sends the whole chat again. In a live test on a 12-module task, one model used 55% fewer tokens (1.23M to 0.54M on average) and the other about the same.
- **Questions come with a recommendation.** When a request is unclear and reading the code can’t settle it, the model asks one to three short questions, each with the choice it would make (“createdAt (recommended), updatedAt or shippedAt?”), so you can just say yes.
- **A long line can be read whole.** A line over 2,000 characters (a long string, a Markdown paragraph, a SQL query) is still shown by its start in a wide read, but a read of one to three lines now shows it whole, up to 30,000 characters, and the note says how.
- **Fix: symbols with no path, for a name defined in several files, used only the first.** It now shows every definition (up to 5), or for references, names the other files where it’s defined. And for TypeScript and JavaScript functions it now finds the definition at all: VS Code names them with their parentheses there, so they never matched and fell back to text matches.
- **edit_file forgives indentation that’s off by one even amount.** When old_text matches in one place with every line indented by the same amount more or less than the file (a deep block copied a level off), it’s applied at the file’s own depth, new_text shifted the same way, and the model is told. Uneven indentation, or tabs for spaces, is still refused rather than guessed at.
- **A missed edit shows the file’s lines.** When old_text isn’t found but its first line is, the error includes the lines around there as they are now (up to 40), so the next try copies from them with no read in between. old_text found in several places shows each of the first three with a line either side. In a live test, both models fixed the edit straight from those lines, 4 times in 4.
- **Several edits to one file in a reply are checked once.** The problems check waits for the last of them (up to 2.5 s saved for each of the others) and compares with the file as it was before the first, so a break that a later edit fixes is never reported. If the later edit fails, the check still runs.
- **Fix: a plan step marked done in the same reply as the next step’s first reads swallowed those reads.** A step now ends where the reply that finishes it begins.
- The “Writing …” line finds the file a call is about near the call’s start only, and before its content (whose text may hold a “path” of its own), instead of rescanning the whole call as it streams in.
- **A used-up allowance is recognised from the gateway’s words too.** A 429 that says its credit limit or quota is reached now counts as used up even without an allowance header or a long Retry-After: it isn’t retried, it shows as used up (with Resume for after the reset), and the status bar’s allowance goes to 0. The limit and the reset time are read from the message when no header gives them (“500/500 credits used … reset is in 3h 12m”), and the message says when it resets: “The allowance is used up (500 credits). It resets in about 3 hours, at 4:12 PM.” A 429 that asks for a short wait is still retried, even if it says quota.

## 0.2.1 (2026-11-06)

- **Scroll to bottom.** Scroll up in a chat and a round ↓ button appears just above the box; it takes you back to the end.
- **problems checks files that aren’t open.** Some language support (TypeScript’s among it) only checks files in an editor tab, so a file Solder had changed but you didn’t have open came back “not checked”. It’s now opened in a background tab for the check, which leaves the editor you’re looking at and the cursor where they are, doesn’t replace a preview tab, and is closed again afterwards. A clean file no longer reads as unchecked where that kind of file does get checked, and when a file really can’t be checked, the model now tells you.
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
