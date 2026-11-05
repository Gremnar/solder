// @ts-check
"use strict";
/**
 * Every fixed text the model sees: the system prompt, the tool definitions and the notes Solder adds
 * to results. One place, pinned by test/prompt.test.js, so a change here is always deliberate.
 *
 * The system prompt is built to stay the same from request to request (no time of day, no file
 * listing): each user message carries the date and time instead.
 *
 * Solder reads and edits code; it doesn't run commands (no shell: nothing for Constrained Language
 * mode, AppLocker or endpoint security to trip over, and no script loops burning tokens).
 */

const RULES = `You are Solder, a coding agent in the user's VS Code. You read and edit the code in their \
workspace with the tools below; Solder runs each call and sends you the result. You can't run commands: when \
something needs building, testing or running, say what to run and the user will.

# How to work
- If the question doesn't need the workspace, just answer.
- Look with read_file, symbols, search and find_files (and, when the task is about recent work, changes \
shows what's changed since the last commit); change files with edit_file and write_file; check your work with problems (VS Code's errors and \
warnings). move_item moves, renames or copies a file or folder; remove_item deletes one, and asks the user \
first. There's no separate tool for folders: write_file and move_item create any folders a path needs.
- To find where a function, class or method is defined or used, use symbols rather than search: it follows \
imports and skips comments, strings and look-alike names.
- A working folder or open file named in the user's message tells you where they are, not what to do: read \
it only when the request is about it.
- Read only what the task needs. Start from what the user named, their selection or the active file.
- Never guess what a file says: read it.
- Follow the project's instructions (AGENTS.md) below; the user's message wins if they conflict.
- Make the smallest change that does the job, in the style of the code around it. Edits are saved at once \
and the user can undo them; after each edit you'll see any new problems in that file. Fix what you broke \
before moving on.
- Calls in one reply run in order and stop at the first that fails or is declined (a failed read doesn't \
stop later reads). Make several at once only when you already know everything each one needs.
- Every result is sent again with each later step, so keep outputs small: search before reading, and for a \
big file you haven't seen, get its outline (symbols) and read only the lines you need.
- If a change could lose the user's work, or the request is unclear, ask first.

# How to answer
- The user reads your reply as it is: don't put your reasoning, drafts or second thoughts in it.
- Before a tool call, write one short sentence at most, or nothing.
- When the task is done, say what you changed or found in a few sentences, with file paths. Use Markdown. \
Don't paste back files you edited.`;

/**
 * The system message.
 * @param {{workspace: string, os?: string, instructions?: {path: string, text: string}[], rules?: string,
 *          docs?: {path: string, about?: string}[]}} context
 */
function systemPrompt({ workspace, os = "Windows", instructions = [], rules = "", docs = [] }) {
  const facts = [`- Workspace folder: ${workspace || "(none open)"}. Relative paths are relative to the working folder \
when the user's message names one, otherwise to this folder; searches start there too.`,
    `- OS: ${os}.`,
    "- Each of the user's messages starts with their local date and time."];
  if (!instructions.length) facts.push("- There's no project instructions file (AGENTS.md) at the workspace root, so \
don't look for one. One in a subfolder is added to your first read there.");
  let text = RULES + "\n\n# The workspace\n" + facts.join("\n");
  for (const file of instructions) {
    text += `\n\n# Project instructions (${file.path})\n${file.text.trim()}`;
  }
  if (docs.length) {
    text += "\n\n# Docs\nThe user keeps reference documentation in these folders. When a task needs something the \
workspace doesn't have (their own APIs, hardware, specifications), search them with search and docs: true, then read \
the passage you need with read_file:\n" + docs.map((folder) => `- ${folder.path}${folder.about ? `: ${folder.about}` : ""}`).join("\n");
  }
  if (rules.trim()) text += "\n\n# The user's rules\n" + rules.trim();
  return text;
}

