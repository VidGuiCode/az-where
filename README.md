<div align="center">

# az-where

**Find where your Azure subscription can run a VM, and where Azure advertises the resources you need.**

[![Latest GitHub release](https://img.shields.io/github/v/release/VidGuiCode/az-where?label=release&color=2563eb)](https://github.com/VidGuiCode/az-where/releases/latest)
[![CI](https://github.com/VidGuiCode/az-where/actions/workflows/ci.yml/badge.svg)](https://github.com/VidGuiCode/az-where/actions/workflows/ci.yml)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-43853d?logo=node.js&logoColor=white)](#install)
[![MIT license](https://img.shields.io/badge/license-MIT-64748b)](LICENSE)

[Install](#install) · [Find a region](#find-a-region) · [Preflight Terraform or Bicep](#preflight-terraform-or-bicep) · [Use in scripts](#use-in-scripts)

</div>

```bash
azw availability vm B1s --eu
```

```text
REGION          GEO   LOCATION    OFFERED   QUOTA       VERDICT
─────────────   ───   ─────────   ───────   ─────────   ────────────
westeurope      EU    Amsterdam   ✓         6/10 free   ✓ DEPLOY
francecentral   EU    Paris       ✓         0/10 free   ✗ QUOTA FULL

Ready to deploy Standard_B1s (1): westeurope
Scanned 2 regions in 1.4s.
```

*Illustrative output. Results depend on your subscription and current quota.*

| What you’re choosing | What az-where checks |
| --- | --- |
| **A VM size and region** | SKU offers, subscription restrictions, allowed-location policy and live VM-family vCPU quota. |
| **A region for a resource type** | Locations advertised by the Azure Resource Manager provider catalog, with allowed-location policy when available. |

`az-where` is an unofficial, read-only CLI. It uses your Azure CLI session and leaves deployment to your existing tools. VM verdicts reflect the checks above. Generic resource verdicts have **availability** confidence and leave service-specific SKU, quota, capacity, and deployment rules unverified.

## Install

Use **Node.js 20+** and **Azure CLI 2.11.0+**. The GitHub release tarball installs both `azw` and `az-where`.

```bash
npm install -g https://github.com/VidGuiCode/az-where/releases/download/v0.5.3/az-where-0.5.3.tgz
az login
azw --version
azw doctor
```

Use `azw where` to confirm the active subscription. To switch, run `az account set --subscription "<subscription id or name>"`. Run `azw update` to check GitHub for a newer release. It asks before installing in an interactive terminal.

<details>
<summary>Build and install from source</summary>

```bash
git clone https://github.com/VidGuiCode/az-where.git
cd az-where
npm ci
npm run build
npm install -g .
```

</details>

## Find a region

| Goal | Command |
| --- | --- |
| Scan European regions for one VM size | `azw availability vm B1s --eu` |
| Explain a VM verdict in one region | `azw check vm B1s --region westeurope` |
| Compare VM sizes across regions | `azw compare vm B1s,B2s,D2s_v5 --eu` |
| Pick a VM region for a script | `azw pick vm B1s --eu -o value` |
| Recommend a VM region using quota and proximity | `azw suggest vm B1s --eu --near Luxembourg` |
| Find regions that advertise a resource type | `azw availability resource storage-account --eu` |
| Explain a resource verdict in one region | `azw check resource key-vault --region westeurope` |
| Compare resource types across regions | `azw compare resource storage-account,key-vault --eu` |
| Pick a region advertising every requested type | `azw pick resource storage-account,key-vault --eu -o value` |
| Recommend a region for several types | `azw suggest resource storage-account,key-vault --eu --near Luxembourg` |

Resource commands accept aliases such as `storage-account` and full ARM types such as `Microsoft.Storage/storageAccounts`. Use `azw resources --namespace Microsoft.Storage` to explore the catalog.

<details>
<summary>Discover SKUs, quota, prices, and geography filters</summary>

| Goal | Command |
| --- | --- |
| List VM sizes advertised in a region | `azw skus --region westeurope --family B` |
| Find deployable VM sizes in a family | `azw available --family B --eu` |
| Find deployable sizes with retail price estimates | `azw available --family B --eu --price --currency EUR --sort price` |
| Estimate compute cost for one size and region | `azw price B2ats_v2 --region swedencentral --currency EUR` |
| Sort VM regions by free family vCPUs | `azw quota B1s --eu` |
| See geography groups visible to your subscription | `azw geos` |

`--eu`, `--us`, and `--asia` select the Azure geography groups Europe, US, and Asia Pacific. Use `--geography "<group>"` for other groups, and `--refresh` to bypass cached catalog data. VM availability hides sizes absent from a regional catalog in the table by default. Use `--all` to show those regions.

Retail prices estimate on-demand VM compute. The estimate excludes disks, bandwidth, taxes, credits, and account-specific discounts.

</details>

Run `azw <command> --help` for supported flags, or `azw availability vm --help` for an individual subcommand.

### Check a Storage SKU

```bash
azw check storage --kind StorageV2 --sku Standard_ZRS --region westeurope
```

The check reads the selected subscription’s Storage SKU catalog and evaluates allowed-location policy when available. It reports whether the requested combination is listed, explicitly restricted, absent from the catalog, or inconclusive. It does not check account quota, zone placement, or live capacity. See the [Storage JSON contract](docs/json-contracts.md#storage-check).

To scan a geography for the same configuration, run:

```bash
azw availability storage --kind StorageV2 --sku Standard_ZRS --eu
azw availability storage --kind StorageV2 --sku Standard_ZRS --eu -o name
```

The table and [JSON output](docs/json-contracts.md#storage-availability) show every evaluated region. Name output prints one advertised region per line.

Compare multiple account kind and SKU pairs on the same region axis:

```bash
azw compare storage "StorageV2/Standard_LRS,StorageV2/Standard_ZRS" --eu
```

Use `-o json` to read the verdict and evidence for every cell. [Storage comparison contract](docs/json-contracts.md#storage-comparison)

### Pick a Storage region for a script

```bash
azw pick storage --kind StorageV2 --sku Standard_ZRS --eu -o value
```

Pick returns the first advertised region in alphabetical order by ARM region name within the requested geography. It requires a successful allowed-location policy lookup unless you pass `--no-policy`. If no region qualifies, `-o value` writes nothing to stdout and exits `1`. Use `-o json` to inspect the selected region and its evidence. [Storage pick contract](docs/json-contracts.md#storage-pick)

## Preflight Terraform or Bicep

```bash
azw verify main.tf vm.tf
azw verify main.bicep -o json
```

`verify` checks literal VM locations and sizes, including scale sets, and looks up advertised locations for common resource types such as Storage accounts, Key Vault, web and function apps, service plans, AKS, and PostgreSQL flexible servers.

Storage accounts also get a subscription-scoped SKU check when all required values are literal. In Terraform, set `location`, `account_kind`, `account_tier`, and `account_replication_type`. For example, `Standard` and `ZRS` form `Standard_ZRS`. In Bicep, set `location`, `kind`, and `sku.name`. The check uses the same Storage catalog and allowed-location policy rules as `azw check storage`. Its confidence is availability. Account quota and live capacity are outside the check.

`verify` exits `1` for a blocked VM or generic resource check, or when a checked Storage configuration is restricted, unlisted, inconclusive, or denied by policy. Dynamic or missing values and unknown region literals appear as skips with their file and line. Skips alone exit `0`. In JSON, `storageAccounts` appears when the files include recognized Storage accounts. [Preflight JSON contract](docs/json-contracts.md#azw-verify-files--o-json-since-047)

## Use in scripts

Capture a region and proceed only if the pick succeeds.

**Bash**

```bash
region=$(azw pick vm B1s --eu -o value) || exit $?
terraform plan -var="location=$region"
```

**PowerShell**

```powershell
$region = azw pick vm B1s --eu -o value
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
terraform plan "-var=location=$region"
```

Use `-o json` for formatted JSON or `-o compact` for one-line JSON. `check` returns an explanation alongside its verdict, and `compare` returns a shared region axis with one result per requested target. See the [JSON contracts](docs/json-contracts.md) for exact fields and exit behavior.

| Output mode | Where to use it |
| --- | --- |
| `table` | Human output |
| `json`, `compact` | Structured results |
| `value` | A `check` verdict or a region from `pick` or `suggest` |
| `name` | Region names from `availability` or `regions`, SKU names from `skus`, or ARM types from `resources` |

### Exit codes

| Exit | Meaning |
| --- | --- |
| `0` | Command succeeded |
| `1` | No qualifying result, a blocked check, or a runtime error |
| `2` | Azure login required |
| `3` | Input validation failed |
| `4` | `doctor` found a failed prerequisite |
| `127` | Azure CLI missing outside the `doctor` checklist |

Machine output suppresses progress. Set `NO_COLOR=1` for plain terminal output, `CI=true` for log-style progress, or `AZ_WHERE_NO_UPDATE_CHECK=1` to skip automatic GitHub release checks.

## Project links

| Looking for | Read |
| --- | --- |
| Upcoming work, research tasks, and release history | [Roadmap](docs/roadmap.md#work-queue) · [Changelog](CHANGELOG.md) |
| Command design and script output | [Command standard](docs/command-standard.md) · [JSON contracts](docs/json-contracts.md) |
| How the CLI works and how to contribute | [Architecture](docs/architecture.md) · [Contributing](CONTRIBUTING.md) |

[Issues](https://github.com/VidGuiCode/az-where/issues) · [MIT license](LICENSE) · [Trademark notice](TRADEMARKS.md)
