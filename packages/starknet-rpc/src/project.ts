import type {
  ContractChange,
  ContractChangeFilter,
  Event,
  EventFilter,
  Filter,
  MessageToL1,
  MessageToL1Filter,
  NonceUpdate,
  StorageDiff,
  Transaction,
  TransactionFilter,
  TransactionTrace,
} from "@apibara/starknet";
import type { StarknetRpcBlock, StarknetRpcTransactionReceipt } from "./block";
import { normalizeFelt } from "./filter";

export function projectBlock(
  block: StarknetRpcBlock,
  filter: Filter,
): StarknetRpcBlock | null {
  const transactions = new Map<number, Transaction>();
  const receipts = new Map<number, StarknetRpcTransactionReceipt>();
  const events = new Map<number, Event>();
  const messages = new Map<number, MessageToL1>();
  const traces = new Map<number, TransactionTrace>();
  const storageDiffs = new Map<number, StorageDiff>();
  const contractChanges = new Map<number, ContractChange>();
  const nonceUpdates = new Map<number, NonceUpdate>();

  for (const transactionFilter of filter.transactions ?? []) {
    for (const transaction of block.transactions) {
      if (!matchesTransaction(transaction, transactionFilter)) continue;
      const index = transaction.meta.transactionIndex;
      add(transactions, index, transaction, transactionFilter.id);
      if (transactionFilter.includeReceipt) {
        includeReceipt(block, receipts, index, transactionFilter.id);
      }
      if (transactionFilter.includeEvents) {
        includeTransactionEvents(block, events, index, transactionFilter.id);
      }
      if (transactionFilter.includeMessages) {
        includeTransactionMessages(
          block,
          messages,
          index,
          transactionFilter.id,
        );
      }
      if (transactionFilter.includeTrace) {
        includeTrace(block, traces, index, transactionFilter.id);
      }
    }
  }

  for (const eventFilter of filter.events ?? []) {
    for (const event of block.events) {
      if (!matchesEvent(event, eventFilter)) continue;
      const index = event.transactionIndex;
      add(events, event.eventIndex, event, eventFilter.id);
      if (eventFilter.includeTransaction) {
        includeTransaction(block, transactions, index, eventFilter.id);
      }
      if (eventFilter.includeReceipt) {
        includeReceipt(block, receipts, index, eventFilter.id);
      }
      if (eventFilter.includeMessages) {
        includeTransactionMessages(block, messages, index, eventFilter.id);
      }
      if (eventFilter.includeSiblings) {
        includeTransactionEvents(block, events, index, eventFilter.id);
      }
      if (eventFilter.includeTransactionTrace) {
        includeTrace(block, traces, index, eventFilter.id);
      }
    }
  }

  for (const messageFilter of filter.messages ?? []) {
    for (const message of block.messages) {
      if (!matchesMessage(message, messageFilter)) continue;
      const index = message.transactionIndex;
      add(messages, message.messageIndex, message, messageFilter.id);
      if (messageFilter.includeTransaction) {
        includeTransaction(block, transactions, index, messageFilter.id);
      }
      if (messageFilter.includeReceipt) {
        includeReceipt(block, receipts, index, messageFilter.id);
      }
      if (messageFilter.includeEvents) {
        includeTransactionEvents(block, events, index, messageFilter.id);
      }
      if (messageFilter.includeTransactionTrace) {
        includeTrace(block, traces, index, messageFilter.id);
      }
    }
  }

  for (const stateFilter of filter.storageDiffs ?? []) {
    block.storageDiffs.forEach((diff, index) => {
      if (
        stateFilter.contractAddress === undefined ||
        equalFelt(diff.contractAddress, stateFilter.contractAddress)
      ) {
        add(storageDiffs, index, diff, stateFilter.id);
      }
    });
  }
  for (const changeFilter of filter.contractChanges ?? []) {
    block.contractChanges.forEach((change, index) => {
      if (matchesContractChange(change, changeFilter)) {
        add(contractChanges, index, change, changeFilter.id);
      }
    });
  }
  for (const nonceFilter of filter.nonceUpdates ?? []) {
    block.nonceUpdates.forEach((update, index) => {
      if (
        nonceFilter.contractAddress === undefined ||
        equalFelt(update.contractAddress, nonceFilter.contractAddress)
      ) {
        add(nonceUpdates, index, update, nonceFilter.id);
      }
    });
  }

  const hasData =
    transactions.size +
      receipts.size +
      events.size +
      messages.size +
      traces.size +
      storageDiffs.size +
      contractChanges.size +
      nonceUpdates.size >
    0;
  if (!hasData && filter.header !== "always") return null;

  return {
    header: block.header,
    transactions: sorted(transactions),
    receipts: sorted(receipts),
    events: sorted(events),
    messages: sorted(messages),
    traces: sorted(traces),
    storageDiffs: sorted(storageDiffs),
    contractChanges: sorted(contractChanges),
    nonceUpdates: sorted(nonceUpdates),
  };
}

