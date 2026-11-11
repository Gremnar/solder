#!/usr/bin/env node
// @ts-check
"use strict";
/**
 * Solder checked inside a real VS Code: each file beside this one (skills.js, policy.js, ...) runs in VS Code's
 * extension host with the extension loaded from this repo, against a throwaway workspace, profile and home folder.
 *
 *   node check/run.js [name ...] [--keep]
 *
 * VS Code is found at SOLDER_VSCODE (the path to Code.exe, or `code` elsewhere), else where the Windows installer
 * puts it. Nothing here is part of the extension: it isn't packaged. See check/README.md.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const REPO = path.resolve(__dirname, "..");
const ALL = ["policy", "edits", "group1", "problems", "symbols", "skills"];
const TIMEOUT_MS = 240_000;

/** The files a few checks expect in the workspace. */
const FIXTURES = {
  "notes.md": "# Notes\nA plain Markdown file.\n",
  "bad.ts": "const total: number = \"not a number\";\nexport {};\n",
  "clean.ts": "export const total: number = 4;\n",
  "calc.ts": "export function total(items: number[]): number {\n    let sum = missing;\n    for (const item of items) {\n        if (item > 0) {\n            sum += item;\n        }\n    }\n    return sum;\n}\n",
  "core.ps1": ". \"$PSScriptRoot\\mod-bad.ps1\"\n. \"$PSScriptRoot\\mod-clean.ps1\"\nWrite-Output (Get-Thing)\n",
  "mod-bad.ps1": "function Get-Broken {\n    if ($true {\n        \"x\"\n    }\n}\n",
  "mod-clean.ps1": "function Get-Thing {\n    return \"ok\"\n}\n",
  "plain.xyz": "some text\n",
};

function findCode() {
  const given = process.env.SOLDER_VSCODE;
  if (given) return given;
  const places = [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Microsoft VS Code", "Code.exe")].filter(Boolean);
  return places.find((place) => fs.existsSync(String(place))) || "";
}

/** One check, in its own VS Code. @param {string} code @param {string} dir @param {string} name @returns {Promise<{pass: number, fail: string[], problem: string}>} */
function runOne(code, dir, name) {
  const log = path.join(dir, `${name}.log`);
  fs.rmSync(log, { force: true });
  const env = { ...process.env, SOLDER_CHECK_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve) => {
    let errors = "";
    const child = spawn(code, [`--extensionDevelopmentPath=${REPO}`, `--extensionTestsPath=${path.join(__dirname, name + ".js")}`,
      `--user-data-dir=${path.join(dir, "ud")}`, `--extensions-dir=${path.join(dir, "ext")}`, "--disable-workspace-trust", "--skip-welcome",
      "--skip-release-notes", path.join(dir, "ws")], { env, windowsHide: true });
    child.stderr.on("data", (chunk) => { if (errors.length < 20_000) errors += chunk; });
    child.stdout.on("data", () => {});
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    const done = (/** @type {string} */ problem) => {
      clearTimeout(timer);
      const lines = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split(/\r?\n/) : [];
      const fail = lines.filter((line) => /^(FAIL|!!!)/.test(line));
      const ended = lines.some((line) => line.startsWith("=== end"));
      resolve({ pass: lines.filter((line) => line.startsWith("PASS")).length, fail,
        problem: problem || (!lines.length ? "it never started: " + (errors.trim().split(/\r?\n/).slice(-3).join(" | ") || "no output") : !ended ? "it didn't finish" : "") });
    };
    child.on("error", (error) => done(`VS Code couldn't be started (${error.message})`));
    child.on("exit", () => done(""));
  });
}

(async () => {
  const args = process.argv.slice(2);
  const keep = args.includes("--keep");
  const names = args.filter((arg) => !arg.startsWith("--"));
  const chosen = names.length ? names : ALL;
  const unknown = chosen.filter((name) => !ALL.includes(name));
  if (unknown.length) { console.error(`No check called ${unknown.join(", ")}. There are: ${ALL.join(", ")}.`); process.exit(2); }
  const code = findCode();
  if (!code) { console.error("VS Code wasn't found. Set SOLDER_VSCODE to its program (Code.exe)."); process.exit(2); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solder-check-"));
  fs.mkdirSync(path.join(dir, "ws"), { recursive: true });
  for (const [name, text] of Object.entries(FIXTURES)) fs.writeFileSync(path.join(dir, "ws", name), text);
  console.log(`Solder in a real VS Code · ${chosen.length} check${chosen.length === 1 ? "" : "s"} · ${code}`);
  let failed = 0;
  let passed = 0;
  for (const name of chosen) {
    const result = await runOne(code, dir, name);
    passed += result.pass;
    const bad = result.fail.length + (result.problem ? 1 : 0);
    failed += bad;
    console.log(`${bad ? "FAIL" : "pass"}  ${name.padEnd(9)} ${String(result.pass).padStart(3)} passed${result.fail.length ? `, ${result.fail.length} failed` : ""}${result.problem ? ` · ${result.problem}` : ""}`);
    for (const line of result.fail) console.log("      " + line.slice(0, 400));
  }
  console.log(`\n${passed} passed, ${failed} failed` + (keep || failed ? ` · logs in ${dir}` : ""));
  if (!keep && !failed) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  process.exit(failed ? 1 : 0);
})();
