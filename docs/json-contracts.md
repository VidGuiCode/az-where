# JSON Contracts

Stable JSON shapes for scripting and agents, pinned per command. Field names here are a contract: human tables can change cosmetically, JSON field names do not change casually.

Every shape below is enforced by `src/core/payloads.ts` (payload builders) and pinned by `tests/core/payloads.test.ts`; live variants run under `AZW_LIVE=1` in `tests/live/arm-smoke.test.ts`.

## Stability Rules

- All payloads carry `schemaVersion: 1` and will keep it while changes are **additive-only**: new fields may be appended, existing fields are never renamed, removed, or change meaning.
- Fields added after a command's first documented release are marked **(since 0.4.6)** in the tables below.
- Fields that are not applicable are present with value `null` — they are never omitted — unless the table says otherwise.
- `-o json` and `-o compact` emit the identical object; only whitespace differs (pretty vs one line).
- Exit codes: `0` success, `1` scan completed but nothing passed the command's bar (payload is still printed), `2` not logged in, `3` validation error, `4` doctor failure, `127` Azure CLI missing. See [architecture.md](architecture.md).

## Verdict Vocabulary

These are the exact verdict strings emitted by the implementation (older docs used the concept name `QUOTA_FULL`; the shipped code value is `FULL`):

| Verdict | Kind | Meaning |
|---|---|---|
| `AVAILABLE` | VM | Offered, not restricted, policy-allowed, and enough free vCPUs for one instance |
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
| `deployability` | VM checks combining SKU offer, subscription restriction, policy, and live quota — strong enough to pick a deployment target |
| `availability` | Generic resource checks — the provider catalog advertises the region, but SKU/quota/capacity are not checked; never treat as deployability |

## Common Envelope Fields

| Field | Type | Present in | Notes |
|---|---|---|---|
| `schemaVersion` | `1` | all | |
| `kind` | string | all | The verb: `availability`, `check`, `pick`, `suggest`, `compare`, `verify` |
| `resourceKind` | string | all | `vm` or `resource` |
| `cache` | object | all | `{ used, refreshed, ttlSeconds }` |
| `policy` | object | all | `{ checked, restricted, allowedLocations, assignments: [{name, displayName}], error }`; `allowedLocations`/`assignments` are `null`/`[]` when unrestricted |
| `explanation` | object | check payloads | `{ code, reason, hint }` **(since 0.4.6)**; `hint` may be `null` |

## Row Contracts

### VM region row (`regions[]` and `checks` in VM payloads)

| Field | Type | Notes |
|---|---|---|
| `region` | string | ARM location name, e.g. `westeurope` |
| `displayName` | string | |
| `geographyGroup` | string \| undefined | e.g. `Europe` |
| `physicalLocation` | string \| undefined | |
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
    "reason": "Standard_B1s needs 2 vCPUs but family standardBSFamily has only 0/4 free in westeurope — 2 vCPUs short.",
    "hint": "Request a quota increase (Azure Portal → Quotas) or free up vCPUs, then re-check."
  }
}
```

- Top-level `verdict` mirrors `checks.verdict`.
- `explanation.reason` states observed evidence only; `explanation.hint` is an actionable next step or `null` (always `null` on `AVAILABLE`).
- Exit `1` when `verdict` is not `AVAILABLE`. `-o value` prints the bare verdict string.

### `azw check resource <target> --region <name> -o json`

Same envelope with `resourceKind: "resource"`, `resolved`, `confidence: "availability"`, `checks` as one resource row, and `explanation`. `RESOURCE_SUPPORTED` explanations always state that the result is availability, not deployability. Exit `1` when `verdict` is not `RESOURCE_SUPPORTED`.

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
  "near": null,
  "elapsedMs": 4200,
  "cache": { "...": "..." },
  "policy": { "...": "..." },
  "suggested": {
    "region": "westeurope",
    "displayName": "West Europe",
    "reason": "westeurope is deployable with 6/10 free",
    "score": 5000,
    "factors": { "free": 6, "limit": 10, "distanceKm": 12, "geographyGroup": "Europe" }
  }
}
```

- `near` is the `--near` input or `null`. `factors.distanceKm` appears only with `--near`.
- On failure the same payload is printed with `suggested: null` and exit `1`.

### `azw compare vm <sku-list> [scope] -o json`

Documented with 0.4.5: a shared `regions` string axis plus `results[]` — one per requested SKU in request order — carrying `family`, `vcpus`, `memoryGiB`, per-region cells, `deployableRegions`, `deployableCount`, and `verdictCounts`. See the 0.4.5 changelog entry for the full field list.

### `azw verify <files...> -o json` (since 0.4.7)

IaC preflight: one `results[]` row per statically-known `location + size` pair parsed from Terraform/Bicep files, plus a `skipped[]` list of VM resources that could not be checked.

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
  "cache": { "...": "..." },
  "policy": { "...": "..." }
}
```

- `results[]` rows embed the pinned 16-field VM verdict row as `checks` plus a per-row `explanation`, exactly like `azw check vm`; `region` is the ARM name the file's location literal resolved to (display-name literals like `West Europe` resolve too).
- `capacity` is a literal scale-set instance count (quota checks multiply the vCPU need by it); `1` for single VMs, `null` when the capacity expression is dynamic (treated as a single instance).
- `skipped[].reason` is a finding, not a verdict: `dynamic-location`, `dynamic-sku`, or `unknown-region` (the literal matched no ARM region). `detail` echoes the raw expression or literal.
- Exit `1` only when a checked pair is blocked; skipped resources never fail the run. Zero checkable pairs exits `0` — the payload states `checked: 0`.
- `--output value` and `--output name` are rejected as validation errors before any Azure call.

## Error Envelope

Failures print to **stderr** (stdout stays empty) as:

```json
{
  "status": "error",
  "code": "ARM_HTTP_ERROR",
  "message": "ARM 403 Forbidden",
  "details": { "statusCode": 403, "statusText": "Forbidden", "endpoint": "/providers/...", "armCode": "AuthorizationFailed", "armMessage": "...", "body": "..." }
}
```

`code` is `ARM_HTTP_ERROR`, `AZ_CLI_ERROR`, `ValidationError`, `PolicyReadError`, or an error class name. The bearer token never appears in any output.
