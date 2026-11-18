// @ts-check
"use strict";
/**
 * The panel's Markdown renderer (media/panel.js), under plain node: the script runs in a vm with a stand-in DOM (every
 * element is a permissive proxy), and exposes `markdown` on `window.__solder` as the browser harness does. What's
 * checked is what reaches innerHTML from a model's answer: escaped, with nothing a reply can say turning into markup.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/** An element that takes anything: properties are more of the same, methods do nothing. */
function element() {
  const bag = { classList: { toggle() {}, add() {}, remove() {}, contains() { return true; } }, style: {}, dataset: {}, value: "", children: [] };
  return new Proxy(bag, {
    get(target, key) {
      if (key in target) return target[/** @type {string} */ (key)];
      if (key === Symbol.iterator) return function* () {};
      return (/** @type {any} */ target)[/** @type {string} */ (key)] = (...args) => (typeof args[0] === "string" && key === "querySelectorAll" ? [] : element());
    },
    set(target, key, value) { (/** @type {any} */ target)[/** @type {string} */ (key)] = value; return true; },
  });
}

/** media/panel.js loaded once: what it exposes for tests (its markdown function, and the paste rule). @returns {any} */
function loadPanel() {
  const source = fs.readFileSync(path.join(__dirname, "..", "media", "panel.js"), "utf8");
  const sandbox = /** @type {any} */ ({ document: element(), setInterval: () => 0, setTimeout: () => 0, clearTimeout() {}, console, performance: { now: () => 0 } });
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.window.matchMedia = () => ({ matches: true });
  sandbox.window.innerHeight = 800;
  vm.runInNewContext(source, sandbox, { filename: "panel.js" });
  return sandbox.__solder;
}

const panel = loadPanel();
const markdown = panel.markdown;

test("a reply's text is escaped before any Markdown: tags, attributes and quotes in it can't become markup", () => {
  const html = markdown('<img src=x onerror=alert(1)> **b<i>old</i>** `a"b` [x](https://h/?a="b)');
  assert.doesNotMatch(html, /<img|<i>|<\/i>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<code>a&quot;b<\/code>/);
  assert.match(html, /<a href="https:\/\/h\/\?a=&quot;b" title="https:\/\/h\/\?a=&quot;b">x<\/a>/);
});

test("a link that isn't http(s) is a path link (no href of its own, so no javascript: or other scheme runs)", () => {
  const html = markdown("[run](javascript:alert(1)) and [file](src/app.js:12)");
  assert.doesNotMatch(html, /href="javascript/);
  assert.match(html, /<a href="#" class="path-link" data-path="javascript:alert\(1">/);
  assert.match(html, /<a href="#" class="path-link" data-path="src\/app.js:12"><code class="path">file<\/code><\/a>/);
});

test("NUL characters in a reply don't break the renderer (they look like the inline-code placeholders)", () => {
  // A model (or a file it quotes) can send \u0000: with digits around, it read as a placeholder for a code span that
  // didn't exist, and the whole panel stopped drawing on a TypeError. Now it renders, and real code spans still do.
  const html = markdown("a `real` span, then \u00001\u0000 end");
  assert.match(html, /<code>real<\/code>/);
  assert.match(html, /then \u00001\u0000 end/);
  assert.doesNotThrow(() => markdown("\u00007\u0000"));
  assert.doesNotThrow(() => markdown("`a`\u00001\u0000"));
});

test("a link's address keeps its underscores and stars: only its label is formatted", () => {
  const html = markdown("See [the **docs**](https://example.com/some_page_name/a*b*c) and _this_.");
  assert.match(html, /href="https:\/\/example\.com\/some_page_name\/a\*b\*c"/);
  assert.match(html, />the <strong>docs<\/strong><\/a>/);
  assert.match(html, /<em>this<\/em>/);
  assert.doesNotThrow(() => markdown("stray \u00013\u0001 marker"));
});

test("a shell's code block gets Paste in terminal beside Copy; other code doesn't", () => {
  const T = "```";
  const shell = markdown(T + "powershell\nGet-ChildItem\n" + T);
  assert.match(shell, /<pre class="shell"><button class="paste"[^>]*>Paste in terminal<\/button><button class="copy">Copy<\/button>/);
  for (const lang of ["bash", "PS1", "cmd", "console"]) assert.match(markdown(T + lang + "\nx\n" + T), /class="paste"/, lang);
  assert.doesNotMatch(markdown(T + "js\nlet a = 1;\n" + T), /class="paste"/);
  assert.doesNotMatch(markdown(T + "\nplain\n" + T), /class="paste"/, "no language: no guess");
});

test("a paste of more than 40 lines, or 4,000 characters, goes as a chip; a shorter one into the box", () => {
  const { pasteAsChip } = panel;
  assert.equal(pasteAsChip("one line"), false);
  assert.equal(pasteAsChip(Array.from({ length: 40 }, (_, i) => "line " + i).join("\n")), false, "40 lines still fit the box");
  assert.equal(pasteAsChip(Array.from({ length: 41 }, (_, i) => "line " + i).join("\n")), true);
  assert.equal(pasteAsChip("x".repeat(4001)), true, "one very long line too");
});
