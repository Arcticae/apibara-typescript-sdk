/**
 * Converts loosely typed JSON-RPC fields into the strict scalar and collection
 * shapes used by the internal Starknet model.
 */
import type { RpcObject } from "../rpc-types";

export class RpcValueMapper {
  object(value: unknown, name: string): RpcObject {
    if (!this.isObject(value)) throw new Error(`Invalid ${name}`);
    return value;
  }

  isObject(value: unknown): value is RpcObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  array(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  string(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
  }

  requiredNumber(value: unknown, name: string): number {
    if (typeof value !== "number") throw new Error(`Missing ${name}`);
    return value;
  }

  number(value: unknown): number {
    return Number(this.bigint(value));
  }

  bigint(value: unknown): bigint {
    if (value === undefined || value === null) return 0n;
    return BigInt(String(value));
  }

  felt(value: string): `0x${string}` {
    if (!/^0x[0-9a-fA-F]+$/.test(value)) {
      throw new Error(`Invalid field element: ${value}`);
    }
    return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
  }

  optionalFelt(value: string | undefined): `0x${string}` | undefined {
    return value === undefined ? undefined : this.felt(value);
  }

  feltArray(value: unknown): `0x${string}`[] {
    return this.array(value).map((item) => this.felt(String(item)));
  }

  transactionVersion(value: unknown): number {
    try {
      return Number(BigInt(String(value ?? "0x0")) & 0xffn);
    } catch {
      return 0;
    }
  }

  normalizedFelt(value: string): string {
    return BigInt(value).toString(16);
  }
}
