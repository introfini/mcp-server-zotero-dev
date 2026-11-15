/**
 * Unit tests for zotero_instance_setup / zotero_instance_list (#29).
 *
 * Everything here runs without Zotero: the tools never talk to one. The
 * filesystem cases work in a fresh temp directory, with a sandboxed host (its
 * own home and APPDATA) so that the inventory never reads the profiles of the
 * Zotero on the machine running the tests, and the XPIs are ZIPs built here,
 * so no bridge build is needed. The port probe is stubbed except in the case
 * that holds a real port. tests/instance-live.test.mts starts a real instance.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BRIDGE_ID,
  buildUserJs,
  compareVersions,
  defaultHttpPort,
  defaultParentDir,
  formatCommand,
  launchArgs,
  mcpServerEntry,
  parseProfilesIni,
  readBridgeXpi,
  readPrefValue,
  readZipEntry,
  resolveZoteroExecutable,
  setupInstance,
  validateName,
  validatePort,
  zoteroExecutableCandidates,
  type HostEnv,
  type SetupContext,
} from "../src/utils/instance.js";
import { formatSetup, handleInstanceList } from "../src/tools/instance.js";

/** A minimal ZIP (no CRCs: neither readZipEntry nor these tests check them). */
function makeZip(entries: Record<string, string>, deflate = true): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text, "utf8");
    const data = deflate ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(deflate ? 8 : 0, 10);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, data);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

function bridgeManifest(version: string, id = BRIDGE_ID): string {
  return JSON.stringify({
    manifest_version: 2,
    name: "MCP Bridge for Zotero",
    version,
    applications: { zotero: { id, strict_min_version: "6.999", strict_max_version: "10.0.*" } },
  });
}

describe("arguments", () => {
  it("accepts directory-safe names and refuses the rest", () => {
    for (const ok of ["beta", "session-b", "i29.a", "z_11", "a"]) expect(validateName(ok)).toBe(ok);
    for (const bad of ["", "../x", "a/b", "a\\b", "a b", "x.", ".x", "-x", "a".repeat(65), 7, undefined]) {
      expect(() => validateName(bad), String(bad)).toThrow(/Invalid instance name/);
    }
  });

  it("accepts unprivileged ports, as numbers or digit strings", () => {
    expect(validatePort(6101, "rdpPort")).toBe(6101);
    expect(validatePort("6101", "rdpPort")).toBe(6101);
    for (const bad of [80, 1023, 65536, 6101.5, "61o1", "", null]) {
      expect(() => validatePort(bad, "rdpPort"), String(bad)).toThrow(/Invalid rdpPort/);
    }
  });

  it("moves the default HTTP port by the RDP port's offset", () => {
    expect(defaultHttpPort(6101)).toBe(23120);
    expect(defaultHttpPort(6191)).toBe(23210);
    expect(defaultHttpPort(50000)).toBeUndefined(); // 66 919 is not a port
  });
});

describe("user.js", () => {
  const dataDir = "D:\\Zotero instances\\beta \"x\"\\data";
  const text = buildUserJs({ name: "beta", dataDir, rdpPort: 6101, httpPort: 23120 });

  it("gives the profile its own data directory, ports and an enabled sideload", () => {
    expect(readPrefValue(text, "extensions.zotero.dataDir")).toBe(dataDir); // escaped and read back intact
    expect(readPrefValue(text, "extensions.zotero.useDataDir")).toBe(true);
    expect(readPrefValue(text, "extensions.mcp-rdp.port")).toBe(6101);
    expect(readPrefValue(text, "extensions.zotero.httpServer.port")).toBe(23120);
    expect(readPrefValue(text, "extensions.zotero.sync.autoSync")).toBe(false);
    expect(readPrefValue(text, "extensions.autoDisableScopes")).toBe(0);
    expect(readPrefValue(text, "extensions.zoteroWinWordIntegration.skipInstallation")).toBe(true);
    expect(readPrefValue(text, "extensions.zoteroMacWordIntegration.skipInstallation")).toBe(true);
    expect(readPrefValue(text, "extensions.zoteroOpenOfficeIntegration.skipInstallation")).toBe(true);
  });

  it("writes the port as a number, never as a string or boolean", () => {
    // A Boolean port makes the bridge open a pipe instead of a TCP port (README).
    expect(text).toContain('user_pref("extensions.mcp-rdp.port", 6101);');
  });

  it("reads the last value a prefs file gives", () => {
    const prefs = 'user_pref("a.b", 1);\nuser_pref("a.b", 2);\nuser_pref("a.bc", 3);\nuser_pref("s", "C:\\\\x");\n';
    expect(readPrefValue(prefs, "a.b")).toBe(2);
    expect(readPrefValue(prefs, "s")).toBe("C:\\x");
    expect(readPrefValue(prefs, "missing")).toBeUndefined();
  });
});

