#!/usr/bin/env node
// @ts-check
"use strict";
/**
 * Solder's live test suite: real models, through any OpenAI-compatible endpoint (a local proxy, say), on throwaway
 * workspaces. Each scenario runs N times; the table shows how often it passed and what it cost, beside a baseline.
 *
 *   node live/run.js --model <id> [--endpoint <url>] [--runs 3] [--only a,b] [--skip bugs12] [--parallel 4]
 *                    [--src <a copy of Solder's src>] [--label name] [--baseline label] [--effort low]
 *                    [--tool-models <regex>] [--assist-block <name>]   (the Assist lane: see live/README.md)
 *
 * The key comes from SOLDER_LIVE_KEY (or "test"). Results go to live/results/<label>.jsonl (not in git).
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { solder, workspaceHost } = require("./host.js");
const { SCENARIOS } = require("./scenarios.js");

const argv = process.argv.slice(2);
const opt = (/** @type {string} */ name, /** @type {string} */ fallback = "") => {
  const at = argv.indexOf("--" + name);
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
};
const model = opt("model");
if (!model) { console.error("Give --model <id>."); process.exit(2); }
const endpoint = opt("endpoint", process.env.SOLDER_LIVE_ENDPOINT || "http://127.0.0.1:8789/v1/chat/completions");
const runs = Number(opt("runs", "3"));
const parallel = Number(opt("parallel", "4"));
const src = path.resolve(opt("src", path.join(__dirname, "..", "src")));
const effort = opt("effort", "low");
// The Assist lane: --tool-models is the pattern for Tool models (the model under test is Assist when it doesn't match),
// --assist-block the session block's name (empty: every Assist request carries the conversation over).
const toolModels = opt("tool-models", "");
const assistBlock = opt("assist-block", "");
const label = opt("label", `run-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`);
const baseline = opt("baseline");
const only = opt("only") ? opt("only").split(",") : null;
const skip = opt("skip") ? opt("skip").split(",") : [];
const resultsDir = path.join(__dirname, "results");
fs.mkdirSync(resultsDir, { recursive: true });
const resultsFile = path.join(resultsDir, `${label}.jsonl`);

const S = solder(src);
const chosen = SCENARIOS.filter((s) => (only ? only.includes(s.name) : true) && !skip.includes(s.name));
if (!chosen.length) { console.error("No scenarios match."); process.exit(2); }

/** A module in the workspace, fresh each time (its own requires too), with some requires stood in for. */
function loader(/** @type {string} */ root) {
  return (/** @type {string} */ rel, /** @type {Record<string, any>} */ mocks = {}) => {
    for (const key of Object.keys(require.cache)) if (key.startsWith(root)) delete require.cache[key];
    const load = /** @type {any} */ (Module)._load;
    /** @type {any} */ (Module)._load = function (/** @type {string} */ request, /** @type {any} */ parent, /** @type {any[]} */ ...rest) {
      if (Object.hasOwn(mocks, request) && parent?.filename?.startsWith(root)) return mocks[request];
      return load.call(this, request, parent, ...rest);
    };
    try { return require(path.join(root, rel)); } finally { /** @type {any} */ (Module)._load = load; }
  };
}

