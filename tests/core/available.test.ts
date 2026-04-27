import { describe, expect, it } from "vitest";
import {
  classifyAvailableSkuRegion,
  groupAvailableRows,
  type CandidateRow,
} from "../../src/core/available.js";
import { buildPolicyCheck, parseAllowedLocationPolicy } from "../../src/core/policy.js";
import type { AzLocation, AzVmUsage } from "../../src/core/types.js";

const loc = (name: string): AzLocation => ({
  name,
  displayName: name,
  metadata: {
    geographyGroup: "Europe",
    physicalLocation: name,
  },
});

const usage = (free: number, limit = 10): AzVmUsage => ({
  name: { value: "standardBasv2Family", localizedValue: "Basv2" },
  currentValue: limit - free,
  limit,
  unit: "Count",
});

describe("available family classification", () => {
  it("requires free quota to cover the SKU vCPU count", () => {
    expect(
      classifyAvailableSkuRegion({
        location: loc("swedencentral"),
        skuOffered: true,
        family: "standardBasv2Family",
        requiredVcpus: 2,
        usage: usage(1),
        policyAllowed: true,
        policyReason: null,
      }).verdict,
    ).toBe("FULL");

    expect(
      classifyAvailableSkuRegion({
        location: loc("norwayeast"),
        skuOffered: true,
        family: "standardBasv2Family",
        requiredVcpus: 2,
        usage: usage(2),
        policyAllowed: true,
        policyReason: null,
      }).verdict,
    ).toBe("AVAILABLE");
  });

  it("marks policy-denied regions before quota", () => {
    const row = classifyAvailableSkuRegion({
      location: loc("denmarkeast"),
      skuOffered: true,
      family: "standardBasv2Family",
      requiredVcpus: 2,
      usage: usage(10),
      policyAllowed: false,
      policyReason: "denied",
    });

    expect(row.verdict).toBe("POLICY_DENIED");
    expect(row.policyAllowed).toBe(false);
  });

  it("filters to deployable rows by default and includes blocked rows with --all", () => {
    const locations = [loc("norwayeast"), loc("denmarkeast")];
    const rows: CandidateRow[] = [
      {
        sku: "Standard_B2ats_v2",
        family: "standardBasv2Family",
        vcpus: 2,
        memoryGiB: 1,
        region: classifyAvailableSkuRegion({
          location: locations[0],
          skuOffered: true,
          family: "standardBasv2Family",
          requiredVcpus: 2,
          usage: usage(10),
          policyAllowed: true,
          policyReason: null,
        }),
      },
      {
        sku: "Standard_B2ats_v2",
        family: "standardBasv2Family",
        vcpus: 2,
        memoryGiB: 1,
        region: classifyAvailableSkuRegion({
          location: locations[1],
          skuOffered: true,
          family: "standardBasv2Family",
          requiredVcpus: 2,
          usage: usage(10),
          policyAllowed: false,
          policyReason: "denied",
        }),
      },
    ];

    expect(groupAvailableRows(rows, locations, false)[0].regions.map((r) => r.verdict)).toEqual([
      "AVAILABLE",
    ]);
    expect(groupAvailableRows(rows, locations, true)[0].regions.map((r) => r.verdict)).toEqual([
      "AVAILABLE",
      "POLICY_DENIED",
    ]);
  });

  it("uses policy metadata for missing SKU rows in --all mode", () => {
    const locations = [loc("swedencentral"), loc("denmarkeast")];
    const policy = buildPolicyCheck(
      parseAllowedLocationPolicy([
        {
          name: "sys.regionrestriction",
          properties: {
            displayName: "Allowed locations",
            parameters: { listOfAllowedLocations: { value: ["swedencentral"] } },
          },
        },
      ]),
    );
    const rows: CandidateRow[] = [
      {
        sku: "Standard_B2ats_v2",
        family: "standardBasv2Family",
        vcpus: 2,
        memoryGiB: 1,
        region: classifyAvailableSkuRegion({
          location: locations[0],
          skuOffered: true,
          family: "standardBasv2Family",
          requiredVcpus: 2,
          usage: usage(10),
          policyAllowed: true,
          policyReason: null,
        }),
      },
    ];

    const denied = groupAvailableRows(rows, locations, true, policy)[0].regions.find(
      (r) => r.region === "denmarkeast",
    );

    expect(denied?.verdict).toBe("POLICY_DENIED");
  });
});
