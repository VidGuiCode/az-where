# Architecture

## Product shape

`az-where` is a local client CLI that answers "where in Azure can I actually deploy this?" It delegates auth to the official `az` CLI and is **read-only**: it never creates, modifies, or deletes Azure resources.

Two boundaries talk to Azure:

- **`az` CLI** — for one-offs (`account show`, `list-locations`) and to mint a bearer token via `az account get-access-token`. Auth stays in `az`; we never store credentials.
- **ARM REST (direct `fetch`)** — for the hot-loop scan. After we have the token, per-region sku and usage lookups go straight to `management.azure.com`. Spawning `az` per region burns ~2–5s on Python startup each time *and* serialises on the MSAL token-cache file lock on Windows, so a 17-region sweep takes minutes through the CLI and seconds over ARM.

## Binary layout

`package.json` declares two `bin` entries, both pointing at the same `dist/cli.js`:

| Name | Intended use |
|---|---|
| `az-where` | discoverable long form, good for docs and fresh onboarding |
| `azw` | short form, the form the README teaches |

## Source layout

### `src/cli.ts`

Entrypoint. Two responsibilities:

1. **Positional SKU shorthand** — before Commander parses `argv`, `rewritePositionalSku()` checks whether `argv[2]` is an unknown token shaped like a VM size (`B1s`, `D2s_v5`, `NC24ads_A100_v4`). If yes, it rewrites to `["regions", <normalized-sku>, ...]`. This is what makes `azw B1s` work.
2. Register commands (`where`, `regions`, `pick`, `quota`, `geos`), wire up the custom help formatter, and invoke Commander.

### `src/commands/`

| File | Verb |
|---|---|
| `where.ts` | `azw where` — current Azure subscription / user |
| `regions.ts` | `azw regions <sku>` — coloured verdict table (default when a SKU is given positionally) |
| `quota.ts` | `azw quota <sku>` — same scan, sorted by free vCPU descending |
| `pick.ts` | `azw pick <sku>` — one region name on stdout for scripting |
| `geos.ts` | `azw geos` — enumerate `geographyGroup` values the sub can see |

Handlers are thin: parse flags, call core helpers, print output.

### `src/core/az.ts`

The single boundary between `az-where` and the Azure CLI. No other module spawns processes. Uses `spawn` (not `exec`) to avoid shell-injection risk; shell is only enabled on Windows so `az.cmd` resolves. Detects "not logged in" and raises `AzNotLoggedInError` (exit code 2).

### `src/core/arm.ts`

Thin ARM client. `getToken()` shells out to `az account get-access-token` exactly once per process (memoised) and hands back the bearer + subscription id. `armList<T>(path)` does the actual `fetch`, follows `nextLink` pagination, and returns the flattened `value` array.

### `src/core/scan.ts`

Parallel per-region scanner over ARM. For each region it calls `GET /providers/Microsoft.Compute/skus?$filter=location eq '<r>'`; if the SKU is offered and not restricted, it follows up with `GET /providers/Microsoft.Compute/locations/<r>/usages` to resolve quota. Skipping the usage call for non-offered regions halves the ARM traffic in the typical case where a given SKU only lives in a handful of regions. Worker-pool concurrency defaults to 16 — `fetch` is cheap, the constraint is ARM's per-subscription rate limit, not local CPU.

Each `RegionVerdict` lands in one of five states:

| Verdict | Meaning |
|---|---|
| `AVAILABLE` | SKU offered, subscription allowed, quota `>= 1` |
| `QUOTA_UNKNOWN` | SKU offered, but `list-usage` returned no matching family row |
| `FULL` | SKU offered and allowed, but quota exhausted |
| `BLOCKED_FOR_SUB` | SKU offered, but this subscription carries a `NotAvailableForSubscription` restriction here — different fix (upgrade sub) than `SKU_NOT_OFFERED` (ask Microsoft) |
| `SKU_NOT_OFFERED` | Azure doesn't run the SKU in this region at all |

