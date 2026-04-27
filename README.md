<div align="center">

# `az-where`

**Where in Azure can I actually deploy this VM size?**

[![Release](https://img.shields.io/badge/release-v0.3.3-cb3837?logo=github&logoColor=white)](https://github.com/VidGuiCode/az-where/releases)
[![License](https://img.shields.io/badge/license-MIT-22c55e.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-3c873a?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178c6?logo=typescript&logoColor=white)](tsconfig.json)

</div>

```bash
azw B1s --eu
```

`az-where` checks Azure VM SKU availability, subscription restrictions, and vCPU quota across regions, then prints the places where the size can actually deploy.

It is an unofficial community CLI. It wraps the official [Azure CLI (`az`)](https://learn.microsoft.com/cli/azure/) for authentication and uses ARM REST for the region checks. It never stores credentials.

## Install

Requires **Node 20+** and the **Azure CLI** installed and logged in:

```bash
az login
```

Install the current release:

```bash
npm install -g https://github.com/VidGuiCode/az-where/releases/download/v0.3.3/az-where-0.3.3.tgz
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
| Check a VM size globally | `azw B1s` |
| Check only Europe / US / Asia Pacific | `azw B1s --eu` / `--us` / `--asia` |
| Print one deployable region | `azw pick B1s` |
| Get a recommended region with a reason | `azw suggest B1s --eu --near Luxembourg` |
| Sort deployable regions by quota headroom | `azw quota B1s` |
| List geography groups your subscription sees | `azw geos` |
| Discover VM SKU names | `azw skus --eu --family B` |
| Show current Azure identity/subscription | `azw where` |
| Check for a newer release | `azw update` |

## Example Output

```text
REGION              GEO    LOCATION          OFFERED   QUOTA        VERDICT
-----------------   ----   ---------------   -------   ----------   --------------
westeurope          EU     Amsterdam         yes       6/10 free    DEPLOY
francecentral       EU     Paris             yes       0/10 free    QUOTA FULL
germanywestcentral  EU     Frankfurt         no        -            SKU NOT OFFERED

Ready to deploy Standard_B1s (1): westeurope
Scanned 17 regions in 5.8s.
```

During scans, stderr shows progress immediately, including the initial Azure token/region lookup, then switches to the per-region progress bar when the region count is known.

## Commands

```bash
azw regions <sku>       # full availability table; also used by `azw B1s`
azw pick <sku>          # one deployable region name for scripts
azw suggest <sku>       # recommended region with a short explanation
azw quota <sku>         # quota-focused view, sorted by free vCPUs
azw skus                # discover VM SKU names
azw geos                # list Azure geographyGroup values
azw where               # show current Azure account context
azw update              # print update/install commands
```

Run `azw <command> --help` for command-specific flags.

## Useful Flags

| Flag | Purpose |
|---|---|
| `--eu`, `--us`, `--asia` | Filter to common geography groups |
| `--geography <group>` | Filter to any exact Azure `geographyGroup` |
| `--concurrency <n>` | Parallel ARM requests during scans, default `16` |
| `--json` | Structured JSON output; progress stays off |
| `--compact` | One-line JSON for scripts and agents |
| `--name` | Region names only, for `regions` / `pick` |
| `--no-update-check` | Skip the once-per-day release check |

Environment:

- `NO_COLOR=1` disables ANSI colour.
- `CI=true` disables live redraws and uses log-style progress.
- `AZ_WHERE_NO_UPDATE_CHECK=1` disables the update banner.

Exit codes: `0` success, `1` no deployable region or generic error, `2` Azure auth required, `3` validation error.

## Auth And Safety

`az-where` uses the current Azure CLI context. If `az account show` points at a subscription, that is the subscription `az-where` scans. To switch:

```bash
az account set --subscription "<subscription id or name>"
```

The scanner is read-only. It calls ARM endpoints for locations, VM SKUs, and usage/quota; it never creates, modifies, or deletes Azure resources.

## How It Works

`az-where` asks the Azure CLI for a bearer token with `az account get-access-token`, then calls Azure Resource Manager directly over HTTPS.

The main read-only ARM calls are:

- `GET /subscriptions/{id}/locations`
- `GET /subscriptions/{id}/providers/Microsoft.Compute/skus`
- `GET /subscriptions/{id}/providers/Microsoft.Compute/locations/{region}/usages`

Location and SKU responses are cached briefly for faster repeated scans. Quota/usage responses are always live so deployability decisions do not use stale quota.

## Scripting

```bash
terraform apply -var="location=$(azw pick B1s --eu)"
```

`pick` exits with code `1` if no region qualifies, so deployment scripts fail fast instead of receiving an empty location.

For machine-readable output:

```bash
azw B1s --eu --json --compact
```

## Development

```bash
bun install
bun run dev -- B1s --eu
bun run typecheck
bun test
```

More details live in [docs/architecture.md](docs/architecture.md), with future ideas in [docs/roadmap.md](docs/roadmap.md).

## License

[MIT](LICENSE). See [TRADEMARKS.md](TRADEMARKS.md) for Microsoft/Azure trademark notes.
