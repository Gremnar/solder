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
- Look with read_file, symbols, search and find_files (changes: what's changed since the last commit); change \
files with edit_file and write_file; check them with problems (VS Code's errors and \
warnings). move_item moves, renames or copies a file or folder; remove_item deletes one, and asks the user \
first. write_file and move_item create any folders a path needs.
- To find where a function, class or method is defined or used, use symbols rather than search: it follows \
imports and skips comments, strings and look-alike names.
- A working folder or open file named in the user's message tells you where they are, not what to do: read \
it only when the request is about it.
- Read only what the task needs. Start from what the user named, their selection or the active file.
- Never guess what a file says: read it.
- Follow the project's instructions (AGENTS.md) below; the user's message wins if they conflict.
- Make the smallest change that does the job, in the style of the code around it. Edits save at once (the \
user can undo them), and you'll see any new problems they cause: fix what you broke before moving on.
- Calls in one reply run in order and stop at the first that fails or is declined (a failed read doesn't \
stop later reads). When you know several files or names you need, look at them in one reply (up to 8 reads), \
not one per reply. Batch edits only when you know everything each one needs.
- Every result is sent again with each later step, so keep outputs small: search before reading, and for a \
big file you haven't seen, get its outline (symbols) and read only the lines you need.
- For a task of two or more steps, call plan first, then do one step at a time. When a step is done, call plan \
with done and notes on what you did and what later steps need: that step's results are then left out of the chat. \
Call it alongside your other calls; skip it for small tasks.
- If a change could lose the user's work, or the request is unclear and reading the code can't settle \
it, ask first: one to three short questions, each with the choice you'd recommend.

# How to answer
- The user reads your reply as it is: don't put your reasoning, drafts or second thoughts in it.
- Write no text alongside tool calls (the user sees each step), except to ask something or flag a surprise.
- When the task is done, say what you changed or found in a few sentences, with file paths. Use Markdown. \
Don't paste back files you edited.`;

/**
 * The system message.
 * @param {{workspace: string, folders?: string[], os?: string, instructions?: {path: string, text: string}[], rules?: string,
 *          docs?: {path: string, about?: string}[]}} context
 */
function systemPrompt({ workspace, folders = [], os = "Windows", instructions = [], rules = "", docs = [] }) {
  const several = folders.length > 1;
  const facts = [several
    ? `- Workspace folders: ${folders[0]} (the main one), ${folders.slice(1).join(", ")}. Relative paths are relative \
to the working folder when the user's message names one, otherwise to the main folder; use full paths for the others. \
Searches cover all of them, or just the working folder when there is one.`
    : `- Workspace folder: ${workspace || "(none open)"}. Relative paths are relative to the working folder \
when the user's message names one, otherwise to this folder; searches start there too.`,
    `- OS: ${os}.`,
    "- Each of the user's messages starts with their local date and time."];
  if (!instructions.length) facts.push(`- There's no project instructions file (AGENTS.md) at the ${several ? "top of any workspace folder" : "workspace root"}, so \
don't look for one. One in a subfolder is added to your first read there.`);
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
passages for the query (a few key words, or a short question), in any order (regex and glob don't apply)." },
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
  plan: ["Sets out a task of several steps, or marks one finished. The user sees each step's goal as a checklist. \
With steps: the plan (replacing any earlier one; steps already done stay done). With done: that step is finished, \
and its notes are kept in place of its tool results, which are left out of the chat from then on.", {
    steps: { type: "array", description: "The plan, in order.", items: { type: "object", properties: {
      goal: { type: "string", description: "One sentence the user sees, such as \"Fix the date parsing in Get-Report\"." },
      work: { type: "string", description: "What the step needs: files, functions, what to check. Only you see it." } },
      required: ["goal"] } },
    done: { type: "integer", description: "The step just finished (numbered from 1)." },
    notes: { type: "string", description: "With done: what you did, and anything later steps need from it (names, \
values, decisions), in a few lines." },
  }, []],
};

/** Tools that only look: more of them fit in one reply, and one failing doesn't stop the rest. */
const READ_ONLY = new Set(["read_file", "symbols", "search", "find_files", "changes", "problems", "plan"]);

/** The tools array, in a fixed order. */
function toolDefinitions() {
  return Object.entries(TOOLS).map(([name, [description, properties, required]]) => ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required } },
  }));
}

/** "a", "a and b", "a, b and c". @param {string[]} items */
function listed(items) {
  return items.length <= 1 ? items.join("") : items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
}