`sortVerdicts()` orders them deployable-first so the user's eye lands on green rows. By default [commands/regions.ts](../src/commands/regions.ts) and [commands/quota.ts](../src/commands/quota.ts) also **fold away** `SKU_NOT_OFFERED` rows from the table (they contribute nothing actionable) and replace them with a `+ N regions where Azure doesn't offer ...` note; `--all` restores the full table. `--json` always returns every row.

### `src/core/sku.ts`

`normalizeSku("B1s") -> "Standard_B1s"` and `looksLikeSku("regions") -> false`. These two functions drive the positional-SKU dispatch in `cli.ts`.

### `src/core/geo.ts`

Wraps `az account list-locations`. Maps user-facing aliases (`eu`, `us`, `asia`, `apac`) onto Azure's real `metadata.geographyGroup` values (`Europe`, `US`, `Asia Pacific`). Filters out non-physical regions (`regionType != 'Physical'`) and Microsoft-internal regions whose names end in `stg` (staging) or `euap` (early-access preview) — those show `regionType: "Physical"` but no customer subscription can deploy into them.

### `src/core/progress.ts`

`Progress(total, label, etaSeconds?)` with `.tick(subLabel, ok?)` and `.done()`. Three rendering modes:

| Condition | Mode |
|---|---|
| `--json` / `--name` / `--pick` | silent |
| non-TTY / `CI=true` / `NO_COLOR=1` | stderr log lines (`[1/12] westeurope ✓ 3.1s`) |
| interactive TTY | redrawing bar with rolling ETA (`[████░░░░] 4/12 · 1.1s elapsed · ~2.2s remaining · francecentral`), refreshed on a 250 ms heartbeat so the clock keeps ticking through slow calls |

ETA is `(elapsed / completed) * remaining`, a rolling mean that self-corrects as slower regions arrive.

### `src/core/color.ts`

Zero-dep ANSI wrappers (`c.green`, `c.red`, `c.yellow`, `c.dim`, `c.bold`, `c.cyan`, `c.gray`). When `colorEnabled()` returns false, each wrapper is the identity function — so call sites don't branch.

`colorEnabled()` is false when any of: `--json`, `--name`, `--pick`, `--compact`, `NO_COLOR`, `CI`, or non-TTY stdout.

Also exports `visibleLength` and `padVisible` so ANSI-wrapped cells pad correctly in tables.

### `src/core/output.ts`

- `printInfo` / `printError` / `printJson` / `printTable` — generic
- `printVerdictTable(rows)` — the REGION · GEO · LOCATION · OFFERED · QUOTA · VERDICT table with coloured cells
- `printFooter(rows, elapsedMs, sku)` — shortlist of deployable regions + scan time

### `src/core/errors.ts`

Typed errors and the centralised `exitWithError(err, json)` helper.

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | generic error / `az` failure / `pick` found nothing |
| 2 | not logged in (`az login` required) |
| 3 | validation / missing input in non-interactive mode |

### `src/core/help.ts`

Custom Commander help formatter applied recursively to all commands after registration. Adds section rules (`── Commands ────`) and a trailing newline.

### `src/core/runtime.ts`

`hasArg`, `isCompactMode`, `isNonInteractiveMode` — runtime flag helpers, consulted by `output.ts`, `color.ts`, `progress.ts`.

### `src/core/prompt.ts`

`ask(question, default)` — interactive readline prompt that throws `NonInteractiveError` in non-TTY or `--no-interactive` mode. Not yet used by any command; retained for future verbs that need interactive input.

### `src/core/types.ts`

TypeScript interfaces for the `az` JSON shapes this CLI consumes: `AzAccount`, `AzLocation`, `AzVmSku`, `AzVmUsage`, and the synthesised `RegionVerdict`.

## `tests/`

Vitest suite.

```
tests/
├── core/
│   ├── sku.test.ts           # normalizeSku / looksLikeSku edge cases (positional dispatch relies on these)
│   └── progress.test.ts      # ETA + non-TTY log fallback
└── smoke/
    └── cli-smoke.test.ts     # --version, --help, command presence, per-command help screens
```

## Auth and context model

`az-where` has **no config file and no stored credentials**. Every invocation calls `az account show` (or another `az` subcommand) and accepts whatever the Azure CLI currently resolves to — user, service principal, or managed identity.

This is intentional. Re-implementing auth would duplicate behaviour that `az` already handles correctly and would create a second credential store to leak or expire.

## Caching (planned)

Global SKU lists change rarely. v0.2 will cache `az vm list-skus` responses under the user's XDG cache directory with a short TTL (5–15 min) to cut repeated queries to instant.
