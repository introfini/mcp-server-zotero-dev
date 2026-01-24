/**
 * Screenshot Tool
 *
 * Capture screenshots of Zotero windows and elements
 */

import type { Tool, TextContent, ImageContent } from "@modelcontextprotocol/sdk/types.js";
import { getRdpClient } from "../index.js";

export const screenshotTool: Tool = {
  name: "zotero_screenshot",
  description:
    "Capture a screenshot of Zotero. Can capture the main window, a specific window, " +
    "or a specific element by CSS selector. Optionally highlight an element with a red border.",
  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        enum: ["main-window", "window", "element"],
        description: "What to capture: main-window (default), specific window, or element",
        default: "main-window",
      },
      windowId: {
        type: "number",
        description: "Window outerWindowID (use zotero_list_windows to find). Required if target='window'",
      },
      selector: {
        type: "string",
        description: "CSS selector for element to capture (required if target='element')",
      },
      highlightSelector: {
        type: "string",
        description: "CSS selector for element to highlight with red border before capture",
      },
      format: {
        type: "string",
        enum: ["png", "jpeg"],
        description: "Image format (default: png)",
        default: "png",
      },
      scale: {
        type: "number",
        description: "Scale factor for the screenshot (default: 1)",
        default: 1,
      },
    },
  },
};

export async function handleScreenshot(
  args: Record<string, unknown>
): Promise<(TextContent | ImageContent)[]> {
  const target = (args.target as string) || "main-window";
  const windowId = args.windowId as number | undefined;
  const selector = args.selector as string | undefined;
  const highlightSelector = args.highlightSelector as string | undefined;
  const format = (args.format as string) || "png";
  const scale = (args.scale as number) || 1;

  if (target === "element" && !selector) {
    throw new Error("selector is required when target='element'");
  }

  const client = await getRdpClient();

  // Build the screenshot code
  const code = buildScreenshotCode({
    target,
    windowId,
    selector,
    highlightSelector,
    format,
    scale,
  });

  const response = await client.evaluateJS(code);

  if (response.exception) {
    throw new Error(`Screenshot failed: ${response.exceptionMessage}`);
  }

  // Screenshots return large base64 strings that may come as longString grips
  // Use async method to fetch full content if needed
  const jsonString = await client.gripToValueAsync(response.result);
  if (jsonString === undefined || jsonString === null) {
    throw new Error("Screenshot failed: received undefined result from Zotero");
  }

  const result = JSON.parse(String(jsonString)) as {
    data?: string;
    error?: string;
    width?: number;
    height?: number;
    windowTitle?: string;
  };

  if (result.error) {
    throw new Error(result.error);
  }

  if (!result.data) {
    throw new Error("No screenshot data returned");
  }

  const description = buildDescription(target, windowId, selector, result);

  return [
    {
      type: "image",
      data: result.data,
      mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
    },
    {
      type: "text",
      text: description,
    },
  ];
}

interface ScreenshotOptions {
  target: string;
  windowId?: number;
  selector?: string;
  highlightSelector?: string;
  format: string;
  scale: number;
}

function buildScreenshotCode(options: ScreenshotOptions): string {
  const { target, windowId, selector, highlightSelector, format, scale } = options;

  // This code runs in Zotero's context
  return `
    (async () => {
      try {
        let win;
        let element;
        let highlightedElement;
        let originalOutline;

        // Get the target window
        ${
          target === "window" && windowId
            ? `
          // Find window by outerWindowID
          const windows = Services.wm.getEnumerator(null);
          while (windows.hasMoreElements()) {
            const w = windows.getNext();
            if (w.docShell?.outerWindowID === ${windowId}) {
              win = w;
              break;
            }
          }
          if (!win) {
            return JSON.stringify({ error: "Window not found with ID ${windowId}" });
          }
        `
            : `
          // Get main Zotero window
          win = Zotero.getMainWindow();
          if (!win) {
            return JSON.stringify({ error: "Could not get main Zotero window" });
          }
        `
        }

        // Handle element targeting
        ${
          target === "element" && selector
            ? `
          element = win.document.querySelector(${JSON.stringify(selector)});
          if (!element) {
            return JSON.stringify({ error: "Element not found: ${selector}" });
          }
        `
            : ""
        }

        // Handle highlighting
        ${
          highlightSelector
            ? `
          highlightedElement = win.document.querySelector(${JSON.stringify(highlightSelector)});
          if (highlightedElement) {
            originalOutline = highlightedElement.style.outline;
            highlightedElement.style.outline = "3px solid red";
          }
        `
            : ""
        }

        // Calculate dimensions
        let x = 0, y = 0, width, height;

        ${
          target === "element"
            ? `
          const rect = element.getBoundingClientRect();
          x = rect.left;
          y = rect.top;
          width = rect.width;
          height = rect.height;
        `
            : `
          width = win.innerWidth;
          height = win.innerHeight;
        `
        }

        // Create canvas and capture
        const canvas = win.document.createElement('canvas');
        canvas.width = Math.ceil(width * ${scale});
        canvas.height = Math.ceil(height * ${scale});

        const ctx = canvas.getContext('2d');
        ctx.scale(${scale}, ${scale});
        ctx.drawWindow(win, x, y, width, height, 'white');

        // Remove highlight
        ${
          highlightSelector
            ? `
          if (highlightedElement) {
            highlightedElement.style.outline = originalOutline || '';
          }
        `
            : ""
        }

        // Convert to data URL
        const dataUrl = canvas.toDataURL('${format === "jpeg" ? "image/jpeg" : "image/png"}', 0.92);
        const base64 = dataUrl.split(',')[1];

        return JSON.stringify({
          data: base64,
          width: Math.ceil(width),
          height: Math.ceil(height),
          windowTitle: win.document.title
        });
      } catch (error) {
        return JSON.stringify({ error: error.message || String(error) });
      }
    })()
  `;
}

function buildDescription(
  target: string,
  windowId: number | undefined,
  selector: string | undefined,
  result: { width?: number; height?: number; windowTitle?: string }
): string {
  const parts: string[] = [];

  if (target === "element" && selector) {
    parts.push(`Element: ${selector}`);
  } else if (target === "window" && windowId) {
    parts.push(`Window ID: ${windowId}`);
  } else {
    parts.push("Main Zotero window");
  }

  if (result.windowTitle) {
    parts.push(`Title: ${result.windowTitle}`);
  }

  if (result.width && result.height) {
    parts.push(`Size: ${result.width}×${result.height}`);
  }

  return parts.join("\n");
}