const RELATIVE = "a path relative to the workspace folder, or a full path";

/** name → [description, {argument: schema}, required[]] */
const TOOLS = {
  read_file: ["Returns a text file with line numbers (unsaved changes in the editor included). Up to 2,000 \
lines at a time: for a longer file, ask for a range (symbols shows where things are).", {
    path: { type: "string", description: `The file: ${RELATIVE}.` },
    start_line: { type: "integer", description: "The first line to return (lines are numbered from 1)." },
    end_line: { type: "integer", description: "The last line to return." },
  }, ["path"]],
  symbols: ["Uses VS Code's language support. With just a path: the file's outline (its classes, functions, \
methods and so on, nested, with line ranges), much smaller than the file. With a name: where that symbol is \
defined, with its code, or (find: references) every place it's used; give a file it appears in if you know one.", {
    path: { type: "string", description: `The file: ${RELATIVE}. With name, a file it appears in (optional).` },
    name: { type: "string", description: "A function, class, method or variable name." },
    find: { type: "string", enum: ["definition", "references"], description: "What to find for name: definition (the default) or references." },
    line: { type: "integer", description: "The line where name appears, when it appears more than once in the file." },
  }, []],
  search: ["Searches file contents in the workspace (respecting .gitignore) and returns matching lines as \
path:line: text, up to 200.", {
    query: { type: "string", description: "The text to find." },
    regex: { type: "boolean", description: "True to read query as a regular expression." },
    glob: { type: "string", description: "Only search files matching this, such as src/**/*.ts or *.py." },
    docs: { type: "boolean", description: "True to search the user's docs folders (see Docs) instead: the best \
passages for the query's words, in any order (regex and glob don't apply)." },
  }, ["query"]],
  find_files: ["Lists workspace files whose paths match a glob (respecting .gitignore and files.exclude), \
up to 300.", {
    glob: { type: "string", description: "A glob such as **/*.json, src/**/test_*.py or **/README*." },
  }, ["glob"]],
  changes: ["Shows what's changed in git since the last commit. With no path: the changed files (staged, \
unstaged and new) with their line counts, and the diff too when it's small. With a path: the diff for that file \
or folder. Unsaved editor changes aren't included.", {
    path: { type: "string", description: `Just this file or folder: ${RELATIVE}.` },
  }, []],
  edit_file: ["Replaces one exact piece of text in a file and saves it. old_text must appear exactly once: \
include enough surrounding lines to make it unique. Returns any new problems in the file.", {
    path: { type: "string", description: `The file: ${RELATIVE}.` },
    old_text: { type: "string", description: "The exact text to replace, appearing once in the file." },
    new_text: { type: "string", description: "The text to put in its place." },
  }, ["path", "old_text", "new_text"]],
  write_file: ["Writes a whole file (creating it, and its folders, if needed) and saves it. For a change to \
part of an existing file, use edit_file. Returns any new problems in the file.", {
    path: { type: "string", description: `The file: ${RELATIVE}.` },
    content: { type: "string", description: "The file's whole text." },
  }, ["path", "content"]],
  move_item: ["Moves or renames a file or folder, or copies it (copy: true), creating any folders needed. A to that's \
a folder, or ends with /, means into it. Never overwrites; the user can undo it.", {
    from: { type: "string", description: "The file or folder." },
    to: { type: "string", description: "Its new path, or a folder to put it in." },
    copy: { type: "boolean", description: "True to copy instead." },
  }, ["from", "to"]],
  remove_item: ["Deletes a file or a folder (with everything in it). The user is asked first, and can undo it.", {
    path: { type: "string", description: `The file or folder: ${RELATIVE}.` },
  }, ["path"]],
  problems: ["Returns the errors and warnings VS Code currently shows (from its language servers and \
linters), for one file or the whole workspace.", {
    path: { type: "string", description: `Just this file: ${RELATIVE}.` },
  }, []],
};

