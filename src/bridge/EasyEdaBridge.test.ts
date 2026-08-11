import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { EasyEdaBridge } from "./EasyEdaBridge.js";
import { BridgeProtocolCompatibilityError, BridgeRpcError, BridgeUnavailableError } from "./errors.js";

const bridges: EasyEdaBridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
});

describe("EasyEdaBridge", () => {
  it("reports disconnected status before an extension connects", async () => {
    const bridge = await startBridge();

    expect(bridge.getStatus().connected).toBe(false);
    expect(bridge.getStatus().message).toContain("WebSocket bridge is listening");
    await expect(bridge.call("getContext")).rejects.toBeInstanceOf(BridgeUnavailableError);
  });

  it("keeps retrying when the requested port is busy and acquires it when released", async () => {
    const currentOwner = await startBridge();
    const port = Number(new URL(currentOwner.endpoint).port);
    const messages: string[] = [];
    const waitingBridge = new EasyEdaBridge({
      port,
      retryDelayMs: 10,
      logger: {
        error: (message) => messages.push(String(message)),
        warn: () => undefined,
        info: () => undefined
      }
    });
    bridges.push(waitingBridge);

    await waitingBridge.start();

    expect(waitingBridge.getStatus()).toMatchObject({
      connected: false,
      connectionState: "disconnected"
    });
    expect(waitingBridge.getStatus().message).toContain("already in use");
    expect(messages.some((message) => message.includes("MCP tools remain available"))).toBe(true);
    await wait(35);
    expect(messages.filter((message) => message.includes("already in use"))).toHaveLength(1);

    await currentOwner.stop();
    await vi.waitFor(() => {
      expect(waitingBridge.getStatus().message).toContain("WebSocket bridge is listening");
    }, { timeout: 2_000, interval: 10 });

    const client = await connectClient(waitingBridge.endpoint);
    expect(client.readyState).toBe(WebSocket.OPEN);
    client.close();
  });

  it("round-trips RPC calls through a WebSocket extension client", async () => {
    const bridge = await startBridge();
    const client = await connectClient(bridge.endpoint);
    client.on("message", (data) => {
      const message = JSON.parse(data.toString());
      client.send(JSON.stringify({
        kind: "result",
        requestId: message.requestId,
        result: {
          method: message.method,
          params: message.params
        }
      }));
    });

    const result = await bridge.call("findComponent", { query: "U1" });

    expect(result).toEqual({
      method: "findComponent",
      params: { query: "U1" }
    });
    client.close();
  });

  it("updates status from hello messages", async () => {
    const bridge = await startBridge();
    const client = await connectClient(bridge.endpoint);
    client.send(JSON.stringify({
      kind: "hello",
      client: "easyeda-pro-extension",
      version: "0.1.0",
      protocolVersion: "0.1.0",
      capabilities: {
        websocket: true,
        pcbDocument: true
      },
      status: {
        documentName: "main pcb"
      }
    }));

    await wait(20);

    expect(bridge.getStatus()).toMatchObject({
      connected: true,
      extensionVersion: "0.1.0",
      documentName: "main pcb"
    });
    client.close();
  });

  it("blocks calls when the extension protocol is incompatible", async () => {
    const bridge = await startBridge();
    const client = await connectClient(bridge.endpoint);
    client.send(JSON.stringify({
      kind: "hello",
      client: "easyeda-pro-extension",
      version: "0.1.0",
      protocolVersion: "9.9.9",
      capabilities: {
        websocket: true
      }
    }));

    await wait(20);

    await expect(bridge.call("getContext")).rejects.toBeInstanceOf(BridgeProtocolCompatibilityError);
    client.close();
  });

  it("turns remote errors into BridgeRpcError", async () => {
    const bridge = await startBridge();
    const client = await connectClient(bridge.endpoint);
    client.on("message", (data) => {
      const message = JSON.parse(data.toString());
      client.send(JSON.stringify({
        kind: "error",
        requestId: message.requestId,
        error: {
          code: "api_unavailable",
          message: "missing EasyEDA API"
        }
      }));
    });

    await expect(bridge.call("zoomBoard")).rejects.toBeInstanceOf(BridgeRpcError);
    client.close();
  });

  it("allows a newer extension connection to replace the old one", async () => {
    const bridge = await startBridge();
    const oldClient = await connectClient(bridge.endpoint);
    const newClient = await connectClient(bridge.endpoint);
    newClient.on("message", (data) => {
      const message = JSON.parse(data.toString());
      newClient.send(JSON.stringify({
        kind: "result",
        requestId: message.requestId,
        result: "new-client"
      }));
    });

    await wait(20);

    await expect(bridge.call("getContext")).resolves.toBe("new-client");
    oldClient.close();
    newClient.close();
  });

  it("rejects pending calls when a newer extension connection replaces the old one", async () => {
    const bridge = await startBridge();
    const oldClient = await connectClient(bridge.endpoint);
    const pendingCall = bridge.call("getContext");
    pendingCall.catch(() => undefined);

    await wait(20);
    const newClient = await connectClient(bridge.endpoint);
    newClient.on("message", (data) => {
      const message = JSON.parse(data.toString());
      newClient.send(JSON.stringify({
        kind: "result",
        requestId: message.requestId,
        result: "new-client"
      }));
    });

    await expect(pendingCall).rejects.toBeInstanceOf(BridgeUnavailableError);
    oldClient.close();
    newClient.close();
  });
});

async function startBridge(): Promise<EasyEdaBridge> {
  const bridge = new EasyEdaBridge({
    port: 0,
    logger: {
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined
    }
  });
  await bridge.start();
  bridges.push(bridge);
  return bridge;
}

async function connectClient(endpoint: string): Promise<WebSocket> {
  const client = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  return client;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
