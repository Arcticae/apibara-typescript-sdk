/**
 * Maps every supported Starknet JSON-RPC transaction variant to the canonical
 * discriminated transaction model used by @apibara/starknet.
 */
import type { Transaction } from "@apibara/starknet";
import type { RpcObject } from "../rpc-types";
import { RpcValueMapper } from "./rpc-value";

type TransactionBase = Pick<Transaction, "filterIds" | "meta">;

export class TransactionMapper {
  readonly #value = new RpcValueMapper();

  map(
    value: RpcObject,
    transactionIndex: number,
    transactionHash: `0x${string}`,
    status: "succeeded" | "reverted",
  ): Transaction {
    const type = this.#value.string(value.type)?.toUpperCase();
    const version = this.#value.transactionVersion(value.version);
    const base = this.#base(transactionIndex, transactionHash, status);

    switch (type) {
      case "INVOKE":
        return this.#mapInvoke(value, version, base);
      case "DECLARE":
        return this.#mapDeclare(value, version, base);
      case "DEPLOY_ACCOUNT":
        return this.#mapDeployAccount(value, version, base);
      case "DEPLOY":
        return this.#mapDeploy(value, base);
      default:
        return this.#mapL1Handler(value, base);
    }
  }

  #base(
    transactionIndex: number,
    transactionHash: `0x${string}`,
    transactionStatus: "succeeded" | "reverted",
  ): TransactionBase {
    return {
      filterIds: [],
      meta: { transactionIndex, transactionHash, transactionStatus },
    };
  }

  #mapInvoke(
    value: RpcObject,
    version: number,
    base: TransactionBase,
  ): Transaction {
    const signature = this.#value.feltArray(value.signature);
    const maxFee = this.#value.felt(this.#value.string(value.max_fee) ?? "0x0");
    const nonce = this.#value.felt(this.#value.string(value.nonce) ?? "0x0");
    if (version === 0) {
      return {
        ...base,
        transaction: {
          _tag: "invokeV0",
          invokeV0: {
            maxFee,
            signature,
            contractAddress: this.#value.felt(
              this.#value.string(value.contract_address) ?? "0x0",
            ),
            entryPointSelector: this.#value.felt(
              this.#value.string(value.entry_point_selector) ?? "0x0",
            ),
            calldata: this.#value.feltArray(value.calldata),
          },
        },
      };
    }
    if (version === 3) {
      return {
        ...base,
        transaction: {
          _tag: "invokeV3",
          invokeV3: {
            senderAddress: this.#value.felt(
              this.#value.string(value.sender_address) ?? "0x0",
            ),
            calldata: this.#value.feltArray(value.calldata),
            signature,
            nonce,
            resourceBounds: this.#resourceBounds(value.resource_bounds),
            tip: this.#value.bigint(value.tip),
            paymasterData: this.#value.feltArray(value.paymaster_data),
            accountDeploymentData: this.#value.feltArray(
              value.account_deployment_data,
            ),
            nonceDataAvailabilityMode: this.#dataAvailabilityMode(
              value.nonce_data_availability_mode,
            ),
            feeDataAvailabilityMode: this.#dataAvailabilityMode(
              value.fee_data_availability_mode,
            ),
          },
        },
      };
    }
    return {
      ...base,
      transaction: {
        _tag: "invokeV1",
        invokeV1: {
          senderAddress: this.#value.felt(
            this.#value.string(value.sender_address) ?? "0x0",
          ),
          calldata: this.#value.feltArray(value.calldata),
          maxFee,
          signature,
          nonce,
        },
      },
    };
  }

  #mapDeclare(
    value: RpcObject,
    version: number,
    base: TransactionBase,
  ): Transaction {
    const signature = this.#value.feltArray(value.signature);
    const maxFee = this.#value.felt(this.#value.string(value.max_fee) ?? "0x0");
    const nonce = this.#value.felt(this.#value.string(value.nonce) ?? "0x0");
    const declareBase = {
      senderAddress: this.#value.felt(
        this.#value.string(value.sender_address) ?? "0x0",
      ),
      signature,
      classHash: this.#value.felt(
        this.#value.string(value.class_hash) ?? "0x0",
      ),
    };
    if (version === 0) {
      return {
        ...base,
        transaction: {
          _tag: "declareV0",
          declareV0: { ...declareBase, maxFee },
        },
      };
    }
    if (version === 1) {
      return {
        ...base,
        transaction: {
          _tag: "declareV1",
          declareV1: { ...declareBase, maxFee, nonce },
        },
      };
    }
    const compiledClassHash = this.#value.felt(
      this.#value.string(value.compiled_class_hash) ?? "0x0",
    );
    if (version === 2) {
      return {
        ...base,
        transaction: {
          _tag: "declareV2",
          declareV2: {
            ...declareBase,
            compiledClassHash,
            maxFee,
            nonce,
          },
        },
      };
    }
    return {
      ...base,
      transaction: {
        _tag: "declareV3",
        declareV3: {
          ...declareBase,
          compiledClassHash,
          nonce,
          resourceBounds: this.#resourceBounds(value.resource_bounds),
          tip: this.#value.bigint(value.tip),
          paymasterData: this.#value.feltArray(value.paymaster_data),
          accountDeploymentData: this.#value.feltArray(
            value.account_deployment_data,
          ),
          nonceDataAvailabilityMode: this.#dataAvailabilityMode(
            value.nonce_data_availability_mode,
          ),
          feeDataAvailabilityMode: this.#dataAvailabilityMode(
            value.fee_data_availability_mode,
          ),
        },
      },
    };
  }

  #mapDeployAccount(
    value: RpcObject,
    version: number,
    base: TransactionBase,
  ): Transaction {
    const deployBase = {
      signature: this.#value.feltArray(value.signature),
      nonce: this.#value.felt(this.#value.string(value.nonce) ?? "0x0"),
      contractAddressSalt: this.#value.felt(
        this.#value.string(value.contract_address_salt) ?? "0x0",
      ),
      constructorCalldata: this.#value.feltArray(value.constructor_calldata),
      classHash: this.#value.felt(
        this.#value.string(value.class_hash) ?? "0x0",
      ),
    };
    if (version === 3) {
      return {
        ...base,
        transaction: {
          _tag: "deployAccountV3",
          deployAccountV3: {
            ...deployBase,
            resourceBounds: this.#resourceBounds(value.resource_bounds),
            tip: this.#value.bigint(value.tip),
            paymasterData: this.#value.feltArray(value.paymaster_data),
            nonceDataAvailabilityMode: this.#dataAvailabilityMode(
              value.nonce_data_availability_mode,
            ),
            feeDataAvailabilityMode: this.#dataAvailabilityMode(
              value.fee_data_availability_mode,
            ),
          },
        },
      };
    }
    return {
      ...base,
      transaction: {
        _tag: "deployAccountV1",
        deployAccountV1: {
          ...deployBase,
          maxFee: this.#value.felt(this.#value.string(value.max_fee) ?? "0x0"),
        },
      },
    };
  }

  #mapDeploy(value: RpcObject, base: TransactionBase): Transaction {
    return {
      ...base,
      transaction: {
        _tag: "deploy",
        deploy: {
          contractAddressSalt: this.#value.felt(
            this.#value.string(value.contract_address_salt) ?? "0x0",
          ),
          constructorCalldata: this.#value.feltArray(
            value.constructor_calldata,
          ),
          classHash: this.#value.felt(
            this.#value.string(value.class_hash) ?? "0x0",
          ),
        },
      },
    };
  }

  #mapL1Handler(value: RpcObject, base: TransactionBase): Transaction {
    return {
      ...base,
      transaction: {
        _tag: "l1Handler",
        l1Handler: {
          nonce: this.#value.bigint(value.nonce),
          contractAddress: this.#value.felt(
            this.#value.string(value.contract_address) ?? "0x0",
          ),
          entryPointSelector: this.#value.felt(
            this.#value.string(value.entry_point_selector) ?? "0x0",
          ),
          calldata: this.#value.feltArray(value.calldata),
        },
      },
    };
  }

  #resourceBounds(value: unknown) {
    const object = this.#value.isObject(value) ? value : {};
    return {
      l1Gas: this.#singleResourceBounds(object.l1_gas),
      l2Gas: this.#singleResourceBounds(object.l2_gas),
    };
  }

  #singleResourceBounds(value: unknown) {
    const object = this.#value.isObject(value) ? value : {};
    return {
      maxAmount: this.#value.bigint(object.max_amount),
      maxPricePerUnit: this.#value.bigint(object.max_price_per_unit),
    };
  }

  #dataAvailabilityMode(value: unknown): "l1" | "l2" | "unknown" {
    return value === "L1" ? "l1" : value === "L2" ? "l2" : "unknown";
  }
}
