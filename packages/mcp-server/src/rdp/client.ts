/**
 * RDP Client - Connects to Firefox/Zotero DevTools Server
 *
 * Handles:
 * - TCP socket connection
 * - Packet framing (<length>:<json>)
 * - Request/response correlation
 * - Automatic reconnection
 */

import { createConnection, Socket } from "node:net";
import { EventEmitter } from "node:events";
import type {
  RDPResponse,
  RDPErrorResponse,
  ListTabsResponse,
  ListProcessesResponse,
  ProcessDescriptor,
  AttachResponse,
  EvaluateJSResponse,
  GetTargetResponse,
  GetCachedMessagesResponse,
  TabDescriptor,
  GripValue,
  GripObject,
} from "./protocol.js";
import { type ConnectionState, createConnectionState, findMainWindow } from "./actors.js";

export interface RDPClientOptions {
  host: string;
  port: number;
  reconnectDelay?: number;
  maxReconnectAttempts?: number;
  timeout?: number;
}

const DEFAULT_OPTIONS: Required<RDPClientOptions> = {
  host: "127.0.0.1",
  port: 6100,
  reconnectDelay: 1000,
  maxReconnectAttempts: 3,
  timeout: 30000,
};

/**
 * How long to trust a cached console actor before refreshing (ms)
 * Based on research: actors can become stale after navigation or page changes
 */
const ACTOR_CACHE_TTL_MS = 30000; // 30 seconds

/**
 * How long since last successful operation before we proactively check health
 */
const HEALTH_CHECK_THRESHOLD_MS = 10000; // 10 seconds

/**
 * Keepalive interval - how often to check connection health in background (ms)
 * Set to 0 to disable keepalive
 */
const KEEPALIVE_INTERVAL_MS: number = 30000; // 30 seconds

