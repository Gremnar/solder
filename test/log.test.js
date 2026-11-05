// @ts-check
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Log } = require("../src/log.js");

test("the diagnostics log keeps names and numbers only, and the newest lines", () => {
  const shown = [];
  const log = new Log({ appendLine: (line) => shown.push(line) });
  log.event({ type: "reply", model: "model-a", ms: 3210, prompt: 12345, completion: 67, finish: "stop", calls: 2 });
  log.event({ type: "ran", name: "read_file", ms: 400, failed: false, chars: 3210, label: "read_file C:/secret/path.js" });
  log.event({ type: "delta", text: "words of the answer" });
  log.event({ type: "error", message: "The gateway answered HTTP 429.", exhausted: true });
  assert.equal(shown.length, 3, "streamed text isn't logged");
  assert.match(shown[0], /reply model-a 3\.2s prompt=12,345 out=67 finish=stop calls=2$/);
  assert.match(shown[1], /tool read_file 0\.4s ok 3,210 chars$/);
  assert.ok(!shown.join("\n").includes("secret"), "no paths");
  assert.match(shown[2], /allowance used up/);
  for (let i = 0; i < 600; i++) log.write("x" + i);
  assert.equal(log.lines.length, 500);
  assert.match(log.recent(1)[0], /x599$/);
});