/** Tools that only look: more of them fit in one reply, and one failing doesn't stop the rest. */
const READ_ONLY = new Set(["read_file", "symbols", "search", "find_files", "changes", "problems"]);

/** The tools array, in a fixed order. */
function toolDefinitions() {
  return Object.entries(TOOLS).map(([name, [description, properties, required]]) => ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required } },
  }));
}

const TEXTS = {
  notRun: "Not run: an earlier call in this reply failed or was declined, so this one was skipped.",
  notRunStopped: "Not run: the user stopped the reply before this call.",
  notRunFull: "Not run yet, only because this reply's results reached the size limit for one step. Call it again \
in your next step, before you answer: nothing is wrong with it.",
  resume: "Please carry on from where you stopped.",
  resumeStopped: "Please carry on from where you stopped. I stopped it, but I didn't mean to cancel anything: run \
again whatever was stopped or not run, then go on.",
  stoppedRunning: "Stopped: the user stopped the reply while this was running, so there's no result.",
  notRunFailed: "Not run: the reply failed (a connection or gateway problem) before this call.",
  notRunLimit: "Not run: the step limit for one message was reached.",
  notRunBatch: (/** @type {number} */ limit) =>
    `Not run: Solder runs up to ${limit} calls from one reply. Send it again if you still need it.`,
  repeat: "Not run again: it's the same call as an earlier one in this reply (see that result).",
  declined: "The user declined this.",
  userNote: (/** @type {string} */ note) => `The user's note: ${note}`,
  unknownTool: (/** @type {string} */ name, /** @type {string[]} */ offered) =>
    `There's no tool called ${name}. The tools are: ${offered.join(", ")}.`,
  badArguments: "The call's arguments weren't valid JSON, so it wasn't run.",
  missing: (/** @type {string} */ name, /** @type {string} */ arg) => `${name} needs ${arg}; it wasn't run.`,
  wrongType: (/** @type {string} */ name, /** @type {string} */ arg, /** @type {string} */ type) =>
    `${name}'s ${arg} must be ${type === "integer" ? "a whole number" : type === "boolean" ? "true or false" : "text"}; it wasn't run.`,
  cutOff: "The call was cut off at the length limit before its arguments ended, so it wasn't run. Send it again \
in smaller parts: for a big file, write_file with the first part, then edit_file to add the rest.",
  emptyReply: "\n\n(Your reply to this came back empty, so here it is again. Please carry on: make your next call, \
or give your answer.)",
  wrapUp: (/** @type {number} */ left) => left <= 0
    ? "That was the last reply with tool calls allowed for this message, so answer now: say what's done and what's still left."
    : `${left} more ${left === 1 ? "reply" : "replies"} with tool calls left for this message: finish up, then say what's done.`,
  steer: (/** @type {string} */ text) => `Also, a message from the user while you were working:\n\n${text}`,
  argumentLeftOut: (/** @type {number} */ lines) =>
    `[Solder: ${lines.toLocaleString("en-US")} lines, left out of this copy of the chat to save space. They're in the file; read it if you need them.]`,
  resultCut: (/** @type {number} */ chars) =>
    `…(${chars.toLocaleString("en-US")} characters of this output are left out here; narrow the call down to see them)…`,
  stub: (/** @type {string} */ summary) => `Solder ran this earlier (${summary}) and you saw the full output then; \
it's left out here to save space. Read it again, narrowed down, if you still need it.`,
  compaction: "Before we continue, please write a summary of our conversation so far that could stand in for the \
full history. Keep my goals and preferences, key facts, decisions and conclusions, open questions, and any code, \
file names, numbers or exact values that may matter later. Note which files were changed and how. Be concise but \
complete, use short headings and bullet points, and reply with only the summary.",
  compactionTranscript: "Here's our conversation so far, as a transcript:",
  compactionFocus: (/** @type {string} */ focus) => `In the summary, take particular care to keep this: ${focus}`,
  titleRequest: (/** @type {string} */ excerpt) => "Give a short title, two to four words, for a chat that begins like \
this. Reply with only the title, without quotes.\n\n" + excerpt,
  compactionSystem: "You write concise, complete summaries of coding conversations.",
};

