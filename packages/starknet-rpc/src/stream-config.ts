import type { Bytes } from "@apibara/protocol";
import type { DataFinality } from "@apibara/protocol";
import {
  type BlockInfo,
  type FetchBlockByHashArgs,
  type FetchBlockByHashResult,
  type FetchBlockRangeArgs,
  type FetchBlockRangeManyArgs,
  type FetchBlockRangeManyResult,
  type FetchBlockRangeResult,
  type FetchCursorArgs,
  type FetchCursorRangeArgs,
  type FetchHeaderByHashManyArgs,
  type FetchHeaderByHashManyResult,
  RpcStreamConfig,
  type ValidateFilterResult,
  sleep,
} from "@apibara/protocol/rpc";
import { type Filter, mergeFilter } from "@apibara/starknet";
import { metrics } from "@opentelemetry/api";
import { satisfies } from "semver";
import type { StarknetRpcBlock } from "./block";
import type { BlockMapper } from "./block-mapper";
import { StarknetJsonRpcClient } from "./client";
import { StarknetEndpointCapabilities } from "./endpoint-capabilities";
import {
  StarknetRpcCapabilityError,
  UnsupportedStarknetRpcVersionError,
} from "./errors";
import { normalizeFelt } from "./felt";
import type { FetchPlan } from "./fetch-plan";
import { FilterSet } from "./filter";
import { StarknetRpcCapabilities, parseSpecVersion } from "./rpc-capabilities";
import type {
  RpcBlock,
  RpcBlockWithReceipts,
  RpcEventPage,
  RpcObject,
  RpcStateUpdate,
} from "./rpc-types";
import { StarknetRpcMapper } from "./transform";
import { StarknetWebSocketSignal } from "./websocket";

export type StarknetRpcStreamOptions = {
  url: string;
  wsUrl?: string;
  compatibility?: "auto" | "0.9" | "0.10.2";
  requestsPerSecond?: number;
  maxConcurrency?: number;
  mergeEventFilters?: "always" | "accepted" | false;
  /** Timeout in milliseconds for HTTP, trace, probe, and WebSocket requests. */
  timeout?: number;
  /** Number of retries after the initial request. */
  retryCount?: number;
  /** Fixed delay between retries in milliseconds. */
  retryDelay?: number;
  pendingDebounceMs?: number;
  pendingPolling?: boolean;
  batch?: boolean;
  headRefreshIntervalMs?: number;
  finalizedRefreshIntervalMs?: number;
};

type StarknetCapabilities = {
  rpc: StarknetRpcCapabilities;
  endpoint: StarknetEndpointCapabilities;
};

const meter = metrics.getMeter("@apibara/starknet-rpc");
const candidateCounter = meter.createCounter(
  "apibara.starknet_rpc.candidate_blocks",
);
const fullBlockCounter = meter.createCounter(
  "apibara.starknet_rpc.full_block_loads",
);
const stateCounter = meter.createCounter("apibara.starknet_rpc.state_loads");
const traceCounter = meter.createCounter("apibara.starknet_rpc.traces");
const pageCounter = meter.createCounter("apibara.starknet_rpc.event_pages");
const cacheCounter = meter.createCounter("apibara.starknet_rpc.cache_hits");
const rangeHistogram = meter.createHistogram(
  "apibara.starknet_rpc.event_range_size",
  { unit: "blocks" },
);

export class StarknetRpcStream extends RpcStreamConfig<
  Filter,
  StarknetRpcBlock
