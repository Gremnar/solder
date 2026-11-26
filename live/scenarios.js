// @ts-check
"use strict";
/**
 * The live scenarios. Each sets up a small workspace, gives a task, and checks the result on disk (not just the
 * answer). `hooks` change things under the model (a file edited after it read it) to test recovery.
 * @typedef {{name: string, about: string, heavy?: boolean, setup: (write: (p: string, t: string) => void) => void, task: string | ((prompt: any) => string),
 *   hooks?: any, maxRounds?: number, resumes?: number, skills?: Record<string, string>, then?: (string | ((prompt: any) => string))[], check: (r: {ws: any, chat: any, answer: string, read: (p: string) => string,
 *   load: (p: string, mocks?: Record<string, any>) => any, skillsFolder: string}) => string}} Scenario
 *   skills: name → file text, put in a skills folder beside the workspace; then: follow-up messages in the same chat
 * check returns "" when it passed, else what was wrong.
 */
const fs = require("node:fs");

/** @type {Scenario[]} */
const SCENARIOS = [];

// ---------------------------------------------------------------- edits and recovery --

SCENARIOS.push({
  name: "typo",
  about: "a one-line fix: done directly, no question",
  setup: (w) => w("src/greet.js", "function greet(name) {\n  return \"Helo, \" + name;\n}\nmodule.exports = { greet };\n"),
  task: "Fix the typo in greet.js.",
  check: ({ read, chat }) => !/"Hello, "/.test(read("src/greet.js")) ? "not fixed"
    : chat.messages.some((/** @type {any} */ m) => m.tool_calls?.some((/** @type {any} */ c) => c.function.name === "plan")) ? "made a plan for a one-line fix" : "",
});

SCENARIOS.push({
  name: "rename",
  about: "rename a function everywhere and document it (two steps)",
  setup: (w) => {
    w("src/cart.js", "function totalPrice(items) {\n  return items.reduce((sum, i) => sum + i.price * i.qty, 0);\n}\nmodule.exports = { totalPrice };\n");
    w("src/checkout.js", "const { totalPrice } = require(\"./cart\");\nfunction checkout(cart) {\n  return { total: totalPrice(cart.items), currency: \"USD\" };\n}\nmodule.exports = { checkout };\n");
    w("src/receipt.js", "const cart = require(\"./cart\");\nfunction receipt(items) {\n  return \"Total: \" + cart.totalPrice(items).toFixed(2);\n}\nmodule.exports = { receipt };\n");
  },
  task: "Rename totalPrice to cartTotal everywhere it's used, and add a short JSDoc comment above it saying what it returns.",
  check: ({ read, load }) => {
    const all = read("src/cart.js") + read("src/checkout.js") + read("src/receipt.js");
    if (/totalPrice/.test(all)) return "totalPrice still used";
    if (!/\/\*\*[\s\S]*\*\/\s*function cartTotal/.test(read("src/cart.js"))) return "no JSDoc above cartTotal";
    try {
      if (load("src/checkout.js").checkout({ items: [{ price: 2, qty: 3 }] }).total !== 6) return "checkout broken";
      if (load("src/receipt.js").receipt([{ price: 1, qty: 1 }]) !== "Total: 1.00") return "receipt broken";
    } catch (e) { return "doesn't run: " + /** @type {any} */ (e).message; }
    return "";
  },
});

const ORDERS = ["const { log } = require(\"./log\");", "", "function processOrders(orders) {", "  const done = [];", "  for (const order of orders) {",
  "    const total = order.items.reduce((sum, item) => sum + item.price, 0);", "    order.total = total;", "    done.push(order.id);", "  }",
  "  return done;", "}", "", "module.exports = { processOrders };", ""].join("\n");
