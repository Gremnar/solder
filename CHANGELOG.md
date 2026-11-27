# Changelog

## 0.3.20 (2026-11-27)

- **More in the Command Palette.** Type *Solder* in the Command Palette for what the slash commands and the panel's bar do: **Rename**, **Fork** and **Summarise this chat**, **Review changes since the last commit**, **Attach files to the next message**, **Switch this chat's model** and **Set this chat's effort** (each a list to pick from), **Open settings**, **Projects**, and for the pet, **Show or hide the pet** and **Choose a pet** (Bit, Flux or Wisp, its corner on or off, or hiding it). Each brings Solder's panel up first, so you see what it did.

- **Images, for Tool models.** Paste a screenshot into the box, or attach a PNG or JPEG with the paperclip, and the model sees it with your message. Every image costs about 1,100 tokens whatever its size, and is sent again with each step like the rest of the chat; it goes at full detail during the task it came with, and at low detail (about 300 tokens) in later ones. A big screenshot is made smaller (a JPEG no more than 2,560 pixels across) before it goes, which only makes it quicker to send. Assist models read text only, so Solder won't send an image to one: it says so and puts your words back in the box. Images are kept in Solder's storage, not in the chat file, and removed 90 days after they were last attached; one that's gone is named in its place. While Solder is working, an image waits above the box for your next message (what you add mid-reply goes as text).

## 0.3.19 (2026-11-26)

- **A pet, if you'd like one.** `/pet` shows a small pixel companion over the chat's top right corner, and `/pet` again hides it. There are three, each with a corner of its own: **Bit**, a robot at a workbench (`/pet bit`), **Flux**, a cat on a shelf (`/pet flux`), and **Wisp**, a ghost in a night sky (`/pet wisp`); `/pet corner` takes the corner away or gives it back. It acts out what Solder is doing: a thought bubble while the model thinks, a book for reading, a magnifying glass for searching, a laptop while a file is written, a question mark when Solder asks you something, a hop when the reply is done, and a nap after five quiet minutes. It's off until you ask for it, and your choice is remembered. Messages pass under it and it takes no clicks; it's hidden in Settings, the setup and Projects, and in a very narrow panel. With reduced motion turned on in your system it holds a still pose. It's drawn in the panel from a few hundred lines of code, with no image files: nothing about it is sent to the model, and it uses no tokens.

- **Docs folders skip what can't be a document.** Files with a binary extension (images, archives, programs, and build output such as `.o`, `.rlib` and `.rmeta`) are now left out as the folder is walked: not looked at, not kept in the index, and not counted toward a folder's 20,000-file limit, which a build's output could fill before the documents were reached. Folders that mark themselves as a cache (a `CACHEDIR.TAG` file, as Rust's `target` folder has) are skipped whole. Anything like that already in your index goes on the next refresh.

## 0.3.18 (2026-11-26)

- **Fix: a big docs folder you'd removed could freeze VS Code for an hour, on every start.** Fourteen days after a docs folder leaves your settings, Solder clears it out of its docs index. It did that one file at a time, and each file meant reading every passage in the index, with nothing else able to run meanwhile. A folder of 24,000 files took about an hour, the panel looked frozen throughout, and since nothing was kept until the end, every window load started it again. Each passage's file is now kept in a small indexed list, so finding a file's passages is immediate; a folder is cleared a batch at a time, with VS Code free between batches; and what's done is kept, so a reload carries on from there. Forgetting 3,000 files went from 9 seconds of frozen window to a third of a second. Updating a changed file in a large index is faster for the same reason. An index made before this gets its list filled in once, in a single pass.

## 0.3.17 (2026-11-26)

- **Tool models look at everything they need in one reply.** The instructions said "up to 8 reads" a reply, and a current model held to it: a rename across 25 files and a question needing 16 files read each took extra replies. Without the limit it did each in one, with 37% fewer tokens on the rename and the rest of the live tests unchanged. Reads in a reply now also run eight at a time, not four.

- **Fix: some models sent a second whole-file write with no text.** To save tokens, Solder sent an earlier task's long `write_file` and `edit_file` calls without their text. Some models copy the shape of their own earlier calls, so in a follow-up turn they sent `write_file` with a path and no content: it failed, and cost a round trip each time. Those calls now go as they came. Measured on such a model, a chat that writes two files and then changes the first: before, 0 of 4 runs passed, at 8.5 requests and about 33k input tokens; now 4 of 4, at 6 requests and about 25k. A long chat is still kept in bounds by its summary.

## 0.3.16 (2026-11-26)

From an eight-reviewer engine review (2026-11-25), step 1:

