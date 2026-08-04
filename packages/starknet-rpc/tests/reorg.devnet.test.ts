import type { StreamDataResponse } from "@apibara/protocol";
import { RpcClient } from "@apibara/protocol/rpc";
import type { Filter } from "@apibara/starknet";
import { describe, expect, it } from "vitest";
import type { StarknetRpcBlock } from "../src/block";
import { StarknetRpcStream } from "../src/stream-config";
import { DevnetControl } from "./support/devnet";
import { getDevnetUrl } from "./support/live-endpoints";

/**
 * Reorg / invalidate coverage against a controllable starknet-devnet.
 *
 * A reorg can't be provoked on a public node, so this uses devnet's block
 * abortion: stream some accepted blocks, then abort the head block and remine a
 * divergent one, and assert the stream emits `invalidate` and recovers. Skips
 * unless a devnet URL is configured (see `getDevnetUrl`).
 */

const devnetUrl = getDevnetUrl();
const FINALIZED = 2; // accepted-on-L1 up to here; the reorg happens above it.
const REORG_AT = 5; // last block streamed, then aborted and remined.

describe.skipIf(!devnetUrl)("Starknet RPC reorg (devnet)", () => {
  it("emits invalidate on a block abortion and recovers", async () => {
    const devnet = new DevnetControl(devnetUrl!);
    await devnet.restart();
    for (let i = 0; i < REORG_AT; i++) await devnet.createBlock();
    await devnet.acceptOnL1(FINALIZED);

    const client = new RpcClient<Filter, StarknetRpcBlock>(
      new StarknetRpcStream({
        url: devnetUrl!,
        requestsPerSecond: 50,
        headRefreshIntervalMs: 300,
        finalizedRefreshIntervalMs: 1_000,
      }),
    );

    const controller = new AbortController();
    const stop = setTimeout(() => controller.abort(), 40_000);

    // Once the stream has caught up to the head and is polling, abort the head
    // block and remine a divergent one (a mint tx forces a new hash), then
    // extend past the old head so the tracker re-evaluates.
    let triggered = false;
    const triggerReorg = async () => {
      if (triggered) return;
      triggered = true;
      await new Promise((r) => setTimeout(r, 800)); // let it settle into live
      await devnet.abortBlocks(REORG_AT);
      await devnet.mint("0x1", 1_000_000_000_000_000_000);
      await devnet.createBlock(); // REORG_AT' — divergent (carries the tx)
      await devnet.createBlock(); // advance head past the old tip
    };

    const seen: bigint[] = [];
    let invalidateAt: bigint | undefined;
    let recoveredAfterInvalidate = false;

    try {
      for await (const message of client.streamData(
        {
          finality: "accepted",
          filter: [{ header: "always" }],
          startingCursor: { orderKey: BigInt(FINALIZED) },
        },
        { signal: controller.signal },
      ) as AsyncIterable<StreamDataResponse<StarknetRpcBlock>>) {
        if (message._tag === "data") {
          const orderKey = message.data.endCursor?.orderKey;
          if (orderKey !== undefined) seen.push(orderKey);
          if (invalidateAt !== undefined) {
            recoveredAfterInvalidate = true;
            break;
          }
          if (orderKey !== undefined && orderKey >= BigInt(REORG_AT)) {
            void triggerReorg();
          }
        }
        if (message._tag === "invalidate") {
          invalidateAt = message.invalidate.cursor?.orderKey;
        }
      }
    } finally {
      clearTimeout(stop);
      controller.abort();
    }

    // The reorg was detected…
    expect(invalidateAt).toBeDefined();
    // …rewinding to a safe point at or below the aborted block, never below
    // the finalized block.
    expect(invalidateAt!).toBeGreaterThanOrEqual(BigInt(FINALIZED));
    expect(invalidateAt!).toBeLessThan(BigInt(REORG_AT));
    // …and the stream kept producing on the new branch afterwards.
    expect(recoveredAfterInvalidate).toBe(true);
  }, 60_000);
});
