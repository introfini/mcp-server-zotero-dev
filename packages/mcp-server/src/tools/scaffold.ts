/**
 * Scaffold Integration Tools
 *
 * Build, serve, and manage Zotero plugin projects using zotero-plugin-scaffold
 */

import type { Tool, TextContent } from "@modelcontextprotocol/sdk/types.js";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Track running processes
const runningProcesses: Map<string, ChildProcess> = new Map();

// Tool definitions
export const scaffoldBuildTool: Tool = {
  name: "zotero_scaffold_build",
  description:
    "Build a Zotero plugin project using zotero-plugin-scaffold. " +
    "Runs 'npm run build' or 'npm run build:dev' in the project directory.",
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["development", "production"],
        description: "Build mode (default: development)",
        default: "development",
      },
      projectPath: {
        type: "string",
        description: "Path to plugin project (default: current working directory)",
      },
    },
  },
};

export const scaffoldServeTool: Tool = {
  name: "zotero_scaffold_serve",
  description:
    "Start/stop the zotero-plugin-scaffold dev server with hot reload. " +
    "This watches for changes and automatically rebuilds/reloads the plugin.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["start", "stop", "status"],
        description: "Action to perform",
      },
      projectPath: {
        type: "string",
        description: "Path to plugin project (default: current working directory)",
      },
    },
    required: ["action"],
  },
};

export const scaffoldLintTool: Tool = {
  name: "zotero_scaffold_lint",
  description: "Run ESLint on a Zotero plugin project.",
  inputSchema: {
    type: "object",
    properties: {
      projectPath: {
        type: "string",
        description: "Path to plugin project (default: current working directory)",
      },
      fix: {
        type: "boolean",
        description: "Automatically fix problems (default: false)",
        default: false,
      },
    },
  },
};

export const scaffoldTypecheckTool: Tool = {
  name: "zotero_scaffold_typecheck",
  description: "Run TypeScript type checking on a Zotero plugin project.",
  inputSchema: {
    type: "object",
    properties: {
      projectPath: {
        type: "string",
        description: "Path to plugin project (default: current working directory)",
      },
    },
  },
};

// Helper to validate project path
function validateProjectPath(projectPath?: string): string {
  const path = projectPath || process.cwd();

  if (!existsSync(path)) {
    throw new Error(`Project path does not exist: ${path}`);
  }

  const packageJsonPath = join(path, "package.json");
  if (!existsSync(packageJsonPath)) {
    throw new Error(
      `No package.json found at ${path}. Is this a Zotero plugin project?`
    );
  }

  return path;
}

// Helper to run npm command
async function runNpmCommand(
  command: string,
  args: string[],
  cwd: string,
  timeout = 120000
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const proc = spawn(command, args, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeoutId = setTimeout(() => {
      proc.kill();
      resolve({
        stdout,
        stderr: stderr + "\n[Process timed out]",
        code: -1,
      });
    }, timeout);

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timeoutId);
      resolve({ stdout, stderr, code: code || 0 });
    });

    proc.on("error", (err) => {
      clearTimeout(timeoutId);
      resolve({
        stdout,
        stderr: stderr + `\nError: ${err.message}`,
        code: -1,
      });
    });
  });
}

// Tool handlers
export async function handleScaffoldBuild(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const mode = (args.mode as string) || "development";
  const projectPath = validateProjectPath(args.projectPath as string | undefined);

  const script = mode === "production" ? "build" : "build:dev";

  const startTime = Date.now();
  const result = await runNpmCommand("npm", ["run", script], projectPath);
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  if (result.code !== 0) {
    return [
      {
        type: "text",
        text:
          `Build failed (${duration}s)\n\n` +
          `Command: npm run ${script}\n` +
          `Exit code: ${result.code}\n\n` +
          `Output:\n${result.stdout}\n\n` +
          `Errors:\n${result.stderr}`,
      },
    ];
  }

  // Check for build output
  const buildDir = existsSync(join(projectPath, "build"))
    ? "build"
    : existsSync(join(projectPath, "dist"))
      ? "dist"
      : null;

  return [
    {
      type: "text",
      text:
        `✓ Build successful (${duration}s)\n\n` +
        `Mode: ${mode}\n` +
        (buildDir ? `Output: ${buildDir}/\n` : "") +
        (result.stdout ? `\nOutput:\n${result.stdout.slice(-500)}` : ""),
    },
  ];
}

