import type {
  BlockHeader,
  ContractChange,
  Event,
  FunctionInvocation,
  MessageToL1,
  NonceUpdate,
  StorageDiff,
  Transaction,
  TransactionTrace,
} from "@apibara/starknet";
import type {
  StarknetRpcBlock,
  StarknetRpcExecutionResources,
  StarknetRpcTransactionReceipt,
} from "./block";
import type {
  RpcBlock,
  RpcBlockWithReceipts,
  RpcObject,
  RpcReceipt,
  RpcStateUpdate,
} from "./rpc-types";

export type TransformedReceiptBlock = {
  header: BlockHeader;
  transactions: Transaction[];
  receipts: StarknetRpcTransactionReceipt[];
  events: Event[];
  messages: MessageToL1[];
};

export function rpcHeaderToBlockHeader(block: RpcBlock): BlockHeader {
  return {
    blockHash: optionalFelt(block.block_hash),
    parentBlockHash: felt(block.parent_hash),
    blockNumber: BigInt(requiredNumber(block.block_number, "block_number")),
    sequencerAddress: felt(block.sequencer_address ?? "0x0"),
    newRoot: optionalFelt(block.new_root),
    timestamp: new Date(requiredNumber(block.timestamp, "timestamp") * 1_000),
    starknetVersion: block.starknet_version ?? "",
    l1GasPrice: resourcePrice(block.l1_gas_price),
    l1DataGasPrice: resourcePrice(block.l1_data_gas_price),
    l1DataAvailabilityMode: block.l1_da_mode === "BLOB" ? "blob" : "calldata",
    l2GasPrice: block.l2_gas_price
      ? resourcePrice(block.l2_gas_price)
      : undefined,
  };
}

export function transformReceiptBlock(
  block: RpcBlockWithReceipts,
): TransformedReceiptBlock {
  const transactions: Transaction[] = [];
  const receipts: StarknetRpcTransactionReceipt[] = [];
  const events: Event[] = [];
  const messages: MessageToL1[] = [];
  let eventIndex = 0;
  let messageIndex = 0;

  for (
    let transactionIndex = 0;
    transactionIndex < block.transactions.length;
    transactionIndex++
  ) {
    const pair = block.transactions[transactionIndex];
    const status = transactionStatus(pair.receipt);
    const hash = felt(
      stringValue(pair.transaction.transaction_hash) ??
        pair.receipt.transaction_hash,
    );
    transactions.push(
      transformTransaction(pair.transaction, transactionIndex, hash, status),
    );
    receipts.push(
      transformReceipt(pair.transaction, pair.receipt, transactionIndex, hash),
    );

    for (const [eventIndexInTransaction, value] of arrayValue(
      pair.receipt.events,
    ).entries()) {
      const event = objectValue(value, "event");
      events.push({
        filterIds: [],
        address: felt(stringValue(event.from_address) ?? "0x0"),
        keys: feltArray(event.keys),
        data: feltArray(event.data),
        eventIndex: eventIndex++,
        transactionIndex,
        transactionHash: hash,
        transactionStatus: status,
        eventIndexInTransaction,
      });
    }
    for (const [messageIndexInTransaction, value] of arrayValue(
      pair.receipt.messages_sent,
    ).entries()) {
      const message = objectValue(value, "message");
      messages.push({
        filterIds: [],
        fromAddress: felt(stringValue(message.from_address) ?? "0x0"),
        toAddress: felt(stringValue(message.to_address) ?? "0x0"),
        payload: feltArray(message.payload),
        messageIndex: messageIndex++,
        transactionIndex,
        transactionHash: hash,
        transactionStatus: status,
        messageIndexInTransaction,
      });
    }
  }

  return {
    header: rpcHeaderToBlockHeader(block),
    transactions,
    receipts,
    events,
    messages,
  };
}