- **Assist models: a reply that says what it will do but sends nothing is asked once to send it.** An Assist model sometimes ends with "I'll inspect the function first." and no request, so nothing ran and the turn ended as if done: the most common way an Assist task failed in the live tests. Solder now answers such a reply once a turn, for free, asking for the request (or the answer, if it's done). Never after Stop, at the step limit, or with a message of yours waiting.
- **The problems check after a change tells the truth.**
  - A file that isn't open in a tab is checked too, in a background tab that's closed again: some languages (TypeScript among them) check only files in a tab, so a broken edit there used to look clean.
  - A reply's edits and writes are checked together, once, after the last of them, so several writes no longer wait one after another, and a file isn't checked before the rest of the reply is written.
  - A code file that nothing in VS Code checks (a PowerShell script with no PowerShell extension, say) says so once, so the model doesn't take silence for "no errors".
- **search takes a file or folder (`path`), and can list just the matching files (`files_only`).** A long attached file or paste is saved outside the workspace, where search couldn't reach it: finding one line in a 5,000-line log took several reads. Now it's one search, with the same approval rules as reading.
- **A file written whole replaces the task's earlier reads of it**, so the old copy isn't sent again with every later step (fewer tokens on the Tool lane).
- **Search around a match in minified code shows the match**, not the first 300 characters of the line.
- **Fix: two Undo backups made at the same moment for files of the same name** (in different folders) could overwrite each other, so one Undo put back the other file's text.
- **Fix: symbols never found a PowerShell `$variable`** by name, and `Get-Uptime` also matched inside `My-Get-Uptime`.

Step 2:

- **An outline for files VS Code can't outline.** For a PowerShell script with no PowerShell extension, Structured Text or SCL, a TwinCAT or other PLC XML export, a batch file, Python or SQL, Solder makes the outline from the text (functions, blocks and sections, with their lines), says so, and finds a name's definition in it. Before, the model's only way into a big script was reading it whole. A language that never gives an outline is waited for once, not every time.
- **A folder's own rules arrive before the first change there.** A subfolder's AGENTS.md used to reach the model only with a read in that folder, so a change made from a search, or a new file, could miss it. Now a search or symbols result brings it, and a change in a folder whose rules the model hasn't seen yet waits: the rules come back, and the model makes the change again following them.
- **A look at a file in the wrong folder (read_file or symbols) finds the right one**, when there's exactly one file of that name in the workspace, and says where it is. Changes are never redirected: they still need the exact path.
- **Edits written with spaces land on files indented with tabs** (and the other way round), when it's clear one tab stands for 2 or 4 spaces throughout, with the new text indented to match.
- **Tool models are nudged to make independent changes together** after reading several files, rather than one change a reply.
- **Assist models:**
  - A conversation carried over in one message (no session, a dead one, a switch) keeps your current request, your messages after it, and the skills and folder rules the task is using: earlier turns are shortened first, and only then are the oldest left out. A skill that had to be left out is sent again when it's read.
  - A reply cut off partway keeps the requests that arrived whole: they run, and the model is told the rest didn't arrive. When the session still holds the conversation, only what's new is sent.
  - Tool results reach the model as they were: a line of a file that happened to read like one of Solder's own notes was reworded, and a tab at a line's end was dropped.
- **A reply cut off at the model's output limit** is kept and marked unfinished, with Resume, instead of ending as if it were done.

Step 3:

- **Fewer tokens on every Tool-model request.** The instructions and tool descriptions are sent with every request, and in the live tests they were more than half of all tokens. They're shorter now, saying the same things once: the rules no longer list every tool (each tool's own description says what it does), the note on relative and full paths is said once instead of in every path argument, and search's docs argument is left out when you have no docs folders. About 1,400 characters (some 350 tokens) less on every request; the Assist setup message is about 1,000 characters shorter too.

## 0.3.15 (2026-11-25)

Fixes from an eight-reviewer bug hunt (2026-11-25). Nothing looks or works differently, except that these no longer happen.

- **Paste in terminal:**
  - PowerShell code whose braces don't balance (a stray `}`) is no longer sent as one `. { … }` command: the `}` closed it early, and the lines after it ran as they arrived, without Enter. It's asked about first, as other terminals are.
  - Something you copied while a paste was going in is no longer overwritten when the clipboard is put back.
- **Files and Undo:**
  - `write_file` on an open file that changed on disk unnoticed (network drives) brings it up to date first, so Undo and Review use what was really there, and a write is never wrongly called "unchanged".
  - A file whose details couldn't be read for a moment is no longer overwritten as if it were new, with no backup.
  - Typing in a file while Solder waits for its problems check is no longer taken for part of Solder's edit: Undo refuses, as for any change of yours since.
  - A binary file is refused cleanly, and an `old_text` that was only a line number no longer locks up the window.
- **What the model is shown:**
  - Search results keep the file's own backslashes (`C:\Temp` came back as `C:/Temp`).
  - A read past a file's end, or one that shortened long lines, no longer replaces an earlier full read.
  - Merge conflicts in `changes` are reported as conflicts.
  - A subfolder's AGENTS.md is found when the workspace is a drive root (`Z:\`).
- **Reading the model's requests (both lanes):**
  - Valid requests are taken exactly as written: a `,]` or `,}` inside a file's text is no longer removed.
  - A Windows path written with single backslashes keeps its `\t` and `\n` (`src\tools\new.ps1`).
  - On the Assist lane, a broken request no longer swallows the requests after it, and a block holding a list of requests runs each one.
  - A read you decline stops the rest of that reply, as a declined change does.
- **Chats and windows:**
  - Changing the working folder while a task runs in that chat applies from the next message: the running task, and any change waiting for your answer, stay where they started.
  - A folder chosen for a chat made in another window is saved so it means the same folder. A chat whose folder isn't in this window's workspace says so, instead of working in this window's first folder.
  - File links in the chat you're reading open that chat's files, not those of a task running in another chat.
  - Deleting a chat's last turn no longer deletes turns another window saved meanwhile. A late save of a deleted chat no longer brings it back. A chats folder that can't be listed for a moment no longer leaves the spinner going.
  - "Summarise, then switch" acts on the chat it was asked in, even if you opened another meanwhile; so do Rename and Delete.
  - Stop pressed while the last answer was being saved no longer sends the message you'd queued.
  - The status bar shows the open chat's tokens.
