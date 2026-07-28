import type { StreamDataOptions } from "@apibara/protocol";
import type { StreamDataRequest, StreamDataResponse } from "@apibara/protocol";
import { RpcClient } from "@apibara/protocol/rpc";
import type { Filter } from "@apibara/starknet";
import { describe, expect, it } from "vitest";
import type { StarknetRpcBlock } from "../src/block";
import { StarknetEndpointCapabilities } from "../src/endpoint-capabilities";
import {
  StarknetRpcStream,
  type StarknetRpcStreamOptions,
} from "../src/stream-config";
import {
  type LiveEndpointName,
  getLiveEndpoint,
} from "./support/live-endpoints";

/**
 * End-to-end streaming tests against live public Starknet RPC endpoints.
 *
 * These exercise the real HTTP transport, capability probing, cursor
 * resolution, event discovery, receipt/state/trace fetching, and the
 * `RpcDataStream` reorg-aware backfill loop — none of which the mock-based
 * unit tests can validate. Endpoints are resolved out-of-band (see
 * `support/live-endpoints`); when unset the whole suite is skipped.
 */

const FELT = /^0x[0-9a-f]{1,64}$/;
const BLOCK_HASH = /^0x[0-9a-f]{64}$/;

// Conservative client settings so the shared public nodes are not hammered.
const BASE_OPTIONS = {
  requestsPerSecond: 6,
  maxConcurrency: 4,
  timeout: 20_000,
  retryCount: 3,
} satisfies Partial<StarknetRpcStreamOptions>;

type EndpointCase = {
  name: LiveEndpointName;
  label: string;
  enhanced: boolean;
};

const CASES: EndpointCase[] = [
  { name: "testnet", label: "testnet v0.9", enhanced: false },
  { name: "integration", label: "integration v0.10", enhanced: true },
];

function createClient(url: string, extra?: Partial<StarknetRpcStreamOptions>) {
  const config = new StarknetRpcStream({ url, ...BASE_OPTIONS, ...extra });
  return new RpcClient<Filter, StarknetRpcBlock>(config);
}

type Response = StreamDataResponse<StarknetRpcBlock>;
type DataResponse = Extract<Response, { _tag: "data" }>;

/**
 * Streams a bounded, backfilling range for one filter and returns the `data`
 * messages up to and including block `end`.
 *
 * `endingCursor` only stops the loop once the cursor has *passed* it (a whole
 * fetch window can be emitted first, and the live phase runs to head), so the
 * range is bounded precisely by breaking on the first message reaching `end` —
 * exactly what a real consumer does.
 */
async function streamRange(
  url: string,
  filter: Filter,
  start: bigint,
  end: bigint,
  extra?: Partial<StarknetRpcStreamOptions>,
): Promise<DataResponse[]> {
  const client = createClient(url, extra);
  const request: StreamDataRequest<Filter> = {
    finality: "accepted",
    filter: [filter],
    startingCursor: { orderKey: start },
  };
  const options: StreamDataOptions = { endingCursor: { orderKey: end } };

  const data: DataResponse[] = [];
  let total = 0;
  for await (const message of client.streamData(request, options)) {
    if (++total > 2_000) throw new Error("stream did not reach end in budget");
    if (message._tag !== "data") continue;
    data.push(message);
    if ((message.data.endCursor?.orderKey ?? -1n) >= end) break;
  }
  return data;
}

/** Like {@link streamRange} but streams several filters at once. */
async function streamRangeMany(
  url: string,
  filters: Filter[],
  start: bigint,
  end: bigint,
  extra?: Partial<StarknetRpcStreamOptions>,
): Promise<DataResponse[]> {
  const client = createClient(url, extra);
  const request: StreamDataRequest<Filter> = {
    finality: "accepted",
    filter: filters,
    startingCursor: { orderKey: start },
  };
  const options: StreamDataOptions = { endingCursor: { orderKey: end } };

  const data: DataResponse[] = [];
  let total = 0;
  for await (const message of client.streamData(request, options)) {
    if (++total > 2_000) throw new Error("stream did not reach end in budget");
    if (message._tag !== "data") continue;
    data.push(message);
    if ((message.data.endCursor?.orderKey ?? -1n) >= end) break;
  }
  return data;
}

/**
 * Opens a raw `starknet_subscribeNewHeads` subscription and resolves with the
 * first head's block number, then closes the socket. Validates the node-side
 * WebSocket subscription that {@link StarknetRpcStream} relies on for head
 * signalling and pending finality.
 */
function firstNewHead(wsUrl: string, timeoutMs = 20_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const settle = (fn: () => void) => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      fn();
    };
    const timer = setTimeout(
      () => settle(() => reject(new Error("no newHeads notification in time"))),
      timeoutMs,
    );
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "starknet_subscribeNewHeads",
          params: [],
        }),
      );
    };
    socket.onmessage = (event) => {
      let message: {
        params?: { result?: { block_number?: number } };
      };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const blockNumber = message.params?.result?.block_number;
      if (typeof blockNumber === "number") {
        settle(() => resolve(blockNumber));
      }
    };
    socket.onerror = () =>
      settle(() => reject(new Error("WebSocket upgrade/connection failed")));
  });
}

