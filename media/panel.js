// @ts-check
"use strict";
/* Solder's chat panel. It renders what the extension posts and sends back what you do; it holds no
   chat state of its own beyond what's on screen (and your unsent draft). */
(function () {
  // @ts-ignore: provided by VS Code's webview
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : { postMessage() {}, getState() {}, setState() {} };
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const transcript = $("transcript");
  const input = /** @type {HTMLTextAreaElement} */ ($("input"));
  /** @type {any} */
  let state = null;
  const editor = { file: "", selection: "" };
  const chipsOn = { file: true, selection: true };
  /** @type {Set<string>} */
  const open = new Set(); // steps whose output is shown
  let thinkingSince = 0;
  let stickToBottom = true;

  const saved = vscode.getState() || {};
  input.value = saved.draft || "";

  // ---------------------------------------------------------------- markdown --

  /** @param {string} text */
  function escape(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  const PATHLIKE = /^(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]{1,8}(?::\d+)?$|^(?:[\w.-]+\/)+[\w.-]+(?::\d+)?$/;

  /** Inline Markdown on one escaped line. @param {string} raw */
  function inline(raw) {
    const codes = [];
    let text = raw.replace(/`([^`\n]+)`/g, (_m, code) => {
      codes.push(code);
      return `\u0000${codes.length - 1}\u0000`;
    });
    text = escape(text)
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
      .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>")
      .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label, href) => /^https?:/i.test(href)
        ? `<a href="${href}" title="${href}">${label}</a>` : `<a href="#" class="path-link" data-path="${href}"><code class="path">${label}</code></a>`);
    return text.replace(/\u0000(\d+)\u0000/g, (_m, n) => {
      const code = codes[Number(n)];
      return PATHLIKE.test(code.trim()) ? `<a href="#" class="path-link" data-path="${escape(code.trim())}"><code class="path">${escape(code)}</code></a>` : `<code>${escape(code)}</code>`;
    });
  }

  /** Markdown → safe HTML (everything is escaped first; no raw HTML passes through). @param {string} source */
  function markdown(source) {
    const lines = source.replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let i = 0;
    /** @type {string[]} */
    let paragraph = [];
    const flush = () => { if (paragraph.length) { out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`); paragraph = []; } };
    while (i < lines.length) {
      const line = lines[i];
      const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line);
      if (fence) {
        flush();
        const close = fence[1];
        const body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(close)) body.push(lines[i++]);
        i++;
        out.push(`<pre><button class="copy">Copy</button><code>${escape(body.join("\n"))}</code></pre>`);
        continue;
      }
      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (heading) { flush(); out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); i++; continue; }
      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { flush(); out.push("<hr>"); i++; continue; }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flush();
        const cells = (/** @type {string} */ row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") + "</tbody></table>");
        continue;
      }
      const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (item) {
        flush();
        const ordered = /\d/.test(item[2]);
        const items = [];
        while (i < lines.length) {
          const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          if (m) { items.push({ depth: m[1].length >= 2 ? 1 : 0, text: m[3] }); i++; continue; }
          if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) { items[items.length - 1].text += " " + lines[i].trim(); i++; continue; }
          break;
        }
        let html = ordered ? "<ol>" : "<ul>";
        let depth = 0;
        for (const it of items) {
          if (it.depth > depth) html += "<ul>";
          if (it.depth < depth) html += "</ul>";
          depth = it.depth;
          html += `<li>${inline(it.text)}</li>`;
        }
        if (depth) html += "</ul>";
        out.push(html + (ordered ? "</ol>" : "</ul>"));
        continue;
      }
      if (/^\s*>\s?/.test(line)) {
        flush();
        const quote = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
        out.push(`<blockquote>${markdown(quote.join("\n"))}</blockquote>`);
        continue;
      }
      if (!line.trim()) { flush(); i++; continue; }
      paragraph.push(line);
      i++;
    }
    flush();
    return out.join("");
  }

  // --------------------------------------------------------------- rendering --

  // ------------------------------------------------------------- entrances --
  // The transcript is re-rendered whole on every state, so an element can't just animate when it's created: it
  // would replay each time. Things that should arrive with a little motion carry data-enter="key"; a key seen for
  // the first time gets .enter, and keeps it (with its age in --age, so the animation carries on rather than
  // restarting) for ENTER_MS. Keys: i: an item, d: a step's finished mark, o: an opened output, t: a steer,
  // q: a queued message, s: the status line, w: the welcome.

  const ENTER_MS = 1000;
  /** @type {Map<string, number>} */
  const bornInTranscript = new Map();
  /** @type {Map<string, number>} */
  const bornInComposer = new Map();

  /** @param {HTMLElement} root @param {Map<string, number>} born @param {boolean} quiet nothing animates but the welcome */
  function entrances(root, born, quiet) {
    const now = performance.now();
    const els = /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll("[data-enter]"));
    let fresh = 0;
    for (const el of els) if (!born.has(String(el.dataset.enter)) && String(el.dataset.enter).startsWith("i:")) fresh++;
    if (fresh > 4) quiet = true; // a whole chat changed at once (a summary shifted it): no parade
    const present = new Set();
    for (const el of els) {
      const key = String(el.dataset.enter);
      present.add(key);
      if (!born.has(key)) born.set(key, quiet && !key.startsWith("w:") ? -Infinity : now);
      const age = now - Number(born.get(key));
      if (age < ENTER_MS) {
        el.classList.add("enter");
        if (age >= 1) el.style.setProperty("--age", `-${Math.round(age)}ms`);
      }
    }
    for (const key of [...born.keys()]) if (!present.has(key)) born.delete(key);
  }

  /** Restarts a one-shot animation class. @param {Element | null} el @param {string} name */
  function replay(el, name) {
    if (!el) return;
    el.classList.remove(name);
    void (/** @type {HTMLElement} */ (el).offsetWidth);
    el.classList.add(name);
  }

  // ---------------------------------------------------------- accessibility --
  // The transcript is a quiet log; what a screen reader should hear is said here, once, in short.

  /** @type {string[]} */
  let toAnnounce = [];
  /** @type {any} */
  let announceTimer = null;
  /** Says something through the status region (emptied first, so the same words can be said twice). @param {string} text */
  function announce(text) {
    if (!text) return;
    toAnnounce.push(text);
    if (announceTimer) return;
    $("announce").textContent = "";
    announceTimer = setTimeout(() => { $("announce").textContent = toAnnounce.join(" "); toAnnounce = []; announceTimer = null; }, 80);
  }

  /** What identifies an element across a redraw, most specific first. */
  const FOCUS_KEYS = ["data-step", "data-chip", "data-field", "data-docs-about", "data-about", "data-pick-model", "data-sact", "data-setup",
    "data-action", "data-review", "data-undo", "data-unsteer", "data-model", "data-open", "id"];

  /**
   * Runs a redraw of root; if it replaced the focused element, focus goes to its new copy (or to fallback).
   * @param {HTMLElement} root @param {() => void} redraw @param {HTMLElement} [fallback]
   */
  function keepFocus(root, redraw, fallback) {
    const was = /** @type {HTMLElement | null} */ (document.activeElement);
    if (!was || was === document.body || !root.contains(was)) { redraw(); return; }
    let selector = "";
    if (was.dataset.sfield) selector = `[data-sfield="${CSS.escape(was.dataset.sfield)}"][data-value="${CSS.escape(String(was.dataset.value))}"]`;
    else {
      const key = FOCUS_KEYS.find((k) => was.hasAttribute(k));
      if (key) selector = `[${key}="${CSS.escape(was.getAttribute(key) || "")}"]` + (was.hasAttribute("data-index") ? `[data-index="${CSS.escape(String(was.dataset.index))}"]` : "");
    }
    const field = /** @type {HTMLInputElement} */ (was);
    /** @type {[number, number] | null} */
    let range = null;
    try { if (typeof field.selectionStart === "number") range = [field.selectionStart, Number(field.selectionEnd)]; } catch { /* not a text field */ }
    redraw();
    if (was.isConnected) return;
    const found = /** @type {HTMLElement | null} */ (selector ? root.querySelector(selector) : null);
    const next = found || fallback;
    if (!next) return;
    next.focus({ preventScroll: true });
    if (range && found) { try { /** @type {HTMLInputElement} */ (found).setSelectionRange(range[0], range[1]); } catch { /* not a text field */ } }
  }

  /** An answer as plain words, for the status region. @param {string} text */
  function plain(text) {
    const div = document.createElement("div");
    div.innerHTML = renderedOnce(text);
    for (const copy of div.querySelectorAll(".copy")) copy.remove();
    for (const block of div.querySelectorAll("p, li, h1, h2, h3, h4, pre, tr, th, td, blockquote")) block.append(" ");
    for (const br of div.querySelectorAll("br")) br.replaceWith(" ");
    return (div.textContent || "").replace(/\s+/g, " ").trim();
  }

  /** What changed between two states that a screen reader should hear. @param {any} was @param {any} now */
  function announceChanges(was, now) {
    if (!was || now.setup || was.chat.id !== now.chat.id) return;
    if (now.busy && !was.busy) announce("Working…");
    /** @type {Map<string, any>} */
    const before = new Map();
    const answers = new Set();
    for (const item of was.chat.items) {
      if (item.kind === "step") before.set(item.id, item);
      else if (item.kind === "answer") answers.add(item.text);
    }
    for (const item of now.chat.items) {
      if (item.kind !== "step" || item.pending) continue;
      const old = before.get(item.id);
      if (!old || old.pending) announce((item.failed ? "Failed: " : "") + (item.summary || item.label));
      else if (item.undone && !old.undone) announce("Undone: " + (item.summary || item.label));
    }
    // a whole chat that shifted at once (a summary) isn't read out again
    const fresh = now.chat.items.filter((/** @type {any} */ i) => i.kind === "answer" && !answers.has(i.text));
    if (fresh.length && fresh.length <= 2) announce("Solder: " + plain(fresh[fresh.length - 1].text));
    const asked = new Set(was.approvals.map((/** @type {any} */ a) => a.id));
    for (const a of now.approvals) if (!asked.has(a.id)) announce("Approval needed: " + a.label);
  }

  const ICONS = {
    check: `<svg viewBox="0 0 16 16" aria-hidden="true"><path pathLength="1" d="M4.2 8.4 6.9 11l4.9-5.8"/></svg>`,
    cross: `<svg viewBox="0 0 16 16" aria-hidden="true"><path pathLength="1" d="M5 5l6 6M11 5l-6 6"/></svg>`,
    undo: `<svg viewBox="0 0 16 16" aria-hidden="true"><path pathLength="1" d="M5.5 6.5h4a2.6 2.6 0 0 1 0 5.2H7.5M7.6 4.4 5.5 6.5l2.1 2.1"/></svg>`,
    more: `<svg class="more" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5 8 10l3.5-3.5"/></svg>`,
    clock: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 5v3l2 1.3M13.5 8a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Z"/></svg>`,
    alert: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 4.8v3.6M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0Z"/><circle cx="8" cy="11" r="0.85"/></svg>`,
    pause: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.6 6v4M9.4 6v4M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0Z"/></svg>`,
    shield: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8 13 3.8V8c0 3-2.2 5.1-5 6.2C5.2 13.1 3 11 3 8V3.8z"/></svg>`,
    search: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.4 10.4 13.6 13.6M11.6 7.1a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Z"/></svg>`,
    edit: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.2 12.8 6l-6.6 6.6H3.4V9.8zM8.6 4.6l2.8 2.8"/></svg>`,
    triangle: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.6 14.2 13.2H1.8zM8 6.6v3.2"/><circle cx="8" cy="11.4" r="0.8"/></svg>`,
    // Solder's mark (media/solder.svg): a pad, the S-shaped trace, and the joint at its end
    solder: `<svg viewBox="0 0 24 24" aria-hidden="true"><path class="trace" pathLength="1" d="M16.3 5.5H9.6L7.4 7.7v1.8l2.2 2.2h4.6l2.2 2.2v1.6l-2.2 2.2H7.7"/>` +
      `<circle class="pad" cx="16.4" cy="5.5" r="1.7"/><circle class="end" cx="7.6" cy="17.7" r="1.9"/></svg>`,
  };

  let focusInput = false; // leaving settings or setup: the cursor goes back to the box

  function render() {
    if (!state) return;
    $("chat-title-text").textContent = state.setup ? "Set up Solder" : state.settings ? "Settings" : state.chat.title;
    // An open dropdown follows the chats (a pin or rename from its right-click menu), keeping its focus.
    if (!$("chat-menu").classList.contains("hidden")) keepFocus($("chat-menu"), renderChatMenu);
    document.body.classList.toggle("in-setup", !!state.setup || !!state.settings);
    document.body.classList.toggle("busy", !!state.busy && !state.setup);
    // The setup and settings screens draw into the transcript's place: the chat is redrawn whole afterwards.
    if (state.setup) { shownParts = []; renderSetup(); return; }
    if (state.settings) { shownParts = []; renderSettings(); return; }
    settingsShape = "";
    setupDraft = null;
    setupShown = "";
    renderTranscript();
    renderComposer();
    if (focusInput) { focusInput = false; input.focus(); }
  }

  // ------------------------------------------------------------- settings --
  // The extension holds the values; fields save when you leave them (or press Enter), and a small
  // "Saved" shows where. Progress updates (the docs index) refresh only the status, never your typing.

  let settingsShape = "";
  let settingsValues = "";
  let settingsSaved = "";

  function renderSettings() {
    const s = state.settings;
    // The form is rebuilt only when its structure changes; saved values are put in place, so focus stays where it is.
    const shape = JSON.stringify({ models: s.models, hasKey: s.hasKey, docs: s.docs.map((/** @type {any} */ d) => d.path), docsSearch: s.docsSearch,
      model: s.models.some((/** @type {any} */ m) => m.id === s.model) ? "" : s.model });
    const values = JSON.stringify({ ...s, docsStatus: null, notice: null, noticeKind: null, checking: null, saved: null });
    const savedNow = s.saved && (s.saved !== settingsSaved || values !== settingsValues) ? s.saved : "";
    if (savedNow && settingsShape) announce("Saved");
    settingsSaved = s.saved || "";
    settingsValues = values;
    const status = docsStatusText(s.docsStatus);
    if (shape === settingsShape && transcript.querySelector(".settings")) {
      for (const el of /** @type {NodeListOf<HTMLInputElement>} */ (transcript.querySelectorAll("[data-field]"))) {
        const want = String(s[String(el.dataset.field)] ?? "");
        if (el !== document.activeElement && el.value !== want) el.value = want;
      }
      for (const el of /** @type {NodeListOf<HTMLInputElement>} */ (transcript.querySelectorAll("[data-docs-about]"))) {
        const want = s.docs[Number(el.dataset.docsAbout)]?.about ?? "";
        if (el !== document.activeElement && el.value !== want) el.value = want;
      }
      for (const el of /** @type {NodeListOf<HTMLElement>} */ (transcript.querySelectorAll("[data-sfield]"))) {
        const on = s[String(el.dataset.sfield)] === el.dataset.value;
        el.classList.toggle("on", on);
        el.setAttribute("aria-pressed", String(on));
      }
      if (savedNow || !s.saved) {
        for (const slot of /** @type {NodeListOf<HTMLElement>} */ (transcript.querySelectorAll("[data-saved-for]"))) {
          slot.innerHTML = slot.dataset.savedFor === savedNow ? `<span class="saved">Saved</span>` : "";
        }
      }
      const el = $("docs-status");
      if (el) { el.textContent = status.text; el.className = "status-pill" + (status.busy ? " busy" : ""); }
      const notice = $("settings-notice");
      if (notice) { notice.textContent = s.notice || ""; notice.className = "settings-notice " + (s.noticeKind || ""); }
      const check = /** @type {HTMLButtonElement | null} */ (transcript.querySelector('[data-sact="check"]'));
      if (check) { check.disabled = !!s.checking; check.innerHTML = (s.checking ? `<span class="spinner"></span>` : "") + (s.checking ? "Checking…" : "Check connection"); }
      return;
    }
    const fresh = !settingsShape;
    settingsShape = shape;
    const saved = (/** @type {string} */ field) => `<span class="saved-slot" data-saved-for="${field}" aria-hidden="true">${s.saved === field ? `<span class="saved">Saved</span>` : ""}</span>`;
    const efforts = ["default", "low", "medium", "high"].map((level) =>
      `<button class="seg${s.effort === level ? " on" : ""}" data-sfield="effort" data-value="${level}" aria-pressed="${s.effort === level}">${level === "default" ? "Default" : level[0].toUpperCase() + level.slice(1)}</button>`).join("");
    const modelField = s.models.length
      ? `<select class="field" id="sf-model" data-field="model">${s.models.some((/** @type {any} */ m) => m.id === s.model) ? "" : `<option value="${escape(s.model)}">${escape(s.model || "Choose a model")}</option>`}` +
        s.models.map((/** @type {any} */ m) => `<option value="${escape(m.id)}"${m.id === s.model ? " selected" : ""}>${escape(m.name)}${m.name !== m.id ? ` (${escape(m.id)})` : ""}</option>`).join("") + `</select>`
      : `<input class="field" id="sf-model" data-field="model" spellcheck="false" placeholder="The model's id" value="${escape(s.model)}">`;
    const docs = s.docs.map((/** @type {any} */ d, /** @type {number} */ i) => `<div class="doc"><div class="doc-path" title="${escape(d.path)}">` +
      `<svg viewBox="0 0 16 16"><path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/></svg><span>${escape(d.path)}</span>` +
      `<button data-sact="removeDocs" data-index="${i}" title="Stop searching this folder" aria-label="Remove ${escape(d.path)}">✕</button></div>` +
      `<input class="field about" data-docs-about="${i}" aria-label="What's in ${escape(d.path)}" placeholder="What's in it? It tells the model when to look here" value="${escape(d.about)}">${saved("docs-" + i)}` +
      (/^[A-Za-z]:[\\/]?$|^\/$/.test(d.path.trim()) ? `<div class="hint">A whole drive is slow to index and fills the 20,000-file limit with unrelated files: the folder your docs are in works better.</div>` : "") +
      `</div>`).join("");
    const html = `<div class="setup settings${fresh ? " enter" : ""}">` +
      `<div class="settings-head"><h2 id="settings-title" tabindex="-1">Settings</h2><button class="link-button primary" data-sact="close">Done</button></div>` +
      `<div id="settings-notice" class="settings-notice ${s.noticeKind || ""}" role="status">${escape(s.notice || "")}</div>` +
      section("Connection",
        label("Gateway address", "endpoint", saved("endpoint")) + `<input class="field" id="sf-endpoint" data-field="endpoint" type="url" spellcheck="false" placeholder="https://gateway.example.com/v1/chat/completions" value="${escape(s.endpoint)}">` +
        label("API key", "key", saved("key"), "settings-key") + `<div class="row-field"><input class="field" id="settings-key" type="password" placeholder="${s.hasKey ? "A key is saved: type a new one to replace it" : "Paste your key"}">` +
        `<button class="link-button" data-sact="key">Save</button></div>` +
        (s.hasKey ? `<div class="hint">A key is saved. <button class="link" data-sact="clearKey">Remove it</button></div>` : "") +
        `<div class="actions-row"><button class="link-button" data-sact="check">Check connection</button></div>`) +
      section("Model",
        label("Default model", "model", saved("model")) + modelField +
        `<div class="field-label" id="sf-effort-label"><span>Effort</span>${saved("effort")}</div><div class="segs" role="group" aria-labelledby="sf-effort-label">${efforts}</div><div class="hint">Default sends nothing: the model's own choice, usually like Low. High is slower and uses many more tokens.</div>`) +
      section("Your docs",
        `<div class="docs-head"><span id="docs-status" class="status-pill${status.busy ? " busy" : ""}">${escape(status.text)}</span>` +
        (s.docs.length ? `<button class="link" data-sact="reindex">Index again</button>` : "") + `</div>` +
        `<div class="docs">${docs}</div><button class="link-button" data-sact="addDocs">Add a folder…</button>` +
        `<div class="hint">Plain text of any kind, and Word, Excel and PowerPoint files; not PDFs or scans. Up to 20,000 files a folder, indexed on this PC.</div>` +
        `<div class="field-label" id="sf-docsSearch-label"><span>Search by</span>${saved("docsSearch")}</div><div class="segs" role="group" aria-labelledby="sf-docsSearch-label">` +
        [["keyword", "Keywords"], ["hybrid", "Keywords + meaning"]].map(([value, text]) => `<button class="seg${s.docsSearch === value ? " on" : ""}" data-sfield="docsSearch" data-value="${value}" aria-pressed="${s.docsSearch === value}">${text}</button>`).join("") + `</div>` +
        (s.docsSearch === "hybrid"
          ? label("Embeddings model", "embeddingModel", saved("embeddingModel")) + `<div class="row-field"><input class="field" id="sf-embeddingModel" data-field="embeddingModel" spellcheck="false" placeholder="The gateway's embeddings model id" value="${escape(s.embeddingModel)}">` +
            `<button class="link-button" data-sact="testEmbedding">Test</button></div>` +
            `<div class="hint">Meaning search finds passages that say the same thing in other words. It sends every passage of your docs folders to the gateway once to be turned into numbers, then only changed files, and each search's words. The log (Copy diagnostics) shows the tokens each run used.</div>`
          : `<div class="hint">Keywords: the index stays on this PC, and only the passages the model reads are sent.</div>`)) +
      section("Rules and instructions",
        label("Your rules", "rules", saved("rules")) + `<textarea class="field area" id="sf-rules" data-field="rules" rows="4" placeholder="We target Python 3.10 and Node 18.&#10;Never edit files under generated/.">${escape(s.rules)}</textarea>` +
        label("Instruction files", "instructionFiles", saved("instructionFiles")) + `<input class="field" id="sf-instructionFiles" data-field="instructionFiles" spellcheck="false" value="${escape(s.instructionFiles)}">` +
        `<div class="hint">Files in the workspace the model follows, separated by commas, such as AGENTS.md, CLAUDE.md.</div>`) +
      section("Cost",
        `<div class="pair"><div>${label("Compact at tokens", "compactAt", saved("compactAt"))}<input class="field" id="sf-compactAt" data-field="compactAt" type="number" min="30000" step="10000" value="${s.compactAt}"></div>` +
        `<div>${label("Max rounds", "maxRounds", saved("maxRounds"))}<input class="field" id="sf-maxRounds" data-field="maxRounds" type="number" min="1" max="100" value="${s.maxRounds}"></div></div>` +
        `<div class="hint">Every step sends the whole chat again: compacting sooner costs less. Max rounds is the most steps with tool calls for one message.</div>`) +
      section("Advanced",
        label("Model filter", "modelFilter", saved("modelFilter")) + `<input class="field" id="sf-modelFilter" data-field="modelFilter" spellcheck="false" placeholder="A regular expression, such as -tools$" value="${escape(s.modelFilter)}">` +
        `<div class="hint">Only models whose id matches are offered. Short names for models are set in <button class="link" data-sact="vscodeSettings">VS Code's settings</button>.</div>`) +
      `</div>`;
    keepFocus(transcript, () => { transcript.innerHTML = html; });
    if (fresh) /** @type {HTMLElement | null} */ (document.getElementById("settings-title"))?.focus();
  }

  /** @param {string} title @param {string} body */
  function section(title, body) {
    return `<section class="settings-section"><h3>${escape(title)}</h3>${body}</section>`;
  }

  /** A field's label, tied to its field (id sf-<field> unless given). @param {string} text @param {string} field @param {string} [extra] @param {string} [id] */
  function label(text, field, extra = "", id = "sf-" + field) {
    return `<label class="field-label" for="${id}"><span>${escape(text)}</span>${extra}</label>`;
  }

  /** @param {any} d */
  function docsStatusText(d) {
    if (!d) return { text: "", busy: false };
    if (!d.available) return { text: "Needs a newer VS Code", busy: false };
    if (!d.folders) return { text: "No folders yet", busy: false };
    const m = d.meaning;
    const meaning = !m ? "" : m.error ? " · meaning: stopped, see the log"
      : m.waiting ? ` · meaning: waiting for your OK to send ${Number(m.waiting.passages).toLocaleString()} passages (Index again asks)` : m.passages
      ? ` · meaning: ${Number(m.embedded).toLocaleString()} of ${Number(m.passages).toLocaleString()} passages${m.tokens ? `, ${compact(m.tokens)} tokens` : ""}` : "";
    if (d.active) return { text: `Indexing… ${Number(d.indexed).toLocaleString()} files so far${meaning}`, busy: true };
    return { text: `Ready · ${Number(d.indexed).toLocaleString()} file${d.indexed === 1 ? "" : "s"} indexed${meaning}`, busy: false };
  }

  /** A settings field was left (or Enter pressed, or a choice made): save it. @param {HTMLElement} el */
  function saveSetting(el) {
    if (!state?.settings) return;
    const input = /** @type {HTMLInputElement} */ (el);
    if (input.dataset.field) {
      const now = input.value;
      const before = String(state.settings[input.dataset.field] ?? "");
      if (now !== before) vscode.postMessage({ type: "settingsScreen", action: "set", field: input.dataset.field, value: now });
    } else if (input.dataset.docsAbout !== undefined) {
      const index = Number(input.dataset.docsAbout);
      if (input.value !== (state.settings.docs[index]?.about ?? "")) vscode.postMessage({ type: "settingsScreen", action: "docsAbout", index, value: input.value });
    }
  }

  transcript.addEventListener("change", (event) => {
    const el = /** @type {HTMLElement} */ (event.target);
    if (state?.settings && el.matches("select[data-field], input[data-field], textarea[data-field], [data-docs-about]")) saveSetting(el);
  });
  transcript.addEventListener("keydown", (event) => {
    const el = /** @type {HTMLElement} */ (event.target);
    if (!state?.settings || event.key !== "Enter" || el.tagName !== "INPUT") return;
    event.preventDefault();
    if (el.id === "settings-key") /** @type {HTMLElement | null} */ (transcript.querySelector('[data-sact="key"]'))?.click();
    else el.blur();
  });

  // ------------------------------------------------------------ guided setup --
  // The extension holds the wizard's state; what you type stays here (draft) until you go on.

  /** @type {Record<string, string> | null} */
  let setupDraft = null;
  let setupShown = "";
  let setupLast = { error: "", busy: false, at: 0 }; // what the last render showed: for the direction of the slide and the shake

  const SETUP_TEXT = {
    endpoint: ["Where's your gateway?", "The full Chat Completions address, ending in <code>/chat/completions</code>. Any OpenAI-compatible endpoint with tool calling works."],
    key: ["Your API key", "Kept in VS Code's secret storage, never in settings. Solder checks it by listing the models."],
    model: ["Your default model", "New chats start with it; each chat can switch beside Send."],
    docs: ["Your own docs", "Optional. Folders of reference docs that live only on your PC: APIs, schematics, specifications. They're indexed here; only the passages the model reads are sent. Plain text and Word, Excel and PowerPoint files; not PDFs."],
    rules: ["About you and your code", "Optional. A few plain lines the model always follows: languages and versions, style, what not to touch."],
    done: ["You're set", "Solder is ready. You can change any of this in Settings, or run this again from the ⋯ menu."],
  };

  function renderSetup() {
    const s = state.setup;
    for (const key of [...bornInTranscript.keys()]) if (key.startsWith("w:")) bornInTranscript.delete(key); // the welcome after it arrives anew
    if (!setupDraft) setupDraft = {};
    const keep = (/** @type {string} */ id, /** @type {string} */ value) => escape(setupDraft?.[id] ?? value ?? "");
    const order = s.steps.filter((/** @type {string} */ name) => name !== "done");
    const at = s.steps.indexOf(s.step);
    const dots = order.map((/** @type {string} */ name, /** @type {number} */ i) =>
      `<span class="dot${i < at ? " done" : i === at ? " on" : ""}" title="${escape(SETUP_TEXT[name][0])}"></span>`).join("");
    const [title, intro] = SETUP_TEXT[/** @type {keyof typeof SETUP_TEXT} */ (s.step)];
    let body = "";
    const labelled = ` aria-labelledby="setup-title" aria-describedby="setup-intro"`;
    if (s.step === "endpoint") {
      body = `<input id="setup-endpoint" class="field"${labelled} type="url" spellcheck="false" placeholder="https://gateway.example.com/v1/chat/completions" value="${keep("setup-endpoint", s.endpoint)}">`;
    } else if (s.step === "key") {
      body = `<input id="setup-key" class="field" aria-labelledby="setup-title" aria-describedby="setup-intro setup-hint" type="password" placeholder="${s.hasKey ? "A key is saved: leave empty to keep it" : "Paste your key"}" value="${keep("setup-key", "")}">` +
        `<div class="hint" id="setup-hint">${s.hasKey ? "A key is already saved." : "A local server may not need one: leave it empty."}</div>`;
    } else if (s.step === "model") {
      const chosen = setupDraft["setup-model"] ?? s.model;
      const any = s.models.some((/** @type {any} */ m) => m.id === chosen);
      body = s.models.length
        ? `<div class="pick" role="radiogroup" aria-labelledby="setup-title" aria-describedby="setup-intro">${s.models.map((/** @type {any} */ m, /** @type {number} */ i) =>
            `<button class="option${m.id === chosen ? " on" : ""}" role="radio" aria-checked="${m.id === chosen}" tabindex="${m.id === chosen || (!any && i === 0) ? 0 : -1}" data-pick-model="${escape(m.id)}">` +
            `<span class="radio" aria-hidden="true"></span><span>${escape(m.name)}</span>${m.name !== m.id ? `<span class="grey">${escape(m.id)}</span>` : ""}</button>`).join("")}</div>`
        : `<input id="setup-model-typed" class="field" aria-labelledby="setup-title" aria-describedby="setup-intro setup-hint" spellcheck="false" placeholder="The model's id" value="${keep("setup-model-typed", s.model)}">` +
          `<div class="hint" id="setup-hint">The models couldn't be listed, so type the id your gateway uses.</div>`;
    } else if (s.step === "docs") {
      body = `<div class="docs">${s.docs.map((/** @type {any} */ d, /** @type {number} */ i) => `<div class="doc"><div class="doc-path" title="${escape(d.path)}">` +
          `<svg viewBox="0 0 16 16"><path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/></svg><span>${escape(d.path)}</span>` +
          `<button data-setup="removeDocs" data-index="${i}" title="Remove" aria-label="Remove ${escape(d.path)}">✕</button></div>` +
          `<input class="field about" data-about="${i}" aria-label="What's in ${escape(d.path)}" placeholder="What's in it? For example: PX-40 schematics and the FooBus API" value="${keep("about-" + i, d.about)}"></div>`).join("")}</div>` +
        `<button class="link-button" data-setup="addDocs">Add a folder…</button>`;
    } else if (s.step === "rules") {
      body = `<textarea id="setup-rules" class="field area"${labelled} rows="5" placeholder="We target Python 3.10 and Node 18.&#10;Use tabs, not spaces.&#10;Never edit files under generated/.">${keep("setup-rules", s.rules)}</textarea>`;
    } else if (s.step === "done") {
      let host = s.endpoint;
      try { host = new URL(s.endpoint).host; } catch { /* as typed */ }
      body = `<ul class="summary"><li><span>Gateway</span>${escape(host)}</li><li><span>Key</span>${s.hasKey ? "saved" : "none"}</li>` +
        `<li><span>Model</span>${escape(s.model)}</li><li><span>Docs</span>${s.docs.length ? s.docs.length + " folder" + (s.docs.length === 1 ? "" : "s") : "none"}</li>` +
        `<li><span>Rules</span>${s.rules ? s.rules.split("\n").filter(Boolean).length + " line" + (s.rules.split("\n").filter(Boolean).length === 1 ? "" : "s") : "none"}</li></ul>`;
    }
    const fresh = setupShown !== s.step;
    const shake = !!s.error && (fresh || s.error !== setupLast.error || setupLast.busy);
    const back = fresh && setupShown !== "" && at < setupLast.at;
    const error = s.error ? `<div class="setup-error${shake ? " enter" : ""}" role="alert">${ICONS.alert}<div>${escape(s.error)}` +
      `${s.step === "key" ? ` <button class="link" data-setup="skipCheck">Continue without checking</button>` : ""}</div></div>` : "";
    const next = s.step === "done" ? "Start chatting" : s.step === "key" ? (s.busy ? "Checking…" : "Check and continue")
      : (s.step === "docs" && !s.docs.length) || (s.step === "rules" && !(setupDraft["setup-rules"] ?? s.rules)) ? "Skip" : "Continue";
    const buttons = `<div class="setup-buttons">` +
      (at > 0 && s.step !== "done" ? `<button class="link-button" data-setup="back"${s.busy ? " disabled" : ""}>Back</button>` : `<button class="link-button" data-setup="cancel">Not now</button>`) +
      `<span class="grow"></span><button class="link-button primary" data-setup="${s.step === "done" ? "finish" : "next"}"${s.busy ? " disabled" : ""}>` +
      (s.busy ? `<span class="spinner"></span>` : "") + `${next}</button></div>`;
    setupShown = s.step;
    setupLast = { error: s.error || "", busy: !!s.busy, at };
    const progress = s.step === "done"
      ? `<div class="done-mark">${ICONS.check}</div>`
      : `<div class="progress"><div class="dots" aria-hidden="true">${dots}</div><span class="count">${at + 1} of ${order.length}</span></div>`;
    const html = `<div class="setup${fresh ? " enter" : ""}${back ? " back" : ""}">${progress}<h2 id="setup-title" tabindex="-1">${escape(title)}</h2>` +
      `<p class="intro" id="setup-intro">${intro}</p>${body}${error}${buttons}</div>`;
    keepFocus(transcript, () => { transcript.innerHTML = html; });
    // a new step: the cursor goes to its field, its chosen option, its main button, or its title
    const first = /** @type {HTMLElement | null} */ (transcript.querySelector(".field, [role=radio][tabindex='0']") ||
      (s.step === "done" ? transcript.querySelector('[data-setup="finish"]') : transcript.querySelector("#setup-title")));
    if (fresh && first) setTimeout(() => first.focus(), 60);
  }

  /** Chooses a model on the setup's list. @param {HTMLElement} el */
  function pickModel(el) {
    if (setupDraft) setupDraft["setup-model"] = String(el.dataset.pickModel);
    for (const option of transcript.querySelectorAll("[data-pick-model]")) {
      option.classList.toggle("on", option === el);
      option.setAttribute("aria-checked", String(option === el));
      option.setAttribute("tabindex", option === el ? "0" : "-1");
    }
  }

  /** What the current step's "next" sends: its inputs. */
  function setupValues() {
    const s = state.setup;
    const value = (/** @type {string} */ id) => /** @type {HTMLInputElement | null} */ (document.getElementById(id))?.value ?? "";
    if (s.step === "endpoint") return { endpoint: value("setup-endpoint") };
    if (s.step === "key") return { key: value("setup-key") };
    if (s.step === "model") return { model: s.models.length ? (setupDraft?.["setup-model"] ?? s.model) : value("setup-model-typed") };
    if (s.step === "docs") return { abouts: [...document.querySelectorAll("[data-about]")].map((el) => /** @type {HTMLInputElement} */ (el).value) };
    if (s.step === "rules") return { rules: value("setup-rules") };
    return {};
  }

  transcript.addEventListener("input", (event) => {
    const el = /** @type {HTMLInputElement} */ (event.target);
    if (!state?.setup || !setupDraft) return;
    if (el.id) setupDraft[el.id] = el.value;
    if (el.dataset.about !== undefined) setupDraft["about-" + el.dataset.about] = el.value;
    if (el.id === "setup-rules") {
      const button = transcript.querySelector('[data-setup="next"]');
      if (button) button.textContent = el.value.trim() ? "Continue" : "Skip";
    }
  });
  transcript.addEventListener("keydown", (event) => {
    const el = /** @type {HTMLElement} */ (event.target);
    if (state?.setup && event.key === "Enter" && el.tagName === "INPUT") {
      event.preventDefault();
      /** @type {HTMLElement | null} */ (transcript.querySelector('[data-setup="next"]'))?.click();
    }
    // the model list is a radio group: the arrows move the choice
    if (state?.setup && el.dataset?.pickModel !== undefined && ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) {
      const options = /** @type {HTMLElement[]} */ ([...transcript.querySelectorAll("[data-pick-model]")]);
      const at = options.indexOf(el);
      const n = options.length;
      const to = event.key === "Home" ? 0 : event.key === "End" ? n - 1 : event.key === "ArrowDown" || event.key === "ArrowRight" ? (at + 1) % n : (at - 1 + n) % n;
      event.preventDefault();
      pickModel(options[to]);
      options[to].focus();
    }
  });

  let shownChat = ""; // the chat the transcript last showed: a different one arrives without a parade

  function renderTranscript() {
    const items = state.chat.items;
    const quiet = shownChat !== state.chat.id;
    if (quiet && shownChat) replay(transcript, "swap");
    shownChat = state.chat.id;
    /** @type {string[]} one top-level element each, so only the ones that changed are redrawn */
    const parts = [];
    if (!items.length && !state.busy) parts.push(welcome());
    /** @type {string[]} consecutive steps share one timeline */
    let timeline = [];
    const endSteps = () => { if (timeline.length) parts.push(`<div class="steps">${timeline.join("")}</div>`); timeline = []; };
    items.forEach((/** @type {any} */ item, /** @type {number} */ index) => {
      if (item.kind === "step") {
        timeline.push(step(item));
        return;
      }
      endSteps();
      if (item.kind === "user") {
        parts.push(`<div class="user${item.resume ? " resume" : ""}" data-enter="i:u${index}">${escape(item.text)}` +
          (item.chips.length ? `<div class="chips">${item.chips.map((/** @type {string} */ c) => `<span class="chip">${escape(c).replace(/^✂/, `<span aria-hidden="true">✂</span>`)}</span>`).join("")}</div>` : "") + "</div>");
      } else if (item.kind === "answer") {
        // no entrance: an answer arrives word by word, through the fade-in
        parts.push(`<div class="answer${item.incomplete ? " incomplete" : ""}">${renderedOnce(item.text)}</div>`);
      } else if (item.kind === "plan") {
        parts.push(planCard(item));
      } else if (item.kind === "note") {
        parts.push(`<div class="note" data-enter="i:n${index}">${escape(item.text)}</div>`);
      }
    });
    if (state.busy) {
      const stepRunning = items.some((/** @type {any} */ i) => i.kind === "step" && i.running);
      if (reveal.shown) {
        endSteps();
        parts.push(`<div class="answer" id="live" aria-busy="true">${markdown(closeOpenMarks(reveal.shown))}</div>`);
        parts.push(`<div class="status after-live${state.status ? "" : " waiting"}" id="after-live"><span class="spinner"></span><span class="what">${escape(state.status || quietLabel())}</span><span class="clock"></span></div>`);
      }
      else if (!stepRunning || state.status) {
        // after steps, the status is the timeline's next node
        timeline.push(`<div class="status" id="status" data-enter="s:status"><span class="spinner"></span><span class="what">${escape(state.status || "Working…")}</span><span class="clock"></span></div>`);
      }
    }
    endSteps();
    // 2. What you typed meanwhile, waiting to go with the next step (✕ takes it back into the box).
    for (const [index, text] of (state.busy ? state.steers || [] : []).entries()) {
      parts.push(`<div class="user queued" data-enter="q:${escape(text)}">${escape(text)}<div class="queued-note">${ICONS.clock}<span>Goes with the next step</span>` +
        `<button data-unsteer="${index}" title="Take it back (into the box)" aria-label="Take it back">✕</button></div></div>`);
    }
    const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
    if (quiet) { transcript.innerHTML = ""; shownParts = []; }
    keepFocus(transcript, () => patch(transcript, parts));
    entrances(transcript, bornInTranscript, quiet);
    if (atBottom || stickToBottom) transcript.scrollTop = transcript.scrollHeight;
    stickToBottom = false;
  }

  /** @type {string[]} what each of the transcript's top-level elements was drawn from */
  let shownParts = [];

  /**
   * Bring the transcript up to `parts` (one HTML string per top-level element), replacing only the elements whose
   * HTML changed: a long chat with one new step redraws one element, not hundreds.
   * @param {HTMLElement} container @param {string[]} parts
   */
  function patch(container, parts) {
    const nodes = container.children;
    if (nodes.length !== shownParts.length) { container.innerHTML = parts.join(""); shownParts = parts.slice(); return; }
    for (let index = 0; index < parts.length; index++) {
      if (shownParts[index] === parts[index] && nodes[index]) continue;
      const holder = document.createElement("template");
      holder.innerHTML = parts[index];
      const fresh = holder.content.firstElementChild;
      if (!fresh) continue;
      if (nodes[index]) container.replaceChild(fresh, nodes[index]);
      else container.appendChild(fresh);
    }
    while (container.children.length > parts.length) /** @type {Element} */ (container.lastElementChild).remove();
    shownParts = parts.slice();
  }

  /** @type {Map<string, string>} an answer's text → its HTML (Markdown is rendered once per answer, not per update) */
  const renderedAnswers = new Map();
  /** @param {string} text */
  function renderedOnce(text) {
    let html = renderedAnswers.get(text);
    if (html === undefined) {
      html = markdown(text);
      renderedAnswers.set(text, html);
      if (renderedAnswers.size > 500) renderedAnswers.delete(/** @type {string} */ (renderedAnswers.keys().next().value));
    }
    return html;
  }

  /** The plan: each step's goal, done (with its notes), now (a spinner while it works) or to do. @param {any} item */
  function planCard(item) {
    const done = item.steps.filter((/** @type {any} */ step) => step.state === "done").length;
    const rows = item.steps.map((/** @type {any} */ step, /** @type {number} */ index) => {
      const mark = step.state === "done" ? ICONS.check : step.state === "doing" && item.active ? `<span class="spinner"></span>` : `<span class="dot"></span>`;
      const state = step.state === "done" ? "Done" : step.state === "doing" ? "Now" : "To do";
      return `<li class="${step.state}"><span class="mark" aria-hidden="true">${mark}</span><span class="sr-only">${state}: </span>` +
        `<span class="goal">${index + 1}. ${escape(step.goal)}</span>` +
        (step.state === "done" && step.notes ? `<span class="notes" title="${escape(step.notes)}">${escape(step.notes)}</span>` : "") + `</li>`;
    }).join("");
    return `<section class="plan" aria-label="Plan" data-enter="i:plan${escape(item.id)}"><div class="plan-head"><span>Plan</span>` +
      `<span class="count">${done} of ${item.steps.length} done</span></div><ol>${rows}</ol></section>`;
  }

  /** A step's label: the tool's name in code type while it waits; after it, the summary with its detail quieter. @param {any} item @param {string} label */
  function stepLabel(item, label) {
    if (item.pending && item.name && label.startsWith(item.name + " ")) return `<span class="tool">${escape(item.name)}</span>${escape(label.slice(item.name.length))}`;
    const cut = label.indexOf(" · ");
    if (cut < 0) return escape(label);
    let detail = escape(label.slice(cut));
    if (item.change && !item.undone) {
      detail = detail.replace(/(^|\s)([−-]\d+)(?=\s|$)/g, `$1<span class="del">$2</span>`).replace(/(^|\s)(\+\d+)(?=\s|$)/g, `$1<span class="add">$2</span>`);
    }
    return `${escape(label.slice(0, cut))}<span class="sub">${detail}</span>`;
  }

  /** @param {any} item */
  function step(item) {
    const cls = item.pending ? (item.running ? "running" : "waiting") : item.failed ? "failed" : "ok";
    const mark = item.pending ? "" : item.undone ? ICONS.undo : item.failed ? ICONS.cross : ICONS.check;
    const acts = item.change && !item.pending
      ? `<span class="acts">${item.noDiff || item.removed ? "" : `<button data-review="${escape(item.id)}" aria-label="Review: ${escape(item.summary || item.label)}">Review</button>`}` +
        `${item.undone ? "" : `<button data-undo="${escape(item.id)}" aria-label="Undo: ${escape(item.summary || item.label)}">Undo</button>`}</span>` : "";
    const label = item.pending ? item.label : (item.summary || item.label) + (item.undone ? " · undone" : "");
    const shown = open.has(item.id) && !!item.output;
    const body = shown ? `<pre class="out" data-enter="o:${escape(item.id)}"><code>${escape(item.output)}</code></pre>` : "";
    const time = item.running && item.since ? `<span class="time" data-since="${item.since}">${elapsed(Date.now() - item.since)}</span>`
      : !item.pending && item.ms >= 1000 ? `<span class="time" title="How long this step took">${duration(item.ms)}</span>` : "";
    const steered = item.steer ? `<div class="steered" data-enter="t:${escape(item.id)}"><span class="who">You, with this step</span>${escape(item.steer)}</div>` : "";
    // the head's key changes as the step finishes (or is undone), so its mark pops and draws once
    const settled = item.pending ? "" : ` data-enter="d:${escape(item.id)}${item.failed ? ":failed" : ""}${item.undone ? ":undone" : ""}"`;
    // only the label part toggles the output (a button, when there's output); Review and Undo sit beside it
    const said = item.pending ? (item.running ? "Running: " : "Waiting: ") : item.failed ? "Failed: " : "";
    const inner = `<span class="mark">${mark}</span>${said ? `<span class="sr-only">${said}</span>` : ""}<span class="label" title="${escape(label)}">${stepLabel(item, label)}</span>` +
      `${item.output ? ICONS.more : ""}${time}`;
    const toggle = item.output ? `<button class="step-toggle" data-step="${escape(item.id)}" aria-expanded="${shown}">${inner}</button>` : `<span class="step-toggle">${inner}</span>`;
    return `<div class="step ${cls}${item.undone ? " undone" : ""}${shown ? " open" : ""}" data-enter="i:${escape(item.id)}"><div class="step-head"${settled}>` +
      `${toggle}${acts}</div>${body}${steered}</div>`;
  }

  function welcome() {
    if (state.modelsProblem === "setup") {
      return `<div class="welcome" data-enter="w:setup"><div class="logo">${ICONS.solder}</div><h2>Set up Solder</h2>` +
        `<p class="lead">It takes a minute: your gateway's address, your key and a model, then your own docs and rules if you like.</p>` +
        `<div class="actions"><button class="link-button primary" data-setup="start">Start guided setup</button>` +
        `<button class="link-button" data-action="settings">Settings</button></div></div>`;
    }
    if (state.modelsProblem) {
      return `<div class="welcome" data-enter="w:problem"><div class="logo problem">${ICONS.triangle}</div><h2>Can't reach the endpoint</h2>` +
        `<p class="lead">${escape(state.modelsProblem)}</p>` +
        `<div class="actions"><button class="link-button primary" data-action="refreshModels">Try again</button>` +
        `<button class="link-button" data-action="settings">Settings</button><button class="link-button" data-action="setKey">Set API key</button></div></div>`;
    }
    // Starter cards: each sends its prompt (from prompt.js, through the extension) and starts the chat.
    const cards = (state.starters || []).map((/** @type {any} */ s, /** @type {number} */ i) =>
      `<button class="starter" data-starter="${escape(s.id)}" style="--i:${i}"><span class="starter-title">${escape(s.title)}</span>` +
      `<span class="starter-blurb">${escape(s.blurb)}</span></button>`).join("");
    return `<div class="welcome" data-enter="w:${state.chat.id}"><div class="logo">${ICONS.solder}</div><h2>Solder</h2>` +
      `<p class="lead">Ask about your code, or for a change. Every edit can be reviewed and undone.</p>` +
      (cards && state.workspace ? `<div class="starters">${cards}</div>` : "") +
      (state.workspace ? `<p class="hint"><kbd>Enter</kbd> sends, <kbd>Shift</kbd>+<kbd>Enter</kbd> adds a line.</p>`
        : `<p class="aside">Open a folder first: Solder works inside a workspace.</p>`) + "</div>";
  }

  let shownApprovals = "";
  let shownModels = "";
  let shownBanner = "";
  let shownChips = "";

  function renderComposer() {
    // approvals (announced through the status region, not as alerts)
    const approvals = state.approvals.map((/** @type {any} */ a) => `<div class="approval" data-id="${escape(a.id)}" data-enter="a:${escape(a.id)}" role="region" aria-label="Approval needed">` +
      `<div class="what" id="ap-what-${escape(a.id)}">${ICONS.shield}<span>${escape(a.label)}</span></div><div class="why" id="ap-why-${escape(a.id)}">${escape(a.reason)}</div>` +
      (a.content ? `<pre><code>${escape(a.content)}</code></pre>` : "") +
      `<input type="text" aria-label="Note for the model" placeholder="A note for the model (optional)"><div class="buttons">` +
      `<button class="allow" data-decide="allow" aria-describedby="ap-what-${escape(a.id)} ap-why-${escape(a.id)}">Allow</button>` +
      `<button data-decide="decline" aria-describedby="ap-what-${escape(a.id)}">Decline</button></div></div>`).join("");
    if (approvals !== shownApprovals) { // only when they change: a note you're typing stays put
      shownApprovals = approvals;
      const box = $("approvals");
      const had = /** @type {HTMLElement | null} */ (document.activeElement);
      const inside = had && box.contains(had) ? had : null;
      const card = /** @type {HTMLElement | null} */ (inside?.closest(".approval") || null)?.dataset.id;
      const what = inside ? (inside.tagName === "INPUT" ? "input" : `[data-decide="${inside.dataset.decide}"]`) : "";
      box.innerHTML = approvals;
      entrances(box, bornInComposer, false);
      if (inside) { // after Allow or Decline: the same place if the card is still there, else the next card, else the box
        const same = card ? box.querySelector(`.approval[data-id="${CSS.escape(card)}"] ${what}`) : null;
        /** @type {HTMLElement} */ (same || box.querySelector(".allow") || input).focus();
      }
    }
    // banner: redrawn only when it changes, so it's announced once and Resume keeps focus
    const banner = $("banner");
    // Another chat is working (or waiting for you, or finished meanwhile): say so, with a way back to it.
    const away = state.elsewhere;
    const awayText = !away ? "" : away.done ? (away.problem ? `"${away.title}" stopped: ${away.problem}` : `"${away.title}" is done.`)
      : away.waiting ? `"${away.title}" is waiting for your approval.` : `Solder is working in "${away.title}".`;
    const bannerClass = state.error && !state.busy ? "banner" + (state.error.stopped ? " soft" : "")
      : away ? "banner soft" + (away.waiting ? " waiting" : "") : "banner hidden";
    const bannerHtml = state.error && !state.busy ? (state.error.stopped ? ICONS.pause : ICONS.alert) + `<span class="msg">${escape(state.error.message)}` +
      (state.error.exhausted ? " Resume once it resets; everything so far is saved." : "") + "</span>" +
      (state.error.resumable && !(away && !away.done) ? `<button data-action="resume">Resume</button>` : "")
      : away ? (away.done ? (away.problem ? ICONS.pause : ICONS.check) : `<span class="spinner" aria-hidden="true"></span>`) + `<span class="msg">${escape(awayText)}</span>` +
        `<button data-open="${escape(away.id)}">${away.done ? "Open it" : "Go back"}</button>` : "";
    if (bannerClass + bannerHtml !== shownBanner) {
      shownBanner = bannerClass + bannerHtml;
      const hadFocus = banner.contains(document.activeElement);
      banner.className = bannerClass;
      banner.innerHTML = bannerHtml;
      if (hadFocus) /** @type {HTMLElement} */ (banner.querySelector("button") || input).focus();
    }
    input.placeholder = state.busy ? "Add to this: it goes with the next step…"
      : away && !away.done ? "Solder is working in another chat…" : "Ask Solder to read or change your code…";
    // chips
    const chips = [];
    if (state.workspace) {
      chips.push(`<button class="chip folder" data-action="folder" title="The folder you're working in: relative paths and searches start here. Click to change.">` +
        `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/></svg>${escape(folderLabel(state.folder) || state.workspaceName || "Workspace")}</button>` +
        (state.folder ? `<button class="chip clear" data-action="clearFolder" title="Back to the whole workspace" aria-label="Use the whole workspace">✕</button>` : ""));
    }
    if (editor.selection) chips.push(`<button class="chip${chipsOn.selection ? " on" : ""}" data-chip="selection" aria-pressed="${chipsOn.selection}" title="Send the selected lines with your message"><span aria-hidden="true">✂</span> ${escape(base(editor.file))}:${editor.selection}</button>`);
    else if (editor.file) chips.push(`<button class="chip${chipsOn.file ? " on" : ""}" data-chip="file" aria-pressed="${chipsOn.file}" title="Tell Solder which file is open">${escape(base(editor.file))}</button>`);
    if (chips.join("") !== shownChips) {
      shownChips = chips.join("");
      keepFocus($("chips"), () => { $("chips").innerHTML = shownChips; }, input);
    }
    // model
    const model = state.models.find((/** @type {any} */ m) => m.id === state.model);
    $("model-name").textContent = model ? model.name : state.model || "Choose a model";
    const models = state.models.length
      ? state.models.map((/** @type {any} */ m) => `<button role="menuitemradio" aria-checked="${m.id === state.model}" tabindex="-1" data-model="${escape(m.id)}" class="${m.id === state.model ? "active" : ""}">` +
        `<span>${escape(m.name)}</span>${m.name !== m.id ? `<span class="grey">${escape(m.id)}</span>` : ""}</button>`).join("")
      : `<div class="empty" role="menuitem" aria-disabled="true" tabindex="-1">No models listed.</div>`;
    if (models !== shownModels) { shownModels = models; $("model-menu").innerHTML = models; } // an open menu doesn't flicker
    // effort
    const level = state.effort === "default" ? "low" : state.effort;
    for (const button of $("effort").querySelectorAll("button")) {
      button.classList.toggle("active", button.dataset.level === level);
      button.setAttribute("aria-pressed", String(button.dataset.level === level));
    }
    // send / stop
    $("send").classList.toggle("hidden", state.busy && !input.value.trim());
    $("stop").classList.toggle("hidden", !state.busy);
    $("send").classList.toggle("idle", !input.value.trim());
    $("send").title = state.busy ? "Send with the next step (Enter)" : "Send (Enter)";
    // footer
    const footer = [];
    if (state.chat.tokens) footer.push(`<span title="Tokens this chat has used">${compact(state.chat.tokens)} tokens</span>`);
    const share = state.credits && state.credits.limit ? Math.max(0, Math.min(1, state.credits.remaining / state.credits.limit)) : 0;
    if (state.credits) footer.push(`<span class="left" title="${state.credits.remaining.toLocaleString()} of ${state.credits.limit.toLocaleString()} left">` +
      `${state.credits.limit ? `<span class="meter${share < 0.15 ? " low" : ""}"></span>` : ""}${compact(state.credits.remaining)} left</span>`);
    $("footer").innerHTML = footer.join("");
    /** @type {HTMLElement | null} */ (document.querySelector("#footer .meter"))?.style.setProperty("--fill", share.toFixed(3));
  }

  /** A finished step's time: "1.4s", "12s", "1:05". @param {number} ms */
  function duration(ms) {
    const s = ms / 1000;
    return s < 10 ? s.toFixed(1) + "s" : s < 60 ? Math.round(s) + "s" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  }

  /** A running step's clock, from the first second: "3s", "1:05". @param {number} ms */
  function elapsed(ms) {
    const s = Math.floor(ms / 1000);
    return s < 1 ? "" : s < 60 ? s + "s" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  /** @param {string} file */
  function base(file) { return file.split("/").pop() || file; }

  /** The working folder on its chip: relative as it is; a full path (another workspace folder) by its last two parts. @param {string} folder */
  function folderLabel(folder) {
    if (!/^([A-Za-z]:)?[\\/]/.test(folder)) return folder;
    return folder.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
  }

  /** @param {number} n */
  function compact(n) {
    return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k" : String(n);
  }

  /** Whether the dropdown shows the archived chats (folded away by default). */
  let archivedOpen = false;

  /** The chats dropdown: pinned first, then by age (today, the last 7 and 30 days, older), archived folded at the end. */
  function renderChatMenu() {
    const now = Date.now();
    const day = 86400000;
    const item = (/** @type {any} */ c) =>
      `<button role="menuitemradio" aria-checked="${c.id === state.chat.id}" tabindex="-1" data-open="${escape(c.id)}" data-pinned="${!!c.pinned}" data-archived="${!!c.archived}" class="${c.id === state.chat.id ? "active" : ""}"` +
      ` aria-haspopup="menu" aria-keyshortcuts="Shift+F10">${c.pinned ? `<svg class="pin" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2.5h4l-.5 4 2 2v1h-7v-1l2-2zM8 9.5V14"/></svg>` : ""}` +
      `<span>${escape(c.title)}</span><span class="when">${ago(now - c.updated)}</span></button>`;
    const live = state.chats.filter((/** @type {any} */ c) => !c.archived);
    const archived = state.chats.filter((/** @type {any} */ c) => c.archived);
    /** @type {[string, any[]][]} */
    const groups = [
      ["Pinned", live.filter((/** @type {any} */ c) => c.pinned)],
      ["Today", live.filter((/** @type {any} */ c) => !c.pinned && now - c.updated < day)],
      ["Last 7 days", live.filter((/** @type {any} */ c) => !c.pinned && now - c.updated >= day && now - c.updated < 7 * day)],
      ["Last 30 days", live.filter((/** @type {any} */ c) => !c.pinned && now - c.updated >= 7 * day && now - c.updated < 30 * day)],
      ["Older", live.filter((/** @type {any} */ c) => !c.pinned && now - c.updated >= 30 * day)],
    ];
    let html = groups.filter(([, list]) => list.length)
      .map(([name, list]) => `<div class="group" role="presentation">${name}</div>` + list.map(item).join("")).join("");
    if (archived.length) {
      html += `<button class="fold" role="menuitem" tabindex="-1" data-fold="archived" aria-expanded="${archivedOpen}">Archived · ${archived.length}<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5 8 10l3.5-3.5"/></svg></button>` +
        (archivedOpen ? archived.map(item).join("") : "");
    }
    $("chat-menu").innerHTML = html || `<div class="empty" role="menuitem" aria-disabled="true" tabindex="-1">No saved chats yet.</div>`;
  }

  // ---- the right-click menu on a chat: pin, rename, fork, archive, delete ----
  const chatActions = $("chat-actions");
  /** The chat it was opened on, and that chat's row (focus goes back to it). @type {HTMLElement | null} */
  let actionsFor = null;
  /** @param {HTMLElement} row @param {number} x @param {number} y */
  function openChatActions(row, x, y) {
    actionsFor = row;
    const pinned = row.dataset.pinned === "true";
    const archived = row.dataset.archived === "true";
    const entry = (/** @type {string} */ action, /** @type {string} */ label) => `<button role="menuitem" tabindex="-1" data-chat-action="${action}">${label}</button>`;
    chatActions.innerHTML = [
      archived ? "" : entry(pinned ? "unpin" : "pin", pinned ? "Unpin" : "Pin"),
      entry("rename", "Rename…"),
      entry("fork", "Fork"),
      entry(archived ? "unarchive" : "archive", archived ? "Unarchive" : "Archive"),
      `<div class="sep" role="separator"></div>`,
      entry("delete", "Delete…"),
    ].join("");
    chatActions.classList.remove("hidden");
    // Where the pointer is, kept inside the panel.
    const width = chatActions.offsetWidth;
    const height = chatActions.offsetHeight;
    chatActions.style.left = Math.max(4, Math.min(x, window.innerWidth - width - 4)) + "px";
    chatActions.style.top = Math.max(4, Math.min(y, window.innerHeight - height - 4)) + "px";
    /** @type {HTMLElement | null} */ (chatActions.querySelector("button"))?.focus();
  }
  function closeChatActions(/** @type {boolean} */ refocus) {
    if (chatActions.classList.contains("hidden")) return;
    chatActions.classList.add("hidden");
    if (refocus && actionsFor && document.body.contains(actionsFor)) actionsFor.focus();
  }
  $("chat-menu").addEventListener("contextmenu", (event) => {
    const row = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest("[data-open]"));
    event.preventDefault();
    if (row) openChatActions(row, event.clientX, event.clientY);
  });
  $("chat-menu").addEventListener("keydown", (event) => {
    const row = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest("[data-open]"));
    if (!row || !(event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) return;
    event.preventDefault();
    event.stopPropagation();
    const box = row.getBoundingClientRect();
    openChatActions(row, box.left + 24, box.bottom);
  });
  chatActions.addEventListener("keydown", (event) => {
    const items = /** @type {HTMLElement[]} */ ([...chatActions.querySelectorAll("button")]);
    const at = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeChatActions(true); return; }
    if (event.key === "Tab") { event.preventDefault(); closeChatActions(true); return; }
    const to = event.key === "ArrowDown" ? (at + 1) % items.length : event.key === "ArrowUp" ? (at <= 0 ? items.length - 1 : at - 1)
      : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : -1;
    if (to >= 0) { event.preventDefault(); items[to].focus(); }
  });
  chatActions.addEventListener("click", (event) => {
    event.stopPropagation();
    const button = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest("[data-chat-action]"));
    if (!button || !actionsFor) return;
    const action = button.dataset.chatAction;
    const id = actionsFor.dataset.open;
    closeChatActions(false);
    // Rename and delete ask in VS Code itself; fork opens the copy: the dropdown closes for those.
    if (action === "rename" || action === "delete" || action === "fork") closeMenus();
    vscode.postMessage({ type: "chatAction", action, id });
  });

  /** @param {number} ms */
  function ago(ms) {
    const m = Math.round(ms / 60000);
    return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  }

  const STILL_WORKING = "Still working: a long file or answer can take a minute or two…";
  /** When the streamed words last moved: a reply that's gone quiet after them is writing a tool call. */
  let liveMovedAt = Date.now();
  /** @param {number} [seconds] */
  function quietLabel(seconds = (Date.now() - liveMovedAt) / 1000) {
    return seconds >= 20 ? STILL_WORKING : "Thinking…";
  }

  // the "Thinking…" clock: after 15 s of quiet, show how long it's been
  setInterval(() => {
    const after = document.getElementById("after-live");
    if (after) {
      const quiet = (Date.now() - liveMovedAt) / 1000;
      after.classList.toggle("waiting", !state?.status && (quiet < 2 || !!reveal.buffer));
      const what = after.querySelector(".what");
      if (what && !state?.status) what.textContent = quietLabel(quiet);
      const clock = after.querySelector(".clock");
      if (clock) clock.textContent = quiet >= 15 ? `${Math.floor(quiet / 60)}:${String(Math.floor(quiet % 60)).padStart(2, "0")}` : "";
    }
    for (const time of document.querySelectorAll(".step .time[data-since]")) {
      time.textContent = elapsed(Date.now() - Number(/** @type {HTMLElement} */ (time).dataset.since));
    }
    const clock = document.querySelector("#status .clock");
    if (!clock) return;
    const seconds = Math.floor((Date.now() - thinkingSince) / 1000);
    clock.textContent = seconds >= 15 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "";
    const label = document.querySelector("#status .what");
    if (label && seconds >= 15 && state?.effort === "high" && !state.status.includes("…")) label.textContent = "Thinking hard on High effort…";
    else if (label && seconds >= 20 && (!state?.status || state.status === "Thinking…")) label.textContent = STILL_WORKING;
  }, 1000);

  // ------------------------------------------------- the fade-in (as Alloy) --
  // One word per tick, each fading in where it lands in the formatted text. Only a backlog (a burst from
  // the gateway, or the reply already finished) speeds it up, so the text never falls far behind.

  const FADE_MS = 900; // keep in step with .fade in panel.css
  const TICK_MS = 30;
  const reveal = { received: "", shown: "", buffer: "", /** @type {{text: string, born: number}[]} */ spans: [],
    /** @type {any} */ timer: null, /** @type {any} */ pending: null };

  function resetReveal() {
    if (reveal.timer) clearTimeout(reveal.timer);
    Object.assign(reveal, { received: "", shown: "", buffer: "", spans: [], timer: null });
  }

  /** @param {any} message */
  function applyState(message) {
    const was = state;
    if (!was || was.status !== message.status || !message.busy) thinkingSince = Date.now();
    if (!was || was.chat.id !== message.chat.id) { open.clear(); stickToBottom = true; resetReveal(); }
    if (!message.live) resetReveal(); // that stream is now a saved answer (or none has started)
    announceChanges(was, message);
    state = message;
    render();
  }

  function stepReveal() {
    reveal.timer = null;
    const now = performance.now();
    if (reveal.buffer) {
      const backlog = reveal.pending ? 120 : 360;
      let take = reveal.buffer.length > backlog ? Math.min(18, Math.ceil(reveal.buffer.length / 30)) : 1;
      const space = reveal.buffer.indexOf(" ", Math.max(1, take));
      if (space !== -1 && space - take <= 14) take = space + 1;
      else if (space === -1 && reveal.buffer.length <= 14) take = reveal.buffer.length;
      const chunk = reveal.buffer.slice(0, take);
      reveal.buffer = reveal.buffer.slice(take);
      reveal.shown += chunk;
      liveMovedAt = Date.now();
      reveal.spans.push({ text: chunk, born: now });
    }
    reveal.spans = reveal.spans.filter((span) => now - span.born < FADE_MS);
    paintLive(now);
    if (reveal.buffer || (reveal.pending && reveal.spans.length)) {
      reveal.timer = setTimeout(stepReveal, TICK_MS);
    } else if (reveal.pending) {
      const next = reveal.pending;
      reveal.pending = null;
      applyState(next);
    }
  }

  /** @param {number} now */
  function paintLive(now) {
    let live = document.getElementById("live");
    if (!live) { renderTranscript(); live = document.getElementById("live"); if (!live) return; }
    const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
    live.innerHTML = markdown(closeOpenMarks(reveal.shown));
    fadeNewest(live, reveal.spans, now);
    if (atBottom) transcript.scrollTop = transcript.scrollHeight;
  }

  /** A **bold** or `code` opened on the last line isn't closed yet: close it for showing. @param {string} text */
  function closeOpenMarks(text) {
    const opening = text.match(/(^|\n)[ \t]*`{1,3}[\w+#.-]*$/);
    if (opening) text = text.slice(0, opening.index);
    if (((text.match(/```/g) || []).length) % 2 === 1) return text;
    const lastLine = text.slice(text.lastIndexOf("\n") + 1);
    let closing = "";
    if (((lastLine.replace(/```/g, "").match(/`/g) || []).length) % 2 === 1) closing += "`";
    const outside = lastLine.replace(/`[^`]*`?/g, "");
    if (((outside.match(/\*\*/g) || []).length) % 2 === 1) closing += "**";
    return closing ? text + closing : text;
  }

  /** Wrap the newest characters in fading spans, each chunk on its own clock. */
  function fadeNewest(/** @type {HTMLElement} */ container, /** @type {{text: string, born: number}[]} */ spans, /** @type {number} */ now) {
    const shown = (/** @type {string} */ text) => text.replace(/^\s*(?:[-+*]|\d+\.)\s+/gm, "").replace(/^\s*#{1,6}\s+/gm, "")
      .replace(/^\s*>\s?/gm, "").replace(/\*\*|__|`|\*/g, "").replace(/\s+/g, "");
    const nodes = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => node.parentElement?.closest("button") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    while (walker.nextNode()) nodes.push(/** @type {Text} */ (walker.currentNode));
    let index = nodes.length - 1;
    for (let s = spans.length - 1; s >= 0 && index >= 0; s--) {
      let need = shown(spans[s].text).length;
      const age = Math.max(0, Math.min(FADE_MS - 10, Math.round(now - spans[s].born)));
      while (need > 0 && index >= 0) {
        const node = nodes[index];
        const text = node.nodeValue || "";
        let cut = text.length;
        let counted = 0;
        while (cut > 0 && counted < need) { cut--; if (!/\s/.test(text[cut])) counted++; }
        if (counted === 0) { index--; continue; }
        const piece = cut > 0 ? node.splitText(cut) : node;
        const wrap = document.createElement("span");
        wrap.className = "fade";
        wrap.style.animationDelay = `-${age}ms`;
        piece.parentNode?.insertBefore(wrap, piece);
        wrap.appendChild(piece);
        need -= counted;
        if (cut === 0) index--;
      }
    }
  }

  // ------------------------------------------------------------------ events --

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "state") {
      // While words are still appearing, the next state (the finished answer, the next step) waits.
      if (reveal.timer && state && message.chat.id === state.chat.id) { reveal.pending = message; return; }
      applyState(message);
    } else if (message.type === "live" && state) {
      if (!message.text.startsWith(reveal.received)) resetReveal();
      reveal.buffer += message.text.slice(reveal.received.length);
      reveal.received = message.text;
      if (!reveal.timer) stepReveal();
    } else if (message.type === "editor") {
      if (message.selection !== editor.selection) chipsOn.selection = true;
      editor.file = message.file;
      editor.selection = message.selection;
      if (state) renderComposer();
    } else if (message.type === "restore") {
      if (!input.value.trim()) { input.value = message.text; autosize(); }
    } else if (message.type === "attachSelection") {
      // "Add to chat" from the editor: the selection chip on, the cursor in the box.
      chipsOn.selection = true;
      if (state) renderComposer();
      input.focus();
    }
  });

  // ------------------------------------------------------------ slash commands --

  /** What "/" offers. The extension runs them (src/panel.js, command); /help opens the guide, and a bare /model the model menu. */
  const COMMANDS = [
    { name: "new", about: "Start a new chat" },
    { name: "fork", about: "Carry on in a copy of this chat" },
    { name: "compact", hint: "what to keep", about: "Summarise this chat now, to save tokens" },
    { name: "rename", hint: "name", about: "Rename this chat" },
    { name: "model", hint: "name", about: "Switch this chat's model" },
    { name: "effort", hint: "low, medium or high", about: "How hard this chat thinks" },
    { name: "review", about: "Review what's changed since the last commit" },
    { name: "settings", about: "Open Solder's settings" },
    { name: "help", about: "Open Solder's guide" },
  ];
  const slash = $("slash");
  /** @type {typeof COMMANDS} the commands the list shows now */
  let slashShown = [];
  let slashAt = 0;

  /** The list follows the box: open while it holds just "/" and the start of a command's name. */
  function renderSlash() {
    const typed = /^\/(\S*)$/.exec(input.value);
    if (!typed || !state) { hideSlash(); return; }
    const word = typed[1].toLowerCase();
    slashShown = COMMANDS.filter((c) => c.name.startsWith(word));
    slashAt = Math.min(slashAt, Math.max(0, slashShown.length - 1));
    slash.innerHTML = slashShown.length
      ? slashShown.map((c, i) => `<div role="option" id="slash-${i}" class="slash-item${i === slashAt ? " active" : ""}" aria-selected="${i === slashAt}" data-slash="${i}">` +
          `<span class="cmd">/${c.name}${c.hint ? ` <i>${escape(c.hint)}</i>` : ""}</span><span class="about">${escape(c.about)}</span></div>`).join("")
      : `<div class="slash-none">No command starts with that: Enter sends it as a message.</div>`;
    slash.classList.remove("hidden");
    if (slashShown.length) input.setAttribute("aria-activedescendant", `slash-${slashAt}`);
    else input.removeAttribute("aria-activedescendant");
    // Keep the chosen one in view by scrolling the list only (scrollIntoView would move the whole panel).
    const active = /** @type {HTMLElement | null} */ (slash.querySelector(".active"));
    if (active) {
      if (active.offsetTop < slash.scrollTop) slash.scrollTop = active.offsetTop;
      else if (active.offsetTop + active.offsetHeight > slash.scrollTop + slash.clientHeight) slash.scrollTop = active.offsetTop + active.offsetHeight - slash.clientHeight;
    }
  }
  function hideSlash() {
    slash.classList.add("hidden");
    slashShown = [];
    slashAt = 0;
    input.removeAttribute("aria-activedescendant");
  }
  /** Picking one: a command that takes something is completed in the box; the others run at once. @param {number} index */
  function pickSlash(index) {
    const command = slashShown[index];
    if (!command) return;
    hideSlash();
    if (command.hint) {
      input.value = `/${command.name} `;
      autosize();
      vscode.setState({ draft: input.value });
      input.focus();
      return;
    }
    clearBox();
    runCommand(command.name, "");
  }
  /** @param {string} name @param {string} arg */
  function runCommand(name, arg) {
    if (name === "help") { vscode.postMessage({ type: "guide" }); return; }
    if (name === "model" && !arg) { toggle("model-menu"); return; }
    if (name === "new" || name === "fork" || name === "review") stickToBottom = true;
    vscode.postMessage({ type: "command", name, arg });
  }
  function clearBox() {
    input.value = "";
    autosize();
    vscode.setState({ draft: "" });
  }
  // Clicking a command: mousedown, so the box keeps its focus.
  slash.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const item = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest("[data-slash]"));
    if (item) pickSlash(Number(item.dataset.slash));
  });
  input.addEventListener("blur", hideSlash);

  function send() {
    const text = input.value.trim();
    if (!text || !state) return;
    // "/name what" for a command we have runs it; anything else that starts with "/" goes as a message.
    const typed = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text);
    if (typed && COMMANDS.some((c) => c.name === typed[1].toLowerCase())) {
      hideSlash();
      clearBox();
      runCommand(typed[1].toLowerCase(), (typed[2] || "").trim());
      return;
    }
    vscode.postMessage({ type: "send", text, selection: !!editor.selection && chipsOn.selection, file: !!editor.file && chipsOn.file });
    replay($("send"), "launch");
    input.value = "";
    stickToBottom = true;
    autosize();
    vscode.setState({ draft: "" });
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + "px";
    if (state) $("send").classList.toggle("hidden", state.busy && !input.value.trim());
    $("send").classList.toggle("idle", !input.value.trim());
  }

  input.addEventListener("input", () => { autosize(); vscode.setState({ draft: input.value }); renderSlash(); });
  input.addEventListener("keydown", (event) => {
    const open = !slash.classList.contains("hidden");
    if (open && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); hideSlash(); return; } // not Stop
    if (open && slashShown.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        slashAt = (slashAt + (event.key === "ArrowDown" ? 1 : slashShown.length - 1)) % slashShown.length;
        renderSlash();
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey && !event.isComposing) || event.key === "Tab") {
        event.preventDefault();
        pickSlash(slashAt);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!document.querySelectorAll(".menu:not(.hidden)").length && state?.busy) vscode.postMessage({ type: "stop" });
      closeMenus();
    }
  });
  $("send").addEventListener("click", send);
  $("stop").addEventListener("click", () => vscode.postMessage({ type: "stop" }));
  $("btn-new").addEventListener("click", () => { vscode.postMessage({ type: "new" }); input.focus(); });

  /** Each menu and the button that opens it (its chevron turns while it's open). */
  const OPENERS = { "chat-menu": "chat-title", "more-menu": "btn-more", "model-menu": "model-button" };
  /** A menu's items, in order. @param {Element} menu */
  function menuItems(menu) { return /** @type {HTMLElement[]} */ ([...menu.querySelectorAll('[role^="menuitem"]')]); }
  /** Closes the menus; one that had focus gives it back to its button. */
  function closeMenus(except = "") {
    for (const menu of document.querySelectorAll(".menu")) if (menu.id !== except) {
      const opener = document.getElementById(OPENERS[/** @type {keyof typeof OPENERS} */ (menu.id)] || "");
      const hadFocus = !menu.classList.contains("hidden") && menu.contains(document.activeElement);
      menu.classList.add("hidden");
      opener?.setAttribute("aria-expanded", "false");
      if (hadFocus) opener?.focus();
    }
  }
  /** @param {string} id @param {boolean} [last] focus the last item rather than the chosen one */
  function toggle(id, last = false) {
    const menu = $(id);
    const show = menu.classList.contains("hidden");
    closeMenus();
    if (show) {
      if (id === "chat-menu") renderChatMenu();
      menu.classList.remove("hidden");
      document.getElementById(OPENERS[/** @type {keyof typeof OPENERS} */ (id)])?.setAttribute("aria-expanded", "true");
      const items = menuItems(menu);
      /** @type {HTMLElement | undefined} */ (last ? items[items.length - 1] : menu.querySelector('[aria-checked="true"]') || items[0])?.focus();
    }
  }
  $("chat-title").addEventListener("click", (e) => { e.stopPropagation(); toggle("chat-menu"); });
  $("btn-more").addEventListener("click", (e) => { e.stopPropagation(); toggle("more-menu"); });
  $("model-button").addEventListener("click", (e) => { e.stopPropagation(); toggle("model-menu"); });
  for (const [menuId, openerId] of Object.entries(OPENERS)) {
    // the arrows open a menu from its button
    $(openerId).addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      if ($(menuId).classList.contains("hidden")) toggle(menuId, event.key === "ArrowUp");
    });
    // inside: the arrows, Home and End move; Tab closes (Escape is handled below, with Stop)
    $(menuId).addEventListener("keydown", (event) => {
      const items = menuItems($(menuId));
      const n = items.length;
      const at = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
      if (event.key === "Tab") { event.preventDefault(); closeMenus(); return; }
      const to = !n ? -1 : event.key === "ArrowDown" ? (at + 1) % n : event.key === "ArrowUp" ? (at <= 0 ? n - 1 : at - 1)
        : event.key === "Home" ? 0 : event.key === "End" ? n - 1 : -1;
      if (to >= 0) { event.preventDefault(); items[to].focus(); }
    });
  }

  document.addEventListener("click", (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    if (!target.closest("#chat-actions")) closeChatActions(false);
    const el = /** @type {HTMLElement | null} */ (target.closest("[data-fold],[data-action],[data-starter],[data-sact],[data-sfield],[data-setup],[data-pick-model],[data-open],[data-model],[data-level],[data-chip],[data-undo],[data-review],[data-decide],[data-unsteer],[data-step],[data-path],pre .copy,.step-head"));
    if (!target.closest(".menu")) closeMenus();
    if (!el) return;
    const d = el.dataset;
    if (d.action) { closeMenus(); vscode.postMessage({ type: d.action }); }
    else if (d.starter) { stickToBottom = true; vscode.postMessage({ type: "starter", id: d.starter }); }
    else if (d.sact) {
      if (el.hasAttribute("disabled")) return;
      if (d.sact === "close") focusInput = true;
      if (d.sact === "key") {
        const key = /** @type {HTMLInputElement | null} */ (document.getElementById("settings-key"))?.value ?? "";
        if (key.trim()) vscode.postMessage({ type: "settingsScreen", action: "key", key });
      } else if (d.sact === "clearKey") vscode.postMessage({ type: "settingsScreen", action: "key", key: "" });
      else vscode.postMessage({ type: "settingsScreen", action: d.sact, index: d.index !== undefined ? Number(d.index) : undefined });
    } else if (d.sfield) vscode.postMessage({ type: "settingsScreen", action: "set", field: d.sfield, value: d.value });
    else if (d.setup) {
      closeMenus();
      if (el.hasAttribute("disabled")) return;
      if (d.setup === "finish" || d.setup === "cancel") focusInput = true;
      const extra = d.setup === "next" ? setupValues() : d.setup === "removeDocs" ? { index: Number(d.index) } : {};
      if (d.setup === "removeDocs" && setupDraft) setupDraft = Object.fromEntries(Object.entries(setupDraft).filter(([k]) => !k.startsWith("about-")));
      vscode.postMessage({ type: "setup", action: d.setup, ...extra });
    } else if (d.pickModel) pickModel(el);
    else if (d.open) { closeMenus(); vscode.postMessage({ type: "open", id: d.open }); }
    else if (d.fold === "archived") { archivedOpen = !archivedOpen; renderChatMenu(); /** @type {HTMLElement | null} */ ($("chat-menu").querySelector('[data-fold="archived"]'))?.focus(); }
    else if (d.model) { closeMenus(); vscode.postMessage({ type: "model", id: d.model }); }
    else if (d.level) vscode.postMessage({ type: "effort", level: d.level });
    else if (d.chip) { chipsOn[/** @type {"file"|"selection"} */ (d.chip)] = !chipsOn[/** @type {"file"|"selection"} */ (d.chip)]; renderComposer(); replay(document.querySelector(`[data-chip="${d.chip}"]`), "flip"); }
    else if (d.undo) vscode.postMessage({ type: "undo", id: d.undo });
    else if (d.unsteer !== undefined) vscode.postMessage({ type: "unsteer", index: Number(d.unsteer) });
    else if (d.review) vscode.postMessage({ type: "review", id: d.review });
    else if (d.decide) {
      const card = /** @type {HTMLElement} */ (el.closest(".approval"));
      const note = /** @type {HTMLInputElement} */ (card.querySelector("input")).value;
      vscode.postMessage({ type: "decide", id: card.dataset.id, decision: d.decide, note });
    } else if (d.step) {
      open.has(d.step) ? open.delete(d.step) : open.add(d.step);
      renderTranscript();
    } else if (d.path !== undefined) {
      event.preventDefault();
      const [file, line] = String(d.path).split(/:(\d+)$/);
      vscode.postMessage({ type: "openFile", path: file, line: line ? Number(line) : undefined });
    } else if (el.matches("pre .copy")) {
      const code = el.parentElement?.querySelector("code")?.textContent || "";
      navigator.clipboard.writeText(code).then(() => {
        announce("Copied");
        el.textContent = "Copied";
        el.classList.add("done");
        setTimeout(() => { el.textContent = "Copy"; el.classList.remove("done"); }, 1200);
      });
    } else if (el.matches(".step-head") && !target.closest(".acts")) {
      // the row around a step's label toggles it too, for the mouse
      /** @type {HTMLElement | null} */ (el.querySelector("[data-step]"))?.click();
    }
  });

  autosize();
  vscode.postMessage({ type: "ready" });
  // @ts-ignore: for the browser preview harness
  window.__solder = { markdown };
})();
