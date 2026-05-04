import { Command } from "commander";
import { exitWithError, ValidationError } from "../core/errors.js";
import { formatMoney, getVmPrice, normalizeCurrency, type VmPriceOs } from "../core/pricing.js";
import { normalizeSku } from "../core/sku.js";
import { printInfo, printJson } from "../core/output.js";
import {
  addJsonCompatibilityOptions,
  addOutputOption,
  isJsonOutput,
  resolveOutputMode,
} from "../core/outputMode.js";

export function createPriceCommand(): Command {
  const cmd = new Command("price")
    .description("Show estimated retail compute price for one VM SKU in one region.")
    .argument("[sku]", "VM SKU (e.g. B2ats_v2, Standard_B2ats_v2)")
    .option("--sku <sku>", "VM SKU (alternative to positional)")
    .requiredOption("--region <name>", "Azure region name, e.g. swedencentral")
    .option("--currency <code>", "3-letter currency code", "USD")
    .option("--os <linux|windows>", "Operating system price lens", "linux")
    .option("--hours <n>", "Monthly estimate hours", "730")
    .action(async (positional: string | undefined, opts) => {
      let jsonErrors = Boolean(opts.json);
      try {
        const mode = resolveOutputMode(opts);
        jsonErrors = isJsonOutput(mode);
        const rawSku = opts.sku ?? positional;
        if (!rawSku) {
          throw new ValidationError(
            "Missing SKU. Try: azw price B2ats_v2 --region swedencentral --currency EUR",
          );
        }

        const sku = normalizeSku(rawSku);
        const region = String(opts.region).trim().toLowerCase();
        if (!region) throw new ValidationError("Missing --region.");
        const os = parseOs(opts.os);
        const currency = normalizeCurrency(String(opts.currency));
        const hours = parseHours(opts.hours);
        const price = await getVmPrice(sku, region, { currency, os, hoursPerMonth: hours });

        if (isJsonOutput(mode)) {
          printJson({
            schemaVersion: 1,
            kind: "price",
            sku,
            region,
            os,
            currency,
            hoursPerMonth: hours,
            price,
          });
          if (!price) process.exit(1);
          return;
        }

        if (!price) {
          process.stderr.write(
            `No ${os} retail consumption price found for ${sku} in ${region}.\n`,
          );
          process.exit(1);
        }

        printInfo("");
        printInfo(`${sku} in ${region} (${os})`);
        printInfo(`Hourly: ${formatMoney(price.hourly, currency)} / hour`);
        printInfo(`Estimate: ${formatMoney(price.monthlyEstimate, currency)} / ${hours}h month`);
        printInfo("");
        printInfo(
          "Estimate is compute retail price only; disks, bandwidth, taxes, credits, and discounts are not included.",
        );
      } catch (err) {
        exitWithError(err, jsonErrors);
      }
    });
  addOutputOption(addJsonCompatibilityOptions(cmd, "Machine-readable JSON output"));
  return cmd;
}

function parseOs(input: string): VmPriceOs {
  const os = String(input).trim().toLowerCase();
  if (os === "linux" || os === "windows") return os;
  throw new ValidationError("Invalid --os. Use 'linux' or 'windows'.");
}

function parseHours(input: string): number {
  const hours = Number(input);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new ValidationError("Invalid --hours. Use a positive number.");
  }
  return hours;
}
