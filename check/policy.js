// @ts-nocheck
"use strict";
// One of Solder's checks inside a real VS Code: run with `node check/run.js policy` (see check/README.md).
// Runs inside a real VS Code extension host: Solder activates with its policy read (real reg.exe), and a policy in
// force is what settings see, with locked settings left as they were.
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
// The repo this file is in, and the throwaway folder check/run.js made for this run.
const REPO = path.resolve(__dirname, "..");
const T = process.env.SOLDER_CHECK_DIR || path.join(require("node:os").tmpdir(), "solder-check");
const LOG = path.join(T, "policy.log");
const log = (...a) => fs.appendFileSync(LOG, a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ") + "\n");
const check = (name, ok, detail = "") => log(ok ? "PASS" : "FAIL", name, detail);

exports.run = async function () {
  fs.writeFileSync(LOG, `=== policy ${new Date().toISOString()}\n`);
  try { await main(); } catch (e) { log("!!! harness", String(e && e.stack || e)); }
  log("=== end");
};

async function main() {
  const ext = vscode.extensions.getExtension("gremnar.solder");
  const began = Date.now();
  await ext.activate();
  check("activates (with the policy read first)", ext.isActive, `${Date.now() - began} ms`);
  const { policy } = require(path.join(REPO, "src", "policy.js"));
  const { config } = require(path.join(REPO, "src", "config.js"));
  check("no policy on this PC, and no error", policy.error === "" && policy.names.length === 0, JSON.stringify({ error: policy.error, names: policy.names }));
  const user = vscode.workspace.getConfiguration("solder");
  await user.update("maxRounds", 40, vscode.ConfigurationTarget.Global);
  // A policy in force (as if read from the registry).
  policy.apply(new Map([["endpoint", "https://gw.example.com/v1/chat/completions"], ["maxrounds", 12], ["orgrules", "Comment in English."]]), "");
  check("enforced values are what Solder reads", config().get("endpoint", "") === "https://gw.example.com/v1/chat/completions" && config().get("maxRounds", 30) === 12);
  await config().update("maxRounds", 77, vscode.ConfigurationTarget.Global);
  check("a locked setting isn't written", vscode.workspace.getConfiguration("solder").get("maxRounds") === 40, String(vscode.workspace.getConfiguration("solder").get("maxRounds")));
  check("the user's own value is still there underneath", config().own("maxRounds", 30) === 40);
  await config().update("effort", "high", vscode.ConfigurationTarget.Global);
  check("an unlocked one is", vscode.workspace.getConfiguration("solder").get("effort") === "high");
  await user.update("maxRounds", undefined, vscode.ConfigurationTarget.Global);
  await user.update("effort", undefined, vscode.ConfigurationTarget.Global);
  policy.apply(new Map(), "");
}
