# `@apibara/starknet-rpc`

Stream Starknet data using a standard JSON-RPC endpoint and the same filters as
`@apibara/starknet`.

```ts
import { createRpcClient } from "@apibara/protocol/rpc";
import { StarknetRpcStream } from "@apibara/starknet-rpc";

const stream = new StarknetRpcStream({
  url: process.env.STARKNET_RPC_URL!,
  wsUrl: process.env.STARKNET_RPC_WS_URL,
});

const client = createRpcClient(stream);
```

The constructor defaults are:

| Option | Default |
|---|---:|
| `compatibility` | `"auto"` |
| `requestsPerSecond` | `10` |
| `maxConcurrency` | `8` |
| `getEventsRangeSize` | `1_000n` |
| `maxGetEventsRangeSize` | `10_000n` |
| `mergeEventFilters` | `"accepted"` |
| `requestTimeoutMs` | `30_000` |
| `traceTimeoutMs` | `120_000` |
| `pendingDebounceMs` | `250` |
| `pendingPolling` | `false` |
| `batch` | `false` |

## Compatibility

Always run `probeStarknetRpc(url, wsUrl)` against the actual endpoint. The
package does not infer capabilities from a URL.

| RPC / node | Finalized and accepted | Enhanced queries | Pending |
|---|---|---|---|
| RPC v0.9.x hosted endpoint | Yes | No | Capability-gated WSS |
| Exact RPC v0.10.2 | Yes | Multi-address events, event indices, filtered state updates, response flags when the probe confirms each feature | Capability-gated WSS |
| RPC v0.8.x | Rejected | No | No |
| Pathfinder 0.22.2 serving v0.10.2 | Yes, subject to archive configuration | Full probed feature set | Subject to WSS support |
| Juno 0.15.22 serving v0.10.2 | Yes, subject to archive configuration | Full probed feature set | Subject to WSS support |

Archive history and traces are operational capabilities. A matching spec
version does not guarantee either one.

## Cost model and limitations

Sparse event backfills use ranged `starknet_getEvents` for discovery and then
load `starknet_getBlockWithReceipts` once for every candidate block. RPC v0.9
accepts one event address per query and omits event/transaction indices, so the
receipt block is required for API-compatible ordering. Transaction, receipt,
message, state, and dense-event scans require per-block calls. Traces are loaded
only for a block that already matches a filter requesting traces.

State filters download the full state diff on v0.9. Exact v0.10.2 endpoints may
receive the union of requested contract addresses, but results are still
refined locally. Pre-confirmed blocks are mutable, do not advance the durable
accepted cursor, may be repeated, and never support traces.

JSON-RPC batching is disabled by default because provider billing and support
vary. Setting `batch: true` only takes effect after the capability probe accepts
a batch request.

RPC receipt resources intentionally differ from DNA receipt resources:

```ts
type StarknetRpcExecutionResources = {
  l1Gas: bigint;
  l1DataGas: bigint;
  l2Gas: bigint;
};
```

JSON-RPC does not consistently expose DNA computation steps or builtin
counters, so `StarknetRpcBlock` is not exactly assignable to the DNA `Block`.

## Expected relative performance

| Workload | Starknet RPC | DNA |
|---|---|---|
| Sparse events | Range discovery + one receipt block per matching block | Indexed stream, work follows matches |
| Many event addresses on v0.9 | At least one scan per distinct address group | Server-side filter |
| Transactions / receipts / messages | One receipt block per scanned block | Indexed stream |
| State changes | Header + state update per scanned block | Indexed stream |
| Traces | Receipt block + trace call for matched blocks | Pre-indexed when requested |

The deterministic fixture benchmark (run by
`tests/query-plan-calls.test.ts`) currently records:

| Scenario | Range | Event pages | Header loads | Receipt-block loads | State loads | Trace loads |
|---|---:|---:|---:|---:|---:|---:|
| Two overlapping v0.9 event filters, one candidate | 96 blocks | 1 | 0 | 1 | 0 | 0 |
| Two state filters | 20-block scheduling window | 0 | 20 | 0 | 20 | 0 |

Wall time, response bytes, retries, and provider cost are emitted through the
metrics below and must be measured against the intended endpoint: payload size
and billing are provider-dependent, so fixture timings are not presented as
network benchmarks.

OpenTelemetry instruments calls, bytes, latency, retries, pagination, adaptive
range sizes, cache hits, candidate blocks, receipt/state/trace loads, and
throttling.

## Live compatibility tests

Live tests are opt-in and run when their matching HTTP endpoint is configured:

- `TEST_STARKNET_RPC_V09_HTTP_URL` and optional
  `TEST_STARKNET_RPC_V09_WS_URL`
- `TEST_STARKNET_RPC_V010_HTTP_URL` and optional
  `TEST_STARKNET_RPC_V010_WS_URL`
- `TEST_STARKNET_PATHFINDER_HTTP_URL` and optional
  `TEST_STARKNET_PATHFINDER_WS_URL`
- `TEST_STARKNET_JUNO_HTTP_URL` and optional
  `TEST_STARKNET_JUNO_WS_URL`

Run them with `pnpm --filter @apibara/starknet-rpc test:live`. Endpoint values
are never included in test names, snapshots, or logs because provider URLs may
contain credentials.
