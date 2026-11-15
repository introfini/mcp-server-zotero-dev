/**
 * The server's RDP session: one client per process, created and connected on
 * first use, and the configuration it connects with.
 *
 * This lives here rather than in index.ts because index.ts starts the MCP
 * server when it is imported. Tool modules import getRdpClient() from this
 * module, which has no side effects on import, so a test can load any of them
 * without a stdio server coming up (#33).
 */

import { createClient, type RDPClient } from "./client.js";
import { loadConfig, type Config } from "../utils/config.js";

let rdpClient: RDPClient | null = null;
let config: Config | null = null;

/**
 * The configuration, read from the environment on first use and kept for the
 * life of the process.
 */
export function getConfig(): Config {
  if (!config) {
    config = loadConfig();
  }
  return config;
}

/**
 * Get or create the RDP client, connecting it if it is not connected.
 */
export async function getRdpClient(): Promise<RDPClient> {
  if (!rdpClient) {
    const { rdp } = getConfig();
    rdpClient = createClient({
      host: rdp.host,
      port: rdp.port,
    });
  }

  if (!rdpClient.isConnected()) {
    await rdpClient.connect();
  }

  return rdpClient;
}

/**
 * Disconnect the RDP client, if one was created (SIGINT/SIGTERM).
 */
export function disconnectRdpClient(): void {
  if (rdpClient) {
    rdpClient.disconnect();
  }
}
