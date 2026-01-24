/**
 * DOM Inspection Tools
 *
 * Find elements, inspect DOM structure, and get computed styles
 */

import type { Tool, TextContent } from "@modelcontextprotocol/sdk/types.js";
import { getRdpClient } from "../index.js";
import { RDPClient } from "../rdp/index.js";

// Tool definitions
export const inspectElementTool: Tool = {
  name: "zotero_inspect_element",
  description:
    "Find DOM elements by CSS selector and return their details. " +
    "Returns: tagName, id, className, attributes, text content, bounding rect, child count.",
  inputSchema: {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description: "CSS selector to find elements",
      },
      windowId: {
        type: "number",
        description: "Window outerWindowID (optional, defaults to main window)",
      },
      limit: {
        type: "number",
        description: "Maximum number of elements to return (default: 10)",
        default: 10,
      },
    },
    required: ["selector"],
  },
};

export const getDomTreeTool: Tool = {
  name: "zotero_get_dom_tree",
  description:
    "Get a simplified DOM tree structure. " +
    "Shows tag names, IDs, classes, and child counts for navigation.",
  inputSchema: {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description: "CSS selector for root element (default: document.documentElement)",
      },
      depth: {
        type: "number",
        description: "Maximum depth to traverse (default: 3)",
        default: 3,
      },
      windowId: {
        type: "number",
        description: "Window outerWindowID (optional, defaults to main window)",
      },
    },
  },
};

export const getStylesTool: Tool = {
  name: "zotero_get_styles",
  description:
    "Get computed CSS styles for an element. " +
    "Useful for debugging layout and styling issues.",
  inputSchema: {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description: "CSS selector for the element",
      },
      properties: {
        type: "array",
        items: { type: "string" },
        description:
          "Specific CSS properties to return (default: common layout properties)",
      },
      windowId: {
        type: "number",
        description: "Window outerWindowID (optional)",
      },
    },
    required: ["selector"],
  },
};

