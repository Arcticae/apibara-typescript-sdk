import { describe, expect, it } from "vitest";
import type { Bytes } from "../src/common";
import { createChainTracker } from "../src/rpc/chain-tracker";
import type { BlockInfo } from "../src/rpc/config";

describe("RPC ChainTracker", () => {
  it("recovers a longer chain that reorgs back to the finalized block", async () => {
    const genesis = block(0n, "a", "0x0");
    const old = [
      genesis,
      block(1n, "a", genesis.blockHash),
      block(2n, "a", hash(1n, "a")),
    ];
    const replacement = [
      genesis,
      block(1n, "b", genesis.blockHash),
      block(2n, "b", hash(1n, "b")),
      block(3n, "b", hash(2n, "b")),
    ];
    const tracker = createChainTracker({
      finalized: genesis,
      head: genesis,
      batchSize: 20n,
    });
    const fetchOldRange = async ({
      startBlockNumber,
      endBlockNumber,
    }: {
      startBlockNumber: bigint;
      endBlockNumber: bigint;
    }) =>
      old.filter(
        (item) =>
          item.blockNumber >= startBlockNumber &&
          item.blockNumber <= endBlockNumber,
      );
    await tracker.updateHead({
      newHead: old[2],
      fetchCursorByHash: async () => null,
      fetchCursorRange: fetchOldRange,
    });

    const byHash = new Map(replacement.map((item) => [item.blockHash, item]));
    const reorg = await tracker.updateHead({
      newHead: replacement[3],
      fetchCursorByHash: async (blockHash) => byHash.get(blockHash) ?? null,
      fetchCursorRange: async () => [replacement[3]],
    });
    expect(reorg).toEqual({
      status: "reorg",
      cursor: { orderKey: 0n, uniqueKey: genesis.blockHash },
    });
    expect(tracker.head()).toEqual({
      orderKey: 0n,
      uniqueKey: genesis.blockHash,
    });

    const advanced = await tracker.updateHead({
      newHead: replacement[3],
      fetchCursorByHash: async (blockHash) => byHash.get(blockHash) ?? null,
      fetchCursorRange: async ({ startBlockNumber, endBlockNumber }) =>
        replacement.filter(
          (item) =>
            item.blockNumber >= startBlockNumber &&
            item.blockNumber <= endBlockNumber,
        ),
    });
    expect(advanced).toEqual({ status: "success" });
    expect(tracker.head()).toEqual({
      orderKey: 3n,
      uniqueKey: replacement[3].blockHash,
    });
  });
});

function block(
  blockNumber: bigint,
  fork: string,
  parentBlockHash: Bytes,
): BlockInfo {
  return { blockNumber, blockHash: hash(blockNumber, fork), parentBlockHash };
}

function hash(blockNumber: bigint, fork: string): Bytes {
  const forkValue = BigInt(fork.charCodeAt(0));
  return `0x${(blockNumber * 256n + forkValue).toString(16).padStart(64, "0")}`;
}