const TEXTS = {
  notRun: "Not run: an earlier call in this reply failed or was declined, so this one was skipped.",
  notRunStopped: "Not run: the user stopped the reply before this call.",
  notRunFull: "Not run yet, only because this reply's results reached the size limit for one step. Call it again \
in your next step, before you answer: nothing is wrong with it.",
  resume: "Please carry on from where you stopped.",
  planLeft: (/** @type {{number: number, goal: string}[]} */ steps) => `The plan still has ${steps.length === 1 ? "a step" : steps.length + " steps"} \
to do: ${steps.map((step) => `${step.number}. ${step.goal}`).join("; ")}. Please carry on with ${steps.length === 1 ? "it" : "them"}. If you \
stopped on purpose (it's done another way, or you need something from me), say so instead.`,
  planLeftShown: (/** @type {number} */ count) => `Carry on (the plan had ${count} step${count === 1 ? "" : "s"} left)`,
  resumeStopped: "Please carry on from where you stopped. I stopped it, but I didn't mean to cancel anything: run \
again whatever was stopped or not run, then go on.",
  stoppedRunning: "Stopped: the user stopped the reply while this was running, so there's no result.",
  notRunFailed: "Not run: the reply failed (a connection or gateway problem) before this call.",
  notRunLimit: "Not run: the step limit for one message was reached.",
  notRunBatch: (/** @type {number} */ calls, /** @type {number} */ changes) =>
    `Not run: Solder runs up to ${calls} calls from one reply, ${changes} of them changes (plan calls aside). Send it again if you still need it.`,
  repeat: "Not run again: it's the same call as an earlier one in this reply (see that result).",
  declined: "The user declined this.",
  userNote: (/** @type {string} */ note) => `The user's note: ${note}`,
  unknownTool: (/** @type {string} */ name, /** @type {string[]} */ offered) =>
    `There's no tool called ${name}. The tools are: ${offered.join(", ")}.`,
  badArguments: "The call's arguments weren't valid JSON, so it wasn't run.",
  missing: (/** @type {string} */ name, /** @type {string[]} */ args, /** @type {string[]} */ ignored = []) =>
    `${name} needs ${listed(args)}; it wasn't run.` + (ignored.length ? ` It doesn't take ${listed(ignored)}.` : ""),
  ignored: (/** @type {string} */ name, /** @type {string[]} */ args) =>
    `(${name} doesn't take ${listed(args)}, so ${args.length === 1 ? "it was" : "they were"} left out.)`,
  wrongType: (/** @type {string} */ name, /** @type {string} */ arg, /** @type {string} */ type) =>
    `${name}'s ${arg} must be ${type === "integer" ? "a whole number" : type === "boolean" ? "true or false" : type === "array" ? "a list" : "text"}; it wasn't run.`,
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
/** The plan tool's answers. */
const PLAN = {
  /** @param {{goal: string, work: string, state: string, notes: string}[]} steps */
  now: (steps) => {
    const at = steps.findIndex((step) => step.state === "doing");
    const done = steps.filter((step) => step.state === "done").length;
    const head = at >= 0 ? `Plan: step ${at + 1} of ${steps.length} now (${done} done).` : `Plan: all ${steps.length} steps done.`;
    return [head, ...steps.map((step, index) => `${index + 1}. [${step.state === "done" ? "done" : step.state === "doing" ? "now" : "to do"}] ${step.goal}` +
      (step.state === "done" && step.notes ? `\n   Notes: ${step.notes}` : "") + (step.state === "doing" && step.work ? `\n   Work: ${step.work}` : ""))].join("\n");
  },
  none: "There's no plan yet: call plan with steps first.",
  badStep: (/** @type {number} */ count) => `done needs a step number from 1 to ${count}.`,
  /** An older plan result, all of it in the newest one. */
  superseded: "(An earlier state of the plan, left out: the newest plan result, further on, holds all of it.)",
  /** A finished step's result, left out. */
  stub: (/** @type {number} */ step, /** @type {string} */ summary) =>
    `(Step ${step} is done; this result (${summary}) is left out to save space. The step's notes in the plan say what came of it.)`,
};

const RESULTS = {
  networkPath: "Network paths (\\\\server\\share) aren't opened, outside the workspace: use a path on this PC.",
  error: (/** @type {string} */ message) => `Error: ${message}`,
  noPath: "No path was given.",
  noTool: (/** @type {string} */ name) => `There's no tool called ${name}.`,
  noWorkspace: "No workspace folder is open.",
  missing: (/** @type {string} */ file) => `${file} doesn't exist.`,
  isFolder: (/** @type {string} */ file) => `${file} is a folder.`,
  readFolder: (/** @type {string} */ file) => `${file} is a folder, not a file.`,
  tooLarge: (/** @type {string} */ file, /** @type {number} */ mb) => `${file} is too large to read (${mb} MB).`,
  notText: (/** @type {string} */ file) => `${file} couldn't be opened as text (it may be a binary file).`,
  signatureLeftOut: (/** @type {number} */ first, /** @type {number} */ last) =>
    `…(lines ${first}–${last}: the file's digital signature, left out to save space)`,
  signatureInDiff: (/** @type {number} */ lines) => `…(${lines} lines of a digital signature, left out)`,
  signatureBroken: "This file was digitally signed, so this change makes its signature invalid: tell the user to sign it again.",
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
  notChecked: (/** @type {string} */ file) => `VS Code hasn't checked ${file}: it couldn't be opened in an editor, where its language support checks files. Its problems are unknown, not necessarily none. Tell the user it wasn't checked, so they can open it to have it checked.`,
  notReported: (/** @type {string} */ file) => `Nothing was reported for ${file}, even opened in an editor, and nothing in VS Code has reported problems in this kind of file yet: it may have no language support that checks it. Its problems are unknown, not necessarily none. Tell the user it may not have been checked.`,
  pastEnd: (/** @type {string} */ file, /** @type {number} */ lines) => `${file} has only ${lines.toLocaleString("en-US")} line${lines === 1 ? "" : "s"}.`,
  sameText: "old_text and new_text are the same, so there's nothing to change.",
  changedOnDisk: (/** @type {string} */ file) => `${file} changed on disk a moment ago and VS Code hasn't caught up yet, so nothing \
was changed. Read it again, then make the change.`,
  notSaved: (/** @type {string} */ file) => `VS Code couldn't save ${file} (it may be read-only, or have changed on disk), so the \
change was undone in the editor too. Read it again before trying anything else.`,
  notWritable: (/** @type {string} */ file) => `${file} couldn't be written: it may be read-only, or locked by another program.`,
  sameContent: (/** @type {string} */ file) => `${file} already has exactly that content, so nothing changed.`,
  notInFile: (/** @type {string} */ name, /** @type {string} */ file) =>
    `${name} doesn't appear in ${file} as a whole word, so the whole workspace was looked in instead:`,
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
  longLine: (/** @type {number} */ line, /** @type {number} */ chars, /** @type {boolean} */ readable) => readable
    ? `(line ${line} is ${chars.toLocaleString("en-US")} characters long, so only its start is shown. To see it whole, read just that \
line (start_line and end_line ${line}). If it's minified or generated code, search for the names you need instead: that shows the \
text around each match.)`
    : `(line ${line} is ${chars.toLocaleString("en-US")} characters long, more than one read can show, probably minified or generated \
code, so only its start is shown. Search for the names you need instead: that shows the text around each match in a long line.)`,
  outsideNotShown: "(outside the workspace and your docs folders, so not shown: read_file it to see it, which asks the user first)",
  alsoDefined: (/** @type {string} */ name, /** @type {string[]} */ places) =>
    `(${name} is also defined in ${places.join(", ")}: these are the uses of the first. Give path and line for another's.)`,
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
  notFound: (/** @type {string} */ file, /** @type {number} */ from, /** @type {number} */ to, /** @type {number} */ matched, /** @type {number} */ of) =>
    `old_text wasn't found in ${file}.` + (from > 0
    ? ` The closest place is around lines ${from}-${to} (${matched} of its ${of} line${of === 1 ? "" : "s"} match there). Those lines as they are now, to copy old_text from exactly:`
    : " Read the file again and copy the text exactly."),
  numbersLeftOut: "old_text had read_file's line numbers in it; they were left out to match it.",
  numberedNewText: "old_text has read_file's line numbers in it, and new_text has them on some lines only. Send both without the numbers.",
  nearby: (/** @type {string[]} */ paths, /** @type {boolean} */ sameName) =>
    `${sameName ? "Files with that name" : "Files with that name and another extension"}: ${paths.join(", ")}.`,
  folderHas: (/** @type {string[]} */ names, /** @type {number} */ total) =>
    `It holds: ${names.join(", ")}` + (total > names.length ? `, and ${(total - names.length).toLocaleString("en-US")} more.` : "."),
  folderEmpty: "It's empty.",
  searchTimedOut: (/** @type {number} */ seconds) => `The search stopped after ${seconds} seconds with nothing found yet, so this \
isn't an answer either way: narrow it with a glob or a more specific query.`,
  searchIncomplete: (/** @type {number} */ seconds) => `(The search stopped after ${seconds} seconds, so there may be more \
matches than these: narrow it with a glob to be sure.)`,
  reindented: (/** @type {string} */ amount, /** @type {boolean} */ less) => `old_text was indented ${amount} ${less ? "less" : "more"} than the file there, so it was matched with that difference and new_text was shifted the same way.`,
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

// ================================================================ the Assist lane
/*
 * Assist models take no system message and no tools: everything they need goes inside the user's own messages, in
 * plain first person, about the user's own program ("I'm using Solder, a small VS Code extension of mine…"). Newer
 * models refuse pseudo-system wrappers ("[SYSTEM]", "You are…" role-play); this style hasn't been refused. These texts
 * are the Assist lane's alone: the Tool lane's RULES and systemPrompt aren't built from them, nor they from those,
 * and each lane is pinned by its own test, so work on one can't change the other.
 */
const ASSIST_LEAD = "I'm using Solder, a small VS Code extension of mine, to talk with you. It works in my workspace \
and can do a few things there that you can't do directly:";

const ASSIST_HOW = `When one of these would help, end your reply with a code block tagged tool that holds one JSON \
request, like this:

\`\`\`tool
{"tool": "read_file", "path": "src/app.js"}
\`\`\`

My extension runs it and sends you the result in my next message, and you can keep going like that for as many \
steps as you need. When you say you'll do something, end that same reply with the request for it: I can't see a \
step you only describe. You can put up to eight requests in one reply, each in its own tool block, when you already know \
everything each one needs; at most five of them can change files. My extension runs them in order and stops at the \
first one that fails or that I decline, so a later request can rely on the earlier ones having worked; a read that \
fails doesn't stop the reads after it. Every result stays in our conversation, so keep outputs small: search before \
reading, and for a big file you haven't seen, get its outline with symbols and read only the lines you need. To find \
where a function, class or method is defined or used, use symbols rather than search. Read only what the task needs, \
and never guess what a file says: read it. Make the smallest change that does the job, in the style of the code \
around it. Edits are saved right away (I can undo them), and you'll see any new problems they cause: fix what you \
broke before moving on. For a task of two or more steps, call plan first, then do one step at a time. My extension \
can't run commands: when something needs building, testing or running, tell me what to run and I will. I only see \
what my extension sends back, so wait for a result before describing what a file says. If a change could lose my \
work, or what I'm asking is unclear and reading the code can't settle it, ask me first: one to three short \
questions, each with the choice you'd recommend. When you're done, tell me \
what you changed or found in a few sentences, with file paths, and don't paste back files you edited. If you don't \
need anything from my workspace, just answer normally.`;

/** The lead before the user's own words. Kept identical always: it's how a saved message is split back up. */
const MESSAGE_LEAD = "Here's my message:";

/**
 * The Assist setup: the tools, how to ask for them, the workspace and what to follow. The tool lines come from TOOLS,
 * so a tool change lands in both lanes.
 * @param {{workspace: string, folders?: string[], os?: string, instructions?: {path: string, text: string}[], rules?: string,
 *          docs?: {path: string, about?: string}[]}} context
 */
function assistSetup({ workspace, folders = [], os = "Windows", instructions = [], rules = "", docs = [] }) {
  const lines = Object.entries(TOOLS).map(([name, [description, properties, required]]) => {
    const args = Object.keys(properties).map((arg) => /** @type {string[]} */ (required).includes(arg) ? arg : `${arg} (optional)`);
    return `- ${name}: ${assistText(description)}` + (args.length ? ` Arguments: ${args.join(", ")}` : "");
  });
  const where = folders.length > 1
    ? `My workspace folders are ${folders[0]} (the main one) and ${folders.slice(1).join(", ")}. Relative paths are \
relative to the working folder when my message names one, otherwise to the main folder; use full paths for the others.`
    : `My workspace folder is ${workspace || "(none open)"}. Relative paths are relative to the working folder when my \
message names one, otherwise to this folder.`;
  const parts = [ASSIST_LEAD + "\n\n" + lines.join("\n"), ASSIST_HOW, `${where} I'm on ${os}. Each of my messages starts with my local date and time.`];
  for (const file of instructions) parts.push(`My project's instructions (${file.path}), which you should follow; what \
I ask in a message wins if they conflict:\n\n${file.text.trim()}`);
  if (docs.length) parts.push("I keep reference documentation in these folders. When a task needs something my \
workspace doesn't have, search them with search and docs set to true, then read the passage you need with read_file:\n"
    + docs.map((d) => `- ${d.path}${d.about ? `: ${d.about}` : ""}`).join("\n"));
  if (String(rules || "").trim()) parts.push("A few rules of mine, for everything in this conversation:\n\n" + String(rules).trim());
  return parts.join("\n\n");
}

/** Texts that say "the user", in the Assist lane's first person (the user is the one speaking there). */
const ASSIST_SWAPS = [
  [TEXTS.notRun, "My extension didn't run this one: an earlier request in the same reply failed or I declined it."],
  [TEXTS.notRunStopped, "I stopped the reply before this one, so my extension didn't run it."],
  [TEXTS.stoppedRunning, "I stopped the reply while this was running, so there's no result."],
  [TEXTS.declined, "I declined this."],
  [TEXTS.emptyReply, "\n\n(Your reply to this came back empty, so here it is again. Please carry on: send your next tool \
request, or give me your answer.)"],
  ["The user's note: ", "My note: "],
  ["Also, a message from the user while you were working:", "Also, a message from me while you were working:"],
  ["tell the user to sign it again", "remind me to sign it again"],
  ["Tell the user it wasn't checked, so they can open it to have it checked.", "Tell me it wasn't checked, so I can open it to have it checked."],
  ["Tell the user it may not have been checked.", "Tell me it may not have been checked."],
  ["The user can add them", "I can add them"],
  ["which asks the user first", "which asks me first"],
  ["Ask the user to save it first.", "Ask me to save it first."],
  ["Never overwrites; the user can undo it.", "Never overwrites; I can undo it."],
  ["The user is asked first, and can undo it.", "I'm asked first, and can undo it."],
  ["The user sees each step's goal as a checklist.", "I see each step's goal as a checklist."],
];

const ASSIST = {
  lead: ASSIST_LEAD,
  messageLead: MESSAGE_LEAD,
  setup: assistSetup,
  /** The whole first message: the setup, the lead, then the user's own words. @param {any} context @param {string} message */
  introduce: (context, message) => assistSetup(context) + "\n\n" + MESSAGE_LEAD + "\n\n" + message,
  /** A setup that changed since the model was told: said in front of the new message. */
  setupChanged: (/** @type {string} */ setup) => `(My setup has changed since I first told you about it. Here's how it is \
now; please go by this from now on:\n\n${setup})`,
  setupChangedLead: "(My setup has changed since I first told you about it.",
  resultOk: (/** @type {string} */ label) => `Here's what my extension returned for ${label}:`,
  resultFailed: (/** @type {string} */ label) => `My extension tried ${label}, but it didn't work:`,
  resultClosing: "Send another tool request if you need more, otherwise go ahead and answer.",
  carryOverLead: "Here's our conversation so far, as my extension saved it, so you can pick up where we left off. \
\"Me\" is me, including the results my extension sent you, and \"You\" is you.",
  carryOverLeftOut: (/** @type {number} */ count) => `(${count} earlier message${count === 1 ? " is" : "s are"} left out here.)`,
  carryOverEnd: "That's the conversation so far. My new message:",
  /** A request that couldn't be read, asked for again. */
  repair: (/** @type {string} */ problem) => `My extension couldn't read that request (${problem}). Could you send it again \
as a single \`\`\`tool block holding valid JSON?`,
  /** A request for a tool there isn't. */
  unknownTool: (/** @type {string} */ name, /** @type {string[]} */ tools) => `My extension couldn't run that request: there's \
no tool called '${name}'. The tools you can use here are ${tools.join(", ")}. Send it again with one of those, or answer \
without a tool if none of them fits.`,
  /** A request cut off at the length limit. */
  cutOff: "My extension couldn't use that request: your reply was cut off at the length limit before it ended, so the \
content was incomplete. Could you send it in smaller parts? For a big file, write_file with the first part, then \
edit_file to add each of the rest.",
  /** Shown to the user (not the model) after asking twice. */
  gaveUp: "Solder couldn't read the tool request in this reply, even after asking again, so nothing was run.",
  /** The Tool lane's texts that say "the user", with their first-person versions. */
  swaps: ASSIST_SWAPS,
};

/** A shared text as the Assist lane says it: "the user" becomes "I" (or "me"); anything else is unchanged. @param {string} text */
function assistText(text) {
  let out = String(text);
  for (const [from, to] of ASSIST_SWAPS) if (out.includes(from)) out = out.split(from).join(to);
  return out;
}

module.exports = { RULES, TOOLS, READ_ONLY, TEXTS, RESULTS, PLAN, STARTERS, SELECTION, CONTEXT, systemPrompt, toolDefinitions, timeNote, ASSIST, assistText };
