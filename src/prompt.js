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
- Look with read_file, search and find_files; change files with edit_file and write_file; check your work \
with problems (VS Code's errors and warnings). remove_item deletes a file or folder, and asks the user first.
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
- Every result is sent again with each later step, so keep outputs small: search before reading, and read \
ranges of big files.
- If a change could lose the user's work, or the request is unclear, ask first.

# How to answer
- The user reads your reply as it is: don't put your reasoning, drafts or second thoughts in it.
- Before a tool call, write one short sentence at most, or nothing.
- When the task is done, say what you changed or found in a few sentences, with file paths. Use Markdown. \
Don't paste back files you edited.`;

/**
 * The system message.
 * @param {{workspace: string, os?: string, instructions?: {path: string, text: string}[], rules?: string}} context
 */
function systemPrompt({ workspace, os = "Windows", instructions = [], rules = "" }) {
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
  if (rules.trim()) text += "\n\n# The user's rules\n" + rules.trim();
  return text;
}

const RELATIVE = "a path relative to the workspace folder, or a full path";

/** name → [description, {argument: schema}, required[]] */
const TOOLS = {
  read_file: ["Returns a text file with line numbers (unsaved changes in the editor included). Up to 2,000 \
lines at a time: for a longer file, ask for a range.", {
    path: { type: "string", description: `The file: ${RELATIVE}.` },
    start_line: { type: "integer", description: "The first line to return (lines are numbered from 1)." },
    end_line: { type: "integer", description: "The last line to return." },
  }, ["path"]],
  search: ["Searches file contents in the workspace (respecting .gitignore) and returns matching lines as \
path:line: text, up to 200.", {
    query: { type: "string", description: "The text to find." },
    regex: { type: "boolean", description: "True to read query as a regular expression." },
    glob: { type: "string", description: "Only search files matching this, such as src/**/*.ts or *.py." },
  }, ["query"]],
  find_files: ["Lists workspace files whose paths match a glob (respecting .gitignore and files.exclude), \
up to 300.", {
    glob: { type: "string", description: "A glob such as **/*.json, src/**/test_*.py or **/README*." },
  }, ["glob"]],
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
  remove_item: ["Deletes a file or a folder (with everything in it). The user is asked first, and can undo it.", {
    path: { type: "string", description: `The file or folder: ${RELATIVE}.` },
  }, ["path"]],
  problems: ["Returns the errors and warnings VS Code currently shows (from its language servers and \
linters), for one file or the whole workspace.", {
    path: { type: "string", description: `Just this file: ${RELATIVE}.` },
  }, []],
};

/** Tools that only look: more of them fit in one reply, and one failing doesn't stop the rest. */
const READ_ONLY = new Set(["read_file", "search", "find_files", "problems"]);

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
  compactionSystem: "You write concise, complete summaries of coding conversations.",
};

/** The tools' results and errors (src/tools.js). An error reaches the model as "Error: " + the text. */
const RESULTS = {
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
  noProblems: (/** @type {string} */ file) => "No errors or warnings" + (file ? ` in ${file}.` : "."),
  moreProblems: (/** @type {number} */ more) => `(${more} more)`,
  removeRoot: "That's the workspace folder (or a drive) itself; Solder won't remove it.",
  removeNoTrash: (/** @type {string} */ file) =>
    `${file} couldn't be moved to the Recycle Bin, and it's too big to keep a copy of, so it wasn't removed.`,
  removed: (/** @type {string} */ file, /** @type {number | null} */ files) =>
    `Removed ${file}` + (files === null ? "" : ` (a folder with ${files.toLocaleString("en-US")} file${files === 1 ? "" : "s"})`) + ".",
};

/** "(Wednesday, 4 November 2026, 14:05)": what each user message starts with. @param {Date} [now] */
function timeNote(now = new Date()) {
  const day = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const time = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `(${day}, ${time})`;
}

module.exports = { RULES, TOOLS, READ_ONLY, TEXTS, RESULTS, systemPrompt, toolDefinitions, timeNote };