> {
  readonly mergeFilter = mergeFilter;
  private client: StarknetJsonRpcClient;
  private capabilitiesPromise?: Promise<StarknetCapabilities>;
  private capabilities?: StarknetCapabilities;
  private readonly headerCache = new Map<bigint, RpcBlock>();
  private readonly receiptCache = new Map<bigint, RpcBlockWithReceipts>();
  private readonly stateCache = new Map<bigint, RpcStateUpdate>();
  private readonly hashToNumber = new Map<string, bigint>();
  private websocketSignal?: StarknetWebSocketSignal;
  private pendingLoaded = false;
  private readonly rpcMapper = new StarknetRpcMapper();

  constructor(private readonly options: StarknetRpcStreamOptions) {
    super();
    this.client = this.createClient(false);
  }

  headRefreshIntervalMs(): number {
    return this.options.headRefreshIntervalMs ?? 3_000;
  }

  finalizedRefreshIntervalMs(): number {
    return this.options.finalizedRefreshIntervalMs ?? 30_000;
  }

  pendingRefreshIntervalMs(): number {
    return this.options.pendingDebounceMs ?? 250;
  }

  override async waitForHeadChange(timeoutMs: number): Promise<void> {
    if (this.websocketSignal) {
      await this.websocketSignal.wait("accepted", timeoutMs);
      return;
    }
    await super.waitForHeadChange(timeoutMs);
  }

  validateFilter(filter: Filter): ValidateFilterResult {
    try {
      new FilterSet().add(filter);
      return { valid: true };
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      return {
        valid: false,
        error:
          cause instanceof Error
            ? cause.message
            : error instanceof Error
              ? error.message
              : String(error),
      };
    }
  }

  async initializeRequest(
    filters: readonly Filter[],
    finality: DataFinality,
  ): Promise<void> {
    const capabilities = await this.getCapabilities();
    const { rpc, endpoint } = capabilities;
    const plan = this.createFilterSet(filters).createFetchPlan();
    const version = parseSpecVersion(rpc.specVersion);
    const supportedBaseline = satisfies(version, "0.9.x");
    // Accept the whole 0.10 line, including release candidates such as
    // 0.10.3-rc.0, rather than pinning to an exact patch release. Per-version
    // feature differences are already derived by StarknetRpcCapabilities.
    const supportedEnhanced = satisfies(version, ">=0.10.0 <0.11.0", {
      includePrerelease: true,
    });
    if (!supportedBaseline && !supportedEnhanced) {
      throw new UnsupportedStarknetRpcVersionError(rpc.specVersion);
    }
    if (this.options.compatibility === "0.10.2" && !supportedEnhanced) {
      throw new UnsupportedStarknetRpcVersionError(rpc.specVersion);
    }
    if (this.options.compatibility === "0.9" && !supportedBaseline) {
      throw new UnsupportedStarknetRpcVersionError(rpc.specVersion);
    }
    const requestsTraces = plan.fetchTraces;
    if (finality === "pending" && requestsTraces) {
      throw new StarknetRpcCapabilityError(
        "pending traces",
        "traceBlockTransactions does not support pre_confirmed blocks",
      );
    }
    if (requestsTraces && !rpc.traces) {
      throw new StarknetRpcCapabilityError(
        "traces",
        "the endpoint did not accept starknet_traceBlockTransactions",
      );
    }
    if (finality === "pending") {
      const subscriptions = rpc.subscriptions;
      const compatibleWs =
        endpoint.webSocket &&
        subscriptions.newHeads &&
        subscriptions.reorgNotifications &&
        (subscriptions.newTransactions ||
          subscriptions.transactionStatus ||
          subscriptions.events);
      if (!compatibleWs && !this.options.pendingPolling) {
        throw new StarknetRpcCapabilityError(
          "pending WebSocket subscriptions",
          "provide a compatible wsUrl or explicitly set pendingPolling: true",
        );
      }
    }
    if (
      this.options.wsUrl &&
      endpoint.webSocket &&
      rpc.subscriptions.newHeads &&
      !this.websocketSignal
    ) {
      this.websocketSignal = new StarknetWebSocketSignal(
        this.options.wsUrl,
        this.timeout(),
      );
      try {
        await this.websocketSignal.connect();
      } catch (error) {
        this.websocketSignal = undefined;
        if (finality === "pending" && !this.options.pendingPolling) {
          throw new StarknetRpcCapabilityError(
            "pending WebSocket connection",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }
    if (
      (plan.fetchReceipts || finality === "pending") &&
      !rpc.blockWithReceipts
    ) {
      throw new StarknetRpcCapabilityError(
        "receipt blocks",
        "the endpoint did not accept starknet_getBlockWithReceipts",
      );
    }
    if (plan.fetchState && !rpc.stateUpdates) {
      throw new StarknetRpcCapabilityError(
        "state updates",
        "the endpoint did not accept starknet_getStateUpdate",
      );
    }
    if (this.options.batch) {
      if (!endpoint.batch) {
        throw new StarknetRpcCapabilityError(
          "JSON-RPC batch",
          "the capability probe rejected batched requests",
        );
      }
      this.client = this.createClient(true);
    }
  }

  async fetchCursor(args: FetchCursorArgs): Promise<BlockInfo | null> {
    const blockId = cursorArgsToBlockId(args);
    let block: RpcBlock;
    try {
      block = await this.client.request<RpcBlock>(
        "starknet_getBlockWithTxHashes",
        [blockId],
      );
    } catch (error) {
      if (isBlockNotFound(error)) return null;
      throw error;
    }
    return this.rememberBlock(block);
  }

  async fetchCursorRange({
    startBlockNumber,
    endBlockNumber,
  }: FetchCursorRangeArgs): Promise<BlockInfo[]> {
    const result: BlockInfo[] = [];
    for (
      let windowStart = startBlockNumber;
      windowStart <= endBlockNumber;
      windowStart += 20n
    ) {
      const windowEnd =
        windowStart + 19n < endBlockNumber ? windowStart + 19n : endBlockNumber;
      const requests: Promise<BlockInfo | null>[] = [];
      for (let number = windowStart; number <= windowEnd; number++) {
        requests.push(this.fetchCursor({ blockNumber: number }));
      }
      const values = await Promise.all(requests);
      for (const value of values) {
        if (!value) throw new Error("Missing block inside canonical range");
        result.push(value);
      }
    }
    return result;
  }

  async fetchBlockRange(
    args: FetchBlockRangeArgs<Filter>,
  ): Promise<FetchBlockRangeResult<StarknetRpcBlock>> {
    const result = await this.fetchBlockRangeMany({
      ...args,
      filters: [args.filter],
    });
    return {
      startBlock: result.startBlock,
      endBlock: result.endBlock,
      data: result.data.map((item) => ({
        cursor: item.cursor,
        endCursor: item.endCursor,
        block: item.blocks[0] ?? null,
      })),
    };
  }

  async fetchBlockRangeMany({
    startBlock,
    maxBlock,
    force,
    clampAllowed,
    filters,
  }: FetchBlockRangeManyArgs<Filter>): Promise<
    FetchBlockRangeManyResult<StarknetRpcBlock>
  > {
    const capabilities = await this.getCapabilities();
    const filterSet = this.createFilterSet(filters);
    const plan = filterSet.createFetchPlan();
    const blockMapper = filterSet.createBlockMapper();
    const traceRequirements = filters.map(
      (filter) => new FilterSet().add(filter).createFetchPlan().fetchTraces,
    );
    let endBlock = maxBlock;
    const receiptEveryBlock = filters.some(
      (filter) =>
        (filter.transactions?.length ?? 0) > 0 ||
        (filter.messages?.length ?? 0) > 0,
    );
    const requiresBlockScan = receiptEveryBlock || plan.fetchState;
    if (requiresBlockScan || plan.headerRequirement === "always") {
      endBlock = min(maxBlock, startBlock + 19n);
    } else if (!plan.fetchEvents && endBlock - startBlock >= 20n) {
      endBlock = startBlock + 19n;
    }

    let candidates = new Set<bigint>();
    if (plan.fetchEvents) {
      candidates = await this.discoverEventBlocks(
        startBlock,
        endBlock,
        filters,
        capabilities,
        clampAllowed,
      );
      candidateCounter.add(candidates.size);
      rangeHistogram.record(Number(endBlock - startBlock + 1n));
    }
    const eventCandidates = new Set(candidates);
    if (requiresBlockScan || plan.headerRequirement === "always") {
      for (let number = startBlock; number <= endBlock; number++) {
        candidates.add(number);
      }
    }
    if (
      !plan.fetchEvents &&
      !requiresBlockScan &&
      plan.headerRequirement !== "always"
    ) {
      // Header-only on_data filters cannot match anything.
      candidates.clear();
    }
    if (force && candidates.size === 0) candidates.add(endBlock);

    const data: FetchBlockRangeManyResult<StarknetRpcBlock>["data"] = [];
    const orderedCandidates = [...candidates].sort(compareBigInt);
    for (let offset = 0; offset < orderedCandidates.length; offset += 20) {
      const window = orderedCandidates.slice(offset, offset + 20);
      const receiptNumbers = new Set(
        window.filter(
          (number) => receiptEveryBlock || eventCandidates.has(number),
        ),
      );
      await this.prefetchWindow(window, receiptNumbers, plan, capabilities);
      const values = await Promise.all(
        window.map((number) =>
          this.loadAndProjectBlock(
            number,
            plan,
            blockMapper,
            traceRequirements,
            capabilities,
            receiptNumbers.has(number),
          ),
        ),
      );
      for (const value of values) {
        const hash = value.header.blockHash;
        if (!hash) {
          throw new Error("Accepted block is missing block_hash");
        }
        const number = value.header.blockNumber;
        data.push({
          cursor:
            number === 0n
              ? undefined
              : {
                  orderKey: number - 1n,
                  uniqueKey: value.header.parentBlockHash,
                },
          endCursor: { orderKey: number, uniqueKey: hash },
          blocks: value.blocks,
        });
      }
    }
    return { startBlock, endBlock, data };
  }

  async fetchHeaderByHash({
    blockHash,
  }: FetchBlockByHashArgs<Filter>): Promise<
    FetchBlockByHashResult<StarknetRpcBlock>
  > {
    const result = await this.fetchHeaderByHashMany({
      blockHash,
      filters: [{ header: "always" }],
    });
    return {
      blockInfo: result.blockInfo,
      data: {
        cursor: result.data.cursor,
        endCursor: result.data.endCursor,
        block: result.data.blocks[0] ?? null,
      },
    };
  }

  async fetchHeaderByHashMany({
    blockHash,
    filters,
  }: FetchHeaderByHashManyArgs<Filter>): Promise<
    FetchHeaderByHashManyResult<StarknetRpcBlock>
  > {
    const raw = await this.client.request<RpcBlock>(
      "starknet_getBlockWithTxHashes",
      [{ block_hash: blockHash }],
    );
    const blockInfo = this.rememberBlock(raw);
    const header = this.rpcMapper.mapHeader(raw);
    const empty = emptyBlock(header);
    return {
      blockInfo,
      data: {
        cursor:
          blockInfo.blockNumber === 0n
            ? undefined
            : {
                orderKey: blockInfo.blockNumber - 1n,
                uniqueKey: blockInfo.parentBlockHash,
              },
        endCursor: {
          orderKey: blockInfo.blockNumber,
          uniqueKey: blockInfo.blockHash,
        },
        blocks: filters.map((filter) =>
          filter.header === "always" ||
          filter.header === "on_data_or_on_new_block"
            ? empty
            : null,
        ),
      },
    };
  }

  async fetchPendingBlocks(filters: readonly Filter[]): Promise<{
    revision: string;
    blocks: (StarknetRpcBlock | null)[];
    endCursor: { orderKey: bigint; uniqueKey?: Bytes };
  } | null> {
    if (this.pendingLoaded && this.websocketSignal) {
      await this.websocketSignal.wait("pending", this.headRefreshIntervalMs());
      await sleep(this.pendingRefreshIntervalMs());
    }
    let raw: RpcBlockWithReceipts;
    let rawState: RpcStateUpdate | undefined;
    try {
      raw = await this.client.request<RpcBlockWithReceipts>(
        "starknet_getBlockWithReceipts",
        ["pre_confirmed"],
      );
    } catch (error) {
      if (isBlockNotFound(error)) return null;
      throw error;
    }
    const filterSet = this.createFilterSet(filters);
    const plan = filterSet.createFetchPlan();
    if (plan.fetchState) {
      rawState = await this.client.request<RpcStateUpdate>(
        "starknet_getStateUpdate",
        ["pre_confirmed"],
      );
      // The pre-confirmed block may change between the receipt and state calls.
      // Confirm the identity once and retry on the next notification if it did.
      const confirmation = await this.client.request<RpcBlockWithReceipts>(
        "starknet_getBlockWithReceipts",
        ["pre_confirmed"],
      );
      if (pendingIdentity(raw) !== pendingIdentity(confirmation)) {
        raw = confirmation;
        rawState = await this.client.request<RpcStateUpdate>(
          "starknet_getStateUpdate",
          ["pre_confirmed"],
        );
      }
    }
    if (typeof raw.block_number !== "number") {
      const accepted = await this.fetchCursor({ blockTag: "latest" });
      if (!accepted) throw new Error("Cannot number pre-confirmed block");
      raw = { ...raw, block_number: Number(accepted.blockNumber + 1n) };
    }
    const receipt = this.rpcMapper.mapReceiptBlock(raw);
    const state = rawState
      ? this.rpcMapper.mapStateUpdate(rawState)
      : emptyState();
    const block: StarknetRpcBlock = {
      ...receipt,
      traces: [],
      ...state,
    };
    const mapped = filterSet.createBlockMapper().map(block);
    this.pendingLoaded = true;
    const number =
      typeof raw.block_number === "number"
        ? BigInt(raw.block_number)
        : (await this.fetchCursor({ blockTag: "latest" }))!.blockNumber + 1n;
    return {
      revision: JSON.stringify([raw, rawState]),
      blocks: filters.map((filter, index) => {
        const projected = mapped[index];
        return (
          projected ??
          (filter.header === "on_data_or_on_new_block"
            ? emptyBlock(block.header)
            : null)
        );
      }),
      endCursor: { orderKey: number },
    };
  }

  private async loadAndProjectBlock(
    number: bigint,
    plan: FetchPlan,
    blockMapper: BlockMapper,
    traceRequirements: readonly boolean[],
    capabilities: StarknetCapabilities,
    receiptRequired: boolean,
  ): Promise<{
    header: StarknetRpcBlock["header"];
    blocks: (StarknetRpcBlock | null)[];
  }> {
    let base: StarknetRpcBlock;
    if (receiptRequired) {
      const raw = await this.loadReceiptBlock(number);
      const transformed = this.rpcMapper.mapReceiptBlock(raw);
      base = {
        ...transformed,
        traces: [],
        ...emptyState(),
      };
    } else {
      const header = this.rpcMapper.mapHeader(await this.loadHeader(number));
      base = emptyBlock(header);
    }
    if (plan.fetchState) {
      const state = this.rpcMapper.mapStateUpdate(
        await this.loadStateUpdate(
          number,
          capabilities.rpc.stateAddressFiltering ? plan.stateAddresses : [],
        ),
      );
      base = { ...base, ...state };
    }
    let blocks = blockMapper.map(base);
    if (
      plan.fetchTraces &&
      blocks.some((block, index) => traceRequirements[index] && block !== null)
    ) {
      const rawTraces = await this.client.request<unknown[]>(
        "starknet_traceBlockTransactions",
        [{ block_number: Number(number) }],
      );
      traceCounter.add(1);
      base = {
        ...base,
        traces: this.rpcMapper.mapTraces(
          rawTraces,
          base.transactions,
          base.events,
          base.messages,
        ),
      };
      blocks = blockMapper.map(base);
    }
    return {
      header: base.header,
      blocks: [...blocks],
    };
  }

  /**
   * Finds blocks with matching events across the complete requested interval.
   *
   * `starknet_getEvents` bounds work using result pages and continuation
   * tokens. Juno and Pathfinder also surface their internal scan limits as
   * continuation tokens, so this exhausts the token chain instead of guessing
   * provider-specific block limits from error messages.
   */
  private async discoverEventBlocks(
    start: bigint,
    end: bigint,
    filters: readonly Filter[],
    capabilities: StarknetCapabilities,
    acceptedRange: boolean,
  ): Promise<Set<bigint>> {
    const eventFilters = filters.flatMap((filter) => filter.events ?? []);
    if (eventFilters.length === 0) return new Set();
    const shouldMerge =
      capabilities.rpc.multiAddressEvents &&
      ((this.options.mergeEventFilters ?? "accepted") === "always" ||
        ((this.options.mergeEventFilters ?? "accepted") === "accepted" &&
          !acceptedRange));
    const addresses = [
      ...new Set(
        eventFilters.map((filter) =>
          filter.address ? normalizeFelt(filter.address) : undefined,
        ),
      ),
    ];
    const definedAddresses = addresses.filter(
      (address): address is `0x${string}` => address !== undefined,
    );
    const hasWildcard = addresses.includes(undefined);
    const groups: (string | undefined)[][] = shouldMerge
      ? [
          ...(definedAddresses.length > 0 ? [definedAddresses] : []),
          ...(hasWildcard ? [[undefined]] : []),
        ]
      : addresses.map((address) => [address]);
    const blocks = new Set<bigint>();
    for (const group of groups) {
      let token: string | undefined;
      do {
        const query: Record<string, unknown> = {
          from_block: { block_number: Number(start) },
          to_block: { block_number: Number(end) },
          chunk_size: 1_000,
          continuation_token: token,
        };
        const defined = group.filter(
          (address): address is string => address !== undefined,
        );
        if (defined.length === 1) query.address = defined[0];
        if (defined.length > 1) query.address = defined;
        const page = await this.client.request<RpcEventPage>(
          "starknet_getEvents",
          [query],
        );
        pageCounter.add(1);
        for (const event of page.events) {
          const number = event.block_number;
          if (typeof number === "number") blocks.add(BigInt(number));
        }
        token = page.continuation_token;
      } while (token);
    }
    return blocks;
  }

  private async loadHeader(number: bigint): Promise<RpcBlock> {
    const cached = this.headerCache.get(number);
    if (cached) {
      cacheCounter.add(1, { resource: "header" });
      return cached;
    }
    const raw = await this.client.request<RpcBlock>(
      "starknet_getBlockWithTxHashes",
      [{ block_number: Number(number) }],
    );
    this.rememberBlock(raw);
    return raw;
  }

  private async prefetchWindow(
    numbers: bigint[],
    receiptNumbers: ReadonlySet<bigint>,
    plan: FetchPlan,
    capabilities: StarknetCapabilities,
  ): Promise<void> {
    if (!this.client.batchEnabled || numbers.length === 0) return;
    const calls: {
      method: string;
      params: unknown[];
      resource: "header" | "receipt" | "state";
      number: bigint;
    }[] = [];
    for (const number of numbers) {
      if (receiptNumbers.has(number)) {
        if (!this.receiptCache.has(number)) {
          calls.push({
            method: "starknet_getBlockWithReceipts",
            params: [{ block_number: Number(number) }],
            resource: "receipt",
            number,
          });
        }
      } else if (!this.headerCache.has(number)) {
        calls.push({
          method: "starknet_getBlockWithTxHashes",
          params: [{ block_number: Number(number) }],
          resource: "header",
          number,
        });
      }
      if (plan.fetchState && !this.stateCache.has(number)) {
        const params: unknown[] = [{ block_number: Number(number) }];
        if (
          capabilities.rpc.stateAddressFiltering &&
          plan.stateAddresses.length > 0
        ) {
          params.push({ contract_addresses: plan.stateAddresses });
        }
        calls.push({
          method: "starknet_getStateUpdate",
          params,
          resource: "state",
          number,
        });
      }
    }
    if (calls.length === 0) return;
    const responses = await this.client.batch<unknown[]>(
      calls.map(({ method, params }) => ({ method, params })),
    );
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index];
      const response = responses[index];
      if (call.resource === "state") {
        this.stateCache.set(call.number, response as RpcStateUpdate);
        stateCounter.add(1);
      } else if (call.resource === "receipt") {
        const block = response as RpcBlockWithReceipts;
        this.rememberBlock(block);
        this.receiptCache.set(call.number, block);
        fullBlockCounter.add(1);
      } else {
        this.rememberBlock(response as RpcBlock);
      }
    }
  }

  private async loadReceiptBlock(
    number: bigint,
  ): Promise<RpcBlockWithReceipts> {
    const cached = this.receiptCache.get(number);
    if (cached) {
      cacheCounter.add(1, { resource: "receipt_block" });
      return cached;
    }
    const raw = await this.client.request<RpcBlockWithReceipts>(
      "starknet_getBlockWithReceipts",
      [{ block_number: Number(number) }],
    );
    fullBlockCounter.add(1);
    this.rememberBlock(raw);
    this.receiptCache.set(number, raw);
    return raw;
  }

  private async loadStateUpdate(
    number: bigint,
    addresses: readonly string[],
  ): Promise<RpcStateUpdate> {
    const cached = this.stateCache.get(number);
    if (cached) {
      cacheCounter.add(1, { resource: "state_update" });
      return cached;
    }
    const params: unknown[] = [{ block_number: Number(number) }];
    if (addresses.length > 0) {
      params.push({ contract_addresses: addresses });
    }
    const raw = await this.client.request<RpcStateUpdate>(
      "starknet_getStateUpdate",
      params,
    );
    stateCounter.add(1);
    this.stateCache.set(number, raw);
    return raw;
  }

  private rememberBlock(block: RpcBlock): BlockInfo {
    if (
      typeof block.block_number !== "number" ||
      typeof block.block_hash !== "string"
    ) {
      throw new Error("Canonical Starknet block is missing number or hash");
    }
    const number = BigInt(block.block_number);
    const existing = this.headerCache.get(number);
    if (existing?.block_hash && existing.block_hash !== block.block_hash) {
      this.invalidateFrom(number);
    }
    this.headerCache.set(number, block);
    const blockHash = normalizedHash(block.block_hash);
    const parentBlockHash = normalizedHash(block.parent_hash);
    this.hashToNumber.set(blockHash, number);
    return {
      blockNumber: number,
      blockHash,
      parentBlockHash,
    };
  }

  private invalidateFrom(number: bigint): void {
    for (const key of this.headerCache.keys()) {
      if (key >= number) this.headerCache.delete(key);
    }
    for (const key of this.receiptCache.keys()) {
      if (key >= number) this.receiptCache.delete(key);
    }
    for (const key of this.stateCache.keys()) {
      if (key >= number) this.stateCache.delete(key);
    }
    for (const [hash, key] of this.hashToNumber) {
      if (key >= number) this.hashToNumber.delete(hash);
    }
  }

  private async getCapabilities(): Promise<StarknetCapabilities> {
    if (this.capabilities) return this.capabilities;
    const probeOptions = {
      timeout: this.timeout(),
      retryCount: this.options.retryCount,
      retryDelay: this.options.retryDelay,
    };
    this.capabilitiesPromise ??= Promise.all([
      StarknetRpcCapabilities.probe(this.options.url, probeOptions),
      StarknetEndpointCapabilities.probe(
        this.options.url,
        this.options.wsUrl,
        probeOptions,
      ),
    ]).then(([rpc, endpoint]) => ({ rpc, endpoint }));
    this.capabilities = await this.capabilitiesPromise;
    return this.capabilities;
  }

  private createClient(batch: boolean): StarknetJsonRpcClient {
    return new StarknetJsonRpcClient(this.options.url, {
      requestsPerSecond: this.options.requestsPerSecond ?? 10,
      maxConcurrency: this.options.maxConcurrency ?? 8,
      timeout: this.timeout(),
      retryCount: this.options.retryCount,
      retryDelay: this.options.retryDelay,
      batch,
    });
  }

  private timeout(): number {
    return this.options.timeout ?? 10_000;
  }

  private createFilterSet(filters: readonly Filter[]): FilterSet {
    const filterSet = new FilterSet();
    for (const filter of filters) filterSet.add(filter);
    return filterSet;
  }
}

function cursorArgsToBlockId(args: FetchCursorArgs): RpcObject | string {
  if (args.blockNumber !== undefined) {
    return { block_number: Number(args.blockNumber) };
  }
  if (args.blockHash !== undefined) return { block_hash: args.blockHash };
  // Starknet JSON-RPC encodes block tags as bare strings, not as an object.
  // `{ block_tag: "latest" }` is rejected by nodes with -32602 Invalid params.
  if (args.blockTag === "latest") return "latest";
  if (args.blockTag === "finalized") return "l1_accepted";
  throw new Error("Missing Starknet block identifier");
}

function emptyBlock(header: StarknetRpcBlock["header"]): StarknetRpcBlock {
  return {
    header,
    transactions: [],
    receipts: [],
    events: [],
    messages: [],
    traces: [],
    ...emptyState(),
  };
}

function emptyState(): Pick<
  StarknetRpcBlock,
  "storageDiffs" | "contractChanges" | "nonceUpdates"
> {
  return { storageDiffs: [], contractChanges: [], nonceUpdates: [] };
}

function isBlockNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("block not found") ||
    message.includes("no blocks") ||
    message.includes("block_not_found")
  );
}

function compareBigInt(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function normalizedHash(value: string): Bytes {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error("Invalid Starknet block hash");
  }
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function pendingIdentity(block: RpcBlockWithReceipts): string {
  return JSON.stringify([
    block.parent_hash,
    block.block_number,
    block.timestamp,
    block.new_root,
    block.transactions.map((pair) => pair.receipt.transaction_hash),
  ]);
}