- **Setup, Settings and the key:**
  - Closing Settings, or the guided setup, while a save or Check connection is still going no longer shows an error.
  - Going Back in the guided setup to change the gateway clears the key typed for the old one.
  - Your organization's model filter applies in the guided setup and Check connection as it does in chats.
  - The key is loaded at start, so Explain this run before the side bar is opened sends it; a key changed in one window is used by the others.
  - Model lists that come back out of order no longer replace a newer one.
  - Settings applies folder changes to the folders as they are now (another window's changes stay), and keeps Assist models the filter hides; moving the last Assist model to Tool sticks.
- **Projects and export:**
  - Read it first opens a project you picked yourself, and each Edit under a project's Rules opens its own file.
  - A project's skills folder that's a link leading out of the project isn't read or written. Rename keeps the project's skill switches.
  - Export names folders it couldn't read, keeps a file beside the zip whose name starts the same, and Stop leaves an existing zip as it was.
- **Docs and embeddings:**
  - An embedding batch the gateway may have seen is no longer sent again (billed twice).
  - Results with bad positions are refused, not stored against the wrong passage.
  - A gateway that sends no token count still spends from the daily budget.
  - Search by meaning sees another window's reindex.
- **Streaming:** a reply cut off after the gateway reported its tokens counts them, and an event split across three chunks at a CR is read.
- **Webview:** code inside a Markdown link stays part of that link, and a step no longer goes missing when the next reply starts within a second.

## 0.3.14 (2026-11-25)

- **Fix: Paste in terminal broke multi-line PowerShell.** PowerShell runs each pasted line as soon as it ends, so an `if { }` ran before the `else` on the next line arrived, and that line failed on its own (the same for `catch`, or a line starting with `|` or `.Method()`). In a terminal VS Code says is PowerShell, several lines now go in as one command, wrapped in `. { … }`: nothing runs until you press **Enter**, it then runs as a script would, and its variables stay in your terminal. It isn't asked about any more there, since nothing runs early. Code with `using` goes in as before. Other terminals are as they were.

## 0.3.13 (2026-11-25)

- **Set the default model from the model picker.** Right-click a model in the picker beside Send (or press **Shift+F10** on it) for **Use in this chat** and **Set as default**. The default is what new chats start on, as **Settings → Connection** sets it, and it's marked *default* in the list. When your organization sets the model, there's nothing to change.
- **The guided setup spots an Assist model.** After you pick your default model, Solder asks it to call a tool (one small request, a few seconds). If it answers without one, your endpoint serves it without tool calling: the setup says so and offers **Mark it as an Assist model**, or **Keep it as a Tool model**. Before, such a model was left as a Tool model, and answered without ever looking at your files until you found the setting. A model already marked, or one the check can't reach, goes straight on.
- **Check connection offers the same.** When the model answers without calling the tool, the message has **Mark as an Assist model**. When your organization sets which models are which, it says so instead.
- **Read it first: a project you haven't added yet.** When Solder finds a project in your workspace (a `.solder` folder you haven't used), its row on the Projects screen, and the question that offers it, have **Read it first**: its page, read-only, with its rules file and skills, so you can see what it would tell the model before you use it. None of it is used until you choose **Use this project**.
- **Fix: the docs overpromised about a project you haven't added.** README, SECURITY.md and the design notes said nothing of such a project reaches the model. Its skills and skill switches don't, but a rules file (`AGENTS.md`) at the top of a workspace folder applies to every chat in that folder, project or not, as it always has. They now say so, and suggest reading it first.
- **New screenshots in the README**, among them the approval card and the setup's Assist offer.

## 0.3.12 (2026-11-24)