function matchesTransaction(
  transaction: Transaction,
  filter: TransactionFilter,
): boolean {
  if (
    !matchesStatus(transaction.meta.transactionStatus, filter.transactionStatus)
  ) {
    return false;
  }
  return (
    filter.transactionType === undefined ||
    filter.transactionType._tag === transaction.transaction._tag
  );
}

function matchesEvent(event: Event, filter: EventFilter): boolean {
  if (filter.address && !equalFelt(event.address, filter.address)) return false;
  if (!matchesStatus(event.transactionStatus, filter.transactionStatus)) {
    return false;
  }
  const keys = filter.keys ?? [];
  if (filter.strict && event.keys.length !== keys.length) return false;
  if (event.keys.length < keys.length) return false;
  return keys.every(
    (key, index) => key === null || equalFelt(event.keys[index], key),
  );
}

function matchesMessage(
  message: MessageToL1,
  filter: MessageToL1Filter,
): boolean {
  return (
    (!filter.fromAddress ||
      equalFelt(message.fromAddress, filter.fromAddress)) &&
    (!filter.toAddress || equalFelt(message.toAddress, filter.toAddress)) &&
    matchesStatus(message.transactionStatus, filter.transactionStatus)
  );
}

function matchesStatus(
  status: string,
  filterStatus: string | undefined,
): boolean {
  const expected = filterStatus ?? "succeeded";
  return expected === "all" || status === expected;
}

function matchesContractChange(
  change: ContractChange,
  filter: ContractChangeFilter,
): boolean {
  return (
    filter.change === undefined || filter.change._tag === change.change._tag
  );
}

function includeTransaction(
  block: StarknetRpcBlock,
  target: Map<number, Transaction>,
  transactionIndex: number,
  id: number | undefined,
): void {
  const value = block.transactions.find(
    (item) => item.meta.transactionIndex === transactionIndex,
  );
  if (value) add(target, transactionIndex, value, id);
}

function includeReceipt(
  block: StarknetRpcBlock,
  target: Map<number, StarknetRpcTransactionReceipt>,
  transactionIndex: number,
  id: number | undefined,
): void {
  const value = block.receipts.find(
    (item) => item.meta.transactionIndex === transactionIndex,
  );
  if (value) add(target, transactionIndex, value, id);
}

function includeTransactionEvents(
  block: StarknetRpcBlock,
  target: Map<number, Event>,
  transactionIndex: number,
  id: number | undefined,
): void {
  for (const event of block.events) {
    if (event.transactionIndex === transactionIndex) {
      add(target, event.eventIndex, event, id);
    }
  }
}

function includeTransactionMessages(
  block: StarknetRpcBlock,
  target: Map<number, MessageToL1>,
  transactionIndex: number,
  id: number | undefined,
): void {
  for (const message of block.messages) {
    if (message.transactionIndex === transactionIndex) {
      add(target, message.messageIndex, message, id);
    }
  }
}

function includeTrace(
  block: StarknetRpcBlock,
  target: Map<number, TransactionTrace>,
  transactionIndex: number,
  id: number | undefined,
): void {
  const value = block.traces.find(
    (item) => item.transactionIndex === transactionIndex,
  );
  if (value) add(target, transactionIndex, value, id);
}

function add<T extends { readonly filterIds: readonly number[] }>(
  target: Map<number, T>,
  key: number,
  value: T,
  id: number | undefined,
): void {
  const filterId = id ?? 0;
  const existing = target.get(key);
  const filterIds = existing?.filterIds ?? value.filterIds;
  target.set(key, {
    ...(existing ?? value),
    filterIds: filterIds.includes(filterId)
      ? [...filterIds]
      : [...filterIds, filterId],
  } as T);
}

function sorted<T>(values: Map<number, T>): T[] {
  return [...values.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, value]) => value);
}

function equalFelt(a: string | undefined, b: string | undefined): boolean {
  return (
    a !== undefined && b !== undefined && normalizeFelt(a) === normalizeFelt(b)
  );
}