/** The tools' results and errors (src/tools.js). An error reaches the model as "Error: " + the text. */
const RESULTS = {
  networkPath: "Network paths (\\\\server\\share) aren't opened, outside the workspace: use a path on this PC.",
  error: (/** @type {string} */ message) => `Error: ${message}`,
  noPath: "No path was given.",
  noTool: (/** @type {string} */ name) => `There's no tool called ${name}.`,
  noWorkspace: "No workspace folder is open.",
  missing: (/** @type {string} */ file) => `${file} doesn't exist.`,
  isFolder: (/** @type {string} */ file) => `${file} is a folder.`,
  readFolder: (/** @type {string} */ file) => `${file} is a folder; use find_files to list it.`,
  tooLarge: (/** @type {string} */ file, /** @type {number} */ mb) => `${file} is too large to read (${mb} MB).`,
  notText: (/** @type {string} */ file) => `${file} couldn't be opened as text (it may be a binary file).`,
  readPart: (/** @type {number} */ start, /** @type {number} */ end, /** @type {number} */ total) =>
    `(lines ${start}–${end} of ${total}; ask for a range for more)`,
  readEmpty: "(the file is empty)",
  outlineHead: (/** @type {string} */ file, /** @type {number} */ lines) =>
    `${file}: ${lines.toLocaleString("en-US")} line${lines === 1 ? "" : "s"}. Each entry: kind, name, lines.`,
  outlineCapped: (/** @type {number} */ more) =>
    `(${more.toLocaleString("en-US")} more entries left out; read a range to see the rest of that part)`,
  noOutline: (/** @type {string} */ file, /** @type {number} */ lines) => `VS Code has no outline for ${file} (no \
language support for this kind of file, or nothing in it to list). It has ${lines.toLocaleString("en-US")} \
line${lines === 1 ? "" : "s"}: read it, or a range of it.`,
  badFind: 'find must be "definition" or "references".',
  symbolsNeedsPath: "symbols needs a path (for an outline) or a name.",
  alsoText: (/** @type {string} */ name) => `Also, whole-word text matches for ${name} that VS Code didn't count as uses (comments, \
strings, or uses it missed, such as through require):`,
  notChecked: (/** @type {string} */ file) => `VS Code hasn't checked ${file}: its language support only checks files open in an editor, and this one isn't. Its problems are unknown, not necessarily none; the user can open it to have it checked.`,
  pastEnd: (/** @type {string} */ file, /** @type {number} */ lines) => `${file} has only ${lines.toLocaleString("en-US")} line${lines === 1 ? "" : "s"}.`,
  sameText: "old_text and new_text are the same, so there's nothing to change.",
  changedOnDisk: (/** @type {string} */ file) => `${file} changed on disk a moment ago and VS Code hasn't caught up yet, so nothing \
was changed. Read it again, then make the change.`,
  notSaved: (/** @type {string} */ file) => `VS Code couldn't save ${file} (it may be read-only, or have changed on disk), so the \
change was undone in the editor too. Read it again before trying anything else.`,
  notWritable: (/** @type {string} */ file) => `${file} couldn't be written: it may be read-only, or locked by another program.`,
  sameContent: (/** @type {string} */ file) => `${file} already has exactly that content, so nothing changed.`,
  notInFile: (/** @type {string} */ name, /** @type {string} */ file) =>
    `${name} doesn't appear in ${file} as a whole word. Give a file it appears in (search finds one).`,
  definitions: (/** @type {string} */ name, /** @type {number} */ count) =>
    `${name} is defined in ${count === 1 ? "one place" : `${count} places`}:`,
  references: (/** @type {string} */ name, /** @type {number} */ count, /** @type {number} */ files) =>
    `${name} is used in ${count.toLocaleString("en-US")} place${count === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}:`,
  referencesCapped: (/** @type {number} */ more) =>
    `(${more.toLocaleString("en-US")} more left out; narrow it down with search and a glob if you need them)`,
  definitionCut: "(the rest of it is left out; read a range for more)",
  noLanguageHits: (/** @type {string} */ name) => `VS Code's language support found nothing for ${name} (it may not cover \
this kind of file, or may still be starting). Whole-word text matches instead, which can include comments, strings \
and other things with the same name:`,
  noHitsAtAll: (/** @type {string} */ name) => `VS Code's language support found nothing for ${name}, and there are no \
whole-word text matches either.`,
  noGit: "Git isn't available here (not installed, or blocked), so changes can't be shown.",
  notGit: (/** @type {string} */ where) => `${where} isn't in a git repository, so there are no changes to show.`,
  gitFailed: (/** @type {string} */ message) => `git couldn't show the changes: ${message}`,
  noChanges: (/** @type {string} */ where) => `Nothing has changed since the last commit${where ? ` in ${where}` : ""}.`,
  changedFiles: (/** @type {number} */ count, /** @type {boolean} */ withDiff) =>
    `Changed since the last commit (${count} file${count === 1 ? "" : "s"})${withDiff
      ? ", with the diff below (new files aren't in it: read the ones that matter for the task)" : "; call changes with a path for a diff"}:`,
  changedCapped: (/** @type {number} */ more) => `(${more} more; call changes with a folder to narrow it down)`,
  newFiles: (/** @type {string[]} */ files) => `New, not in git yet (read the ones that matter for the task): ${files.join(", ")}`,
  noCommits: "The repository has no commits yet, so everything in it is new.",
  unsaved: (/** @type {string[]} */ files) => `Unsaved changes in the editor aren't included: ${files.join(", ")}.`,
  docsNone: "No docs folders are set up. The user can add them in Solder's settings (Docs folders), or with \
\"Use as Solder docs\" on a folder in the Explorer.",
  docsUnavailable: "Docs search needs a newer VS Code (its built-in SQLite), so it isn't available here.",
  docsHits: (/** @type {string} */ query, /** @type {number} */ count) => `The best ${count === 1 ? "passage" : `${count} passages`} \
in the docs for ${query}, best first. [Brackets] mark the matching words; read_file the lines shown for the whole passage:`,
  docsLoose: (/** @type {number} */ best, /** @type {number} */ of) => `(Loose matches: the best of these has only ${best} of \
your ${of} words, so they may be about something else.)`,
  docsNoMatches: (/** @type {string} */ query) => `Nothing in the docs matches ${query}, so it's probably not in them: carry \
on without it rather than searching again with other words (unless you have an exact name or number to try).`,
  docsBuilding: (/** @type {number} */ files) => `(The docs index is still being built, ${files.toLocaleString("en-US")} \
files so far, so these results may be incomplete.)`,
  docsTruncated: `(Some docs folders hold more than 20,000 files; the rest aren't searched.)`,
  longLine: (/** @type {number} */ line, /** @type {number} */ chars) =>
    `(line ${line} is ${chars.toLocaleString("en-US")} characters long, so only its start is shown; use search to find text in it)`,
  folderAgents: (/** @type {string} */ file, /** @type {string} */ text) =>
    `This folder's ${file} says (it applies to files under it):\n${text}`,
  noMatches: (/** @type {string} */ query, /** @type {string} */ glob) => `No matches for "${query}"${glob ? ` in ${glob}` : ""}. \
If you were checking whether something already exists, it probably doesn't: carry on without it rather than \
searching again with other words.`,
  searchCapped: (/** @type {number} */ limit) =>
    `(The first ${limit} matching lines; narrow the search with glob or a longer query.)`,
  badRegex: "That regular expression isn't valid.",
  searchFailed: "the search failed",
  stopped: "Stopped.",
  noFiles: (/** @type {string} */ glob) => `No files match ${glob}.`,
  filesCapped: (/** @type {number} */ limit) => `(The first ${limit}; narrow the glob.)`,
  emptyOldText: "old_text is empty; use write_file to replace a whole file.",
  manyMatches: (/** @type {number} */ count, /** @type {string} */ file, /** @type {number[]} */ lines) =>
    `old_text appears ${count} times in ${file} (at lines ${lines.join(", ")}); include more surrounding lines to make it unique.`,
  notFound: (/** @type {string} */ file, /** @type {number} */ firstLineAt) => `old_text wasn't found in ${file}.` + (firstLineAt > 0
    ? ` Its first line appears at line ${firstLineAt}, but the lines after it differ: read the file again around there and copy the text exactly.`
    : " Read the file again and copy the text exactly."),
  notApplied: (/** @type {string} */ file) => `VS Code didn't apply the change to ${file}.`,
  edited: (/** @type {string} */ file, /** @type {number} */ removed, /** @type {number} */ added, /** @type {number} */ from) =>
    `Edited ${file}: replaced ${removed} line${removed === 1 ? "" : "s"} with ${added}, from line ${from}.`,
  written: (/** @type {boolean} */ existed, /** @type {string} */ file, /** @type {number} */ lines) =>
    `${existed ? "Wrote" : "Created"} ${file} (${lines} line${lines === 1 ? "" : "s"}).`,
  newProblems: (/** @type {string} */ file, /** @type {string[]} */ lines, /** @type {number} */ more) =>
    `\n\nNew problems in ${file} now:\n${lines.join("\n")}` + (more > 0 ? `\n- and ${more} more` : ""),
  noProblems: (/** @type {string} */ file) => file ? `No errors or warnings in ${file}.`
    : "No errors or warnings in the files VS Code has checked (mostly the open ones). To check a file that isn't open, give its path.",
  moreProblems: (/** @type {number} */ more) => `(${more} more)`,
  removeRoot: "That's the workspace folder (or a drive) itself; Solder won't remove it.",
  moveRoot: "That's the workspace folder (or a drive) itself; Solder won't move it.",
  moveSame: "from and to are the same place, so nothing was done.",
  moveIntoItself: "A folder can't go inside itself.",
  moveExists: (/** @type {string} */ file) => `Something is already at ${file}, and move_item never overwrites: choose another name, or remove it first.`,
  moveUnsaved: (/** @type {string} */ file) => `${file} has unsaved changes in the editor. Ask the user to save it first.`,
  moved: (/** @type {boolean} */ copied, /** @type {string} */ from, /** @type {string} */ to, /** @type {number | null} */ files) =>
    `${copied ? "Copied" : "Moved"} ${from} to ${to}` + (files === null ? "" : ` (a folder with ${files.toLocaleString("en-US")} file${files === 1 ? "" : "s"})`) + "."
    + (copied ? "" : " Anything that imports or links to it by its old path still points there."),
  moveMentions: (/** @type {string} */ name, /** @type {string[]} */ lines) =>
    `These lines mention ${name} and may still use the old path; update the ones that do:\n${lines.join("\n")}`,
  removeNoTrash: (/** @type {string} */ file) =>
    `${file} couldn't be moved to the Recycle Bin, and it's too big to keep a copy of, so it wasn't removed.`,
  removed: (/** @type {string} */ file, /** @type {number | null} */ files) =>
    `Removed ${file}` + (files === null ? "" : ` (a folder with ${files.toLocaleString("en-US")} file${files === 1 ? "" : "s"})`) + ".",
};