export function transformStateUpdate(
  update: RpcStateUpdate,
): Pick<StarknetRpcBlock, "storageDiffs" | "contractChanges" | "nonceUpdates"> {
  const diff = update.state_diff;
  const storageDiffs: StorageDiff[] = [];
  const contractChanges: ContractChange[] = [];
  const nonceUpdates: NonceUpdate[] = [];

  for (const value of arrayValue(diff.storage_diffs)) {
    const item = objectValue(value, "storage diff");
    storageDiffs.push({
      filterIds: [],
      contractAddress: felt(stringValue(item.address) ?? "0x0"),
      storageEntries: arrayValue(item.storage_entries).map((entry) => {
        const object = objectValue(entry, "storage entry");
        return {
          key: felt(stringValue(object.key) ?? "0x0"),
          value: felt(stringValue(object.value) ?? "0x0"),
        };
      }),
    });
  }
  for (const value of arrayValue(diff.declared_classes)) {
    const item = objectValue(value, "declared class");
    contractChanges.push({
      filterIds: [],
      change: {
        _tag: "declaredClass",
        declaredClass: {
          classHash: optionalFelt(stringValue(item.class_hash)),
          compiledClassHash: optionalFelt(
            stringValue(item.compiled_class_hash),
          ),
        },
      },
    });
  }
  for (const classHash of arrayValue(diff.deprecated_declared_classes)) {
    contractChanges.push({
      filterIds: [],
      change: {
        _tag: "declaredClass",
        declaredClass: {
          classHash: optionalFelt(stringValue(classHash)),
          compiledClassHash: undefined,
        },
      },
    });
  }
  for (const value of arrayValue(diff.replaced_classes)) {
    const item = objectValue(value, "replaced class");
    contractChanges.push({
      filterIds: [],
      change: {
        _tag: "replacedClass",
        replacedClass: {
          contractAddress: optionalFelt(stringValue(item.contract_address)),
          classHash: optionalFelt(stringValue(item.class_hash)),
        },
      },
    });
  }
  for (const value of arrayValue(diff.deployed_contracts)) {
    const item = objectValue(value, "deployed contract");
    contractChanges.push({
      filterIds: [],
      change: {
        _tag: "deployedContract",
        deployedContract: {
          contractAddress: optionalFelt(stringValue(item.address)),
          classHash: optionalFelt(stringValue(item.class_hash)),
        },
      },
    });
  }
  for (const value of arrayValue(diff.nonces)) {
    const item = objectValue(value, "nonce");
    nonceUpdates.push({
      filterIds: [],
      contractAddress: felt(stringValue(item.contract_address) ?? "0x0"),
      nonce: felt(stringValue(item.nonce) ?? "0x0"),
    });
  }
  return { storageDiffs, contractChanges, nonceUpdates };
}

export function transformTraces(
  values: unknown[],
  transactions: readonly Transaction[],
  events: readonly Event[],
  messages: readonly MessageToL1[],
): TransactionTrace[] {
  const transactionByHash = new Map(
    transactions.map((transaction) => [
      normalize(transaction.meta.transactionHash),
      transaction,
    ]),
  );
  const result: TransactionTrace[] = [];
  for (const value of values) {
    const object = objectValue(value, "trace");
    const hash = felt(stringValue(object.transaction_hash) ?? "0x0");
    const transaction = transactionByHash.get(normalize(hash));
    if (!transaction) continue;
    const transactionIndex = transaction.meta.transactionIndex;
    const eventIndices = new Map(
      events
        .filter((event) => event.transactionIndex === transactionIndex)
        .map((event) => [event.eventIndexInTransaction, event.eventIndex]),
    );
    const messageIndices = new Map(
      messages
        .filter((message) => message.transactionIndex === transactionIndex)
        .map((message) => [
          message.messageIndexInTransaction,
          message.messageIndex,
        ]),
    );
    const root = objectValue(object.trace_root, "trace root");
    const type = stringValue(root.type)?.toUpperCase();
    const common = {
      filterIds: [] as number[],
      transactionIndex,
      transactionHash: hash,
    };
    if (type === "INVOKE") {
      const execute = root.execute_invocation;
      const reverted =
        isObject(execute) && typeof execute.revert_reason === "string";
      result.push({
        ...common,
        traceRoot: {
          _tag: "invoke",
          invoke: {
            validateInvocation: optionalInvocation(
              root.validate_invocation,
              eventIndices,
              messageIndices,
            ),
            executeInvocation: reverted
              ? {
                  _tag: "reverted",
                  reverted: { reason: stringValue(execute.revert_reason) },
                }
              : {
                  _tag: "success",
                  success: invocation(execute, eventIndices, messageIndices),
                },
            feeTransferInvocation: optionalInvocation(
              root.fee_transfer_invocation,
              eventIndices,
              messageIndices,
            ),
          },
        },
      });
    } else if (type === "DECLARE") {
      result.push({
        ...common,
        traceRoot: {
          _tag: "declare",
          declare: {
            validateInvocation: optionalInvocation(
              root.validate_invocation,
              eventIndices,
              messageIndices,
            ),
            feeTransferInvocation: optionalInvocation(
              root.fee_transfer_invocation,
              eventIndices,
              messageIndices,
            ),
          },
        },
      });
    } else if (type === "DEPLOY_ACCOUNT") {
      result.push({
        ...common,
        traceRoot: {
          _tag: "deployAccount",
          deployAccount: {
            validateInvocation: optionalInvocation(
              root.validate_invocation,
              eventIndices,
              messageIndices,
            ),
            constructorInvocation: optionalInvocation(
              root.constructor_invocation,
              eventIndices,
              messageIndices,
            ),
            feeTransferInvocation: optionalInvocation(
              root.fee_transfer_invocation,
              eventIndices,
              messageIndices,
            ),
          },
        },
      });
    } else if (type === "L1_HANDLER") {
      result.push({
        ...common,
        traceRoot: {
          _tag: "l1Handler",
          l1Handler: {
            functionInvocation: optionalInvocation(
              root.function_invocation,
              eventIndices,
              messageIndices,
            ),
          },
        },
      });
    }
  }
  return result;
}

