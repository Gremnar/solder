// @ts-check
"use strict";
/**
 * Paste in terminal's check before several lines go into PowerShell as one command, `. { … }` (no `vscode`, tested
 * under node). The wrapper keeps every line waiting for Enter only while the code's own braces balance: a stray `}`
 * would close the wrapper early, and PowerShell would run what follows line by line as it arrives. So the code is
 * wrapped only when this says its braces balance; anything it can't be sure of is pasted the old way, after asking.
 */

/**
 * Whether PowerShell code's braces balance, outside its strings and comments: never more closed than opened, all
 * closed at the end, and no string, here-string or comment left open. Conservative: a double-quoted string holding a
 * subexpression (`$(…)`, which can hold quotes of its own) counts as unsure, and unsure is false.
 * @param {string} code
 */
function bracesBalance(code) {
  let depth = 0;
  let i = 0;
  const n = code.length;
  const lineStart = (at) => at === 0 || code[at - 1] === "\n";
  while (i < n) {
    const ch = code[i];
    if (ch === "`") { i += 2; continue; } // an escaped character, whatever it is
    if (ch === "@" && (code[i + 1] === "'" || code[i + 1] === '"') && /^[ \t]*\r?\n/.test(code.slice(i + 2))) {
      // A here-string: it ends at a line that starts with its closing quote and @.
      const close = new RegExp(`\\n${code[i + 1]}@`, "g");
      close.lastIndex = i + 2;
      const end = close.exec(code);
      if (!end) return false;
      i = end.index + 3;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= n) return false;
        if (code[j] === "'") { if (code[j + 1] === "'") { j += 2; continue; } break; }
        j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= n) return false;
        if (code[j] === "`") { j += 2; continue; }
        if (code[j] === "$" && code[j + 1] === "(") return false; // a subexpression: unsure
        if (code[j] === '"') { if (code[j + 1] === '"') { j += 2; continue; } break; }
        j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === "<" && code[i + 1] === "#") {
      const end = code.indexOf("#>", i + 2);
      if (end < 0) return false;
      i = end + 2;
      continue;
    }
    // A comment starts a word: `a#b` is one word, not a comment. Only a comment's own braces are skipped.
    if (ch === "#" && (lineStart(i) || /[\s;({]/.test(code[i - 1]))) {
      const end = code.indexOf("\n", i);
      i = end < 0 ? n : end;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth < 0) return false;
    i++;
  }
  return depth === 0;
}

module.exports = { bracesBalance };
