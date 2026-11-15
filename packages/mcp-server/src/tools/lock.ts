/**
 * zotero_acquire / zotero_release - the opt-in session lock (#28).
 *
 * Listed only when the server runs with ZOTERO_MCP_LOCK=1; without it the
 * tool list is unchanged. The logic lives in utils/session-lock.ts; these
 * handlers take the client and the lock as arguments, so this module imports
 * nothing from index.ts (#33).
 */
import type { Tool, TextContent } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_LEASE_SECONDS,
  DEFAULT_WAIT_SECONDS,
  MAX_LEASE_SECONDS,
  MAX_WAIT_SECONDS,
  type LockClient,
  type SessionLock,
} from "../utils/session-lock.js";

export const acquireTool: Tool = {
  name: "zotero_acquire",
  description:
    "Take the Zotero lock for a whole test pass (install, checks, logs), so another session " +
    "sharing this Zotero cannot change it in between. While you hold it, the other " +
    "lock-enabled sessions get an error from every Zotero tool; the zotero_scaffold_* tools " +
    "stay free. Waits for the current holder if needed. Each Zotero tool call you make pushes " +
    "the expiry back. Call zotero_release when the pass is done.",
  inputSchema: {
    type: "object",
    properties: {
      waitSeconds: {
        type: "number",
        description:
          `How long to wait for another holder to release the lock or for its lease to lapse ` +
          `(default ${DEFAULT_WAIT_SECONDS}, at most ${MAX_WAIT_SECONDS}; 0 = try once). ` +
          `On failure the reply says who holds it since when; call again to keep waiting.`,
        minimum: 0,
        maximum: MAX_WAIT_SECONDS,
        default: DEFAULT_WAIT_SECONDS,
      },
      leaseSeconds: {
        type: "number",
        description:
          `How long the lock survives without a Zotero tool call from this session ` +
          `(default ${DEFAULT_LEASE_SECONDS}, at most ${MAX_LEASE_SECONDS}). Raise it when a ` +
          `build between two Zotero calls takes longer: the scaffold tools do not renew it.`,
        minimum: 1,
        maximum: MAX_LEASE_SECONDS,
        default: DEFAULT_LEASE_SECONDS,
      },
    },
    required: [],
  },
};

export const releaseTool: Tool = {
  name: "zotero_release",
  description:
    "Give back the Zotero lock taken with zotero_acquire, at the end of a test pass. " +
    "Only the session that holds the lock can release it.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

export interface LockToolResult {
  content: TextContent[];
  isError: boolean;
}

export async function handleAcquire(
  lock: SessionLock,
  client: LockClient,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<LockToolResult> {
  const result = await lock.acquire(client, {
    waitSeconds: args.waitSeconds,
    leaseSeconds: args.leaseSeconds,
    signal,
  });
  return { content: [{ type: "text", text: result.text }], isError: !result.ok };
}

export async function handleRelease(
  lock: SessionLock,
  client: LockClient
): Promise<LockToolResult> {
  const result = await lock.release(client);
  return { content: [{ type: "text", text: result.text }], isError: !result.ok };
}
