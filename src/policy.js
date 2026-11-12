// @ts-check
"use strict";
/**
 * Settings an organisation enforces, by Group Policy or Intune: values under
 *   HKLM\SOFTWARE\Policies\Gremnar\Solder   (computer policy; wins)
 *   HKCU\SOFTWARE\Policies\Gremnar\Solder   (user policy)
 * A value that's there is enforced: Solder uses it, ignores the user's own setting and locks the field. Only
 * admins can write these keys. They're read with reg.exe (started directly, no shell: Node has no registry API),
 * exported as a .reg file, which is UTF-16, so text in any language comes through. No vscode here: tested under node.
 *
 * If the policy can't be read (reg.exe won't start, or its export can't be made sense of), Solder fails closed:
 * it won't connect, as an enforced gateway can't be checked.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

const KEYS = ["HKLM\\SOFTWARE\\Policies\\Gremnar\\Solder", "HKCU\\SOFTWARE\\Policies\\Gremnar\\Solder"];
const READ_MS = 10_000;

/**
 * Each setting's policy value: its registry name and what it holds.
 * @type {Record<string, {value: string, kind: "text" | "number" | "list" | "docs" | "folders" | "names" | "choice", choices?: string[]}>}
 */
const SETTINGS = {
  endpoint: { value: "Endpoint", kind: "text" },
  model: { value: "Model", kind: "text" },
  modelFilter: { value: "ModelFilter", kind: "text" },
  toolModels: { value: "ToolModels", kind: "text" },
  assistModels: { value: "AssistModels", kind: "list" },
  assistSessionBlock: { value: "AssistSessionBlock", kind: "text" },
  modelNames: { value: "ModelNames", kind: "names" },
  effort: { value: "Effort", kind: "choice", choices: ["default", "low", "medium", "high"] },
  compactAtTokens: { value: "CompactAtTokens", kind: "number" },
  maxRounds: { value: "MaxRounds", kind: "number" },
  rules: { value: "Rules", kind: "text" },
  instructionFiles: { value: "InstructionFiles", kind: "list" },
  storageLimitGB: { value: "StorageLimitGB", kind: "number" },
  docsSearch: { value: "DocsSearch", kind: "choice", choices: ["keyword", "hybrid"] },
  embeddingModel: { value: "EmbeddingModel", kind: "text" },
  docsFolders: { value: "DocsFolders", kind: "docs" },
  skillsFolders: { value: "SkillsFolders", kind: "folders" },
  readOnly: { value: "ReadOnly", kind: "number" },
};
/** Policies that aren't a setting: user folders beside enforced ones, and rules added after the user's. */
const ALLOW_USER_DOCS = "AllowUserDocsFolders";
const ALLOW_USER_SKILLS = "AllowUserSkills";
const ORG_RULES = "OrgRules";
/** Where Send feedback goes instead of Solder's own support address (an organisation's own, so reports stay inside). */
const FEEDBACK_ADDRESS = "FeedbackAddress";
/** An email address that's safe in a mailto: link: no spaces, and nothing that would start a header or another address. */
const EMAIL = /^[A-Za-z0-9.!$'*+/=^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/**
 * A .reg export's values for one key: strings, numbers (dword) and lists (multi-string). Others are left out.
 * @param {string} text @param {string} key e.g. HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Gremnar\Solder @returns {Map<string, string | number | string[]>}
 */
function parseRegFile(text, key) {
  /** @type {Map<string, string | number | string[]>} */
  const values = new Map();
  const lines = text.replace(/^\uFEFF/, "").replace(/\\\r?\n\s*/g, "").split(/\r?\n/);
  let inKey = false;
  for (const line of lines) {
    const section = /^\[(.+)\]\s*$/.exec(line);
    if (section) { inKey = section[1].toLowerCase() === key.toLowerCase(); continue; }
    if (!inKey) continue;
    const entry = /^"((?:[^"\\]|\\.)*)"=(.*)$/.exec(line);
    if (!entry) continue;
    const name = unescapeReg(entry[1]);
    const data = entry[2].trim();
    const string = /^"((?:[^"\\]|\\.)*)"$/.exec(data);
    if (string) { values.set(name, unescapeReg(string[1])); continue; }
    const dword = /^dword:([0-9a-f]{8})$/i.exec(data);
    if (dword) { values.set(name, parseInt(dword[1], 16)); continue; }
    const hex = /^hex\((7|2)\):([0-9a-f,\s]*)$/i.exec(data);
    if (hex) {
      const bytes = Buffer.from(hex[2].split(",").map((b) => b.trim()).filter(Boolean).map((b) => parseInt(b, 16)));
      const decoded = bytes.toString("utf16le");
      if (hex[1] === "7") values.set(name, decoded.split("\0").filter(Boolean));
      else values.set(name, decoded.replace(/\0+$/, ""));
    }
  }
  return values;
}