export const listWindowsTool: Tool = {
  name: "zotero_list_windows",
  description:
    "List all open Zotero windows with their IDs, types, and titles. " +
    "Use the windowId in other tools to target specific windows.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

// Tool handlers
export async function handleInspectElement(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const selector = args.selector as string;
  const windowId = args.windowId as number | undefined;
  const limit = (args.limit as number) || 10;

  if (!selector) {
    throw new Error("Missing required parameter: selector");
  }

  const client = await getRdpClient();

  // Return as JSON string to avoid RDP preview limitations with nested objects
  const code = `
    (() => {
      let win;
      ${
        windowId
          ? `
        const windows = Services.wm.getEnumerator(null);
        while (windows.hasMoreElements()) {
          const w = windows.getNext();
          if (w.docShell?.outerWindowID === ${windowId}) {
            win = w;
            break;
          }
        }
        if (!win) return JSON.stringify({ error: "Window not found" });
      `
          : `
        win = Zotero.getMainWindow();
        if (!win) return JSON.stringify({ error: "Could not get main window" });
      `
      }

      const elements = Array.from(win.document.querySelectorAll(${JSON.stringify(selector)}));

      return JSON.stringify({
        count: elements.length,
        elements: elements.slice(0, ${limit}).map(el => {
          const rect = el.getBoundingClientRect();
          const attrs = {};
          for (const attr of el.attributes) {
            attrs[attr.name] = attr.value;
          }
          return {
            tagName: el.tagName.toLowerCase(),
            id: el.id || null,
            className: el.className || null,
            attributes: attrs,
            textContent: (el.textContent || '').slice(0, 100).trim(),
            boundingRect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            },
            childCount: el.children.length
          };
        })
      });
    })()
  `;

  const response = await client.evaluateJS(code);

  if (response.exception) {
    throw new Error(`Inspection failed: ${response.exceptionMessage}`);
  }

  const jsonString = RDPClient.gripToValue(response.result);
  if (jsonString === undefined || jsonString === null) {
    throw new Error("Inspection failed: received undefined result from Zotero");
  }

  const result = JSON.parse(String(jsonString)) as {
    count?: number;
    elements?: unknown[];
    error?: string;
  };

  if (result.error) {
    throw new Error(result.error);
  }

  if (!result.elements || result.elements.length === 0) {
    return [
      {
        type: "text",
        text: `No elements found matching: ${selector}`,
      },
    ];
  }

  const text =
    `Found ${result.count} element(s) matching "${selector}"` +
    (result.count! > limit ? ` (showing first ${limit})` : "") +
    `:\n\n${JSON.stringify(result.elements, null, 2)}`;

  return [{ type: "text", text }];
}

export async function handleGetDomTree(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const selector = args.selector as string | undefined;
  const depth = (args.depth as number) || 3;
  const windowId = args.windowId as number | undefined;

  const client = await getRdpClient();

  // Return as JSON string to avoid RDP preview limitations with nested objects
  const code = `
    (() => {
      let win;
      ${
        windowId
          ? `
        const windows = Services.wm.getEnumerator(null);
        while (windows.hasMoreElements()) {
          const w = windows.getNext();
          if (w.docShell?.outerWindowID === ${windowId}) {
            win = w;
            break;
          }
        }
        if (!win) return JSON.stringify({ error: "Window not found" });
      `
          : `
        win = Zotero.getMainWindow();
        if (!win) return JSON.stringify({ error: "Could not get main window" });
      `
      }

      const rootSelector = ${JSON.stringify(selector || null)};
      const root = rootSelector
        ? win.document.querySelector(rootSelector)
        : win.document.documentElement;

      if (!root) {
        return JSON.stringify({ error: "Root element not found" });
      }

      function buildTree(el, currentDepth) {
        if (currentDepth > ${depth}) {
          return { childCount: el.children.length };
        }

        const node = {
          tag: el.tagName.toLowerCase()
        };

        if (el.id) node.id = el.id;
        if (el.className && typeof el.className === 'string') {
          node.class = el.className.split(' ').filter(c => c).slice(0, 3).join(' ');
          if (el.className.split(' ').length > 3) node.class += '...';
        }

        // Include important attributes
        ['data-testid', 'data-l10n-id', 'label', 'value', 'type'].forEach(attr => {
          if (el.hasAttribute(attr)) {
            node[attr] = el.getAttribute(attr);
          }
        });

        if (el.children.length > 0) {
          if (currentDepth < ${depth}) {
            node.children = Array.from(el.children).slice(0, 20).map(
              child => buildTree(child, currentDepth + 1)
            );
            if (el.children.length > 20) {
              node.children.push({ _more: el.children.length - 20 });
            }
          } else {
            node.childCount = el.children.length;
          }
        }

        return node;
      }

      return JSON.stringify(buildTree(root, 0));
    })()
  `;

  const response = await client.evaluateJS(code);

  if (response.exception) {
    throw new Error(`Failed to get DOM tree: ${response.exceptionMessage}`);
  }

  const jsonString = RDPClient.gripToValue(response.result);
  if (jsonString === undefined || jsonString === null) {
    throw new Error("Failed to get DOM tree: received undefined result from Zotero");
  }

  const result = JSON.parse(String(jsonString));

  if (typeof result === "object" && result !== null && "error" in result) {
    throw new Error((result as { error: string }).error);
  }

  return [
    {
      type: "text",
      text: `DOM Tree${selector ? ` (from ${selector})` : ""}:\n\n${JSON.stringify(result, null, 2)}`,
    },
  ];
}

export async function handleGetStyles(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const selector = args.selector as string;
  const properties = args.properties as string[] | undefined;
  const windowId = args.windowId as number | undefined;

  if (!selector) {
    throw new Error("Missing required parameter: selector");
  }

  // Default properties if none specified
  const defaultProps = [
    "display",
    "position",
    "width",
    "height",
    "margin",
    "padding",
    "border",
    "background",
    "color",
    "font-size",
    "font-family",
    "flex",
    "grid",
    "overflow",
    "visibility",
    "opacity",
    "z-index",
  ];

  const propsToGet = properties || defaultProps;

  const client = await getRdpClient();

  // Return as JSON string to avoid RDP preview limitations with nested objects
  const code = `
    (() => {
      let win;
      ${
        windowId
          ? `
        const windows = Services.wm.getEnumerator(null);
        while (windows.hasMoreElements()) {
          const w = windows.getNext();
          if (w.docShell?.outerWindowID === ${windowId}) {
            win = w;
            break;
          }
        }
        if (!win) return JSON.stringify({ error: "Window not found" });
      `
          : `
        win = Zotero.getMainWindow();
        if (!win) return JSON.stringify({ error: "Could not get main window" });
      `
      }

      const el = win.document.querySelector(${JSON.stringify(selector)});
      if (!el) {
        return JSON.stringify({ error: "Element not found: ${selector}" });
      }

      const computed = win.getComputedStyle(el);
      const styles = {};

      ${JSON.stringify(propsToGet)}.forEach(prop => {
        styles[prop] = computed.getPropertyValue(prop);
      });

      return JSON.stringify({
        selector: ${JSON.stringify(selector)},
        tagName: el.tagName.toLowerCase(),
        styles
      });
    })()
  `;

  const response = await client.evaluateJS(code);

  if (response.exception) {
    throw new Error(`Failed to get styles: ${response.exceptionMessage}`);
  }

  const jsonString = RDPClient.gripToValue(response.result);
  if (jsonString === undefined || jsonString === null) {
    throw new Error("Failed to get styles: received undefined result from Zotero");
  }

  const result = JSON.parse(String(jsonString)) as {
    selector?: string;
    tagName?: string;
    styles?: Record<string, string>;
    error?: string;
  };

  if (result.error) {
    throw new Error(result.error);
  }

  const lines = [
    `Computed styles for ${result.tagName} (${result.selector}):`,
    "",
  ];

  for (const [prop, value] of Object.entries(result.styles || {})) {
    if (value && value !== "none" && value !== "normal" && value !== "auto") {
      lines.push(`  ${prop}: ${value}`);
    }
  }

  return [{ type: "text", text: lines.join("\n") }];
}

export async function handleListWindows(): Promise<TextContent[]> {
  const client = await getRdpClient();

  // Return as JSON string to avoid RDP preview limitations with nested objects
  const code = `
    (() => {
      const results = [];
      const windows = Services.wm.getEnumerator(null);

      while (windows.hasMoreElements()) {
        const win = windows.getNext();
        try {
          results.push({
            windowId: win.docShell?.outerWindowID,
            type: win.document.documentElement.getAttribute('windowtype') || 'unknown',
            title: win.document.title,
            url: win.location.href,
            focused: win === Services.focus.focusedWindow,
            width: win.innerWidth,
            height: win.innerHeight
          });
        } catch (e) {
          // Skip windows we can't access
        }
      }

      return JSON.stringify(results);
    })()
  `;

  const response = await client.evaluateJS(code);

  if (response.exception) {
    throw new Error(`Failed to list windows: ${response.exceptionMessage}`);
  }

  const jsonString = RDPClient.gripToValue(response.result);
  if (jsonString === undefined || jsonString === null) {
    throw new Error("Failed to list windows: received undefined result from Zotero");
  }

  const windows = JSON.parse(String(jsonString)) as Array<{
    windowId?: number;
    type?: string;
    title?: string;
    url?: string;
    focused?: boolean;
    width?: number;
    height?: number;
  }>;

  if (!windows || windows.length === 0) {
    return [{ type: "text", text: "No windows found" }];
  }

  const lines = [`Found ${windows.length} window(s):\n`];

  for (const win of windows) {
    const focused = win.focused ? " [FOCUSED]" : "";
    lines.push(`• Window ID: ${win.windowId}${focused}`);
    lines.push(`  Type: ${win.type}`);
    lines.push(`  Title: ${win.title}`);
    lines.push(`  Size: ${win.width}×${win.height}`);
    lines.push(`  URL: ${win.url}`);
    lines.push("");
  }

  return [{ type: "text", text: lines.join("\n") }];
}
