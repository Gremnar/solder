// @ts-check
"use strict";
/**
 * The live scenarios. Each sets up a small workspace, gives a task, and checks the result on disk (not just the
 * answer). `hooks` change things under the model (a file edited after it read it) to test recovery.
 * @typedef {{name: string, about: string, heavy?: boolean, setup: (write: (p: string, t: string) => void) => void, task: string,
 *   hooks?: any, check: (r: {ws: any, chat: any, answer: string, read: (p: string) => string, load: (p: string) => any}) => string}} Scenario
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

module.exports = { SCENARIOS };
