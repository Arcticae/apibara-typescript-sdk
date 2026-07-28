import type { Filter } from "@apibara/starknet";
import { describe, expect, it } from "vitest";
import type { StarknetRpcBlock } from "../src/block";
import { projectBlock } from "../src/project";
import type { RpcBlockWithReceipts, RpcStateUpdate } from "../src/rpc-types";
import {
  transformReceiptBlock,
  transformStateUpdate,
  transformTraces,
} from "../src/transform";

const receiptBlock: RpcBlockWithReceipts = {
  block_hash: "0x10",
  parent_hash: "0x0f",
  block_number: 16,
  new_root: "0x20",
  timestamp: 1_700_000_000,
  sequencer_address: "0x123",
  starknet_version: "0.13.6",
  l1_gas_price: { price_in_wei: "0x1", price_in_fri: "0x2" },
  l1_data_gas_price: { price_in_wei: "0x3", price_in_fri: "0x4" },
  l2_gas_price: { price_in_wei: "0x5", price_in_fri: "0x6" },
  l1_da_mode: "BLOB",
  transactions: [
    {
      transaction: {
        type: "INVOKE",
        version: "0x1",
        transaction_hash: "0xaa",
        sender_address: "0x100",
        calldata: ["0x1"],
        max_fee: "0x2",
        signature: ["0x3"],
        nonce: "0x4",
      },
      receipt: {
        type: "INVOKE",
        transaction_hash: "0xaa",
        actual_fee: { amount: "0x5", unit: "WEI" },
        execution_status: "SUCCEEDED",
        execution_resources: {
          total_gas_consumed: {
            l1_gas: "0x6",
            l1_data_gas: "0x7",
            l2_gas: "0x8",
          },
        },
        events: [
          { from_address: "0xabc", keys: ["0x11", "0x22"], data: ["0x33"] },
          { from_address: "0xabc", keys: ["0x44"], data: [] },
        ],
        messages_sent: [
          { from_address: "0xabc", to_address: "0x99", payload: ["0x55"] },
        ],
      },
    },
    {
      transaction: {
        type: "DECLARE",
        version: "0x2",
        transaction_hash: "0xbb",
        sender_address: "0x200",
        class_hash: "0x201",
        compiled_class_hash: "0x202",
        max_fee: "0x2",
        signature: [],
        nonce: "0x1",
      },
      receipt: {
        type: "DECLARE",
        transaction_hash: "0xbb",
        execution_status: "REVERTED",
        revert_reason: "fixture revert",
        events: [{ from_address: "0xdef", keys: ["0x11"], data: [] }],
        messages_sent: [],
      },
    },
  ],
};

const stateUpdate: RpcStateUpdate = {
  block_hash: "0x10",
  state_diff: {
    storage_diffs: [
      {
        address: "0xabc",
        storage_entries: [{ key: "0x1", value: "0x2" }],
      },
    ],
    declared_classes: [{ class_hash: "0xc1", compiled_class_hash: "0xc2" }],
    deprecated_declared_classes: ["0xc3"],
    deployed_contracts: [{ address: "0xd1", class_hash: "0xd2" }],
    replaced_classes: [{ contract_address: "0xe1", class_hash: "0xe2" }],
    nonces: [{ contract_address: "0xabc", nonce: "0x9" }],
  },
};

function completeBlock(): StarknetRpcBlock {
  return {
    ...transformReceiptBlock(receiptBlock),
    traces: [],
    ...transformStateUpdate(stateUpdate),
  };
}

