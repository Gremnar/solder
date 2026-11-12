// @ts-check
"use strict";
/**
 * Two kinds of model behind one gateway (no model names live in this repo: they're settings):
 * - Tool lane: a system message, native tool calls, the whole chat every request.
 * - Assist lane: plain user and assistant text only (no system message, no tools), tool requests written in the
 *   reply, and the gateway holds the conversation behind a session.
 * Which is which: the solder.assistModels list when there is one (picked in Settings, or set by policy), else the
 * solder.toolModels pattern (models whose id matches are Tool models). With neither, every model is a Tool model.
 * No vscode here: tested under node.
 */

/** @typedef {{toolModels?: string, assistModels?: string[]}} LaneSettings */

/** The Assist models listed by name, lower-cased ([] when there's no list). @param {LaneSettings} settings */
function listed(settings) {
  return (Array.isArray(settings.assistModels) ? settings.assistModels : []).map((id) => String(id).trim().toLowerCase()).filter(Boolean);
}

/**
 * @param {string} model @param {LaneSettings} settings
 * @returns {"tool" | "assist"}
 */
function laneOf(model, settings) {
  const list = listed(settings);
  if (list.length) return list.includes(String(model || "").toLowerCase()) ? "assist" : "tool";
  const pattern = String(settings.toolModels || "").trim();
  if (!pattern) return "tool";
  try { return new RegExp(pattern, "i").test(String(model || "")) ? "tool" : "assist"; }
  catch { return "tool"; } // a broken pattern changes nothing
}

/**
 * A Tool model's Assist twin ("" when there's none), used to offer the switch when the Tool models' allowance runs out.
 * With a list: the Assist model on offer whose id the Tool model's starts with (the longest, so model-a-tools finds
 * model-a). With a pattern: the id with the pattern's match taken out, if that's an Assist model on offer.
 * @param {string} model @param {LaneSettings} settings @param {string[]} offered the ids the gateway lists
 */
function assistTwin(model, settings, offered) {
  if (laneOf(model, settings) !== "tool") return "";
  const id = String(model || "").toLowerCase();
  if (listed(settings).length) {
    const twins = offered.filter((other) => other.toLowerCase() !== id && id.startsWith(other.toLowerCase()) && laneOf(other, settings) === "assist");
    return twins.sort((a, b) => b.length - a.length)[0] ?? "";
  }
  const pattern = String(settings.toolModels || "").trim();
  if (!pattern) return "";
  let twin = "";
  try { twin = String(model).replace(new RegExp(pattern, "i"), ""); } catch { return ""; }
  return twin && twin !== model && offered.includes(twin) && laneOf(twin, settings) === "assist" ? twin : "";
}

module.exports = { laneOf, assistTwin };