interface PendingRequest {
  resolve: (value: RDPResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class RDPClient extends EventEmitter {
  private options: Required<RDPClientOptions>;
  private socket: Socket | null = null;
  private state: ConnectionState;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private messageIdCounter = 0;
  private buffer = "";
  private reconnectAttempts = 0;

  // Connection health tracking
  private lastSuccessfulOperation = 0;
  private consoleActorCachedAt = 0;
  private consecutiveFailures = 0;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private isKeepaliveEnabled = true;

  constructor(options: Partial<RDPClientOptions> = {}) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.state = createConnectionState();
  }

  /**
   * Connect to the RDP server
   *
   * The server sends an intro packet immediately after connection
   * containing applicationType and traits. We capture this to initialize
   * the root state.
   */
  async connect(): Promise<void> {
    if (this.state.connected && this.socket) {
      return;
    }

    return new Promise((resolve, reject) => {
      let introReceived = false;

      // Handler for the intro packet that arrives immediately after connection
      const handleIntro = (message: RDPResponse) => {
        if (!introReceived && "applicationType" in message) {
          introReceived = true;
          this.state.root = {
            actorID: "root",
            applicationType: message.applicationType as string,
            traits: (message.traits as Record<string, boolean>) || {},
          };
          this.removeListener("message", handleIntro);
          resolve();
        }
      };

      // Listen for the intro packet
      this.on("message", handleIntro);

      this.socket = createConnection(
        {
          host: this.options.host,
          port: this.options.port,
        },
        () => {
          this.state.connected = true;
          this.reconnectAttempts = 0;
          this.consecutiveFailures = 0;
          this.lastSuccessfulOperation = Date.now();
          // Start background health checks
          this.startKeepalive();
          this.emit("connected");
          // Don't resolve here - wait for intro packet
        }
      );

      this.socket.setEncoding("utf8");

      // Enable TCP keepalive to detect dead connections faster
      // This is crucial for detecting when Zotero closes unexpectedly
      this.socket.setKeepAlive(true, 10000); // 10 second keepalive probe

      this.socket.on("data", (data: string) => this.handleData(data));
      this.socket.on("error", (err) => {
        this.removeListener("message", handleIntro);
        this.handleError(err, reject);
      });
      this.socket.on("close", () => this.handleClose());
      this.socket.on("timeout", () => this.handleTimeout());

      this.socket.setTimeout(this.options.timeout);
    });
  }

  /**
   * Disconnect from the RDP server
   */
  disconnect(): void {
    // Stop keepalive timer
    this.stopKeepalive();

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.state = createConnectionState();
    this.pendingRequests.forEach((req) => {
      clearTimeout(req.timeout);
      req.reject(new Error("Connection closed"));
    });
    this.pendingRequests.clear();
  }

  /**
   * Check if connected
   * Performs multiple checks to detect zombie/half-open connections
   */
  isConnected(): boolean {
    if (!this.state.connected || !this.socket) {
      return false;
    }

    // Check if socket is destroyed
    if (this.socket.destroyed) {
      this.state.connected = false;
      return false;
    }

    // Check if socket is still writable (detects half-open connections)
    if (!this.socket.writable) {
      this.state.connected = false;
      return false;
    }

    return true;
  }

  /**
   * Check if the cached console actor is still considered fresh
   * Based on research: actors can become stale after navigation or extended periods
   */
  private isActorCacheFresh(): boolean {
    if (!this.state.consoleActor) return false;
    const age = Date.now() - this.consoleActorCachedAt;
    return age < ACTOR_CACHE_TTL_MS;
  }

  /**
   * Check if we should proactively verify connection health
   */
  private shouldCheckHealth(): boolean {
    const timeSinceLastSuccess = Date.now() - this.lastSuccessfulOperation;
    return timeSinceLastSuccess > HEALTH_CHECK_THRESHOLD_MS;
  }

  /**
   * Lightweight health check - verifies the connection is alive
   * Uses getRoot() which is a simple, always-available operation
   */
  async checkHealth(): Promise<boolean> {
    if (!this.isConnected()) {
      return false;
    }

    try {
      await this.getRoot();
      this.lastSuccessfulOperation = Date.now();
      this.consecutiveFailures = 0;
      return true;
    } catch {
      this.consecutiveFailures++;
      return false;
    }
  }

  /**
   * Invalidate cached actors - call this when you suspect actors may be stale
   * Based on research: actors become invalid after page navigation, plugin reload, etc.
   */
  invalidateActorCache(): void {
    this.state.consoleActor = undefined;
    this.state.currentTab = undefined;
    this.consoleActorCachedAt = 0;
  }

  /**
   * Start the keepalive timer for background health checks
   * This detects stale/zombie connections before they cause operation failures
   */
  startKeepalive(): void {
    if (this.keepaliveTimer || !this.isKeepaliveEnabled || KEEPALIVE_INTERVAL_MS <= 0) {
      return;
    }

    this.keepaliveTimer = setInterval(async () => {
      if (!this.isConnected()) {
        return;
      }

      // Only check if we haven't had recent activity
      if (!this.shouldCheckHealth()) {
        return;
      }

      const healthy = await this.checkHealth();
      if (!healthy) {
        this.emit("keepaliveFailed");
        // Proactively reconnect to avoid failures on next operation
        try {
          await this.reconnect();
          this.emit("keepaliveReconnected");
        } catch {
          // Reconnect failed - will be retried on next operation
        }
      }
    }, KEEPALIVE_INTERVAL_MS);

    // Don't prevent process exit
    this.keepaliveTimer.unref();
  }

  /**
   * Stop the keepalive timer
   */
  stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  /**
   * Enable or disable keepalive (useful for testing or low-resource environments)
   */
  setKeepaliveEnabled(enabled: boolean): void {
    this.isKeepaliveEnabled = enabled;
    if (!enabled) {
      this.stopKeepalive();
    } else if (this.isConnected()) {
      this.startKeepalive();
    }
  }

  /**
   * Generic retry wrapper for any async operation
   * Handles connection errors, actor errors, and implements exponential backoff
   */
  async withRetry<T>(
    operation: () => Promise<T>,
    options: {
      maxRetries?: number;
      shouldInvalidateActors?: boolean;
      operationName?: string;
    } = {}
  ): Promise<T> {
    const { maxRetries = 2, shouldInvalidateActors = false, operationName = "operation" } = options;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Check connection before attempt
        if (!this.isConnected()) {
          if (attempt < maxRetries) {
            await this.reconnect();
          } else {
            throw new Error(
              "Not connected to Zotero. Ensure:\n" +
                "1. Zotero is running\n" +
                "2. MCP Bridge for Zotero plugin is installed\n" +
                `3. Port ${this.options.port} is not blocked`
            );
          }
        }

        const result = await operation();

        // Success - update health tracking
        this.lastSuccessfulOperation = Date.now();
        this.consecutiveFailures = 0;

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.consecutiveFailures++;

        const errorMessage = lastError.message;
        const isActorError = errorMessage.includes("No such actor");
        const isConnectionError =
          errorMessage.includes("Not connected") ||
          errorMessage.includes("Connection closed") ||
          errorMessage.includes("ECONNRESET") ||
          errorMessage.includes("EPIPE") ||
          errorMessage.includes("ETIMEDOUT");

        // Don't retry if we've exhausted attempts
        if (attempt >= maxRetries) {
          break;
        }

        // Actor errors - invalidate cache and retry
        if (isActorError || shouldInvalidateActors) {
          this.invalidateActorCache();
          await this.delay(100 * (attempt + 1));
          continue;
        }

        // Connection errors - full reconnect
        if (isConnectionError) {
          const backoffMs = Math.min(1000 * Math.pow(2, this.consecutiveFailures - 1), 5000);
          await this.delay(backoffMs);
          await this.reconnect();
          continue;
        }

        // Unknown error - don't retry
        break;
      }
    }