describe("RPC transforms and local projection", () => {
  it("maps every transaction version in the Starknet filter vocabulary", () => {
    const variants = [
      ["INVOKE", "0x0", "invokeV0"],
      ["INVOKE", "0x1", "invokeV1"],
      ["INVOKE", "0x3", "invokeV3"],
      ["DECLARE", "0x0", "declareV0"],
      ["DECLARE", "0x1", "declareV1"],
      ["DECLARE", "0x2", "declareV2"],
      ["DECLARE", "0x3", "declareV3"],
      ["DEPLOY", "0x0", "deploy"],
      ["L1_HANDLER", "0x0", "l1Handler"],
      ["DEPLOY_ACCOUNT", "0x1", "deployAccountV1"],
      ["DEPLOY_ACCOUNT", "0x3", "deployAccountV3"],
    ] as const;
    const block: RpcBlockWithReceipts = {
      ...receiptBlock,
      transactions: variants.map(([type, version], index) => ({
        transaction: {
          type,
          version,
          transaction_hash: `0x${(index + 1).toString(16)}`,
          sender_address: "0x1",
          contract_address: "0x1",
          entry_point_selector: "0x1",
          class_hash: "0x1",
          compiled_class_hash: "0x1",
          contract_address_salt: "0x1",
          signature: [],
          calldata: [],
          constructor_calldata: [],
          nonce: "0x0",
          max_fee: "0x0",
        },
        receipt: {
          transaction_hash: `0x${(index + 1).toString(16)}`,
          execution_status: "SUCCEEDED",
          events: [],
          messages_sent: [],
        },
      })),
    };
    expect(
      transformReceiptBlock(block).transactions.map(
        (transaction) => transaction.transaction._tag,
      ),
    ).toEqual(variants.map(([, , tag]) => tag));
  });

  it("derives stable block-global ordering and RPC gas resources", () => {
    const block = completeBlock();
    expect(block.header).toMatchObject({
      blockHash: felt("10"),
      blockNumber: 16n,
      l1DataAvailabilityMode: "blob",
    });
    expect(block.events.map((event) => event.eventIndex)).toEqual([0, 1, 2]);
    expect(block.events.map((event) => event.eventIndexInTransaction)).toEqual([
      0, 1, 0,
    ]);
    expect(block.receipts[0].meta.executionResources).toEqual({
      l1Gas: 6n,
      l1DataGas: 7n,
      l2Gas: 8n,
    });
    expect(block.receipts[1].meta.executionResult).toEqual({
      _tag: "reverted",
      reverted: { reason: "fixture revert" },
    });
    expect(block.contractChanges).toHaveLength(4);
  });

  it("matches strict keys/status and deduplicates related resources", () => {
    const filter: Filter = {
      header: "on_data",
      events: [
        {
          id: 10,
          address: "0x0abc",
          keys: ["0x11"],
          includeTransaction: true,
          includeReceipt: true,
          includeMessages: true,
          includeSiblings: true,
        },
        {
          id: 11,
          address: "0xabc",
          keys: ["0x11", "0x22"],
          strict: true,
          includeTransaction: true,
        },
        {
          id: 12,
          keys: ["0x11"],
          transactionStatus: "reverted",
        },
      ],
    };
    const projected = projectBlock(completeBlock(), filter)!;
    expect(projected.transactions).toHaveLength(1);
    expect(projected.transactions[0].filterIds).toEqual([10, 11]);
    expect(projected.receipts).toHaveLength(1);
    expect(projected.messages).toHaveLength(1);
    expect(projected.events).toHaveLength(3);
    expect(projected.events[0].filterIds).toEqual([10, 11]);
    expect(projected.events[1].filterIds).toEqual([10]);
    expect(projected.events[2].filterIds).toEqual([12]);
  });

  it("joins traces by hash and maps invocation order to global indices", () => {
    const block = completeBlock();
    const traces = transformTraces(
      [
        {
          transaction_hash: "0xbb",
          trace_root: {
            type: "DECLARE",
            validate_invocation: {
              contract_address: "0x1",
              entry_point_selector: "0x2",
              calldata: [],
              caller_address: "0x3",
              class_hash: "0x4",
              call_type: "CALL",
              result: [],
              calls: [],
              events: [{ order: 0, keys: [], data: [] }],
              messages: [],
            },
          },
        },
      ],
      block.transactions,
      block.events,
      block.messages,
    );
    expect(traces).toHaveLength(1);
    expect(
      traces[0].traceRoot._tag === "declare"
        ? traces[0].traceRoot.declare.validateInvocation?.events
        : undefined,
    ).toEqual([2]);

    const projected = projectBlock(
      { ...block, traces },
      {
        events: [
          {
            id: 50,
            address: "0xdef",
            transactionStatus: "reverted",
            includeTransactionTrace: true,
          },
        ],
      },
    );
    expect(projected?.traces[0].filterIds).toEqual([50]);
  });

  it("keeps header modes sparse", () => {
    const filter: Filter = {
      header: "on_data",
      events: [{ address: "0xffff" }],
    };
    expect(projectBlock(completeBlock(), filter)).toBeNull();
    expect(projectBlock(completeBlock(), { header: "always" })).toMatchObject({
      events: [],
      transactions: [],
    });
  });
});

function felt(value: string): `0x${string}` {
  return `0x${value.padStart(64, "0")}`;
}
