import { describe, expect, it } from "vitest";
import { probeStarknetRpc } from "../src/probe";

const endpoints = [
  {
    name: "hosted v0.9",
    http: process.env.TEST_STARKNET_RPC_V09_HTTP_URL,
    ws: process.env.TEST_STARKNET_RPC_V09_WS_URL,
    expected: /^0\.9\./,
  },
  {
    name: "hosted v0.10.2",
    http: process.env.TEST_STARKNET_RPC_V010_HTTP_URL,
    ws: process.env.TEST_STARKNET_RPC_V010_WS_URL,
    expected: /^0\.10\.2$/,
  },
  {
    name: "Pathfinder 0.22.2",
    http: process.env.TEST_STARKNET_PATHFINDER_HTTP_URL,
    ws: process.env.TEST_STARKNET_PATHFINDER_WS_URL,
    expected: /^0\.10\.2$/,
  },
  {
    name: "Juno 0.15.22",
    http: process.env.TEST_STARKNET_JUNO_HTTP_URL,
    ws: process.env.TEST_STARKNET_JUNO_WS_URL,
    expected: /^0\.10\.2$/,
  },
] as const;

describe("live Starknet RPC compatibility", () => {
  for (const endpoint of endpoints) {
    it.skipIf(!endpoint.http)(
      `probes ${endpoint.name} without relying on its URL`,
      async () => {
        // Endpoint values are intentionally never included in test names,
        // snapshots, errors, or logs because provider URLs may carry secrets.
        const capabilities = await probeStarknetRpc(
          endpoint.http!,
          endpoint.ws,
        );
        expect(capabilities.specVersion).toMatch(endpoint.expected);
        expect(capabilities.blockWithReceipts).toBe(true);
        expect(capabilities.stateUpdates).toBe(true);
      },
    );
  }
});