/**
 * The cards on a new chat's screen: clicking one sends its prompt, in the user's own words, and the chat is
 * named after its title. Ask-first prompts ask one to three questions at a time, as Alloy's do.
 */
const STARTERS = [
  { id: "summary", title: "Summarise this codebase", blurb: "What it's for, how it's laid out, and where to start reading.",
    prompt: "Give me an overview of this codebase: what it's for, how it's organised, the main parts and how they fit \
together, and where I should start reading. Look at its structure and key files first (outlines help with big ones), \
read only what you need, and keep it to a short summary with file paths." },
  { id: "script", title: "Explain or fix a script", blurb: "A script or function that fails or puzzles you.",
    prompt: "I have a script or piece of code I'd like explained or fixed. Ask me where it is, what it should do and \
what goes wrong (an error message, or what it does instead), one to three questions at a time. Read it before you \
suggest anything, explain what you find in plain words, and tell me what you'd change before you change it." },
  { id: "cleanup", title: "Clean up and organise", blurb: "Structure, naming and dead code, one step at a time.",
    prompt: "I'd like to clean up and organise this codebase. Look at how it's laid out first, then suggest a short \
plan: what you'd rename, move, merge or remove, and why, the most worthwhile first. Don't change anything until I've \
said which parts to do; then do them one at a time and check for problems after each." },
  { id: "learn", title: "Learn a language or concept", blurb: "Step by step, with examples from your own code.",
    prompt: "I'd like to learn a coding language or concept. Ask me which one and what I already know, one to three \
questions at a time. Then teach it step by step at my pace, with short examples, using code from this workspace where \
it helps, and check I've understood before moving on." },
  { id: "review", title: "Review my changes", blurb: "What's changed since the last commit, checked for mistakes.",
    prompt: "Review my uncommitted changes. Look at what's changed since the last commit, read around the changes \
where you need to, and tell me about anything that looks wrong or risky (bugs, missed cases, leftovers), the most \
important first, with file and line. Don't change anything." },
  { id: "intro", title: "What can Solder do for me?", blurb: "Its tools, and ideas for your own work.",
    prompt: "What can you do for me in this chat? Tell me briefly, in plain words, what each of your tools lets you do \
with my code, and what you can't do (such as running commands). Then ask me what I mostly work on, one to three questions at a time, and suggest \
a few concrete things you could take off my hands." },
];

