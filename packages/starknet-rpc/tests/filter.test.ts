import type { Filter } from "@apibara/starknet";
import { describe, expect, it } from "vitest";
import { compileQueryPlan, validateFilter } from "../src/filter";

describe("compileQueryPlan", () => {
  it("combines acquisition requirements and addresses", () => {
    const filters: Filter[] = [
      {
        header: "on_data",
        events: [
          {
            address: "0x01",
            includeReceipt: true,
            includeTransactionTrace: true,
          },
          { address: "0x1" },
        ],
      },
      {
        header: "always",
        storageDiffs: [{ contractAddress: "0x2" }],
        nonceUpdates: [{ contractAddress: "0x02" }],
      },
    ];
    expect(compileQueryPlan(filters)).toEqual({
      header: "always",
      eventDriven: true,
      receiptDriven: true,
      stateDriven: true,
      traceDriven: true,
      eventAddresses: ["0x1"],
      stateAddresses: ["0x2"],
    });
  });

  it("rejects empty and malformed filters", () => {
    expect(validateFilter({})).toEqual({
      valid: false,
      error: "Filter has no header or data filters",
    });
    expect(
      validateFilter({
        events: [{ address: "not-a-felt" as `0x${string}` }],
      }),
    ).toEqual({ valid: false, error: "Invalid event address" });
  });
});
