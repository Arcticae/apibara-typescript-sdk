import { describe, expect, it } from "vitest";
import { requestStarknetWebSocket } from "../src/websocket-request";

describe("requestStarknetWebSocket", () => {
  it("reuses an open caller-owned socket without closing it", async () => {
    const socket = new MockWebSocket();

    await expect(
      requestStarknetWebSocket(
        socket as unknown as WebSocket,
        { id: 7, method: "starknet_specVersion" },
        100,
      ),
    ).resolves.toBe("0.10.2");

    expect(socket.closeCalls).toBe(0);
    expect(JSON.parse(socket.sent[0])).toEqual({
      jsonrpc: "2.0",
      id: 7,
      method: "starknet_specVersion",
      params: [],
    });
  });
});

class MockWebSocket extends EventTarget {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly readyState = this.OPEN;
  readonly sent: string[] = [];
  closeCalls = 0;

  send(data: string): void {
    this.sent.push(data);
    const request = JSON.parse(data) as { id: number };
    queueMicrotask(() => {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: "0.10.2",
          }),
        }),
      );
    });
  }

  close(): void {
    this.closeCalls++;
  }
}
