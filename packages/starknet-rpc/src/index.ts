export {
  StarknetRpcCapabilityError,
  StarknetRpcError,
  UnsupportedStarknetRpcVersionError,
} from "./errors";
export {
  compileQueryPlan,
  filterRequestsTraces,
  validateFilter,
} from "./filter";
export type { StarknetQueryPlan } from "./filter";
export { EventRangeOracle } from "./range-oracle";
export type {
  StarknetRpcBlock,
  StarknetRpcExecutionResources,
  StarknetRpcTransactionReceipt,
  StarknetRpcTransactionReceiptMeta,
} from "./block";

// Re-export the canonical filter vocabulary for convenience.
export type {
  ContractChangeFilter,
  EventFilter,
  Filter,
  HeaderFilter,
  MessageToL1Filter,
  NonceUpdateFilter,
  StorageDiffFilter,
  TransactionFilter,
} from "@apibara/starknet";
export { mergeFilter } from "@apibara/starknet";