describe("launch command and server entry", () => {
  it("launches with its own profile and -no-remote", () => {
    expect(launchArgs("/opt/zotero/zotero", "/p")).toEqual(["/opt/zotero/zotero", "-profile", "/p", "-no-remote"]);
  });

  it("quotes for cmd, PowerShell and sh", () => {
    const win = ["C:\\Program Files\\Zotero\\zotero.exe", "-profile", "D:\\inst\\beta\\profile", "-no-remote"];
    expect(formatCommand(win, "cmd")).toBe('"C:\\Program Files\\Zotero\\zotero.exe" -profile D:\\inst\\beta\\profile -no-remote');
    expect(formatCommand(win, "powershell")).toBe("& 'C:\\Program Files\\Zotero\\zotero.exe' -profile D:\\inst\\beta\\profile -no-remote");
    const mac = ["/Applications/Zotero Beta.app/Contents/MacOS/zotero", "-profile", "/Users/o'neil/z/profile", "-no-remote"];
    expect(formatCommand(mac, "sh")).toBe(
      "'/Applications/Zotero Beta.app/Contents/MacOS/zotero' -profile '/Users/o'\\''neil/z/profile' -no-remote"
    );
  });

  it("pins the server version and points every variable at the instance", () => {
    expect(mcpServerEntry({ rdpPort: 6101, dataDir: "/d", profileDir: "/p", serverVersion: "1.1.5" })).toEqual({
      command: "npx",
      args: ["-y", "@introfini/mcp-server-zotero-dev@1.1.5"],
      env: { ZOTERO_RDP_PORT: "6101", ZOTERO_DATA_DIR: "/d", ZOTERO_PROFILE_PATH: "/p" },
    });
  });
});

describe("bridge XPI", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-instance-xpi-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const write = (name: string, buf: Buffer) => {
    const p = join(dir, name);
    writeFileSync(p, buf);
    return p;
  };

  it("reads stored and deflated entries", () => {
    for (const deflate of [true, false]) {
      const zip = makeZip({ "bootstrap.js": "x", "manifest.json": '{"a":1}' }, deflate);
      expect(readZipEntry(zip, "manifest.json")?.toString()).toBe('{"a":1}');
      expect(readZipEntry(zip, "missing.json")).toBeUndefined();
    }
    expect(() => readZipEntry(Buffer.from("not a zip at all, really not"), "manifest.json")).toThrow(/not a readable XPI/);
  });

  it("accepts the bridge from 1.0.5 on, and reports its version and declared maximum", () => {
    const info = readBridgeXpi(write("ok.xpi", makeZip({ "manifest.json": bridgeManifest("1.0.6") })));
    expect(info).toEqual({ id: BRIDGE_ID, version: "1.0.6", maxZoteroVersion: "10.0.*" });
    expect(readBridgeXpi(write("ok5.xpi", makeZip({ "manifest.json": bridgeManifest("1.0.5") }))).version).toBe("1.0.5");
  });

  it("refuses a bridge that ignores the port preference (1.0.4 and earlier)", () => {
    const p = write("old.xpi", makeZip({ "manifest.json": bridgeManifest("1.0.4") }));
    expect(() => readBridgeXpi(p)).toThrow(/MCP Bridge 1\.0\.4; 1\.0\.5 or later is required/);
  });

  it("refuses another plugin, a ZIP without manifest and a non-ZIP", () => {
    expect(() => readBridgeXpi(write("other.xpi", makeZip({ "manifest.json": bridgeManifest("2.0.0", "other@example.com") })))).toThrow(
      /not the MCP Bridge for Zotero/
    );
    expect(() => readBridgeXpi(write("empty.xpi", makeZip({ "bootstrap.js": "" })))).toThrow(/no manifest\.json/);
    expect(() => readBridgeXpi(write("junk.xpi", Buffer.from("junk junk junk junk junk")))).toThrow(/not a readable XPI/);
  });

  it("compares dotted versions numerically", () => {
    expect(compareVersions("1.0.10", "1.0.5")).toBe(1);
    expect(compareVersions("1.0.5", "1.0.5")).toBe(0);
    expect(compareVersions("1.0.4", "1.0.5")).toBe(-1);
    expect(compareVersions("1.0.6-dev.1", "1.0.5")).toBe(1);
  });
});

