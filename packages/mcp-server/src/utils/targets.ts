/**
 * Several Zotero instances from one server: an opt-in `port` argument.
 *
 * A plugin developer often runs two Zotero instances side by side (a
 * release build and a beta, a source build, a throwaway profile for a
 * test), each with the bridge on its own port. One server process reached
 * one port, fixed by ZOTERO_RDP_PORT at startup, so driving a second
 * instance meant a second MCP server entry, or a hand-rolled stdio client.
 *
 * Opt-in, like ZOTERO_MCP_LOCK in #28: with ZOTERO_RDP_PORTS unset nothing
 * changes, not even the tool schemas. With ZOTERO_RDP_PORTS=6100,6101 every
 * tool that talks to Zotero takes an optional `port`, limited to the listed
 * ports (plus ZOTERO_RDP_PORT, which stays the default). The port of the
 * call in progress travels in an AsyncLocalStorage, so the tool handlers
 * keep calling getRdpClient() unchanged and parallel calls to different
 * instances cannot cross.
 *
 * Imports nothing from index.ts, so tests can load it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** The port of the tool call in progress (unset outside a call). */
export const portContext = new AsyncLocalStorage<number>();

export interface PortPolicy {
  /** The port used when a call names none (ZOTERO_RDP_PORT). */
  defaultPort: number;
  /** The ports a call may name; empty = the `port` argument is off. */
  allowed: number[];
}

/** "6100, 6101,x" -> [6100, 6101]: valid TCP ports only, deduplicated, in order. */
export function parsePortList(value: string | undefined): number[] {
  const out: number[] = [];
  for (const part of (value ?? "").split(",")) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n > 0 && n < 65536 && !out.includes(n)) out.push(n);
  }
  return out;
}

/** The policy from ZOTERO_RDP_PORTS; the default port is always allowed when it is on. */
export function portPolicy(portsEnv: string | undefined, defaultPort: number): PortPolicy {
  const listed = parsePortList(portsEnv);
  if (!listed.length) return { defaultPort, allowed: [] };
  return { defaultPort, allowed: listed.includes(defaultPort) ? listed : [defaultPort, ...listed] };
}

/** The port a call uses. Throws, saying what is allowed, for any other. */
export function resolvePort(arg: unknown, policy: PortPolicy): number {
  if (arg === undefined || arg === null || arg === "") return policy.defaultPort;
  const n = typeof arg === "string" ? Number(arg) : arg;
  if (!policy.allowed.length) {
    if (n === policy.defaultPort) return policy.defaultPort;
    throw new Error(
      `The "port" argument is off: this server talks to port ${policy.defaultPort} only. ` +
        "List the ports of the other Zotero instances in ZOTERO_RDP_PORTS (e.g. " +
        `ZOTERO_RDP_PORTS=${policy.defaultPort},6101) to reach them from this server.`
    );
  }
  if (typeof n === "number" && policy.allowed.includes(n)) return n;
  throw new Error(
    `Port ${String(arg)} is not one this server may use. Allowed (ZOTERO_RDP_PORTS): ` +
      `${policy.allowed.join(", ")}; default ${policy.defaultPort}.`
  );
}

/**
 * The tool list with the `port` argument added to every tool not in
 * `exempt` (those that never talk to Zotero), when the policy has it on.
 * Unchanged objects otherwise.
 */
export function withPortArgument(tools: Tool[], policy: PortPolicy, exempt: Set<string>): Tool[] {
  if (!policy.allowed.length) return tools;
  return tools.map((tool) => {
    if (exempt.has(tool.name)) return tool;
    return {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...(tool.inputSchema.properties ?? {}),
          port: {
            type: "integer",
            enum: policy.allowed,
            description:
              `Bridge port of the Zotero instance to use (default ${policy.defaultPort}). ` +
              "Each Zotero instance running with the bridge has its own; zotero_ping with a " +
              "port shows which data directory answers there.",
          },
        },
      },
    };
  });
}