    throw lastError || new Error(`${operationName} failed after ${maxRetries + 1} attempts`);
  }

  /**
   * Send a raw RDP message and wait for response
   */
  async sendMessage<T extends RDPResponse>(message: Record<string, unknown>): Promise<T> {
    if (!this.socket || !this.state.connected) {
      throw new Error(
        "Not connected to Zotero. Ensure:\n" +
          "1. Zotero is running\n" +
          "2. MCP Bridge for Zotero plugin is installed\n" +
          `3. Port ${this.options.port} is not blocked`
      );
    }

    return new Promise((resolve, reject) => {
      const messageId = `msg-${++this.messageIdCounter}`;

      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(messageId);
        reject(new Error(`Request timeout for ${message.type} to ${message.to}`));
      }, this.options.timeout);

      this.pendingRequests.set(messageId, {
        resolve: resolve as (value: RDPResponse) => void,
        reject,
        timeout,
      });

      // RDP packet format: <length>:<json>
      const json = JSON.stringify(message);
      const packet = `${json.length}:${json}`;

      this.socket!.write(packet, (err) => {
        if (err) {
          this.pendingRequests.delete(messageId);
          clearTimeout(timeout);
          reject(err);
        }
      });
    });
  }

  /**
   * Get root actor info
   */
  async getRoot(): Promise<void> {
    const response = await this.sendMessage<RDPResponse>({
      to: "root",
      type: "getRoot",
    });

    if ("applicationType" in response) {
      this.state.root = {
        actorID: "root",
        applicationType: response.applicationType as string,
        traits: (response.traits as Record<string, boolean>) || {},
      };
    }
  }

  /**
   * List available tabs/windows
   * Note: Returns empty in Zotero - use listProcesses() instead
   */
  async listTabs(): Promise<TabDescriptor[]> {
    const response = await this.sendMessage<ListTabsResponse>({
      to: "root",
      type: "listTabs",
    });

    return response.tabs || [];
  }

  /**
   * List available processes
   * This is the correct method for Zotero (listTabs returns empty)
   */
  async listProcesses(): Promise<ProcessDescriptor[]> {
    const response = await this.sendMessage<ListProcessesResponse>({
      to: "root",
      type: "listProcesses",
    });

    return response.processes || [];
  }

  /**
   * Attach to a tab to get console actor
   */
  async attachToTab(tabActor: string): Promise<AttachResponse> {
    const response = await this.sendMessage<AttachResponse>({
      to: tabActor,
      type: "attach",
    });

    return response;
  }

  /**
   * Get target info (includes console actor)
   * Works with both tab actors and process descriptors
   */
  async getTarget(actorId: string): Promise<GetTargetResponse> {
    const response = await this.sendMessage<GetTargetResponse>({
      to: actorId,
      type: "getTarget",
    });

    // Handle frame-based response (traditional tabs)
    if (response.frame?.consoleActor) {
      this.state.consoleActor = response.frame.consoleActor;
    }

    // Handle process-based response (Zotero)
    if (response.process?.consoleActor) {
      this.state.consoleActor = response.process.consoleActor;
      // Store additional info about the target
      this.state.currentTab = {
        actorID: response.process.actor,
        title: response.process.title,
        url: response.process.url,
        outerWindowID: response.process.outerWindowID,
      };
    }

    return response;
  }

  /**
   * Execute JavaScript in the Zotero context
   *
   * Implements robust error handling based on Firefox RDP research:
   * - Proactive health checks when connection may be stale
   * - Actor cache invalidation after TTL expires
   * - Automatic reconnection on recoverable errors
   * - Exponential backoff for consecutive failures
   */
  async evaluateJS(code: string, retryCount = 0): Promise<EvaluateJSResponse> {
    const maxRetries = 2;

    // Check connection state and reconnect if needed
    if (!this.isConnected()) {
      if (retryCount < maxRetries) {
        await this.reconnect();
        return this.evaluateJS(code, retryCount + 1);
      }
      throw new Error(
        "Not connected to Zotero. Ensure:\n" +
          "1. Zotero is running\n" +
          "2. MCP Bridge for Zotero plugin is installed\n" +
          `3. Port ${this.options.port} is not blocked`
      );
    }

    // Proactive health check if it's been a while since last success
    // This catches stale connections before they cause errors
    if (this.shouldCheckHealth() && retryCount === 0) {
      const healthy = await this.checkHealth();
      if (!healthy) {
        await this.reconnect();
        return this.evaluateJS(code, retryCount + 1);
      }
    }

    // Check if cached actor might be stale (based on TTL)
    // Research shows actors can become invalid after navigation/reload
    if (!this.isActorCacheFresh()) {
      this.invalidateActorCache();
    }

    // Ensure we have a console actor
    if (!this.state.consoleActor) {
      await this.ensureConsoleActor();
      this.consoleActorCachedAt = Date.now();
    }

    if (!this.state.consoleActor) {
      throw new Error("No console actor available. Cannot execute JavaScript.");
    }

    try {
      const response = await this.sendMessage<EvaluateJSResponse>({
        to: this.state.consoleActor,
        type: "evaluateJSAsync",
        text: code,
        mapped: { await: true },
      });

      // Success! Update health tracking
      this.lastSuccessfulOperation = Date.now();
      this.consecutiveFailures = 0;

      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.consecutiveFailures++;

      // Categorize errors based on Firefox RDP research
      const isActorError = errorMessage.includes("No such actor");
      const isConnectionError =
        errorMessage.includes("Not connected") ||
        errorMessage.includes("Connection closed") ||
        errorMessage.includes("ECONNRESET") ||
        errorMessage.includes("EPIPE") ||
        errorMessage.includes("ETIMEDOUT");

      // Actor errors: invalidate cache and retry (actor was destroyed server-side)
      if (isActorError && retryCount < maxRetries) {
        this.invalidateActorCache();
        // Small delay before retry - server may need time to stabilize
        await this.delay(100 * (retryCount + 1));
        return this.evaluateJS(code, retryCount + 1);
      }

      // Connection errors: full reconnect needed
      if (isConnectionError && retryCount < maxRetries) {
        // Exponential backoff based on consecutive failures
        const backoffMs = Math.min(1000 * Math.pow(2, this.consecutiveFailures - 1), 5000);
        await this.delay(backoffMs);
        await this.reconnect();
        return this.evaluateJS(code, retryCount + 1);
      }

      throw error;
    }
  }

  /**
   * Helper for delays (used in retry backoff)
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Reconnect to the RDP server, clearing all cached state
   * Based on research: Firefox requires full disconnect/reconnect, not just reconnect
   */
  private async reconnect(): Promise<void> {
    // Clear all cached state - actors are definitely invalid after reconnect
    this.invalidateActorCache();
    this.state.root = undefined;
    this.consoleActorCachedAt = 0;

    // Disconnect cleanly (this also clears pending requests)
    this.disconnect();

    // Small delay before reconnect - gives Zotero time to clean up
    // Based on Bug 1544716: immediate reconnect often fails
    await this.delay(100);

    // Reconnect
    await this.connect();

    // Reset health tracking on successful reconnect
    this.lastSuccessfulOperation = Date.now();
  }

  /**
   * Get cached console messages
   */
  async getCachedMessages(
    types: string[] = ["ConsoleAPI", "PageError"]
  ): Promise<GetCachedMessagesResponse> {
    if (!this.state.consoleActor) {
      await this.ensureConsoleActor();
    }

    if (!this.state.consoleActor) {
      throw new Error("No console actor available");
    }

    return this.sendMessage<GetCachedMessagesResponse>({
      to: this.state.consoleActor,
      type: "getCachedMessages",
      messageTypes: types,
    });
  }

  /**
   * Ensure we have a console actor by connecting to the main Zotero process
   *
   * In Zotero, we use listProcesses() instead of listTabs() because
   * Zotero isn't a traditional browser with tabs. The hierarchy is:
   *   root -> listProcesses -> getTarget(processDescriptor) -> consoleActor
   */
  private async ensureConsoleActor(): Promise<void> {
    // Get root if needed
    if (!this.state.root) {
      await this.getRoot();
    }

    // First, try the process-based approach (works for Zotero)
    try {
      const processes = await this.listProcesses();
      const parentProcess = processes.find((p) => p.isParent);

      if (parentProcess) {
        const target = await this.getTarget(parentProcess.actor);

        // Check for console actor in process response
        if (target.process?.consoleActor) {
          this.state.consoleActor = target.process.consoleActor;
          return;
        }

        // Check for console actor in frame response (fallback)
        if (target.frame?.consoleActor) {
          this.state.consoleActor = target.frame.consoleActor;
          return;
        }
      }
    } catch (error) {
      // Process approach failed, try tabs as fallback
    }

    // Fallback: Try tab-based approach (traditional Firefox)
    const tabs = await this.listTabs();
    const mainWindow = findMainWindow(tabs);

    if (mainWindow) {
      // Store current tab
      this.state.currentTab = {
        actorID: mainWindow.actor,
        title: mainWindow.title,
        url: mainWindow.url,
        outerWindowID: mainWindow.outerWindowID,
      };

      // Try getTarget
      try {
        const target = await this.getTarget(mainWindow.actor);
        if (target.frame?.consoleActor || target.process?.consoleActor) {
          return; // Console actor set in getTarget
        }
      } catch {
        // Try attach as last resort
      }

      // Last resort: attach to tab
      try {
        const attached = await this.attachToTab(mainWindow.actor);
        if ("consoleActor" in attached) {
          this.state.consoleActor = attached.consoleActor as string;
          return;
        }
      } catch {
        // Attach failed
      }
    }

    // If we get here, we couldn't find a console actor
    if (!this.state.consoleActor) {
      throw new Error(
        "Could not find Zotero console actor. Ensure:\n" +
          "1. Zotero is running\n" +
          "2. MCP Bridge for Zotero plugin is installed\n" +
          "3. Try restarting Zotero"
      );
    }
  }

  /**
   * Handle incoming data from socket
   */
  private handleData(data: string): void {
    this.buffer += data;
    this.processBuffer();
  }

  /**
   * Process buffered data to extract complete messages
   */
  private processBuffer(): void {
    while (true) {
      // Find the length prefix
      const colonIndex = this.buffer.indexOf(":");
      if (colonIndex === -1) {
        break;
      }

      const lengthStr = this.buffer.slice(0, colonIndex);
      const length = parseInt(lengthStr, 10);

      if (isNaN(length)) {
        // Invalid packet, skip this byte
        this.buffer = this.buffer.slice(1);
        continue;
      }

      const messageStart = colonIndex + 1;
      const messageEnd = messageStart + length;

      if (this.buffer.length < messageEnd) {
        // Incomplete message, wait for more data
        break;
      }

      const messageStr = this.buffer.slice(messageStart, messageEnd);
      this.buffer = this.buffer.slice(messageEnd);

      try {
        const message = JSON.parse(messageStr) as RDPResponse;
        this.handleMessage(message);
      } catch (error) {
        this.emit("error", new Error(`Failed to parse RDP message: ${messageStr}`));
      }
    }
  }

  /**
   * Known RDP event types that are unsolicited notifications, not responses
   */
  private static readonly EVENT_TYPES = new Set([
    "frameUpdate",
    "tabNavigated",
    "newSource",
    "tabDetached",
    "workerListChanged",
    "documentEvent",
    "pageError",
    "consoleAPICall",
    "reflowActivity",
    "styleSheetsAdded",
    "styleSheetsRemoved",
  ]);

  /**
   * Events that indicate actors may have been invalidated
   * Based on geckordp research: navigation and detach events invalidate actors
   */
  private static readonly ACTOR_INVALIDATING_EVENTS = new Set([
    "tabNavigated",
    "tabDetached",
    "frameUpdate",
    "workerListChanged",
  ]);

  /**
   * Handle a parsed RDP message
   */
  private handleMessage(message: RDPResponse): void {
    // Check if this is an unsolicited event (not a response to a request)
    // Events have a "type" field with known event names
    const messageType = message.type as string | undefined;
    if (messageType && RDPClient.EVENT_TYPES.has(messageType)) {
      // Check if this event invalidates our cached actors
      // Based on research: navigation/detach events make actors stale
      if (RDPClient.ACTOR_INVALIDATING_EVENTS.has(messageType)) {
        this.invalidateActorCache();
        this.emit("actorsInvalidated", messageType);
      }

      // This is an event, not a response - emit and don't consume pending requests
      this.emit("message", message);
      return;
    }

    // Skip evaluateJSAsync acknowledgment messages
    // These have only { resultID, from } and are followed by the actual result
    // with { type: "evaluationResult", resultID, result, ... }
    if (
      "resultID" in message &&
      !("type" in message) &&
      !("result" in message) &&
      Object.keys(message).length <= 2
    ) {
      // This is just an acknowledgment, wait for the actual result
      return;
    }

    // RDP responses come from actors, not tied to specific request IDs
    // We use a simple FIFO approach for request/response correlation
    // The first pending request gets the response
    const pendingEntry = this.pendingRequests.entries().next();
    if (!pendingEntry.done) {
      const [messageId, pending] = pendingEntry.value;
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(messageId);

      if ("error" in message) {
        pending.reject(new Error((message as RDPErrorResponse).message || message.error as string));
      } else {
        pending.resolve(message);
      }
    } else {
      // Unsolicited message (event)
      this.emit("message", message);
    }
  }

  /**
   * Handle socket errors
   */
  private handleError(error: Error, initialReject?: (error: Error) => void): void {
    this.state.connected = false;

    if (initialReject) {
      initialReject(
        new Error(
          `Cannot connect to Zotero RDP at ${this.options.host}:${this.options.port}. ` +
            `Ensure Zotero is running with the MCP Bridge for Zotero plugin installed.\n` +
            `Original error: ${error.message}`
        )
      );
    } else {
      this.emit("error", error);
    }
  }

  /**
   * Handle socket close
   */
  private handleClose(): void {
    const wasConnected = this.state.connected;
    this.state.connected = false;
    this.socket = null;

    if (wasConnected) {
      this.emit("disconnected");

      // Attempt reconnection
      if (this.reconnectAttempts < this.options.maxReconnectAttempts) {
        this.reconnectAttempts++;
        setTimeout(() => {
          this.emit("reconnecting", this.reconnectAttempts);
          this.connect().catch(() => {
            // Reconnection failed, will try again if attempts remain
          });
        }, this.options.reconnectDelay);
      }
    }
  }

  /**
   * Handle socket timeout
   */
  private handleTimeout(): void {
    this.emit("timeout");
    this.disconnect();
  }

  /**
   * Get connection state
   */
  getState(): Readonly<ConnectionState> {
    return { ...this.state };
  }

  /**
   * Convert a Grip value to a plain JavaScript value (simplified)
   */
  static gripToValue(grip: GripValue): unknown {
    if (grip === null || grip === undefined) {
      return grip;
    }

    if (typeof grip !== "object") {
      return grip; // Primitive
    }

    // Handle longString type - return initial content for sync access
    // Use gripToValueAsync for full string content
    if ("type" in grip && grip.type === "longString") {
      const longStr = grip as { initial: string; length: number; actor: string };
      // If initial contains all content, return it
      if (longStr.initial && longStr.initial.length >= longStr.length) {
        return longStr.initial;
      }
      // Otherwise return the grip object itself - caller needs to use async method
      return grip;
    }

    if ("type" in grip && grip.type === "object") {
      const gripObj = grip as GripObject;
      if (gripObj.class === "Array" && gripObj.preview?.items) {
        return gripObj.preview.items.map((item) => RDPClient.gripToValue(item));
      }
      if (gripObj.preview && "ownProperties" in gripObj.preview && gripObj.preview.ownProperties) {
        const result: Record<string, unknown> = {};
        for (const [key, prop] of Object.entries(gripObj.preview.ownProperties)) {
          result[key] = RDPClient.gripToValue((prop as { value: GripValue }).value);
        }
        return result;
      }
      // Return a placeholder for complex objects
      return `[${gripObj.class}]`;
    }

    if ("type" in grip && grip.type === "symbol") {
      return Symbol.for((grip as { name: string }).name);
    }

    return grip;
  }

  /**
   * Check if a value is a longString grip that needs async fetching
   */
  static isLongString(value: unknown): value is { type: "longString"; actor: string; length: number; initial: string } {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      (value as { type: string }).type === "longString" &&
      "actor" in value
    );
  }

  /**
   * Fetch the full content of a long string from its actor
   */
  async fetchLongString(actor: string, length: number): Promise<string> {
    const response = await this.sendMessage({
      to: actor,
      type: "substring",
      start: 0,
      end: length,
    });
    return (response as unknown as { substring: string }).substring;
  }

  /**
   * Convert a Grip value to a plain JavaScript value, fetching long strings asynchronously
   */
  async gripToValueAsync(grip: GripValue): Promise<unknown> {
    const syncValue = RDPClient.gripToValue(grip);

    // If it's a longString grip, fetch the full content
    if (RDPClient.isLongString(syncValue)) {
      return this.fetchLongString(syncValue.actor, syncValue.length);
    }

    return syncValue;
  }
}

// Export a singleton instance with default options from environment
export function createClient(options?: Partial<RDPClientOptions>): RDPClient {
  return new RDPClient({
    host: process.env.ZOTERO_RDP_HOST || options?.host || DEFAULT_OPTIONS.host,
    port: parseInt(process.env.ZOTERO_RDP_PORT || "", 10) || options?.port || DEFAULT_OPTIONS.port,
    ...options,
  });
}
