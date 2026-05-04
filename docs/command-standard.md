# CLI Command Standard

This document keeps future `azw` command design consistent as the tool grows from deep VM checks into broader Azure availability discovery.

## Product Boundary

`azw` is a read-only availability discovery CLI.

It should answer:

- what Azure regions exist for the current subscription
- whether a resource capability is advertised in a region
- whether a VM SKU can actually deploy in a region
- why a region is blocked when Azure exposes enough signal
- what location a deployment script should use

It should not:

- create Azure resources
- modify Azure resources
- replace `az`, Terraform, Bicep, Pulumi, or CI/CD deployment systems
- hide uncertainty when Azure APIs do not expose enough information

The clean split is:

```text
az gives raw Azure facts and performs operations.
azw combines read-only facts into availability answers for humans and scripts.
```

## Why azw Exists When az Already Exists

Azure CLI already exposes most building blocks:

| Need | Raw Azure CLI shape |
|---|---|
| List subscription locations | `az account list-locations` |
| Inspect providers/resource types | `az provider list`, `az provider show` |
| Inspect VM SKU availability | `az vm list-skus --location <region>` |
| Inspect VM quota/usage | `az vm list-usage --location <region>` |
| Script output | `--output json`, `--output tsv` |

The problem is that users often need several commands, repeated region loops, and manual interpretation.

`azw` should turn that into one focused answer:

```bash
azw check vm B1s --region westeurope -o json
azw availability resource storage-account --eu
azw pick vm B1s --eu -o value
```

## Canonical Grammar

Future docs and new commands should teach one grammar:

```text
azw <verb> <kind> <target> [scope flags] [output flags]
```

Examples:

```bash
azw check vm B1s --region westeurope
azw availability vm B1s --eu
azw pick vm B1s --eu
azw suggest vm B1s --eu --near Luxembourg
azw compare vm B1s,B2s,D2s_v5 --eu

azw check resource storage-account --region westeurope
azw availability resource storage-account --eu
```

The grammar should feel the same for VMs and non-VM resources. Avoid teaching one shape for VMs and a different shape for everything else.

## Verbs

Keep the verb list small.

| Verb | Meaning |
|---|---|
| `check` | Check one target in exactly one region |
| `availability` | Scan one target across multiple regions |
| `pick` | Return one best script value |
| `suggest` | Return one human recommendation with a reason |
| `compare` | Compare multiple targets across multiple regions |
| `verify` | Inspect an IaC file before deployment |

Do not add new verbs unless an existing verb cannot describe the user intent.

## Kinds

Start with only:

| Kind | Meaning |
|---|---|
| `vm` | Deep VM SKU deployability checks |
| `resource` | Generic Azure resource type availability checks |

Do not use `provider` as the user-facing kind. Provider is Azure's internal language; users think in resources.

The raw Azure provider/resource type should still be accepted as an expert target:

```bash
azw check resource Microsoft.Storage/storageAccounts --region westeurope
```

But docs should prefer friendly aliases:

```bash
azw check resource storage-account --region westeurope
```

## Resource Aliases

Common resources should have stable friendly aliases that map to Azure resource type strings.

Initial alias table:

| Alias | Azure resource type |
|---|---|
| `storage-account` | `Microsoft.Storage/storageAccounts` |
| `key-vault` | `Microsoft.KeyVault/vaults` |
| `web-app` | `Microsoft.Web/sites` |
| `app-service-plan` | `Microsoft.Web/serverfarms` |
| `aks` | `Microsoft.ContainerService/managedClusters` |
| `postgres-flexible-server` | `Microsoft.DBforPostgreSQL/flexibleServers` |

Rules:

- Aliases are lowercase kebab-case.
- Aliases should name the common Azure resource, not the provider namespace.
- Raw Azure resource type strings remain valid for advanced users.
- Do not create deep service behavior just because an alias exists. Alias availability is only generic resource discovery unless a deeper command is implemented.

## Compatibility Rule

Existing VM commands must keep working:

```bash
azw B1s --eu
azw regions B1s --eu
azw pick B1s --eu
azw suggest B1s --eu --near Luxembourg
azw quota B1s --eu
azw available --family B --eu
azw skus --eu --family B
azw price B2ats_v2 --region swedencentral
```

These are compatibility shortcuts for the current VM surface. They should remain supported, but new docs should prefer canonical explicit forms:

| Compatibility shortcut | Canonical form |
|---|---|
| `azw B1s --eu` | `azw availability vm B1s --eu` |
| `azw regions B1s --eu` | `azw availability vm B1s --eu` |
| `azw pick B1s --eu` | `azw pick vm B1s --eu` |
| `azw suggest B1s --eu` | `azw suggest vm B1s --eu` |

Do not add new shortcut grammars for new resource kinds.

## Top-Level Command Rule

Avoid new top-level resource nouns.

Do not add this early:

```bash
azw storage ...
azw postgres ...
azw aks ...
azw appservice ...
```

Use generic resource availability first:

```bash
azw availability resource storage-account --eu
azw check resource aks --region westeurope
```

Promote a resource to a first-class kind only when it has enough deep, service-specific logic to justify it.

For example, a future `storage` kind would need to check more than generic resource-type availability:

```bash
azw check storage --kind StorageV2 --replication LRS --region westeurope
```

Until then, keep it under `resource`.

## Scope Flags

Scope flags should be consistent across commands:

| Flag | Meaning |
|---|---|
| `--region <name>` | Check exactly one Azure region |
| `--eu` | Europe shortcut |
| `--us` | United States shortcut |
| `--asia` | Asia Pacific shortcut |
| `--geography <group>` | Exact Azure `geographyGroup` |
| `--near <city>` | Ranking hint for recommendation commands |
| `--refresh` | Bypass low-risk cached list data |
| `--no-policy` | Skip Azure Policy allowed-location checks when relevant |

