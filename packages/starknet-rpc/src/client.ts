import { metrics } from "@opentelemetry/api";
import { StarknetRpcError } from "./errors";
import type { JsonRpcResponse } from "./rpc-types";

export type StarknetRpcClientOptions = {
  requestsPerSecond?: number;
  maxConcurrency?: number;
  requestTimeoutMs?: number;
  maxAttempts?: number;
  batch?: boolean;
  fetch?: typeof globalThis.fetch;
};

const meter = metrics.getMeter("@apibara/starknet-rpc");
const callCounter = meter.createCounter("apibara.starknet_rpc.calls");
const byteCounter = meter.createCounter("apibara.starknet_rpc.bytes");
const retryCounter = meter.createCounter("apibara.starknet_rpc.retries");
const throttleCounter = meter.createCounter("apibara.starknet_rpc.throttling");
const latency = meter.createHistogram("apibara.starknet_rpc.latency", {
  unit: "ms",
});

export class StarknetJsonRpcClient {
  readonly batchEnabled: boolean;
  private readonly limiter: TokenBucket;
  private readonly semaphore: Semaphore;
  private readonly requestTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private nextId = 1;

  constructor(
    readonly url: string,
    options: StarknetRpcClientOptions = {},
  ) {
    if (!URL.canParse(url)) {
      throw new Error("Invalid Starknet RPC URL");
    }
    const requestsPerSecond = options.requestsPerSecond ?? 10;
    const maxConcurrency = options.maxConcurrency ?? 8;
    if (requestsPerSecond <= 0 || maxConcurrency <= 0) {
      throw new Error(
        "requestsPerSecond and maxConcurrency must be greater than zero",
      );
    }
    this.limiter = new TokenBucket(requestsPerSecond);
    this.semaphore = new Semaphore(maxConcurrency);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.batchEnabled = options.batch ?? false;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  async request<T>(
    method: string,
    params: readonly unknown[] | Record<string, unknown> = [],
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await this.requestOnce<T>(method, params, timeoutMs);
      } catch (error) {
        attempt++;
        if (attempt >= this.maxAttempts || !isRetryable(error)) {
          throw error;
        }
        retryCounter.add(1, { method });
        const retryAfter =
          error instanceof StarknetRpcError ? error.retryAfterMs : undefined;
        const exponential = Math.min(5_000, 100 * 2 ** (attempt - 1));
        const delay = retryAfter ?? exponential * (0.5 + Math.random());
        await sleep(delay);
      }
    }
  }

  async batch<T extends readonly unknown[]>(
    calls: {
      method: string;
      params?: readonly unknown[] | Record<string, unknown>;
    }[],
  ): Promise<T> {
    if (!this.batchEnabled) {
      throw new Error(
        "JSON-RPC batching is disabled. Enable it only after a successful capability probe.",
      );
    }
    if (calls.length === 0) return [] as unknown as T;

    let attempt = 0;
    while (true) {
      try {
        return await this.executeBatch<T>(calls);
      } catch (error) {
        attempt++;
        if (attempt >= this.maxAttempts || !isRetryable(error)) throw error;
        retryCounter.add(1, { method: "batch" });
        const retryAfter =
          error instanceof StarknetRpcError ? error.retryAfterMs : undefined;
        const exponential = Math.min(5_000, 100 * 2 ** (attempt - 1));
        await sleep(retryAfter ?? exponential * (0.5 + Math.random()));
      }
    }
  }

  private async executeBatch<T extends readonly unknown[]>(
    calls: {
      method: string;
      params?: readonly unknown[] | Record<string, unknown>;
    }[],
  ): Promise<T> {
    const ids = calls.map(() => this.nextId++);
    const body = calls.map((call, index) => ({
      jsonrpc: "2.0",
      id: ids[index],
      method: call.method,
      params: call.params ?? [],
    }));
    const responses = await this.fetchJson<JsonRpcResponse<unknown>[]>(
      body,
      "batch",
    );
    const byId = new Map(responses.map((response) => [response.id, response]));
    return calls.map((call, index) => {
      const response = byId.get(ids[index]);
      if (!response) {
        throw new StarknetRpcError(
          `Missing JSON-RPC batch response for ${call.method}`,
        );
      }
      if (response.error) {
        throw new StarknetRpcError(
          `${call.method}: ${response.error.message}`,
          response.error.code,
        );
      }
      return response.result;
    }) as unknown as T;
  }

  private async requestOnce<T>(
    method: string,
    params: readonly unknown[] | Record<string, unknown>,
    timeoutMs: number,
  ): Promise<T> {
    const response = await this.fetchJson<JsonRpcResponse<T>>(
      {
        jsonrpc: "2.0",
        id: this.nextId++,
        method,
        params,
      },
      method,
      timeoutMs,
    );
    if (response.error) {
      throw new StarknetRpcError(
        `${method}: ${response.error.message}`,
        response.error.code,
      );
    }
    if (!("result" in response)) {
      throw new StarknetRpcError(`${method}: response has no result`);
    }
    return response.result as T;
  }

  private async fetchJson<T>(
    body: unknown,
    method: string,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    if (!(await this.limiter.acquire())) {
      throttleCounter.add(1, { reason: "rate" });
    }
    const release = await this.semaphore.acquire();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = performance.now();
    const encodedBody = JSON.stringify(body);
    callCounter.add(1, { method });
    byteCounter.add(new TextEncoder().encode(encodedBody).byteLength, {
      direction: "request",
      method,
    });

    try {
      const response = await this.fetchImplementation(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: encodedBody,
        signal: controller.signal,
      });
      const text = await response.text();
      byteCounter.add(new TextEncoder().encode(text).byteLength, {
        direction: "response",
        method,
      });
      if (!response.ok) {
        throw new StarknetRpcError(
          `Starknet RPC HTTP ${response.status}`,
          undefined,
          response.status,
          parseRetryAfter(response.headers.get("retry-after")),
        );
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new StarknetRpcError("Starknet RPC returned invalid JSON");
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new StarknetRpcError(
          `Starknet RPC request timed out after ${timeoutMs}ms`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      release();
      latency.record(performance.now() - startedAt, { method });
    }
  }
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof StarknetRpcError)) {
    return error instanceof TypeError;
  }
  if (
    error.status === 429 ||
    (error.status !== undefined && error.status >= 500)
  ) {
    return true;
  }
  // Internal error, server error, rate limit, and common provider timeout codes.
  if (error.code === -32603 || error.code === -32005 || error.code === -32010) {
    return true;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("timed out") ||
    (error.code === -32000 &&
      ["timeout", "busy", "temporarily", "rate limit"].some((pattern) =>
        message.includes(pattern),
      ))
  );
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

class TokenBucket {
  private tokens: number;
  private lastRefill = performance.now();

  constructor(private readonly rate: number) {
    this.tokens = rate;
  }

  async acquire(): Promise<boolean> {
    let waited = false;
    while (true) {
      const now = performance.now();
      const elapsed = (now - this.lastRefill) / 1_000;
      this.tokens = Math.min(this.rate, this.tokens + elapsed * this.rate);
      this.lastRefill = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return !waited;
      }
      waited = true;
      await sleep(Math.max(1, ((1 - this.tokens) / this.rate) * 1_000));
    }
  }
}

class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly maximum: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.maximum) {
      throttleCounter.add(1, { reason: "concurrency" });
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiting.shift()?.();
    };
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
