import { describe, expect, it } from "vitest";
import { StarknetEndpointCapabilities } from "../src/endpoint-capabilities";
import { StarknetRpcCapabilities } from "../src/rpc-capabilities";
import {
  type LiveEndpointName,
  getLiveEndpoint,
} from "./support/live-endpoints";

const endpoints: {
  name: LiveEndpointName;
  label: string;
  expectedVersion: RegExp;
  enhancedCapabilities: boolean;
}[] = [
  {
    name: "integration",
    label: "integration v0.10",
    expectedVersion: /^0\.10\./,
    enhancedCapabilities: true,
  },
  {
    name: "testnet",
    label: "testnet v0.9",
    expectedVersion: /^0\.9\./,
    enhancedCapabilities: false,
  },
];

describe("Starknet RPC endpoint capabilities", () => {
  for (const endpoint of endpoints) {
    const resolved = getLiveEndpoint(endpoint.name);

    it.skipIf(!resolved)(
      `probes the ${endpoint.label} endpoint`,
      async () => {
        const url = resolved!.httpUrl;
        const [rpc, deployment] = await Promise.all([
          StarknetRpcCapabilities.probe(url),
          StarknetEndpointCapabilities.probe(url),
        ]);

        expect(rpc.specVersion).toMatch(endpoint.expectedVersion);
        expect(rpc).toMatchObject({
          blockWithReceipts: true,
          stateUpdates: true,
          traces: true,
          subscriptions: {
            newHeads: true,
            newTransactions: true,
            transactionStatus: true,
            events: true,
            reorgNotifications: true,
          },
          multiAddressEvents: endpoint.enhancedCapabilities,
          eventIndices: endpoint.enhancedCapabilities,
          stateAddressFiltering: endpoint.enhancedCapabilities,
          responseFlags: endpoint.enhancedCapabilities,
        });
        expect(deployment).toMatchObject({
          blockZeroAvailable: true,
          batch: true,
        });
      },
      30_000,
    );
  }
});