function transformTransaction(
  value: RpcObject,
  transactionIndex: number,
  transactionHash: `0x${string}`,
  status: "succeeded" | "reverted",
): Transaction {
  const type = stringValue(value.type)?.toUpperCase();
  const version = rpcVersion(value.version);
  const common = {
    filterIds: [] as number[],
    meta: {
      transactionIndex,
      transactionHash,
      transactionStatus: status,
    },
  };
  const signature = feltArray(value.signature);
  const maxFee = felt(stringValue(value.max_fee) ?? "0x0");
  const nonce = felt(stringValue(value.nonce) ?? "0x0");
  if (type === "INVOKE" && version === 0) {
    return {
      ...common,
      transaction: {
        _tag: "invokeV0",
        invokeV0: {
          maxFee,
          signature,
          contractAddress: felt(stringValue(value.contract_address) ?? "0x0"),
          entryPointSelector: felt(
            stringValue(value.entry_point_selector) ?? "0x0",
          ),
          calldata: feltArray(value.calldata),
        },
      },
    };
  }
  if (type === "INVOKE" && version === 3) {
    return {
      ...common,
      transaction: {
        _tag: "invokeV3",
        invokeV3: {
          senderAddress: felt(stringValue(value.sender_address) ?? "0x0"),
          calldata: feltArray(value.calldata),
          signature,
          nonce,
          resourceBounds: resourceBounds(value.resource_bounds),
          tip: bigintValue(value.tip),
          paymasterData: feltArray(value.paymaster_data),
          accountDeploymentData: feltArray(value.account_deployment_data),
          nonceDataAvailabilityMode: dataAvailabilityMode(
            value.nonce_data_availability_mode,
          ),
          feeDataAvailabilityMode: dataAvailabilityMode(
            value.fee_data_availability_mode,
          ),
        },
      },
    };
  }
  if (type === "INVOKE") {
    return {
      ...common,
      transaction: {
        _tag: "invokeV1",
        invokeV1: {
          senderAddress: felt(stringValue(value.sender_address) ?? "0x0"),
          calldata: feltArray(value.calldata),
          maxFee,
          signature,
          nonce,
        },
      },
    };
  }
  if (type === "DECLARE") {
    const base = {
      senderAddress: felt(stringValue(value.sender_address) ?? "0x0"),
      signature,
      classHash: felt(stringValue(value.class_hash) ?? "0x0"),
    };
    if (version === 0) {
      return {
        ...common,
        transaction: {
          _tag: "declareV0",
          declareV0: { ...base, maxFee },
        },
      };
    }
    if (version === 1) {
      return {
        ...common,
        transaction: {
          _tag: "declareV1",
          declareV1: { ...base, maxFee, nonce },
        },
      };
    }
    if (version === 2) {
      return {
        ...common,
        transaction: {
          _tag: "declareV2",
          declareV2: {
            ...base,
            compiledClassHash: felt(
              stringValue(value.compiled_class_hash) ?? "0x0",
            ),
            maxFee,
            nonce,
          },
        },
      };
    }
    return {
      ...common,
      transaction: {
        _tag: "declareV3",
        declareV3: {
          ...base,
          compiledClassHash: felt(
            stringValue(value.compiled_class_hash) ?? "0x0",
          ),
          nonce,
          resourceBounds: resourceBounds(value.resource_bounds),
          tip: bigintValue(value.tip),
          paymasterData: feltArray(value.paymaster_data),
          accountDeploymentData: feltArray(value.account_deployment_data),
          nonceDataAvailabilityMode: dataAvailabilityMode(
            value.nonce_data_availability_mode,
          ),
          feeDataAvailabilityMode: dataAvailabilityMode(
            value.fee_data_availability_mode,
          ),
        },
      },
    };
  }
  if (type === "DEPLOY_ACCOUNT") {
    const base = {
      signature,
      nonce,
      contractAddressSalt: felt(
        stringValue(value.contract_address_salt) ?? "0x0",
      ),
      constructorCalldata: feltArray(value.constructor_calldata),
      classHash: felt(stringValue(value.class_hash) ?? "0x0"),
    };
    if (version === 3) {
      return {
        ...common,
        transaction: {
          _tag: "deployAccountV3",
          deployAccountV3: {
            ...base,
            resourceBounds: resourceBounds(value.resource_bounds),
            tip: bigintValue(value.tip),
            paymasterData: feltArray(value.paymaster_data),
            nonceDataAvailabilityMode: dataAvailabilityMode(
              value.nonce_data_availability_mode,
            ),
            feeDataAvailabilityMode: dataAvailabilityMode(
              value.fee_data_availability_mode,
            ),
          },
        },
      };
    }
    return {
      ...common,
      transaction: {
        _tag: "deployAccountV1",
        deployAccountV1: { ...base, maxFee },
      },
    };
  }
  if (type === "DEPLOY") {
    return {
      ...common,
      transaction: {
        _tag: "deploy",
        deploy: {
          contractAddressSalt: felt(
            stringValue(value.contract_address_salt) ?? "0x0",
          ),
          constructorCalldata: feltArray(value.constructor_calldata),
          classHash: felt(stringValue(value.class_hash) ?? "0x0"),
        },
      },
    };
  }
  return {
    ...common,
    transaction: {
      _tag: "l1Handler",
      l1Handler: {
        nonce: bigintValue(value.nonce),
        contractAddress: felt(stringValue(value.contract_address) ?? "0x0"),
        entryPointSelector: felt(
          stringValue(value.entry_point_selector) ?? "0x0",
        ),
        calldata: feltArray(value.calldata),
      },
    },
  };
}