/** What goes with your message: where you're working, the open file, your selection, an undo you made. */
const CONTEXT = {
  workingIn: (/** @type {string} */ folder) => `(I'm working in ${folder}: relative paths and searches start there.)`,
  openFile: (/** @type {string} */ file) => `(The file open in my editor, for reference: ${file}.)`,
  selected: (/** @type {string} */ file, /** @type {number} */ first, /** @type {number} */ last, /** @type {string} */ language,
    /** @type {string} */ text, /** @type {string} */ fence) => `(Selected in ${file}, lines ${first}–${last}:)\n${fence}${language}\n${text}\n${fence}`,
  cutShort: "\n…(cut short)",
  undid: (/** @type {string} */ file, /** @type {string} */ step) => `(I undid your change to ${file}: ${step}.)`,
};

/** What the editor's right-click menu sends with the selected code (the selection itself goes along as context). */
const SELECTION = {
  explain: "Explain the selected code: what it does, how it does it, and anything surprising or risky in it. Keep it short.",
  fix: "Fix the selected code with the smallest change that does it, then tell me in a sentence or two what was wrong.",
  problems: (/** @type {string[]} */ lines) => `(VS Code's problems in the selection:)\n${lines.join("\n")}`,
};

/** "(Wednesday, 4 November 2026, 14:05)": what each user message starts with. @param {Date} [now] */
function timeNote(now = new Date()) {
  const day = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const time = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `(${day}, ${time})`;
}

module.exports = { RULES, TOOLS, READ_ONLY, TEXTS, RESULTS, STARTERS, SELECTION, CONTEXT, systemPrompt, toolDefinitions, timeNote };
