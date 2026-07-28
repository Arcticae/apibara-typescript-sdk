import type { ValidateFilterResult } from "@apibara/protocol/rpc";
import type {
  EventFilter,
  Filter,
  HeaderFilter,
  TransactionFilter,
} from "@apibara/starknet";

export type StarknetQueryPlan = {
  header: HeaderFilter | undefined;
  eventDriven: boolean;
  receiptDriven: boolean;
  stateDriven: boolean;
  traceDriven: boolean;
  eventAddresses: string[];
  stateAddresses: string[];
};

export function compileQueryPlan(
  filters: readonly Filter[],
): StarknetQueryPlan {
  const events = filters.flatMap((filter) => filter.events ?? []);
  const transactions = filters.flatMap((filter) => filter.transactions ?? []);
  const messages = filters.flatMap((filter) => filter.messages ?? []);
  const storageDiffs = filters.flatMap((filter) => filter.storageDiffs ?? []);
  const nonceUpdates = filters.flatMap((filter) => filter.nonceUpdates ?? []);
  const contractChanges = filters.flatMap(
    (filter) => filter.contractChanges ?? [],
  );
  const traceDriven =
    events.some((filter) => filter.includeTransactionTrace) ||
    messages.some((filter) => filter.includeTransactionTrace) ||
    transactions.some((filter) => filter.includeTrace);

  return {
    header: mergeHeaders(filters.map((filter) => filter.header)),
    eventDriven: events.length > 0,
    receiptDriven:
      events.length > 0 || transactions.length > 0 || messages.length > 0,
    stateDriven:
      storageDiffs.length > 0 ||
      nonceUpdates.length > 0 ||
      contractChanges.length > 0,
    traceDriven,
    eventAddresses: unique(
      events
        .map((filter) => filter.address)
        .filter((address): address is `0x${string}` => address !== undefined),
    ),
    stateAddresses: unique([
      ...storageDiffs
        .map((filter) => filter.contractAddress)
        .filter((address): address is `0x${string}` => address !== undefined),
      ...nonceUpdates
        .map((filter) => filter.contractAddress)
        .filter((address): address is `0x${string}` => address !== undefined),
    ]),
  };
}

export function validateFilter(filter: Filter): ValidateFilterResult {
  const collections = [
    filter.transactions,
    filter.events,
    filter.messages,
    filter.storageDiffs,
    filter.contractChanges,
    filter.nonceUpdates,
  ];
  if (!filter.header && collections.every((items) => !items?.length)) {
    return { valid: false, error: "Filter has no header or data filters" };
  }
  if (filter.header === "unknown") {
    return { valid: false, error: "Unknown header mode" };
  }

  for (const event of filter.events ?? []) {
    const error = validateEventFilter(event);
    if (error) return { valid: false, error };
  }
  for (const transaction of filter.transactions ?? []) {
    const error = validateTransactionFilter(transaction);
    if (error) return { valid: false, error };
  }
  for (const message of filter.messages ?? []) {
    if (message.fromAddress && !isFelt(message.fromAddress)) {
      return { valid: false, error: "Invalid message fromAddress" };
    }
    if (message.toAddress && !isFelt(message.toAddress)) {
      return { valid: false, error: "Invalid message toAddress" };
    }
  }
  for (const state of [
    ...(filter.storageDiffs ?? []),
    ...(filter.nonceUpdates ?? []),
  ]) {
    if (state.contractAddress && !isFelt(state.contractAddress)) {
      return { valid: false, error: "Invalid state contractAddress" };
    }
  }
  return { valid: true };
}

export function filterRequestsTraces(filter: Filter): boolean {
  return (
    (filter.events ?? []).some((item) => item.includeTransactionTrace) ||
    (filter.messages ?? []).some((item) => item.includeTransactionTrace) ||
    (filter.transactions ?? []).some((item) => item.includeTrace)
  );
}

function validateEventFilter(filter: EventFilter): string | undefined {
  if (filter.address && !isFelt(filter.address)) {
    return "Invalid event address";
  }
  for (const key of filter.keys ?? []) {
    if (key !== null && !isFelt(key)) return "Invalid event key";
  }
  if (filter.transactionStatus === "unknown") {
    return "Unknown event transaction status";
  }
  return undefined;
}

function validateTransactionFilter(
  filter: TransactionFilter,
): string | undefined {
  if (filter.transactionStatus === "unknown") {
    return "Unknown transaction status";
  }
  return undefined;
}

function mergeHeaders(
  headers: readonly (HeaderFilter | undefined)[],
): HeaderFilter | undefined {
  if (headers.includes("always")) return "always";
  if (headers.includes("on_data_or_on_new_block")) {
    return "on_data_or_on_new_block";
  }
  if (headers.includes("on_data")) return "on_data";
  return undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(normalizeFelt))];
}

export function normalizeFelt(value: string): string {
  try {
    return `0x${BigInt(value).toString(16)}`;
  } catch {
    return value.toLowerCase();
  }
}

function isFelt(value: string): boolean {
  return /^0x[0-9a-fA-F]{1,64}$/.test(value);
}
