/**
 * zotero_ping - is the bridge reachable AND is Zotero reachable behind it?
 *
 * Those are two different questions (#24). The RDP handshake succeeds as long
 * as the plugin's listener is up; whether `Zotero` resolves depends on the
 * console actor's target, and `getTarget` on the parent ProcessDescriptor
 * only yields the main window's global while a Zotero window is open. With
 * the app running windowless (macOS after closing the last window) the
 * target degrades to an empty about:blank frame where `typeof Zotero` is
 * "undefined" and every tool fails with "Zotero is not defined". The old
 * handler never looked at `.exception`, so it printed a success banner full
 * of "[object Object]" in exactly that state.
 *
 * One probe, JSON round-tripped like every other tool (nested objects do not
 * survive grip resolution), with three outcomes: a string (connected), null
 * (bridge up, Zotero unreachable), or an exception (surfaced verbatim).
 */
import type { Tool, TextContent } from "@modelcontextprotocol/sdk/types.js";
import type { EvaluateJSResponse, GripValue } from "../rdp/index.js";

export const pingTool: Tool = {
  name: "zotero_ping",
  description:
    "Test connection to Zotero and get version info. " +
    "Use this to verify that Zotero is running and the MCP Bridge for Zotero plugin is active.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

/** The subset of RDPClient the ping needs - injectable for tests. */
export interface PingClient {
  evaluateJS(code: string): Promise<EvaluateJSResponse>;
  gripToValueAsync(grip: GripValue): Promise<unknown>;
}

/**
 * Evaluated in the console actor's target. ALWAYS a JSON string: `{reachable:
 * false}` when `Zotero` is not visible from that global, the version block
 * otherwise. Not `null` - a null result comes back as the grip `{type:
 * "null"}`, which gripToValue() hands through unchanged (it maps primitives,
 * longStrings and objects, not the null/undefined grips), and the old banner
 * would print it as "[object Object]" all over again.
 */
export const PING_PROBE =
  "(function () {" +
  "  if (typeof Zotero === 'undefined') return JSON.stringify({ reachable: false });" +
  "  return JSON.stringify({" +
  "    reachable: true," +
  "    version: Zotero.version," +
  "    appName: Zotero.appName," +
  "    platformVersion: Zotero.platformMajorVersion," +
  "    dataDir: Zotero.DataDirectory.dir" +
  "  });" +
  "})()";

interface PingInfo {
  reachable: boolean;
  version?: string;
  appName?: string;
  platformVersion?: string | number;
  dataDir?: string;
}

/** A null/undefined result, raw or as an RDP grip - defensively "unreachable". */
function isNullishGrip(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return (
    typeof value === "object" &&
    "type" in (value as object) &&
    ((value as { type?: string }).type === "null" ||
      (value as { type?: string }).type === "undefined")
  );
}

/**
 * Ping through an already-connected client. Throws when the evaluation
 * itself fails; returns the "unreachable" text when the bridge answered but
 * `Zotero` is not visible from the target.
 */
export async function pingWithClient(
  client: PingClient,
  port: number
): Promise<TextContent[]> {
  const probe = await client.evaluateJS(PING_PROBE);

  if (probe.exception || probe.exceptionMessage) {
    throw new Error(
      `Probe evaluation failed: ${probe.exceptionMessage ?? "unknown exception"}`
    );
  }

  const raw =
    probe.result === undefined ? undefined : await client.gripToValueAsync(probe.result);

  let info: PingInfo;
  if (isNullishGrip(raw)) {
    info = { reachable: false };
  } else if (typeof raw === "string") {
    info = JSON.parse(raw) as PingInfo;
  } else {
    throw new Error(
      `Unexpected probe result (${typeof raw}); expected a JSON string`
    );
  }

  if (!info.reachable) {
    return [
      {
        type: "text",
        text:
          `✗ Bridge reachable on port ${port}, but Zotero is not\n\n` +
          `The RDP handshake succeeded, yet \`typeof Zotero\` is "undefined" in the ` +
          `console actor's target, so every other tool would fail with ` +
          `"Zotero is not defined".\n\n` +
          `This is what Zotero looks like when it is running with NO window open: ` +
          `the target falls back to an empty about:blank frame instead of the main ` +
          `window (on macOS the app keeps running in the Dock after the last window ` +
          `is closed).\n\n` +
          `Troubleshooting:\n` +
          `1. Reopen the main Zotero window (macOS: click the Zotero icon in the Dock, ` +
          `or Window → Zotero), then ping again\n` +
          `2. If a window IS open, restart Zotero - the RDP target was created ` +
          `before the window existed`,
      },
    ];
  }

  return [
    {
      type: "text",
      text:
        `✓ Connected to ${info.appName} ${info.version}\n` +
        `  Platform: Firefox ${info.platformVersion}\n` +
        `  Data directory: ${info.dataDir}\n` +
        `  RDP port: ${port}\n\n` +
        `Ready to help with Zotero plugin development!`,
    },
  ];
}

/** Text for the "could not even talk to the bridge" branch. */
export function pingFailureText(message: string, port: number): TextContent[] {
  return [
    {
      type: "text",
      text:
        `✗ Cannot connect to Zotero\n\n` +
        `Error: ${message}\n\n` +
        `Troubleshooting:\n` +
        `1. Make sure Zotero is running\n` +
        `2. Install the MCP Bridge for Zotero plugin in Zotero:\n` +
        `   Tools → Add-ons → ⚙️ → Install from file\n` +
        `3. Restart Zotero after installing the plugin\n` +
        `4. Check that port ${port} is not blocked`,
    },
  ];
}

/**
 * Handle the ping tool. `getRdpClient` is imported lazily so that this module
 * can be loaded by tests without starting the MCP server (index.ts runs
 * main() on import).
 */
export async function handlePing(port: number): Promise<TextContent[]> {
  try {
    const { getRdpClient } = await import("../index.js");
    const client = await getRdpClient();
    return await pingWithClient(client, port);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return pingFailureText(message, port);
  }
}
