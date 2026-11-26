// @ts-check
"use strict";
// Solder's outline by a file's text (src/outline.js), and its use by symbols when VS Code has no outline for a file:
// PowerShell, Structured Text and SCL, TwinCAT's and other XML exports, batch files, Python and SQL.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { textOutline, outlineLines, definedIn, textKind } = require("../src/outline.js");

/** @param {string} text @param {string} file */
const outline = (text, file) => outlineLines(/** @type {any} */ (textOutline(text, file)));

test("PowerShell: functions, filters, classes with their methods, enums and regions, with their end lines", () => {
  const text = [
    "#region Helpers",                                  // 1
    "function Get-Thing {",                             // 2
    "    param([string]$Name)",                         // 3
    "    $x = \"a $($y | ForEach-Object { \"}\" }) b\"", // 4: a brace in a string in a subexpression in a string
    "    $h = @\"",                                     // 5
    "function NotAFunction {",                          // 6: in a here-string
    "\"@",                                              // 7
    "    if ($x) { 'it''s }' }",                        // 8
    "}",                                                // 9
    "#endregion",                                       // 10
    "filter Out-Odd { if ($_ % 2) { $_ } }",            // 11
    "class Disk : Base {",                              // 12
    "    [string]$Name",                                // 13
    "    Disk([string]$n) : base($n) {",                // 14
    "        $this.Name = $n # a comment with a }",      // 15
    "    }",                                            // 16
    "    [int] Percent([long]$free) {",                 // 17
    "        if ($free) { return 1 }",                  // 18
    "        return 0",                                 // 19
    "    }",                                            // 20
    "}",                                                // 21
    "enum Color { Red; Green }",                        // 22
    "<#",                                               // 23
    "function InAComment { }",                          // 24
    "#>",                                               // 25
    "FUNCTION Global:Set-It($a,",                       // 26
    "    $b) {",                                        // 27
    "    ${env:Path} = $a",                             // 28
    "}",                                                // 29
  ].join("\r\n");
  assert.deepEqual(outline(text, "Scripts/x.ps1"), [
    "region Helpers 1–10",
    "  function Get-Thing 2–9",
    "filter Out-Odd 11",
    "class Disk 12–21",
    "  method Disk 14–16",
    "  method Percent 17–20",
    "enum Color 22",
    "function Global:Set-It 26–29",
  ]);
});

test("PowerShell whose braces don't balance (or a string left open): where each starts, and no ends", () => {
  assert.deepEqual(outline("function A {\n  if ($x) {\n}\nfunction B {\n}\n", "a.psm1"), ["function A 1", "function B 4"]);
  assert.deepEqual(outline("function A {\n  'open\n}\n", "a.ps1"), ["function A 1"]);
});

test("Structured Text and SCL: blocks and VAR sections with their END_ lines, any case, comments left out", () => {
  const text = [
    "FUNCTION_BLOCK PUBLIC FB_Motor EXTENDS FB_Base", // 1
    "VAR_INPUT",                                     // 2
    "  bStart : BOOL; (* start *)",                  // 3
    "END_VAR",                                       // 4
    "var constant",                                  // 5
    "  c : INT := 1;",                               // 6
    "end_var",                                       // 7
    "  IF bStart THEN x := 1; END_IF",               // 8
    "END_FUNCTION_BLOCK",                            // 9
    "TYPE \"UDT_Data\"",                             // 10
    "VERSION : 0.1",                                 // 11
    "   STRUCT",                                     // 12
    "      inner : Struct",                          // 13: not listed, but its END_STRUCT is its own
    "         b : Bool;",                            // 14
    "      END_STRUCT;",                             // 15
    "   END_STRUCT;",                                // 16
    "END_TYPE",                                      // 17
    "(* FUNCTION Hidden : INT",                      // 18
    "END_FUNCTION *)",                               // 19
    "FUNCTION \"F_Add\" : Int",                      // 20
    "VAR_TEMP",                                      // 21
    "END_VAR",                                       // 22
    "END_FUNCTION",                                  // 23
  ].join("\n");
  assert.deepEqual(outline(text, "Motor.scl"), [
    "function_block FB_Motor 1–9",
    "  var_input 2–4",
    "  var constant 5–7",
    "type UDT_Data 10–17",
    "  struct 12–16",
    "function F_Add 20–23",
    "  var_temp 21–22",
  ]);
  assert.deepEqual(outline("PROGRAM Main\nVAR\nEND_VAR\nEND_PROGRAM\n", "main.st"), ["program Main 1–4", "  var 2–3"]);
});

