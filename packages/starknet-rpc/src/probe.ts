import { StarknetJsonRpcClient } from "./client";
import { StarknetRpcError } from "./errors";
import type { RpcBlock, RpcObject } from "./rpc-types";

export type StarknetRpcWebSocketCapabilities = {
  available: boolean;
  newHeads: boolean;
  newTransactions: boolean;
  transactionReceipts: boolean;
  events: boolean;
  reorgs: boolean;
};

export type StarknetRpcCapabilities = {
  specVersion: string;
  nodeImplementation?: string;
  nodeVersion?: string;
  archive: boolean;
  blockWithReceipts: boolean;
  stateUpdates: boolean;
  traces: boolean;
  webSocketSubscriptions: StarknetRpcWebSocketCapabilities;
  multiAddressEvents: boolean;
  eventIndices: boolean;
  stateAddressFiltering: boolean;
  responseFlags: boolean;
  batch: boolean;
};

/**
 * Detect actual endpoint capabilities. The returned values are based on RPC
 * calls, never on a version embedded in the endpoint URL.
 */
export async function probeStarknetRpc(
  url: string,
  wsUrl?: string,
): Promise<StarknetRpcCapabilities> {
  const client = new StarknetJsonRpcClient(url, {
    requestsPerSecond: 10,
    maxConcurrency: 4,
    maxAttempts: 3,
  });
  const specVersion = await client.request<string>("starknet_specVersion");
  const version = parseSpecVersion(specVersion);
  const enhanced =
    version.major === 0 && version.minor === 10 && version.patch === 2;

  const node = await probeNodeVersion(client);
  const [
    archive,
    blockWithReceipts,
    stateUpdates,
    traces,
    enhancedFeatures,
    batch,
  ] = await Promise.all([
    probeArchive(client),
    succeeds(() =>
      client.request("starknet_getBlockWithReceipts", [
        { block_tag: "latest" },
      ]),
    ),
    succeeds(() =>
      client.request("starknet_getStateUpdate", [{ block_tag: "latest" }]),
    ),
    probeTraces(client),
    enhanced
      ? probeEnhancedFeatures(client)
      : Promise.resolve({
          multiAddressEvents: false,
          stateAddressFiltering: false,
          responseFlags: false,
        }),
    probeBatch(url),
  ]);

  return {
    specVersion,
    ...node,
    archive,
    blockWithReceipts,
    stateUpdates,
    traces,
    webSocketSubscriptions: wsUrl
      ? await probeWebSocket(wsUrl)
      : emptyWebSocketCapabilities(),
    multiAddressEvents: enhancedFeatures.multiAddressEvents,
    eventIndices: enhanced,
    stateAddressFiltering: enhancedFeatures.stateAddressFiltering,
    responseFlags: enhancedFeatures.responseFlags,
    batch,
  };
}

