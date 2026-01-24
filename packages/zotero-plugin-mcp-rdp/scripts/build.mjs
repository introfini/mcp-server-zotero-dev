/**
 * Build script for MCP Bridge for Zotero Zotero plugin
 *
 * Creates an .xpi file (which is just a ZIP with a different extension)
 */

import AdmZip from "adm-zip";
import { readFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const buildDir = join(rootDir, "build");
const addonDir = join(rootDir, "addon");
const srcDir = join(rootDir, "src");

// Ensure build directory exists
if (!existsSync(buildDir)) {
  mkdirSync(buildDir, { recursive: true });
}

// Read package.json for version
const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf-8"));

console.log(`Building MCP Bridge for Zotero v${pkg.version}...`);

// Copy bootstrap.js (plain JavaScript, no compilation needed)
copyFileSync(join(srcDir, "bootstrap.js"), join(buildDir, "bootstrap.js"));

console.log("✓ Copied bootstrap.js");

// Create the XPI (ZIP file)
const zip = new AdmZip();

// Add bootstrap.js
zip.addLocalFile(join(buildDir, "bootstrap.js"));

// Add manifest.json (update version from package.json)
const manifest = JSON.parse(readFileSync(join(addonDir, "manifest.json"), "utf-8"));
manifest.version = pkg.version;
zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2)));

// Add locale files
function addDirToZip(zip, dirPath, zipPath) {
  const files = readdirSync(dirPath);
  for (const file of files) {
    const filePath = join(dirPath, file);
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      addDirToZip(zip, filePath, join(zipPath, file));
    } else {
      zip.addLocalFile(filePath, zipPath);
    }
  }
}

// Add locale directory
if (existsSync(join(addonDir, "locale"))) {
  addDirToZip(zip, join(addonDir, "locale"), "locale");
}

// Add content directory (icons, etc.)
if (existsSync(join(addonDir, "content"))) {
  addDirToZip(zip, join(addonDir, "content"), "content");
}

// Write XPI file
const xpiPath = join(buildDir, `zotero-mcp-bridge-${pkg.version}.xpi`);
zip.writeZip(xpiPath);

console.log(`✓ Created ${xpiPath}`);

// Also create a copy without version for convenience
const genericXpiPath = join(buildDir, "zotero-mcp-bridge.xpi");
zip.writeZip(genericXpiPath);

console.log(`✓ Created ${genericXpiPath}`);
console.log("\nBuild complete!");
