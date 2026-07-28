# Starknet RPC branch stack

The Starknet RPC work is split into the following git-spice stack, listed from
the trunk upward. Each branch is an independently reviewable building block,
and implementation tests are committed alongside the behavior they cover.

| Order | Branch | Contents | Tests |
|---:|---|---|---|
| 1 | `rpc-stream-multifilter-finality` | Extends the shared RPC protocol with finalized, accepted, and pending finality; aligned multi-filter range/header hooks; accepted-head and pending watchers; reorg-aware tracking. | RPC data-stream and chain-tracker state-machine coverage. |
| 2 | `starknet-rpc-filter-transforms` | Scaffolds `@apibara/starknet-rpc`; defines RPC-specific block and receipt resources; compiles and validates Starknet filters; transforms and projects RPC data; adds the adaptive event-range oracle. | Filter, transform/projection, and range-oracle unit tests. |
| 3 | `starknet-rpc-transport-probing` | Adds throttled concurrent JSON-RPC transport, retry and timeout behavior, batching gates, endpoint capability probing, and the opt-in live endpoint matrix. | Transport, retry, capability-probe, and live compatibility tests. |
| 4 | `starknet-rpc-cost-aware-stream` | Adds cost-aware block acquisition, shared multi-filter caches, event discovery, state and trace loading, WebSocket head/pending watchers, and `StarknetRpcStream`. | Query-plan call-count and overlapping-filter integration tests. |
| 5 | `starknet-rpc-docs-live-matrix` | Documents compatibility, limitations, defaults, and benchmark call counts; exposes the package from the root README; adds the manual/nightly live compatibility workflow. | No deferred unit-test dump: behavioral tests live on the branches that introduce each feature. |

The stack is based directly on `main`; it does not depend on PR #221. Review
and land the branches in the order above. To inspect the topology locally:

```sh
git-spice log long
```

Live compatibility tests require one or more of the endpoint variables
documented in `packages/starknet-rpc/README.md`. Endpoint values may contain
credentials and are intentionally not printed by the tests.