export function parseSpecVersion(version: string): {
  major: number;
  minor: number;
  patch: number;
} {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (!match) {
    throw new Error(`Invalid starknet_specVersion response: ${version}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
  };
}

async function probeNodeVersion(client: StarknetJsonRpcClient): Promise<{
  nodeImplementation?: string;
  nodeVersion?: string;
}> {
  const methods = [
    ["pathfinder_version", "Pathfinder"],
    ["juno_version", "Juno"],
    ["starknet_nodeVersion", undefined],
  ] as const;
  for (const [method, implementation] of methods) {
    try {
      const result = await client.request<unknown>(method);
      if (typeof result === "string") {
        return {
          nodeImplementation: implementation,
          nodeVersion: result,
        };
      }
      if (isObject(result)) {
        return {
          nodeImplementation:
            implementation ??
            stringProperty(result, "implementation") ??
            stringProperty(result, "name"),
          nodeVersion:
            stringProperty(result, "version") ?? JSON.stringify(result),
        };
      }
    } catch (error) {
      if (!isMethodUnavailable(error)) throw error;
    }
  }
  return {};
}

async function probeArchive(client: StarknetJsonRpcClient): Promise<boolean> {
  try {
    await client.request("starknet_getBlockWithTxHashes", [
      { block_number: 0 },
    ]);
    return true;
  } catch {
    return false;
  }
}

async function probeTraces(client: StarknetJsonRpcClient): Promise<boolean> {
  try {
    await client.request("starknet_traceBlockTransactions", [
      { block_tag: "latest" },
    ]);
    return true;
  } catch {
    return false;
  }
}

async function probeEnhancedFeatures(client: StarknetJsonRpcClient): Promise<{
  multiAddressEvents: boolean;
  stateAddressFiltering: boolean;
  responseFlags: boolean;
}> {
  const latest = { block_tag: "latest" };
  const impossibleAddresses = ["0x0", "0x1"];
  const multiAddressEvents = await succeeds(() =>
    client.request("starknet_getEvents", [
      {
        from_block: latest,
        to_block: latest,
        address: impossibleAddresses,
        chunk_size: 1,
      },
    ]),
  );
  const stateAddressFiltering = await succeeds(() =>
    client.request("starknet_getStateUpdate", [
      latest,
      { contract_addresses: impossibleAddresses },
    ]),
  );
  const responseFlags = await succeeds(() =>
    client.request<RpcBlock>("starknet_getBlockWithReceipts", [
      latest,
      {
        include_block_header: true,
        include_transactions: false,
        include_receipts: false,
      },
    ]),
  );
  return { multiAddressEvents, stateAddressFiltering, responseFlags };
}

async function probeBatch(url: string): Promise<boolean> {
  try {
    const client = new StarknetJsonRpcClient(url, {
      batch: true,
      maxAttempts: 3,
    });
    const result = await client.batch<[string, string]>([
      { method: "starknet_specVersion" },
      { method: "starknet_chainId" },
    ]);
    return (
      result.length === 2 && result.every((item) => typeof item === "string")
    );
  } catch {
    return false;
  }
}

async function probeWebSocket(
  wsUrl: string,
): Promise<StarknetRpcWebSocketCapabilities> {
  if (!URL.canParse(wsUrl) || typeof WebSocket === "undefined") {
    return emptyWebSocketCapabilities();
  }
  const methods = {
    newHeads: "starknet_subscribeNewHeads",
    newTransactions: "starknet_subscribeNewTransactions",
    transactionReceipts: "starknet_subscribeTransactionStatus",
    events: "starknet_subscribeEvents",
    reorgs: "starknet_subscribeNewHeads",
  } as const;
  const result = emptyWebSocketCapabilities();
  try {
    const socket = new WebSocket(wsUrl);
    await waitForSocketOpen(socket, 3_000);
    result.available = true;
    let id = 1;
    await Promise.all(
      (
        Object.entries(methods) as [
          keyof Omit<StarknetRpcWebSocketCapabilities, "available">,
          string,
        ][]
      ).map(async ([capability, method]) => {
        try {
          const response = await sendWebSocketRequest(socket, id++, method);
          result[capability] = !response.error;
        } catch {
          result[capability] = false;
        }
      }),
    );
    socket.close();
  } catch {
    return emptyWebSocketCapabilities();
  }
  return result;
}

function waitForSocketOpen(
  socket: WebSocket,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("WebSocket timeout")),
      timeoutMs,
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket connection failed"));
      },
      { once: true },
    );
  });
}

function sendWebSocketRequest(
  socket: WebSocket,
  id: number,
  method: string,
): Promise<{ error?: unknown }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("WebSocket request timeout")),
      2_000,
    );
    const listener = (event: MessageEvent) => {
      try {
        const value = JSON.parse(String(event.data)) as {
          id?: number;
          error?: unknown;
        };
        if (value.id !== id) return;
        clearTimeout(timeout);
        socket.removeEventListener("message", listener);
        resolve(value);
      } catch {
        // Ignore subscription notifications and malformed provider messages.
      }
    };
    socket.addEventListener("message", listener);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }));
  });
}

function emptyWebSocketCapabilities(): StarknetRpcWebSocketCapabilities {
  return {
    available: false,
    newHeads: false,
    newTransactions: false,
    transactionReceipts: false,
    events: false,
    reorgs: false,
  };
}

function isMethodUnavailable(error: unknown): boolean {
  return (
    error instanceof StarknetRpcError &&
    (error.code === -32601 || error.message.toLowerCase().includes("method"))
  );
}

async function succeeds(call: () => Promise<unknown>): Promise<boolean> {
  try {
    await call();
    return true;
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is RpcObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringProperty(
  object: RpcObject,
  property: string,
): string | undefined {
  const value = object[property];
  return typeof value === "string" ? value : undefined;
}
