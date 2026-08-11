import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  type BridgeCallMessage,
  type ClientToServerMessage,
  createDisconnectedStatus,
  evaluateProtocolCompatibility,
  type EditorStatus,
  parseClientMessage
} from "../protocol/messages.js";
import { BridgeProtocolCompatibilityError, BridgeRpcError, BridgeTimeoutError, BridgeUnavailableError } from "./errors.js";

type PendingCall = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
};

export type EasyEdaBridgeOptions = {
  host?: string;
  port?: number;
  retryDelayMs?: number;
  logger?: Pick<Console, "error" | "warn" | "info">;
};

export class EasyEdaBridge {
  private readonly host: string;
  private readonly port: number;
  private readonly retryDelayMs: number;
  private readonly logger: Pick<Console, "error" | "warn" | "info">;
  private wss?: WebSocketServer;
  private socket?: WebSocket;
  private startPromise?: Promise<void>;
  private retryTimer?: NodeJS.Timeout;
  private stopping = false;
  private waitingForPort = false;
  private readonly pending = new Map<string, PendingCall>();
  private status: EditorStatus = createDisconnectedStatus();

  constructor(options: EasyEdaBridgeOptions = {}) {
    this.host = options.host ?? process.env.EASYEDA_MCP_WS_HOST ?? "127.0.0.1";
    this.port = options.port ?? Number(process.env.EASYEDA_MCP_WS_PORT ?? 8765);
    this.retryDelayMs = options.retryDelayMs ?? Number(process.env.EASYEDA_MCP_WS_RETRY_MS ?? 1_000);
    this.logger = options.logger ?? console;
  }

  get endpoint(): string {
    const address = this.wss?.address();
    const activePort = typeof address === "object" && address ? address.port : this.port;
    return `ws://${this.host}:${activePort}`;
  }

  getStatus(): EditorStatus {
    return this.status;
  }

  async start(): Promise<void> {
    this.stopping = false;
    if (this.wss) {
      return;
    }

    if (this.startPromise || this.retryTimer) {
      return this.startPromise;
    }

    const startPromise = this.startOnce();
    this.startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.startPromise === startPromise) {
        this.startPromise = undefined;
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.waitingForPort = false;
    this.rejectAll(new BridgeUnavailableError("EasyEDA Pro bridge is stopping."));
    this.socket?.close();
    const wss = this.wss;
    this.wss = undefined;
    await new Promise<void>((resolve, reject) => {
      if (!wss) {
        resolve();
        return;
      }
      wss.close((error) => (error ? reject(error) : resolve()));
    });
    this.socket = undefined;
    this.status = createDisconnectedStatus();
  }