const TCPOU = [
  "<?xml version=\"1.0\" encoding=\"utf-8\"?>",            // 1
  "<TcPlcObject Version=\"1.1.0.1\">",                      // 2
  "  <POU Name=\"FB_Pump\" Id=\"{1}\" SpecialFunc=\"None\">", // 3
  "    <Declaration><![CDATA[FUNCTION_BLOCK FB_Pump",       // 4
  "VAR_INPUT",                                              // 5
  "\tbRun : BOOL;",                                         // 6
  "END_VAR",                                                // 7
  "]]></Declaration>",                                      // 8
  "    <Implementation>",                                   // 9
  "      <ST><![CDATA[IF bRun THEN",                        // 10
  "  Start();",                                             // 11
  "END_IF]]></ST>",                                         // 12
  "    </Implementation>",                                  // 13
  "    <Method Name=\"Start\" Id=\"{2}\">",                  // 14
  "      <Declaration><![CDATA[METHOD PUBLIC Start : BOOL", // 15
  "VAR",                                                    // 16
  "END_VAR",                                                // 17
  "]]></Declaration>",                                      // 18
  "      <Implementation>",                                 // 19
  "        <ST><![CDATA[Start := TRUE;]]></ST>",            // 20
  "      </Implementation>",                                // 21
  "    </Method>",                                          // 22
  "  </POU>",                                               // 23
  "</TcPlcObject>",                                         // 24
].join("\r\n");

test("TwinCAT: the ST in the CDATA, a METHOD or the POU ending where its XML element ends", () => {
  assert.deepEqual(outline(TCPOU, "POUs/FB_Pump.TcPOU"), [
    "function_block FB_Pump 4–23",
    "  var_input 5–7",
    "  method Start 15–22",
    "    var 16–17",
  ]);
});

test("XML exports: elements with a name that hold something, nested; Siemens' <AttributeList><Name>; tags that don't nest give nothing", () => {
  const siemens = [
    "<Document>",
    "<SW.Blocks.FB ID=\"0\"><AttributeList>",
    "<Name>FB_Conveyor</Name></AttributeList>",
    "<Member Name=\"a\" Datatype=\"Bool\" />",
    "<Member Name=\"s\" Datatype=\"Struct\">",
    "  <Member Name=\"b\" Datatype=\"Int\" />",
    "</Member>",
    "<!-- <Member Name=\"commented\"> -->",
    "</SW.Blocks.FB>",
    "</Document>",
  ].join("\n");
  assert.deepEqual(outline(siemens, "FB_Conveyor.xml"), ["SW.Blocks.FB FB_Conveyor 2–9", "  Member s 5–7"]);
  const l5x = "<RSLogix5000Content>\n<Controller Name=\"PLC1\">\n<Programs>\n<Program Name=\"Main\">\n<Routines>\n<Routine Name=\"R1\" Type=\"ST\">\n</Routine>\n</Routines>\n</Program>\n</Programs>\n</Controller>\n</RSLogix5000Content>\n";
  assert.deepEqual(outline(l5x, "plc.L5X"), ["Controller PLC1 2–11", "  Program Main 4–9", "    Routine R1 6–7"]);
  assert.deepEqual(outline("<a Name=\"x\">\n<b>\n</a>\n", "bad.xml"), []);
});

test("batch labels, Python by indentation, SQL definitions; other files have no outline of Solder's", () => {
  assert.deepEqual(outline("@echo off\n:: a comment\ncall :sub\ngoto :eof\n:sub\necho hi\nexit /b\n", "run.cmd"), ["label sub 5"]);
  const py = "import os\nclass A:\n    \"\"\"doc\nx\"\"\"\n    def f(self, a,\nb):\n        return 1\n\n    # trailing\ndef g():\n    pass\n";
  assert.deepEqual(outline(py, "a.py"), ["class A 2–9", "  function f 5–7", "function g 10–11"]);
  assert.deepEqual(outline("CREATE OR ALTER PROCEDURE [dbo].[GetX] AS\n/* CREATE TABLE t (a int)\n*/\nCREATE VIEW v AS SELECT 1\n", "a.sql"), ["procedure [dbo].[GetX] 1", "view v 4"]);
  assert.equal(textOutline("function a() {}", "a.js"), null);
  assert.equal(textKind("notes.txt"), "");
});

