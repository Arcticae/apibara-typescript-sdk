import { describe, expect, it } from "vitest";
import { UnsupportedStarknetRpcVersionError } from "../src/errors";

describe("UnsupportedStarknetRpcVersionError", () => {
  it("reports the incompatible endpoint version without declaring an allowlist", () => {
    const error = new UnsupportedStarknetRpcVersionError("0.11.0");

    expect(error).toMatchObject({
      name: "UnsupportedStarknetRpcVersionError",
      specVersion: "0.11.0",
      message:
        "Starknet RPC specification 0.11.0 is not compatible with this package.",
    });
  });
});
