import { describe, expect, it } from "vitest";
import { EventRangeOracle } from "../src/range-oracle";

describe("EventRangeOracle", () => {
  it("halves on provider range limits and grows after four sparse pages", () => {
    const oracle = new EventRangeOracle(1_000n, 4_000n);
    expect(oracle.clamp(10n, 20_000n)).toBe(1_009n);

    expect(
      oracle.error(new Error("query returned more than result limit")),
    ).toBe(true);
    expect(oracle.currentSize()).toBe(500n);

    for (let index = 0; index < 4; index++) oracle.success(2);
    expect(oracle.currentSize()).toBe(1_000n);
    for (let index = 0; index < 8; index++) oracle.success(0);
    expect(oracle.currentSize()).toBe(4_000n);
  });

  it("does not retry permanent errors", () => {
    const oracle = new EventRangeOracle();
    expect(oracle.error(new Error("invalid filter"))).toBe(false);
    expect(oracle.currentSize()).toBe(1_000n);
  });

  it("stops retrying range errors at a single block", () => {
    const oracle = new EventRangeOracle(1n, 1n);
    expect(oracle.error(new Error("too many results"))).toBe(false);
  });
});
