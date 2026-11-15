/**
 * Second Zotero instances (#29): what zotero_instance_setup and
 * zotero_instance_list need, minus the MCP plumbing.
 *
 * A second instance is four things that must agree, and three of them fail
 * silently when they don't (README § "Changing the RDP Port"):
 *   - its own profile. It is created here by writing user.js into an empty
 *     directory and starting Zotero with `-profile <dir>`, so the interactive
 *     profile manager never runs and profiles.ini is never touched;
 *   - its own data directory, so it starts with an empty library and never
 *     opens another instance's zotero.sqlite;
 *   - its own bridge port. Without one, the second Zotero "binds" 6100 next to
 *     the first and both MCP clients end up driving the first (#19);
 *   - the bridge itself, sideloaded into <profile>/extensions/ and enabled on
 *     the first start.
 *
 * Nothing here imports index.ts (#33), so a unit test can load the module
 * without starting the server. The host (platform, home directory,
 * environment) and the port probe are parameters for the same reason.
 */
import { copyFileSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

/** The bridge's add-on ID: its file name in <profile>/extensions/ must be `<id>.xpi`. */
export const BRIDGE_ID = "mcp-rdp@zotero.org";
/**
 * Bridge releases up to 1.0.4 read `extensions.mcp-rdp.port` under the wrong
 * preference branch and stayed on 6100 whatever the profile said (README §
 * "Actually running two instances"), which is #19 all over again.
 */
export const MIN_BRIDGE_VERSION = "1.0.5";
export const DEFAULT_RDP_PORT = 6100;
/** extensions.zotero.httpServer.port in Zotero's defaults/preferences/zotero.js. */
export const DEFAULT_HTTP_PORT = 23119;
/** Written last into every instance directory; marks it as made by this tool. */
export const MARKER_FILE = "zotero-instance.json";
export const MARKER_CREATED_BY = "mcp-server-zotero-dev";
export const BRIDGE_RELEASES_URL = "https://github.com/introfini/mcp-server-zotero-dev/releases/latest";

/** Where the tool runs. Injected so tests can describe another OS or a sandboxed home. */
export interface HostEnv {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
}

export function currentHostEnv(): HostEnv {
  return { platform: process.platform, home: homedir(), env: process.env };
}

/** path.win32 or path.posix, matching the host rather than the machine running the test. */
function pathFor(host: HostEnv): path.PlatformPath {
  return host.platform === "win32" ? path.win32 : path.posix;
}

/** A refusal: the message says what was wrong and what to do instead. */
export class InstanceSetupError extends Error {}

// ---------------------------------------------------------------------------
// Arguments

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}[A-Za-z0-9_-]$|^[A-Za-z0-9]$/;

/** A name that is safe as a directory name on every OS and in a shell command. */
export function validateName(value: unknown): string {
  if (typeof value !== "string" || !NAME_RE.test(value)) {
    throw new InstanceSetupError(
      `Invalid instance name ${JSON.stringify(value)}: use 1-64 letters, digits, ".", "_" or "-", ` +
        `starting with a letter or digit and not ending with "." (it becomes a directory name).`
    );
  }
  return value;
}

/** An unprivileged TCP port. Accepts the number as a string too (some clients send strings). */
export function validatePort(value: unknown, label: string): number {
  const port = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new InstanceSetupError(`Invalid ${label} ${JSON.stringify(value)}: expected an integer from 1024 to 65535.`);
  }
  return port;
}

/**
 * The HTTP port (connector, local API) when none is given: moved from 23119 by
 * the same offset as the RDP port from 6100 (6101 gives 23120), so instances
 * with distinct RDP ports get distinct HTTP ports. Undefined when that falls
 * outside 1024-65535; the caller then asks for an explicit httpPort.
 */
export function defaultHttpPort(rdpPort: number): number | undefined {
  const port = DEFAULT_HTTP_PORT + (rdpPort - DEFAULT_RDP_PORT);
  return port >= 1024 && port <= 65535 ? port : undefined;
}

