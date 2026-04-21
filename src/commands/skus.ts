import { Command } from "commander";
import { armList } from "../core/arm.js";
import { filterByGeography, listLocations, resolveGeography, shortGeo } from "../core/geo.js";
import { exitWithError, ValidationError } from "../core/errors.js";
import { printInfo, printJson, printTable } from "../core/output.js";
import { Spinner } from "../core/progress.js";
import { c, colorEnabled } from "../core/color.js";
import type { AzVmSku } from "../core/types.js";

/**
 * Discovery verb. One ARM call returns every VM SKU the subscription can see,
 * deduped by name, optionally narrowed by geography / family letter. For
 * answering "what SKUs exist that I could try?" without reading Microsoft's
 * size docs end-to-end.
 */
export function createSkusCommand(): Command {
  return new Command("skus")
    .description("Discover VM SKU names (family, vCPU, RAM). Input for `azw regions <sku>`.")
    .option("--region <name>", "Scope to a single region (fast path, ~2-3s)")
    .option("--eu", "Only SKUs offered in an EU region")
    .option("--us", "Only SKUs offered in a US region")
    .option("--asia", "Only SKUs offered in an Asia Pacific region")
    .option("--geography <group>", "geographyGroup filter (or 'all')", "all")
    .option("--family <letter>", "Filter by family prefix (e.g. B, D, E, F, L, N)")
    .option("--json", "Machine-readable JSON output")
    .action(async (opts) => {
      try {
        // Single-region fast path — skip the 35s subscription catalog and hit
        // the location-scoped skus endpoint, which returns in ~2-3s.
        if (opts.region) {
          // --region is its own scope; silently ignoring --eu here would leave
          // users puzzled when the table doesn't reflect the geo they asked
          // for (e.g. `--eu --region francecentral` is unambiguously pointing
          // at one region but the EU flag suggests a 17-row view).
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
          await runSingleRegion(String(opts.region), opts);
          return;
        }

        const geoInput = opts.eu ? "eu" : opts.us ? "us" : opts.asia ? "asia" : opts.geography;
        const geo = resolveGeography(geoInput);

        // One shared call: ARM lists every SKU in the subscription. The
        // `locations` array on each SKU tells us which regions offer it, so
        // we can filter client-side instead of scanning region-by-region.
        // The subscription-level skus endpoint returns thousands of rows
        // unfiltered — one page can take 15–25s on a cold cache. Give it
        // a generous budget; the scan's 10s default is too aggressive here.
        // No progress bar (we don't know the total) — a spinner tells the
        // user the CLI is alive during that wait. ETA is empirical: the
        // catalog endpoint runs ~25-40s cold on a Students sub.
        const spinner = new Spinner("Fetching SKU catalog", 35);
        let skus: AzVmSku[];
        let locations: Awaited<ReturnType<typeof listLocations>>;
        try {
          [skus, locations] = await Promise.all([
            armList<AzVmSku>("/providers/Microsoft.Compute/skus?api-version=2021-07-01", {
              timeoutMs: 60_000,
            }),
            listLocations(),
          ]);
        } finally {
          spinner.done();
        }

        const allowedLocations = filterByGeography(locations, geo);
        // Map of lowercased region name → geographyGroup, so we can tag each
        // SKU with the set of geos it spans without a second lookup.
        const regionGeo = new Map<string, string>();
        for (const l of allowedLocations) {
          regionGeo.set(l.name.toLowerCase(), l.metadata?.geographyGroup ?? "");
        }

        const vms = skus.filter((s) => s.resourceType === "virtualMachines");

        // Dedupe: one row per SKU name, with the set of allowed regions that
        // offer it. Azure returns one entry per (sku, region) pair, so a
        // popular SKU shows up dozens of times.
        const byName = new Map<
          string,
          {
            name: string;
            family: string;
            vcpu: number | null;
            memGiB: number | null;
            regions: Set<string>;
            geos: Set<string>;
          }
        >();
        for (const s of vms) {
          const offeredRegions = s.locations
            .map((r) => r.toLowerCase())
            .filter((r) => regionGeo.has(r));
          if (offeredRegions.length === 0) continue;
          const entry = byName.get(s.name) ?? {
            name: s.name,
            family: s.family ?? "",
            vcpu: capability(s, "vCPUs"),
            memGiB: capability(s, "MemoryGB"),
            regions: new Set<string>(),
            geos: new Set<string>(),
          };
          for (const r of offeredRegions) {
            entry.regions.add(r);
            const g = regionGeo.get(r);
            if (g) entry.geos.add(g);
          }
          byName.set(s.name, entry);
        }

        let rows = [...byName.values()];
        if (opts.family) {
          const letter = String(opts.family).trim();
          const re = new RegExp(`^Standard_${escapeRegex(letter)}`, "i");
          rows = rows.filter((r) => re.test(r.name));
        }

        // Sort by family, then vCPU count, then name — groups related SKUs
        // together so users can eyeball "what sizes does B series come in?".
        rows.sort((a, b) => {
          const f = a.family.localeCompare(b.family);
          if (f !== 0) return f;
          const v = (a.vcpu ?? 0) - (b.vcpu ?? 0);
          if (v !== 0) return v;
          return a.name.localeCompare(b.name);
        });

        if (opts.json) {
          printJson({
            schemaVersion: 1,
            kind: "skus",
            geography: geo ?? "all",
            family: opts.family ?? null,
            skus: rows.map((r) => ({
              name: r.name,
              family: r.family,
              vCPU: r.vcpu,
              memoryGiB: r.memGiB,
              regionCount: r.regions.size,
              regions: [...r.regions].sort(),
              geographyGroups: [...r.geos].sort(),
            })),
          });
          return;
        }

        if (rows.length === 0) {
          printInfo(
            `No SKUs matched ${geo ? `geography '${geo}'` : "this subscription"}${opts.family ? ` with family ${opts.family}` : ""}.`,
          );
          return;
        }

        // Total regions available in the currently filtered scope — used to
        // collapse "offered in every region of the geo" into a compact "all N".
        const totalInScope = regionGeo.size;

        printInfo("");
        printTable(
          rows.map((r) => [
            r.name,
            r.family,
            r.vcpu !== null ? String(r.vcpu) : "—",
            r.memGiB !== null ? `${r.memGiB} GiB` : "—",
            [...r.geos].map(shortGeo).sort().join("+") || "-",
            formatRegions(r.regions, totalInScope),
          ]),
          ["NAME", "FAMILY", "vCPU", "RAM", "GEO", "REGIONS"],
        );
        printInfo("");
        const tip = `${rows.length} SKUs · pipe any NAME into 'azw regions <name>' to check deployability.`;
        printInfo(colorEnabled() ? c.dim(tip) : tip);
      } catch (err) {
        exitWithError(err, Boolean(opts.json));
      }
    });
}

