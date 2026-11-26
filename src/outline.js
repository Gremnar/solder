// @ts-check
"use strict";
/**
 * Solder's own outline of a file, made from its text, for the kinds VS Code often has no language support for:
 * PowerShell, Structured Text and SCL (TwinCAT's XML files too), XML exports, batch files, Python and SQL (no
 * `vscode`, tested under node). Conservative: only lines it is sure define something, and an end line only where it
 * can tell (braces that balance, an END_ keyword, a closing tag, a dedent). Lines are numbered from 1.
 */

/** @typedef {{kind: string, name: string, start: number, end?: number, depth?: number, at?: number}} Entry */

/** How deep the outline goes: three levels, as VS Code's outline does in Solder. */
const MAX_DEPTH = 2;
/** Enough for any outline Solder shows (it shows 400 at most). */
const MAX_ENTRIES = 5000;

/** The kind of text a file holds, by its name, or "" when Solder has no outline of its own for it. @param {string} file */
function textKind(file) {
  const ext = (/\.([^.\\/]+)$/.exec(file)?.[1] ?? "").toLowerCase();
  if (["ps1", "psm1", "psd1"].includes(ext)) return "powershell";
  if (["st", "scl", "iecst", "udt"].includes(ext)) return "st";
  if (["tcpou", "tcdut", "tcgvl", "tcio", "tcitf"].includes(ext)) return "twincat";
  if (["xml", "l5x", "aml"].includes(ext)) return "xml";
  if (["bat", "cmd"].includes(ext)) return "batch";
  if (["py", "pyw"].includes(ext)) return "python";
  if (ext === "sql") return "sql";
  return "";
}

/**
 * The outline of a file's text, in file order with each entry's depth, or null when Solder has none for its kind.
 * @param {string} text @param {string} file its name or path (the extension says the kind) @returns {Entry[] | null}
 */
function textOutline(text, file) {
  const kind = textKind(file);
  if (!kind) return null;
  const lines = text.split(/\r\n|\r|\n/);
  /** @type {Entry[]} */
  let entries;
  if (kind === "powershell") entries = powershell(text, lines);
  else if (kind === "st") entries = structuredText(lines, false).entries;
  else if (kind === "twincat") entries = twincat(text, lines);
  else if (kind === "xml") entries = xml(text, lines);
  else if (kind === "batch") entries = batch(lines);
  else if (kind === "python") entries = python(lines);
  else entries = sql(lines);
  return nest(entries.slice(0, MAX_ENTRIES));
}

/** Outline lines as Solder's outline shows them: "  function Get-Thing 20–45" (no end: the first line only). @param {Entry[]} entries */
function outlineLines(entries) {
  return entries.filter((e) => (e.depth ?? 0) <= MAX_DEPTH).map((e) =>
    `${"  ".repeat(e.depth ?? 0)}${e.kind}${e.name ? " " + e.name : ""} ${e.end && e.end > e.start ? `${e.start}–${e.end}` : e.start}`);
}

/** Kinds that are places in a file rather than definitions of a name. */
const NOT_DEFINITIONS = /^(region|var\b|var_)/i;

/**
 * The entries that define `name` (as the language compares names: Python by case, the rest not; a quoted, bracketed,
 * scoped or schema-qualified name matches by its plain name), each with the last line of its body: its end, or the
 * line before the next entry that isn't inside it. @param {Entry[]} entries @param {string} name @param {string} file
 * @param {number} lineCount @returns {{entry: Entry, last: number}[]}
 */
