<div align="center">

# `az-where`

**What and where can my Azure subscription deploy?**

[![Release](https://img.shields.io/badge/release-v0.4.7-cb3837?logo=github&logoColor=white)](https://github.com/VidGuiCode/az-where/releases)
[![License](https://img.shields.io/badge/license-MIT-22c55e.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-3c873a?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178c6?logo=typescript&logoColor=white)](tsconfig.json)

</div>

```bash
azw availability vm B1s --eu
```

`az-where` is a read-only Azure availability discovery CLI. Today it has deep VM support: it checks Azure Policy allowed locations, VM SKU availability, subscription restrictions, and vCPU quota across regions, then prints the places where the size can actually deploy.

It does not deploy resources. Use it to choose or check a location, then use `az`, Terraform, Bicep, or your CI/CD system to deploy.

It is an unofficial community CLI. It wraps the official [Azure CLI (`az`)](https://learn.microsoft.com/cli/azure/) for authentication and uses ARM REST for the region checks. It never stores credentials.

## Install

Requires **Node 20+** and the **Azure CLI** installed and logged in:

```bash
az login
```

Install the current release:

```bash
npm install -g https://github.com/VidGuiCode/az-where/releases/download/v0.4.7/az-where-0.4.7.tgz
```

Or build from source:

```bash
git clone https://github.com/VidGuiCode/az-where.git
cd az-where
npm install
npm run build
npm install -g .
```

Verify:

```bash
azw --version
azw where
```

Two binaries are installed: `azw` and `az-where`. They are the same tool.

## Quick Start

| Need | Command |
|---|---|
| Check a VM size globally | `azw availability vm B1s` |
| Check only Europe / US / Asia Pacific | `azw availability vm B1s --eu` / `--us` / `--asia` |
| Check one VM size in one region | `azw check vm B1s --region westeurope` |
| Compare several VM sizes at once | `azw compare vm B1s,B2s,D2s_v5 --eu` |
| Preflight Terraform/Bicep before apply | `azw verify main.tf vm.tf` |
| Print one deployable region | `azw pick vm B1s` |
| Get a recommended region with a reason | `azw suggest vm B1s --eu --near Luxembourg` |
| Check generic resource availability | `azw availability resource storage-account --eu` |
| Check one resource in one region | `azw check resource storage-account --region westeurope` |
| Find deployable SKUs in a family | `azw available --family B --eu` |
| Compare deployable family options with price | `azw available --family B --eu --price --currency EUR --sort price` |
| Price one VM size in one region | `azw price B2ats_v2 --region swedencentral --currency EUR` |
| Sort deployable regions by quota headroom | `azw quota B1s` |
| List geography groups your subscription sees | `azw geos` |
| Discover VM SKU names, even if not deployable | `azw skus --eu --family B` |
| Show current Azure identity/subscription | `azw where` |
| Verify prerequisites (az, login, token) | `azw doctor` |
| Check/install a newer release | `azw update` |

## Example Output

```text
REGION              GEO    LOCATION          OFFERED   QUOTA        VERDICT
-----------------   ----   ---------------   -------   ----------   --------------
westeurope          EU     Amsterdam         yes       6/10 free    DEPLOY
francecentral       EU     Paris             yes       0/10 free    QUOTA FULL
germanywestcentral  EU     Frankfurt         no        -            SKU NOT OFFERED
denmarkeast         EU     Copenhagen        no        -            POLICY DENIED

Ready to deploy Standard_B1s (1): westeurope
Scanned 17 regions in 5.8s.
```

`check` commands explain the verdict right under the table:

```text
REGION     GEO    LOCATION    OFFERED   QUOTA       VERDICT
--------   ----   ---------   -------   ---------   -------------
westeurope EU     Amsterdam   yes       0/4 free    QUOTA FULL

Reason: Standard_B1s needs 2 vCPUs but family standardBSFamily has only 0/4 free in westeurope — 2 vCPUs short.
  Hint: Request a quota increase (Azure Portal → Quotas) or free up vCPUs, then re-check.
```

`verify` runs those same checks over your infrastructure code before you deploy it, and also checks common generic resources (storage accounts, key vaults, web/function apps, service plans, AKS, PostgreSQL flexible servers) against the regions your files name — availability confidence, never a deployability claim:

```text
RESOURCE   SKU    REGION       VERDICT          QUOTA
--------   ----   ----------   --------------   ---------
vm         B1s    westeurope   ✓ DEPLOY         6/10 free
vm_win     D2s_v5 westeurope   ✗ QUOTA FULL     0/10 free

Reason: vm_win @ main.tf:32 — Standard_D2s_v5 needs 4 vCPUs but family standardDDSv5Family has only 0/10 free in westeurope — 4 vCPUs short.
  Hint: Request a quota increase (Azure Portal → Quotas) or free up vCPUs, then re-check.
1 of 2 checked VM resources cannot deploy as written.

Generic resources (availability, not deployability):
RESOURCE   TYPE             REGION       VERDICT         CONFIDENCE
--------   ----             ----------   --------------  ------------
stg        storage-account  westeurope   ✓ SUPPORTED     availability

Skipped 1 resource — not statically checkable:
  vmss @ main.tf:48 — var.location (dynamic-location)
```

Only statically-literal `location`/`size` pairs are checked; resources driven by variables are listed as skipped with the expression echoed, never guessed.

During scans, stderr shows progress immediately, including the initial Azure token/region lookup, then switches to the per-region progress bar when the region count is known.

## Commands

```bash
azw availability vm <sku>
                         # canonical VM availability scan
azw availability resource <alias-or-type>
                         # generic Azure resource availability scan
azw check vm <sku> --region <name>
                         # one-region VM deployability verdict
azw check resource <alias-or-type> --region <name>
                         # one-region generic resource availability verdict
azw compare vm <sku-list>
                         # region × size deployability matrix (e.g. B1s,B2s,D2s_v5)
azw verify <files...>    # preflight .tf/.bicep files: check VM size pairs and
                         # generic resource regions before terraform apply / az deployment
azw pick vm <sku>        # one deployable region name for scripts
azw suggest vm <sku>     # recommended region with a short explanation
azw regions <sku>        # compatibility shortcut for VM availability
azw pick <sku>           # compatibility shortcut
azw suggest <sku>        # compatibility shortcut
azw available --family B # deployable VM SKUs in a family
azw price <sku> --region <name>
                         # estimated retail compute price
azw quota <sku>         # quota-focused view, sorted by free vCPUs
azw skus                # discover VM SKU names
azw geos                # list Azure geographyGroup values
azw where               # show current Azure account context
azw doctor              # pass/fail checklist: az install, version, login, token
azw update              # check for updates and ask before installing
```

Run `azw <command> --help` for command-specific flags.

## Useful Flags

| Flag | Purpose |
|---|---|
| `--eu`, `--us`, `--asia` | Filter to common geography groups |
| `--geography <group>` | Filter to any exact Azure `geographyGroup` |
| `--concurrency <n>` | Parallel ARM requests during scans, default `16` |
| `--refresh` | Bypass cached location/SKU data |
| `--price` | Add Azure retail compute estimates to `available` |
| `--currency <code>` | Currency for pricing, e.g. `USD` or `EUR` |
| `--os <linux\|windows>` | OS pricing lens for VM compute rates |
| `--json` | Structured JSON output; progress stays off |
| `--compact` | One-line JSON for scripts and agents |
| `--name` | Compatibility alias for `-o name` where name output is supported |
| `-o, --output <mode>` | Standard output mode: `table`, `json`, `compact`, `value`, or `name` |
| `--no-policy` | Skip Azure Policy allowed-location checks |
| `--no-update-check` | Skip the once-per-day release check |

Environment:

- `NO_COLOR=1` disables ANSI colour.
- `CI=true` disables live redraws and uses log-style progress.
- `AZ_WHERE_NO_UPDATE_CHECK=1` disables the automatic update check.

Exit codes: `0` success, `1` no deployable region or generic error, `2` Azure auth required, `3` validation error, `4` `azw doctor` found a missing prerequisite.

## Auth And Safety

`az-where` uses the current Azure CLI context. If `az account show` points at a subscription, that is the subscription `az-where` scans. To switch:

```bash
az account set --subscription "<subscription id or name>"
```

The scanner is read-only. It calls ARM endpoints for locations, policy assignments, VM SKUs, and usage/quota; it never creates, modifies, or deletes Azure resources.

## How It Works

`az-where` asks the Azure CLI for a bearer token with `az account get-access-token`, then calls Azure Resource Manager directly over HTTPS.

The main read-only ARM calls are:

- `GET /subscriptions/{id}/locations`
- `GET /subscriptions/{id}/providers/Microsoft.Authorization/policyAssignments`
- `GET /subscriptions/{id}/providers`
- `GET /subscriptions/{id}/providers/Microsoft.Compute/skus`
- `GET /subscriptions/{id}/providers/Microsoft.Compute/locations/{region}/usages`

Location and SKU responses are cached briefly for faster repeated scans. Policy and quota/usage responses are always live so deployability decisions do not use stale restrictions or quota.

Pricing uses the public Azure Retail Prices API. It is an estimate for VM compute only; disks, bandwidth, taxes, credits, reservations, savings plans, and account-specific discounts are not included.

## Scripting

```bash
terraform apply -var="location=$(azw pick vm B1s --eu -o value)"
```

`pick` exits with code `1` if no region qualifies, including when all otherwise-good regions are blocked by Azure Policy, so deployment scripts fail fast instead of receiving an unusable location.

For machine-readable output:

```bash
azw availability vm B1s --eu -o compact
azw check vm B1s --region westeurope -o json
azw availability resource storage-account --eu -o json
azw compare vm B1s,B2s,D2s_v5 --eu -o json
azw verify main.tf -o json
```

`verify` exits `1` when a checked pair is blocked — a VM pair that cannot deploy, or a generic resource that is not advertised (or policy-denied) in the region its file names — so it can gate a CI step before `terraform apply`; resources with dynamic values are reported as skipped and never fail the run.`

`compare vm` emits a stable matrix contract for choosing fallback sizes: a top-level `regions` axis plus one result per requested SKU with `deployableRegions`, `deployableCount`, and `verdictCounts`, so scripts can walk the SKU order and pick the first that deploys in a target region.

Field-level JSON shapes for `availability`, `check`, `pick`, `suggest`, `compare`, and `verify` are documented as stable contracts in [docs/json-contracts.md](docs/json-contracts.md), pinned by tests. `check` payloads carry an `explanation` object (`code`, `reason`, `hint`) so agents get the same evidence-based blocker details humans see:

```json
{
  "verdict": "FULL",
  "explanation": {
    "code": "FULL",
    "reason": "Standard_B1s needs 2 vCPUs but family standardBSFamily has only 0/4 free in westeurope — 2 vCPUs short.",
    "hint": "Request a quota increase (Azure Portal → Quotas) or free up vCPUs, then re-check."
  }
}
```

`value` and `name` are intentionally narrower than JSON: they are only enabled on commands where the output has a stable single-value or one-name-per-line meaning. Unsupported combinations fail as validation errors before any Azure calls.

Before running azw in CI, you can gate on the environment itself:

```bash
azw doctor || exit 1   # exits 4 with a checklist if az/login/token is broken
```

## Development

```bash
bun install
bun run dev -- B1s --eu
bun run typecheck
bun test
```

More details live in [docs/architecture.md](docs/architecture.md), with future ideas in [docs/roadmap.md](docs/roadmap.md). Future command naming and output rules are tracked in [docs/command-standard.md](docs/command-standard.md).

## License

[MIT](LICENSE). See [TRADEMARKS.md](TRADEMARKS.md) for Microsoft/Azure trademark notes.
