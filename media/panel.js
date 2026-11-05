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
        ? `<a href="${href}" title="${href}">${label}</a>` : `<code class="path" data-path="${href}">${label}</code>`);
    return text.replace(/\u0000(\d+)\u0000/g, (_m, n) => {
      const code = codes[Number(n)];
      return PATHLIKE.test(code.trim()) ? `<code class="path" data-path="${escape(code.trim())}">${escape(code)}</code>` : `<code>${escape(code)}</code>`;
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

  function render() {
    if (!state) return;
    $("chat-title-text").textContent = state.setup ? "Set up Solder" : state.chat.title;
    document.body.classList.toggle("in-setup", !!state.setup);
    document.body.classList.toggle("busy", !!state.busy && !state.setup);
    if (state.setup) { renderSetup(); return; }
    setupDraft = null;
    setupShown = "";
    renderTranscript();
    renderComposer();
  }

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
    if (s.step === "endpoint") {
      body = `<input id="setup-endpoint" class="field" type="url" spellcheck="false" placeholder="https://gateway.example.com/v1/chat/completions" value="${keep("setup-endpoint", s.endpoint)}">`;
    } else if (s.step === "key") {
      body = `<input id="setup-key" class="field" type="password" placeholder="${s.hasKey ? "A key is saved: leave empty to keep it" : "Paste your key"}" value="${keep("setup-key", "")}">` +
        `<div class="hint">${s.hasKey ? "A key is already saved." : "A local server may not need one: leave it empty."}</div>`;
    } else if (s.step === "model") {
      const chosen = setupDraft["setup-model"] ?? s.model;
      body = s.models.length
        ? `<div class="pick">${s.models.map((/** @type {any} */ m) => `<button class="option${m.id === chosen ? " on" : ""}" data-pick-model="${escape(m.id)}">` +
            `<span class="radio"></span><span>${escape(m.name)}</span>${m.name !== m.id ? `<span class="grey">${escape(m.id)}</span>` : ""}</button>`).join("")}</div>`
        : `<input id="setup-model-typed" class="field" spellcheck="false" placeholder="The model's id" value="${keep("setup-model-typed", s.model)}">` +
          `<div class="hint">The models couldn't be listed, so type the id your gateway uses.</div>`;
    } else if (s.step === "docs") {
      body = `<div class="docs">${s.docs.map((/** @type {any} */ d, /** @type {number} */ i) => `<div class="doc"><div class="doc-path" title="${escape(d.path)}">` +
          `<svg viewBox="0 0 16 16"><path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/></svg><span>${escape(d.path)}</span>` +
          `<button data-setup="removeDocs" data-index="${i}" title="Remove" aria-label="Remove">✕</button></div>` +
          `<input class="field about" data-about="${i}" placeholder="What's in it? For example: PX-40 schematics and the FooBus API" value="${keep("about-" + i, d.about)}"></div>`).join("")}</div>` +
        `<button class="link-button" data-setup="addDocs">Add a folder…</button>`;
    } else if (s.step === "rules") {
      body = `<textarea id="setup-rules" class="field area" rows="5" placeholder="We target Python 3.10 and Node 18.&#10;Use tabs, not spaces.&#10;Never edit files under generated/.">${keep("setup-rules", s.rules)}</textarea>`;
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
      : `<div class="progress"><div class="dots">${dots}</div><span class="count">${at + 1} of ${order.length}</span></div>`;
    transcript.innerHTML = `<div class="setup${fresh ? " enter" : ""}${back ? " back" : ""}">${progress}<h2>${escape(title)}</h2>` +
      `<p class="intro">${intro}</p>${body}${error}${buttons}</div>`;
    const first = /** @type {HTMLElement | null} */ (transcript.querySelector(".field"));
    if (fresh && first) setTimeout(() => first.focus(), 60);
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
  });

  let shownChat = ""; // the chat the transcript last showed: a different one arrives without a parade

  function renderTranscript() {
    const items = state.chat.items;
    const quiet = shownChat !== state.chat.id;
    if (quiet && shownChat) replay(transcript, "swap");
    shownChat = state.chat.id;
    const parts = [];
    if (!items.length && !state.busy) parts.push(welcome());
    let inSteps = false; // consecutive steps share one timeline
    const endSteps = () => { if (inSteps) parts.push("</div>"); inSteps = false; };
    items.forEach((/** @type {any} */ item, /** @type {number} */ index) => {
      if (item.kind === "step") {
        if (!inSteps) parts.push(`<div class="steps">`);
        inSteps = true;
        parts.push(step(item));
        return;
      }
      endSteps();
      if (item.kind === "user") {
        parts.push(`<div class="user${item.resume ? " resume" : ""}" data-enter="i:u${index}">${escape(item.text)}` +
          (item.chips.length ? `<div class="chips">${item.chips.map((/** @type {string} */ c) => `<span class="chip">${escape(c)}</span>`).join("")}</div>` : "") + "</div>");
      } else if (item.kind === "answer") {
        // no entrance: an answer arrives word by word, through the fade-in
        parts.push(`<div class="answer${item.incomplete ? " incomplete" : ""}">${markdown(item.text)}</div>`);
      } else if (item.kind === "note") {
        parts.push(`<div class="note" data-enter="i:n${index}">${escape(item.text)}</div>`);
      }
    });
    if (state.busy) {
      const stepRunning = items.some((/** @type {any} */ i) => i.kind === "step" && i.running);
      if (reveal.shown) { endSteps(); parts.push(`<div class="answer" id="live">${markdown(closeOpenMarks(reveal.shown))}</div>`); }
      else if (!stepRunning || state.status) {
        // after steps, the status is the timeline's next node
        parts.push(`<div class="status" id="status" data-enter="s:status"><span class="spinner"></span><span class="what">${escape(state.status || "Working…")}</span><span class="clock"></span></div>`);
      }
    }
    endSteps();
    // 2. What you typed meanwhile, waiting to go with the next step (✕ takes it back into the box).
    for (const [index, text] of (state.busy ? state.steers || [] : []).entries()) {
      parts.push(`<div class="user queued" data-enter="q:${escape(text)}">${escape(text)}<div class="queued-note">${ICONS.clock}<span>Goes with the next step</span>` +
        `<button data-unsteer="${index}" title="Take it back (into the box)" aria-label="Take it back">✕</button></div></div>`);
    }
    const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
    transcript.innerHTML = parts.join("");
    entrances(transcript, bornInTranscript, quiet);
    if (atBottom || stickToBottom) transcript.scrollTop = transcript.scrollHeight;
    stickToBottom = false;
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
      ? `<span class="acts">${item.removed ? "" : `<button data-review="${item.id}">Review</button>`}${item.undone ? "" : `<button data-undo="${item.id}">Undo</button>`}</span>` : "";
    const label = item.pending ? item.label : (item.summary || item.label) + (item.undone ? " · undone" : "");
    const shown = open.has(item.id) && !!item.output;
    const body = shown ? `<pre class="out" data-enter="o:${item.id}"><code>${escape(item.output)}</code></pre>` : "";
    const time = item.running && item.since ? `<span class="time" data-since="${item.since}">${elapsed(Date.now() - item.since)}</span>`
      : !item.pending && item.ms >= 1000 ? `<span class="time" title="How long this step took">${duration(item.ms)}</span>` : "";
    const steered = item.steer ? `<div class="steered" data-enter="t:${item.id}"><span class="who">You, with this step</span>${escape(item.steer)}</div>` : "";
    // the head's key changes as the step finishes (or is undone), so its mark pops and draws once
    const settled = item.pending ? "" : ` data-enter="d:${item.id}${item.failed ? ":failed" : ""}${item.undone ? ":undone" : ""}"`;
    return `<div class="step ${cls}${item.undone ? " undone" : ""}${shown ? " open" : ""}" data-enter="i:${item.id}"><div class="step-head" data-step="${item.id}" role="button" tabindex="0"${settled}>` +
      `<span class="mark">${mark}</span><span class="label" title="${escape(label)}">${stepLabel(item, label)}</span>${item.output ? ICONS.more : ""}${time}${acts}</div>${body}${steered}</div>`;
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
    const feature = (/** @type {string} */ icon, /** @type {string} */ html) => `<li><span class="ico">${icon}</span><span>${html}</span></li>`;
    return `<div class="welcome" data-enter="w:${state.chat.id}"><div class="logo">${ICONS.solder}</div><h2>Solder</h2>` +
      `<p class="lead">Ask about your code, or for a change.</p><ul class="features">` +
      feature(ICONS.search, "<b>Reads and searches</b> your workspace") +
      feature(ICONS.edit, "<b>Edits</b>, then checks for problems") +
      feature(ICONS.undo, "<b>Every change</b> can be reviewed and undone") + "</ul>" +
      (state.workspace ? `<p class="hint"><kbd>Enter</kbd> sends, <kbd>Shift</kbd>+<kbd>Enter</kbd> adds a line.</p>`
        : `<p class="aside">Open a folder first: Solder works inside a workspace.</p>`) + "</div>";
  }

  let shownApprovals = "";
  let shownModels = "";

  function renderComposer() {
    // approvals
    const approvals = state.approvals.map((/** @type {any} */ a) => `<div class="approval" data-id="${a.id}" data-enter="a:${a.id}" role="alert">` +
      `<div class="what">${ICONS.shield}<span>${escape(a.label)}</span></div><div class="why">${escape(a.reason)}</div>` +
      (a.content ? `<pre><code>${escape(a.content)}</code></pre>` : "") +
      `<input type="text" placeholder="A note for the model (optional)"><div class="buttons">` +
      `<button class="allow" data-decide="allow">Allow</button><button data-decide="decline">Decline</button></div></div>`).join("");
    if (approvals !== shownApprovals) { // only when they change: a note you're typing stays put
      shownApprovals = approvals;
      $("approvals").innerHTML = approvals;
      entrances($("approvals"), bornInComposer, false);
    }
    // banner
    const banner = $("banner");
    if (state.error && !state.busy) {
      banner.className = "banner" + (state.error.stopped ? " soft" : "");
      banner.innerHTML = (state.error.stopped ? ICONS.pause : ICONS.alert) + `<span class="msg">${escape(state.error.message)}` +
        (state.error.exhausted ? " Resume once it resets; everything so far is saved." : "") + "</span>" +
        (state.error.resumable ? `<button data-action="resume">Resume</button>` : "");
    } else banner.className = "banner hidden";
    input.placeholder = state.busy ? "Add to this: it goes with the next step…" : "Ask Solder to read or change your code…";
    // chips
    const chips = [];
    if (state.workspace) {
      chips.push(`<button class="chip folder" data-action="folder" title="The folder you're working in: relative paths and searches start here. Click to change.">` +
        `<svg viewBox="0 0 16 16"><path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/></svg>${escape(state.folder || state.workspaceName || "Workspace")}</button>` +
        (state.folder ? `<button class="chip clear" data-action="clearFolder" title="Back to the whole workspace">✕</button>` : ""));
    }
    if (editor.selection) chips.push(`<button class="chip${chipsOn.selection ? " on" : ""}" data-chip="selection" title="Send the selected lines with your message">✂ ${escape(base(editor.file))}:${editor.selection}</button>`);
    else if (editor.file) chips.push(`<button class="chip${chipsOn.file ? " on" : ""}" data-chip="file" title="Tell Solder which file is open">${escape(base(editor.file))}</button>`);
    $("chips").innerHTML = chips.join("");
    // model
    const model = state.models.find((/** @type {any} */ m) => m.id === state.model);
    $("model-name").textContent = model ? model.name : state.model || "Choose a model";
    const models = state.models.length
      ? state.models.map((/** @type {any} */ m) => `<button data-model="${escape(m.id)}" class="${m.id === state.model ? "active" : ""}">` +
        `<span>${escape(m.name)}</span>${m.name !== m.id ? `<span class="grey">${escape(m.id)}</span>` : ""}</button>`).join("")
      : `<div class="empty">No models listed.</div>`;
    if (models !== shownModels) { shownModels = models; $("model-menu").innerHTML = models; } // an open menu doesn't flicker
    // effort
    const level = state.effort === "default" ? "low" : state.effort;
    for (const button of $("effort").querySelectorAll("button")) button.classList.toggle("active", button.dataset.level === level);
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

  /** @param {number} n */
  function compact(n) {
    return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k" : String(n);
  }

  function renderChatMenu() {
    const now = Date.now();
    $("chat-menu").innerHTML = state.chats.length ? state.chats.map((/** @type {any} */ c) =>
      `<button data-open="${c.id}" class="${c.id === state.chat.id ? "active" : ""}"><span>${escape(c.title)}</span><span class="when">${ago(now - c.updated)}</span></button>`).join("")
      : `<div class="empty">No saved chats yet.</div>`;
  }

  /** @param {number} ms */
  function ago(ms) {
    const m = Math.round(ms / 60000);
    return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  }

  // the "Thinking…" clock: after 15 s of quiet, show how long it's been
  setInterval(() => {
    for (const time of document.querySelectorAll(".step .time[data-since]")) {
      time.textContent = elapsed(Date.now() - Number(/** @type {HTMLElement} */ (time).dataset.since));
    }
    const clock = document.querySelector("#status .clock");
    if (!clock) return;
    const seconds = Math.floor((Date.now() - thinkingSince) / 1000);
    clock.textContent = seconds >= 15 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "";
    const label = document.querySelector("#status .what");
    if (label && seconds >= 15 && state?.effort === "high" && !state.status.includes("…")) label.textContent = "Thinking hard on High effort…";
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
    }
  });

  function send() {
    const text = input.value.trim();
    if (!text || !state) return;
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

  input.addEventListener("input", () => { autosize(); vscode.setState({ draft: input.value }); });
  input.addEventListener("keydown", (event) => {
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
  function closeMenus(except = "") {
    for (const menu of document.querySelectorAll(".menu")) if (menu.id !== except) {
      menu.classList.add("hidden");
      document.getElementById(OPENERS[/** @type {keyof typeof OPENERS} */ (menu.id)] || "")?.setAttribute("aria-expanded", "false");
    }
  }
  /** @param {string} id */
  function toggle(id) {
    const menu = $(id);
    const show = menu.classList.contains("hidden");
    closeMenus();
    if (show) {
      if (id === "chat-menu") renderChatMenu();
      menu.classList.remove("hidden");
      document.getElementById(OPENERS[/** @type {keyof typeof OPENERS} */ (id)])?.setAttribute("aria-expanded", "true");
    }
  }
  $("chat-title").addEventListener("click", (e) => { e.stopPropagation(); toggle("chat-menu"); });
  $("btn-more").addEventListener("click", (e) => { e.stopPropagation(); toggle("more-menu"); });
  $("model-button").addEventListener("click", (e) => { e.stopPropagation(); toggle("model-menu"); });

  document.addEventListener("click", (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    const el = /** @type {HTMLElement | null} */ (target.closest("[data-action],[data-setup],[data-pick-model],[data-open],[data-model],[data-level],[data-chip],[data-undo],[data-review],[data-decide],[data-unsteer],[data-step],code.path,pre .copy"));
    if (!target.closest(".menu")) closeMenus();
    if (!el) return;
    const d = el.dataset;
    if (d.action) { closeMenus(); vscode.postMessage({ type: d.action }); }
    else if (d.setup) {
      closeMenus();
      if (el.hasAttribute("disabled")) return;
      const extra = d.setup === "next" ? setupValues() : d.setup === "removeDocs" ? { index: Number(d.index) } : {};
      if (d.setup === "removeDocs" && setupDraft) setupDraft = Object.fromEntries(Object.entries(setupDraft).filter(([k]) => !k.startsWith("about-")));
      vscode.postMessage({ type: "setup", action: d.setup, ...extra });
    } else if (d.pickModel) {
      if (setupDraft) setupDraft["setup-model"] = d.pickModel;
      for (const option of transcript.querySelectorAll("[data-pick-model]")) option.classList.toggle("on", option === el);
    }
    else if (d.open) { closeMenus(); vscode.postMessage({ type: "open", id: d.open }); }
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
      if (target.closest(".acts")) return;
      open.has(d.step) ? open.delete(d.step) : open.add(d.step);
      renderTranscript();
    } else if (el.matches("code.path")) {
      const [file, line] = String(d.path).split(/:(\d+)$/);
      vscode.postMessage({ type: "openFile", path: file, line: line ? Number(line) : undefined });
    } else if (el.matches("pre .copy")) {
      const code = el.parentElement?.querySelector("code")?.textContent || "";
      navigator.clipboard.writeText(code).then(() => {
        el.textContent = "Copied";
        el.classList.add("done");
        setTimeout(() => { el.textContent = "Copy"; el.classList.remove("done"); }, 1200);
      });
    }
  });
  document.addEventListener("keydown", (event) => {
    const el = /** @type {HTMLElement} */ (event.target);
    if ((event.key === "Enter" || event.key === " ") && el.dataset?.step) { event.preventDefault(); el.click(); }
  });

  autosize();
  vscode.postMessage({ type: "ready" });
  // @ts-ignore: for the browser preview harness
  window.__solder = { markdown };
})();
