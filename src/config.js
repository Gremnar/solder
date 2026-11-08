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

module.exports = { config, policy };