Commands that require one region should fail with a validation error if a broad geography flag is used instead.

Commands that scan multiple regions should accept geography filters.

## Output Standard

All user-facing discovery commands should support a machine-readable mode.

Standard output flag:

```bash
--output table|json|compact|value|name
-o table|json|compact|value|name
```

`-o` should behave like Azure CLI's output shorthand. It should be available anywhere `--output` is available.

Output modes:

| Mode | Meaning |
|---|---|
| `table` | Human-readable default output |
| `json` | Pretty structured JSON |
| `compact` | One-line structured JSON |
| `value` | Exactly one shell-friendly value; fail if there is no single value |
| `name` | One resource or region name per line |

Compatibility mapping:

| Current flag | Equivalent standard form |
|---|---|
| `--json` | `--output json` |
| `--json --compact` | `--output compact` |
| `--name` | `--output name` |

Rules:

- Human output goes to stdout.
- Progress goes to stderr.
- JSON/value modes suppress progress.
- Scripts should have stable fields and stable exit codes.
- `value` should emit exactly one shell-friendly value or fail.
- `name` should emit one resource or region name per line.
- Human tables can change cosmetically; JSON field names should not change casually.
- `--output` / `-o` should be preferred in new docs and examples.
- Existing `--json`, `--compact`, and `--name` flags should remain as compatibility aliases.

## Verdict Standard

VM checks can produce strong deployability verdicts because `azw` can combine SKU, subscription restriction, quota, and policy signals.

Generic resource checks should use availability/confidence verdicts instead of pretending full deployability is known.

Recommended shared verdict vocabulary:

| Verdict | Meaning |
|---|---|
| `AVAILABLE` | All required checks for this kind passed |
| `LOCATION_SUPPORTED` | Azure location is visible to the subscription |
| `RESOURCE_SUPPORTED` | Resource type is advertised for the region |
| `RESOURCE_NOT_SUPPORTED` | Resource type is not advertised for the region |
| `SKU_SUPPORTED` | SKU/tier appears supported for the region |
| `POLICY_DENIED` | Azure Policy blocks the region |
| `BLOCKED_FOR_SUB` | Azure reports the subscription is blocked |
| `QUOTA_FULL` | Known quota is insufficient |
| `QUOTA_UNKNOWN` | Quota could not be matched or read |
| `SKU_NOT_OFFERED` | SKU is not offered in that region |
| `UNKNOWN_SERVICE_RULES` | Azure does not expose enough data for a stronger verdict |

Every JSON result should include:

```json
{
  "kind": "vm",
  "target": "Standard_B1s",
  "region": "westeurope",
  "verdict": "AVAILABLE",
  "confidence": "deployability",
  "checks": []
}
```

Confidence values:

| Confidence | Meaning |
|---|---|
| `deployability` | Strong enough to use for deployment script selection |
| `availability` | Azure advertises support, but not all deployability checks are known |
| `unknown` | The command can only report partial information |

## Proposed Command List

### Canonical Near-Term Commands

| Command | Purpose |
|---|---|
| `azw availability vm <sku> [scope]` | Deep VM regional deployability table |
| `azw check vm <sku> --region <name>` | One-region VM deployability verdict |
| `azw pick vm <sku> [scope]` | Script-first VM region picker |
| `azw suggest vm <sku> [scope]` | Human VM recommendation |
| `azw compare vm <sku-list> [scope]` | Matrix across VM sizes and regions |
| `azw availability resource <alias-or-type> [scope]` | Generic resource availability scan |
| `azw check resource <alias-or-type> --region <name>` | One-region generic resource availability check |

### Existing VM Compatibility Commands

| Command | Status | Notes |
|---|---|---|
| `azw <sku>` | keep | Shortcut for `azw availability vm <sku>` |
| `azw regions <sku>` | keep | Legacy name for VM availability |
| `azw pick <sku>` | keep | Shortcut for `azw pick vm <sku>` |
| `azw suggest <sku>` | keep | Shortcut for `azw suggest vm <sku>` |
| `azw quota <sku>` | keep | VM quota lens |
| `azw available --family <prefix>` | keep | Deployable VM SKU family search |
| `azw skus` | keep | VM SKU discovery |
| `azw price <sku> --region <name>` | keep | VM compute price estimate |

### Later, After API Research

| Command | Purpose |
|---|---|
| `azw check storage --kind <kind> --replication <type> --region <name>` | Deep storage availability check |
| `azw availability storage --kind <kind> --replication <type> [scope]` | Deep storage scan |
| `azw check postgres --sku <sku> --region <name>` | Deep PostgreSQL availability check |
| `azw check aks --node-size <sku> --region <name>` | AKS availability with VM node-size check |
| `azw check appservice --plan <sku> --region <name>` | App Service plan availability check |
| `azw verify <file.tf | file.bicep>` | IaC preflight, starting VM-only and broadening over time |

## Naming Decisions

Use `resource`, not `provider`, in user-facing commands.

Use friendly resource aliases first, raw Azure resource types second.

Use `availability`, not `regions`, for the canonical scan verb. `regions` remains a VM compatibility command.

Use `compare`, not `matrix`, for the command name. Matrix describes one output format; compare describes the user intent.

Use `check` for exactly one target in exactly one region.

Use `availability` for scanning one target across many regions.

Use `pick` only when the command emits one best script value.

Use `suggest` only when the command explains a human recommendation.

Do not add new shortcuts for new resource kinds.
