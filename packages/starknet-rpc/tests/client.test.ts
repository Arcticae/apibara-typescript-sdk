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
      retryDelay: 0,
    });

    await expect(client.request("starknet_specVersion")).resolves.toBe("0.9.0");
    expect(calls).toBe(3);
  });

  it("shares retry behavior with batch requests", async () => {
    let calls = 0;
    const fetchImplementation: typeof fetch = async (_input, init) => {
      calls++;
      if (calls === 1) return new Response("temporary", { status: 503 });
      const requests = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
      }[];
      return Response.json(
        requests.map((request) => ({
          jsonrpc: "2.0",
          id: request.id,
          result:
            request.method === "starknet_specVersion" ? "0.10.2" : "SN_MAIN",
        })),
      );
    };
    const client = new StarknetJsonRpcClient("http://rpc.invalid", {
      batch: true,
      fetch: fetchImplementation,
      requestsPerSecond: 1_000,
      retryCount: 1,
      retryDelay: 0,
    });

    await expect(
      client.batch<[string, string]>([
        { method: "starknet_specVersion" },
        { method: "starknet_chainId" },
      ]),
    ).resolves.toEqual(["0.10.2", "SN_MAIN"]);
    expect(calls).toBe(2);
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
      timeout: 5,
      retryCount: 0,
      requestsPerSecond: 1_000,
    });

    await expect(client.request("starknet_chainId")).rejects.toThrow(
      "timed out after 5ms",
    );
    expect(aborted).toBe(true);
  });
});
