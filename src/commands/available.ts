import { Command } from "commander";
import { scanAvailableFamily, type AvailableRegion, type AvailableSku } from "../core/available.js";
import { armCacheSummary } from "../core/cache.js";
import { c, colorEnabled } from "../core/color.js";
import { exitWithError, ValidationError } from "../core/errors.js";
import { filterByGeography, listLocations, resolveGeography } from "../core/geo.js";
import { printInfo, printJson, printTable } from "../core/output.js";
import { loadPolicyCheck } from "../core/policy.js";
import {
  formatMoney,
  normalizeCurrency,
  priceAvailableSkus,
  type PricedAvailableSku,
  type VmPriceOs,
} from "../core/pricing.js";

export function createAvailableCommand(): Command {
  return new Command("available")
    .description("List VM SKUs in a family that are actually deployable now.")
    .requiredOption("--family <prefix>", "VM family prefix (e.g. B, D, E, Basv2)")
    .option("--region <name>", "Scope to a single region")
    .option("--eu", "EU only")
    .option("--us", "US only")
    .option("--asia", "Asia Pacific only")
    .option("--geography <group>", "geographyGroup filter", "all")
    .option("--all", "Also include blocked candidates and reasons")
    .option("--price", "Include estimated retail compute prices")
    .option("--currency <code>", "3-letter currency code for --price", "USD")
    .option("--os <linux|windows>", "Operating system price lens for --price", "linux")
    .option("--sort <default|price>", "Sort output; price requires --price", "default")
    .option("--no-policy", "Skip Azure Policy allowed-location checks")
    .option("--refresh", "Bypass cached ARM location/SKU data")
    .option("--json", "Machine-readable JSON output")
    .action(async (opts) => {
      try {
        const family = String(opts.family).trim();
        if (!family)
          throw new ValidationError("Missing family. Try: azw available --family B --eu");

        const geoInput = opts.eu ? "eu" : opts.us ? "us" : opts.asia ? "asia" : opts.geography;
        const geo = resolveGeography(geoInput);

        if (opts.region) validateRegionScope(opts);

        const allLocations = await listLocations({
          progressLabel: `Finding available ${family} family`,
          etaSeconds: 5,
          refresh: Boolean(opts.refresh),
        });
        const locations = opts.region
          ? matchRegion(allLocations, String(opts.region))
          : filterByGeography(allLocations, geo);

        if (locations.length === 0) {
          throw new ValidationError(
            opts.region
              ? `Unknown region '${opts.region}'. Try: azw geos`
              : `No regions matched geography '${geoInput}'. Try: azw geos`,
          );
        }

        const policy = await loadPolicyCheck({
          enabled: opts.policy !== false,
          required: opts.policy !== false,
        });
        const { skus, elapsedMs } = await scanAvailableFamily({
          family,
          locations,
          refresh: Boolean(opts.refresh),
          includeAll: Boolean(opts.all),
          policy: policy.check,
        });
        const deployable = skus.some((sku) => sku.regions.some((r) => r.verdict === "AVAILABLE"));
        const priceOptions = {
          enabled: Boolean(opts.price),
          currency: normalizeCurrency(String(opts.currency)),
          os: parseOs(opts.os),
        };
        if (opts.sort !== "default" && opts.sort !== "price") {
          throw new ValidationError("Invalid --sort. Use 'default' or 'price'.");
        }
        if (opts.sort === "price" && !priceOptions.enabled) {
          throw new ValidationError("--sort price requires --price.");
        }
        const outputSkusRaw = priceOptions.enabled
          ? await priceAvailableSkus(skus, {
              currency: priceOptions.currency,
              os: priceOptions.os,
            })
          : skus;
        const outputSkus = opts.sort === "price" ? sortSkusByPrice(outputSkusRaw) : outputSkusRaw;

        if (opts.json) {
          printJson({
            schemaVersion: 1,
            kind: "available",
            family,
            geography: opts.region ? null : (geo ?? "all"),
            region: opts.region ? locations[0].name : null,
            scannedAt: new Date().toISOString(),
            elapsedMs,
            cache: armCacheSummary(),
            policy: policy.summary,
            pricing: priceOptions.enabled
              ? {
                  checked: true,
                  currency: priceOptions.currency,
                  os: priceOptions.os,
                  note: "Compute retail price only; disks, bandwidth, taxes, credits, and discounts are not included.",
                }
              : { checked: false },
            skus: outputSkus.map(jsonSku),
          });
          if (!deployable) process.exit(1);
          return;
        }

        printInfo("");
        if (outputSkus.length === 0) {
          const scope = opts.region ? locations[0].name : (geo ?? "current scope");
          printInfo(`No deployable ${family}-family VM SKUs found in ${scope}.`);
          if (!opts.all) {
            const tip = "Use --all to see blocked candidates and reasons.";
            printInfo(colorEnabled() ? c.dim(tip) : tip);
          }
        } else {
          const title = `Deployable ${family}-family VM SKUs${opts.region ? ` in ${locations[0].name}` : geo ? ` in ${geo}` : ""}`;
          printInfo(colorEnabled() ? c.bold(title) : title);
          printInfo("");
          printTable(
            outputSkus.map((sku) => availableTableRow(sku, Boolean(opts.all), priceOptions)),
            priceOptions.enabled
              ? ["SKU", "vCPU", "RAM", "PRICE/H", "EST/MO", "REGIONS"]
              : ["SKU", "vCPU", "RAM", "FAMILY", "REGIONS"],
          );
          printInfo("");
          const suffix = opts.all ? " candidates" : " deployable SKUs";
          printInfo(
            colorEnabled()
              ? c.dim(`${outputSkus.length}${suffix}.`)
              : `${outputSkus.length}${suffix}.`,
          );
          if (priceOptions.enabled) {
            const note =
              "Prices are compute retail estimates only; disks, bandwidth, taxes, credits, and discounts are not included.";
            printInfo(colorEnabled() ? c.dim(note) : note);
          }
        }

        if (!deployable) process.exit(1);
      } catch (err) {
        exitWithError(err, Boolean(opts.json));
      }
    });
}

