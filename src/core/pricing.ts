import { Spinner } from "./progress.js";
import type { AvailableRegion, AvailableSku } from "./available.js";

const RETAIL_PRICES_ENDPOINT = "https://prices.azure.com/api/retail/prices";
const DEFAULT_HOURS_PER_MONTH = 730;

export type VmPriceOs = "linux" | "windows";

export interface VmPrice {
  sku: string;
  region: string;
  currencyCode: string;
  unitPrice: number;
  retailPrice: number;
  unitOfMeasure: string;
  hourly: number;
  monthlyEstimate: number;
  productName: string;
  meterName: string;
  priceType: string;
  effectiveStartDate: string | null;
}

export interface PriceOptions {
  currency: string;
  os: VmPriceOs;
  hoursPerMonth?: number;
}

export interface PricedAvailableRegion extends AvailableRegion {
  price: VmPrice | null;
}

export interface PricedAvailableSku extends Omit<AvailableSku, "regions"> {
  regions: PricedAvailableRegion[];
  price: VmPrice | null;
}

interface RetailPriceItem {
  currencyCode?: string;
  unitPrice?: number;
  retailPrice?: number;
  unitOfMeasure?: string;
  armRegionName?: string;
  armSkuName?: string;
  productName?: string;
  meterName?: string;
  type?: string;
  priceType?: string;
  effectiveStartDate?: string;
}

interface RetailPriceResponse {
  Items?: RetailPriceItem[];
  NextPageLink?: string;
}

export async function getVmPrice(
  sku: string,
  region: string,
  opts: PriceOptions,
): Promise<VmPrice | null> {
  const items = await fetchRetailPriceItems(sku, region, opts.currency);
  const selected = selectVmPrice(items, opts.os);
  if (!selected) return null;
  const hourly = selected.unitPrice ?? selected.retailPrice ?? 0;
  return {
    sku,
    region,
    currencyCode: selected.currencyCode ?? opts.currency.toUpperCase(),
    unitPrice: selected.unitPrice ?? hourly,
    retailPrice: selected.retailPrice ?? hourly,
    unitOfMeasure: selected.unitOfMeasure ?? "1 Hour",
    hourly,
    monthlyEstimate: roundMoney(hourly * (opts.hoursPerMonth ?? DEFAULT_HOURS_PER_MONTH)),
    productName: selected.productName ?? "",
    meterName: selected.meterName ?? "",
    priceType: selected.priceType ?? selected.type ?? "",
    effectiveStartDate: selected.effectiveStartDate ?? null,
  };
}

export async function priceAvailableSkus(
  skus: AvailableSku[],
  opts: PriceOptions,
): Promise<PricedAvailableSku[]> {
  const pairs = skus.flatMap((sku) =>
    sku.regions
      .filter((region) => region.verdict === "AVAILABLE")
      .map((region) => ({ sku: sku.sku, region: region.region })),
  );
  const prices = new Map<string, VmPrice | null>();
  const spinner = new Spinner("Fetching retail prices", Math.max(3, Math.ceil(pairs.length / 4)));

  try {
    let cursor = 0;
    const concurrency = Math.min(8, Math.max(1, pairs.length));
    async function worker(): Promise<void> {
      while (true) {
        const pair = pairs[cursor++];
        if (!pair) return;
        const price = await getVmPrice(pair.sku, pair.region, opts).catch(() => null);
        prices.set(priceKey(pair.sku, pair.region), price);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  } finally {
    spinner.done();
  }

  return skus.map((sku) => {
    const regions = sku.regions.map((region) => ({
      ...region,
      price:
        region.verdict === "AVAILABLE"
          ? (prices.get(priceKey(sku.sku, region.region)) ?? null)
          : null,
    }));
    return {
      ...sku,
      regions,
      price: cheapestPrice(regions.map((region) => region.price).filter((p): p is VmPrice => !!p)),
    };
  });
}

export function selectVmPrice(items: RetailPriceItem[], os: VmPriceOs): RetailPriceItem | null {
  const candidates = items.filter((item) => {
    if ((item.priceType ?? item.type) !== "Consumption") return false;
    if (!Number.isFinite(item.unitPrice ?? item.retailPrice)) return false;
    const text = `${item.productName ?? ""} ${item.meterName ?? ""}`.toLowerCase();
    if (text.includes("cloud services")) return false;
    if (text.includes("spot") || text.includes("low priority")) return false;
    if (text.includes("reservation")) return false;
    if (text.includes("sql")) return false;
    if (text.includes("red hat") || text.includes("rhel")) return false;
    if (text.includes("sles") || text.includes("suse")) return false;
    if (text.includes("ubuntu pro")) return false;
    const isWindows = text.includes("windows");
    return os === "windows" ? isWindows : !isWindows;
  });

  return (
    candidates.sort(
      (a, b) => (a.unitPrice ?? a.retailPrice ?? 0) - (b.unitPrice ?? b.retailPrice ?? 0),
    )[0] ?? null
  );
}

export function normalizeCurrency(input: string): string {
  const currency = input.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`Invalid currency '${input}'. Use a 3-letter ISO code like USD or EUR.`);
  }
  return currency;
}

export function formatMoney(value: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: value < 1 ? 4 : 2,
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
}

function cheapestPrice(prices: VmPrice[]): VmPrice | null {
  return [...prices].sort((a, b) => a.hourly - b.hourly)[0] ?? null;
}

function priceKey(sku: string, region: string): string {
  return `${sku.toLowerCase()}\n${region.toLowerCase()}`;
}

async function fetchRetailPriceItems(
  sku: string,
  region: string,
  currency: string,
): Promise<RetailPriceItem[]> {
  const filter = [
    "serviceName eq 'Virtual Machines'",
    `armRegionName eq '${escapeOData(region)}'`,
    `armSkuName eq '${escapeOData(sku)}'`,
  ].join(" and ");
  let url = `${RETAIL_PRICES_ENDPOINT}?currencyCode=${encodeURIComponent(
    `'${normalizeCurrency(currency)}'`,
  )}&$filter=${encodeURIComponent(filter)}`;
  const items: RetailPriceItem[] = [];

  while (url) {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Azure Retail Prices API ${res.status} ${res.statusText}`);
    const data = (await res.json()) as RetailPriceResponse;
    items.push(...(data.Items ?? []));
    url = data.NextPageLink ?? "";
  }

  return items;
}

function escapeOData(value: string): string {
  return value.replace(/'/g, "''");
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