describe("Zotero executable", () => {
  it("looks in the installer folders on Windows", () => {
    const host: HostEnv = { platform: "win32", home: "C:\\Users\\u", env: { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" } };
    expect(zoteroExecutableCandidates(host)).toEqual([
      "C:\\Program Files\\Zotero\\zotero.exe",
      "C:\\Program Files (x86)\\Zotero\\zotero.exe",
    ]);
  });

  it("takes every Zotero*.app on macOS, the release and a beta alike", () => {
    const host: HostEnv = { platform: "darwin", home: "/Users/u", env: {} };
    const listDir = (d: string) => (d === "/Applications" ? ["Safari.app", "Zotero.app", "Zotero Beta.app"] : []);
    expect(zoteroExecutableCandidates(host, listDir)).toEqual([
      "/Applications/Zotero Beta.app/Contents/MacOS/zotero",
      "/Applications/Zotero.app/Contents/MacOS/zotero",
    ]);
  });

  it("looks for the extracted tarball on Linux", () => {
    const host: HostEnv = { platform: "linux", home: "/home/u", env: {} };
    expect(zoteroExecutableCandidates(host)).toContain("/home/u/Zotero_linux-x86_64/zotero");
  });

  it("resolves a .app bundle and refuses relative or missing paths", () => {
    const mac: HostEnv = { platform: "darwin", home: "/Users/u", env: {} };
    const exists = (p: string) => p === "/Applications/Zotero.app/Contents/MacOS/zotero";
    expect(resolveZoteroExecutable("/Applications/Zotero.app", mac, exists)).toBe("/Applications/Zotero.app/Contents/MacOS/zotero");
    expect(() => resolveZoteroExecutable("zotero", mac, exists)).toThrow(/absolute path/);
    expect(() => resolveZoteroExecutable("/nope/zotero", mac, exists)).toThrow(/No Zotero executable at/);
  });

  it("asks for zoteroPath when it finds none, or more than one", () => {
    const win: HostEnv = { platform: "win32", home: "C:\\Users\\u", env: { ProgramFiles: "C:\\PF", "ProgramFiles(x86)": "C:\\PF86" } };
    expect(() => resolveZoteroExecutable(undefined, win, () => false)).toThrow(/No Zotero executable found[\s\S]*C:\\PF\\Zotero\\zotero\.exe[\s\S]*Pass zoteroPath/);
    expect(() => resolveZoteroExecutable(undefined, win, () => true)).toThrow(/Several Zotero installations found/);
    expect(resolveZoteroExecutable(undefined, win, (p) => p.startsWith("C:\\PF86"))).toBe("C:\\PF86\\Zotero\\zotero.exe");
  });
});

describe("profiles.ini", () => {
  it("resolves relative and absolute profile paths and the default", () => {
    const ini = "[General]\nStartWithLastProfile=1\n\n[Profile0]\nName=default\nIsRelative=1\nPath=Profiles/ab12.default\nDefault=1\n\n" +
      "[Profile1]\nName=dev\nIsRelative=0\nPath=D:\\dev\\profile\n";
    expect(parseProfilesIni(ini, "C:\\Z", path.win32)).toEqual([
      { name: "default", path: "C:\\Z\\Profiles\\ab12.default", isDefault: true },
      { name: "dev", path: "D:\\dev\\profile", isDefault: false },
    ]);
  });
});

describe("setupInstance (temp directory, sandboxed host)", () => {
  let sandbox: string;
  let parentDir: string;
  let host: HostEnv;
  let zoteroPath: string;
  let bridgeXpi: string;
  let ctx: SetupContext;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "mcp-instance-"));
    parentDir = join(sandbox, "instances");
    // Home and APPDATA inside the sandbox: the inventory reads profiles.ini from there.
    host = { platform: process.platform, home: join(sandbox, "home"), env: { APPDATA: join(sandbox, "appdata") } };
    zoteroPath = join(sandbox, "zotero-exe");
    writeFileSync(zoteroPath, "");
    bridgeXpi = join(sandbox, "zotero-mcp-bridge-1.0.6.xpi");
    writeFileSync(bridgeXpi, makeZip({ "manifest.json": bridgeManifest("1.0.6"), "bootstrap.js": "// bridge" }));
    ctx = { host, configuredPort: 6100, serverVersion: "1.1.5", portBusy: async () => undefined, now: () => new Date("2026-11-15T12:00:00Z") };
  });
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  const args = (over: Record<string, unknown> = {}) => ({ name: "beta", rdpPort: 6191, zoteroPath, bridgeXpi, parentDir, ...over });

  it("creates the profile, the empty data directory, user.js, the bridge and its record", async () => {
    const r = await setupInstance(args(), ctx);
    const root = join(parentDir, "beta");
    expect(r.created).toBe(true);
    expect(r.record).toMatchObject({ name: "beta", rdpPort: 6191, httpPort: 23210, zoteroPath, profileDir: join(root, "profile"), dataDir: join(root, "data") });
    expect(readdirSync(join(root, "data"))).toEqual([]);
    expect(readFileSync(join(root, "profile", "extensions", `${BRIDGE_ID}.xpi`))).toEqual(readFileSync(bridgeXpi));
    const userJs = readFileSync(join(root, "profile", "user.js"), "utf8");
    expect(readPrefValue(userJs, "extensions.zotero.dataDir")).toBe(join(root, "data"));
    expect(readPrefValue(userJs, "extensions.mcp-rdp.port")).toBe(6191);
    expect(readPrefValue(userJs, "extensions.zotero.httpServer.port")).toBe(23210);
    expect(JSON.parse(readFileSync(join(root, "zotero-instance.json"), "utf8"))).toMatchObject({
      createdBy: "mcp-server-zotero-dev",
      createdAt: "2026-11-15T12:00:00.000Z",
      bridge: { source: bridgeXpi, version: "1.0.6" },
    });
    expect(r.argv).toEqual([zoteroPath, "-profile", join(root, "profile"), "-no-remote"]);
    expect(r.mcpEntry.env.ZOTERO_RDP_PORT).toBe("6191");
  });

  it("returns the same setup when called again, without rewriting anything", async () => {
    const first = await setupInstance(args({ httpPort: 23391 }), ctx);
    const userJs = join(first.paths.profileDir, "user.js");
    const before = statSync(userJs).mtimeMs;
    const again = await setupInstance(args(), { ...ctx, portBusy: async () => "busy" });
    expect(again.created).toBe(false);
    expect(again.record).toEqual(first.record);
    expect(again.argv).toEqual(first.argv);
    expect(statSync(userJs).mtimeMs).toBe(before);
  });

  it("refuses to change an existing instance", async () => {
    await setupInstance(args(), ctx);
    await expect(setupInstance(args({ rdpPort: 6192 }), ctx)).rejects.toThrow(/already exists .* with rdpPort 6191; nothing was changed/);
    await expect(setupInstance(args({ httpPort: 23999 }), ctx)).rejects.toThrow(/httpPort 23210/);
  });

  it("never touches a directory it did not make", async () => {
    const root = join(parentDir, "beta");
    mkdirSync(join(root, "profile"), { recursive: true });
    writeFileSync(join(root, "profile", "prefs.js"), "// someone's profile\n");
    await expect(setupInstance(args(), ctx)).rejects.toThrow(/already exists and was not made by zotero_instance_setup/);
    expect(readdirSync(root)).toEqual(["profile"]);
    expect(readdirSync(join(root, "profile"))).toEqual(["prefs.js"]);
  });

  it("refuses the default ports, the server's own port and equal ports", async () => {
    await expect(setupInstance(args({ rdpPort: 6100 }), ctx)).rejects.toThrow(/6100 is the bridge's default port/);
    await expect(setupInstance(args({ rdpPort: 6177 }), { ...ctx, configuredPort: 6177 })).rejects.toThrow(/port this MCP server drives/);
    await expect(setupInstance(args({ httpPort: 23119 }), ctx)).rejects.toThrow(/Zotero's default HTTP port/);
    await expect(setupInstance(args({ httpPort: 6191 }), ctx)).rejects.toThrow(/must differ/);
    expect(existsSync(parentDir)).toBe(false);
  });

  it("refuses a port another instance is configured with, running or not", async () => {
    await setupInstance(args({ name: "a", httpPort: 23391 }), ctx);
    await expect(setupInstance(args({ name: "b", httpPort: 23392 }), ctx)).rejects.toThrow(/Port 6191 is already configured for instance "a"/);
    await expect(setupInstance(args({ name: "b", rdpPort: 6192, httpPort: 23391 }), ctx)).rejects.toThrow(
      /Port 23391 is already configured for instance "a"/
    );
  });

  it("refuses a port a profile-manager profile is configured with", async () => {
    // The sandbox's profile manager: one profile with the bridge on 6192.
    const pmRoot =
      process.platform === "win32" ? join(sandbox, "appdata", "Zotero", "Zotero")
      : process.platform === "darwin" ? join(host.home, "Library", "Application Support", "Zotero")
      : join(host.home, ".zotero", "zotero");
    const prof = join(pmRoot, "Profiles", "x.dev");
    mkdirSync(join(prof, "extensions"), { recursive: true });
    writeFileSync(join(pmRoot, "profiles.ini"), "[Profile0]\nName=dev\nIsRelative=1\nPath=Profiles/x.dev\nDefault=1\n");
    writeFileSync(join(prof, "prefs.js"), 'user_pref("extensions.mcp-rdp.port", 6192);\n');
    writeFileSync(join(prof, "extensions", `${BRIDGE_ID}.xpi`), "");
    await expect(setupInstance(args({ rdpPort: 6192, httpPort: 23392 }), ctx)).rejects.toThrow(/Port 6192 is already configured for profile "dev"/);

    const list = (await handleInstanceList({ parentDir }, { host, configuredPort: 6100, serverVersion: "1.1.5" }))
      .map((c) => c.text)
      .join("\n");
    expect(list).toContain("• dev (default): bridge port 6192, HTTP port 23119");
  });

  it("refuses a port something already listens on (the #19 trap)", async () => {
    const held: Server = createServer();
    await new Promise<void>((resolve) => held.listen(0, "127.0.0.1", resolve));
    const port = (held.address() as { port: number }).port;
    try {
      const real: SetupContext = { ...ctx, portBusy: undefined };
      await expect(setupInstance(args({ rdpPort: port, httpPort: 23391 }), real)).rejects.toThrow(
        new RegExp(`rdpPort ${port} is not free: something already answers on it`)
      );
    } finally {
      await new Promise((resolve) => held.close(resolve));
    }
    expect(existsSync(join(parentDir, "beta"))).toBe(false);
  });

  it("refuses a missing or outdated bridge before creating anything", async () => {
    await expect(setupInstance(args({ bridgeXpi: undefined }), ctx)).rejects.toThrow(/No bridge XPI to copy: no Zotero profile is configured/);
    const fromProfile = { ...ctx, profilePath: join(sandbox, "main-profile") };
    await expect(setupInstance(args({ bridgeXpi: undefined }), fromProfile)).rejects.toThrow(
      /main-profile.extensions.mcp-rdp@zotero\.org\.xpi does not exist/
    );
    const old = join(sandbox, "old.xpi");
    writeFileSync(old, makeZip({ "manifest.json": bridgeManifest("1.0.4") }));
    await expect(setupInstance(args({ bridgeXpi: old }), ctx)).rejects.toThrow(/1\.0\.5 or later is required/);
    expect(existsSync(parentDir)).toBe(false);
  });

  it("copies the bridge installed in the configured profile when no bridgeXpi is given", async () => {
    const main = join(sandbox, "main-profile");
    mkdirSync(join(main, "extensions"), { recursive: true });
    writeFileSync(join(main, "extensions", `${BRIDGE_ID}.xpi`), readFileSync(bridgeXpi));
    const r = await setupInstance(args({ bridgeXpi: undefined }), { ...ctx, profilePath: main });
    expect(r.record.bridge.source).toBe(join(main, "extensions", `${BRIDGE_ID}.xpi`));
  });

  it("defaults to zotero-dev-instances in the home directory", () => {
    expect(defaultParentDir({ platform: "linux", home: "/home/u", env: {} })).toBe("/home/u/zotero-dev-instances");
  });

  it("says what was made, how to start it and which server entry to add", async () => {
    const r = await setupInstance(args(), ctx);
    const [main, next] = formatSetup(r);
    expect(main.text).toMatch(/^✓ Created Zotero instance "beta" \(Zotero was not started\)/);
    for (const c of r.commands) expect(main.text).toContain(c.line);
    const json = JSON.parse(main.text!.slice(main.text!.indexOf("{\n")));
    expect(json.mcpServers["zotero-dev-beta"].env).toEqual({
      ZOTERO_RDP_PORT: "6191",
      ZOTERO_DATA_DIR: r.record.dataDir,
      ZOTERO_PROFILE_PATH: r.record.profileDir,
    });
    expect(next.text).toContain(`Data directory: ${r.record.dataDir}`);

    const list = (await handleInstanceList({ parentDir }, { host, configuredPort: 6100, serverVersion: "1.1.5" }))
      .map((c) => c.text)
      .join("\n");
    expect(list).toMatch(/• beta: bridge port 6191 \(not answering\), HTTP port 23210/);
  });
});