/**
 * Fast path: single region — hit the location-filtered skus endpoint so we
 * get back ~300 rows in 2-3s instead of 15k+ in 25-40s. Shares the same
 * output shape as the catalog path (minus the GEO column, since there's
 * only one).
 */
async function runSingleRegion(
  region: string,
  opts: { family?: string; json?: boolean },
): Promise<void> {
  const spinner = new Spinner(`Fetching SKUs for ${region}`, 3);
  let skus: AzVmSku[];
  try {
    skus = await armList<AzVmSku>(
      `/providers/Microsoft.Compute/skus?api-version=2021-07-01&$filter=location eq '${encodeURIComponent(region)}'`,
    );
  } finally {
    spinner.done();
  }

  let vms = skus.filter((s) => s.resourceType === "virtualMachines");
  if (opts.family) {
    const re = new RegExp(`^Standard_${escapeRegex(String(opts.family).trim())}`, "i");
    vms = vms.filter((s) => re.test(s.name));
  }

  // Dedupe by name — ARM can return the same SKU multiple times per region
  // (different capability-row shapes). Keep the first occurrence; their
  // vCPU/memory are identical across duplicates.
  const byName = new Map<string, AzVmSku>();
  for (const s of vms) if (!byName.has(s.name)) byName.set(s.name, s);
  const rows = [...byName.values()]
    .map((s) => ({
      name: s.name,
      family: s.family ?? "",
      vcpu: capability(s, "vCPUs"),
      memGiB: capability(s, "MemoryGB"),
    }))
    .sort((a, b) => {
      const f = a.family.localeCompare(b.family);
      if (f !== 0) return f;
      const v = (a.vcpu ?? 0) - (b.vcpu ?? 0);
      if (v !== 0) return v;
      return a.name.localeCompare(b.name);
    });

  if (opts.json) {
    printJson({
      schemaVersion: 1,
      kind: "skus",
      region,
      family: opts.family ?? null,
      skus: rows.map((r) => ({
        name: r.name,
        family: r.family,
        vCPU: r.vcpu,
        memoryGiB: r.memGiB,
      })),
    });
    return;
  }

  if (rows.length === 0) {
    printInfo(
      `No SKUs matched region '${region}'${opts.family ? ` with family ${opts.family}` : ""}.`,
    );
    return;
  }

  printInfo("");
  printTable(
    rows.map((r) => [
      r.name,
      r.family,
      r.vcpu !== null ? String(r.vcpu) : "—",
      r.memGiB !== null ? `${r.memGiB} GiB` : "—",
    ]),
    ["NAME", "FAMILY", "vCPU", "RAM"],
  );
  printInfo("");
  const tip = `${rows.length} SKUs in ${region} · pipe any NAME into 'azw regions <name>' to check deployability.`;
  printInfo(colorEnabled() ? c.dim(tip) : tip);
}

/**
 * Render the region set for a SKU row:
 *   - If it's offered in every region of the current scope: "all 17".
 *   - Otherwise: up to 4 names alphabetical, then "+N more".
 * The full list is always available via `--json` for scripts.
 */
function formatRegions(regions: Set<string>, totalInScope: number): string {
  if (regions.size === 0) return "-";
  if (regions.size === totalInScope) return `all ${totalInScope}`;
  const sorted = [...regions].sort();
  const cap = 4;
  if (sorted.length <= cap) return sorted.join(", ");
  return `${sorted.slice(0, cap).join(", ")} +${sorted.length - cap} more`;
}

function capability(sku: AzVmSku, name: string): number | null {
  const cap = sku.capabilities?.find((c) => c.name === name);
  if (!cap) return null;
  const n = Number(cap.value);
  return Number.isFinite(n) ? n : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
