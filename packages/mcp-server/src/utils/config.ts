/**
 * Configuration utilities
 *
 * Handles environment variables and auto-detection of Zotero paths
 */

import { homedir, platform } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";

export interface Config {
  rdp: {
    host: string;
    port: number;
  };
  zotero: {
    dataDir?: string;
    profilePath?: string;
  };
}

/**
 * Load configuration from environment variables and auto-detect paths
 */
export function loadConfig(): Config {
  return {
    rdp: {
      host: process.env.ZOTERO_RDP_HOST || "127.0.0.1",
      port: parseInt(process.env.ZOTERO_RDP_PORT || "6100", 10),
    },
    zotero: {
      dataDir: process.env.ZOTERO_DATA_DIR || detectZoteroDataDir(),
      profilePath: process.env.ZOTERO_PROFILE_PATH || detectZoteroProfilePath(),
    },
  };
}

/**
 * Auto-detect Zotero data directory
 */
function detectZoteroDataDir(): string | undefined {
  const home = homedir();
  const os = platform();

  const candidates: string[] = [];

  if (os === "darwin") {
    // macOS
    candidates.push(join(home, "Zotero"));
    candidates.push(join(home, "Library", "Application Support", "Zotero"));
  } else if (os === "win32") {
    // Windows
    candidates.push(join(home, "Zotero"));
    if (process.env.APPDATA) {
      candidates.push(join(process.env.APPDATA, "Zotero", "Zotero"));
    }
  } else {
    // Linux and others
    candidates.push(join(home, "Zotero"));
    candidates.push(join(home, ".zotero"));
  }

  for (const candidate of candidates) {
    if (existsSync(candidate) && existsSync(join(candidate, "zotero.sqlite"))) {
      return candidate;
    }
  }

  return undefined;
}

/**
 * Auto-detect Zotero profile path
 */
function detectZoteroProfilePath(): string | undefined {
  const home = homedir();
  const os = platform();

  let profilesDir: string;

  if (os === "darwin") {
    profilesDir = join(home, "Library", "Application Support", "Zotero", "Profiles");
  } else if (os === "win32") {
    profilesDir = process.env.APPDATA
      ? join(process.env.APPDATA, "Zotero", "Zotero", "Profiles")
      : join(home, "AppData", "Roaming", "Zotero", "Zotero", "Profiles");
  } else {
    profilesDir = join(home, ".zotero", "zotero");
  }

  if (!existsSync(profilesDir)) {
    return undefined;
  }

  // Find the default profile (usually ends in .default)
  try {
    const profiles = readdirSync(profilesDir);
    const defaultProfile = profiles.find(
      (p) => p.endsWith(".default") || p.endsWith(".default-release")
    );

    if (defaultProfile) {
      return join(profilesDir, defaultProfile);
    }

    // Fall back to first profile
    if (profiles.length > 0) {
      return join(profilesDir, profiles[0]);
    }
  } catch {
    // Ignore errors
  }

  return undefined;
}

/**
 * Get the path to zotero.sqlite database
 */
export function getZoteroDatabasePath(config: Config): string | undefined {
  if (config.zotero.dataDir) {
    const dbPath = join(config.zotero.dataDir, "zotero.sqlite");
    if (existsSync(dbPath)) {
      return dbPath;
    }
  }
  return undefined;
}

/**
 * Get the path to Zotero's extensions directory
 */
export function getExtensionsPath(config: Config): string | undefined {
  if (config.zotero.profilePath) {
    return join(config.zotero.profilePath, "extensions");
  }
  return undefined;
}