/** Reaches into the private WS signal to close it after a test (no leak). */
function closeStreamSocket(stream: StarknetRpcStream): void {
  (
    stream as unknown as { websocketSignal?: { close(): void } }
  ).websocketSignal?.close();
}

for (const { name, label, enhanced } of CASES) {
  const endpoint = getLiveEndpoint(name);

  describe.skipIf(!endpoint)(`Starknet RPC live stream — ${label}`, () => {
    const url = endpoint!.httpUrl;
    const wsUrl = endpoint!.wsUrl;

    async function head(): Promise<bigint> {
      const status = await createClient(url).status();
      const orderKey = status.currentHead?.orderKey;
      if (orderKey === undefined) throw new Error("no head cursor");
      return orderKey;
    }

    it("reports a consistent head/finalized status", async () => {
      const status = await createClient(url).status();
      expect(status.currentHead?.orderKey).toBeGreaterThan(0n);
      expect(status.finalized?.orderKey).toBeGreaterThan(0n);
      // Finalized never runs ahead of the accepted head.
      expect(status.finalized!.orderKey).toBeLessThanOrEqual(
        status.currentHead!.orderKey,
      );
      expect(status.starting?.orderKey).toBe(0n);
    }, 30_000);

    it("backfills headers with contiguous, hash-linked cursors", async () => {
      const tip = await head();
      const start = tip - 8n;
      const end = tip - 3n; // stay away from the reorg-prone tip
      const data = await streamRange(url, { header: "always" }, start, end);

      expect(data.length).toBeGreaterThanOrEqual(3);

      let previousEnd: { orderKey: bigint; uniqueKey?: string } | undefined;
      let expectedNumber = start + 1n;
      for (const message of data) {
        const { cursor, endCursor, finality, data: blocks } = message.data;
        const block = blocks[0];
        expect(block).not.toBeNull();
        expect(finality).toBe("accepted");

        // Cursor arithmetic: one block per message, strictly ascending.
        expect(endCursor?.orderKey).toBe(expectedNumber);
        expect(endCursor?.uniqueKey).toMatch(BLOCK_HASH);

        // Header agrees with the cursor the stream emitted.
        expect(block!.header.blockNumber).toBe(endCursor?.orderKey);
        expect(block!.header.blockHash).toBe(endCursor?.uniqueKey);

        // Parent linkage: each block chains onto the previous endCursor.
        expect(cursor?.orderKey).toBe(expectedNumber - 1n);
        expect(block!.header.parentBlockHash).toMatch(BLOCK_HASH);
        if (previousEnd) {
          expect(cursor?.uniqueKey).toBe(previousEnd.uniqueKey);
          expect(block!.header.parentBlockHash).toBe(previousEnd.uniqueKey);
        }

        previousEnd = endCursor;
        expectedNumber += 1n;
      }
      expect(previousEnd?.orderKey).toBe(end);
    }, 60_000);

    it("streams events with well-formed structure", async () => {
      const tip = await head();
      const data = await streamRange(
        url,
        { header: "on_data", events: [{}] },
        tip - 40n,
        tip - 3n,
      );

      const matched = data.filter(
        (m) => (m.data.data[0]?.events.length ?? 0) > 0,
      );
      expect(matched.length).toBeGreaterThan(0);

      for (const message of matched) {
        const block = message.data.data[0]!;
        // Every returned block must actually carry the events it matched on.
        expect(block.events.length).toBeGreaterThan(0);
        for (const event of block.events) {
          expect(event.address).toMatch(FELT);
          expect(event.transactionHash).toMatch(FELT);
          expect(Array.isArray(event.keys)).toBe(true);
          expect(typeof event.eventIndex).toBe("number");
          expect(event.eventIndex).toBeGreaterThanOrEqual(0);
        }
      }
    }, 60_000);

    it("aligns multi-filter results positionally", async () => {
      const tip = await head();
      // filter[0] always emits a header-only block; filter[1] only emits when
      // the block has events. The projections must stay independent per filter.
      const filters: Filter[] = [
        { header: "always" },
        { header: "on_data", events: [{}] },
      ];
      const data = await streamRangeMany(url, filters, tip - 20n, tip - 3n);
      expect(data.length).toBeGreaterThanOrEqual(3);

      let matchedSecond = 0;
      for (const message of data) {
        const blocks = message.data.data;
        expect(blocks).toHaveLength(2);

        // filter[0] (header:always) is present on every block…
        expect(blocks[0]).not.toBeNull();
        // …and, being header-only, never carries events.
        expect(blocks[0]!.events).toHaveLength(0);

        // filter[1] is null on empty blocks, populated when events matched.
        if (blocks[1] !== null) {
          expect(blocks[1].events.length).toBeGreaterThan(0);
          expect(blocks[1].header.blockNumber).toBe(
            blocks[0]!.header.blockNumber,
          );
          matchedSecond += 1;
        }
      }
      expect(matchedSecond).toBeGreaterThan(0);
    }, 60_000);

    it.runIf(enhanced)(
      "filters events by contract address",
      async () => {
        const tip = await head();
        const start = tip - 40n;
        const end = tip - 3n;

        // Discover a contract that actually emits in this range…
        const wildcard = await streamRange(
          url,
          { header: "on_data", events: [{}] },
          start,
          end,
        );
        const sample = wildcard
          .flatMap((m) => m.data.data[0]?.events ?? [])
          .find((e) => e.address);
        expect(sample).toBeDefined();
        const address = sample!.address;

        // …then re-stream filtered by it and confirm every event matches.
        const filtered = await streamRange(
          url,
          { header: "on_data", events: [{ address }] },
          start,
          end,
        );
        const events = filtered.flatMap((m) => m.data.data[0]?.events ?? []);
        expect(events.length).toBeGreaterThan(0);
        for (const event of events) {
          expect(BigInt(event.address)).toBe(BigInt(address));
        }
      },
      90_000,
    );

    it.runIf(enhanced)(
      "streams state updates (storage diffs)",
      async () => {
        const tip = await head();
        const data = await streamRange(
          url,
          { header: "always", storageDiffs: [{}] },
          tip - 6n,
          tip - 2n,
        );
        const withDiffs = data.filter(
          (m) => (m.data.data[0]?.storageDiffs.length ?? 0) > 0,
        );
        expect(withDiffs.length).toBeGreaterThan(0);
        for (const message of withDiffs) {
          for (const diff of message.data.data[0]!.storageDiffs) {
            expect(diff.contractAddress).toMatch(FELT);
          }
        }
      },
      60_000,
    );

    it.runIf(enhanced)(
      "attaches transaction traces when requested",
      async () => {
        const tip = await head();
        const data = await streamRange(
          url,
          {
            header: "on_data",
            events: [
              { includeTransaction: true, includeTransactionTrace: true },
            ],
          },
          tip - 6n,
          tip - 2n,
        );
        const traced = data.filter(
          (m) => (m.data.data[0]?.traces.length ?? 0) > 0,
        );
        expect(traced.length).toBeGreaterThan(0);
        for (const message of traced) {
          const block = message.data.data[0]!;
          // Traces line up with the transactions that produced the events.
          const txHashes = new Set(
            block.transactions.map((tx) => BigInt(tx.meta.transactionHash)),
          );
          for (const trace of block.traces) {
            expect(trace.transactionHash).toMatch(FELT);
            expect(trace.traceRoot).toBeDefined();
            expect(txHashes.has(BigInt(trace.transactionHash))).toBe(true);
          }
        }
      },
      90_000,
    );

    it.runIf(enhanced)(
      "produces identical cursors with JSON-RPC batching enabled",
      async () => {
        const tip = await head();
        const start = tip - 8n;
        const end = tip - 3n;
        const filter: Filter = { header: "always" };

        const [plain, batched] = await Promise.all([
          streamRange(url, filter, start, end),
          streamRange(url, filter, start, end, { batch: true }),
        ]);

        const cursors = (data: typeof plain) =>
          data.map((m) => ({
            orderKey: m.data.endCursor?.orderKey,
            uniqueKey: m.data.endCursor?.uniqueKey,
          }));
        expect(cursors(batched)).toEqual(cursors(plain));
      },
      60_000,
    );

    // Requires a WebSocket endpoint (wsUrl). Skips when one isn't configured.
    describe.skipIf(!wsUrl)("WebSocket transport", () => {
      it("advertises the webSocket capability once a wsUrl is given", async () => {
        const deployment = await StarknetEndpointCapabilities.probe(
          url,
          wsUrl,
          { timeout: 20_000 },
        );
        expect(deployment.webSocket).toBe(true);
      }, 30_000);

      it("delivers newHeads subscription notifications", async () => {
        const tip = await head();
        const blockNumber = await firstNewHead(wsUrl!);
        expect(blockNumber).toBeGreaterThan(0);
        // A live head, not a stale replay: at or just behind the current tip.
        expect(blockNumber).toBeGreaterThanOrEqual(Number(tip) - 2);
      }, 30_000);

      it.runIf(enhanced)(
        "streams pending finality over the WebSocket signal",
        async () => {
          const tip = await head();
          const stream = new StarknetRpcStream({ url, wsUrl, ...BASE_OPTIONS });
          const client = new RpcClient<Filter, StarknetRpcBlock>(stream);
          const controller = new AbortController();
          const stop = setTimeout(() => controller.abort(), 45_000);

          let pendingSeen = false;
          try {
            const request: StreamDataRequest<Filter> = {
              finality: "pending",
              filter: [{ header: "always" }],
              startingCursor: { orderKey: tip - 2n },
            };
            for await (const message of client.streamData(request, {
              signal: controller.signal,
            })) {
              if (
                message._tag === "data" &&
                message.data.finality === "pending"
              ) {
                // Pending cursors are ephemeral: an orderKey with no block hash.
                expect(message.data.endCursor?.uniqueKey).toBeUndefined();
                pendingSeen = true;
                break;
              }
            }
          } finally {
            clearTimeout(stop);
            controller.abort();
            closeStreamSocket(stream);
          }
          expect(pendingSeen).toBe(true);
        },
        60_000,
      );
    });
  });
}