function unescapeReg(/** @type {string} */ text) {
  return text.replace(/\\(["\\])/g, "$1");
}

/**
 * One key's values, by exporting it with reg.exe. null when the key isn't there.
 * @param {string} key @returns {Promise<Map<string, string | number | string[]> | null>}
 */
function readKey(key) {
  const reg = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
  const file = path.join(os.tmpdir(), `solder-policy-${crypto.randomBytes(6).toString("hex")}.reg`);
  return new Promise((resolve, reject) => {
    execFile(reg, ["export", key, file, "/y", "/reg:64"], { windowsHide: true, timeout: READ_MS }, (error) => {
      const done = (/** @type {() => void} */ then) => { fs.rm(file, { force: true }, () => {}); then(); };
      try {
        if (error && /** @type {any} */ (error).killed) { done(() => reject(new Error("reg.exe took too long"))); return; }
        // A start that failed (missing, or blocked) has a string code; a plain exit code is a number.
        if (error && typeof /** @type {any} */ (error).code === "string") { done(() => reject(new Error(`reg.exe couldn't run: ${/** @type {any} */ (error).code}`))); return; }
        if (error || !fs.existsSync(file)) {
          // The export failed. That's "nothing enforced" only if the key really isn't there (reg.exe's messages are
          // translated, so its exit code is what's asked): a key that's there but couldn't be exported fails closed.
          execFile(reg, ["query", key, "/reg:64"], { windowsHide: true, timeout: READ_MS }, (queryError) => {
            if (!queryError) { done(() => reject(new Error("the policy key is there, but reg.exe couldn't export it"))); return; }
            if (/** @type {any} */ (queryError).killed || typeof /** @type {any} */ (queryError).code === "string") {
              done(() => reject(new Error("reg.exe couldn't check the policy key"))); return;
            }
            done(() => resolve(null));
          });
          return;
        }
        const raw = fs.readFileSync(file);
        const text = raw[0] === 0xff && raw[1] === 0xfe ? raw.toString("utf16le") : raw.toString("utf8");
        const full = key.replace(/^HKLM\\/i, "HKEY_LOCAL_MACHINE\\").replace(/^HKCU\\/i, "HKEY_CURRENT_USER\\");
        if (!/^\uFEFF?Windows Registry Editor/.test(text)) { done(() => reject(new Error("reg.exe's export couldn't be read"))); return; }
        const values = parseRegFile(text, full);
        done(() => resolve(values));
      } catch (problem) {
        done(() => reject(problem instanceof Error ? problem : new Error(String(problem))));
      }
    });
  });
}

class Policy {
  /** @param {{read?: (key: string) => Promise<Map<string, any> | null>, platform?: string}} [options] */
  constructor({ read = readKey, platform = process.platform } = {}) {
    this.read = read;
    this.platform = platform;
    /** @type {Map<string, any>} the enforced values, by setting name */
    this.values = new Map();
    this.allowUserDocs = false;
    this.allowUserSkills = false;
    this.orgRules = "";
    /** @type {string | null} the feedback address the organisation sets, as given (null when it sets none) */
    this.feedbackAddress = null;
    /** Why the policy couldn't be read ("" when it could): Solder won't connect while this is set. */
    this.error = "";
    /** @type {string[]} values that were there but couldn't be used (for diagnostics) */
    this.problems = [];
    /** The setting names enforced, for diagnostics. @type {string[]} */
    this.names = [];
  }

  /** Read the policy again. @returns {Promise<boolean>} whether anything changed */
  async refresh() {
    const before = JSON.stringify([[...this.values], this.allowUserDocs, this.allowUserSkills, this.orgRules, this.feedbackAddress, this.error]);
    if (this.platform !== "win32") { this.apply(new Map(), ""); return before !== JSON.stringify([[...this.values], this.allowUserDocs, this.allowUserSkills, this.orgRules, this.feedbackAddress, this.error]); }
    try {
      /** @type {Map<string, any>} */
      const merged = new Map();
      // User policy first, computer policy over it.
      for (const key of [...KEYS].reverse()) {
        const found = await this.read(key);
        for (const [name, value] of found || []) merged.set(name.toLowerCase(), value);
      }
      this.apply(merged, "");
    } catch (error) {
      this.apply(new Map(), `Your organization's settings for Solder couldn't be read (${/** @type {any} */ (error)?.message || error}), so Solder won't connect until they can be. Ask your IT team.`);
    }
    return before !== JSON.stringify([[...this.values], this.allowUserDocs, this.allowUserSkills, this.orgRules, this.feedbackAddress, this.error]);
  }

  /** @param {Map<string, any>} raw by lower-case value name @param {string} error */
  apply(raw, error) {
    this.error = error;
    this.values = new Map();
    this.problems = [];
    for (const [setting, { value, kind, choices }] of Object.entries(SETTINGS)) {
      if (!raw.has(value.toLowerCase())) continue;
      const given = raw.get(value.toLowerCase());
      const read = coerce(given, kind, choices);
      // The gateway is enforced even when it's malformed: connecting then fails, rather than falling back to the user's.
      if (read === undefined && setting !== "endpoint") { this.problems.push(`${value}: not a usable ${kind}`); continue; }
      this.values.set(setting, read === undefined ? String(given) : read);
      // A pattern that won't read is still enforced (it then matches nothing), and reported.
      if ((setting === "modelFilter" || setting === "toolModels") && typeof read === "string" && read) {
        try { new RegExp(read); } catch { this.problems.push(`${value}: not a valid regular expression`); }
      }
    }
    const on = (/** @type {any} */ value) => value !== undefined && (typeof value === "number" ? value !== 0 : /^(1|true|yes)$/i.test(String(value).trim()));
    this.allowUserDocs = on(raw.get(ALLOW_USER_DOCS.toLowerCase()));
    this.allowUserSkills = on(raw.get(ALLOW_USER_SKILLS.toLowerCase()));
    const org = raw.get(ORG_RULES.toLowerCase());
    this.orgRules = org === undefined ? "" : (Array.isArray(org) ? org.join("\n") : String(org)).trim();
    const feedback = raw.get(FEEDBACK_ADDRESS.toLowerCase());
    this.feedbackAddress = feedback === undefined ? null : (Array.isArray(feedback) ? feedback.join(" ") : String(feedback)).trim();
    this.names = [...this.values.keys(), ...(this.allowUserDocs ? [ALLOW_USER_DOCS] : []), ...(this.allowUserSkills ? [ALLOW_USER_SKILLS] : []),
      ...(this.orgRules ? [ORG_RULES] : []), ...(this.feedbackAddress !== null ? [FEEDBACK_ADDRESS] : [])];
  }

  /**
   * Where Send feedback goes: the organisation's address when it sets one, else Solder's own. It fails closed: an
   * address that's set but isn't a usable email address, or a policy that can't be read, sends nothing (it never
   * falls back to Solder's, so feedback meant to stay inside can't leave).
   * @param {string} fallback Solder's own support address @returns {{to: string} | {problem: string}}
   */
  feedbackTo(fallback) {
    if (this.error) return { problem: "Your organization's settings for Solder couldn't be read, so Send feedback can't tell where your feedback should go. Ask your IT team." };
    if (this.feedbackAddress === null) return { to: fallback };
    if (!EMAIL.test(this.feedbackAddress) || this.feedbackAddress.length > 254) {
      return { problem: "Your organization sets where Solder's feedback goes, but the address it set isn't a usable email address, so nothing was sent. Ask your IT team." };
    }
    return { to: this.feedbackAddress };
  }

  /** Before anything connects: throws while the policy can't be read (fail closed). */
  gate() {
    if (this.error) throw new Error(this.error);
  }

  /** Whether the user can't change this setting. @param {string} name */
  locked(name) {
    if (name === "docsFolders") return this.values.has("docsFolders") && !this.allowUserDocs;
    if (name === "skillsFolders") return this.values.has("skillsFolders") && !this.allowUserSkills;
    return this.values.has(name);
  }

  /** The docs folders the organisation sets ([] when none). @returns {{path: string, about: string}[]} */
  orgDocs() { return this.values.get("docsFolders") || []; }

  /** The skills folders the organisation sets ([] when none). @returns {string[]} */
  orgSkills() { return this.values.get("skillsFolders") || []; }

  /**
   * VS Code's settings for Solder with the policy over them: enforced values win, the user's can't be changed.
   * @param {{get: (name: string, fallback?: any) => any, update: (name: string, value: any, target?: any) => Thenable<void>}} config
   */
  wrap(config) {
    const policy = this;
    return {
      /** @param {string} name @param {any} [fallback] */
      get(name, fallback) {
        if (name === "docsFolders") {
          if (!policy.values.has("docsFolders")) return config.get(name, fallback);
          const org = policy.orgDocs();
          if (!policy.allowUserDocs) return org;
          const mine = (config.get(name, []) || []).map((/** @type {any} */ item) => typeof item === "string" ? { path: item, about: "" } : item);
          return [...org, ...mine.filter((/** @type {any} */ d) => !org.some((o) => o.path.toLowerCase() === String(d?.path ?? "").toLowerCase()))];
        }
        if (name === "skillsFolders") {
          if (!policy.values.has("skillsFolders")) return config.get(name, fallback);
          const org = policy.orgSkills();
          if (!policy.allowUserSkills) return org;
          const mine = (config.get(name, []) || []).map((/** @type {any} */ item) => String(typeof item === "string" ? item : item?.path ?? "")).filter(Boolean);
          return [...org, ...mine.filter((folder) => !org.some((o) => o.toLowerCase() === folder.toLowerCase()))];
        }
        return policy.values.has(name) ? policy.values.get(name) : config.get(name, fallback);
      },
      /** The user's own value, policy aside (their docs folders, beside the organisation's). @param {string} name @param {any} [fallback] */
      own(name, fallback) { return config.get(name, fallback); },
      /** @param {string} name @param {any} value @param {any} [target] */
      update(name, value, target) {
        return policy.locked(name) ? Promise.resolve() : config.update(name, value, target);
      },
    };
  }
}

/** A policy value as its setting needs it, or undefined when it can't be. @param {any} given @param {string} kind @param {string[]} [choices] */
function coerce(given, kind, choices) {
  const text = Array.isArray(given) ? given.join("\n") : String(given);
  switch (kind) {
    case "text": return text.trim();
    case "number": {
      const n = typeof given === "number" ? given : /^\s*\d+\s*$/.test(text) ? Number(text) : NaN;
      return Number.isFinite(n) ? n : undefined;
    }
    case "choice": { const choice = text.trim().toLowerCase(); return choices?.includes(choice) ? choice : undefined; }
    case "list": {
      const items = (Array.isArray(given) ? given : text.split(/[,;\n]/)).map((s) => String(s).trim()).filter(Boolean);
      return items.length ? items : undefined;
    }
    case "docs": {
      const items = (Array.isArray(given) ? given : text.split(/\r?\n/)).map((s) => String(s).trim()).filter(Boolean);
      const docs = items.map((item) => { const at = item.indexOf("|"); return at < 0 ? { path: item, about: "" } : { path: item.slice(0, at).trim(), about: item.slice(at + 1).trim() }; })
        .filter((d) => d.path);
      return docs.length ? docs : undefined;
    }
    case "folders": {
      const items = (Array.isArray(given) ? given : text.split(/\r?\n/)).map((s) => String(s).trim()).filter(Boolean);
      return items.length ? items : undefined;
    }
    case "names": {
      try { const names = JSON.parse(text); return names && typeof names === "object" && !Array.isArray(names) ? names : undefined; } catch { return undefined; }
    }
  }
  return undefined;
}

/** The one policy for this window. */
const policy = new Policy();

module.exports = { Policy, policy, parseRegFile, readKey, coerce, SETTINGS, KEYS, ALLOW_USER_DOCS, ALLOW_USER_SKILLS, ORG_RULES, FEEDBACK_ADDRESS };
