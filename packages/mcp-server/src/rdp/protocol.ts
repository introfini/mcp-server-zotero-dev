/**
 * Firefox Remote Debugging Protocol (RDP) message types
 *
 * The RDP uses a simple packet format: <length>:<json-message>
 * Example: 36:{"to":"root","type":"getRoot"}
 */

// Base message types
export interface RDPMessage {
  to: string;
  type: string;
}

export interface RDPResponse {
  from: string;
  [key: string]: unknown;
}

export interface RDPErrorResponse extends RDPResponse {
  error: string;
  message?: string;
}

// Root actor messages
export interface GetRootRequest extends RDPMessage {
  type: "getRoot";
}

export interface RootActorResponse extends RDPResponse {
  applicationType: string;
  traits: Record<string, boolean>;
}

// List tabs request/response
export interface ListTabsRequest extends RDPMessage {
  type: "listTabs";
}

export interface TabDescriptor {
  actor: string;
  title: string;
  url: string;
  outerWindowID?: number;
  browsingContextID?: number;
}

export interface ListTabsResponse extends RDPResponse {
  tabs: TabDescriptor[];
  selected: number;
}

// List processes request/response (used for Zotero instead of tabs)
export interface ListProcessesRequest extends RDPMessage {
  type: "listProcesses";
}

export interface ProcessDescriptor {
  actor: string;
  id: number;
  isParent: boolean;
  isWindowlessParent?: boolean;
  traits?: {
    watcher?: boolean;
    supportsReloadDescriptor?: boolean;
  };
}

export interface ListProcessesResponse extends RDPResponse {
  processes: ProcessDescriptor[];
}

// Process target response (from getTarget on a process descriptor)
export interface ProcessTargetInfo {
  actor: string;
  targetType: string;
  browsingContextID?: number;
  processID?: number;
  innerWindowId?: number;
  topInnerWindowId?: number;
  isTopLevelTarget?: boolean;
  title: string;
  url: string;
  outerWindowID?: number;
  consoleActor: string;
  inspectorActor?: string;
  styleSheetsActor?: string;
  screenshotContentActor?: string;
  threadActor?: string;
  // ... other actors
}

// Tab actor - attach to get console
export interface AttachRequest extends RDPMessage {
  type: "attach";
  options?: Record<string, unknown>;
}

export interface AttachResponse extends RDPResponse {
  type: "tabAttached";
  threadActor?: string;
  targetFront?: string;
}

// Console actor messages
export interface EvaluateJSRequest extends RDPMessage {
  type: "evaluateJSAsync";
  text: string;
  eager?: boolean;
  selectedNodeActor?: string;
  mapped?: {
    await: boolean;
  };
}

export interface EvaluateJSResponse extends RDPResponse {
  resultID?: string;
  input?: string;
  result?: GripValue;
  exception?: GripValue;
  exceptionMessage?: string;
  helperResult?: unknown;
  timestamp?: number;
}

// Grip (serialized JS value)
export type GripValue =
  | null
  | undefined
  | boolean
  | number
  | string
  | GripObject
  | GripArray
  | GripSymbol
  | GripLongString
  | GripError;

export interface GripObject {
  type: "object";
  actor: string;
  class: string;
  preview?: {
    kind: string;
    ownProperties?: Record<string, { value: GripValue }>;
    items?: GripValue[];
    [key: string]: unknown;
  };
  ownPropertyLength?: number;
}

export interface GripArray {
  type: "object";
  actor: string;
  class: "Array";
  preview?: {
    kind: "ArrayLike";
    length: number;
    items?: GripValue[];
  };
}

export interface GripSymbol {
  type: "symbol";
  name: string;
}

export interface GripLongString {
  type: "longString";
  actor: string;
  length: number;
  initial: string;
}

export interface GripError {
  type: "object";
  actor: string;
  class: "Error" | "TypeError" | "ReferenceError" | "SyntaxError";
  preview?: {
    kind: "Error";
    name: string;
    message: string;
    stack?: string;
    fileName?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
}

// Get target (for getting console actor)
export interface GetTargetRequest extends RDPMessage {
  type: "getTarget";
}

export interface GetTargetResponse extends RDPResponse {
  // For tab targets
  frame?: {
    actor: string;
    consoleActor: string;
    [key: string]: unknown;
  };
  // For process targets (Zotero)
  process?: ProcessTargetInfo;
}

// Console getCachedMessages
export interface GetCachedMessagesRequest extends RDPMessage {
  type: "getCachedMessages";
  messageTypes: string[];
}

export interface ConsoleMessage {
  type: string;
  message?: string;
  level?: string;
  timestamp?: number;
  arguments?: GripValue[];
  filename?: string;
  lineNumber?: number;
  columnNumber?: number;
  category?: string;
}

export interface GetCachedMessagesResponse extends RDPResponse {
  messages: ConsoleMessage[];
}

// Utility types
export function isErrorResponse(response: RDPResponse): response is RDPErrorResponse {
  return "error" in response;
}

export function isGripObject(value: GripValue): value is GripObject {
  return typeof value === "object" && value !== null && "type" in value && value.type === "object";
}
