import { describe, expect, it } from "vitest";
import { StarknetJsonRpcClient } from "../src/client";

describe("StarknetJsonRpcClient", () => {
  it("retries transient HTTP errors", async () => {
    let calls = 0;
    const fetchImplementation: typeof fetch = async () => {
      calls++;
      if (calls < 3) {
        return new Response("temporary", { status: 503 });
      }
      return Response.json({ jsonrpc: "2.0", id: 1, result: "0.9.0" });
    };
    const client = new StarknetJsonRpcClient("http://rpc.invalid", {
      fetch: fetchImplementation,
      requestsPerSecond: 1_000,
    });

    await expect(client.request("starknet_specVersion")).resolves.toBe("0.9.0");
    expect(calls).toBe(3);
  });

  it("enforces the in-flight concurrency limit", async () => {
    let active = 0;
    let maximumActive = 0;
    const fetchImplementation: typeof fetch = async (_input, init) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      const body = JSON.parse(String(init?.body)) as { id: number };
      return Response.json({ jsonrpc: "2.0", id: body.id, result: body.id });
    };
    const client = new StarknetJsonRpcClient("http://rpc.invalid", {
      fetch: fetchImplementation,
      requestsPerSecond: 1_000,
      maxConcurrency: 2,
    });

    await Promise.all(
      Array.from({ length: 8 }, () => client.request("starknet_chainId")),
    );
    expect(maximumActive).toBe(2);
  });

  it("does not retry invalid JSON-RPC requests", async () => {
    let calls = 0;
    const fetchImplementation: typeof fetch = async () => {
      calls++;
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32602, message: "invalid params" },
      });
    };
    const client = new StarknetJsonRpcClient("http://rpc.invalid", {
      fetch: fetchImplementation,
      requestsPerSecond: 1_000,
    });

    await expect(client.request("starknet_getEvents")).rejects.toThrow(
      "invalid params",
    );
    expect(calls).toBe(1);
  });

  it("cancels requests at the configured timeout", async () => {
    let aborted = false;
    const fetchImplementation: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const client = new StarknetJsonRpcClient("http://rpc.invalid", {
      fetch: fetchImplementation,
      requestTimeoutMs: 5,
      maxAttempts: 1,
      requestsPerSecond: 1_000,
    });

    await expect(client.request("starknet_chainId")).rejects.toThrow(
      "timed out after 5ms",
    );
    expect(aborted).toBe(true);
  });
});