function transformReceipt(
  transaction: RpcObject,
  receipt: RpcReceipt,
  transactionIndex: number,
  transactionHash: `0x${string}`,
): StarknetRpcTransactionReceipt {
  const type = stringValue(transaction.type)?.toUpperCase();
  const executionStatus = transactionStatus(receipt);
  const common = {
    filterIds: [] as number[],
    meta: {
      transactionIndex,
      transactionHash,
      actualFee: actualFee(receipt.actual_fee),
      executionResources: executionResources(receipt.execution_resources),
      executionResult:
        executionStatus === "reverted"
          ? ({
              _tag: "reverted",
              reverted: { reason: stringValue(receipt.revert_reason) },
            } as const)
          : ({ _tag: "succeeded", succeeded: {} } as const),
    },
  };
  if (type === "L1_HANDLER") {
    return {
      ...common,
      receipt: {
        _tag: "l1Handler",
        l1Handler: { messageHash: new Uint8Array() },
      },
    };
  }
  if (type === "DEPLOY" || type === "DEPLOY_ACCOUNT") {
    const tag = type === "DEPLOY" ? "deploy" : "deployAccount";
    const contractAddress = felt(
      stringValue(receipt.contract_address) ?? "0x0",
    );
    return tag === "deploy"
      ? {
          ...common,
          receipt: { _tag: "deploy", deploy: { contractAddress } },
        }
      : {
          ...common,
          receipt: {
            _tag: "deployAccount",
            deployAccount: { contractAddress },
          },
        };
  }
  if (type === "DECLARE") {
    return {
      ...common,
      receipt: { _tag: "declare", declare: {} },
    };
  }
  return {
    ...common,
    receipt: { _tag: "invoke", invoke: {} },
  };
}

function actualFee(value: unknown): {
  amount: `0x${string}`;
  unit: "wei" | "fri" | "unknown";
} {
  if (typeof value === "string") {
    return { amount: felt(value), unit: "wei" };
  }
  if (!isObject(value)) return { amount: "0x0", unit: "unknown" };
  const unit = stringValue(value.unit)?.toUpperCase();
  return {
    amount: felt(stringValue(value.amount) ?? "0x0"),
    unit: unit === "WEI" ? "wei" : unit === "FRI" ? "fri" : "unknown",
  };
}