function definedIn(entries, name, file, lineCount) {
  const exact = textKind(file) === "python";
  const plain = (/** @type {string} */ n) => {
    const bare = n.replace(/^["'`[]+|["'`\]]+$/g, "").replace(/\]?\.\[?/g, ".");
    const short = bare.replace(/^(?:global|script|local|private):/i, "");
    return exact ? short : short.toLowerCase();
  };
  const want = plain(name);
  const out = [];
  for (let k = 0; k < entries.length; k++) {
    const entry = entries[k];
    if (!entry.name || NOT_DEFINITIONS.test(entry.kind)) continue;
    const have = plain(entry.name);
    if (have !== want && !have.endsWith("." + want)) continue;
    let last = entry.end ?? 0;
    if (!last) {
      const next = entries.slice(k + 1).find((e) => e.start > entry.start && (e.depth ?? 0) <= (entry.depth ?? 0));
      last = next ? Math.max(entry.start, next.start - 1) : lineCount;
    }
    out.push({ entry, last });
  }
  return out;
}

/** Entries sorted by their first line, each given its depth: how many entries with an end hold it. @param {Entry[]} entries */
function nest(entries) {
  const sorted = entries.filter((e) => e.start > 0)
    .sort((a, b) => a.start - b.start || (b.end ?? b.start) - (a.end ?? a.start) || (a.at ?? 0) - (b.at ?? 0));
  /** @type {Entry[]} */
  const open = [];
  for (const entry of sorted) {
    while (open.length && /** @type {number} */ (open[open.length - 1].end) < entry.start) open.pop();
    entry.depth = open.length;
    if (entry.end && entry.end > entry.start) open.push(entry);
    delete entry.at;
  }
  return sorted;
}

/** The line (from 1) each character offset is on. @param {string} text */
function lineFinder(text) {
  /** @type {number[]} */
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n" || (text[i] === "\r" && text[i + 1] !== "\n")) starts.push(i + 1);
  }
  return {
    starts,
    /** @param {number} at */
    lineOf(at) {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= at) lo = mid; else hi = mid - 1;
      }
      return lo + 1;
    },
  };
}

// ------------------------------------------------------------------ PowerShell --

/**
 * PowerShell's strings, comments and braces: the pairs of braces in its code, the stretches that aren't code, and
 * whether it all closed (no string, here-string or comment left open, and every brace matched). A double-quoted string's
 * $( ) is code, its braces counted too. @param {string} text
 */
function scanPowerShell(text) {
  const n = text.length;
  /** @type {{open: number, close: number}[]} */
  const pairs = [];
  /** @type {[number, number][]} stretches that are strings or comments */
  const skips = [];
  /** @type {number[]} */
  const opens = [];
  let ok = true;
  const herePlain = /[ \t]*\r?\n/y;
  /** Code from i; inside a $( ) when `sub`, ending after its ). The index after it, or -1 when something didn't close. */
  const code = (/** @type {number} */ i, /** @type {boolean} */ sub, /** @type {number} */ level) => {
    if (level > 40) return -1;
    const depth = opens.length;
    let parens = 0;
    while (i < n) {
      const ch = text[i];
      if (ch === "`") { i += 2; continue; } // an escaped character, whatever it is
      if (sub && ch === "(") { parens++; i++; continue; }
      if (sub && ch === ")") {
        if (parens) { parens--; i++; continue; }
        return opens.length === depth ? i + 1 : -1;
      }
      if (ch === "@" && (text[i + 1] === "'" || text[i + 1] === '"')) {
        herePlain.lastIndex = i + 2;
        if (herePlain.test(text)) {
          // A here-string: it ends at a line that starts with its closing quote and @.
          const close = text.indexOf("\n" + text[i + 1] + "@", i + 2);
          if (close < 0) return -1;
          skips.push([i, close + 3]);
          i = close + 3;
          continue;
        }
      }
      if (ch === "'") {
        let j = i + 1;
        for (;;) {
          if (j >= n) return -1;
          if (text[j] === "'") { if (text[j + 1] === "'") { j += 2; continue; } break; }
          j++;
        }
        skips.push([i, j + 1]);
        i = j + 1;
        continue;
      }
      if (ch === '"') {
        let j = i + 1;
        let from = i;
        for (;;) {
          if (j >= n) return -1;
          if (text[j] === "`") { j += 2; continue; }
          if (text[j] === "$" && text[j + 1] === "(") {
            skips.push([from, j]);
            const after = code(j + 2, true, level + 1);
            if (after < 0) return -1;
            j = from = after;
            continue;
          }
          if (text[j] === '"') { if (text[j + 1] === '"') { j += 2; continue; } break; }
          j++;
        }
        skips.push([from, j + 1]);
        i = j + 1;
        continue;
      }
      if (ch === "<" && text[i + 1] === "#") {
        const end = text.indexOf("#>", i + 2);
        if (end < 0) return -1;
        skips.push([i, end + 2]);
        i = end + 2;
        continue;
      }
      // A comment starts a word: `a#b` is one word, not a comment.
      if (ch === "#" && (i === 0 || /[\s;(){}|,=]/.test(text[i - 1]))) {
        let end = i;
        while (end < n && text[end] !== "\n" && text[end] !== "\r") end++;
        skips.push([i, end]);
        i = end;
        continue;
      }
      if (ch === "$" && text[i + 1] === "{") {
        // ${env:Path}, ${a b}: a variable's name in braces.
        const end = text.indexOf("}", i + 2);
        if (end < 0) return -1;
        i = end + 1;
        continue;
      }
      if (ch === "{") opens.push(i);
      else if (ch === "}") {
        const open = opens.pop();
        if (open === undefined) return -1;
        pairs.push({ open, close: i });
      }
      i++;
    }
    return sub ? -1 : i;
  };
  const end = code(0, false, 0);
  if (end < 0 || opens.length) ok = false;
  return { pairs: pairs.sort((a, b) => a.open - b.open), skips, ok };
}

