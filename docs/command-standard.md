# CLI command standard

[README](../README.md) · [Architecture](architecture.md) · [JSON contracts](json-contracts.md)

`azw` reads Azure metadata and turns it into availability verdicts. Keep Azure operations read-only, delegate authentication to `az`, and show the confidence supported by the evidence.

## Command grammar

```text
azw <verb> <kind> <target> [scope] [output options]
```

| Verb | Intent | Example |
| --- | --- | --- |
| `check` | Explain one target’s verdict in one region | `azw check vm B1s --region westeurope` |
| `availability` | Scan regions for one target | `azw availability resource storage-account --eu` |
| `compare` | Compare several targets across regions | `azw compare vm B1s,B2s,D2s_v5 --eu` |
| `pick` | Return a region name for automation | `azw pick resource storage-account,key-vault --eu -o value` |
| `suggest` | Recommend a region and explain the choice | `azw suggest vm B1s --eu --near Luxembourg` |

Use `vm` for VM SKU checks and `resource` for provider-catalog checks. Use existing verbs for new intents when they fit. A new resource kind warrants distinct service-specific evidence. Keep generic catalog checks under `resource`.

`compare` takes a comma-separated list of VM SKUs or resource targets. Resource `pick` and `suggest` also accept a comma-separated list and require every target to be advertised in the chosen region. A single resource target works with either command.

### Commands outside the grammar

| Command | Purpose |
| --- | --- |
| `verify <files...>` | Preflight supported resources in Terraform or Bicep using literal values |
| `geos`, `skus`, `resources` | Discover geography groups, VM sizes, and ARM resource types |
| `available`, `quota`, `price` | Explore VM family deployability, vCPU headroom, and retail compute pricing |
| `where`, `doctor`, `update` | Inspect account context, check prerequisites, or check for a newer release |

`verify` takes its regions from the supplied files. Report dynamic values with their source location and mark them skipped. Exit `1` when any checked pair is blocked. Skipped findings alone permit exit `0`.

### VM compatibility

Teach explicit commands in new examples. Preserve these shortcuts for existing users. New resource kinds use the explicit grammar.

| Shortcut | Canonical form |
| --- | --- |
| `azw B1s --eu` | `azw availability vm B1s --eu` |
| `azw regions B1s --eu` | `azw availability vm B1s --eu` |
| `azw pick B1s --eu` | `azw pick vm B1s --eu` |
| `azw suggest B1s --eu` | `azw suggest vm B1s --eu` |

## Resource targets

Prefer lowercase, kebab-case aliases that describe the resource. Keep raw ARM type strings valid, for example `azw check resource Microsoft.Storage/storageAccounts --region westeurope`.

| Alias | ARM resource type |
| --- | --- |
| `storage-account` | `Microsoft.Storage/storageAccounts` |
| `key-vault` | `Microsoft.KeyVault/vaults` |
| `web-app` | `Microsoft.Web/sites` |
| `app-service-plan` | `Microsoft.Web/serverfarms` |
| `aks` | `Microsoft.ContainerService/managedClusters` |
| `postgres-flexible-server` | `Microsoft.DBforPostgreSQL/flexibleServers` |

## Scope

| Flag | Meaning |
| --- | --- |
| `--region <name>` | One Azure region. Required for `check` and optional for supported scans. |
| `--eu`, `--us`, `--asia` | Select Europe, US, or Asia Pacific. |
| `--geography <group>` | Select an Azure geography group. Use `azw geos` to discover names. |
| `--near <city>` | Rank suggestions using distance when coordinates are known. |
| `--concurrency <n>` | Adjust parallelism on commands that fan out across regions. |
| `--refresh` | Bypass cached ARM lists. |
| `--no-policy` | Skip the allowed-location lookup on commands with policy checks. |

Keep exact-region and broad geography flags mutually exclusive. Use geography flags for `pick` and `suggest`.

## Output

Use `-o` and `--output` for the same option. Reject unsupported modes before Azure calls.

| Mode | Meaning |
| --- | --- |
| `table` | Default human output |
| `json` | Structured JSON on stdout |
| `compact` | The same result as `json` on one line |
| `value` | One verdict from `check` or one region from `pick` or `suggest` |
| `name` | One qualifying name per line on `availability`, `regions`, `skus`, and `resources` |

Keep stdout parseable and send progress and errors to stderr. Suppress progress and advisory messages in machine output. Preserve supported compatibility flags `--json`, `--json --compact`, and `--name`. Prefer `-o compact` in new examples. For versioned machine output, follow the [JSON stability rules](json-contracts.md#stability-rules).

## Verdicts and confidence

| Check | Confidence | Verdicts |
| --- | --- | --- |
| VM | `deployability` | `AVAILABLE`, `FULL`, `SKU_NOT_OFFERED`, `BLOCKED_FOR_SUB`, `POLICY_DENIED`, `QUOTA_UNKNOWN` |
| Generic resource | `availability` | `RESOURCE_SUPPORTED`, `RESOURCE_NOT_SUPPORTED`, `POLICY_DENIED` |

Use observed facts in explanations and provide a hint when there is a concrete next step. VM checks combine known SKU, subscription, policy, and VM-family quota signals. Generic resource results describe locations advertised for a type. The [verdict vocabulary](json-contracts.md#verdict-vocabulary) defines each code.
