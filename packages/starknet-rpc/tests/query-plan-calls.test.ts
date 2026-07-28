import type { Filter } from "@apibara/starknet";
import { describe, expect, it } from "vitest";
import { StarknetJsonRpcClient } from "../src/client";
import type { StarknetRpcCapabilities } from "../src/probe";
import { StarknetRpcStream } from "../src/stream-config";

const baseline: StarknetRpcCapabilities = {
  specVersion: "0.9.0",
  archive: true,
  blockWithReceipts: true,
  stateUpdates: true,
  traces: false,
  webSocketSubscriptions: {
    available: false,
    newHeads: false,
    newTransactions: false,
    transactionReceipts: false,
    events: false,
    reorgs: false,
  },
  multiAddressEvents: false,
  eventIndices: false,
  stateAddressFiltering: false,
  responseFlags: false,
  batch: false,
};

describe("query-plan call counts", () => {
  it("shares event discovery and one receipt block across top-level filters", async () => {
    const calls: string[] = [];
    const stream = configuredStream(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
      };
      calls.push(request.method);
      const result =
        request.method === "starknet_getEvents"
          ? {
              events: [
                {
                  block_number: 5,
                  from_address: "0xabc",
                  keys: ["0x1"],
                  data: [],
                },
              ],
            }
          : receiptBlock(5);
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    });
    const filters: Filter[] = [
      { events: [{ id: 1, address: "0xabc", keys: ["0x1"] }] },
      { events: [{ id: 2, address: "0x0abc", keys: ["0x1"] }] },
    ];

    const result = await stream.fetchBlockRangeMany({
      startBlock: 5n,
      maxBlock: 100n,
      force: false,
      clampAllowed: true,
      filters,
    });

    expect(
      calls.filter((method) => method === "starknet_getEvents"),
    ).toHaveLength(1);
    expect(
      calls.filter((method) => method === "starknet_getBlockWithReceipts"),
    ).toHaveLength(1);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].blocks).toHaveLength(2);
    expect(result.data[0].blocks[0]?.events[0].filterIds).toEqual([1]);
    expect(result.data[0].blocks[1]?.events[0].filterIds).toEqual([2]);
  });

  it("loads headers, not receipt blocks, for non-candidates in a mixed filter set", async () => {
    const calls: string[] = [];
    const stream = configuredStream(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params: [{ block_number?: number }];
      };
      calls.push(request.method);
      const number = request.params[0].block_number ?? 5;
      const result =
        request.method === "starknet_getEvents"
          ? { events: [{ block_number: 5 }] }
          : request.method === "starknet_getBlockWithReceipts"
            ? receiptBlock(number)
            : headerBlock(number);
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    });

    const result = await stream.fetchBlockRangeMany({
      startBlock: 5n,
      maxBlock: 100n,
      force: false,
      clampAllowed: true,
      filters: [
        { events: [{ address: "0xabc", keys: ["0x1"] }] },
        { header: "always" },
      ],
    });

    expect(result.endBlock).toBe(24n);
    expect(
      calls.filter((method) => method === "starknet_getBlockWithReceipts"),
    ).toHaveLength(1);
    expect(
      calls.filter((method) => method === "starknet_getBlockWithTxHashes"),
    ).toHaveLength(19);
    expect(result.data).toHaveLength(20);
    expect(result.data[1].blocks).toEqual([
      null,
      expect.objectContaining({ transactions: [] }),
    ]);
  });

  it("scans state filters in a bounded 20-block window", async () => {
    const calls: string[] = [];
    const stream = configuredStream(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params: [{ block_number: number }];
      };
      calls.push(request.method);
      const number = request.params[0].block_number;
      const result =
        request.method === "starknet_getStateUpdate"
          ? {
              state_diff: {
                storage_diffs: [
                  {
                    address: "0xabc",
                    storage_entries: [{ key: "0x1", value: "0x2" }],
                  },
                ],
              },
            }
          : headerBlock(number);
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    });

    const result = await stream.fetchBlockRangeMany({
      startBlock: 5n,
      maxBlock: 100n,
      force: false,
      clampAllowed: true,
      filters: [
        { storageDiffs: [{ id: 1, contractAddress: "0xabc" }] },
        { nonceUpdates: [{ id: 2, contractAddress: "0xdef" }] },
      ],
    });

    expect(result.endBlock).toBe(24n);
    expect(
      calls.filter((method) => method === "starknet_getBlockWithTxHashes"),
    ).toHaveLength(20);
    expect(
      calls.filter((method) => method === "starknet_getStateUpdate"),
    ).toHaveLength(20);
    expect(result.data).toHaveLength(20);
    expect(result.data[0].blocks).toHaveLength(2);
  });
});

function configuredStream(
  fetchImplementation: typeof fetch,
): StarknetRpcStream {
  const stream = new StarknetRpcStream({
    url: "http://rpc.invalid",
    requestsPerSecond: 10_000,
    maxConcurrency: 8,
  });
  const client = new StarknetJsonRpcClient("http://rpc.invalid", {
    fetch: fetchImplementation,
    requestsPerSecond: 10_000,
    maxConcurrency: 8,
    maxAttempts: 1,
  });
  Object.assign(stream, { client, capabilities: baseline });
  return stream;
}

function headerBlock(number: number) {
  return {
    block_hash: `0x${(number + 1_000).toString(16)}`,
    parent_hash: `0x${(number + 999).toString(16)}`,
    block_number: number,
    timestamp: 1_700_000_000 + number,
    sequencer_address: "0x1",
    starknet_version: "0.13.6",
    transactions: [],
  };
}

function receiptBlock(number: number) {
  return {
    ...headerBlock(number),
    transactions: [
      {
        transaction: {
          type: "INVOKE",
          version: "0x1",
          transaction_hash: "0xaa",
          sender_address: "0x1",
          calldata: [],
          max_fee: "0x0",
          signature: [],
          nonce: "0x0",
        },
        receipt: {
          transaction_hash: "0xaa",
          execution_status: "SUCCEEDED",
          events: [{ from_address: "0xabc", keys: ["0x1"], data: [] }],
          messages_sent: [],
        },
      },
    ],
  };
}