// ---------------------------------------------------------------------------
// Layout

export interface InstancePaths {
  root: string;
  profileDir: string;
  dataDir: string;
  extensionsDir: string;
  bridgeXpi: string;
  userJs: string;
  marker: string;
}

export function defaultParentDir(host: HostEnv): string {
  return pathFor(host).join(host.home, "zotero-dev-instances");
}

export function instancePaths(parentDir: string, name: string, p: path.PlatformPath = path): InstancePaths {
  const root = p.join(parentDir, name);
  const profileDir = p.join(root, "profile");
  const extensionsDir = p.join(profileDir, "extensions");
  return {
    root,
    profileDir,
    dataDir: p.join(root, "data"),
    extensionsDir,
    bridgeXpi: p.join(extensionsDir, `${BRIDGE_ID}.xpi`),
    userJs: p.join(profileDir, "user.js"),
    marker: p.join(root, MARKER_FILE),
  };
}

// ---------------------------------------------------------------------------
// user.js

export interface UserJsOptions {
  name: string;
  dataDir: string;
  rdpPort: number;
  httpPort: number;
}

/**
 * The new profile's user.js. Firefox reads prefs.js and then user.js every
 * time the profile loads (Preferences::ReadUserOverridePrefs), so these values
 * win over anything changed later in the Config Editor.
 */
