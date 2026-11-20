# JSON Contracts

[README](../README.md#use-in-scripts) · [Command standard](command-standard.md) · [Architecture](architecture.md)

Use `-o json` or `-o compact` to read versioned discovery results. The [payload builders](../src/core/payloads.ts) assemble most of these objects, and [contract tests](../tests/core/payloads.test.ts) pin their field names. See [Contributing](../CONTRIBUTING.md#verify-a-change) for the opt-in live checks.

[Verdicts](#verdict-vocabulary) · [Common fields](#common-envelope-fields) · [Command payloads](#commands) · [Errors](#error-envelope)

## Stability Rules

- Changes within `schemaVersion: 1` are additive. Consumers should accept new fields and use field names when reading results.
- Nullable fields use JSON `null` when the value is unavailable. Optional fields may be omitted.
- `-o json` formats the result across lines. `-o compact` writes the same result on one line.
- A completed scan may emit a result on stdout and exit `1`. A runtime failure can also exit `1`, with error details on stderr. Check both the exit status and the output stream. See the [exit code table](../README.md#exit-codes).

## Verdict Vocabulary

Parse these exact verdict strings.

| Verdict | Kind | Meaning |
|---|---|---|
| `AVAILABLE` | VM | SKU offered, no blocking subscription restriction or evaluated policy, and sufficient VM-family vCPU quota |
| `FULL` | VM | Offered but the family quota has fewer free vCPUs than the size needs |
| `SKU_NOT_OFFERED` | VM | The region's SKU catalog does not list the size |
| `BLOCKED_FOR_SUB` | VM | Azure restricts the size for this subscription in this region |
| `POLICY_DENIED` | VM, resource | An Azure Policy allowed-location assignment excludes the region |
| `QUOTA_UNKNOWN` | VM | Quota state could not be read (missing usage row or ARM failure) |
| `RESOURCE_SUPPORTED` | resource | The ARM provider catalog advertises the region for the type |
| `RESOURCE_NOT_SUPPORTED` | resource | The provider catalog does not advertise the region for the type |

`LOCATION_SUPPORTED`, `SKU_SUPPORTED`, and `UNKNOWN_SERVICE_RULES` sometimes appear in design discussions as reserved vocabulary; they are **not emitted** by any command today.

## Confidence

| Confidence | Meaning |
|---|---|
| `deployability` | VM checks combine SKU, subscription, policy, and live VM-family quota evidence. See `policy.checked` and `policy.error` for policy coverage. |
| `availability` | Generic resource checks describe the provider catalog’s advertised locations. Service-specific SKU, quota, and capacity are outside the check. |

## Common Envelope Fields

| Field | Type | Present in | Notes |
|---|---|---|---|
| `schemaVersion` | `1` | all | |
| `kind` | string | all | The verb: `availability`, `check`, `pick`, `suggest`, `compare`, `verify` |
| `resourceKind` | string | all | `vm`, `resource`, or `storage` |
| `cache` | object | all | `{ used, refreshed, ttlSeconds }` |
| `policy` | object | all | `{ checked, restricted, allowedLocations, assignments: [{name, displayName}], error }`; `allowedLocations`/`assignments` are `null`/`[]` when unrestricted |
| `explanation` | object | check payloads | `{ code, reason, hint }` **(since 0.4.6)**; `hint` may be `null` |

## Row Contracts

### VM region row (`regions[]` and `checks` in VM payloads)

| Field | Type | Notes |
|---|---|---|
| `region` | string | ARM location name, e.g. `westeurope` |
| `displayName` | string | |
| `geographyGroup` | string, optional | e.g. `Europe` |
| `physicalLocation` | string, optional | |
| `skuOffered` | boolean | |
| `family` | string \| null | e.g. `standardBSFamily` |
| `used`, `limit`, `free` | number \| null | Family vCPU quota numbers |
| `policyAllowed` | boolean \| null | `null` when policy was not checked |
| `policyReason` | string \| null | Set on `POLICY_DENIED` |
| `verdict` | string | See vocabulary above |
| `requiredVcpus` | number \| null | vCPUs one instance needs **(since 0.4.6)** |
| `skuRestrictions` | array \| null | Raw ARM restrictions on `BLOCKED_FOR_SUB` **(since 0.4.6)** |
| `familySizesOffered` | string[] \| null | Up to 5 same-series sizes listed in-region on `SKU_NOT_OFFERED` **(since 0.4.6)** |
| `errorDetail` | string \| null | Concise ARM failure summary when a call failed **(since 0.4.6)** |

### Resource region row (`regions[]` and `checks` in resource payloads)

| Field | Type | Notes |
|---|---|---|
| `kind` | `"resource"` | |
| `target` | string | The input as given |
| `resourceType` | string | Full type, e.g. `Microsoft.Storage/storageAccounts` |
| `region`, `displayName`, `geographyGroup`, `physicalLocation` | | As above |
| `policyAllowed`, `policyReason` | | As above |
| `confidence` | `"availability"` | Always — resource rows never claim deployability |
| `verdict` | string | See vocabulary above |
| `providerRegistered` | boolean \| null | `registrationState === "Registered"`; `null` when the provider is absent **(since 0.4.6)** |
| `typeLocationCount` | number \| null | How many regions the type advertises **(since 0.4.6)** |
| `notSupportedCause` | string \| null | `provider-not-found`, `type-not-found`, or `region-not-advertised` on `RESOURCE_NOT_SUPPORTED` **(since 0.4.6)** |

## Commands

### `azw availability vm <sku> [scope] -o json`

Legacy `azw regions <sku>` emits the same shape with `kind: "regions"`.

```json
{
  "schemaVersion": 1,
  "kind": "availability",
  "resourceKind": "vm",
  "sku": "Standard_B1s",
  "geography": "Europe",
  "region": null,
  "scannedAt": "2026-10-08T12:00:00.000Z",
  "elapsedMs": 4200,
  "cache": { "used": true, "refreshed": false, "ttlSeconds": 600 },
  "policy": { "checked": true, "restricted": false, "allowedLocations": null, "assignments": [], "error": null },
  "regions": [ { "...": "VM region row" } ]
}
```

- `sku` is normalized (`B1s` → `Standard_B1s`); `geography` is `null` when `--region` was used, `region` is `null` when a geography was scanned.
- `regions` keeps every row including `SKU_NOT_OFFERED` (the human table hides them unless `--all`).
- Exit `1` when no row is `AVAILABLE`.

### `azw availability resource <target> [scope] -o json`

Same envelope with `resourceKind: "resource"`, plus `target`, `resolved` (`{ input, resourceType, alias, namespace, typePath }`), `confidence: "availability"`, and `regions` of resource rows. Exit `1` when no row is `RESOURCE_SUPPORTED`.

### `azw check vm <sku> --region <name> -o json`

```json
{
  "schemaVersion": 1,
  "kind": "check",
  "resourceKind": "vm",
  "target": "Standard_B1s",
  "region": "westeurope",
  "verdict": "FULL",
  "confidence": "deployability",
  "cache": { "...": "..." },
  "policy": { "...": "..." },
  "checks": { "...": "one VM region row (an object, never an array)" },
  "explanation": {
    "code": "FULL",
    "reason": "Standard_B1s needs 1 vCPUs but family standardBSFamily has only 0/4 free in westeurope — 1 vCPU short.",
    "hint": "Request a quota increase (Azure Portal → Quotas) or free up vCPUs, then re-check."
  }
}
```

- Top-level `verdict` mirrors `checks.verdict`.
- `explanation.reason` states observed evidence only; `explanation.hint` is an actionable next step or `null` (always `null` on `AVAILABLE`).
- Exit `1` when `verdict` is not `AVAILABLE`. `-o value` prints the bare verdict string.

### `azw check resource <target> --region <name> -o json`

Same envelope with `resourceKind: "resource"`, `resolved`, `confidence: "availability"`, `checks` as one resource row, and `explanation`. `RESOURCE_SUPPORTED` explanations always state that the result is availability, not deployability. Exit `1` when `verdict` is not `RESOURCE_SUPPORTED`.

### Storage check

`azw check storage --kind <kind> --sku <sku> --region <name> -o json` adds a `kind: "check"` payload with `resourceKind: "storage"` and `confidence: "availability"`. It includes the requested `accountKind`, `sku`, resolved `region`, `verdict`, shared `cache` and `policy` fields, and `explanation: { code, reason, hint }`. The `evidence` object contains `listed` (boolean, or `null` when location evidence is incomplete or a policy denial skipped the lookup) and `restrictionReasons` (an array of matching Azure reason codes).

| Verdict | Meaning |
| --- | --- |
| `STORAGE_SKU_ADVERTISED` | The catalog lists the combination in the region without an applicable explicit restriction. |
| `STORAGE_SKU_RESTRICTED` | A location restriction explicitly names this region, including when a catalog row also advertises it. |
| `STORAGE_SKU_NOT_LISTED` | The catalog did not list the combination in the region. |
| `STORAGE_SKU_UNKNOWN` | A matching SKU entry omits location evidence, or a location restriction omits its affected regions. |
| `POLICY_DENIED` | An evaluated allowed-location policy excludes the region. The SKU catalog is skipped. |

`-o value` prints the verdict. Exit `0` means advertised. Other verdicts write a result and exit `1`. A failed request or an unusable catalog uses the [error envelope](#error-envelope) on stderr. Use `policy.checked` and `policy.error` to identify skipped or failed policy reads. The Storage SKU catalog is read live. `--refresh` refreshes the ARM locations list.

### Storage availability

`azw availability storage --kind <kind> --sku <sku> [scope] -o json` uses the same verdicts as [Storage check](#storage-check). The payload carries `schemaVersion: 1`, `kind: "availability"`, `resourceKind: "storage"`, `accountKind`, `sku`, `geography`, `region`, `scannedAt`, `elapsedMs`, `confidence: "availability"`, `cache`, `policy`, and `regions`.

- `regions[]` covers all evaluated locations. Each row contains `region`, `displayName`, nullable `geographyGroup`, `verdict`, `listed`, `restrictionReasons`, and `reason`. The row evidence matches the single-region check.
- `geography` is the selected group, `"all"` without a filter, or `null` for a single region. `region` is the canonical name for a single-region scan and `null` otherwise.
- The scan exits `0` when at least one region is advertised and `1` otherwise, with JSON emitted in either case. `-o name` prints only advertised region names, or no rows on exit `1`. Failed catalog reads use the [error envelope](#error-envelope).

### `azw pick vm <sku> [scope] -o json`

```json
{
  "schemaVersion": 1,
  "kind": "pick",
  "resourceKind": "vm",
  "sku": "Standard_B1s",
  "cache": { "...": "..." },
  "policy": { "...": "..." },
  "picked": {
    "region": "westeurope",
    "displayName": "West Europe",
    "geographyGroup": "Europe",
    "free": 6,
    "limit": 10
  }
}
```

- On failure the same payload is printed with `picked: null` and exit `1`.
- `-o value` prints the bare region name on stdout (exit `1`, empty stdout, when nothing deploys).

### `azw suggest vm <sku> [scope] -o json`

```json
{
  "schemaVersion": 1,
  "kind": "suggest",
  "resourceKind": "vm",
  "sku": "Standard_B1s",
  "geography": "Europe",
  "near": "Luxembourg",
  "elapsedMs": 4200,
  "cache": { "...": "..." },
  "policy": { "...": "..." },
  "suggested": {
    "region": "westeurope",
    "displayName": "West Europe",
    "reason": "westeurope is deployable with 6/10 free and is about 318 km from the requested location.",
    "score": 5682,
    "factors": { "free": 6, "limit": 10, "distanceKm": 318, "geographyGroup": "Europe" }
  }
}
```

- `near` is the `--near` input or `null`. `factors.distanceKm` requires `--near` and a region with known coordinates. The score is `1000 × free vCPUs − distanceKm`, with zero used for an absent distance.
- On failure the same payload is printed with `suggested: null` and exit `1`.

### Resource pick and suggest

Both commands accept up to 30 targets, deduplicated case-insensitively by resolved ARM type. They share a single provider catalog load. The `--concurrency` option shown in shared command help applies to VM scans.

#### `azw pick resource <target-list> [scope] -o json` (since 0.4.10)

Returns the first region where **every** requested type is `RESOURCE_SUPPORTED`, in geography-group and region-name order. A single target is also valid.

```json
{
  "schemaVersion": 1,
  "kind": "pick",
  "resourceKind": "resource",
  "confidence": "availability",
  "targets": ["storage-account", "key-vault"],
  "resolved": [
    {
      "input": "storage-account",
      "resourceType": "Microsoft.Storage/storageAccounts",
      "alias": "storage-account",
      "namespace": "Microsoft.Storage",
      "typePath": "storageAccounts"
    },
    {
      "input": "key-vault",
      "resourceType": "Microsoft.KeyVault/vaults",
      "alias": "key-vault",
      "namespace": "Microsoft.KeyVault",
      "typePath": "vaults"
    }
  ],
  "cache": { "used": true, "refreshed": false, "ttlSeconds": 600 },
  "policy": { "...": "..." },
  "picked": { "region": "northeurope", "displayName": "North Europe", "geographyGroup": "Europe" }
}
```

- `resolved` carries one entry per target in request order; `picked` carries `region`, `displayName`, and `geographyGroup` only — resource rows have no quota fields.
- On failure the same payload is printed with `picked: null` and exit `1`; the human path explains the closest miss (the requested type supported in the fewest scanned regions).
- Default human output is the bare region name, like `pick vm`; `-o value` prints the same bare name; `-o name` is rejected as a validation error. No `--region` flag: scoping to one region is `check resource`'s job. Scope flags otherwise match `pick vm` (`--eu`, `--us`, `--asia`, `--geography`, `--no-policy`, `--refresh`).

#### `azw suggest resource <target-list> [scope] [--near <city>] -o json` (since 0.4.10)

Recommends a region that advertises every requested type. With `--near` and known coordinates, the score is the negative great-circle distance in kilometres. Scores are zero when distance is unavailable or `--near` is omitted. Ties follow the shared geography-group and region-name ordering.

```json
{
  "schemaVersion": 1,
  "kind": "suggest",
  "resourceKind": "resource",
  "confidence": "availability",
  "targets": ["storage-account", "key-vault"],
  "resolved": [ { "...": "one resolved entry per target, as above" } ],
  "geography": "Europe",
  "near": "Luxembourg",
  "elapsedMs": 3800,
  "cache": { "...": "..." },
  "policy": { "...": "..." },
  "suggested": {
    "region": "westeurope",
    "displayName": "West Europe",
    "reason": "westeurope advertises all 2 requested resource types and is about 318 km from the requested location — availability, not deployability.",
    "score": -318,
    "factors": { "distanceKm": 318, "geographyGroup": "Europe" }
  }
}
```

- The reason always states that all N requested types are advertised there and carries the availability-not-deployability caveat; `factors` carries `distanceKm` (only with `--near`) and `geographyGroup` — never `free`/`limit`, which resource rows do not have.
- On failure the same payload is printed with `suggested: null` and exit `1`. Scope flags match `suggest vm` (`--eu`, `--us`, `--asia`, `--geography`, `--near`, `--no-policy`, `--refresh`); no `--region`.

### `azw compare vm <sku-list> [scope] -o json`

The common envelope adds `confidence: "deployability"`, `skus`, `regions`, `geography`, `region`, `scannedAt`, `elapsedMs`, and `results`. The `skus` array contains normalized, deduplicated sizes in input order.

| Field in `results[]` | Meaning |
|---|---|
| `sku` | Normalized SKU name |
| `family`, `vcpus`, `memoryGiB` | SKU catalog facts, nullable when unknown |
| `regions` | One cell per region in the same order as the top-level `regions` string array |
| `deployableRegions`, `deployableCount` | Region names and count for `AVAILABLE` cells |
| `verdictCounts` | Count by VM verdict string |

Cells use the [VM region row](#vm-region-row-regions-and-checks-in-vm-payloads) fields with five exclusions (`family`, `requiredVcpus`, `skuRestrictions`, `familySizesOffered`, `errorDetail`). Exit `1` when no requested size is `AVAILABLE` in any scanned region. Use `json` or `compact` for machine output.

### `azw compare resource <target-list> [scope] -o json` (since 0.4.9)

Region × type matrix of generic resource availability verdicts, mirroring `compare vm`. Targets accept the same friendly aliases and raw Azure resource types as `availability resource`; they are validated, deduplicated case-insensitively (on the resolved resource type), and capped at 30 per invocation before any Azure call. Comparing N types costs one provider-catalog call — the same as a single `check resource` scan — so there is no `--concurrency` flag.

```json
{
  "schemaVersion": 1,
  "kind": "compare",
  "resourceKind": "resource",
  "confidence": "availability",
  "targets": ["storage-account", "key-vault"],
  "regions": ["northeurope", "westeurope"],
  "geography": "Europe",
  "region": null,
  "scannedAt": "2026-10-18T12:00:00.000Z",
  "elapsedMs": 3800,
  "cache": { "used": true, "refreshed": false, "ttlSeconds": 600 },
  "policy": { "...": "..." },
  "results": [
    {
      "target": "storage-account",
      "resolved": {
        "input": "storage-account",
        "resourceType": "Microsoft.Storage/storageAccounts",
        "alias": "storage-account",
        "namespace": "Microsoft.Storage",
        "typePath": "storageAccounts"
      },
      "regions": [ { "...": "resource region row" } ],
      "supportedRegions": ["westeurope"],
      "supportedCount": 1,
      "verdictCounts": { "RESOURCE_SUPPORTED": 1, "RESOURCE_NOT_SUPPORTED": 1, "POLICY_DENIED": 0 }
    }
  ]
}
```

- `regions` is the shared string axis; each `results[]` entry's `regions` rows align with it in the same order, one resource region row per scanned region, each carrying `confidence: "availability"` — a comparison never claims deployability.
- `results[]` keeps request order after dedupe; `target` is the first form the user gave and `resolved` mirrors `availability resource`.
- Exit `1` when no requested type is supported in any region (payload is still printed); `-o value` and `-o name` are rejected as validation errors before any Azure call.

### `azw verify <files...> -o json` (since 0.4.7)

IaC preflight: one `results[]` row per statically-known `location + size` pair parsed from Terraform/Bicep files, plus a `skipped[]` list of VM resources that could not be checked. Since 0.4.8, generic `type + location` pairs (storage accounts, key vaults, web/function apps, service plans, AKS, PostgreSQL flexible servers, …) are checked in a separate `genericResources` section.

```json
{
  "schemaVersion": 1,
  "kind": "verify",
  "resourceKind": "vm",
  "confidence": "deployability",
  "files": ["main.tf"],
  "formats": ["terraform"],
  "scannedAt": "2026-10-08T12:00:00.000Z",
  "elapsedMs": 4200,
  "summary": { "resources": 2, "checked": 1, "skipped": 1, "deployableCount": 1, "verdictCounts": { "AVAILABLE": 1, "FULL": 0, "SKU_NOT_OFFERED": 0, "BLOCKED_FOR_SUB": 0, "POLICY_DENIED": 0, "QUOTA_UNKNOWN": 0 } },
  "results": [
    {
      "file": "main.tf",
      "line": 14,
      "format": "terraform",
      "resourceType": "azurerm_linux_virtual_machine",
      "resourceName": "vm",
      "sku": "Standard_B1s",
      "region": "westeurope",
      "capacity": 1,
      "checks": { "region": "westeurope", "displayName": "West Europe", "...": "the full 16-field VM row, identical to azw check vm" },
      "explanation": { "code": "AVAILABLE", "reason": "Standard_B1s is offered in westeurope ...", "hint": null }
    }
  ],
  "skipped": [
    {
      "file": "main.tf",
      "line": 32,
      "format": "terraform",
      "resourceType": "azurerm_windows_virtual_machine",
      "resourceName": "vm_win",
      "reason": "dynamic-location",
      "detail": "azurerm_resource_group.rg.location"
    }
  ],
  "genericResources": {
    "seen": 2,
    "checked": 1,
    "skipped": 1,
    "supportedCount": 1,
    "verdictCounts": { "RESOURCE_SUPPORTED": 1, "RESOURCE_NOT_SUPPORTED": 0, "POLICY_DENIED": 0 },
    "results": [
      {
        "file": "main.tf",
        "line": 48,
        "format": "terraform",
        "resourceType": "Microsoft.Storage/storageAccounts",
        "sourceType": "azurerm_storage_account",
        "resourceName": "stg",
        "region": "westeurope",
        "checks": { "kind": "resource", "region": "westeurope", "...": "the full resource row, identical to azw check resource" },
        "explanation": { "code": "RESOURCE_SUPPORTED", "reason": "…availability, not deployability…", "hint": null }
      }
    ],
    "skippedFindings": [
      {
        "file": "main.tf",
        "line": 60,
        "format": "terraform",
        "resourceType": "azurerm_key_vault",
        "resourceName": "kv",
        "reason": "dynamic-location",
        "detail": "var.location"
      }
    ]
  },
  "cache": { "...": "..." },
  "policy": { "...": "..." }
}
```

- `results[]` rows embed the pinned 16-field VM verdict row as `checks` plus a per-row `explanation`, exactly like `azw check vm`; `region` is the ARM name the file's location literal resolved to (display-name literals like `West Europe` resolve too).
- `capacity` is a literal scale-set instance count (quota checks multiply the vCPU need by it); `1` for single VMs, `null` when the capacity expression is dynamic (treated as a single instance).
- `skipped[].reason` is a finding, not a verdict: `dynamic-location`, `dynamic-sku`, or `unknown-region` (the literal matched no ARM region). `detail` echoes the raw expression or literal.
- `genericResources` **(since 0.4.8)** keeps the VM `summary` / `results` / `skipped` fields meaning exactly what they meant in 0.4.7: generic findings never mix into them. `genericResources.results[]` rows carry `resourceType` (the ARM type checked), `sourceType` (the type as written in the file), and the pinned resource row as `checks` — every row carries `confidence: "availability"` and never claims deployability. The top-level `confidence: "deployability"` describes `results` (VM rows) only. `genericResources` is always present, with zeros and empty arrays when no mapped generic types were found.
- Exit `1` only when a checked pair is blocked — a blocked VM pair, or a generic resource that is `RESOURCE_NOT_SUPPORTED` or `POLICY_DENIED` in its region; skipped resources never fail the run. Zero checkable pairs exits `0` — the payload states `checked: 0`.
- `--output value` and `--output name` are rejected as validation errors before any Azure call.

## Error Envelope

Errors handled by a command in a resolved JSON output mode are written to **stderr**. A completed scan with an unfavorable verdict still writes its result to stdout.

```json
{
  "status": "error",
  "code": "ARM_HTTP_ERROR",
  "message": "ARM 403 Forbidden",
  "details": { "statusCode": 403, "statusText": "Forbidden", "endpoint": "/providers/...", "armCode": "AuthorizationFailed", "armMessage": "...", "body": "..." }
}
```

`ARM_HTTP_ERROR` and `AZ_CLI_ERROR` include `details`. Other handled errors typically carry the error class name as `code` plus a message. Argument parser failures can be plain text, including when a command fails before resolving its output mode.