/** @param {string} text @param {string[]} lines @returns {Entry[]} */
function powershell(text, lines) {
  const { pairs, skips, ok } = scanPowerShell(text);
  const { starts, lineOf } = lineFinder(text);
  // Lines that start inside a string or comment: never a definition, whatever they say.
  const inside = new Set();
  for (const [from, to] of skips) {
    for (let line = lineOf(from) + 1; line <= lines.length && starts[line - 1] < to; line++) {
      if (starts[line - 1] > from) inside.add(line);
    }
  }
  /** The braces that open after `from` with only `between` before them, within a few lines; null when not sure. */
  const bodyAfter = (/** @type {number} */ from, /** @type {RegExp} */ between) => {
    if (!ok) return null;
    const pair = pairs.find((p) => p.open >= from);
    if (!pair || lineOf(pair.open) - lineOf(from) > 30) return null;
    return between.test(text.slice(from, pair.open)) ? pair : null;
  };
  /** @type {Entry[]} */
  const out = [];
  /** @type {Entry[]} */
  const regions = [];
  /** @type {{entry: Entry, pair: {open: number, close: number}}[]} */
  const classes = [];
  const DEF = /^(\s*)(function|filter|workflow|configuration|class|enum)\s+([\w.:-]+)/i;
  lines.forEach((line, k) => {
    const number = k + 1;
    if (inside.has(number)) return;
    const region = /^\s*#region\b[ \t]*(.*)$/i.exec(line);
    if (region) {
      const entry = { kind: "region", name: region[1].trim().slice(0, 100), start: number };
      regions.push(entry);
      out.push(entry);
      return;
    }
    if (/^\s*#endregion\b/i.test(line)) {
      const entry = regions.pop();
      if (entry) /** @type {Entry} */ (entry).end = number;
      return;
    }
    const def = DEF.exec(line);
    if (!def) return;
    const kind = def[2].toLowerCase();
    /** @type {Entry} */
    const entry = { kind, name: def[3], start: number };
    const after = starts[k] + def[0].length;
    const pair = bodyAfter(after, kind === "class" ? /^[\s\w.:,[\]]*$/ : kind === "enum" ? /^\s*$/ : /^\s*(\([\s\S]*\))?\s*$/);
    if (pair) {
      entry.end = lineOf(pair.close);
      if (kind === "class") classes.push({ entry, pair });
    }
    out.push(entry);
  });
  // A class's methods and constructors: definitions whose body is one of the class body's own braces.
  const METHOD = /^\s*(?:(?:static|hidden)\s+)*(?:\[[^\]\r\n]*\]\s*)*([A-Za-z_]\w*)\s*(?=\()/i;
  const KEYWORDS = /^(if|elseif|foreach|for|while|switch|until|catch|trap|param|return|throw)$/i;
  for (const { pair } of classes) {
    const inner = pairs.filter((p) => p.open > pair.open && p.close < pair.close);
    const direct = inner.filter((p) => !inner.some((q) => q !== p && q.open < p.open && q.close > p.close));
    for (let line = lineOf(pair.open) + 1; line < lineOf(pair.close); line++) {
      if (inside.has(line)) continue;
      const method = METHOD.exec(lines[line - 1]);
      if (!method || KEYWORDS.test(method[1])) continue;
      const body = bodyAfter(starts[line - 1] + method[0].length, /^\s*\([\s\S]*\)\s*(?::\s*base\s*\([\s\S]*\))?\s*$/i);
      if (!body || !direct.includes(body)) continue;
      out.push({ kind: "method", name: method[1], start: line, end: lineOf(body.close) });
    }
  }
  return out;
}

