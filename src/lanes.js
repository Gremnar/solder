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

/** Words that mark a model as a small one (as whole words in its id: "x-lite", "x_mini"). */
const SMALL = /(^|[^a-z])(lite|mini|nano|small|tiny|micro)([^a-z]|$)/i;
/** Words that mark the bigger variant of a model. */
const BIG = /(^|[^a-z])(pro|max|ultra|large|plus)([^a-z]|$)/i;

/**
 * A model id's version, as numbers to compare part by part ("x-3.5-y" → [3, 5]; "x-3.10" beats "x-3.9"). The first
 * number of one or two digits, with its dotted parts; dates and long numbers ("2024-05-13", "0613") aren't versions.
 * @param {string} id @returns {number[]}
 */
function versionOf(id) {
  const plain = String(id).replace(/\d{4,}(?:[-_.]\d{1,2}){0,2}/g, " "); // dates and long numbers out first
  const found = /(?:^|[^\d.])(?!0\d)(\d{1,2}(?:\.\d{1,3})*)(?![\d.])/.exec(plain);
  return found ? found[1].split(".").map(Number) : [];
}

/**
 * The model to choose for you, best first: not a small one (lite, mini, nano…), then the highest version, then the
 * bigger variant (pro, max…), then the gateway's own order. Names only: it can't know a model, just read its id.
 * @param {string[]} ids @returns {string} "" when there are none
 */
function bestModel(ids) {
  const ranked = ids.map((id, order) => ({ id, order, small: SMALL.test(id), version: versionOf(id), big: BIG.test(id) }));
  ranked.sort((a, b) => {
    if (a.small !== b.small) return a.small ? 1 : -1;
    for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
      const d = (b.version[i] ?? -1) - (a.version[i] ?? -1);
      if (d) return d;
    }
    if (a.big !== b.big) return a.big ? -1 : 1;
    return a.order - b.order;
  });
  return ranked[0]?.id ?? "";
}

/**
 * Whether a model can call tools natively: it's asked something only a tool can answer, given one tool. A model that
 * answers without calling it is served without tool calling (an Assist model, to Solder). When it does call the tool,
 * it's given the result, and whether its answer used it is said too.
 * @param {{reply: (request: any) => Promise<any>}} client @param {string} model @param {AbortSignal} [signal]
 * @returns {Promise<{calls: boolean, used: boolean, first: any, second: any}>} throws what the request throws
 */
async function probeTools(client, model, signal) {
  const { PROBE } = require("./prompt.js");
  const tools = [PROBE.tool];
  /** @type {any[]} */
  const messages = [{ role: "system", content: PROBE.system }, { role: "user", content: PROBE.ask }];
  const first = await client.reply({ model, messages, tools, signal });
  if (!first.calls.length) return { calls: false, used: false, first, second: null };
  messages.push({ role: "assistant", content: first.content, tool_calls: first.calls.map((/** @type {any} */ call) => ({ id: call.id,
    type: "function", function: { name: call.name, arguments: call.arguments }, ...(call.extra ? { extra_content: call.extra } : {}) })) });
  for (const call of first.calls) messages.push({ role: "tool", tool_call_id: call.id, content: PROBE.result });
  const second = await client.reply({ model, messages, tools, signal });
  return { calls: true, used: String(second.content || "").includes(PROBE.canary), first, second };
}

/**
 * The Assist models list with one more model in it, made as Settings makes it: every model offered that's an Assist
 * model now (by the list, or else by the Tool models pattern), and this one. A list, once there is one, decides alone,
 * so it has to keep the ones the pattern made Assist models.
 * @param {string[]} offered the models listed @param {{toolModels?: string, assistModels?: string[]}} kinds @param {string} model
 */
function withAssist(offered, kinds, model) {
  const now = offered.filter((id) => laneOf(id, kinds) === "assist");
  return [...new Set([...(kinds.assistModels || []), ...now, model])];
}

module.exports = { laneOf, assistTwin, bestModel, versionOf, probeTools, withAssist };