export function buildUserJs(o: UserJsOptions): string {
  // JSON string syntax is valid pref-file string syntax (\\, \", \uXXXX).
  const str = (s: string) => JSON.stringify(s);
  return [
    `// Zotero instance ${str(o.name)}, made by mcp-server-zotero-dev (zotero_instance_setup).`,
    `// Firefox re-applies this file at every start: change these values here, with Zotero closed.`,
    ``,
    `// Its own data directory (chrome/content/zotero/xpcom/dataDirectory.js reads`,
    `// dataDir only when useDataDir is true). Starts empty: a new library.`,
    `user_pref("extensions.zotero.dataDir", ${str(o.dataDir)});`,
    `user_pref("extensions.zotero.useDataDir", true);`,
    `// Its own MCP Bridge port (bridge 1.0.5 or later reads this name).`,
    `user_pref("extensions.mcp-rdp.port", ${o.rdpPort});`,
    `// Its own HTTP server port (connector, local API): the default 23119 belongs to`,
    `// the Zotero you already run.`,
    `user_pref("extensions.zotero.httpServer.port", ${o.httpPort});`,
    `// A test library never syncs on its own, even if someone signs in to test something.`,
    `user_pref("extensions.zotero.sync.autoSync", false);`,
    `// Firefox disables an add-on dropped into a profile ("sideloaded") when its install`,
    `// scope is in this mask (XPIDatabase.sys.mjs, addMetadata). 0 lets the bridge start`,
    `// enabled - and any other XPI later copied into this profile's extensions folder.`,
    `user_pref("extensions.autoDisableScopes", 0);`,
    `// No automatic Word / LibreOffice plugin installation on first start, as in`,
    `// Zotero's own test runner (test/runtests.sh): the word processor is shared with`,
    `// the Zotero you already run.`,
    `user_pref("extensions.zoteroWinWordIntegration.skipInstallation", true);`,
    `user_pref("extensions.zoteroMacWordIntegration.skipInstallation", true);`,
    `user_pref("extensions.zoteroOpenOfficeIntegration.skipInstallation", true);`,
    ``,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Launch command and MCP server entry

/**
 * argv for starting the instance. `-no-remote` matters only to Firefox ESR 128
 * and earlier, where it keeps the launch from being forwarded to a running
 * Zotero; ESR 140 and later identify a running instance by its full profile
 * path and strip `-no-remote` as unsupported (toolkit/xre/nsAppRunner.cpp).
 */
export function launchArgs(zoteroPath: string, profileDir: string): string[] {
  return [zoteroPath, "-profile", profileDir, "-no-remote"];
}

/**
 * argv as one line to paste into a shell: "sh" (macOS, Linux), "cmd" or
 * "powershell" (Windows; PowerShell needs the call operator before a quoted
 * program path, and takes '...' literally where "..." would expand $).
 */
export function formatCommand(argv: string[], shell: "sh" | "cmd" | "powershell"): string {
  if (shell === "cmd") {
    // Windows paths cannot contain double quotes, so quoting is enough.
    return argv.map((a) => (/[\s&()^|<>%]/.test(a) ? `"${a}"` : a)).join(" ");
  }
  if (shell === "powershell") {
    const q = (a: string) => (/^[A-Za-z0-9_\-.:\\/]+$/.test(a) ? a : `'${a.replace(/'/g, "''")}'`);
    return `& ${argv.map(q).join(" ")}`;
  }
  return argv.map((a) => (/^[A-Za-z0-9_\-./:=@,+]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}

/** The ready-to-paste launch lines for the host: cmd and PowerShell on Windows, sh elsewhere. */
export function launchCommands(argv: string[], platform: NodeJS.Platform): { shell: string; line: string }[] {
  return platform === "win32"
    ? [
        { shell: "cmd", line: formatCommand(argv, "cmd") },
        { shell: "PowerShell", line: formatCommand(argv, "powershell") },
      ]
    : [{ shell: "sh", line: formatCommand(argv, "sh") }];
}

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** A second server entry for the instance, pinned to this server's version as the README recommends. */
export function mcpServerEntry(o: { rdpPort: number; dataDir: string; profileDir: string; serverVersion: string }): McpServerEntry {
  return {
    command: "npx",
    args: ["-y", `@introfini/mcp-server-zotero-dev@${o.serverVersion}`],
    env: {
      ZOTERO_RDP_PORT: String(o.rdpPort),
      ZOTERO_DATA_DIR: o.dataDir,
      ZOTERO_PROFILE_PATH: o.profileDir,
    },
  };
}

// ---------------------------------------------------------------------------
// Bridge XPI

/**
 * One entry of a ZIP archive (an XPI), or undefined when absent. Only what a
 * built XPI uses: stored or deflated entries, no ZIP64, no encryption. Throws
 * when the buffer is not a readable ZIP.
 */
export function readZipEntry(buf: Buffer, entryName: string): Buffer | undefined {
  try {
    const minEocd = Math.max(0, buf.length - 22 - 0xffff);
    let eocd = -1;
    for (let i = buf.length - 22; i >= minEocd; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("no end-of-central-directory record");
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    for (let n = 0; n < count; n++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory entry");
      const method = buf.readUInt16LE(p + 10);
      const compressedSize = buf.readUInt32LE(p + 20);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const localOffset = buf.readUInt32LE(p + 42);
      const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
      if (name === entryName) {
        if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("bad local header");
        const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
        const data = buf.subarray(start, start + compressedSize);
        if (data.length !== compressedSize) throw new Error("truncated entry");
        if (method === 0) return Buffer.from(data);
        if (method === 8) return inflateRawSync(data);
        throw new Error(`compression method ${method}`);
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return undefined;
  } catch (e) {
    throw new Error(`not a readable XPI (ZIP): ${(e as Error).message}`);
  }
}

/** Numeric comparison of dotted versions; a pre-release suffix ("1.0.6-dev.1") is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[-+]/)[0].split(".").map((x) => parseInt(x, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface BridgeInfo {
  id: string;
  version: string;
  maxZoteroVersion?: string;
}

/** Reads and checks the XPI's manifest: the bridge's ID, version 1.0.5 or later. */
export function readBridgeXpi(xpiPath: string): BridgeInfo {
  let manifestText: Buffer | undefined;
  try {
    manifestText = readZipEntry(readFileSync(xpiPath), "manifest.json");
  } catch (e) {
    throw new InstanceSetupError(`${xpiPath}: ${(e as Error).message}.`);
  }
  if (!manifestText) throw new InstanceSetupError(`${xpiPath} has no manifest.json: not a Zotero plugin.`);
  let manifest: Record<string, any>;
  try {
    manifest = JSON.parse(manifestText.toString("utf8"));
  } catch {
    throw new InstanceSetupError(`${xpiPath}: manifest.json is not valid JSON.`);
  }
  const app = manifest.applications?.zotero ?? manifest.browser_specific_settings?.zotero ?? {};
  const id = String(app.id ?? "");
  const version = String(manifest.version ?? "");
  if (id !== BRIDGE_ID) {
    throw new InstanceSetupError(
      `${xpiPath} is not the MCP Bridge for Zotero (add-on ID ${JSON.stringify(id)}, expected "${BRIDGE_ID}").`
    );
  }
  if (!version || compareVersions(version, MIN_BRIDGE_VERSION) < 0) {
    throw new InstanceSetupError(
      `${xpiPath} is MCP Bridge ${version || "(no version)"}; ${MIN_BRIDGE_VERSION} or later is required: ` +
        `earlier releases ignore extensions.mcp-rdp.port and listen on 6100 whatever the profile says. ` +
        `Download the current one from ${BRIDGE_RELEASES_URL}`
    );
  }
  return { id, version, maxZoteroVersion: app.strict_max_version ? String(app.strict_max_version) : undefined };
}

// ---------------------------------------------------------------------------
// Zotero executable

/**
 * The standard install locations to look at. Windows: the installer's
 * default folders. macOS: every Zotero*.app in /Applications and
 * ~/Applications (a beta installs next to the release). Linux: the folder the
 * release tarball extracts to (Zotero_linux-<arch>, from app/build.sh) in the
 * home directory, and /opt/zotero.
 */
export function zoteroExecutableCandidates(host: HostEnv, listDir: (dir: string) => string[] = safeReaddir): string[] {
  const p = pathFor(host);
  if (host.platform === "win32") {
    const dirs = [host.env.ProgramFiles, host.env["ProgramFiles(x86)"], host.env.LOCALAPPDATA && p.join(host.env.LOCALAPPDATA, "Programs")]
      .filter((d): d is string => Boolean(d));
    return [...new Set(dirs)].map((d) => p.join(d, "Zotero", "zotero.exe"));
  }
  if (host.platform === "darwin") {
    const out: string[] = [];
    for (const dir of ["/Applications", p.join(host.home, "Applications")]) {
      for (const entry of listDir(dir).filter((e) => /^Zotero.*\.app$/.test(e)).sort()) {
        out.push(p.join(dir, entry, "Contents", "MacOS", "zotero"));
      }
    }
    return out;
  }
  return [
    p.join(host.home, "Zotero_linux-x86_64", "zotero"),
    p.join(host.home, "Zotero_linux-arm64", "zotero"),
    "/opt/zotero/zotero",
  ];
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The executable to launch: the given path (a macOS .app bundle is resolved), or the single one found. */
export function resolveZoteroExecutable(given: unknown, host: HostEnv, fileExists: (p: string) => boolean = isFile): string {
  const p = pathFor(host);
  if (given !== undefined && given !== null && given !== "") {
    if (typeof given !== "string" || !p.isAbsolute(given)) {
      throw new InstanceSetupError(`zoteroPath must be an absolute path to the Zotero executable (got ${JSON.stringify(given)}).`);
    }
    const exe = /\.app[\\/]?$/.test(given) ? p.join(given, "Contents", "MacOS", "zotero") : given;
    if (!fileExists(exe)) throw new InstanceSetupError(`No Zotero executable at ${exe}.`);
    return exe;
  }
  const candidates = zoteroExecutableCandidates(host);
  const found = candidates.filter(fileExists);
  if (found.length === 1) return found[0];
  if (found.length === 0) {
    throw new InstanceSetupError(
      `No Zotero executable found at the standard locations:\n${candidates.map((c) => `  - ${c}`).join("\n")}\n` +
        `Pass zoteroPath: the absolute path of the Zotero executable to run (zotero.exe on Windows, ` +
        `Zotero.app on macOS, the "zotero" script of the extracted tarball on Linux).`
    );
  }
  throw new InstanceSetupError(
    `Several Zotero installations found; pass zoteroPath to choose one:\n${found.map((c) => `  - ${c}`).join("\n")}`
  );
}

// ---------------------------------------------------------------------------
// What already exists: profile-manager profiles and instances made here

/** Where Zotero's profile manager keeps profiles.ini (the same roots config.ts searches). */
export function profileManagerRoot(host: HostEnv): string {
  const p = pathFor(host);
  if (host.platform === "win32") {
    return host.env.APPDATA ? p.join(host.env.APPDATA, "Zotero", "Zotero") : p.join(host.home, "AppData", "Roaming", "Zotero", "Zotero");
  }
  if (host.platform === "darwin") return p.join(host.home, "Library", "Application Support", "Zotero");
  return p.join(host.home, ".zotero", "zotero");
}

export interface IniProfile {
  name: string;
  path: string;
  isDefault: boolean;
}

/** The [ProfileN] sections of a profiles.ini, with relative paths resolved against `root`. */
export function parseProfilesIni(text: string, root: string, p: path.PlatformPath = path): IniProfile[] {
  const out: IniProfile[] = [];
  let section: Record<string, string> | null = null;
  const flush = () => {
    if (section?.Path) {
      const rel = section.IsRelative === "1";
      out.push({
        name: section.Name ?? section.Path,
        path: rel ? p.join(root, ...section.Path.split("/")) : section.Path,
        isDefault: section.Default === "1",
      });
    }
  };
  for (const raw of text.split(/\r?\n|\r/)) {
    const line = raw.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      flush();
      section = /^\[Profile\d+\]$/i.test(line) ? {} : null;
    } else if (section && line.includes("=")) {
      const i = line.indexOf("=");
      section[line.slice(0, i)] = line.slice(i + 1);
    }
  }
  flush();
  return out;
}

/** The last value a prefs.js/user.js text gives a preference, or undefined. */
export function readPrefValue(text: string, name: string): string | number | boolean | undefined {
  const re = new RegExp(`user_pref\\(\\s*"${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*,\\s*(.+?)\\s*\\)\\s*;`, "g");
  let value: string | number | boolean | undefined;
  for (const m of text.matchAll(re)) {
    const v = m[1];
    if (v === "true" || v === "false") value = v === "true";
    else if (/^-?\d+$/.test(v)) value = Number(v);
    else {
      try {
        value = JSON.parse(v);
      } catch {
        value = v;
      }
    }
  }
  return value;
}

function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export interface ProfilePorts {
  /**
   * The bridge port configured in this profile; 6100 when the bridge is
   * installed with no port set; undefined when neither.
   */
  rdpPort?: number;
  httpPort: number;
  dataDir?: string;
  bridgeInstalled: boolean;
}

/** The ports and data directory a profile is configured with, read from its user.js and prefs.js. */
export function readProfilePorts(profileDir: string): ProfilePorts {
  // user.js is applied after prefs.js, so it wins.
  const texts = [readText(path.join(profileDir, "prefs.js")), readText(path.join(profileDir, "user.js"))];
  const pref = (name: string) => {
    let v: string | number | boolean | undefined;
    for (const t of texts) v = readPrefValue(t, name) ?? v;
    return v;
  };
  const bridgeInstalled = existsSync(path.join(profileDir, "extensions", `${BRIDGE_ID}.xpi`));
  // Bridge releases up to 1.0.4 stored the port under the prefixed name; 1.0.5+ still read it.
  const rdp = pref("extensions.mcp-rdp.port") ?? pref("extensions.zotero.extensions.mcp-rdp.port");
  const http = pref("extensions.zotero.httpServer.port");
  const dataDir = pref("extensions.zotero.useDataDir") === true ? pref("extensions.zotero.dataDir") : undefined;
  return {
    bridgeInstalled,
    rdpPort: typeof rdp === "number" ? rdp : bridgeInstalled ? DEFAULT_RDP_PORT : undefined,
    httpPort: typeof http === "number" ? http : DEFAULT_HTTP_PORT,
    dataDir: typeof dataDir === "string" ? dataDir : undefined,
  };
}

/** What zotero_instance_setup records in <instance>/zotero-instance.json. */
export interface InstanceRecord {
  createdBy: typeof MARKER_CREATED_BY;
  serverVersion: string;
  createdAt: string;
  name: string;
  rdpPort: number;
  httpPort: number;
  profileDir: string;
  dataDir: string;
  zoteroPath: string;
  bridge: { source: string; version: string };
}

/** The record of an instance directory this tool made, or undefined for any other directory. */
export function readMarker(root: string): InstanceRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(path.join(root, MARKER_FILE), "utf8")) as InstanceRecord;
    return record.createdBy === MARKER_CREATED_BY && typeof record.name === "string" ? record : undefined;
  } catch {
    return undefined;
  }
}

export interface InventoryEntry {
  kind: "instance" | "profile";
  name: string;
  profileDir: string;
  isDefault?: boolean;
  ports: ProfilePorts;
  record?: InstanceRecord;
}

export interface Inventory {
  parentDir: string;
  profilesIni: string;
  executables: string[];
  entries: InventoryEntry[];
}

/** Instances made here (under parentDir) and profiles of Zotero's profile manager. Reads files only. */
export function takeInventory(host: HostEnv, parentDir: string): Inventory {
  const entries: InventoryEntry[] = [];
  for (const dir of safeReaddir(parentDir).sort()) {
    const root = path.join(parentDir, dir);
    const record = readMarker(root);
    if (!record) continue;
    const profileDir = path.join(root, "profile");
    entries.push({ kind: "instance", name: record.name, profileDir, ports: readProfilePorts(profileDir), record });
  }
  const pmRoot = profileManagerRoot(host);
  const profilesIni = path.join(pmRoot, "profiles.ini");
  for (const prof of parseProfilesIni(readText(profilesIni), pmRoot)) {
    entries.push({ kind: "profile", name: prof.name, profileDir: prof.path, isDefault: prof.isDefault, ports: readProfilePorts(prof.path) });
  }
  const executables = zoteroExecutableCandidates(host).filter(isFile);
  return { parentDir, profilesIni, executables, entries };
}

// ---------------------------------------------------------------------------
// Ports

/** True when something accepts a TCP connection on 127.0.0.1:port within the timeout. */
export function portAnswers(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const done = (answered: boolean) => {
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Undefined when 127.0.0.1:port can be bound now, else the error code (EADDRINUSE, EACCES, ...). */
export function bindError(port: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? e.message));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => server.close(() => resolve(undefined)));
  });
}

/**
 * Why the port cannot be given to a new instance right now, or undefined when
 * it is free. A listener is caught by the connect; the bind also catches a
 * port reserved by the OS (Windows excludes whole port ranges, which then fail
 * with EACCES).
 */
export async function portBusy(port: number): Promise<string | undefined> {
  if (await portAnswers(port)) return "something already answers on it";
  const err = await bindError(port);
  return err ? `it cannot be bound (${err})` : undefined;
}

// ---------------------------------------------------------------------------
// Setup

export interface SetupArgs {
  name?: unknown;
  rdpPort?: unknown;
  httpPort?: unknown;
  zoteroPath?: unknown;
  bridgeXpi?: unknown;
  parentDir?: unknown;
}

export interface SetupContext {
  host: HostEnv;
  /** ZOTERO_RDP_PORT of the server handling the call: the instance it already drives. */
  configuredPort: number;
  /** ZOTERO_PROFILE_PATH (or the detected profile): where to look for a bridge XPI to copy. */
  profilePath?: string;
  serverVersion: string;
  /** Injectable for tests; defaults to portBusy. */
  portBusy?: (port: number) => Promise<string | undefined>;
  now?: () => Date;
}

export interface SetupResult {
  created: boolean;
  record: InstanceRecord;
  paths: InstancePaths;
  argv: string[];
  commands: { shell: string; line: string }[];
  mcpEntry: McpServerEntry;
  bridge?: BridgeInfo;
}

function absoluteOrThrow(value: unknown, label: string, host: HostEnv): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !pathFor(host).isAbsolute(value)) {
    throw new InstanceSetupError(`${label} must be an absolute path (got ${JSON.stringify(value)}).`);
  }
  return value;
}

