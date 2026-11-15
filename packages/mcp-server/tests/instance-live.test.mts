/**
 * Live test for zotero_instance_setup (#29): the instance it creates must come
 * up as a Zotero of its own, with the bridge enabled on the instance's port
 * and the instance's own data directory, from the launch command the tool
 * returns.
 *
 * It starts a real Zotero, so it never picks an executable by itself: it runs
 * only when ZOTERO_INSTANCE_TEST_EXE names one, and skips otherwise. Each run
 * creates its instance in a new directory <prefix>-XXXXXX inside the temp
 * directory (or inside ZOTERO_INSTANCE_TEST_DIR), named
 * <prefix>-<time>, where the prefix is ZOTERO_INSTANCE_TEST_PREFIX (default
 * mcp-instance-test), on ZOTERO_INSTANCE_TEST_RDP_PORT /
 * ZOTERO_INSTANCE_TEST_HTTP_PORT (default 6188 / 23188), with the bridge XPI
 * from ZOTERO_BRIDGE_XPI or the workspace build (npm run build). The
 * inventory runs against a sandboxed home, so the test neither reads nor
 * depends on the profiles of the Zotero you use. The instance is quit at the
 * end; its directory is removed in the temp case and kept otherwise.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type GripValue } from "../src/rdp/index.js";
import { portAnswers, readPrefValue, setupInstance, type SetupContext, type SetupResult } from "../src/utils/instance.js";
import { formatSetup } from "../src/tools/instance.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXE = process.env.ZOTERO_INSTANCE_TEST_EXE ?? "";
const RDP_PORT = Number(process.env.ZOTERO_INSTANCE_TEST_RDP_PORT ?? "6188");
const HTTP_PORT = Number(process.env.ZOTERO_INSTANCE_TEST_HTTP_PORT ?? "23188");
const PREFIX = process.env.ZOTERO_INSTANCE_TEST_PREFIX ?? "mcp-instance-test";
const XPI =
  process.env.ZOTERO_BRIDGE_XPI ?? join(PKG_ROOT, "..", "zotero-plugin-mcp-rdp", "build", "zotero-mcp-bridge.xpi");

const skipReason = !EXE
  ? "ZOTERO_INSTANCE_TEST_EXE is not set (the Zotero executable to start a test instance with)"
  : !existsSync(EXE)
    ? `ZOTERO_INSTANCE_TEST_EXE does not exist: ${EXE}`
    : !existsSync(XPI)
      ? `no bridge XPI at ${XPI} (run npm run build, or set ZOTERO_BRIDGE_XPI)`
      : "";
if (skipReason) console.warn(`[instance-live.test] skipping - ${skipReason}`);

const samePath = (a: string, b: string) =>
  process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

/** One evaluation on a fresh RDP client: the JSON string it returns, parsed, or an Error. */
async function evalJson(port: number, code: string, timeout = 15_000): Promise<any> {
  const client = createClient({ port, timeout });
  try {
    await client.connect();
    const r = await client.evaluateJS(code);
    if (r.exception) return new Error(`eval threw: ${r.exceptionMessage}`);
    const v = await client.gripToValueAsync(r.result as GripValue);
    return typeof v === "string" ? JSON.parse(v) : new Error(`unexpected result ${JSON.stringify(v)}`);
  } catch (e) {
    return e as Error;
  } finally {
    try { client.disconnect(); } catch { /* not connected */ }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(Boolean(skipReason))("zotero_instance_setup (live: starts a Zotero)", () => {
  // A fresh parent directory per run: the tool keeps refusing the ports an
  // earlier run's instance is recorded with, as it should.
  const keep = Boolean(process.env.ZOTERO_INSTANCE_TEST_DIR);
  const name = `${PREFIX}-${Date.now().toString(36)}`;
  let parentDir: string;
  let sandboxHome: string;
  let ctx: SetupContext;
  let result: SetupResult;
  let started = false;

  beforeAll(async () => {
    parentDir = mkdtempSync(join(process.env.ZOTERO_INSTANCE_TEST_DIR ?? tmpdir(), `${PREFIX}-`));
    sandboxHome = mkdtempSync(join(tmpdir(), "mcp-instance-live-home-"));
    ctx = {
      host: { platform: process.platform, home: sandboxHome, env: { APPDATA: join(sandboxHome, "AppData") } },
      configuredPort: 6100,
      serverVersion: "test",
    };
    result = await setupInstance({ name, rdpPort: RDP_PORT, httpPort: HTTP_PORT, zoteroPath: EXE, bridgeXpi: XPI, parentDir }, ctx);
  });

  afterAll(async () => {
    if (started && (await portAnswers(RDP_PORT))) {
      // Quit only the Zotero that serves OUR data directory.
      const quit = await evalJson(
        RDP_PORT,
        `(function () {
          if (typeof Zotero === "undefined") return JSON.stringify({ quitting: false, why: "no Zotero" });
          const norm = (p) => ${process.platform === "win32" ? "p.toLowerCase()" : "p"};
          if (norm(Zotero.DataDirectory.dir) !== norm(${JSON.stringify(result.record.dataDir)})) return JSON.stringify({ quitting: false, why: Zotero.DataDirectory.dir });
          Zotero.getMainWindow().setTimeout(() => Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit), 300);
          return JSON.stringify({ quitting: true });
        })()`
      );
      if (!(quit && quit.quitting)) console.warn(`[instance-live.test] did not quit the instance: ${JSON.stringify(quit?.why ?? String(quit))}`);
      for (let i = 0; i < 60 && (await portAnswers(RDP_PORT)); i++) await sleep(1000);
    }
    if (parentDir && !keep && !(await portAnswers(RDP_PORT))) rmSync(parentDir, { recursive: true, force: true });
    if (sandboxHome) rmSync(sandboxHome, { recursive: true, force: true });
  }, 120_000);

  it("creates the instance without starting it", async () => {
    expect(result.created).toBe(true);
    expect(await portAnswers(RDP_PORT)).toBe(false);
    const userJs = readFileSync(join(result.paths.profileDir, "user.js"), "utf8");
    expect(readPrefValue(userJs, "extensions.mcp-rdp.port")).toBe(RDP_PORT);
    const text = formatSetup(result).map((c) => c.text).join("\n");
    expect(text).toContain(JSON.stringify(result.argv));
  });

  it("comes up from the returned command as its own Zotero, bridge enabled on its port", async () => {
    const [exe, ...args] = result.argv;
    const child = spawn(exe, args, { detached: true, stdio: "ignore" });
    child.unref();
    started = true;

    // Ready when `Zotero` resolves through the bridge (the port alone is not enough, see ping.test).
    const resolves = (t: unknown) => t === "object" || t === "function";
    let ready: any;
    for (let i = 0; i < 90; i++) {
      ready = await evalJson(RDP_PORT, `JSON.stringify({ zotero: typeof Zotero })`);
      if (!(ready instanceof Error) && resolves(ready.zotero)) break;
      await sleep(2000);
    }
    expect(ready instanceof Error ? ready.message : resolves(ready.zotero), JSON.stringify(ready)).toBe(true);

    // Let the first start finish: with a new database, Zotero installs the bundled
    // translators and styles after the UI is up (Zotero.Schema in schema.js). An
    // instance quit halfway through that stopped its next start on the modal
    // "could not load the translators and styles" error, which also suspends the
    // main window's timers (every eval that awaits a timeout then hangs).
    const schema = await evalJson(
      RDP_PORT,
      `(async () => { await Zotero.Schema.schemaUpdatePromise; return JSON.stringify({ done: true }); })()`,
      120_000
    );
    expect(schema).toEqual({ done: true });

    // A fresh client for the checks.
    const info = await evalJson(
      RDP_PORT,
      `(async () => {
        const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
        const addon = await AddonManager.getAddonByID("mcp-rdp@zotero.org");
        return JSON.stringify({
          zoteroType: typeof Zotero,
          version: Zotero.version,
          platform: Zotero.platformMajorVersion,
          dataDir: Zotero.DataDirectory.dir,
          profileDir: PathUtils.profileDir,
          rdpPortPref: Services.prefs.getIntPref("extensions.mcp-rdp.port", -1),
          httpPortPref: Zotero.Prefs.get("httpServer.port"),
          autoSync: Zotero.Prefs.get("sync.autoSync"),
          autoDisableScopes: Services.prefs.getIntPref("extensions.autoDisableScopes", -1),
          autoDisableScopesDefault: Services.prefs.getDefaultBranch("").getIntPref("extensions.autoDisableScopes", -1),
          bridge: addon && { active: addon.isActive, userDisabled: addon.userDisabled, version: addon.version },
        });
      })()`
    );
    expect(info).not.toBeInstanceOf(Error);
    console.info(
      `[instance-live.test] Zotero ${info.version} (Firefox ${info.platform}) on port ${RDP_PORT}, data ${info.dataDir}, ` +
        `extensions.autoDisableScopes ${info.autoDisableScopes} (default ${info.autoDisableScopesDefault})`
    );
    expect(resolves(info.zoteroType)).toBe(true);
    expect(samePath(info.dataDir, result.record.dataDir)).toBe(true);
    expect(samePath(info.profileDir, result.record.profileDir)).toBe(true);
    expect(info.rdpPortPref).toBe(RDP_PORT);
    expect(info.httpPortPref).toBe(HTTP_PORT);
    expect(info.autoSync).toBe(false);
    expect(info.autoDisableScopes).toBe(0);
    expect(info.bridge).toMatchObject({ active: true, userDisabled: false, version: result.record.bridge.version });

    // Its HTTP server answers on the instance's port, not on 23119.
    const ping = await fetch(`http://127.0.0.1:${HTTP_PORT}/connector/ping`);
    expect(ping.status).toBe(200);
    expect(await ping.text()).toContain("Zotero is running");
  }, 240_000);

  it("refuses the running instance's port for another instance (#19)", async () => {
    const otherParent = mkdtempSync(join(tmpdir(), "mcp-instance-live-other-"));
    try {
      await expect(
        setupInstance({ name: `${PREFIX}-other`, rdpPort: RDP_PORT, httpPort: HTTP_PORT + 1, zoteroPath: EXE, bridgeXpi: XPI, parentDir: otherParent }, ctx)
      ).rejects.toThrow(new RegExp(`rdpPort ${RDP_PORT} is not free: something already answers on it`));
      expect(existsSync(join(otherParent, `${PREFIX}-other`))).toBe(false);
    } finally {
      rmSync(otherParent, { recursive: true, force: true });
    }
  });
});
