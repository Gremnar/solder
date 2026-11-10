// @ts-check
"use strict";
/**
 * Two kinds of model behind one gateway, told apart by the solder.toolModels pattern (a setting, so no model names
 * live in this repo):
 * - Tool lane: models whose id matches. A system message, native tool calls, the whole chat every request.
 * - Assist lane: every other model. Plain user and assistant text only (no system message, no tools), tool requests
 *   written in the reply, and the gateway holds the conversation behind a session.
 * With the pattern empty, every model is a Tool model: today's behaviour. No vscode here: tested under node.
 */

/**
 * @param {string} model @param {{toolModels?: string}} settings
 * @returns {"tool" | "assist"}
 */
function laneOf(model, settings) {
  const pattern = String(settings.toolModels || "").trim();
  if (!pattern) return "tool";
  try { return new RegExp(pattern, "i").test(String(model || "")) ? "tool" : "assist"; }
  catch { return "tool"; } // a broken pattern changes nothing
}

/**
 * A Tool model's Assist twin: its id with the toolModels match taken out, if that's a model on offer ("" when
 * there's none). Used to offer the switch when the Tool models' allowance runs out.
 * @param {string} model @param {{toolModels?: string}} settings @param {string[]} offered the ids the gateway lists
 */
function assistTwin(model, settings, offered) {
  const pattern = String(settings.toolModels || "").trim();
  if (!pattern || laneOf(model, settings) !== "tool") return "";
  let twin = "";
  try { twin = String(model).replace(new RegExp(pattern, "i"), ""); } catch { return ""; }
  return twin && twin !== model && offered.includes(twin) && laneOf(twin, settings) === "assist" ? twin : "";
}

module.exports = { laneOf, assistTwin };
