/**
 * Maps JSON-RPC receipts to canonical receipt variants and the gas-only
 * execution-resource model exposed by supported RPC specifications.
 */
import type { StarknetRpcTransactionReceipt } from "../block";
import type { RpcObject, RpcReceipt } from "../rpc-types";
import { RpcValueMapper } from "./rpc-value";

export class ReceiptMapper {
  readonly #value = new RpcValueMapper();

  map(
    transaction: RpcObject,
    receipt: RpcReceipt,
    transactionIndex: number,
    transactionHash: `0x${string}`,
  ): StarknetRpcTransactionReceipt {
    const type = this.#value.string(transaction.type)?.toUpperCase();
    const common = {
      filterIds: [] as number[],
      meta: {
        transactionIndex,
        transactionHash,
        actualFee: this.#actualFee(receipt.actual_fee),
        executionResources: this.#executionResources(
          receipt.execution_resources,
        ),
        executionResult:
          this.status(receipt) === "reverted"
            ? ({
                _tag: "reverted",
                reverted: { reason: this.#value.string(receipt.revert_reason) },
              } as const)
            : ({ _tag: "succeeded", succeeded: {} } as const),
      },
    };

    switch (type) {
      case "L1_HANDLER":
        return {
          ...common,
          receipt: {
            _tag: "l1Handler",
            l1Handler: { messageHash: new Uint8Array() },
          },
        };
      case "DEPLOY":
        return {
          ...common,
          receipt: {
            _tag: "deploy",
            deploy: { contractAddress: this.#contractAddress(receipt) },
          },
        };
      case "DEPLOY_ACCOUNT":
        return {
          ...common,
          receipt: {
            _tag: "deployAccount",
            deployAccount: {
              contractAddress: this.#contractAddress(receipt),
            },
          },
        };
      case "DECLARE":
        return {
          ...common,
          receipt: { _tag: "declare", declare: {} },
        };
      default:
        return {
          ...common,
          receipt: { _tag: "invoke", invoke: {} },
        };
    }
  }

  status(receipt: RpcReceipt): "succeeded" | "reverted" {
    return receipt.execution_status === "REVERTED" ? "reverted" : "succeeded";
  }

  #contractAddress(receipt: RpcReceipt): `0x${string}` {
    return this.#value.felt(
      this.#value.string(receipt.contract_address) ?? "0x0",
    );
  }

  #actualFee(value: unknown): {
    amount: `0x${string}`;
    unit: "wei" | "fri" | "unknown";
  } {
    if (typeof value === "string") {
      return { amount: this.#value.felt(value), unit: "wei" };
    }
    if (!this.#value.isObject(value)) {
      return { amount: "0x0", unit: "unknown" };
    }
    const unit = this.#value.string(value.unit)?.toUpperCase();
    return {
      amount: this.#value.felt(this.#value.string(value.amount) ?? "0x0"),
      unit: unit === "WEI" ? "wei" : unit === "FRI" ? "fri" : "unknown",
    };
  }

  #executionResources(value: unknown): {
    l1Gas: bigint;
    l1DataGas: bigint;
    l2Gas: bigint;
  } {
    if (!this.#value.isObject(value)) {
      return { l1Gas: 0n, l1DataGas: 0n, l2Gas: 0n };
    }
    const total = this.#value.isObject(value.total_gas_consumed)
      ? value.total_gas_consumed
      : value;
    const data = this.#value.isObject(value.data_availability)
      ? value.data_availability
      : {};
    return {
      l1Gas: this.#value.bigint(total.l1_gas ?? data.l1_gas),
      l1DataGas: this.#value.bigint(total.l1_data_gas ?? data.l1_data_gas),
      l2Gas: this.#value.bigint(total.l2_gas),
    };
  }
}