function resultFor(record: InstanceRecord, paths: InstancePaths, ctx: SetupContext, created: boolean, bridge?: BridgeInfo): SetupResult {
  const argv = launchArgs(record.zoteroPath, record.profileDir);
  return {
    created,
    record,
    paths,
    argv,
    commands: launchCommands(argv, ctx.host.platform),
    mcpEntry: mcpServerEntry({ ...record, serverVersion: ctx.serverVersion }),
    bridge,
  };
}

/**
 * Creates the instance, or returns the existing one when this tool made it
 * with the same arguments. Refuses, before writing anything, a target
 * directory it did not make, a port that is reserved, recorded elsewhere or in
 * use, a missing executable and a missing or wrong bridge XPI. A failure while
 * writing removes the directory it had just created, so no half-made instance
 * is left behind.
 */
export async function setupInstance(args: SetupArgs, ctx: SetupContext): Promise<SetupResult> {
  const { host } = ctx;
  const name = validateName(args.name);
  const rdpPort = validatePort(args.rdpPort, "rdpPort");
  const httpPortArg = args.httpPort === undefined || args.httpPort === null || args.httpPort === "" ? undefined : validatePort(args.httpPort, "httpPort");
  const parentDir = absoluteOrThrow(args.parentDir, "parentDir", host) ?? defaultParentDir(host);
  const paths = instancePaths(parentDir, name);

  // An instance this tool made: hand back its setup, change nothing.
  if (existsSync(paths.root)) {
    const record = readMarker(paths.root);
    if (!record) {
      throw new InstanceSetupError(
        `${paths.root} already exists and was not made by zotero_instance_setup: it is left untouched. ` +
          `Choose another name or parentDir.`
      );
    }
    const zoteroPathArg = args.zoteroPath ? resolveZoteroExecutable(args.zoteroPath, host) : undefined;
    const differs = [
      rdpPort !== record.rdpPort && `rdpPort ${record.rdpPort}`,
      httpPortArg !== undefined && httpPortArg !== record.httpPort && `httpPort ${record.httpPort}`,
      zoteroPathArg !== undefined && zoteroPathArg !== record.zoteroPath && `zoteroPath ${record.zoteroPath}`,
    ].filter(Boolean);
    if (differs.length) {
      throw new InstanceSetupError(
        `Instance "${name}" already exists in ${parentDir} with ${differs.join(", ")}; nothing was changed. ` +
          `Call again with those values (or without the optional ones) to get its launch command, or choose another name.`
      );
    }
    return resultFor(record, paths, ctx, false);
  }

  const httpPort = httpPortArg ?? defaultHttpPort(rdpPort);
  if (httpPort === undefined) {
    throw new InstanceSetupError(`No default HTTP port for rdpPort ${rdpPort}: pass httpPort.`);
  }

  // Ports: reserved, recorded by another profile, in use - in that order.
  if (rdpPort === DEFAULT_RDP_PORT) {
    throw new InstanceSetupError(
      `rdpPort ${DEFAULT_RDP_PORT} is the bridge's default port, which the Zotero you already run listens on. ` +
        `Two instances on one port end up with every client driving the first (#19). Pick another port, e.g. 6101.`
    );
  }
  if (rdpPort === ctx.configuredPort) {
    throw new InstanceSetupError(
      `rdpPort ${rdpPort} is the port this MCP server drives (ZOTERO_RDP_PORT): it belongs to an existing instance. Pick another port.`
    );
  }
  if (httpPort === DEFAULT_HTTP_PORT) {
    throw new InstanceSetupError(`httpPort ${DEFAULT_HTTP_PORT} is Zotero's default HTTP port, used by the Zotero you already run. Pick another.`);
  }
  if (httpPort === rdpPort) {
    throw new InstanceSetupError(`rdpPort and httpPort must differ (both ${rdpPort}).`);
  }
  const inventory = takeInventory(host, parentDir);
  for (const e of inventory.entries) {
    const owner = `${e.kind === "instance" ? "instance" : "profile"} "${e.name}" (${e.profileDir})`;
    if (e.ports.rdpPort === rdpPort || e.ports.httpPort === rdpPort) {
      throw new InstanceSetupError(`Port ${rdpPort} is already configured for ${owner}, running or not. Pick another rdpPort.`);
    }
    if (e.ports.httpPort === httpPort || e.ports.rdpPort === httpPort) {
      throw new InstanceSetupError(`Port ${httpPort} is already configured for ${owner}, running or not. Pick another httpPort.`);
    }
  }
  const busy = ctx.portBusy ?? portBusy;
  for (const [label, port] of [["rdpPort", rdpPort], ["httpPort", httpPort]] as const) {
    const why = await busy(port);
    if (why) throw new InstanceSetupError(`${label} ${port} is not free: ${why}. Pick another ${label}.`);
  }

  const zoteroPath = resolveZoteroExecutable(args.zoteroPath, host);

  const xpiArg = absoluteOrThrow(args.bridgeXpi, "bridgeXpi", host);
  const xpiSource = xpiArg ?? (ctx.profilePath ? path.join(ctx.profilePath, "extensions", `${BRIDGE_ID}.xpi`) : undefined);
  if (!xpiSource || !isFile(xpiSource)) {
    throw new InstanceSetupError(
      (xpiArg
        ? `No file at bridgeXpi ${xpiArg}.`
        : `No bridge XPI to copy: ${xpiSource ? `${xpiSource} does not exist` : "no Zotero profile is configured (ZOTERO_PROFILE_PATH)"}.`) +
        ` Pass bridgeXpi: the path of zotero-mcp-bridge-<version>.xpi from ${BRIDGE_RELEASES_URL}`
    );
  }
  const bridge = readBridgeXpi(xpiSource);

  const record: InstanceRecord = {
    createdBy: MARKER_CREATED_BY,
    serverVersion: ctx.serverVersion,
    createdAt: (ctx.now ?? (() => new Date()))().toISOString(),
    name,
    rdpPort,
    httpPort,
    profileDir: paths.profileDir,
    dataDir: paths.dataDir,
    zoteroPath,
    bridge: { source: xpiSource, version: bridge.version },
  };

  mkdirSync(parentDir, { recursive: true });
  try {
    // Not recursive: fails if another call created the directory since the check above.
    mkdirSync(paths.root);
  } catch (e) {
    throw new InstanceSetupError(`Cannot create ${paths.root}: ${(e as Error).message}`);
  }
  try {
    mkdirSync(paths.extensionsDir, { recursive: true });
    mkdirSync(paths.dataDir);
    copyFileSync(xpiSource, paths.bridgeXpi, constants.COPYFILE_EXCL);
    writeFileSync(paths.userJs, buildUserJs({ name, dataDir: paths.dataDir, rdpPort, httpPort }), { flag: "wx" });
    writeFileSync(paths.marker, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  } catch (e) {
    rmSync(paths.root, { recursive: true, force: true });
    throw new InstanceSetupError(`Setting up ${paths.root} failed, nothing was kept: ${(e as Error).message}`);
  }
  return resultFor(record, paths, ctx, true, bridge);
}