export async function handleScaffoldServe(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const action = args.action as string;
  const projectPath = validateProjectPath(args.projectPath as string | undefined);

  const processKey = `serve:${projectPath}`;

  if (action === "status") {
    const proc = runningProcesses.get(processKey);
    if (proc && !proc.killed) {
      return [
        {
          type: "text",
          text: `Dev server is running\nPID: ${proc.pid}\nProject: ${projectPath}`,
        },
      ];
    }
    return [{ type: "text", text: "Dev server is not running" }];
  }

  if (action === "stop") {
    const proc = runningProcesses.get(processKey);
    if (proc && !proc.killed) {
      proc.kill();
      runningProcesses.delete(processKey);
      return [{ type: "text", text: "Dev server stopped" }];
    }
    return [{ type: "text", text: "Dev server was not running" }];
  }

  if (action === "start") {
    // Check if already running
    const existing = runningProcesses.get(processKey);
    if (existing && !existing.killed) {
      return [
        {
          type: "text",
          text: `Dev server already running (PID: ${existing.pid})`,
        },
      ];
    }

    // Start the serve process
    const proc = spawn("npm", ["run", "serve"], {
      cwd: projectPath,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    // Don't let the process block our exit
    proc.unref();

    runningProcesses.set(processKey, proc);

    // Collect some initial output
    let output = "";
    const outputPromise = new Promise<string>((resolve) => {
      const timeout = setTimeout(() => resolve(output), 3000);

      proc.stdout.on("data", (data) => {
        output += data.toString();
        if (
          output.includes("watching") ||
          output.includes("ready") ||
          output.includes("started")
        ) {
          clearTimeout(timeout);
          resolve(output);
        }
      });

      proc.stderr.on("data", (data) => {
        output += data.toString();
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        resolve(`Error: ${err.message}`);
      });

      proc.on("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          resolve(`Process exited with code ${code}\n${output}`);
        }
      });
    });

    const initialOutput = await outputPromise;

    if (proc.killed || proc.exitCode !== null) {
      runningProcesses.delete(processKey);
      return [
        {
          type: "text",
          text: `Failed to start dev server:\n${initialOutput}`,
        },
      ];
    }

    return [
      {
        type: "text",
        text:
          `✓ Dev server started\n` +
          `PID: ${proc.pid}\n` +
          `Project: ${projectPath}\n\n` +
          `The server will watch for changes and rebuild automatically.\n` +
          `Use action="stop" to stop the server.\n\n` +
          (initialOutput ? `Initial output:\n${initialOutput.slice(0, 500)}` : ""),
      },
    ];
  }

  throw new Error(`Unknown action: ${action}`);
}

export async function handleScaffoldLint(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const projectPath = validateProjectPath(args.projectPath as string | undefined);
  const fix = args.fix as boolean;

  const script = fix ? "lint:fix" : "lint";

  // Check if lint script exists, fall back to direct eslint call
  const result = await runNpmCommand("npm", ["run", script], projectPath, 60000);

  if (result.code === 0) {
    return [
      {
        type: "text",
        text: `✓ Lint passed${fix ? " (with fixes applied)" : ""}\n\n${result.stdout}`,
      },
    ];
  }

  return [
    {
      type: "text",
      text:
        `Lint ${fix ? "fix " : ""}completed with issues:\n\n` +
        `${result.stdout}\n${result.stderr}`,
    },
  ];
}

export async function handleScaffoldTypecheck(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const projectPath = validateProjectPath(args.projectPath as string | undefined);

  const result = await runNpmCommand(
    "npx",
    ["tsc", "--noEmit"],
    projectPath,
    60000
  );

  if (result.code === 0) {
    return [
      {
        type: "text",
        text: "✓ Type check passed - no errors found",
      },
    ];
  }

  return [
    {
      type: "text",
      text:
        `Type check found errors:\n\n` +
        `${result.stdout}\n${result.stderr}`,
    },
  ];
}

// Cleanup on process exit
process.on("exit", () => {
  for (const proc of runningProcesses.values()) {
    if (!proc.killed) {
      proc.kill();
    }
  }
});