  async call(method: string, params?: unknown, timeoutMs = 10_000): Promise<unknown> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new BridgeUnavailableError(this.status.message);
    }

    if (this.status.compatibility && !this.status.compatibility.compatible) {
      throw new BridgeProtocolCompatibilityError(
        this.status.compatibility.reason ?? "EasyEDA Pro extension protocol is incompatible with the MCP server.",
        this.status.compatibility.expectedProtocolVersion,
        this.status.compatibility.actualProtocolVersion
      );
    }

    const requestId = randomUUID();
    const message: BridgeCallMessage = {
      kind: "call",
      requestId,
      method,
      params,
      timeoutMs
    };

    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new BridgeTimeoutError(method, timeoutMs));
      }, timeoutMs);

      this.pending.set(requestId, {
        method,
        resolve,
        reject,
        timer
      });
    });

    this.socket.send(JSON.stringify(message));
    return response;
  }

  private attachSocket(socket: WebSocket): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.rejectAll(new BridgeUnavailableError("EasyEDA Pro extension reconnected. Retry the MCP tool call."));
      this.socket.close(1012, "A newer EasyEDA Pro extension connection replaced this one.");
    }

    this.socket = socket;
    this.status = {
      connected: true,
      connectionState: "connecting",
      message: "EasyEDA Pro extension connected. Waiting for hello/status.",
      updatedAt: new Date().toISOString()
    };
    this.logger.error("[easyeda-mcp] EasyEDA Pro extension connected");

    socket.on("message", (data) => {
      try {
        this.handleMessage(parseClientMessage(data.toString()));
      } catch (error) {
        this.logger.warn(`[easyeda-mcp] Ignored invalid bridge message: ${String(error)}`);
      }
    });

    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = undefined;
        this.status = createDisconnectedStatus("EasyEDA Pro extension disconnected. Keep the extension open or reopen EasyEDA Pro.");
        this.rejectAll(new BridgeUnavailableError(this.status.message));
      }
      this.logger.error("[easyeda-mcp] EasyEDA Pro extension disconnected");
    });
  }

  private async startOnce(): Promise<void> {
    const wss = new WebSocketServer({ host: this.host, port: this.port });
    this.wss = wss;
    wss.on("connection", (socket) => this.attachSocket(socket));

    try {
      await new Promise<void>((resolve, reject) => {
        const onListening = () => {
          wss.off("error", onError);
          resolve();
        };
        const onError = (error: Error) => {
          wss.off("listening", onListening);
          reject(error);
        };
        wss.once("listening", onListening);
        wss.once("error", onError);
      });
    } catch (error) {
      wss.removeAllListeners();
      if (this.wss === wss) {
        this.wss = undefined;
      }

      if (this.stopping) {
        return;
      }

      if (isAddressInUseError(error)) {
        const message = `WebSocket bridge ${this.endpoint} is already in use. MCP tools remain available and the bridge will retry in ${this.retryDelayMs}ms.`;
        this.status = createDisconnectedStatus(message);
        if (!this.waitingForPort) {
          this.logger.error(`[easyeda-mcp] ${message}`);
        }
        this.waitingForPort = true;
        this.scheduleRetry();
        return;
      }

      throw error;
    }

    if (this.stopping) {
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => (error ? reject(error) : resolve()));
      });
      if (this.wss === wss) {
        this.wss = undefined;
      }
      return;
    }

    this.waitingForPort = false;
    this.status = createDisconnectedStatus(`EasyEDA Pro extension is not connected. WebSocket bridge is listening at ${this.endpoint} and waiting for the extension.`);
    wss.on("error", (error) => {
      this.logger.error(`[easyeda-mcp] WebSocket bridge error: ${String(error)}`);
    });
    this.logger.error(`[easyeda-mcp] WebSocket bridge listening at ${this.endpoint}`);
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.stopping) {
      return;
    }

    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.stopping) {
        return;
      }
      void this.start().catch((error) => {
        this.status = createDisconnectedStatus(`WebSocket bridge could not start: ${String(error)}`);
        this.logger.error(`[easyeda-mcp] WebSocket bridge retry failed: ${String(error)}`);
      });
    }, this.retryDelayMs);
    this.retryTimer.unref();
  }

  private handleMessage(message: ClientToServerMessage): void {
    if (message.kind === "hello") {
      const compatibility = evaluateProtocolCompatibility(message.protocolVersion);
      this.status = {
        connected: true,
        connectionState: compatibility.compatible ? "connected" : "blocked",
        extensionVersion: message.version,
        protocolVersion: message.protocolVersion,
        compatibility,
        capabilities: message.capabilities,
        ...message.status,
        message: compatibility.compatible
          ? message.status?.message
          : compatibility.reason,
        updatedAt: new Date().toISOString()
      };
      return;
    }

    if (message.kind === "status") {
      const reportedProtocolVersion = message.status.protocolVersion ?? this.status.protocolVersion;
      const compatibility = evaluateProtocolCompatibility(reportedProtocolVersion);
      this.status = {
        ...this.status,
        ...message.status,
        connected: true,
        connectionState: compatibility.compatible ? "connected" : "blocked",
        compatibility,
        message: compatibility.compatible
          ? message.status.message ?? this.status.message
          : compatibility.reason,
        updatedAt: new Date().toISOString()
      };
      return;
    }

    if (message.kind === "result") {
      const pending = this.pending.get(message.requestId);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      pending.resolve(message.result);
      return;
    }

    if (message.kind === "error") {
      const pending = this.pending.get(message.requestId);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      pending.reject(new BridgeRpcError(message.error.message, message.error.code, message.error.details));
    }
  }

  private rejectAll(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }
}

function isAddressInUseError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}