test("definedIn: the definition's lines, by the language's way of comparing names", () => {
  const ps = /** @type {any} */ (textOutline("function Get-A {\n}\n#region R\nfunction Get-B { 1 }\nfunction Get-C {\n", "a.ps1"));
  // Get-B ends on its own line; Get-C's end isn't known (braces don't balance): to the end of the file.
  assert.deepEqual(definedIn(ps, "get-c", "a.ps1", 6).map((d) => [d.entry.name, d.entry.start, d.last]), [["Get-C", 5, 6]]);
  assert.deepEqual(definedIn(ps, "Get-B", "a.ps1", 6).map((d) => [d.entry.start, d.last]), [[4, 4]]);
  const sure = /** @type {any} */ (textOutline("function Get-A {\n}\nfunction Get-B {\n  1\n}\n", "a.ps1"));
  assert.deepEqual(definedIn(sure, "get-b", "a.ps1", 5).map((d) => [d.entry.name, d.entry.start, d.last]), [["Get-B", 3, 5]]);
  assert.deepEqual(definedIn(ps, "Get-A", "a.ps1", 6).map((d) => [d.entry.start, d.last]), [[1, 2]]);
  // A batch label runs to the line before the next.
  const bat = /** @type {any} */ (textOutline(":one\necho 1\n:two\necho 2\n", "a.bat"));
  assert.deepEqual(definedIn(bat, "one", "a.bat", 4).map((d) => [d.entry.start, d.last]), [[1, 2]]);
  assert.deepEqual(definedIn(bat, "two", "a.bat", 4).map((d) => [d.entry.start, d.last]), [[3, 4]]);
  // Python compares by case; a region or a VAR section is no definition.
  const py = /** @type {any} */ (textOutline("def Go():\n    pass\n", "a.py"));
  assert.equal(definedIn(py, "go", "a.py", 2).length, 0);
  assert.equal(definedIn(/** @type {any} */ (textOutline("#region R\n#endregion\n", "a.ps1")), "R", "a.ps1", 2).length, 0);
  // A method by its name; a SQL object by its name without the schema.
  assert.deepEqual(definedIn(/** @type {any} */ (textOutline(TCPOU, "a.TcPOU")), "start", "a.TcPOU", 24).map((d) => [d.entry.start, d.last]), [[15, 22]]);
  assert.equal(definedIn(/** @type {any} */ (textOutline("CREATE PROCEDURE [dbo].[GetX] AS\n", "a.sql")), "GetX", "a.sql", 1).length, 1);
});

// ------------------------------------------------------------------ in symbols --

/** @type {{symbols: (uri: any) => any, calls: number}} what the stand-in VS Code's outline provider gives */
const provider = { symbols: () => [], calls: 0 };
const docs = new Map();
const vscodeStub = {
  Uri: { file: (/** @type {string} */ fsPath) => ({ fsPath, scheme: "file", toString: () => "file://" + fsPath }) },
  Position: class { constructor(/** @type {number} */ line, /** @type {number} */ character) { this.line = line; this.character = character; } },
  Range: class {}, FileType: { File: 1, Directory: 2 }, SymbolKind: { 11: "Function" }, env: { appRoot: "" },
  RelativePattern: class {},
  languages: { onDidChangeDiagnostics: () => ({ dispose() {} }), getDiagnostics: () => [] },
  commands: {
    executeCommand: async (/** @type {string} */ command, /** @type {any} */ uri) => {
      if (command === "vscode.executeDocumentSymbolProvider") { provider.calls++; return provider.symbols(uri); }
      return [];
    },
  },
  workspace: {
    textDocuments: [],
    getConfiguration: () => ({ get: (/** @type {string} */ _key, /** @type {any} */ fallback) => fallback }),
    findFiles: async () => [],
    fs: { stat: async (/** @type {any} */ uri) => { const st = fs.statSync(uri.fsPath); return { type: st.isDirectory() ? 2 : 1, size: st.size }; } },
    openTextDocument: async (/** @type {any} */ uri) => {
      const full = uri.fsPath;
      const text = fs.readFileSync(full, "utf8");
      const lines = text.split(/\r\n|\n/);
      const doc = { uri, languageId: path.extname(full) === ".txt" ? "plaintext" : path.extname(full).slice(1).toLowerCase(), getText: () => text, lineCount: lines.length, lineAt: (/** @type {number} */ i) => ({ text: lines[i] }) };
      docs.set(full, doc);
      return doc;
    },
  },
};
const load = /** @type {any} */ (Module)._load;
/** @type {any} */ (Module)._load = function (/** @type {string} */ request, /** @type {any[]} */ ...rest) {
  return request === "vscode" ? vscodeStub : load.call(this, request, ...rest);
};
const { WorkspaceTools } = require("../src/tools.js");
const { RESULTS } = require("../src/prompt.js");

