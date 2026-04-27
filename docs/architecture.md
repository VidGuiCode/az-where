# Architecture

## Product Shape

`az-where` is a local, read-only CLI that answers "where in Azure can I actually deploy this?" It delegates authentication to the official Azure CLI and calls Azure Resource Manager directly for the hot paths.

Two boundaries talk to Azure:

- **Azure CLI (`az`)**: used for account context and `az account get-access-token`.
- **ARM REST (`fetch`)**: used for locations, policy assignments, Compute SKU lists, and per-region usage/quota.

The tool never creates, modifies, or deletes Azure resources.

## CLI Layout

`package.json` exposes two binaries that both point at `dist/cli.js`:

| Name | Intended use |
|---|---|
| `az-where` | Long, discoverable form |
| `azw` | Short form used in examples |

`src/cli.ts` registers commands and rewrites positional SKU shorthand. For example, `azw B1s --eu` becomes `azw regions Standard_B1s --eu` before Commander parses arguments.

## Commands

| File | Verb |
|---|---|
| `where.ts` | `azw where` - current Azure subscription and user |
| `regions.ts` | `azw regions <sku>` - full availability table |
| `pick.ts` | `azw pick <sku>` - one region name for scripts |
| `suggest.ts` | `azw suggest <sku>` - recommended region with a short reason |
| `quota.ts` | `azw quota <sku>` - quota-focused view sorted by free vCPUs |
| `geos.ts` | `azw geos` - geography groups visible to the subscription |
| `skus.ts` | `azw skus` - VM SKU discovery |
| `update.ts` | `azw update` - latest-release check and confirmed install flow |

Command handlers stay thin: parse flags, call core helpers, print output.

## Core Flow

`src/core/arm.ts` gets one bearer token from `az account get-access-token`, memoizes it for the process, and sends ARM HTTPS requests under the selected subscription.

`src/core/geo.ts` reads locations from ARM and filters out non-physical/internal regions.

`src/core/policy.ts` reads subscription policy assignments and extracts enforced allowed-location lists.

`src/core/scan.ts` scans regions in parallel. For each region it:

1. Applies Azure Policy allowed-location restrictions when enabled.
2. Reads location-filtered Compute SKUs.
3. Checks whether the target VM SKU exists.
4. Checks `NotAvailableForSubscription` restrictions.
5. Reads live usage/quota for the SKU family only when the SKU is offered and allowed.

Quota/usage is intentionally never cached.

## Verdicts

| Verdict | Meaning |
|---|---|
| `AVAILABLE` | SKU offered, subscription allowed, quota `>= 1` |
| `QUOTA_UNKNOWN` | SKU offered, but usage/quota could not be matched |
| `FULL` | SKU offered and allowed, but quota exhausted |
| `BLOCKED_FOR_SUB` | SKU offered, but this subscription is blocked in that region |
| `POLICY_DENIED` | Azure Policy allowed-location assignment blocks deployment in that region |
| `SKU_NOT_OFFERED` | Azure does not offer the SKU in that region |

`sortVerdicts()` orders deployable rows first. Human tables hide `SKU_NOT_OFFERED` rows by default; JSON keeps every row.

## Cache

`src/core/cache.ts` caches low-risk ARM list responses for 10 minutes under the platform cache directory:

- `/locations`
- subscription-wide Compute SKU list
- location-filtered Compute SKU list

`--refresh` bypasses cached ARM data. Usage/quota endpoints are never cached so deployability decisions do not use stale quota.

Policy assignments are not cached in v0.3.5. Policy remains live because it can directly decide whether `pick` may safely return a region for Terraform or scripts.

## Suggestion

`src/core/suggest.ts` powers `azw suggest`. It considers only `AVAILABLE` regions, prefers more free quota, optionally applies proximity with a built-in coordinate table, and uses region name as a stable tie-break.

`pick` remains strict and script-first. `suggest` is the human-facing recommendation command.

## Output Modes

- Human table output uses ANSI-aware padding and color when supported.
- `--json` prints structured JSON and suppresses progress.
- `--compact` prints one-line JSON.
- `--name` prints region names only where supported.

Progress uses stderr and switches between live redraw on TTY and log lines in CI/non-TTY. Machine-readable modes stay quiet.

## Auth And Errors

`src/core/az.ts` is the only process-spawning boundary. It detects missing Azure CLI and not-logged-in states.

`src/core/errors.ts` owns typed errors and exit codes:

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Generic failure, ARM failure, or no deployable region |
| `2` | Azure login required |
| `3` | Validation error |
| `127` | Azure CLI missing |

ARM HTTP errors include status code, endpoint, ARM error code, and ARM message when available. JSON error output exposes those details.
