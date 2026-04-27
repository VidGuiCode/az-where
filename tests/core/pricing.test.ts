import { describe, expect, it } from "vitest";
import { formatMoney, normalizeCurrency, selectVmPrice } from "../../src/core/pricing.js";

describe("pricing helpers", () => {
  const base = {
    currencyCode: "EUR",
    armRegionName: "swedencentral",
    armSkuName: "Standard_B2ats_v2",
    priceType: "Consumption",
    unitOfMeasure: "1 Hour",
  };

  it("selects linux consumption prices and ignores windows/licensed/spot rows", () => {
    const selected = selectVmPrice(
      [
        { ...base, unitPrice: 0.001, productName: "Virtual Machines Spot", meterName: "Spot" },
        { ...base, unitPrice: 0.02, productName: "Virtual Machines Windows", meterName: "Windows" },
        { ...base, unitPrice: 0.03, productName: "Virtual Machines RHEL", meterName: "RHEL" },
        {
          ...base,
          unitPrice: 0.0084,
          productName: "Virtual Machines BS Series",
          meterName: "B2ats v2",
        },
      ],
      "linux",
    );

    expect(selected?.unitPrice).toBe(0.0084);
  });

  it("selects windows prices when requested", () => {
    const selected = selectVmPrice(
      [
        {
          ...base,
          unitPrice: 0.0084,
          productName: "Virtual Machines BS Series",
          meterName: "B2ats v2",
        },
        {
          ...base,
          unitPrice: 0.03,
          productName: "Virtual Machines Windows",
          meterName: "B2ats v2 Windows",
        },
      ],
      "windows",
    );

    expect(selected?.unitPrice).toBe(0.03);
  });

  it("normalizes currency codes", () => {
    expect(normalizeCurrency(" eur ")).toBe("EUR");
    expect(() => normalizeCurrency("EURO")).toThrow("Invalid currency");
  });

  it("formats small hourly prices with enough precision", () => {
    expect(formatMoney(0.0084, "EUR")).toBe("€0.0084");
  });
});
