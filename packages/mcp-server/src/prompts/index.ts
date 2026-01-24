/**
 * MCP Prompts (Slash Commands)
 *
 * Guided workflows for common Zotero plugin development tasks
 */

import type { Prompt, GetPromptResult } from "@modelcontextprotocol/sdk/types.js";

// Prompt definitions
export const setupDevPrompt: Prompt = {
  name: "setup-dev",
  description: "Set up Zotero plugin development environment from scratch",
  arguments: [
    {
      name: "pluginName",
      description: "Name for your new plugin (e.g., 'my-awesome-plugin')",
      required: false,
    },
  ],
};

export const debugPluginPrompt: Prompt = {
  name: "debug-plugin",
  description: "Connect to Zotero and start debugging your plugin",
  arguments: [],
};

export const fixErrorsPrompt: Prompt = {
  name: "fix-errors",
  description: "Find and fix errors from Zotero's error console",
  arguments: [],
};

export const inspectApiPrompt: Prompt = {
  name: "inspect-api",
  description: "Interactive exploration of Zotero's JavaScript APIs",
  arguments: [
    {
      name: "api",
      description: "API to explore (e.g., 'Zotero.Items', 'ZoteroPane')",
      required: false,
    },
  ],
};

export const migrateZ7Prompt: Prompt = {
  name: "migrate-z7",
  description: "Help migrate a plugin from Zotero 6 to Zotero 7",
  arguments: [
    {
      name: "projectPath",
      description: "Path to the plugin project to migrate",
      required: false,
    },
  ],
};

// All prompts
export const allPrompts: Prompt[] = [
  setupDevPrompt,
  debugPluginPrompt,
  fixErrorsPrompt,
  inspectApiPrompt,
  migrateZ7Prompt,
];

// Prompt handlers
export function handleSetupDev(args: Record<string, string>): GetPromptResult {
  const pluginName = args.pluginName || "my-zotero-plugin";

  return {
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Help me set up a new Zotero plugin development environment.

Plugin name: ${pluginName}

Please guide me through these steps:

1. **Check prerequisites**
   - Verify Node.js 20+ is installed
   - Check if npm is available

2. **Create project from template**
   - Clone or scaffold from zotero-plugin-template
   - Update package.json with plugin name and ID
   - Configure manifest.json

3. **Set up development environment**
   - Install dependencies
   - Configure TypeScript
   - Set up build scripts

4. **Install MCP Bridge for Zotero plugin in Zotero**
   - Download the bridge plugin
   - Install it in Zotero (Tools → Add-ons)
   - Restart Zotero

5. **Verify the setup**
   - Connect to Zotero via RDP (use zotero_ping)
   - Build the plugin
   - Install and test in Zotero
   - Take a screenshot to verify

After completing these steps, show me a screenshot of Zotero with the plugin installed and explain what to do next.`,
        },
      },
    ],
  };
}

export function handleDebugPlugin(): GetPromptResult {
  return {
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Help me debug my Zotero plugin. Please:

1. **Connect and take a screenshot**
   - Use zotero_ping to verify connection
   - Take a screenshot of the main Zotero window

2. **Check for errors**
   - Read the error console (zotero_read_errors)
   - Read recent debug logs (zotero_read_logs)

3. **List installed plugins**
   - Use zotero_plugin_list to find my plugin
   - Check if it's enabled and what version

4. **Analyze findings**
   - If there are errors, explain what they mean
   - Suggest what to investigate next
   - If the plugin appears to be working, confirm that

5. **Provide next steps**
   - Based on what you find, suggest debugging actions
   - Offer to inspect specific elements or execute test code

Start by connecting to Zotero and gathering this information.`,
        },
      },
    ],
  };
}

export function handleFixErrors(): GetPromptResult {
  return {
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Find and help me fix errors in my Zotero plugin.

Please:

1. **Read error console**
   - Use zotero_read_errors to get recent errors
   - Focus on errors from my plugin (not Zotero core)

2. **For each error found**:
   - Explain what the error means in simple terms
   - Identify the likely cause
   - Show the relevant code if visible in stack trace
   - Provide a specific fix

3. **Take screenshots if helpful**
   - If the error is UI-related, capture the problematic area
   - Highlight the element causing issues

4. **Test the fixes**
   - After suggesting fixes, offer to reload the plugin
   - Verify the error is resolved

Start by reading the error console and analyzing what you find.`,
        },
      },
    ],
  };
}

export function handleInspectApi(args: Record<string, string>): GetPromptResult {
  const api = args.api;

  const apiPrompt = api
    ? `I want to explore the Zotero API: ${api}

Please:
1. Show me what methods and properties are available on ${api}
2. Provide example usage for common operations
3. Let me test specific calls interactively`
    : `Help me explore Zotero's JavaScript APIs.

I'd like to understand what APIs are available for plugin development.

Please:
1. List the main Zotero API namespaces (Zotero.Items, Zotero.Collections, etc.)
2. Ask me which area I want to explore
3. Show me practical examples I can use

Start by showing me an overview of available APIs.`;

  return {
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: apiPrompt,
        },
      },
    ],
  };
}

export function handleMigrateZ7(args: Record<string, string>): GetPromptResult {
  const projectPath = args.projectPath || "current directory";

  return {
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Help me migrate my Zotero plugin from Zotero 6 to Zotero 7.

Project: ${projectPath}

Please:

1. **Analyze current plugin**
   - Examine the plugin structure
   - Identify Zotero 6 patterns that need updating

2. **Check for common migration issues**:
   - XUL to HTML/XHTML changes
   - Overlay system removed (use bootstrapped approach)
   - API changes (Services.*, ChromeUtils.import)
   - Preference system changes
   - Localization changes (DTD to Fluent)

3. **List required changes**
   - Categorize by: breaking changes, deprecated APIs, new patterns
   - Estimate complexity of each change

4. **Offer to make changes**
   - For each change, show the before/after
   - Make the changes incrementally
   - Test after each major change

5. **Verify migration**
   - Build the updated plugin
   - Install in Zotero 7
   - Check for errors

Start by examining the plugin's current structure and manifest.`,
        },
      },
    ],
  };
}

// Get prompt handler
export function getPromptHandler(name: string, args: Record<string, string>): GetPromptResult {
  switch (name) {
    case "setup-dev":
      return handleSetupDev(args);
    case "debug-plugin":
      return handleDebugPlugin();
    case "fix-errors":
      return handleFixErrors();
    case "inspect-api":
      return handleInspectApi(args);
    case "migrate-z7":
      return handleMigrateZ7(args);
    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
}