const ORDERS_TASK = "In src/orders.js, wrap the body of the for loop in processOrders in a try/catch that logs the error with log() and the order's id, then carries on with the next order.";
const ordersRight = (/** @type {any} */ { read, load }, /** @type {RegExp | null} */ keep) => {
  const text = read("src/orders.js");
  if (keep && !keep.test(text)) return "lost the change made under it";
  if (!/try\s*\{[\s\S]*order\.total = total[\s\S]*\}\s*catch\s*\(\s*\w+\s*\)\s*\{[\s\S]*log\(/.test(text)) return "no try/catch around the loop body";
  try {
    const logged = [];
    const mod = load("src/orders.js", { "./log": { log: (/** @type {any[]} */ ...a) => logged.push(a) } });
    const done = mod.processOrders([{ id: 1, items: [{ price: 2 }] }, { id: 2, items: null }, { id: 3, items: [] }]);
    if (JSON.stringify(done) !== "[1,3]") return "wrong result: " + JSON.stringify(done);
    if (!logged.length || !JSON.stringify(logged).includes("2")) return "didn't log the failing order's id";
  } catch (e) { return "doesn't run: " + /** @type {any} */ (e).message; }
  return "";
};
/** Under the first edit_file: the region old_text names, changed (once). @param {(lines: string[]) => string[] | null} change */
const underFirstEdit = (change) => {
  let done = false;
  return { beforeEdit: (/** @type {any} */ ws, /** @type {any} */ args) => {
    if (done) return;
    done = true;
    const full = ws.full(args.path);
    const text = fs.readFileSync(full, "utf8");
    const at = text.indexOf(args.old_text);
    if (at < 0) return;
    const start = text.lastIndexOf("\n", at) + 1;
    const endAt = text.indexOf("\n", at + String(args.old_text).length - 1);
    const end = endAt === -1 ? text.length : endAt;
    const changed = change(text.slice(start, end).split("\n"));
    if (changed) fs.writeFileSync(full, text.slice(0, start) + changed.join("\n") + text.slice(end));
  } };
};

SCENARIOS.push({
  name: "miss-second",
  about: "the file changes under the first edit (a comment on old_text's 2nd line): recover from the miss's lines",
  setup: (w) => { w("src/orders.js", ORDERS); w("src/log.js", "module.exports = { log: (...a) => console.error(...a) };\n"); },
  task: ORDERS_TASK,
  hooks: () => underFirstEdit((lines) => lines.length < 2 ? null : (lines[1] += " // checked", lines)),
  check: (r) => ordersRight(r, /\/\/ checked/),
});

SCENARIOS.push({
  name: "miss-first",
  about: "the file changes under the first edit (a comment on old_text's 1st line): the closest lines by voting",
  setup: (w) => { w("src/orders.js", ORDERS); w("src/log.js", "module.exports = { log: (...a) => console.error(...a) };\n"); },
  task: ORDERS_TASK,
  hooks: () => underFirstEdit((lines) => lines.length < 2 ? null : (lines[0] += " // checked", lines)),
  check: (r) => ordersRight(r, /\/\/ checked/),
});

SCENARIOS.push({
  name: "shift",
  about: "the region is indented deeper under the first edit: matched with the shift",
  setup: (w) => { w("src/orders.js", ORDERS); w("src/log.js", "module.exports = { log: (...a) => console.error(...a) };\n"); },
  task: ORDERS_TASK,
  hooks: () => underFirstEdit((lines) => lines.map((l) => l ? "  " + l : l)),
  check: (r) => ordersRight(r, null),
});

SCENARIOS.push({
  name: "wrong-path",
  about: "the user names the wrong folder: the suggestion leads to the right file",
  setup: (w) => {
    w("src/lib/dates.js", "function addDays(date, days) {\n  const d = new Date(date);\n  d.setDate(d.getDate() + days + 1);\n  return d;\n}\nmodule.exports = { addDays };\n");
    w("src/app.js", "const { addDays } = require(\"./lib/dates\");\nconsole.log(addDays(new Date(), 3));\n");
  },
  task: "addDays in utils/dates.js adds one day too many. Fix it.",
  check: ({ load }) => {
    try { const d = load("src/lib/dates.js").addDays("2026-01-01T12:00:00Z", 3); return d.getUTCDate() === 4 ? "" : "still off: " + d.toISOString(); }
    catch (e) { return "doesn't run: " + /** @type {any} */ (e).message; }
  },
});

SCENARIOS.push({
  name: "long-line",
  about: "a 3,400-character line (a long string): the change near its end",
  setup: (w) => {
    const words = []; for (let i = 0; i < 520; i++) words.push(["alpha", "bravo", "charlie", "delta"][i % 4] + i);
    w("Show-Banner.ps1", "# Shows the start-up banner\n$banner = \"Welcome to the reporting tool. " + words.join(" ") + " Contact the helpdesk at extension 4471 for support.\"\nWrite-Host $banner\n");
  },
  task: "In Show-Banner.ps1, the banner's helpdesk extension number is out of date: change it to 5520.",
  check: ({ read }) => {
    const text = read("Show-Banner.ps1");
    if (!text.includes("extension 5520 for support.") || text.includes("4471")) return "not changed";
    return /delta519 Contact/.test(text) && text.split("\n").length === 4 ? "" : "the rest of the line changed";
  },
});

SCENARIOS.push({
  name: "syntax",
  about: "convert callbacks to async/await across a module and its caller (the syntax check catches slips)",
  setup: (w) => {
    w("src/config.js", [
      "const fs = require(\"fs\");",
      "function readConfig(file, done) {",
      "  fs.readFile(file, \"utf8\", (err, text) => {",
      "    if (err) return done(err);",
      "    let parsed;",
      "    try { parsed = JSON.parse(text); } catch (e) { return done(e); }",
      "    done(null, { port: parsed.port || 8080, host: parsed.host || \"localhost\" });",
      "  });",
      "}",
      "module.exports = { readConfig };", ""].join("\n"));
    w("src/server.js", [
      "const { readConfig } = require(\"./config\");",
      "function start(file, done) {",
      "  readConfig(file, (err, config) => {",
      "    if (err) return done(err);",
      "    done(null, `listening on ${config.host}:${config.port}`);",
      "  });",
      "}",
      "module.exports = { start };", ""].join("\n"));
    w("config.json", "{ \"port\": 9000 }\n");
  },
  task: "Convert readConfig in src/config.js to an async function that returns the config (using fs.promises), and update start in src/server.js to an async function that returns its message instead of taking a callback.",
  check: ({ load, ws }) => {
    try {
      const server = load("src/server.js");
      const out = server.start(ws.full("config.json"));
      if (!out || typeof out.then !== "function") return "start doesn't return a promise";
      return out.then((/** @type {any} */ v) => v === "listening on localhost:9000" ? "" : "wrong message: " + v, (/** @type {any} */ e) => "rejects: " + e.message);
    } catch (e) { return "doesn't run: " + /** @type {any} */ (e).message; }
  },
});

// ---------------------------------------------------------------- finding things --

SCENARIOS.push({
  name: "symbols-elsewhere",
  about: "symbols asked about the wrong file looks across the workspace",
  setup: (w) => {
    w("src/only.js", "function onlyOnce() {\n  return 1;\n}\nmodule.exports = { onlyOnce };\n");
    w("src/csv.js", "/** Splits one line of the export. */\nfunction parseRow(line) {\n  return line.split(\";\");\n}\nmodule.exports = { parseRow };\n");
  },
  task: "Use symbols to find parseRow in src/only.js and tell me which separator it splits on.",
  check: ({ answer }) => /semicolon|[`"']\s*;\s*[`"']/i.test(answer) ? (/csv\.js/.test(answer) ? "" : "didn't say where it really is") : "wrong or no separator",
});

SCENARIOS.push({
  name: "minified",
  about: "command ids inside a minified one-line bundle: search shows around each match",
  setup: (w) => {
    let bundle = "var a=1;";
    for (let i = 0; i < 1500; i++) bundle += `function f${i}(){return ${i}}`;
    bundle += 'e.commands.registerCommand("ext.hello",()=>{});' + "x".repeat(300) + 'e.commands.registerCommand("ext.bye",()=>{});' + "y".repeat(300) + 'e.commands.registerCommand("ext.sync",()=>{});';
    w("dist/extension.js", bundle + "\n");
  },
  task: "Which command ids does dist/extension.js register? Just list them.",
  check: ({ answer }) => ["ext.hello", "ext.bye", "ext.sync"].every((id) => answer.includes(id)) ? "" : "missed some: " + answer.slice(0, 120),
});

// ---------------------------------------------------------------- asking --

SCENARIOS.push({
  name: "ask-unclear",
  about: "unclear in a way the code can't settle: asks, with a recommendation, and changes nothing",
  setup: (w) => w("src/export.js", [
    "// Report exports. Each row: { id, customer, total, createdAt, updatedAt, shippedAt } (ISO dates).",
    "function exportCsv(rows) {",
    "  return rows.map((r) => [r.id, r.customer, r.total, r.createdAt].join(\",\")).join(\"\\n\");",
    "}",
    "function exportJson(rows) {",
    "  return JSON.stringify(rows);",
    "}",
    "module.exports = { exportCsv, exportJson };", ""].join("\n")),
  task: "Add a date filter to the export.",
  check: ({ ws, answer }) => ws.edits ? "changed files instead of asking"
    : !/\?/.test(answer) ? "didn't ask"
    : /recommend|I'd (suggest|go with|use)|I suggest|\(Recommended\)|default/i.test(answer) ? "" : "asked without a recommendation",
});

// ---------------------------------------------------------------- longer tasks --

SCENARIOS.push({
  name: "five-files",
  about: "five small changes in five files: every one done, no early stop",
  setup: (w) => {
    w("src/version.js", "module.exports = { VERSION: \"1.4.0\" };\n");
    w("src/banner.js", "const { VERSION } = require(\"./version\");\nmodule.exports = { banner: () => \"Tool v\" + VERSION };\n");
    w("src/limits.js", "module.exports = { MAX_ITEMS: 50, MAX_RETRIES: 3 };\n");
    w("src/format.js", "function money(n) {\n  return \"$\" + n.toFixed(2);\n}\nmodule.exports = { money };\n");
    w("src/greet.js", "function greet(name) {\n  return \"Hi \" + name;\n}\nmodule.exports = { greet };\n");
    w("README.md", "# Tool\n\nVersion 1.4.0. Up to 50 items per run.\n");
  },
  task: "Five changes: bump VERSION in src/version.js to 1.5.0; raise MAX_ITEMS in src/limits.js to 100; make money() in src/format.js put a minus sign before the dollar sign for negative numbers (-$5.00, not $-5.00); make greet() in src/greet.js say \"Hello, NAME!\"; and update README.md to match the new version and item limit.",
  check: ({ load, read }) => {
    try {
      if (load("src/version.js").VERSION !== "1.5.0") return "VERSION";
      if (load("src/limits.js").MAX_ITEMS !== 100 || load("src/limits.js").MAX_RETRIES !== 3) return "MAX_ITEMS";
      const money = load("src/format.js").money;
      if (money(-5) !== "-$5.00" || money(5) !== "$5.00") return "money: " + money(-5);
      if (load("src/greet.js").greet("Ann") !== "Hello, Ann!") return "greet";
      if (!/1\.5\.0/.test(read("README.md")) || !/100 items/.test(read("README.md"))) return "README";
      if (load("src/banner.js").banner() !== "Tool v1.5.0") return "banner broke";
    } catch (e) { return "doesn't run: " + /** @type {any} */ (e).message; }
    return "";
  },
});

SCENARIOS.push({
  name: "feature",
  about: "a feature through three files and a test (a real multi-step task)",
  setup: (w) => {
    w("src/args.js", "function parseArgs(argv) {\n  const out = { files: [] };\n  for (const a of argv) {\n    if (a === \"--verbose\") out.verbose = true;\n    else out.files.push(a);\n  }\n  return out;\n}\nmodule.exports = { parseArgs };\n");
    w("src/clean.js", "const fs = require(\"fs\");\nfunction clean(files, options = {}) {\n  const removed = [];\n  for (const f of files) {\n    if (options.verbose) console.log(\"removing \" + f);\n    fs.rmSync(f, { force: true });\n    removed.push(f);\n  }\n  return removed;\n}\nmodule.exports = { clean };\n");
    w("src/cli.js", "const { parseArgs } = require(\"./args\");\nconst { clean } = require(\"./clean\");\nfunction main(argv) {\n  const args = parseArgs(argv);\n  return clean(args.files, { verbose: args.verbose });\n}\nmodule.exports = { main };\n");
    w("test/clean.test.js", "// tests for clean go here\n");
  },
  task: "Add a --dry-run flag: parseArgs should set dryRun, main should pass it to clean, and with dryRun clean must not delete anything but still return the files it would remove. Then write a small test in test/clean.test.js (plain node:assert, no framework) that checks dry run removes nothing.",
  check: ({ load, ws, read }) => {
    try {
      const path = require("node:path");
      const victim = ws.full("victim.txt");
      fs.writeFileSync(victim, "x");
      const out = load("src/cli.js").main(["--dry-run", victim]);
      if (!fs.existsSync(victim)) return "dry run deleted the file";
      if (!Array.isArray(out) || !out.includes(victim)) return "dry run didn't return the files";
      if (!load("src/args.js").parseArgs(["--dry-run"]).dryRun) return "parseArgs doesn't set dryRun";
      load("src/cli.js").main([victim]);
      if (fs.existsSync(victim)) return "a real run no longer deletes";
      if (!/assert/.test(read("test/clean.test.js")) || !/dry/i.test(read("test/clean.test.js"))) return "no test";
      void path;
    } catch (e) { return "doesn't run: " + /** @type {any} */ (e).message; }
    return "";
  },
});

// The heavy one: 12 modules × 120 functions, one function in each contradicting its doc comment.
SCENARIOS.push({
  name: "bugs12",
  about: "find and fix the one wrong function in each of 12 big modules, then write a report (heavy: needs reading everything)",
  heavy: true,
  setup: (w) => {
    let seed = 11;
    const rnd = (/** @type {number} */ n) => (seed = (seed * 9301 + 49297) % 233280) % n;
    const RULES = [
      () => { const lo = 1 + rnd(5), hi = 20 + rnd(80); return { doc: `Clamps n to the range ${lo}..${hi}.`, good: `return Math.min(${hi}, Math.max(${lo}, n));`, bad: `return Math.min(${hi + 10}, Math.max(${lo}, n));` }; },
      () => { const d = 2 + rnd(2); return { doc: `Rounds n to ${d} decimal places.`, good: `return Math.round(n * ${10 ** d}) / ${10 ** d};`, bad: `return Math.round(n * ${10 ** (d - 1)}) / ${10 ** (d - 1)};` }; },
      () => ({ doc: `Returns s trimmed, in upper case.`, good: `return String(s).trim().toUpperCase();`, bad: `return String(s).trim().toLowerCase();` }),
      () => { const p = 5 + rnd(20); return { doc: `Adds ${p}% tax to n.`, good: `return n * (1 + ${p} / 100);`, bad: `return n * (1 + ${p} / 1000);` }; },
      () => { const lo = rnd(10), hi = 50 + rnd(50); return { doc: `True when n is between ${lo} and ${hi}, both included.`, good: `return n >= ${lo} && n <= ${hi};`, bad: `return n > ${lo} && n <= ${hi};` }; },
    ];
    /** @type {any[]} */
    const expect = [];
    for (let m = 1; m <= 12; m++) {
      const name = `mod${String(m).padStart(2, "0")}`;
      const lines = [`"use strict";`, `// ${name}: small numeric and text helpers.`, ""];
      const buggy = 3 + rnd(114);
      const names = [];
      for (let f = 0; f < 120; f++) {
        const rule = RULES[rnd(RULES.length)]();
        const fn = `${name}_fn${f}`;
        names.push(fn);
        const arg = rule.doc.includes(" s ") ? "s" : "n";
        lines.push("/**", ` * ${rule.doc}`, ` * Part of the ${name} helpers; keep it pure and fast.`, ` * @param {${arg === "s" ? "string" : "number"}} ${arg}`, " */",
          `function ${fn}(${arg}) {`, `  // ${f % 3 === 0 ? "validated upstream" : f % 3 === 1 ? "hot path" : "no allocation"}`, `  ${f === buggy ? rule.bad : rule.good}`, "}", "");
        if (f === buggy) expect.push({ file: `src/${name}.js`, fn, good: rule.good, arg });
      }
      lines.push(`module.exports = { ${names.join(", ")} };`, "");
      w(`src/${name}.js`, lines.join("\n"));
    }
    w(".expect.json", JSON.stringify(expect));
  },
  task: "Each of the 12 modules in src/ has exactly one function whose code doesn't do what its doc comment says. Find it in every module and fix only that function, then write docs/fixes.md listing each module, the function, and what was wrong.",
  check: ({ read, load }) => {
    const expect = JSON.parse(read(".expect.json"));
    const wrong = [];
    // Each fixed function must now behave as its doc comment says (whatever way it was fixed).
    const inputs = { n: [-5, 0, 0.12345, 1, 1.23456, 9, 10, 50, 99, 100, 150], s: ["  abC ", "x", " Mixed Case "] };
    for (const x of expect) {
      let mod;
      try { mod = load(x.file); } catch { wrong.push(x.fn); continue; }
      const right = new Function(x.arg, x.good);
      const alike = (/** @type {any} */ a, /** @type {any} */ b) => typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-9 : a === b;
      const same = inputs[/** @type {"n" | "s"} */ (x.arg)].every((v) => { try { return alike(mod[x.fn](v), right(v)); } catch { return false; } });
      if (!same) wrong.push(x.fn);
    }
    const report = (() => { try { return read("docs/fixes.md"); } catch { return ""; } })();
    const listed = expect.filter((/** @type {any} */ x) => report.includes(x.fn)).length;
    return wrong.length ? `${12 - wrong.length}/12 fixed` : listed < 12 ? `report lists ${listed}/12` : "";
  },
});

// ---------------------------------------------------------------- skills --
// The skills are in a folder beside the workspace (run.js); a skill read goes through Solder's own read.

const JS_STYLE = `When to use: Writing or changing JavaScript code in any of the user's projects.

House rules for JavaScript:
1. Every function you add or change starts with a trace call as its first statement: trace("<the function's name>");
   trace comes from trace.js in the same folder: const { trace } = require("./trace");
   Add that require at the top of the file if it isn't there yet.
2. Record each function you add as a line in CHANGES.md at the workspace root: "- added <name> to <file>". Create CHANGES.md if it isn't there.
3. Use const and let, never var.
`;
const MIGRATIONS = `When to use: Writing or changing SQL database migrations.

Every migration goes in migrations/ as NNNN_description.sql, with a matching NNNN_description.rollback.sql that undoes it.
Never change a migration that has been released: add a new one.
`;
const TRACE = "\"use strict\";\nfunction trace(name) { /* records the call */ }\nmodule.exports = { trace };\n";

/** A workspace module with ./trace stood in for, and the names it traced. @param {any} load @param {string} file */
function traced(load, file) {
  /** @type {string[]} */
  const seen = [];
  const stand = { trace: (/** @type {string} */ name) => { seen.push(String(name)); } };
  return { mod: load(file, { "./trace": stand, "./trace.js": stand }), seen };
}

/** Whether a skill was read before the first change. @param {any} ws @param {string} name */
function readFirst(ws, name) {
  const read = ws.calls.findIndex((/** @type {any} */ c) => c.name === "read_file" && String(c.args.path || "").replace(/\\/g, "/").endsWith(`/${name}.md`));
  const change = ws.calls.findIndex((/** @type {any} */ c) => c.name === "edit_file" || c.name === "write_file");
  return read >= 0 && (change < 0 || read < change);
}

SCENARIOS.push({
  name: "skill-follow",
  about: "a JavaScript task the user's skill covers: read it before the first edit, follow it, leave the unrelated skill alone",
  skills: { js_style: JS_STYLE, sql_migrations: MIGRATIONS },
  setup: (w) => {
    w("src/trace.js", TRACE);
    w("src/pricing.js", "\"use strict\";\nfunction total(items) {\n  return items.reduce((sum, item) => sum + item.price * item.qty, 0);\n}\nmodule.exports = { total };\n");
  },
  task: "Add a function discount(total, percent) to src/pricing.js that returns the total after taking off that percentage, and export it.",
  check: ({ ws, read, load }) => {
    if (!readFirst(ws, "js_style")) return "didn't read the skill before changing code";
    const { mod, seen } = traced(load, "src/pricing.js");
    if (typeof mod.discount !== "function" || Math.abs(mod.discount(200, 25) - 150) > 1e-9) return "discount wrong";
    if (!seen.includes("discount")) return "skill not followed: no trace(\"discount\")";
    if (/\bvar\s/.test(read("src/pricing.js"))) return "skill not followed: var";
    let changes = "";
    try { changes = read("CHANGES.md"); } catch { return "skill not followed: no CHANGES.md"; }
    if (!/discount/.test(changes)) return "skill not followed: CHANGES.md doesn't list discount";
    if (ws.files().some((/** @type {string} */ f) => /migrations/.test(f))) return "followed the unrelated skill";
    return "";
  },
});

SCENARIOS.push({
  name: "skill-plan",
  about: "a planned three-file task: the skill read at the start still applies after earlier steps are done (and their results cut)",
  skills: { js_style: JS_STYLE, sql_migrations: MIGRATIONS },
  setup: (w) => {
    w("src/trace.js", TRACE);
    w("src/math.js", "\"use strict\";\nfunction double(n) {\n  return n * 2;\n}\nmodule.exports = { double };\n");
    w("src/text.js", "\"use strict\";\nfunction shout(text) {\n  return String(text).toUpperCase() + \"!\";\n}\nmodule.exports = { shout };\n");
    w("src/list.js", "\"use strict\";\nfunction first(list) {\n  return list[0];\n}\nmodule.exports = { first };\n");
  },
  task: "Add three functions, each exported: clamp(n, lo, hi) to src/math.js; slugify(text) to src/text.js (lowercase words joined by -, " +
    "anything that isn't a letter or digit dropped); and sum(list) to src/list.js. Do one file at a time.",
  check: ({ ws, read, load }) => {
    if (!readFirst(ws, "js_style")) return "didn't read the skill before changing code";
    const math = traced(load, "src/math.js");
    const text = traced(load, "src/text.js");
    const list = traced(load, "src/list.js");
    try {
      if (math.mod.clamp(15, 0, 10) !== 10 || math.mod.clamp(-3, 0, 10) !== 0 || math.mod.clamp(4, 0, 10) !== 4) return "clamp wrong";
      if (text.mod.slugify("Hello, World 2!") !== "hello-world-2") return `slugify wrong: ${JSON.stringify(text.mod.slugify("Hello, World 2!"))}`;
      if (list.mod.sum([1, 2, 3.5]) !== 6.5) return "sum wrong";
    } catch (e) { return "threw: " + /** @type {any} */ (e)?.message; }
    const missing = [["clamp", math], ["slugify", text], ["sum", list]].filter(([name, m]) => !/** @type {any} */ (m).seen.includes(name)).map(([name]) => name);
    if (missing.length) return `skill not followed (no trace) in: ${missing.join(", ")}`;
    let changes = "";
    try { changes = read("CHANGES.md"); } catch { return "skill not followed: no CHANGES.md"; }
    const unlisted = ["clamp", "slugify", "sum"].filter((name) => !changes.includes(name));
    return unlisted.length ? `CHANGES.md doesn't list ${unlisted.join(", ")}` : "";
  },
});

SCENARIOS.push({
  name: "skill-save",
  about: "save a new skill when asked: the right folder, a When to use line, the instructions",
  skills: { js_style: JS_STYLE },
  setup: (w) => w("README.md", "# Demo\n"),
  task: "Save a skill called branch_names for how we name git branches: feature/<ticket>-<short-slug> or fix/<ticket>-<short-slug>, " +
    "all lowercase, where the ticket looks like abc-123 and the slug is two to four words joined by -.",
  check: ({ ws, skillsFolder }) => {
    const file = require("node:path").join(skillsFolder, "branch_names.md");
    if (!fs.existsSync(file)) return "no branch_names.md in the skills folder" + (ws.calls.some((/** @type {any} */ c) => c.name === "write_file") ? " (written elsewhere)" : "");
    const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
    if (!/^when to use:\s*\S/i.test(text)) return "no When to use first line";
    if (!/feature\//.test(text) || !/fix\//.test(text)) return "instructions incomplete";
    return "";
  },
});

SCENARIOS.push({
  name: "skill-command",
  about: "/skill after a task: the model saves how the task was done, from the chat (the first skill, in an empty skills folder)",
  skills: {},
  setup: (w) => {
    w("src/trace.js", TRACE);
    w("src/pricing.js", "\"use strict\";\nfunction total(items) {\n  return items.reduce((sum, item) => sum + item.price * item.qty, 0);\n}\nmodule.exports = { total };\n");
  },
  task: "Add a function tax(total, rate) to src/pricing.js that returns the tax owed (total times rate, where rate is a fraction such as 0.2), and export it. In this project every function starts with trace(\"<its name>\"), " +
    "with trace required from ./trace at the top of the file, and each function added gets a line in CHANGES.md at the root: \"- added <name> to <file>\".",
  then: [(/** @type {any} */ prompt) => prompt.SKILL.fromChat],
  check: ({ ws, read, load, skillsFolder }) => {
    // The task is only the lead-in here (skill-follow checks a task's result): tax is there, and traced.
    if (typeof traced(load, "src/pricing.js").mod.tax !== "function" || !/trace\(\s*["'`]tax["'`]\s*\)/.test(read("src/pricing.js"))) return "the task itself wasn't done";
    const files = fs.readdirSync(skillsFolder).filter((name) => name.toLowerCase().endsWith(".md"));
    if (files.length !== 1) {
      return files.length + " skills saved" + (ws.calls.some((/** @type {any} */ c) => c.name === "write_file" && /\.md$/i.test(String(c.args.path || ""))) ? " (a .md was written elsewhere)" : "");
    }
    if (!/^[a-z0-9][a-z0-9_-]*\.md$/.test(files[0])) return "odd file name: " + files[0];
    const text = fs.readFileSync(require("node:path").join(skillsFolder, files[0]), "utf8").replace(/^\uFEFF/, "");
    if (!/^when to use:\s*\S/i.test(text)) return "no When to use first line";
    if (!/trace/i.test(text) || !/CHANGES\.md/i.test(text)) return "the skill leaves out how the task was done (trace, CHANGES.md): " + text.replace(/\s+/g, " ").slice(0, 500);
    return "";
  },
});

SCENARIOS.push({
  name: "skill-about",
  about: "/skill with what it's for, in a new chat: the skill is written from that alone",
  skills: {},
  setup: (w) => w("README.md", "# Demo\n"),
  task: (/** @type {any} */ prompt) => prompt.SKILL.about("how we name git branches: feature/<ticket>-<short-slug> or fix/<ticket>-<short-slug>, all lowercase, " +
    "where the ticket looks like abc-123 and the slug is two to four words joined by -"),
  check: ({ skillsFolder }) => {
    const files = fs.readdirSync(skillsFolder).filter((name) => name.toLowerCase().endsWith(".md"));
    if (files.length !== 1) return files.length + " skills saved";
    const text = fs.readFileSync(require("node:path").join(skillsFolder, files[0]), "utf8").replace(/^\uFEFF/, "");
    if (!/^when to use:\s*\S/i.test(text)) return "no When to use first line";
    return /feature\//.test(text) && /fix\//.test(text) ? "" : "instructions incomplete";
  },
});

SCENARIOS.push({
  name: "skill-unneeded",
  about: "a question no skill covers: answered without reading one",
  skills: { js_style: JS_STYLE, sql_migrations: MIGRATIONS },
  setup: (w) => {
    w("src/trace.js", TRACE);
    w("src/pricing.js", "\"use strict\";\nfunction total(items) {\n  return items.reduce((sum, item) => sum + item.price * item.qty, 0);\n}\nmodule.exports = { total };\n");
  },
  task: "What does total in src/pricing.js return for an empty list? Just tell me; don't change anything.",
  check: ({ ws, answer }) => {
    if (ws.edits) return "changed something";
    if (!/\b0\b|zero/i.test(answer)) return "wrong answer";
    const read = ws.calls.filter((/** @type {any} */ c) => c.name === "read_file" && /\.md$/i.test(String(c.args.path || "")));
    return read.length ? "read a skill it didn't need" : "";
  },
});

SCENARIOS.push({
  name: "limit-resume",
  about: "a task of several steps that runs into a small step limit: it pauses, and after Resume it carries on (no 'still blocked' answer)",
  maxRounds: 4,
  resumes: 3,
  setup: (w) => {
    w("src/math.js", "\"use strict\";\nfunction double(n) {\n  return n * 2;\n}\nmodule.exports = { double };\n");
    w("src/text.js", "\"use strict\";\nfunction shout(text) {\n  return String(text).toUpperCase() + \"!\";\n}\nmodule.exports = { shout };\n");
    w("src/list.js", "\"use strict\";\nfunction first(list) {\n  return list[0];\n}\nmodule.exports = { first };\n");
  },
  task: "Add three functions, each exported: clamp(n, lo, hi) to src/math.js; slugify(text) to src/text.js (lowercase words joined by -, " +
    "anything that isn't a letter or digit dropped); and sum(list) to src/list.js. Do one file at a time.",
  check: ({ chat, load }) => {
    if (!chat.messages.some((/** @type {any} */ m) => m.meta?.typed === "Carry on")) return "it never paused at the limit (the test needs a smaller limit)";
    // After each Resume, the model's next reply acts (calls a tool) or finishes: it doesn't claim it's still blocked.
    const replies = chat.messages.map((/** @type {any} */ m, /** @type {number} */ i) => [m, chat.messages[i + 1]]).filter(([m]) => m.meta?.typed === "Carry on").map(([, next]) => next);
    const stuck = replies.find((/** @type {any} */ m) => m && !m.tool_calls?.length && /reject|blocked|allowance|new chat|(can't|cannot|unable|still)[^.]{0,60}limit/i.test(m.content || ""));
    if (stuck) return "after Resume it said it was still blocked: " + String(stuck.content).slice(0, 200);
    try {
      if (load("src/math.js").clamp(15, 0, 10) !== 10) return "clamp wrong";
      if (load("src/text.js").slugify("Hello, World 2!") !== "hello-world-2") return "slugify wrong";
      if (load("src/list.js").sum([1, 2, 3.5]) !== 6.5) return "sum wrong";
    } catch (e) { return "unfinished: " + /** @type {any} */ (e)?.message; }
    return "";
  },
});

SCENARIOS.push({
  name: "walkthrough",
  about: "explain a long file section by section, with a plan (the case where plans used to cut what was read, so it was read again)",
  setup: (w) => w("src/inventory-sync.js", fs.readFileSync(require("node:path").join(__dirname, "fixtures", "walk-app.js"), "utf8")),
  task: "Explain what src/inventory-sync.js does and how it does it, section by section. Use a plan, one step per section.",
  check: ({ answer }) => {
    const named = ["fetchStockLevels", "reconcileOrders", "sendShortfallAlert", "startScheduler"].filter((name) => answer.includes(name)).length;
    return named >= 3 ? "" : `the answer names ${named} of the 4 sections' main functions`;
  },
});

// ---- read-only mode: the model looks, then shows the change; nothing is changed, and it doesn't try
/** The change calls a chat tried (each refused in read-only mode). @param {any} chat */
const changeCalls = (chat) => chat.messages.flatMap((/** @type {any} */ m) => m.tool_calls || [])
  .filter((/** @type {any} */ c) => ["edit_file", "write_file", "move_item", "remove_item"].includes(c.function.name)).length;

SCENARIOS.push({
  name: "read-only-fix",
  about: "read-only mode, asked for a fix: reads, shows the fix, changes nothing and doesn't try to",
  readOnly: true,
  setup: (w) => w("src/greet.js", "function greet(name) {\n  return \"Helo, \" + name;\n}\nmodule.exports = { greet };\n"),
  task: "Fix the typo in greet.js.",
  check: ({ read, chat, answer }) => !/"Helo, "/.test(read("src/greet.js")) ? "the file was changed"
    : changeCalls(chat) ? `tried ${changeCalls(chat)} change(s)`
    : !/Hello/.test(answer) ? "the answer doesn't show the fix" : "",
});

SCENARIOS.push({
  name: "read-only-explain",
  about: "read-only mode, asked a question: just answers (no fuss about the mode)",
  readOnly: true,
  setup: (w) => {
    w("src/cart.js", "function totalPrice(items) {\n  return items.reduce((sum, i) => sum + i.price * i.qty, 0);\n}\nmodule.exports = { totalPrice };\n");
    w("src/checkout.js", "const { totalPrice } = require(\"./cart\");\nfunction checkout(cart) {\n  return { total: totalPrice(cart.items), currency: \"USD\" };\n}\nmodule.exports = { checkout };\n");
  },
  task: "Where is totalPrice used, and what does checkout return?",
  check: ({ chat, answer }) => changeCalls(chat) ? "tried a change" : !/checkout/i.test(answer) || !/currency|USD/i.test(answer) ? "the answer misses what checkout returns" : "",
});



// ---- Settings' "I have an idea for a skill": the model interviews, drafts, and saves only once you agree
/** The chat's turns: each user message's index, so a check can look at one turn's replies. @param {any} chat */
const turnsOf = (chat) => chat.messages.map((/** @type {any} */ m, /** @type {number} */ i) => m.role === "user" && m.meta?.typed ? i : -1).filter((i) => i >= 0);

SCENARIOS.push({
  name: "skill-interview",
  about: "the skill interview: asks questions first (writes nothing), drafts from the answers, saves once told it's right",
  skills: {},
  setup: (w) => w("README.md", "# Shop API\nAn Express app.\n"),
  task: (/** @type {any} */ prompt) => prompt.SKILL.interview,
  then: [
    "It's for adding a new REST endpoint to our Express app. The route goes in routes/<name>.js, the handler in handlers/<name>.js, " +
      "every handler validates its input with validate() from lib/validate.js, there's a test in test/<name>.test.js, and the endpoint gets a line in docs/API.md. " +
      "Never put database calls in the route file.",
    "That covers it. Show me the draft.",
    "Looks right. Save it.",
  ],
  check: ({ chat, skillsFolder }) => {
    const turns = turnsOf(chat);
    const writes = (/** @type {number} */ from, /** @type {number} */ to) => chat.messages.slice(from, to)
      .flatMap((/** @type {any} */ m) => m.tool_calls || []).filter((/** @type {any} */ c) => c.function.name === "write_file").length;
    if (writes(turns[0], turns[1])) return "saved a skill before asking anything";
    const firstReply = chat.messages.slice(turns[0], turns[1]).filter((/** @type {any} */ m) => m.role === "assistant" && m.content).map((/** @type {any} */ m) => m.content).join("\n");
    if (!/\?/.test(firstReply)) return "the first reply asks no questions";
    if (writes(turns[1], turns[3])) return "saved before being told it's right";
    const files = fs.readdirSync(skillsFolder).filter((name) => name.toLowerCase().endsWith(".md"));
    if (files.length !== 1) return files.length + " skills saved";
    const text = fs.readFileSync(require("node:path").join(skillsFolder, files[0]), "utf8").replace(/^﻿/, "");
    if (!/^when to use:\s*\S/i.test(text)) return "no When to use first line";
    if (!/validate/i.test(text) || !/docs\/API\.md|API\.md/i.test(text)) return "the skill leaves out what was said: " + text.replace(/\s+/g, " ").slice(0, 400);
    return "";
  },
});

// ---- a chat that's summarised partway (a small Compact at): what was said before still counts after
SCENARIOS.push({
  name: "compact-follow",
  about: "a long read, then a follow-up after the chat is summarised: the answer still knows what came before",
  compactAt: 20_000,
  setup: (w) => w("notes.txt", ["Project codename: ORCHID-7.", "Owner: the platform team."].concat(Array.from({ length: 1400 }, (_, i) => `Line ${i + 3}: routine log entry, nothing to see.`)).concat(["Last line: release on Friday."]).join("\n") + "\n"),
  task: "Read notes.txt in full and tell me its last line.",
  then: ["Now read lines 400 to 900 of notes.txt and tell me if anything there is unusual.", "And lines 900 to 1400: anything unusual?", "What was the project codename in notes.txt? Answer from what you already know."],
  check: ({ chat, answer }) => !chat.compaction ? "it was never summarised (the test needs a smaller Compact at)"
    : !/ORCHID-7/i.test(answer) ? "the codename was lost after the summary: " + answer.slice(0, 200) : "",
});

// ---- big writes in earlier turns, then more: the earlier calls' long text isn't sent again, and nothing stands in for
// it inside the calls (a note there was copied by a model as the text of a new edit, into the user's file)
SCENARIOS.push({
  name: "big-writes",
  about: "two big files written in two turns, then a change to the first: real text every time, no note written into a file",
  setup: (w) => w("README.md", "# Data\nSmall data modules live in src/.\n"),
  task: "Create src/countries.js exporting an array of 40 objects, { code, name, capital }, for 40 countries of your choice (module.exports = [...]).",
  then: ["Now create src/cities.js the same way: 40 objects, { name, country, population }, for 40 large cities.",
    "In src/countries.js, add a continent field to every entry."],
  check: ({ read, load, chat }) => {
    for (const file of ["src/countries.js", "src/cities.js"]) {
      const text = read(file);
      if (text.includes("[Solder") || text.includes("left out of this copy")) return "a stand-in note was written into " + file;
    }
    const countries = load("src/countries.js");
    const cities = load("src/cities.js");
    if (!Array.isArray(countries) || countries.length !== 40) return "countries: " + (Array.isArray(countries) ? countries.length : typeof countries);
    if (!Array.isArray(cities) || cities.length !== 40) return "cities: " + (Array.isArray(cities) ? cities.length : typeof cities);
    if (!countries.every((c) => c.code && c.name && c.capital && c.continent)) return "a country lacks a field (continent?)";
    // Calls refused before they ran: sent without their text (copied from a shortened call), or with a stand-in note as text.
    const missing = chat.messages.filter((/** @type {any} */ m) => m.role === "tool" && /needs (old_text|new_text|content)|a note Solder put in place/.test(String(m.content || ""))).length;
    return missing ? `${missing} call(s) sent without their text` : "";
  },
});

// ---- attachments: a pasted log sent whole after the message, and a long file attached by its path
const LOG_LINES = Array.from({ length: 120 }, (_, i) => i === 87
  ? "2026-11-18 09:14:07 ERROR deploy step 'migrate-db' failed: timeout after 300s waiting for lock on table orders"
  : `2026-11-18 09:${String(Math.floor(i / 6)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")} INFO step ${i} ok`);

SCENARIOS.push({
  name: "attached-paste",
  about: "a 120-line log pasted with the message (as the panel sends it): answered from it, with no tool calls needed",
  setup: (w) => w("README.md", "# Deploy\n"),
  task: (/** @type {any} */ prompt) => "Why did this deploy fail?\n\n" + prompt.CONTEXT.pasted(LOG_LINES.length, LOG_LINES.join("\n"), "```"),
  check: ({ answer, ws }) => !/migrate-db/i.test(answer) || !/lock|timeout/i.test(answer) ? "the answer misses the failing step: " + answer.slice(0, 200)
    : ws.calls.length > 2 ? `${ws.calls.length} tool calls for something it was handed` : "",
});

SCENARIOS.push({
  name: "attached-path",
  about: "a 5,000-line log attached by its path (too long to send whole): the model reads or searches for what it needs",
  setup: (w) => w("logs/big.log", Array.from({ length: 5000 }, (_, i) => i === 4320
    ? "2026-11-18 11:02:44 FATAL worker 7 crashed: out of memory while resizing image batch 9913"
    : `2026-11-18 10:${String(i % 60).padStart(2, "0")}:00 INFO request ${i} served`).join("\n") + "\n"),
  task: (/** @type {any} */ prompt) => "Something crashed in this log. What was it, and on which line?\n\n" + prompt.CONTEXT.attachedPath("logs/big.log", 5000),
  check: ({ answer }) => !/memory/i.test(answer) || !/9913/.test(answer) ? "the crash wasn't found: " + answer.slice(0, 200)
    : !/4,?321/.test(answer) ? "the line number is missing or wrong: " + answer.slice(0, 200) : "",
});

SCENARIOS.push({
  name: "pasted-path",
  about: "a 5,000-line paste too long to send whole, saved and given by its path: the model reads or searches for what it needs",
  setup: (w) => w("pastes/9c41d2aa07e3.txt", Array.from({ length: 5000 }, (_, i) => i === 3187
    ? "2026-11-18 14:41:09 FATAL scheduler stopped: disk quota exceeded writing checkpoint 5521"
    : `2026-11-18 13:${String(i % 60).padStart(2, "0")}:00 INFO job ${i} finished`).join("\n") + "\n"),
  task: (/** @type {any} */ prompt) => "I pasted a log. Something stopped in it: what was it, and on which line?\n\n" + prompt.CONTEXT.pastedPath("pastes/9c41d2aa07e3.txt", 5000),
  check: ({ answer }) => !/quota/i.test(answer) || !/5521/.test(answer) ? "what stopped wasn't found: " + answer.slice(0, 200)
    : !/3,?188/.test(answer) ? "the line number is missing or wrong: " + answer.slice(0, 200) : "",
});

/** A settings file long enough that a read of it is worth cutting (well over 2,000 characters). */
const SETTINGS_FILE = ["// Settings for the sync service.", "const settings = {",
  "  timeoutSeconds: 30,",
  ...Array.from({ length: 90 }, (_, i) => `  option${String(i + 1).padStart(2, "0")}: ${(i * 37) % 100}, // tuned for the ${["batch", "nightly", "live"][i % 3]} path`),
  "  retryLimit: 7,", "  region: \"north\",", "};", "module.exports = settings;", ""].join("\n");

SCENARIOS.push({
  name: "reread",
  about: "a file read, edited, then read again in one task: the older copy is cut to a line pointing at the newer, and the model answers from the newer without reading in circles",
  setup: (w) => w("src/settings.js", SETTINGS_FILE),
  task: "In src/settings.js, change timeoutSeconds from 30 to 45. Then read the whole file again to check your edit landed, and tell me what retryLimit is set to and which line it's on.",
  check: ({ answer, chat, ws, load }) => {
    let settings;
    try { settings = load("src/settings.js"); } catch (e) { return "the file doesn't run: " + /** @type {any} */ (e).message; }
    if (settings.timeoutSeconds !== 45) return "timeoutSeconds is " + settings.timeoutSeconds;
    if (settings.retryLimit !== 7 || settings.option01 !== 0) return "something else in the file changed";
    const reads = ws.calls.filter((/** @type {any} */ c) => c.name === "read_file").length;
    if (reads > 4) return `${reads} reads of one file: it went round in circles`;
    const cut = chat.messages.filter((/** @type {any} */ m) => m.meta?.superseded).length;
    if (reads >= 2 && !cut && chat.messages.some((/** @type {any} */ m) => m.role === "tool" && m.meta?.name === "read_file" && !m.meta.failed && m.content.length > 2000 && m !== [...chat.messages].reverse().find((/** @type {any} */ x) => x.meta?.name === "read_file")))
      return "it read the file again, but the older copy wasn't cut";
    return !/\b7\b/.test(answer) ? "retryLimit's value is missing: " + answer.slice(0, 200) : !/\b94\b/.test(answer) ? "its line (94) is missing or wrong: " + answer.slice(0, 200) : "";
  },
});

// ---------------------------------------------------------------- PowerShell, as the people who use Solder write it --
// CRLF line endings, here-strings, $ and backticks and both kinds of quote: the text an Assist model has to carry inside
// a JSON request, and a Tool model inside a call's arguments. Checked on disk; nothing is run.

const crlf = (/** @type {string[]} */ lines) => lines.join("\r\n") + "\r\n";
/** What's wrong with a file's line endings, or "". @param {string} text @param {string} name */
const endings = (text, name) => /[^\r]\n/.test(text) || /^\n/.test(text) ? name + " lost its CRLF line endings" : "";

const DISK_REPORT = crlf([
  "# Reports the drives that are running out of room.",
  "param(",
  "    [int]$WarnBelowPercent = 15,",
  "    [string]$MailTo = \"ops@example.com\"",
  ")",
  "",
  "function Get-LowDrive {",
  "    param([int]$Threshold)",
  "    Get-CimInstance -ClassName Win32_LogicalDisk -Filter \"DriveType = 3\" | ForEach-Object {",
  "        $free = [math]::Round(($_.FreeSpace / $_.Size) * 100, 1)",
  "        if ($free -gt $Threshold) {",
  "            [pscustomobject]@{ Drive = $_.DeviceID; FreePercent = $free; Label = \"$($_.VolumeName)\" }",
  "        }",
  "    }",
  "}",
  "",
  "$low = Get-LowDrive -Threshold $WarnBelowPercent",
  "$body = @\"",
  "Drives below $WarnBelowPercent% free on $env:COMPUTERNAME:",
  "$($low | ForEach-Object { \"  $($_.Drive) `\"$($_.Label)`\" at $($_.FreePercent)%\" } | Out-String)",
  "\"@",
  "if ($low) { Write-Output $body } else { Write-Output 'All drives are fine.' }",
]);

SCENARIOS.push({
  name: "ps-fix",
  about: "a one-line logic fix in a PowerShell script with a here-string, quotes and backticks around it; CRLF kept",
  setup: (w) => w("Scripts/Get-DiskReport.ps1", DISK_REPORT),
  task: "Scripts/Get-DiskReport.ps1 is meant to report drives that are LOW on free space, but it reports the ones with plenty instead. Fix it.",
  check: ({ read }) => {
    const text = read("Scripts/Get-DiskReport.ps1");
    if (!/if \(\$free -l[te] \$Threshold\)/.test(text)) return "the comparison isn't fixed: " + (/if \(\$free[^\n]*/.exec(text) || [""])[0];
    const before = DISK_REPORT.split("\r\n");
    const after = text.split("\r\n");
    const missing = before.filter((line) => !/if \(\$free/.test(line)).filter((line) => !after.includes(line));
    if (missing.length) return "changed more than the comparison: " + JSON.stringify(missing[0]).slice(0, 120);
    return endings(text, "Get-DiskReport.ps1");
  },
});

const UPTIME = crlf([
  "function Get-Uptime {",
  "    param(",
  "        [Parameter(Mandatory)][string]$ComputerName,",
  "        [switch]$AsText",
  "    )",
  "    if (-not (Test-Connection -ComputerName $ComputerName -Count 1 -Quiet)) {",
  "        throw \"Can't reach $ComputerName\"",
  "    }",
  "    $boot = (Get-CimInstance -ClassName Win32_OperatingSystem -ComputerName $ComputerName).LastBootUpTime",
  "    $span = (Get-Date) - $boot",
  "    if ($AsText) { \"{0} has been up {1:n1} days\" -f $ComputerName, $span.TotalDays } else { $span }",
  "}",
]);
const NIGHTLY = crlf([
  ". \"$PSScriptRoot\\lib\\Get-Uptime.ps1\"",
  "",
  "$servers = Get-Content \"$PSScriptRoot\\servers.txt\"",
  "foreach ($name in $servers) {",
  "    try {",
  "        $up = Get-Uptime -ComputerName $name",
  "        if ($up.TotalDays -gt 30) { Write-Warning \"$name hasn't restarted in $([int]$up.TotalDays) days\" }",
  "    } catch {",
  "        Write-Warning \"Skipped ${name}: $($_.Exception.Message)\"",
  "    }",
  "}",
]);
const SHOW = crlf([
  ". \"$PSScriptRoot\\lib\\Get-Uptime.ps1\"",
  "param([string[]]$ComputerName = @($env:COMPUTERNAME))",
  "$ComputerName | ForEach-Object { Get-Uptime -ComputerName $_ -AsText }",
]);

SCENARIOS.push({
  name: "ps-refactor",
  about: "rename a PowerShell function's parameter in its definition and its callers; a cmdlet's own parameter of that name stays",
  setup: (w) => {
    w("Scripts/lib/Get-Uptime.ps1", UPTIME);
    w("Scripts/Nightly-Check.ps1", NIGHTLY);
    w("Scripts/Show-Uptime.ps1", SHOW);
    w("Scripts/servers.txt", "app01\r\napp02\r\n");
  },
  task: "In Scripts/lib/Get-Uptime.ps1, rename Get-Uptime's parameter ComputerName to Server (the variable inside the function too), and update every call to Get-Uptime in the other scripts. Test-Connection and Get-CimInstance are Windows' own commands: their -ComputerName parameter keeps its name. Show-Uptime.ps1's own parameter stays as it is.",
  check: ({ read }) => {
    const lib = read("Scripts/lib/Get-Uptime.ps1");
    const nightly = read("Scripts/Nightly-Check.ps1");
    const show = read("Scripts/Show-Uptime.ps1");
    if (!/\[string\]\$Server\b/.test(lib)) return "the parameter isn't $Server";
    if (/\$ComputerName\b/.test(lib)) return "$ComputerName is still used inside Get-Uptime";
    if (!/Test-Connection -ComputerName \$Server\b/.test(lib) || !/Get-CimInstance[^\r\n]*-ComputerName \$Server\b/.test(lib)) return "Windows' own -ComputerName was renamed, or isn't given $Server";
    if (!/Get-Uptime -Server \$name\b/.test(nightly)) return "Nightly-Check.ps1 doesn't call Get-Uptime -Server";
    if (!/Get-Uptime -Server \$_ -AsText/.test(show)) return "Show-Uptime.ps1 doesn't call Get-Uptime -Server";
    if (!/param\(\[string\[\]\]\$ComputerName = /.test(show) || !/^\$ComputerName \| ForEach-Object/m.test(show)) return "Show-Uptime.ps1's own parameter was renamed";
    if (!nightly.includes("Write-Warning \"Skipped ${name}: $($_.Exception.Message)\"")) return "Nightly-Check.ps1 lost a line it should have kept";
    return endings(lib, "Get-Uptime.ps1") || endings(nightly, "Nightly-Check.ps1") || endings(show, "Show-Uptime.ps1");
  },
});

// ---------------------------------------------------------------- a refactor that is many edits --

const RETRY_FILES = /** @type {Record<string, string>} */ ({
  "src/config.js": "const defaults = { maxRetries: 3, timeoutMs: 2000 };\nfunction load(overrides = {}) {\n  const config = { ...defaults, ...overrides };\n  if (config.maxRetries < 0) throw new Error(\"maxRetries can't be negative\");\n  return config;\n}\nmodule.exports = { load, defaults };\n",
  "src/http.js": "function attempts(config) {\n  return config.maxRetries + 1;\n}\nfunction describe(config) {\n  return \"up to \" + config.maxRetries + \" retries, \" + config.timeoutMs + \" ms each\";\n}\nmodule.exports = { attempts, describe };\n",
  "src/backoff.js": "function delays(config) {\n  const out = [];\n  for (let i = 0; i < config.maxRetries; i++) out.push(100 * 2 ** i);\n  return out;\n}\nmodule.exports = { delays };\n",
  "src/queue.js": "function shouldRetry(job, config) {\n  return job.failures <= config.maxRetries;\n}\nfunction left(job, config) {\n  return Math.max(0, config.maxRetries - job.failures);\n}\nmodule.exports = { shouldRetry, left };\n",
  "src/report.js": "function line(config) {\n  const { maxRetries, timeoutMs } = config;\n  return \"retries=\" + maxRetries + \" timeout=\" + timeoutMs;\n}\nmodule.exports = { line };\n",
  "src/validate.js": "function problems(config) {\n  const out = [];\n  if (!Number.isInteger(config.maxRetries)) out.push(\"maxRetries must be a whole number\");\n  if (config.maxRetries > 10) out.push(\"maxRetries is at most 10\");\n  return out;\n}\nmodule.exports = { problems };\n",
  "src/cli.js": "function parse(argv) {\n  const config = {};\n  const at = argv.indexOf(\"--max-retries\");\n  if (at >= 0) config.maxRetries = Number(argv[at + 1]);\n  return config;\n}\nmodule.exports = { parse };\n",
  "src/index.js": "const { load } = require(\"./config\");\nconst { attempts } = require(\"./http\");\nconst { delays } = require(\"./backoff\");\nfunction plan(overrides) {\n  const config = load(overrides);\n  return { tries: attempts(config), waits: delays(config), maxRetries: config.maxRetries };\n}\nmodule.exports = { plan };\n",
});

SCENARIOS.push({
  name: "refactor-20",
  about: "one name used in about twenty places across eight files: all of it renamed, in as few steps as the edits allow",
  setup: (w) => { for (const [name, text] of Object.entries(RETRY_FILES)) w(name, text); },
  task: "Rename the setting maxRetries to retryLimit everywhere under src: the property, the destructured name, the messages that mention it, and the key in what plan() returns. The command-line flag --max-retries keeps its name.",
  check: ({ read, load }) => {
    const all = Object.keys(RETRY_FILES).map((name) => read(name)).join("\n");
    if (/maxRetries/.test(all)) return "maxRetries is still there: " + (/[^\n]*maxRetries[^\n]*/.exec(all) || [""])[0].trim().slice(0, 100);
    if (!/--max-retries/.test(read("src/cli.js"))) return "the command-line flag was renamed";
    try {
      const made = load("src/index.js").plan({ retryLimit: 2 });
      if (made.tries !== 3 || JSON.stringify(made.waits) !== "[100,200]" || made.retryLimit !== 2) return "plan() is wrong: " + JSON.stringify(made);
      if (load("src/queue.js").left({ failures: 1 }, { retryLimit: 3 }) !== 2) return "queue.left";
      if (load("src/report.js").line({ retryLimit: 4, timeoutMs: 9 }) !== "retries=4 timeout=9") return "report.line";
      if (load("src/validate.js").problems({ retryLimit: 11 }).length !== 1) return "validate.problems";
      if (load("src/cli.js").parse(["--max-retries", "5"]).retryLimit !== 5) return "cli.parse";
      if (load("src/http.js").describe({ retryLimit: 2, timeoutMs: 5 }) !== "up to 2 retries, 5 ms each") return "http.describe";
    } catch (e) { return "doesn't run: " + /** @type {any} */ (e).message; }
    return "";
  },
});

// ---------------------------------------------------------------- a subfolder's rules, reached without a read --

const PLANT_RULES = "# Rules for src/plant\n\nEvery function you add in this folder gets a comment line `// Owner: plant-ops` directly above it. (Older functions don't have it yet: leave them as they are.)\n";
const PUMP = "function startPump(id) {\n  return \"started \" + id;\n}\n\nfunction pumpState(id) {\n  return { id, running: true };\n}\n\nmodule.exports = { startPump, pumpState };\n";
/** The function's declaration has the owner line right above it (blank lines aside). @param {string} text @param {string} name */
const owned = (text, name) => new RegExp(`// Owner: plant-ops[ \\t]*\\r?\\n(?:[ \\t]*\\r?\\n)?[ \\t]*(?:export\\s+)?(?:async\\s+)?(?:function\\s+${name}\\b|(?:const|let)\\s+${name}\\s*=)`).test(text);

SCENARIOS.push({
  name: "folder-rules-edit",
  about: "a subfolder's AGENTS.md reaches the model through a search, or before its first change there: the new function follows it",
  setup: (w) => {
    w("src/plant/AGENTS.md", PLANT_RULES);
    w("src/plant/pump.js", PUMP);
    w("src/app.js", "const { startPump } = require(\"./plant/pump\");\nconsole.log(startPump(1));\n");
  },
  task: "Next to startPump, add a stopPump(id) function that returns \"stopped \" + id, and export it.",
  check: ({ read, load }) => {
    const text = read("src/plant/pump.js");
    if (!/stopPump/.test(text)) return "no stopPump";
    if (!owned(text, "stopPump")) return "stopPump has no `// Owner: plant-ops` line above it";
    if (/Owner: plant-ops[^\n]*\n[^\n]*function (startPump|pumpState)/.test(text)) return "an older function was given the owner line";
    try { return load("src/plant/pump.js").stopPump(3) === "stopped 3" ? "" : "stopPump returns the wrong thing"; }
    catch (e) { return "doesn't run: " + /** @type {any} */ (e).message; }
  },
});

SCENARIOS.push({
  name: "folder-rules-new-file",
  about: "a new file in a subfolder with its own AGENTS.md, written without reading anything there: the rules come first",
  setup: (w) => {
    w("src/plant/AGENTS.md", PLANT_RULES);
    w("src/plant/pump.js", PUMP);
  },
  task: "Create src/plant/valve.js with a function openValve(id) that returns \"open \" + id, exported with module.exports.",
  check: ({ read, load }) => {
    let text;
    try { text = read("src/plant/valve.js"); } catch { return "no src/plant/valve.js"; }
    if (!owned(text, "openValve")) return "openValve has no `// Owner: plant-ops` line above it";
    // Exported by name or as the module itself: the task says only "exported with module.exports".
    try { const made = load("src/plant/valve.js"); return (typeof made === "function" ? made : made.openValve)(2) === "open 2" ? "" : "openValve returns the wrong thing"; }
    catch (e) { return "doesn't run: " + /** @type {any} */ (e).message; }
  },
});

// ---------------------------------------------------------------- a big script with no language support --
// VS Code often has no PowerShell support installed: Solder's outline by the text has to stand in, so the model finds
// the one function it needs without reading 1,500 lines (resent with every later step).

const BIG_FUNCTIONS = ["Get-ServerList", "Test-ServerOnline", "Get-ServiceState", "Restart-StoppedService", "Get-EventSummary",
  "Clear-TempFolder", "Get-PatchLevel", "Test-PendingReboot", "Get-ScheduledTaskState", "Export-InventoryCsv", "Get-CertificateExpiry",
  "Test-BackupAge", "Get-ShareUsage", "Get-LocalAdmins", "Test-TimeSync", "Get-NetworkAdapterState", "Get-FreeSpacePercent",
  "Get-PrinterQueue", "Test-DnsRecord", "Get-IisSiteState", "Get-SqlServiceState", "Write-MaintenanceLog", "Send-MaintenanceMail",
  "Get-UptimeReport", "Invoke-NightlyMaintenance"];
const FREE_SPACE = [
  "function Get-FreeSpacePercent {",
  "    param(",
  "        [Parameter(Mandatory)][string]$ComputerName,",
  "        [string]$Drive = 'C:'",
  "    )",
  "    $disk = Get-CimInstance -ClassName Win32_LogicalDisk -ComputerName $ComputerName -Filter \"DeviceID = '$Drive'\"",
  "    if (-not $disk -or -not $disk.Size) { return $null }",
  "    # The share of the drive that is still free, in percent.",
  "    $percent = ($disk.Size - $disk.FreeSpace) / $disk.Size * 100",
  "    [math]::Round($percent, 1)",
  "}",
];
/** A plain function of about 58 lines: steps that each work something out, with strings, hashtables and a here-string. @param {string} name @param {number} k */
const bigFunction = (name, k) => {
  const lines = [
    `function ${name} {`,
    "    [CmdletBinding()]",
    "    param(",
    "        [Parameter(Mandatory)][string]$ComputerName,",
    `        [int]$TimeoutSeconds = ${20 + k}`,
    "    )",
    `    Write-Verbose "${name}: starting on $ComputerName"`,
    `    $result = [ordered]@{ Name = '${name}'; Computer = $ComputerName; Started = Get-Date }`,
  ];
  for (let step = 1; step <= 8; step++) {
    lines.push(`    # Step ${step}: part ${step} of what ${name} reports`,
      `    $part${step} = @{ Step = ${step}; Value = ($TimeoutSeconds * ${step + k}) % 7 }`,
      `    if ($part${step}.Value -gt 3) {`,
      `        Write-Verbose "step ${step} is high: $($part${step}.Value) {of 7}"`,
      "    }",
      `    $result['Step${step}'] = $part${step}.Value`);
  }
  if (k % 5 === 0) lines.push("    $note = @\"", `${name} finished on $ComputerName.`, "Steps: $($result.Keys -join ', ')", "\"@", "    Write-Verbose $note");
  lines.push("    [pscustomobject]$result", "}", "");
  return lines;
};
const MAINTENANCE = crlf([
  "# Nightly maintenance for the servers in servers.txt. Run as a scheduled task.",
  "#Requires -Version 5.1",
  "",
  ...BIG_FUNCTIONS.flatMap((name, k) => name === "Get-FreeSpacePercent" ? [...FREE_SPACE, ""] : bigFunction(name, k)),
  "Invoke-NightlyMaintenance -ComputerName $env:COMPUTERNAME -Verbose",
]);

SCENARIOS.push({
  name: "ps-big",
  about: "a one-line fix in a 1,500-line PowerShell script with 25 functions and no language support: found by the outline or a search, not read whole",
  setup: (w) => w("Scripts/Maintenance.ps1", MAINTENANCE),
  task: "In Scripts/Maintenance.ps1, Get-FreeSpacePercent reports the used space instead of the free space: a drive with 10 GB free of 100 GB gives 90 instead of 10. Fix it.",
  check: ({ read, ws }) => {
    const text = read("Scripts/Maintenance.ps1");
    const before = MAINTENANCE.split("\r\n");
    const at = before.indexOf(FREE_SPACE[0]);
    const after = text.split("\r\n");
    const start = after.indexOf(FREE_SPACE[0]);
    if (start < 0) return "Get-FreeSpacePercent is gone";
    const end = after.indexOf("}", start);
    const body = after.slice(start, end + 1).join("\n");
    if (/\$disk\.Size\s*-\s*\$disk\.FreeSpace/.test(body) || !/\$disk\.FreeSpace\s*\/\s*\$disk\.Size|\$disk\.FreeSpace\s*\*\s*100\s*\/\s*\$disk\.Size/.test(body)) return "not fixed: " + body.replace(/\s+/g, " ").slice(0, 200);
    // Everything around the function as it was.
    if (after.slice(0, start).join("\n") !== before.slice(0, at).join("\n")) return "changed lines before Get-FreeSpacePercent";
    if (after.slice(end + 1).join("\n") !== before.slice(at + FREE_SPACE.length).join("\n")) return "changed lines after Get-FreeSpacePercent";
    const lines = before.length - 1;
    for (const call of ws.calls.filter((/** @type {any} */ c) => c.name === "read_file" && /Maintenance\.ps1$/i.test(String(c.args.path || "")))) {
      const from = Number(call.args.start_line) || 1;
      const to = Math.min(lines, Number(call.args.end_line) || from + 1999);
      if (to - from + 1 > 300) return `read ${to - from + 1} lines of the script at once (${from}–${to})`;
    }
    return endings(text, "Maintenance.ps1");
  },
});

// ---------------------------------------------------------------- wide work: many files in one task --
// How much a model does in one reply: a rename across 25 files, and a question that needs 16 files read.

const STATIONS = Array.from({ length: 24 }, (_, i) => `station${String(i + 1).padStart(2, "0")}`);

SCENARIOS.push({
  name: "wide-rename",
  about: "a function used in 24 files plus its own: renamed everywhere, in as few steps as the model can manage",
  setup: (w) => {
    w("src/lib/money.js", "function formatPrice(cents) {\n  return \"$\" + (cents / 100).toFixed(2);\n}\n\nmodule.exports = { formatPrice };\n");
    STATIONS.forEach((name, i) => w(`src/stations/${name}.js`, `const { formatPrice } = require("../lib/money");\n\n// Station ${i + 1}: its fee, shown to the operator.\nfunction fee() {\n  return formatPrice(${(i + 1) * 125});\n}\n\nmodule.exports = { fee };\n`));
  },
  task: "Rename formatPrice to formatMoney everywhere under src: the function itself and every place that uses it.",
  check: ({ read, load }) => {
    const all = ["src/lib/money.js", ...STATIONS.map((name) => `src/stations/${name}.js`)].map((name) => read(name)).join("\n");
    if (/formatPrice/.test(all)) return "formatPrice is still there";
    try {
      if (typeof load("src/lib/money.js").formatMoney !== "function") return "money.js doesn't export formatMoney";
      for (const [i, name] of STATIONS.entries()) if (load(`src/stations/${name}.js`).fee() !== "$" + ((i + 1) * 1.25).toFixed(2)) return `${name}.fee() is wrong`;
    } catch (e) { return "doesn't run: " + /** @type {any} */ (e).message; }
    return "";
  },
});

const RATES = Array.from({ length: 16 }, (_, i) => {
  // Four of them go below zero for an input of 0: each in its own way, so a search for one pattern can't find them all.
  const bad = { 2: "return (x - 3) * 0.5;", 7: "return x > 0 ? x * 2 : -1;", 11: "const base = 10;\n  return base - (x + 12);", 14: "return Math.min(x, 1) - 2;" }[i];
  return [`src/rates/rate${String(i + 1).padStart(2, "0")}.js`, `// Rate ${i + 1} for the billing engine.\nfunction rate(x) {\n  ${bad ?? `return x * ${(i % 5) + 1} + ${i};`}\n}\n\nmodule.exports = { rate };\n`];
});

SCENARIOS.push({
  name: "wide-read",
  about: "a question that needs 16 small files read: answered right, in as few steps as reads at once allow",
  setup: (w) => { for (const [name, text] of RATES) w(name, text); },
  task: "Each file in src/rates exports a rate(x) function. Which of them return a negative number for rate(0)? List the file names. Work it out from the code; don't change anything.",
  check: ({ answer }) => {
    const want = ["rate03", "rate08", "rate12", "rate15"];
    const missing = want.filter((name) => !answer.includes(name));
    if (missing.length) return "missed " + missing.join(", ") + ": " + answer.slice(0, 160);
    const wrong = RATES.map(([name]) => /rate\d\d/.exec(name)?.[0] || "").filter((name) => !want.includes(name) && answer.includes(name));
    return wrong.length ? "also named " + wrong.join(", ") : "";
  },
});

// ---------------------------------------------------------------- a long session: earlier reads trimmed --
// Six turns over six large files (about 9k tokens each): past about 40k tokens of earlier tasks' results, the oldest
// are cut to stand-ins. The later turns need what the early ones read, so a cut either costs a re-read or a wrong edit.

const SESSION = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"].map((name, i) => {
  const lines = [`// The ${name} service: ${["billing", "shipping", "audit", "search", "mail", "reports"][i]}.`,
    `const RATE_LIMIT = ${(i + 2) * 7};`, `const TIMEOUT_MS = ${[4500, 1200, 9800, 3100, 7700, 2600][i]};`, `const REGION = "${["north", "south", "east", "west", "central", "coast"][i]}";`, ""];
  for (let f = 0; f < 140; f++) {
    lines.push(`/** Step ${f} of the ${name} pipeline: scales and clamps a reading. */`,
      `function step${f}(value, options = {}) {`, `  const scaled = value * ${(f % 9) + 1} + ${f};`,
      `  const limit = options.limit ?? RATE_LIMIT * ${(f % 4) + 1};`, `  return Math.min(scaled, limit) / ${(f % 3) + 1};`, `}`, "");
  }
  lines.push(`module.exports = { RATE_LIMIT, TIMEOUT_MS, REGION, ${Array.from({ length: 140 }, (_, f) => `step${f}`).join(", ")} };`, "");
  return [`src/${name}.js`, lines.join("\n")];
});

SCENARIOS.push({
  name: "long-session",
  about: "six turns over six large files: later turns need what earlier ones read, after those reads may have been cut",
  setup: (w) => { for (const [name, text] of SESSION) w(name, text); },
  task: "Read src/alpha.js and src/bravo.js in full, and tell me the RATE_LIMIT and TIMEOUT_MS of each.",
  then: [
    "Now read src/charlie.js and src/delta.js in full: their RATE_LIMIT and TIMEOUT_MS?",
    "And src/echo.js and src/foxtrot.js in full: their RATE_LIMIT and TIMEOUT_MS?",
    "In src/alpha.js, double RATE_LIMIT.",
    "Of the six services, which has the largest TIMEOUT_MS, and which the smallest? Answer from what you already know.",
    "In src/bravo.js, add an exported function describe() that returns \"bravo in \" + REGION, written in the same style as the file's other functions (with a /** */ comment above it).",
  ],
  check: ({ answer, read, load }) => {
    try {
      if (load("src/alpha.js").RATE_LIMIT !== 28) return "alpha's RATE_LIMIT isn't doubled to 28";
      if (load("src/bravo.js").describe?.() !== "bravo in south") return "bravo.describe() is missing or wrong";
    } catch (e) { return "doesn't run: " + /** @type {any} */ (e).message; }
    if (!/\/\*\*[^]*?\*\/\s*function describe/.test(read("src/bravo.js"))) return "describe() has no /** */ comment above it";
    return "";
  },
});

module.exports = { SCENARIOS };