function validateRegionScope(opts: {
  eu?: boolean;
  us?: boolean;
  asia?: boolean;
  geography?: string;
}): void {
  const conflicting = [
    opts.eu && "--eu",
    opts.us && "--us",
    opts.asia && "--asia",
    opts.geography && opts.geography !== "all" && `--geography ${opts.geography}`,
  ].filter(Boolean);
  if (conflicting.length > 0) {
    throw new ValidationError(
      `--region scopes to a single region and can't be combined with ${conflicting.join(", ")}. Drop either the geo flag or --region.`,
    );
  }
}

function matchRegion(locations: Awaited<ReturnType<typeof listLocations>>, region: string) {
  const normalized = region.trim().toLowerCase();
  return locations.filter((l) => l.name.toLowerCase() === normalized);
}

function jsonSku(sku: AvailableSku | PricedAvailableSku) {
  return {
    sku: sku.sku,
    family: sku.family,
    vcpus: sku.vcpus,
    memoryGiB: sku.memoryGiB,
    price: "price" in sku ? sku.price : undefined,
    regions: sku.regions,
  };
}

function availableTableRow(
  sku: AvailableSku | PricedAvailableSku,
  includeVerdicts: boolean,
  priceOptions: { enabled: boolean; currency: string },
): string[] {
  const base = [
    sku.sku,
    sku.vcpus !== null ? String(sku.vcpus) : "-",
    sku.memoryGiB !== null ? `${sku.memoryGiB} GiB` : "-",
  ];
  if (!priceOptions.enabled) {
    return [...base, sku.family, formatRegions(sku.regions, includeVerdicts)];
  }
  const price = "price" in sku ? sku.price : null;
  return [
    ...base,
    price ? formatMoney(price.hourly, price.currencyCode) : "-",
    price ? formatMoney(price.monthlyEstimate, price.currencyCode) : "-",
    formatRegions(sku.regions, includeVerdicts),
  ];
}

function sortSkusByPrice<T extends AvailableSku | PricedAvailableSku>(skus: T[]): T[] {
  return [...skus].sort((a, b) => {
    const ap = "price" in a && a.price ? a.price.hourly : Number.POSITIVE_INFINITY;
    const bp = "price" in b && b.price ? b.price.hourly : Number.POSITIVE_INFINITY;
    if (ap !== bp) return ap - bp;
    const av = a.vcpus ?? Number.MAX_SAFE_INTEGER;
    const bv = b.vcpus ?? Number.MAX_SAFE_INTEGER;
    if (av !== bv) return av - bv;
    return a.sku.localeCompare(b.sku);
  });
}

function formatRegions(regions: AvailableRegion[], includeVerdicts: boolean): string {
  const labels = regions.map((r) =>
    includeVerdicts ? `${r.region}:${shortVerdict(r.verdict)}` : r.region,
  );
  const cap = includeVerdicts ? 5 : 4;
  if (labels.length <= cap) return labels.join(", ");
  return `${labels.slice(0, cap).join(", ")} +${labels.length - cap} more`;
}

function parseOs(input: string): VmPriceOs {
  const os = String(input).trim().toLowerCase();
  if (os === "linux" || os === "windows") return os;
  throw new ValidationError("Invalid --os. Use 'linux' or 'windows'.");
}

function shortVerdict(verdict: AvailableRegion["verdict"]): string {
  switch (verdict) {
    case "AVAILABLE":
      return "DEPLOY";
    case "FULL":
      return "FULL";
    case "BLOCKED_FOR_SUB":
      return "SUB";
    case "POLICY_DENIED":
      return "POLICY";
    case "SKU_NOT_OFFERED":
      return "NO_SKU";
    case "QUOTA_UNKNOWN":
      return "QUOTA?";
  }
}
