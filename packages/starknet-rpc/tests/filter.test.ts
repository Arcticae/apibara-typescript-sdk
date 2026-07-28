import type { Filter } from "@apibara/starknet";
import { describe, expect, it } from "vitest";
import { FilterSet } from "../src/filter";

describe("FilterSet", () => {
  it("creates a fetch plan from all filters", () => {
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
    const filterSet = new FilterSet();
    for (const filter of filters) filterSet.add(filter);

    expect(filterSet.createFetchPlan()).toEqual({
      headerRequirement: "always",
      fetchEvents: true,
      fetchReceipts: true,
      fetchState: true,
      fetchTraces: true,
      eventAddresses: ["0x1"],
      stateAddresses: ["0x2"],
    });
  });

  it("rejects empty and malformed filters as they are added", () => {
    expect(() => new FilterSet().add({})).toThrowError(
      "Filter at position 0 is invalid: Filter has no header or data filters",
    );
    expect(() =>
      new FilterSet().add({
        events: [{ address: "not-a-felt" as `0x${string}` }],
      }),
    ).toThrowError("Filter at position 0 is invalid: Invalid event address");
  });

  it("creates fetch-plan snapshots", () => {
    const filters = new FilterSet().add({
      header: "on_data",
      events: [{ address: "0x1" }],
    });
    const first = filters.createFetchPlan();

    filters.add({
      header: "always",
      storageDiffs: [{ contractAddress: "0x2" }],
    });
    const second = filters.createFetchPlan();

    expect(first).toMatchObject({
      headerRequirement: "on_data",
      fetchState: false,
    });
    expect(second).toMatchObject({
      headerRequirement: "always",
      fetchState: true,
    });
  });

  it("owns filters instead of retaining mutable caller objects", () => {
    const filter: {
      header: Filter["header"];
      events: {
        address: `0x${string}`;
        keys: `0x${string}`[];
      }[];
    } = {
      header: "on_data",
      events: [{ address: "0x1", keys: ["0x2"] }],
    };
    const filters = new FilterSet().add(filter);

    filter.header = "always";
    filter.events.push({ address: "0x3", keys: [] });
    filter.events[0].keys.push("0x4");

    expect(filters.createFetchPlan()).toMatchObject({
      headerRequirement: "on_data",
      eventAddresses: ["0x1"],
    });
  });
});
