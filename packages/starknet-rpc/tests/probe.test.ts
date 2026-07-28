import { describe, expect, it } from "vitest";
import { parseSpecVersion } from "../src/probe";

describe("parseSpecVersion", () => {
  it("parses supported version spellings", () => {
    expect(parseSpecVersion("0.9.0")).toEqual({
      major: 0,
      minor: 9,
      patch: 0,
    });
    expect(parseSpecVersion("v0.10.2")).toEqual({
      major: 0,
      minor: 10,
      patch: 2,
    });
  });

  it("rejects non-version responses", () => {
    expect(() => parseSpecVersion("Pathfinder")).toThrow(
      "Invalid starknet_specVersion",
    );
  });
});