/** One run of one scenario. @param {any} scenario @param {number} run */
async function once(scenario, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `solder-live-${scenario.name}-`));
  const write = (/** @type {string} */ p, /** @type {string} */ t) => { const f = path.join(root, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
  scenario.setup(write);
  // A scenario's skills go in a folder beside the workspace (outside it, as a user's would be).
  let skillsFolder = "";
  if (scenario.skills) { // {} gives an empty skills folder: nothing offered, but somewhere to save one
    if (!S.skills) throw new Error("this src has no skills");
    skillsFolder = root + "-skills";
    fs.mkdirSync(skillsFolder, { recursive: true });
    for (const [name, text] of Object.entries(scenario.skills)) fs.writeFileSync(path.join(skillsFolder, name + ".md"), String(text));
  }
  const { ws, host } = workspaceHost(root, S, typeof scenario.hooks === "function" ? scenario.hooks() : (scenario.hooks || {}), skillsFolder);
  const client = new S.GatewayClient({ endpoint, apiKey: process.env.SOLDER_LIVE_KEY || "test" });
  let requests = 0;
  const reply = client.reply.bind(client);
  // The task's own requests (with tools): not the chat's title, which goes out on its own afterwards.
  client.reply = async (/** @type {any} */ req) => {
    if (!String(req.messages?.at(-1)?.content || "").startsWith("Give a short title")) requests++;
    return reply(req);
  };
  const engine = new S.Engine({ client, host, settings: () => ({ model, effort, compactAt: 100_000, maxRounds: 40, toolModels, assistSessionBlock: assistBlock }), onEvent: () => {} });
  const chat = S.Engine.newChat();
  const started = Date.now();
  let error = "";
  // A scenario's task, then any follow-up messages in the same chat (`then`). Each is a text, or a function of Solder's own
  // texts (a slash command's message, as the panel would send it).
  const texts = [scenario.task, ...(scenario.then || [])].map((/** @type {any} */ item) => typeof item === "function" ? item(S.prompt) : item);
  try { for (const text of texts) await engine.ask(chat, text); } catch (e) { error = /** @type {any} */ (e)?.message || String(e); }
  const answer = [...chat.messages].reverse().find((/** @type {any} */ m) => m.role === "assistant" && (m.content || "").trim())?.content || "";
  let why;
  try {
    why = await scenario.check({ ws, chat, answer, read: (/** @type {string} */ p) => fs.readFileSync(path.join(root, p), "utf8"), load: loader(root), skillsFolder });
  } catch (e) { why = "check failed: " + /** @type {any} */ (e)?.message; }
  if (error) why = "error: " + error;
  const replies = chat.messages.filter((/** @type {any} */ m) => m.role === "assistant");
  const withCalls = replies.filter((/** @type {any} */ m) => m.tool_calls?.length);
  const plan = /** @type {any} */ (chat).plan;
  const row = {
    label, model, scenario: scenario.name, run, ok: !why, why: why || "",
    tokens: chat.usage.tokens + (chat.usage.assistTokens || 0), requests, minutes: +((Date.now() - started) / 60000).toFixed(2),
    calls: ws.calls.length, failed: ws.calls.filter((/** @type {any} */ c) => c.failed).length, edits: ws.edits,
    failedCalls: ws.calls.filter((/** @type {any} */ c) => c.failed).map((/** @type {any} */ c) => `${c.name}(${c.args.path || c.args.glob || c.args.query || c.args.name || ""})`),
    reads: ws.calls.filter((/** @type {any} */ c) => c.name === "read_file").length,
    chatter: withCalls.filter((/** @type {any} */ m) => (m.content || "").trim()).length,
    maxReads: Math.max(0, ...withCalls.map((/** @type {any} */ m) => m.tool_calls.filter((/** @type {any} */ c) => c.function.name === "read_file").length)),
    planned: !!plan, planLeft: plan ? plan.steps.filter((/** @type {any} */ s) => s.state !== "done").length : 0,
    nudges: chat.messages.filter((/** @type {any} */ m) => m.meta?.nudge).length,
    skillsRead: skillsFolder ? ws.calls.filter((/** @type {any} */ c) => c.name === "read_file" && path.resolve(root, String(c.args.path || "")).startsWith(skillsFolder))
      .map((/** @type {any} */ c) => path.basename(String(c.args.path), ".md")) : undefined,
    answer: answer.replace(/\s+/g, " ").slice(0, 300),
    // What an Assist model really wrote, when a run fails (its tool blocks included).
    raw: why ? chat.messages.filter((/** @type {any} */ m) => m.meta?.raw).slice(-4).map((/** @type {any} */ m) => String(m.meta.raw).slice(0, 700)) : undefined,
  };
  fs.appendFileSync(resultsFile, JSON.stringify(row) + "\n");
  fs.rmSync(root, { recursive: true, force: true });
  if (skillsFolder) fs.rmSync(skillsFolder, { recursive: true, force: true });
  console.log(`${row.ok ? "pass" : "FAIL"}  ${scenario.name.padEnd(18)} #${run}  ${(row.tokens / 1000).toFixed(0).padStart(5)}k tok  ${String(requests).padStart(3)} req` +
    (row.nudges ? `  nudged ${row.nudges}` : "") + (row.skillsRead ? `  skills read: ${row.skillsRead.join(",") || "none"}` : "") + (row.why ? `  — ${row.why}` : ""));
  return row;
}

/** The table: per scenario, passes and the means, beside the baseline's. @param {any[]} rows @param {any[]} base */
function table(rows, base) {
  const by = (/** @type {any[]} */ list, /** @type {string} */ name) => list.filter((r) => r.scenario === name);
  const mean = (/** @type {any[]} */ list, /** @type {string} */ key) => list.length ? list.reduce((s, r) => s + r[key], 0) / list.length : NaN;
  const k = (/** @type {number} */ n) => Number.isNaN(n) ? "    -" : (n / 1000).toFixed(0).padStart(5) + "k";
  const lines = [`\n${"scenario".padEnd(18)} ${"pass".padStart(7)} ${"tokens".padStart(7)} ${"req".padStart(5)} ${"fail".padStart(5)} ${"nudge".padStart(5)}` + (base.length ? `   | base pass  tokens   req` : "")];
  let total = 0;
  for (const scenario of chosen) {
    const mine = by(rows, scenario.name);
    const theirs = by(base, scenario.name);
    total += mine.reduce((s, r) => s + r.tokens, 0);
    lines.push(`${scenario.name.padEnd(18)} ${(mine.filter((r) => r.ok).length + "/" + mine.length).padStart(7)} ${k(mean(mine, "tokens"))} ${mean(mine, "requests").toFixed(1).padStart(5)} ${mean(mine, "failed").toFixed(1).padStart(5)} ${mean(mine, "nudges").toFixed(1).padStart(5)}` +
      (theirs.length ? `   | ${(theirs.filter((r) => r.ok).length + "/" + theirs.length).padStart(9)} ${k(mean(theirs, "tokens"))} ${mean(theirs, "requests").toFixed(1).padStart(5)}` : ""));
  }
  const passed = rows.filter((r) => r.ok).length;
  lines.push(`\n${passed}/${rows.length} passed · ${(total / 1e6).toFixed(2)}M tokens · results in ${path.relative(process.cwd(), resultsFile)}`);
  return lines.join("\n");
}

// Code a model wrote can throw later, from a callback, while a check runs it: that's a failed run, not a crashed suite.
process.on("uncaughtException", (error) => { console.log(`(a model's code threw outside its check: ${error && error.message})`); });

(async () => {
  console.log(`Solder live suite · model ${model} · ${chosen.length} scenarios × ${runs} · src ${src} · label ${label}`);
  const jobs = [];
  for (let run = 1; run <= runs; run++) for (const scenario of chosen) jobs.push({ scenario, run });
  // The heavy ones first, so they overlap the rest.
  jobs.sort((a, b) => (b.scenario.heavy ? 1 : 0) - (a.scenario.heavy ? 1 : 0));
  /** @type {any[]} */
  const rows = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, parallel) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try { rows.push(await once(job.scenario, job.run)); }
      catch (e) { console.log(`FAIL  ${job.scenario.name} #${job.run}  — harness: ${/** @type {any} */ (e)?.message}`); }
    }
  }));
  const baseFile = baseline ? path.join(resultsDir, `${baseline}.jsonl`) : "";
  const base = baseFile && fs.existsSync(baseFile) ? fs.readFileSync(baseFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.model === model) : [];
  console.log(table(rows, base));
})();
