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
  about: "a one-line fix: done directly, no plan, no question",
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

// ---------------------------------------------------------------- longer tasks (plans) --

SCENARIOS.push({
  name: "five-files",
  about: "five small changes in five files: a plan, every step done, no early stop",
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
    "anything that isn't a letter or digit dropped); and sum(list) to src/list.js. Make a plan first, one step per file, and do one step at a time.",
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
  about: "a planned task that runs into a small step limit: it pauses, and after Resume it carries on (no 'still blocked' answer)",
  maxRounds: 4,
  resumes: 3,
  setup: (w) => {
    w("src/math.js", "\"use strict\";\nfunction double(n) {\n  return n * 2;\n}\nmodule.exports = { double };\n");
    w("src/text.js", "\"use strict\";\nfunction shout(text) {\n  return String(text).toUpperCase() + \"!\";\n}\nmodule.exports = { shout };\n");
    w("src/list.js", "\"use strict\";\nfunction first(list) {\n  return list[0];\n}\nmodule.exports = { first };\n");
  },
  task: "Add three functions, each exported: clamp(n, lo, hi) to src/math.js; slugify(text) to src/text.js (lowercase words joined by -, " +
    "anything that isn't a letter or digit dropped); and sum(list) to src/list.js. Make a plan first, one step per file, and do one step at a time.",
  check: ({ chat, load }) => {
    if (!chat.messages.some((/** @type {any} */ m) => m.meta?.typed === "Carry on")) return "it never paused at the limit (the test needs a smaller limit)";
    // After each Resume, the model's next reply acts (calls a tool) or finishes: it doesn't claim it's still blocked.
    const replies = chat.messages.map((/** @type {any} */ m, /** @type {number} */ i) => [m, chat.messages[i + 1]]).filter(([m]) => m.meta?.typed === "Carry on").map(([, next]) => next);
    const stuck = replies.find((/** @type {any} */ m) => m && !m.tool_calls?.length && /reject|blocked|limit|allowance|new chat/i.test(m.content || ""));
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

module.exports = { SCENARIOS };
