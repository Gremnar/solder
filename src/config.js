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

/** What's shown when your organization's model filter won't read: no model is offered, or sent to. */
const MODEL_FILTER_BROKEN = "Your organization's model filter isn't a valid pattern, so no model can be offered. Ask your IT team.";

/**
 * Which models a request may use: any, unless your organization enforces a model filter, when only those it matches
 * (none, if the filter won't read). null when there's no such rule.
 * @returns {((id: string) => boolean) | null}
 */
function modelAllowed() {
  if (!policy.locked("modelFilter")) return null;
  const filter = String(config().get("modelFilter", "") || "");
  if (!filter) return null;
  try { const pattern = new RegExp(filter, "i"); return (id) => pattern.test(id); } catch { return () => false; }
}

module.exports = { config, policy, readOnly, allowChanges, modelAllowed, MODEL_FILTER_BROKEN };
