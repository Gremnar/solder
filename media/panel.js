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

  function render() {
    if (!state) return;
    $("chat-title-text").textContent = state.chat.title;
    renderTranscript();
    renderComposer();
  }

  function renderTranscript() {
    const items = state.chat.items;
    const parts = [];
    if (!items.length && !state.busy) parts.push(welcome());
    for (const item of items) {
      if (item.kind === "user") {
        parts.push(`<div class="user${item.resume ? " resume" : ""}">${escape(item.text)}` +
          (item.chips.length ? `<div class="chips">${item.chips.map((c) => `<span class="chip">${escape(c)}</span>`).join("")}</div>` : "") + "</div>");
      } else if (item.kind === "answer") {
        parts.push(`<div class="answer${item.incomplete ? " incomplete" : ""}">${markdown(item.text)}</div>`);
      } else if (item.kind === "note") {
        parts.push(`<div class="note">${escape(item.text)}</div>`);
      } else if (item.kind === "step") {
        parts.push(step(item));
      }
    }
    if (state.busy) {
      if (reveal.shown) parts.push(`<div class="answer" id="live">${markdown(closeOpenMarks(reveal.shown))}</div>`);
      else parts.push(`<div class="status" id="status"><span class="spinner"></span><span>${escape(state.status || "Working…")}</span><span class="clock"></span></div>`);
    }
    const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
    transcript.innerHTML = parts.join("");
    if (atBottom || stickToBottom) transcript.scrollTop = transcript.scrollHeight;
    stickToBottom = false;
  }

  /** @param {any} item */
  function step(item) {
    const cls = item.pending ? (item.running ? "running" : "waiting") : item.failed ? "failed" : "ok";
    const mark = item.pending ? (item.running ? "" : "·") : item.failed ? "✕" : "✓";
    const acts = item.change && !item.pending
      ? `<span class="acts">${item.removed ? "" : `<button data-review="${item.id}">Review</button>`}${item.undone ? "" : `<button data-undo="${item.id}">Undo</button>`}</span>` : "";
    const label = item.pending ? item.label : (item.summary || item.label) + (item.undone ? " · undone" : "");
    const body = open.has(item.id) && item.output ? `<pre class="out"><code>${escape(item.output)}</code></pre>` : "";
    return `<div class="step ${cls}${item.undone ? " undone" : ""}"><div class="step-head" data-step="${item.id}" role="button" tabindex="0">` +
      `<span class="mark">${mark}</span><span class="label" title="${escape(label)}">${escape(label)}</span>${acts}</div>${body}</div>`;
  }

  function welcome() {
    if (state.modelsProblem === "setup") {
      return `<div class="welcome"><h2>Set up Solder</h2>Point it at an OpenAI-compatible endpoint with tool calling, then add its key.` +
        `<div class="actions"><button class="link-button primary" data-action="settings">Open settings</button>` +
        `<button class="link-button" data-action="setKey">Set API key</button></div></div>`;
    }
    if (state.modelsProblem) {
      return `<div class="welcome"><h2>Can't reach the endpoint</h2>${escape(state.modelsProblem)}` +
        `<div class="actions"><button class="link-button primary" data-action="refreshModels">Try again</button>` +
        `<button class="link-button" data-action="settings">Settings</button><button class="link-button" data-action="setKey">Set API key</button></div></div>`;
    }
    return `<div class="welcome"><h2>Solder</h2>Ask about your code, or for a change. Solder reads, searches and edits files in this workspace, ` +
      `checks VS Code's problems after each edit, and every change can be reviewed and undone.` +
      (state.workspace ? "" : "<br><br>Open a folder first: Solder works inside a workspace.") + "</div>";
  }

  function renderComposer() {
    // approvals
    $("approvals").innerHTML = state.approvals.map((/** @type {any} */ a) => `<div class="approval" data-id="${a.id}">` +
      `<div class="what">${escape(a.label)}</div><div class="why">${escape(a.reason)}</div>` +
      (a.content ? `<pre><code>${escape(a.content)}</code></pre>` : "") +
      `<input type="text" placeholder="A note for the model (optional)"><div class="buttons">` +
      `<button class="allow" data-decide="allow">Allow</button><button data-decide="decline">Decline</button></div></div>`).join("");
    // banner
    const banner = $("banner");
    if (state.error && !state.busy) {
      banner.className = "banner" + (state.error.stopped ? " soft" : "");
      banner.innerHTML = `<span class="msg">${escape(state.error.message)}` +
        (state.error.exhausted ? " Resume once it resets; everything so far is saved." : "") + "</span>" +
        (state.error.resumable ? `<button data-action="resume">Resume</button>` : "");
    } else if (state.busy && state.steers) {
      banner.className = "banner soft";
      banner.innerHTML = `<span class="msg">Your message goes with the next step.</span>`;
    } else banner.className = "banner hidden";
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
    $("model-menu").innerHTML = state.models.length
      ? state.models.map((/** @type {any} */ m) => `<button data-model="${escape(m.id)}" class="${m.id === state.model ? "active" : ""}">` +
        `<span>${escape(m.name)}</span>${m.name !== m.id ? `<span class="grey">${escape(m.id)}</span>` : ""}</button>`).join("")
      : `<div class="empty">No models listed.</div>`;
    // effort
    const level = state.effort === "default" ? "low" : state.effort;
    for (const button of $("effort").querySelectorAll("button")) button.classList.toggle("active", button.dataset.level === level);
    // send / stop
    $("send").classList.toggle("hidden", state.busy && !input.value.trim());
    $("stop").classList.toggle("hidden", !state.busy);
    $("send").title = state.busy ? "Send with the next step" : "Send (Enter)";
    // footer
    const footer = [];
    if (state.chat.tokens) footer.push(`<span title="Tokens this chat has used">${compact(state.chat.tokens)} tokens</span>`);
    if (state.credits) footer.push(`<span title="${state.credits.remaining.toLocaleString()} of ${state.credits.limit.toLocaleString()} left">${compact(state.credits.remaining)} left</span>`);
    $("footer").innerHTML = footer.join("");
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
    const clock = document.querySelector("#status .clock");
    if (!clock) return;
    const seconds = Math.floor((Date.now() - thinkingSince) / 1000);
    clock.textContent = seconds >= 15 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "";
    const label = document.querySelector("#status span:nth-child(2)");
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
    input.value = "";
    stickToBottom = true;
    autosize();
    vscode.setState({ draft: "" });
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + "px";
    if (state) $("send").classList.toggle("hidden", state.busy && !input.value.trim());
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

  function closeMenus(except = "") {
    for (const menu of document.querySelectorAll(".menu")) if (menu.id !== except) menu.classList.add("hidden");
  }
  /** @param {string} id */
  function toggle(id) {
    const menu = $(id);
    const show = menu.classList.contains("hidden");
    closeMenus();
    if (show) { if (id === "chat-menu") renderChatMenu(); menu.classList.remove("hidden"); }
  }
  $("chat-title").addEventListener("click", (e) => { e.stopPropagation(); toggle("chat-menu"); });
  $("btn-more").addEventListener("click", (e) => { e.stopPropagation(); toggle("more-menu"); });
  $("model-button").addEventListener("click", (e) => { e.stopPropagation(); toggle("model-menu"); });

  document.addEventListener("click", (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    const el = /** @type {HTMLElement | null} */ (target.closest("[data-action],[data-open],[data-model],[data-level],[data-chip],[data-undo],[data-review],[data-decide],[data-step],code.path,pre .copy"));
    if (!target.closest(".menu")) closeMenus();
    if (!el) return;
    const d = el.dataset;
    if (d.action) { closeMenus(); vscode.postMessage({ type: d.action }); }
    else if (d.open) { closeMenus(); vscode.postMessage({ type: "open", id: d.open }); }
    else if (d.model) { closeMenus(); vscode.postMessage({ type: "model", id: d.model }); }
    else if (d.level) vscode.postMessage({ type: "effort", level: d.level });
    else if (d.chip) { chipsOn[/** @type {"file"|"selection"} */ (d.chip)] = !chipsOn[/** @type {"file"|"selection"} */ (d.chip)]; renderComposer(); }
    else if (d.undo) vscode.postMessage({ type: "undo", id: d.undo });
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
      navigator.clipboard.writeText(code).then(() => { el.textContent = "Copied"; setTimeout(() => (el.textContent = "Copy"), 1200); });
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