const SCRIPT = ["# Maintenance", "function Get-Free {", "    param($Disk)", "    $Disk.FreeSpace / $Disk.Size", "}", "",
  "function Get-Used {", "    param($Disk)", "    Get-Free $Disk", "}", ""].join("\r\n");

test("symbols on a file VS Code has no outline for: Solder's outline by its text, a definition's body, and the wait paid once", async () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "solder-outline-"));
  try {
    fs.mkdirSync(path.join(top, "Scripts"));
    fs.writeFileSync(path.join(top, "Scripts", "maint.ps1"), SCRIPT);
    fs.writeFileSync(path.join(top, "Scripts", "other.ps1"), "function Get-Other {\r\n    'x'\r\n}\r\n");
    fs.writeFileSync(path.join(top, "app.js"), "function main() {\n  return 1;\n}\n");
    const tools = new WorkspaceTools(/** @type {any} */ ({ globalStorageUri: { fsPath: path.join(top, ".store") }, subscriptions: [] }));
    tools.roots = () => [top];
    /** @type {any} */ (tools)._pruned = Date.now();
    const signal = AbortSignal.timeout(30_000);

    provider.calls = 0;
    const first = await tools.symbols({ path: "Scripts/maint.ps1" }, signal);
    assert.equal(first.output, RESULTS.textOutlineHead("Scripts/maint.ps1", 11) + "\nfunction Get-Free 2–5\nfunction Get-Used 7–10");
    assert.match(first.summary, /2 entries \(by text\)/);
    assert.equal(provider.calls, 4, "the first file of the language waits for its language support, as before");

    // The language gave nothing after the whole wait: asked once, not waited for, from now on in this window.
    provider.calls = 0;
    const started = Date.now();
    const again = await tools.symbols({ path: "Scripts/other.ps1" }, signal);
    assert.match(again.output, /function Get-Other 1–3/);
    assert.equal(provider.calls, 1);
    assert.ok(Date.now() - started < 400, "not waited for");

    // A name in such a file: its body, not bare text matches.
    const def = await tools.symbols({ name: "get-free", path: "Scripts/maint.ps1" }, signal);
    assert.equal(def.output, RESULTS.textDefinitions("get-free", 1) + "\n\nScripts/maint.ps1 2–5:\n2\tfunction Get-Free {\n3\t    param($Disk)\n4\t    $Disk.FreeSpace / $Disk.Size\n5\t}");
    assert.match(def.summary, /by text/);
    // With no path: the files the name's text is in, outlined by their text.
    const anywhere = await tools.symbols({ name: "Get-Used" }, signal);
    assert.match(anywhere.output, /Scripts\/maint\.ps1 7–10:\n7\tfunction Get-Used \{\n8\t    param\(\$Disk\)\n9\t    Get-Free \$Disk\n10\t\}/);
    // References are text matches, as before.
    const uses = await tools.symbols({ name: "Get-Free", find: "references" }, signal);
    assert.match(uses.output, /^VS Code's language support found nothing/);

    // A file with language support keeps VS Code's outline.
    provider.symbols = (uri) => /app\.js$/.test(uri.fsPath)
      ? [{ name: "main", kind: 11, range: { start: { line: 0 }, end: { line: 2 } }, selectionRange: { start: { line: 0 } }, children: [] }] : [];
    const js = await tools.symbols({ path: "app.js" }, signal);
    assert.equal(js.output, RESULTS.outlineHead("app.js", 4) + "\nfunction main 1–3");
    // And a kind Solder has no outline of its own for: as before.
    fs.writeFileSync(path.join(top, "notes.txt"), "a=1\n");
    const txt = await tools.symbols({ path: "notes.txt" }, signal);
    assert.equal(txt.output, RESULTS.noOutline("notes.txt", 2));
  } finally {
    provider.symbols = () => [];
    fs.rmSync(top, { recursive: true, force: true });
  }
});