// --------------------------------------------------------- Structured Text / SCL --

/** Blocks Structured Text opens with a keyword at a line's start, closed by END_<keyword>; true: a name follows. */
const ST_BLOCKS = /** @type {Record<string, boolean>} */ ({
  PROGRAM: true, FUNCTION_BLOCK: true, FUNCTION: true, METHOD: true, PROPERTY: true, ACTION: true, INTERFACE: true,
  TYPE: false, STRUCT: false, UNION: false, ORGANIZATION_BLOCK: true, DATA_BLOCK: true, CONFIGURATION: true,
  RESOURCE: true, NAMESPACE: true, REGION: false,
});
const ST_MODIFIERS = /^(PUBLIC|PRIVATE|PROTECTED|INTERNAL|ABSTRACT|FINAL)$/i;

/**
 * Structured Text's blocks and VAR sections, with their END_ lines. In TwinCAT's XML (`cdata`), only the text inside
 * CDATA is ST, and what a CDATA leaves open stays without an end. @param {string[]} lines @param {boolean} cdata
 */
function structuredText(lines, cdata) {
  /** @type {Entry[]} */
  const out = [];
  /** @type {{family: string, entry: Entry | null}[]} open blocks (null: one that isn't listed, as `x : STRUCT`) */
  let stack = [];
  let comment = ""; // "(*" or "/*" while inside one
  let inData = !cdata;
  lines.forEach((line, k) => {
    // The ST on this line from its start, when the line starts in ST code (not in a comment, and in a CDATA).
    let head = null;
    let i = 0;
    if (!inData) {
      const open = line.indexOf("<![CDATA[");
      if (open < 0) return;
      inData = true;
      i = open + 9;
      head = line.slice(i);
    } else if (!comment) head = line;
    if (head !== null) {
      const at = k + 1;
      const word = /^\s*(?:\{[^}\n]*\}\s*)*([A-Za-z_]\w*)\b(.*)$/.exec(head);
      const key = word ? word[1].toUpperCase() : "";
      if (key.startsWith("END_")) {
        const family = key === "END_VAR" ? "VAR" : key.slice(4);
        const found = stack.map((s) => s.family).lastIndexOf(family);
        if (found >= 0) {
          const entry = stack[found].entry;
          if (entry) entry.end = at;
          stack = stack.slice(0, found);
        }
      } else if (word && /^VAR(_\w+)?$/.test(key) && /^\s*(?:(?:CONSTANT|RETAIN|PERSISTENT|NON_RETAIN)\b\s*)*(?:\(\*.*|\/\/.*|\/\*.*|\{.*)?$/i.test(word[2])) {
        const extra = /^\s+(CONSTANT|RETAIN|PERSISTENT|NON_RETAIN)\b/i.exec(word[2]);
        const entry = { kind: key.toLowerCase() + (extra ? " " + extra[1].toLowerCase() : ""), name: "", start: at };
        out.push(entry);
        stack.push({ family: "VAR", entry });
      } else if (word && key in ST_BLOCKS) {
        let name = "";
        if (key === "REGION") name = word[2].trim().slice(0, 100);
        else {
          let rest = word[2];
          for (;;) {
            const token = /^\s+("[^"]+"|[A-Za-z_][\w.]*)/.exec(rest);
            if (!token || !ST_MODIFIERS.test(token[1])) { name = token ? token[1] : ""; break; }
            rest = rest.slice(token[0].length);
          }
          if (key === "TYPE" && /^(STRUCT|UNION)$/i.test(name)) name = "";
        }
        if (ST_BLOCKS[key] && !name) { stack.push({ family: key, entry: null }); }
        else {
          const entry = { kind: key.toLowerCase(), name: name.replace(/^"|"$/g, ""), start: at };
          out.push(entry);
          stack.push({ family: key, entry });
        }
      }
      // A STRUCT or UNION opened later on the line (`data : STRUCT`): not listed, but its END_ is its own.
      if (word) {
        const later = word[2].replace(/\(\*.*?\*\)|\/\/.*$|'[^']*'/g, "");
        for (const m of later.matchAll(/\b(STRUCT|UNION)\b/gi)) stack.push({ family: m[1].toUpperCase(), entry: null });
      }
    }
    // Comments and strings through the rest of the line, so the next line's start is known.
    for (; i < line.length; i++) {
      if (cdata && line.startsWith("]]>", i)) {
        inData = false;
        comment = "";
        stack = [];
        const again = line.indexOf("<![CDATA[", i + 3);
        if (again < 0) break;
        inData = true;
        i = again + 8;
        continue;
      }
      if (comment) {
        const close = comment === "(*" ? "*)" : "*/";
        if (line.startsWith(close, i)) { comment = ""; i++; }
        continue;
      }
      const two = line.slice(i, i + 2);
      if (two === "(*" || two === "/*") { comment = two; i++; continue; }
      if (two === "//") break;
      if (line[i] === "'" || line[i] === '"') {
        const quote = line[i];
        let j = i + 1;
        while (j < line.length && line[j] !== quote) j += line[j] === "$" ? 2 : 1;
        i = j;
      }
    }
  });
  return { entries: out };
}

/**
 * TwinCAT's XML files: the ST in their CDATA, a block with no END_ line (a METHOD, the POU itself) ending where the
 * XML element it's declared in ends. @param {string} text @param {string[]} lines
 */
function twincat(text, lines) {
  const { entries } = structuredText(lines, true);
  if (!entries.length) return xml(text, lines);
  const elements = xmlElements(text);
  if (elements) {
    for (const entry of entries) {
      if (entry.end) continue;
      const holders = elements.filter((e) => e.name && e.start <= entry.start && e.end >= entry.start && e.end > e.start);
      const innermost = holders.sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
      if (innermost) entry.end = innermost.end;
    }
  }
  return entries;
}

// ------------------------------------------------------------------------ XML --

/**
 * Every element's tag, its name (a Name attribute, or Siemens' <AttributeList><Name>) and lines, or null when the
 * tags don't nest (not XML Solder can be sure of). @param {string} text
 * @returns {{tag: string, name: string, start: number, end: number, empty: boolean, at: number}[] | null}
 */
function xmlElements(text) {
  const { lineOf } = lineFinder(text);
  const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  /** @type {{tag: string, name: string, start: number, end: number, empty: boolean, at: number}[]} */
  const all = [];
  /** @type {{tag: string, element: any}[]} */
  const stack = [];
  for (const m of text.matchAll(TOKEN)) {
    const at = /** @type {number} */ (m.index);
    if (m[1]) {
      const top = stack.pop();
      if (!top || top.tag !== m[1]) return null;
      top.element.end = lineOf(at);
      continue;
    }
    if (!m[2]) continue;
    const named = /(?:^|\s)name\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(m[3] ?? "");
    const element = { tag: m[2], name: named ? (named[1] ?? named[2] ?? "") : "", start: lineOf(at), end: lineOf(at), empty: !!m[4], at };
    all.push(element);
    if (m[4]) continue;
    // Siemens' exports name a block in a <Name> inside its <AttributeList>.
    if (m[2] === "Name" && stack.length >= 2 && stack[stack.length - 1].tag === "AttributeList") {
      const owner = stack[stack.length - 2].element;
      const close = text.indexOf("<", at + m[0].length);
      const value = close < 0 ? "" : text.slice(at + m[0].length, close).trim();
      if (!owner.name && value && !/[<>]/.test(value)) owner.name = value;
    }
    stack.push({ tag: m[2], element });
  }
  return stack.length ? null : all;
}

/** Elements that carry a name and hold something (a named element on one line, with nothing in it, is a value). @param {string} text @param {string[]} _lines */
function xml(text, _lines) {
  const elements = xmlElements(text);
  if (!elements) return [];
  return elements.filter((e) => e.name && !e.empty)
    .map((e) => ({ kind: e.tag, name: e.name.slice(0, 100), start: e.start, end: e.end, at: e.at }));
}

// ---------------------------------------------------------- batch, Python, SQL --

/** @param {string[]} lines */
function batch(lines) {
  /** @type {Entry[]} */
  const out = [];
  lines.forEach((line, k) => {
    const label = /^\s*:([^\s:+=,;][^\s+=,;]*)/.exec(line);
    if (label) out.push({ kind: "label", name: label[1], start: k + 1 });
  });
  return out;
}

/**
 * def and class, ending at the last line indented under them; none of the ends when a string or bracket is left
 * open at the end of the file. @param {string[]} lines
 */
function python(lines) {
  /** Whether each line starts a statement (outside strings and brackets), and its indentation. */
  const starts = [];
  let quote = ""; // an open triple-quoted string's quotes
  let depth = 0;
  let joined = false; // the line before ended in a backslash
  for (const line of lines) {
    starts.push(!quote && depth === 0 && !joined);
    joined = false;
    for (let i = 0; i < line.length; i++) {
      if (quote) {
        if (line[i] === "\\") { i++; continue; }
        if (line.startsWith(quote, i)) { i += quote.length - 1; quote = ""; }
        continue;
      }
      const ch = line[i];
      if (ch === "#") break;
      if (ch === "'" || ch === '"') {
        const triple = ch.repeat(3);
        if (line.startsWith(triple, i)) { quote = triple; i += 2; continue; }
        let j = i + 1;
        while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
        i = j;
        continue;
      }
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth = Math.max(0, depth - 1);
    }
    if (!quote && /\\$/.test(line)) joined = true;
  }
  const sure = !quote && depth === 0;
  const indent = (/** @type {string} */ line) => /^[ \t]*/.exec(line)?.[0].replace(/\t/g, "        ").length ?? 0;
  /** @type {Entry[]} */
  const out = [];
  lines.forEach((line, k) => {
    if (!starts[k]) return;
    const def = /^([ \t]*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(line);
    if (!def) return;
    /** @type {Entry} */
    const entry = { kind: def[2] === "def" ? "function" : "class", name: def[3], start: k + 1 };
    if (sure) {
      const own = indent(line);
      let last = k;
      for (let j = k + 1; j < lines.length; j++) {
        const text = lines[j];
        if (!text.trim()) continue;
        if (starts[j] && !/^\s*#/.test(text) && indent(text) <= own) break;
        if (!starts[j] || indent(text) > own) last = j;
      }
      entry.end = last + 1;
    }
    out.push(entry);
  });
  return out;
}

/** CREATE (or ALTER) PROCEDURE, FUNCTION, VIEW, TABLE and TRIGGER, outside /* *\/ comments. @param {string[]} lines */
function sql(lines) {
  /** @type {Entry[]} */
  const out = [];
  let comment = false;
  lines.forEach((line, k) => {
    if (!comment) {
      const m = /^\s*(?:CREATE\s+OR\s+(?:ALTER|REPLACE)|CREATE|ALTER)\s+(PROCEDURE|PROC|FUNCTION|VIEW|TABLE|TRIGGER)\s+((?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w#@$]+)(?:\.(?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w#@$]+))*)/i.exec(line);
      if (m) out.push({ kind: m[1].toUpperCase() === "PROC" ? "procedure" : m[1].toLowerCase(), name: m[2], start: k + 1 });
    }
    const code = line.replace(/--.*$/, "");
    for (let i = 0; i < code.length - 1; i++) {
      if (!comment && code.startsWith("/*", i)) { comment = true; i++; } else if (comment && code.startsWith("*/", i)) { comment = false; i++; }
    }
  });
  return out;
}

module.exports = { textKind, textOutline, outlineLines, definedIn, scanPowerShell };
