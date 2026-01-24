/**
 * Actor interfaces for Firefox Remote Debugging Protocol
 *
 * Actors are the primary abstraction in RDP. Each actor has:
 * - A unique actor ID (string)
 * - A set of methods it can handle
 * - Optional event notifications
 */

import type { GripValue, TabDescriptor, ConsoleMessage } from "./protocol.js";

/**
 * Root actor - entry point for all RDP communication
 * Always available at actor ID "root"
 */
export interface RootActor {
  actorID: "root";

  // Application info
  applicationType: string;
  traits: Record<string, boolean>;
}

/**
 * Tab actor - represents a browser tab/window
 * Use listTabs to discover available tabs
 */
export interface TabActor {
  actorID: string;
  title: string;
  url: string;
  outerWindowID?: number;

  // Child actors obtained after attach
  consoleActor?: string;
  inspectorActor?: string;
  threadActor?: string;
}

/**
 * Console actor - JavaScript execution and console messages
 * Primary tool for interacting with Zotero's runtime
 */
export interface ConsoleActor {
  actorID: string;

  // Methods
  evaluateJS(text: string): Promise<EvaluateResult>;
  getCachedMessages(types: string[]): Promise<ConsoleMessage[]>;
}

export interface EvaluateResult {
  input: string;
  result?: GripValue;
  exception?: GripValue;
  exceptionMessage?: string;
  timestamp: number;
}

/**
 * Inspector actor - DOM inspection
 * Used for element finding and DOM tree navigation
 */
export interface InspectorActor {
  actorID: string;

  // Actors obtained from inspector
  walkerActor?: string;
  pageStyleActor?: string;
}

/**
 * Walker actor - DOM tree traversal
 * Obtained from InspectorActor
 */
export interface WalkerActor {
  actorID: string;
  rootNode?: NodeActor;
}

/**
 * Node actor - represents a DOM node
 */
export interface NodeActor {
  actorID: string;
  nodeType: number;
  nodeName: string;
  nodeValue?: string;

  // Common attributes
  attrs?: Array<{ name: string; value: string }>;

  // Hierarchy info
  numChildren?: number;

  // Computed info
  isDisplayed?: boolean;
  displayType?: string;
}

/**
 * PageStyle actor - CSS computed styles
 */
export interface PageStyleActor {
  actorID: string;

  getComputed(nodeActor: string): Promise<Record<string, string>>;
}

/**
 * Screenshot actor - screen capture
 * May be available as a method on TabActor or separate actor
 */
export interface ScreenshotActor {
  actorID: string;

  captureScreenshot(options: ScreenshotOptions): Promise<ScreenshotResult>;
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  scale?: number;
}

export interface ScreenshotResult {
  data: string; // Base64 PNG
  mimeType: "image/png";
}

/**
 * Connection state tracking
 */
export interface ConnectionState {
  connected: boolean;
  root?: RootActor;
  currentTab?: TabActor;
  consoleActor?: string;
  inspectorActor?: string;
}

/**
 * Create a fresh connection state
 */
export function createConnectionState(): ConnectionState {
  return {
    connected: false,
  };
}

/**
 * Helper to extract tab from list response
 */
export function findMainWindow(tabs: TabDescriptor[]): TabDescriptor | undefined {
  // Look for Zotero's main window
  // It typically has title containing "Zotero" and URL starting with "chrome://"
  return (
    tabs.find((t) => t.url.startsWith("chrome://zotero/content/zoteroPane.xhtml")) ||
    tabs.find((t) => t.title.includes("Zotero")) ||
    tabs[0] // Fallback to first tab
  );
}
