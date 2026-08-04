import { type Server, createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StarknetJsonRpcClient } from "../src/client";

/**
 * Transport retry policy, driven against a controllable local HTTP server.
 *
 * These paths (429/5xx/timeout retried, other 4xx and client-side JSON-RPC
 * errors not retried) can't be provoked reliably against healthy live nodes,
 * so they run fully hermetically here — no devnet, no network, no secrets.
 */

type ScriptedResponse = {
  status?: number;
  headers?: Record<string, string>;
  /** JSON body to return (defaults to a successful specVersion result). */
  body?: unknown;
  /** Delay before responding, to trip the client's request timeout. */
  delayMs?: number;
};

let server: Server;
let url: string;
let queue: ScriptedResponse[];
let requestCount: number;

beforeEach(async () => {
  queue = [];
  requestCount = 0;
  server = createServer((req, res) => {
    requestCount += 1;
    let requestId = 1;
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        requestId = JSON.parse(raw).id ?? 1;
      } catch {}
      const scripted = queue.shift() ?? { body: { result: "0.10.2" } };
      const send = () => {
        res.writeHead(scripted.status ?? 200, {
          "content-type": "application/json",
          ...scripted.headers,
        });
        const body = scripted.body ?? { result: "0.10.2" };
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            ...(body as object),
          }),
        );
      };
      if (scripted.delayMs) setTimeout(send, scripted.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("failed to bind test server");
  }
  url = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function client() {
  return new StarknetJsonRpcClient(url, {
    requestsPerSecond: 1000,
    maxConcurrency: 8,
    timeout: 150,
    retryCount: 3,
    retryDelay: 10,
  });
}

describe("StarknetJsonRpcClient transport retries", () => {
  it("retries HTTP 429 and then succeeds", async () => {
    queue = [{ status: 429 }, { body: { result: "0.10.2" } }];
    expect(await client().request("starknet_specVersion")).toBe("0.10.2");
    expect(requestCount).toBe(2);
  });

  it("retries HTTP 5xx and then succeeds", async () => {
    queue = [{ status: 503 }, { status: 502 }, { body: { result: "0.10.2" } }];
    expect(await client().request("starknet_specVersion")).toBe("0.10.2");
    expect(requestCount).toBe(3);
  });

  it("honors the Retry-After header on 429", async () => {
    queue = [
      { status: 429, headers: { "retry-after": "0" } },
      { body: { result: "0.10.2" } },
    ];
    expect(await client().request("starknet_specVersion")).toBe("0.10.2");
    expect(requestCount).toBe(2);
  });

  it("retries a request timeout and then succeeds", async () => {
    queue = [{ delayMs: 400 }, { body: { result: "0.10.2" } }];
    expect(await client().request("starknet_specVersion")).toBe("0.10.2");
    expect(requestCount).toBe(2);
  });

  it("retries the -32603 internal JSON-RPC error", async () => {
    queue = [
      { body: { error: { code: -32603, message: "internal" } } },
      { body: { result: "0.10.2" } },
    ];
    expect(await client().request("starknet_specVersion")).toBe("0.10.2");
    expect(requestCount).toBe(2);
  });

  it("does not retry non-429 client errors (HTTP 400)", async () => {
    queue = [{ status: 400 }, { body: { result: "0.10.2" } }];
    await expect(client().request("starknet_specVersion")).rejects.toThrow();
    expect(requestCount).toBe(1);
  });

  it("does not retry client-side JSON-RPC errors (-32602 invalid params)", async () => {
    queue = [{ body: { error: { code: -32602, message: "Invalid params" } } }];
    await expect(client().request("starknet_specVersion")).rejects.toThrow(
      "Invalid params",
    );
    expect(requestCount).toBe(1);
  });

  it("gives up after exhausting the retry budget", async () => {
    queue = Array.from({ length: 6 }, () => ({ status: 503 }));
    await expect(client().request("starknet_specVersion")).rejects.toThrow();
    // initial attempt + retryCount(3)
    expect(requestCount).toBe(4);
  });
});
