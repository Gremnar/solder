// @ts-check
"use strict";
// The parts of src/tools.js that don't need a running VS Code, with a stand-in for the vscode module.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const KINDS = ["File", "Module", "Namespace", "Package", "Class", "Method", "Property", "Field", "Constructor", "Enum",
  "Interface", "Function", "Variable", "Constant", "String", "Number", "Boolean", "Array", "Object", "Key", "Null",
  "EnumMember", "Struct", "Event", "Operator", "TypeParameter"];
const SymbolKind = Object.fromEntries(KINDS.flatMap((name, index) => [[name, index], [index, name]]));
const load = /** @type {any} */ (Module)._load;
/** @type {any} */ (Module)._load = function (/** @type {string} */ request, /** @type {any[]} */ ...rest) {
  return request === "vscode" ? { SymbolKind } : load.call(this, request, ...rest);
};
const { outlineEntries } = require("../src/tools.js");

const at = (start, end) => ({ start: { line: start - 1 }, end: { line: end - 1 } });
const kind = (/** @type {number} */ k) => SymbolKind[k];

test("an outline lists classes, methods and functions in file order, nested, with line ranges", () => {
  const symbols = [
    { name: "main", kind: SymbolKind.Function, range: at(205, 230), children: [
      { name: "local", kind: SymbolKind.Variable, range: at(206, 206) },
      { name: "helper", kind: SymbolKind.Function, range: at(210, 220) }] },
    { name: "App", kind: SymbolKind.Class, range: at(12, 200), children: [
      { name: "config", kind: SymbolKind.Property, range: at(14, 14) },
      { name: "start", kind: SymbolKind.Method, range: at(20, 45), children: [
        { name: "x", kind: SymbolKind.Constant, range: at(21, 21) },
        { name: "deep", kind: SymbolKind.Function, range: at(30, 40), children: [
          { name: "deeper", kind: SymbolKind.Function, range: at(31, 32) }] }] }] },
  ];
  assert.deepEqual(outlineEntries(symbols, kind), [
    "class App 12–200",
    "  property config 14",
    "  method start 20–45",
    "    function deep 30–40",
    "function main 205–230",
    "  function helper 210–220",
  ]);
});

test("flat symbol lists (SymbolInformation) work too, and odd names are tidied", () => {
  const symbols = [
    { name: "b", kind: SymbolKind.Function, location: { range: at(9, 12) } },
    { name: "  Heading\nwith a break ", kind: SymbolKind.String, location: { range: at(1, 8) } },
    { name: "", kind: SymbolKind.Function, location: { range: at(20, 21) } },
    { name: "no range", kind: SymbolKind.Function },
  ];
  assert.deepEqual(outlineEntries(symbols, kind), ["string Heading with a break 1–8", "function b 9–12", "function (unnamed) 20–21"]);
});
