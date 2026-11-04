// @ts-check
"use strict";
/**
 * Builds solder-<version>.vsix with no packages: a .vsix is a zip holding extension.vsixmanifest,
 * [Content_Types].xml and the extension under extension/. Run: node build/vsix.js
 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
// What ships: nothing else (no tests, docs or private notes).
const INCLUDE = ["package.json", "README.md", "LICENSE", "src", "media"];

/** @returns {{name: string, data: Buffer}[]} */
function extensionFiles() {
  const files = [];
  /** @param {string} relative */
  const walk = (relative) => {
    const full = path.join(root, relative);
    if (fs.statSync(full).isDirectory()) {
      for (const name of fs.readdirSync(full).sort()) walk(path.join(relative, name));
    } else {
      // vsce names the license LICENSE.txt; the Marketplace looks for that.
      const name = relative === "LICENSE" ? "LICENSE.txt" : relative;
      files.push({ name: "extension/" + name.split(path.sep).join("/"), data: fs.readFileSync(full) });
    }
  };
  for (const item of INCLUDE) walk(item);
  return files;
}

/** @param {string} text */
const xml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function vsixManifest() {
  const m = manifest;
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xml(m.name)}" Version="${xml(m.version)}" Publisher="${xml(m.publisher)}" />
    <DisplayName>${xml(m.displayName)}</DisplayName>
    <Description xml:space="preserve">${xml(m.description)}</Description>
    <Tags>${xml((m.keywords || []).join(","))}</Tags>
    <Categories>${xml((m.categories || []).join(","))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(m.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="${xml((m.extensionKind || ["workspace"]).join(","))}" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
    </Properties>
    <License>extension/LICENSE.txt</License>${m.icon ? `
    <Icon>extension/${xml(m.icon)}</Icon>` : ""}
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />${m.icon ? `
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${xml(m.icon)}" Addressable="true" />` : ""}
  </Assets>
</PackageManifest>
`;
}

/** @param {string[]} names */
function contentTypes(names) {
  const types = { ".json": "application/json", ".js": "application/javascript", ".css": "text/css", ".html": "text/html",
    ".svg": "image/svg+xml", ".png": "image/png", ".md": "text/markdown", ".txt": "text/plain", ".vsixmanifest": "text/xml" };
  const used = [...new Set(names.map((name) => path.extname(name).toLowerCase()).filter(Boolean))].sort();
  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
${used.map((ext) => `  <Default Extension="${ext}" ContentType="${/** @type {any} */ (types)[ext] || "application/octet-stream"}" />`).join("\n")}
</Types>
`;
}

/** A plain zip (deflate, no zip64): enough for an extension. @param {{name: string, data: Buffer}[]} files */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const time = dosTime(new Date());
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const packed = zlib.deflateRawSync(file.data, { level: 9 });
    const crc = zlib.crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);       // version needed
    local.writeUInt16LE(0x0800, 6);   // UTF-8 names
    local.writeUInt16LE(8, 8);        // deflate
    local.writeUInt32LE(time, 10);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(time, 12);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** @param {Date} d */
function dosTime(d) {
  return (((d.getFullYear() - 1980) << 25) | ((d.getMonth() + 1) << 21) | (d.getDate() << 16) |
    (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) >>> 0;
}

const files = extensionFiles();
const all = [
  { name: "extension.vsixmanifest", data: Buffer.from(vsixManifest(), "utf8") },
  { name: "[Content_Types].xml", data: Buffer.from(contentTypes(["x.vsixmanifest", ...files.map((f) => f.name)]), "utf8") },
  ...files,
];
const out = path.join(root, `${manifest.name}-${manifest.version}.vsix`);
fs.writeFileSync(out, zip(all));
console.log(`${path.basename(out)}: ${files.length} files, ${(fs.statSync(out).size / 1024).toFixed(1)} KB`);