- **Solder asks before a long chat is moved to an Assist model that couldn't be sent all of it.** An Assist model that doesn't hold a chat yet (one you switch to, or the one offered when your allowance runs out) is sent the conversation in one message, up to **Assist carry-over tokens**: past that, the oldest part, your first request among it, was left out without a word. When that would happen, Solder now says how big the chat is and how much would go, and offers **Summarise, then switch**: the model the chat is on now writes a summary, and the new model is sent that and the recent turns. **Switch anyway** goes ahead as before. A chat that fits, or a switch to a Tool model (which is sent the whole chat, trimmed and summarised as ever), isn't asked about.
- **Fix: an Assist chat's token count was far too low.** The footer's **free** count added up what the gateway reported, and a gateway that keeps the conversation in a session counts only each new message, not the conversation the model holds. Each request now counts the conversation the session held as well (Solder's own estimate, where it's larger than the gateway's). The footer also shows how big the conversation the model holds is now (**in context**), which is what a switch to another model has to carry over.

## 0.3.11 (2026-11-24)

- **A finished turn says how long it worked.** Its row showed a time that was only how long the tools took to run, adding up to a second or two for a task that took ten minutes of the model's time. It now says **Worked for 10m 15s**: the whole turn, from your message to the answer, a Resume included and any time a card waited for your Allow left out. Chats from before this have no time on their rows.
- **README:** a section near the top on Tool models and Assist models: an Assist model gets no `tools` array but still uses all of Solder's tools, how to tell which kind a model is, and how to set it.

## 0.3.10 (2026-11-24)

- **A reply's edits are checked for problems once, together.** After an edit, Solder waits a moment for VS Code's language support and reports any new errors in the file. Several edits to one file already shared one check; edits to different files each waited for their own, so a reply that changed twenty files waited twenty times, and reported the errors a half-made change always has (a function given a new parameter before its callers are updated). Every file a reply edits is now checked at the end of its edits, all at once.
- **A change that fails no longer stops the changes to other files.** When one call in a reply failed, every call after it was skipped. Now that a reply can carry twenty edits, a miss at the third meant the other seventeen were written out and sent again. A failed edit or write now stops only what was built on it: later changes to the same file, and any move or removal after it. Changes to other files go ahead, and so do reads. A change you decline still stops everything after it, and so does a move or a removal that fails. In live runs with one edit made to miss, tasks finished every time on both kinds of model (it was 14 of 16), for about a fifth fewer tokens on a Tool model.
- **Search can show the lines around each match.** A search returns the matching lines, and when the model needed the code around one it read the file: another step. With `context_lines` (1 to 5) it gets each match with the lines before and after it, numbered as a file read numbers them, with matches near each other shown as one stretch.
- **Assist models are told what each argument means.** Solder describes its tools to an Assist model in plain words, and gave each tool's arguments by name only: what `glob` covers, what `docs` does, or that `line` is a number was left to be guessed. Each argument now comes with what it means, whether it's needed, and what kind of value it takes, as a Tool model has always been given.
- **`edit_file` can replace every place at once.** An edit changes one exact piece of text, so renaming something used six times in a file took six edits, each with enough around it to be unique, or a rewrite of the whole file. With `replace_all`, one edit changes every place the text appears in the file, exactly as written, and says how many places and on which lines. In live runs a rename across eight files took about half the requests.
- **Approval cards show the change.** A card asking about an edit showed its file and the reason, and nothing of the edit itself (only a whole-file write showed its text). It now shows the text taken out and the text put in, and both kinds of card have **Show diff**, which opens the file as it is beside the file as the change would leave it, worked out exactly as the change will be. Nothing is changed by looking, and an edit that wouldn't go through says why instead.
- **Review all.** A finished turn's row has **Review** beside **Undo all**. It opens VS Code's changes editor with one diff for each file the turn changed, from before the turn's first change to it to the file as it is now. A file edited five times is one diff, a new file is shown against nothing, a removed one against what it was, and moves are listed. Each step's own Review is still there; it compares only that step's copy with the file now, so a turn of twenty edits was twenty overlapping diffs.
- **Assist models: the panel says what's being written.** An Assist model writes its tool requests as text, which Solder doesn't show, so during a big write or a reply with many edits the panel sat still for up to a minute and a half and looked stuck. It now says which request is being written and how far it's got ("Editing src/app.ps1 (step 7) · 2.1 KB so far"), as it does on a Tool model.
- **The panel no longer lags behind a long reply.** Words appear at a reading pace, and when a lot arrived at once the rest was let out at a fixed rate: a long answer could go on appearing for half a minute after it had finished, with its buttons (Allow, Resume, Undo) held back until it was done. A backlog now catches up in a couple of seconds, and what's left when the reply finishes appears in under a second. With reduced motion set, text appears at once.
- **Assist models are no longer called a fallback.** The model picker, Settings and the guided setup describe the two kinds as they are (a Tool model: faster steps, uses your allowance; an Assist model: slower steps, doesn't, and may take more of them), without recommending one. The guided setup keeps a model you had already chosen, whichever kind it is: it used to swap an Assist model for a Tool one. The status bar shows a chat's Assist tokens as unbilled, where it showed 0.
- **When the allowance runs out, the switch is offered even without a matching name.** Solder offered to move the chat to "the Assist version of the same model", found by its name. Where the names don't pair up, it now offers the best Assist model there is.
- **Fix: "Index again" was missing when every docs folder comes from your organization.** It showed only when you had a folder of your own.
- **A reply's reads run side by side.** Calls that only look (reading a file, searching, finding files, symbols, changes), next to each other in a reply, ran one after another: eight reads of a slow share were eight waits. Up to four now run at once. The model still gets their results in the order it asked, a change still waits for the looks before it and holds back the ones after it, and a call that has to be asked about runs in its own turn.
- **Tool models: a call's small slips are forgiven.** Another agent's name for an argument (`file_path` for `path`, `old_string` for `old_text`), a trailing comma, a Windows path with single backslashes, a real line break inside a string: an Assist model's requests were already read through these, and a Tool model's call was refused, a billed step to send it again. Both are read the same way now.

- **Fix: an Assist model's tool request that couldn't be used was dropped without a word, sometimes with the ones after it.** When a reply held several requests and one in the middle couldn't be used (an argument missing, a tool that doesn't exist, text that couldn't be read, or the last one cut short at the length limit), the ones before it ran and the model was told nothing about the rest. With a sentence after the requests, the bad one was taken for an example and skipped while the later ones still ran. Either way the model could report a refactor done with only part of it made. Now the requests before it run, the one that couldn't be used and those after it don't, and the model is told so with the results: which one, why, how many came after, and to send them again. The step in the panel says a later request wasn't run.

## 0.3.9 (2026-11-23)

- **Assist models: a reply that's cut off carries on by itself.** When an Assist model's reply stopped partway (the gateway's stream ended early, the connection dropped, it went quiet), Solder showed the error and waited for **Resume**, every time. It now does what Resume does, once, without asking: what had arrived stays in the chat, and the model is asked to carry on in the same session. The status line says the reply was cut off and is being carried on, and the chat shows the **Carry on** it sent. If the reply is cut off again straight away, the error is shown with **Resume** as before. A reply you stopped is never carried on, nor is one that failed for a reason that would only repeat.
- **Every call in a reply runs.** A reply's calls were run up to 8 and the rest refused, to be sent again. For a big refactor a model sends fifteen or twenty edits at once, so the limit only cost steps, and on a Tool model the whole chat sent once more with each. All of them now run, in order, on Tool and Assist models alike (up to 50, a guard against a reply gone wrong). A change that fails still stops the ones after it, and what one reply's reads may bring back together is held to the same size as before.

## 0.3.8 (2026-11-23)

- **A reply can make up to 8 changes in one step.** A reply's calls were run up to 8, but only 5 of them could change files, so a model that sent six, seven or eight edits it already knew had the ones past the fifth refused and had to send them again: a step more, and the whole chat sent once more with it. The 8 now covers reads and changes alike. A change that fails still stops the ones after it.

## 0.3.7 (2026-11-22)

- **Solder asks before the model changes a rules file or a project's own files.** An edit, write, move or copy that touches `AGENTS.md` (or whichever names **Instruction files** gives, in any folder) or anything in a project's `.solder` folder (its skills, its name, its skill switches) now shows an approval card first. Later chats follow those files, so a change made in one chat would have carried into every chat after it, and to anyone the project is shared with, without anyone agreeing to it. Reading them is as free as before, and what you do yourself on the Projects screen and in Settings isn't asked about.
- **A workspace file asks too.** A change to a `.code-workspace` file is asked about like one to `.vscode`: it holds the same settings and tasks.
- **Fix: your key went to a newly entered gateway address.** Typing another gateway's address in Settings or the guided setup listed that gateway's models at once, with the key saved for the old one. A key now goes only to the gateway it was saved for (its scheme, host and port). Change the address and nothing is sent there with the old key: Settings and the guided setup say the saved key is another gateway's, and ask for this one's. A key you already have is taken as your current gateway's, so nothing changes until the address does. An address your organization sets by policy takes the key with it.
- **Fix: two VS Code windows could undo each other's chats.** Each window kept its own copy of a chat it had opened and saved the whole copy back. So pinning or renaming a chat in one window could erase the turns added to it in another, and a chat deleted in one window could come back from the other. Now:
  - a chat another window went on with shows its newer turns when you come back to the window, and before anything is done to it there;
  - a pin, a name or a model set from a copy that's behind lands on the chat as it is now, and the other window's turns stay;
  - a chat deleted in one window stays deleted, unless the other window has added turns of its own since;
  - if both windows added turns to the same chat, both are kept: one under the chat, the other as a copy named **(from another window)**.
- **Fix: a project removed in one window could come back from another.** The list of your projects was also each window's own copy, saved whole: adding a project in one window put back one you had removed in the other, and with it your yes to its rules and skills. Every window now goes by the one list, and changes it as it is at that moment.
- **Fix: a document that couldn't be read once could vanish from docs search.** A file that was open in another program, or on a share that dropped for a moment, was indexed as empty: its passages and their embeddings went, and stayed gone until the file next changed. A folder that failed to list took everything under it out the same way. Such a file or folder now keeps what the index has, and is tried again the next time; only what's really gone is forgotten. The log says how many files couldn't be read.
- **The multi-line paste warning can be switched off for a chat.** The question before pasting several lines into the terminal has a second button, **Paste, and don't ask again in this chat**. It applies to that chat only; every other chat still asks.
- **Fix: two terminal pastes in quick succession left the first one on your clipboard.** What you had copied is put back after a multi-line paste; a second paste within a second took the first paste for it.
- **The project's chip above the message box is gone.** The project is already named before the chat's title at the top of the panel, and clicking it there opens the project's page.

## 0.3.6 (2026-11-19)

- **Embedding has a Start and Stop button, in Settings.** A big embedding run used to ask in a notification at the bottom right, which went away and didn't come back until meaning search was turned off and on again. Now Settings → Docs / RAG has a row that says where embedding stands (waiting, running, stopped, waiting for tomorrow's budget, done) with one button: **Start embedding** or **Stop embedding**. A big run waits there for Start for as long as it takes; a notification says once that it's waiting, with a button to open Settings. Once started, a run carries on across restarts and over as many days as the budget needs without asking again. Stop holds everything until you press Start; what's embedded is kept and still used.
- **Embedding is paced.** Docs search by meaning now sends at most so many tokens a minute to the embeddings model, 250,000 unless you change it, so a big folder is embedded at a steady pace and isn't refused part-way by a gateway's per-minute limit. **Pace** in Settings → Docs / RAG sets it (0 for no limit), and the `EmbedTokensPerMinute` policy sets it for everyone. A gateway on this PC isn't paced.

## 0.3.5 (2026-11-19)

- **Fix: Settings, the guided setup and Projects wouldn't open while a reply was streaming.** They waited for the words to finish appearing. They now open at once, work while the reply goes on, and the reply is there when you go back.
- **Assist models are held back less.** Their tokens aren't billed, so the limits that are there to save tokens no longer apply to them:
  - **Nothing is trimmed.** Older tool results are no longer cut to stand-ins on the Assist lane (they were never summarised by themselves there).
  - **More steps a message.** A chat on an Assist model may take 60 steps with tool calls before it pauses, against 30 on a Tool model. The new **Assist max rounds** setting (and `AssistMaxRounds` policy) changes it.
  - **A bigger carry-over, set on its own.** When a conversation has to go to an Assist model in one request (a chat switched to one, or the gateway's session ended), it now takes up to 200,000 tokens of it, where it took four fifths of Compact at. The new **Assist carry-over tokens** setting (and `AssistCarryTokens` policy) sets it: keep it well inside what your Assist models can hold.

## 0.3.4 (2026-11-19)

- **The Explorer's right-click entry is named for Solder.** "Work in this folder" on a folder is now **Solder: Work in this folder**, so it's clear whose it is, as the docs and skills entries beside it already were.

- **Fix: right-clicking a file's name in an answer.** The menu was VS Code's own, with Cut, and a Copy that copied nothing. A file's name now has its own menu: **Copy** (the name as shown), **Copy as path** (its full path), **Open in VS Code** and **Show in Explorer**. It opens from the keyboard too (Shift+F10 or the menu key).

## 0.3.3 (2026-11-19)

- **Paste in terminal asks before pasting several lines.** Some terminals, Windows PowerShell among them, run each line of a paste as it arrives, without waiting for Enter. A block of more than one line now asks once, saying how many lines and why, before anything goes to the terminal. A single line is pasted as before.
- **Export a project.** A project's page has **Export…**: it writes one zip named after the project (`Script tests.solder.zip`), with either the project's own files (its rules, name, skills and their switches) or the whole folder, code included. Whoever gets it unzips it and opens the folder, and the Projects screen offers it. The whole-folder export leaves out git's history and `node_modules`, never follows links out of the folder, and asks first, since every file in the folder goes in.
- **Fix: the Projects screen could take seconds to open.** Opening it looked for projects in every folder of the workspace, one at a time, before drawing anything, and read every project's rules and skills just to show its name. On a network drive that was hundreds of round trips. The screen now opens at once and the look goes on behind it; a project's name comes from its own small file; and one pass over the saved chats serves a whole redraw.

## 0.3.2 (2026-11-18)

- **A chat's project shows in the bar.** In a project's chat, the project's name comes before the chat's title at the top of the panel (`Work › Fix the build`), so you can see which project you're in, or that you're in none, without opening anything. Clicking the name opens the project.

## 0.3.1 (2026-11-18)

- **Search by meaning no longer returns noise.** A passage now has to be near enough in meaning to count. Before, a question about nothing in your docs still brought back its nearest passages, whatever they were. The floor is a similarity of 0.58, measured with real questions on real docs. A search with nothing near enough falls back to keywords alone. Embeddings models score on their own scales, so the log (Copy diagnostics) shows each search's best similarity, and the new **Meaning floor** setting changes the floor for yours.
- **What you attach costs less.** Attached text goes whole with your message only up to about 40,000 characters in all. Past that, the rest goes by its path and the model reads the lines it needs: a file from where it is, a paste from a copy Solder saves in its own storage. Whole text is sent again with every step of a task, so a 400,000-character log used to cost about 100,000 tokens a step.
- **Each chip says what it will cost** before you send: about how many tokens when it goes whole, or "by path".
- **A file read twice in one task is kept once.** When the model reads lines of a file it has already read in the same task (often to check an edit), the older copy is cut to a line pointing at the newer one. Both used to be sent again with every later step. In a live test of read, edit, read again, the task used about 15% fewer tokens.

Fixes from a review of 0.3.0 by six reviewers.

- **Fix: sending from another chat could move a running task's files.** With a task working in one chat, pressing Send in another was refused, but first switched Solder to that other chat's folder and skills, so the task's next file could land in the wrong folder. A running task now keeps its folder, its skills and what it may read until it's done.
- **Fix: an attached file stayed readable without asking after its chip was removed.** A long file attached from outside the workspace is read without asking only once it's sent, only in that chat, and no longer once the message it went with is deleted. What's attached and unsent stays with its chat instead of following you into the next one.
- **Fix: a folder's own `.vscode` settings could set Solder's.** Rules, the step limit, Compact at, the model, model names, effort and instruction files are now your own settings only, so a repository you open can't supply them. The step limit and Compact at are also held to their ranges wherever they're read. If you had set one of these in a workspace's settings, set it in your user settings instead.
- **Fix: a project's skills folder could point somewhere else.** A project whose `.solder\skills` is a link or junction out of the project isn't used: it would have made that other place readable without asking.
- **Fix: a project's chat opened in another window could work in the wrong folder.** A chat's folder is now the folder it was saved for, not one of the same name in whichever window opens it, and a project's chat with no folder of its own works in its project.
- **Fix: deleting a chat's only turn, or editing its first message, left the old conversation on disk,** to come back after a reload.
- **Fix: a new profile with only the gateway's address in its settings had changes turned on.** It now starts read-only like any new install; only a saved key or saved chats count as having used Solder before.
- **Fix: the `changes` tool could run programs named in a repository's own git config** (filters, on a copied or cloned-in repository). Those are switched off for Solder's git; filters you set up yourself, such as Git LFS, still run.
- **Fix: Paste in terminal passed control characters through,** which a shell can read as key presses, one of them running the line. They're taken out, so nothing runs until you press Enter.
- **Fix: removing a docs folder, or turning search by meaning off, didn't stop the indexing run already going,** which kept sending that folder's passages to be embedded. The run now stops at once.
- **Fix: read-only mode arriving while a reply's steps ran didn't stop a change queued behind them,** or one waiting for your Allow.
- **Fix: a message queued while Solder worked was sent by itself when the reply failed,** clearing the error and its Resume button, and with the allowance used up failing again at once. It now goes back in the box.
- **Fix: a reply streaming in could draw the chat over Settings, the guided setup or Projects,** losing what you'd typed there, and a late update could flip the panel back to the chat you'd just left.
- **Fix: smaller things in the panel.** Escape in a project's new-skill form stopped the running task (Escape now stops a reply only from the chat itself); Shift+Tab in the slash-command list ran `/new`; a long run of `>` in an answer stopped the chat drawing; and a fence line inside a code block ended it early, so Copy took only part.

## 0.3.0 (2026-11-18)

- **Docs embeddings can be shared between PCs.** Set **Shared embeddings folder** (Settings → Docs / RAG, or the new `EmbeddingsCache` policy) to a folder your team shares. What one PC has embedded for search by meaning is put there and the others take it: no tokens, and nothing against the daily embedding budget. It applies where a file's text and the embeddings model are exactly the same; the folder holds numbers only (no text, no file names). A PC that had already embedded its docs puts them there too. If the folder can't be reached, embedding goes through the gateway as before.
- **Skills can be switched off, everywhere or in one project.** Each of your skills has a switch in **Settings → Skills**: off, the model isn't told about it. A project's page lists your skills with switches for that project alone, so a skill can be off in one project, or on only there; the project's own skills have switches too. A project's switches are kept in its folder, so they travel with it when it's shared. Your organization's skills are always on.

## 0.2.19 (2026-11-18)

- **Projects.** A project is a folder you work in, with its own rules, skills and chats.
  - **Starting a chat in one:** the arrow beside **+** lists your projects (**+** itself starts a chat in no project).
  - **The chats list is grouped by project:** the project you're in first, your other projects folded under it, then **Other chats**; each group sorted as before (pinned, then by age).
  - **The Projects screen** (the new button at the top of the panel) lists your projects with their chats, and has **New project…**.
  - **A project's page** shows all of it to read: its `AGENTS.md` in full, each of its skills, and its chats. You can rename it, edit or create its rules, and add, edit or delete its skills from there.
  - **Sharing:** everything a project is lives in its own folder (`AGENTS.md`, and a `.solder` folder with its name and skills), so copying or zipping the folder shares it; chats stay on your PC. Solder asks before using a project someone else set up, and a project can't change your settings.
- **The version shows in Settings,** at the top right of every tab.
- **A turn keeps more of what it read.** What the turn in progress has read now stays whole up to twice **Compact at** (it was one and a half times), so reading a long file through is less likely to have its start cut while the model still needs it.
- **Settings explains AGENTS.md, and makes one.** Settings → Rules now says what an instruction file is (one you write yourself, in a project's top folder), whether this workspace has one, and has **Create AGENTS.md** (or **Open** when it's there).
- **Fix: Resume and Continue could summarise the task in progress.** Pressing Resume or Continue (after the step limit, a Stop or an error) in a chat past **Compact at** summarised everything, the task being resumed included, so the model lost its place and read things again. Now only earlier turns are summarised, as before any other step.
- **Attach text files.** A paperclip beside Send attaches text files to your next message (Word, Excel and PowerPoint as their text). A file up to about 40,000 characters is sent whole; a longer one goes by its path, and the model reads only the parts it needs, without asking (you attached it). A signed script goes without its signature block.
- **Long pastes become chips.** Text you paste that's over 40 lines (or 4,000 characters) goes above the box as a chip, not into it, and shows in the chat as a chip too, so a hundred lines of log don't fill the scroll. ✕ takes it off before sending; a click shows it. Edit on a message brings its attachments back with its words.

## 0.2.18 (2026-11-18)

- **Fix: edits to a file on a network drive could lock up.** When a file changed outside VS Code (a script signed again, say) and VS Code never noticed, as happens on mapped and network drives, every edit was refused with "changed on disk a moment ago", and reading the file again gave the same old copy, so it never cleared. Now a read gives what's on disk, and before an edit Solder has VS Code reload the file, then makes the change. Your unsaved changes are never reloaded away.
- **Fix: a placeholder could be written into a file.** To save tokens, Solder sent earlier edits' long text as a one-line note inside the call. A model could copy that note as the text of a new edit, which failed several times and once wrote the note into the file. The long text is now left out without a note in its place (what's said about it goes with the call's result), the task being worked on keeps its calls whole even after Resume, and an edit whose text is that note is refused.

## 0.2.17 (2026-11-17)

- **Paste in terminal.** A shell's code block in an answer (PowerShell, bash, cmd and the like) has **Paste in terminal** beside **Copy**. It puts the command into VS Code's terminal for you to check and run with Enter; Solder never runs it. Several lines go through VS Code's own paste, with its warning where the shell would run each line as it arrives, and your clipboard is put back.

## 0.2.16 (2026-11-17)

- **Fix: an enforced `ToolModels` pattern can't be overridden.** A user's own Assist models list (made by moving models in Settings → Advanced → Kinds of model) used to win over the organization's pattern. Now the pattern decides, the user's list doesn't apply while it's enforced, and Kinds of model is locked.
- **A daily budget for docs search by meaning.** Embedding counts against the same daily allowance as the models, so it's now held to 250,000 tokens a day by default (from midnight UTC; Settings → Docs / RAG → Daily budget). Past it, embedding waits for the next day while keyword search goes on, and **raise it for today** carries on now. A gateway on your own PC isn't counted. New `EmbedDailyBudget` policy.
- **Fix: the `ReadOnly` and `AssistModels` policies didn't take effect.** In the ADMX templates since 0.2.10 (`AssistModels`) and 0.2.11 (`ReadOnly`), their registry path had lost its backslashes, so Group Policy wrote them where Solder doesn't look. Use the templates from this release; a new test checks every policy's path against the code.

## 0.2.15 (2026-11-17)

- **First start with your organization's gateway.** When the gateway comes from policy and you have no key yet, Solder now starts the guided setup (at the key, as the gateway is set) instead of showing a connection error (HTTP 401). A key that's there but turned away still shows the connection problem, now with **Guided setup** beside Try again, Settings and Set API key.

## 0.2.14 (2026-11-16)

- **Summaries and titles by the Assist twin.** When a chat's Tool model has an Assist twin on offer, the twin writes the chat's summary (compaction) and its title: they no longer use your allowance, and still work once it's used up. If the twin fails, or your organization's model filter doesn't allow it, the chat's own model does it, as before.
- **No more plans.** The model no longer sets out a checklist for longer tasks. Measured on six multi-step tasks, three runs each on two models: every task still succeeded (36 of 36 both ways), and without plans the same work took 36% and 53% fewer tokens, with about half the requests. Setting and ticking off a plan cost extra round trips, and each one resends the whole chat. Chats from before keep working: their old plan steps just aren't shown or sent.
- **Edit or delete your messages.** Point at one of your messages: **Delete** (the bin) takes it and its reply out of the chat, after asking; **Edit** (the pencil) takes it and everything after it, and puts your words back in the box. Files Solder changed stay as they are. On the Assist lane, the next message carries the chat over afresh, so the gateway's session doesn't keep what you removed.

## 0.2.13 (2026-11-15)

- **Help writing a skill.** Settings → Skills has a new button: **I have an idea for a skill, but I don't know how to write it**. It starts a chat where Solder asks you a few questions at a time, shows you a draft, and saves the skill once you say it's right (it makes your skills folder first if you have none).
- **Tool or Assist, made plain.** The guided setup lists the Tool models first, as recommended, with one chosen for you; the Assist models are folded away below as the fallback, with a short comparison of the two (how each works, speed, reliability, Effort, your allowance, and when to use which). Settings's Default model groups them the same way, and the Assist tag in the model menu now says it's the fallback (it used to lead with "Free"). The model chosen for you (in setup, or for a first chat with no default) is the best Tool model by its name: never a lite, mini or nano one while another is on offer, then the highest version, then a pro or max variant.

## 0.2.12 (2026-11-15)

- **Security fixes from a two-reviewer review.** A new `.gitattributes`, `.gitmodules` or `.gitconfig` written with an NTFS stream suffix (`.gitattributes::$DATA`) now asks for approval like the plain name. An instruction file (AGENTS.md) that is a link to somewhere outside the workspace is no longer read and sent as instructions. An Assist session block in a gateway response can no longer set fields of the next request (its model, tools or limits).
- **Fixes:** a link in a reply keeps the underscores and stars in its address (they were turned into italics, which broke the link); a reply containing NUL characters no longer stops the chat from redrawing; when an Assist chat is carried over after a setup change, none of the old setup is left in it (a line of your rules or AGENTS.md ending in a bracket could cut the note short).

## 0.2.11 (2026-11-12)

- **Read-only mode, on by default.** A new install of Solder reads, searches and explains code, but can't create, edit, move or delete files: the tools that change files aren't offered to the model, and aren't run if it asks for one anyway. It shows the change instead. Turn changes on once with **Enable tools** at the top of the panel, in the guided setup (a new last step), or in **Settings → Connection → Changes**; Solder never turns read-only mode back on by itself. If you set Solder up before this version, changes stay on. Organizations can enforce either with the new `ReadOnly` policy (in the ADMX templates). In read-only mode, `/skill` opens the New skill form, as the model can't write the file.

## 0.2.10 (2026-11-12)

- **A finished turn folds up.** While Solder works, every step shows as it happens. Once the turn is done, its steps fold into one row (how many, how many changes, how long), with **Undo all** on it; click the row to see them again, with Review and Undo on each.
- **The plan shows once.** While a planned task runs, its checklist is only above the box; when the turn is done, it's shown completed after the answer (it used to be in the chat and above the box at once).
- **The step limit is a pause, not an error.** A turn that reaches the most steps for one message says "Paused after 30 steps", in a calm colour, with **Continue** and **Stop here**. It's no longer nudged to carry on right at the limit (which made it try one more step, refused), and **Continue** tells the model it has a fresh allowance (it sometimes read the refused step as still blocked).
- **In Settings, the title closes them** (as Done does); it used to open a list of chats that did nothing there.
- **Fix:** Undo all was hard to read in some themes.
- **Security fixes from a twelve-reviewer bug hunt.** A path written with a Windows short name (`GIT~1` for `.git`) or through a link no longer gets past the approval for git's and VS Code's own files. `problems` on a file outside the workspace now asks first. An Assist model's example of a tool request inside a file it writes is no longer run as a request. An enforced **Model filter** now applies to what's sent, not only to the picker, and one that isn't a valid pattern offers no models (it used to offer all of them). **Copy diagnostics** no longer lets parts of a path with spaces through. An organization's skill can't be deleted when its policy folder starts with `~`.
- **Fixes for hangs and lost work.** A crafted Word, Excel or PowerPoint file in a docs folder could freeze VS Code while indexing (it now reads in linear time), and so could a regular-expression search with a pathological pattern. An Assist side request that timed out could be sent again (and billed again). `write_file` on a file that wasn't open now keeps its encoding (a UTF-8 BOM, UTF-16) and CRLF line endings. **Undo all** no longer stops at a moved or copied file edited later in the same task. A deleted item's backup can't be pruned away by a small storage limit, and a deleted chat no longer comes back when a save was waiting.
- **Plans trim like any task.** A finished step's results used to be cut as soon as the step was done, so models read the same lines again (the same walkthrough cost 115k tokens with a plan, 41k without). They now stay in the chat, and go first only if a long task outgrows its room. Live, on a long-file walkthrough: Sol's re-reads fell from about 4 a run to 1, and its tokens by about a quarter.
- **Spent and in context.** Under the box: what the chat has spent, and how much is in context now (what each step sends), which is what decides when it's summarised.
- **Kinds of model, picked by hand.** Settings → Advanced → Kinds of model lists your gateway's models as Tool models, and an arrow moves each Assist model across: no regular expression needed. Also by policy (`AssistModels`, in the ADMX templates).
- **New skill in Settings.** It's a form on the Skills tab now, not prompts at the top of the window; the guided setup makes your skills folder (`%APPDATA%\Solder\skills`).
- **The open file's path matches the working folder.** It was given relative to the workspace while relative paths start at the working folder, so the model's first call on it often failed.
- **Docs / RAG.** The Docs tab is renamed.
- **Smaller fixes:** search in docs keeps words in every language (it cut "Übersicht" to "bersicht" and dropped "東京"); `changes` reads paths like `app/[slug]` literally; a skill that opens with a `---` rule isn't taken for front matter; reset headers like `6m0s` are read as minutes; an Assist model gets two repairs for each request, not for the whole turn; two plans in one Assist reply stay two; a rename or pin of the chat a task runs in is kept; a stopped last step near the limit is resumed properly; a glob left open, and a git timeout, give clear messages; the arrow keys on a link in Settings' Rules tab no longer switch tabs; the starter cards come in one after another again.

## 0.2.9 (2026-11-11)

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