function executionResources(value: unknown): StarknetRpcExecutionResources {
  if (!isObject(value)) return { l1Gas: 0n, l1DataGas: 0n, l2Gas: 0n };
  const total = isObject(value.total_gas_consumed)
    ? value.total_gas_consumed
    : value;
  const data = isObject(value.data_availability) ? value.data_availability : {};
  return {
    l1Gas: bigintValue(total.l1_gas ?? data.l1_gas),
    l1DataGas: bigintValue(total.l1_data_gas ?? data.l1_data_gas),
    l2Gas: bigintValue(total.l2_gas),
  };
}

function invocation(
  value: unknown,
  eventIndices: ReadonlyMap<number, number>,
  messageIndices: ReadonlyMap<number, number>,
): FunctionInvocation {
  const object = objectValue(value, "function invocation");
  return {
    contractAddress: felt(stringValue(object.contract_address) ?? "0x0"),
    entryPointSelector: felt(stringValue(object.entry_point_selector) ?? "0x0"),
    calldata: feltArray(object.calldata),
    callerAddress: felt(stringValue(object.caller_address) ?? "0x0"),
    classHash: felt(stringValue(object.class_hash) ?? "0x0"),
    callType: callType(object.call_type),
    result: feltArray(object.result),
    calls: arrayValue(object.calls).map((call) =>
      invocation(call, eventIndices, messageIndices),
    ),
    events: arrayValue(object.events).map((event) => {
      const order = numberValue(objectValue(event, "ordered event").order);
      return eventIndices.get(order) ?? order;
    }),
    messages: arrayValue(object.messages).map((message) => {
      const order = numberValue(objectValue(message, "ordered message").order);
      return messageIndices.get(order) ?? order;
    }),
  };
}

function optionalInvocation(
  value: unknown,
  eventIndices: ReadonlyMap<number, number>,
  messageIndices: ReadonlyMap<number, number>,
): FunctionInvocation | undefined {
  return isObject(value)
    ? invocation(value, eventIndices, messageIndices)
    : undefined;
}

function resourcePrice(value: unknown): {
  priceInFri?: `0x${string}`;
  priceInWei?: `0x${string}`;
} {
  if (!isObject(value)) return {};
  return {
    priceInFri: optionalFelt(stringValue(value.price_in_fri)),
    priceInWei: optionalFelt(stringValue(value.price_in_wei)),
  };
}

function resourceBounds(value: unknown) {
  const object = isObject(value) ? value : {};
  return {
    l1Gas: singleResourceBounds(object.l1_gas),
    l2Gas: singleResourceBounds(object.l2_gas),
  };
}

function singleResourceBounds(value: unknown) {
  const object = isObject(value) ? value : {};
  return {
    maxAmount: bigintValue(object.max_amount),
    maxPricePerUnit: bigintValue(object.max_price_per_unit),
  };
}

function transactionStatus(receipt: RpcReceipt): "succeeded" | "reverted" {
  return receipt.execution_status === "REVERTED" ? "reverted" : "succeeded";
}

function rpcVersion(value: unknown): number {
  try {
    return Number(BigInt(String(value ?? "0x0")) & 0xffn);
  } catch {
    return 0;
  }
}

function dataAvailabilityMode(value: unknown): "l1" | "l2" | "unknown" {
  return value === "L1" ? "l1" : value === "L2" ? "l2" : "unknown";
}

function callType(value: unknown): FunctionInvocation["callType"] {
  return value === "CALL"
    ? "call"
    : value === "DELEGATE"
      ? "delegate"
      : value === "LIBRARY_CALL"
        ? "libraryCall"
        : "unknown";
}

function felt(value: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`Invalid field element: ${value}`);
  }
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function optionalFelt(value: string | undefined): `0x${string}` | undefined {
  return value === undefined ? undefined : felt(value);
}

function feltArray(value: unknown): `0x${string}`[] {
  return arrayValue(value).map((item) => felt(String(item)));
}

function bigintValue(value: unknown): bigint {
  if (value === undefined || value === null) return 0n;
  return BigInt(String(value));
}

function numberValue(value: unknown): number {
  return Number(bigintValue(value));
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number") throw new Error(`Missing ${name}`);
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function objectValue(value: unknown, name: string): RpcObject {
  if (!isObject(value)) throw new Error(`Invalid ${name}`);
  return value;
}

function isObject(value: unknown): value is RpcObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize(value: string): string {
  return BigInt(value).toString(16);
}
