// @ts-check
"use strict";
/**
 * Solder's settings as they apply: VS Code's (user scope), with the organisation's policy over them (policy.js).
 * Everything reads settings through here, never vscode.workspace.getConfiguration("solder") directly.
 */
const vscode = require("vscode");
const { policy } = require("./policy.js");

function config() {
  return policy.wrap(vscode.workspace.getConfiguration("solder"));
}

/**
 * Whether Solder is in read-only mode: it looks, but the tools that change files are neither offered nor run. It's
 * how Solder starts (the setting's default); you turn changes on once (the guided setup, the panel's Enable tools,
 * or Settings), and nothing turns them off again but you, or your organization's ReadOnly policy (a number: 0 or 1).
 */
function readOnly() {
  const value = config().get("readOnly", true);
  return typeof value === "number" ? value !== 0 : value !== false;
}

/** Turns changes on (read-only mode off), unless the organization sets it. @returns {Promise<boolean>} whether it could */
async function allowChanges() {
  if (policy.locked("readOnly")) return false;
  await config().update("readOnly", false, vscode.ConfigurationTarget.Global);
  return true;
}

module.exports = { config, policy, readOnly, allowChanges };
