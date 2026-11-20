# Roadmap

[Release plan](#v05x-release-plan) · [Later versions](#later-versions) · [Changelog](../CHANGELOG.md) · [GitHub Issues](https://github.com/VidGuiCode/az-where/issues)

`az-where` helps people choose Azure regions for a VM or a set of resources before they deploy. The next step is to answer narrower questions, such as whether Azure advertises a specific Storage account kind and replication SKU in a region for the selected subscription.

## Where the project stands

[v0.5.2](https://github.com/VidGuiCode/az-where/releases/tag/v0.5.2) compares Storage configurations on a shared region axis using the same evidence as the single-region check and scan. VM checks combine SKU, policy, subscription restrictions, and live VM-family quota. The CLI also compares generic resource types, picks a region that advertises all of them, and preflights literal Terraform and Bicep values.

## Work queue

| Order | Task | Target | Deliverable |
| --- | --- | --- | --- |
| 1 | [Research Storage SKU availability](#research-storage-sku-availability) | Research completed for `v0.5.0` | Live catalog examples and a decision to ship a check at availability confidence. |
| 2 | [Continue the Storage series](#v05x-release-plan) | `v0.5.3`–`v0.5.4` | Preflight Storage in Terraform and Bicep, then pick a region for scripts. |
| 3 | [Research PostgreSQL and App Service](#research-postgresql-and-app-service) | Before `v0.6.0` and `v0.7.0` | One feasibility note per service. Research can run during the Storage series. |
| 4 | [Revisit AKS node-size checks](#revisit-aks-node-size-checks) | Before `v0.8.0` | A decision on a supported source for AKS-specific node-size restrictions. |

## v0.5.x release plan

The Storage series starts with one subscription-aware SKU check and reuses its verdicts as the CLI adds more ways to use them. As in v0.4.x, each increment can ship an additive capability. These are planning targets. If an urgent fix needs the next patch number, move the feature targets forward.

| Version | Purpose | Planned scope | Ready to release when |
| --- | --- | --- | --- |
| `v0.4.11` | Optional maintenance | A fix that needs to ship before Storage is ready. | A specific fix warrants its own release. |
| `v0.5.0` | Check one Storage configuration | One account kind, one replication SKU, and one region. Show the verdict, evidence, and reason in human output and JSON. | The [research decision](#research-storage-sku-availability) supports a useful claim. Fixtures exercise advertised, restricted, absent, and failed lookups. A read-only live check confirms the documented behavior. |
| `v0.5.1` | Scan regions for one configuration | Show where the kind and SKU are advertised, with geography filtering. Reuse the subscription SKU catalog across regions. | Each region agrees with the single-region check for the same evidence. Policy coverage and inconclusive rows are visible in the output. |
| `v0.5.2` | Compare Storage configurations | Compare explicitly requested kind and SKU pairs on a shared region axis. Keep target order stable in JSON. | A single catalog load powers the matrix. The legend and contract explain each result, including absent or incomplete evidence. |
| `v0.5.3` | Preflight Storage in Terraform and Bicep | Extend `verify` to evaluate recognized Storage accounts with literal location, kind, and SKU values. Report dynamic inputs as skipped. | Fixtures cover both formats, an explicitly blocked configuration, and dynamic inputs. Existing VM and generic resource JSON consumers continue to work. |
| `v0.5.4` | Pick a Storage region for scripts | Return one region for a requested account kind and SKU, with deterministic selection and JSON or scalar output. | The selected region satisfies the documented Storage evidence and policy rules. With no qualifying region, scalar output is empty and the command exits nonzero. |

Each release updates command help, the README, the changelog, and the JSON reference where applicable. Document policy coverage and keep the confidence of Storage results tied to the evidence the API provides.

## Research Storage SKU availability

**User question.** Can my current subscription use a `StorageV2` account with `Standard_ZRS` in the region I’m considering?

**Starting point.** Microsoft documents a subscription-scoped SKU list with account kinds, SKU names, locations, and restrictions. Use it to investigate which fields establish that a specific combination is advertised or explicitly restricted. [Storage SKUs List API](https://learn.microsoft.com/en-us/rest/api/storagerp/skus/list?view=rest-storagerp-2026-09-01)

**Work to do**

1. Compare an advertised kind and SKU combination with a region where the combination is absent or explicitly restricted. Record which response fields explain each result.
2. Check how region names, pagination, and provider registration affect the result. Probe what a limited-permission account can read when one is available.
3. Capture representative redacted responses. Include an API failure case through a fixture if it is impractical to reproduce live.
4. Write a short decision note that maps each evidence case to an advertised, restricted, or unknown outcome. Document whether a missing row is authoritative enough to report an unsupported combination and which conditions remain outside the API’s scope.

**Done when** another contributor can reproduce the observations and explain what the check would say for an advertised SKU, a region restriction, missing evidence, and a failed request. If the evidence is incomplete, propose a narrower answer or leave Storage on the generic catalog check.

**Decision.** Ship a single-region check at availability confidence. In a live read against one registered subscription, `StorageV2 / Standard_ZRS` was listed for `australiaeast` and absent for `australiacentral`. The Storage catalog used ARM region identifiers and returned multiple rows for the same kind and SKU. Treat absence as unlisted in that catalog. An explicit location restriction can override a listed row. No restricted row appeared in the live sample, so restriction and request-error handling are covered by fixtures. Behavior under a limited-permission account remains unverified.

## Build a single-region Storage check

Start after the research yields a reliable answer beyond the generic provider catalog. The first version takes an account kind, a SKU, and one region. Keep multi-region scans, comparison, and IaC integration for a follow-up once the single-region result is useful.

- Reuse the Azure session, ARM client, region resolution, and allowed-location policy handling where their behavior fits. Explain whether policy was evaluated.
- Print the observed result and its reason. In JSON, include the requested inputs, evaluated evidence, and the applicable confidence. Specify the exit behavior for positive, negative, and inconclusive results before exposing it to scripts.
- Preserve the existing generic `resource` commands and their JSON payloads. Report Storage SKU and location evidence at the confidence it supports. Account quota, live capacity, and other deployment constraints remain outside this first check unless independently verified and documented.
- Test advertised, restricted, unlisted, and unavailable-evidence responses with fixtures. Verify that invalid inputs fail before an Azure call and that JSON stays parseable on stdout.
- Update command help, the README examples, the JSON contract, and the changelog. Record a read-only live verification against an authorized Azure subscription before release.

## Research PostgreSQL and App Service

Use the Storage research format for each service. Record the user question, API scope, minimum permissions where known, a positive and a negative or inconclusive example, and the verdict the evidence supports.

| Service | First question | Starting point |
| --- | --- | --- |
| PostgreSQL Flexible Server | Is a requested compute SKU advertised for this subscription and region? Determine whether the response distinguishes a missing SKU from a service restriction before considering HA or capacity. | [Capabilities by Location API](https://learn.microsoft.com/en-us/rest/api/postgresql/capabilities-by-location/list?view=rest-postgresql-2026-10-01) |
| App Service | Is the exact plan SKU listed for the region, and does its tier advertise Linux workers there? Keep the two observations separate unless an exact-SKU Linux capability is verified. | [List SKUs API](https://learn.microsoft.com/en-us/rest/api/appservice/list-skus/list-skus?view=rest-appservice-2026-07-15) · [List Geo Regions API](https://learn.microsoft.com/en-us/rest/api/appservice/list-geo-regions/list-geo-regions?view=rest-appservice-2026-07-15) |

**Done when** each note recommends a command, a narrower result, or keeping the existing generic behavior. Each proposed command should identify the exact claim the API can support.

**PostgreSQL live observation.** West Europe and East US both returned `OfferRestricted` with status `Enabled` and no edition entries for the sampled subscription. Treat those responses as an explicit offer restriction. Verify a positive SKU listing on an eligible subscription before defining the success verdict. [Capabilities by Location API](https://learn.microsoft.com/en-us/rest/api/postgresql/capabilities-by-location/list?view=rest-postgresql-2026-10-01)

**App Service live observation.** The Basic tier Linux filter returned region listings, but the exact SKU endpoint returned an empty list on two API versions despite the provider being registered. The tier result supports a Linux worker observation at tier scope. Exact SKU status remains inconclusive for this subscription. Verify a populated SKU response before building the exact-SKU verdict. [List SKUs API](https://learn.microsoft.com/en-us/rest/api/appservice/list-skus/list-skus?view=rest-appservice-2026-07-15) · [List Geo Regions API](https://learn.microsoft.com/en-us/rest/api/appservice/list-geo-regions/list-geo-regions?view=rest-appservice-2026-07-15)

## Revisit AKS node-size checks

An AKS node-size check needs evidence that the size can be used in a node pool. The AKS-specific SKU operation appears in the preview REST contract and is absent from the stable contract reviewed. The preview lists regional SKUs and restrictions for a subscription. Pool mode, OS, and node count still require separate evidence. Keep v0.8.0 deferred until a supported source is available. [Preview REST reference](https://learn.microsoft.com/en-us/rest/api/aks/vm-skus/list?view=rest-aks-2026-09-02-preview) · [Stable ARM specification](https://github.com/Azure/azure-rest-api-specs/blob/main/specification/containerservice/resource-manager/Microsoft.ContainerService/aks/stable/2026-07-01/managedClusters.json)

**Done when** a feasibility note explains which AKS-specific restrictions can be observed, how those relate to the existing VM quota and SKU checks, and whether the resulting confidence is useful enough to ship. While deferred, `availability resource aks` remains the catalog-level check.

## Later versions

These targets give each roadmap area a place in the release sequence. Review the slot after the corresponding research or workflow has enough evidence to choose a scope.

| Target | Purpose | Planned first deliverable | Decision before implementation |
| --- | --- | --- | --- |
| `v0.6.0` | PostgreSQL Flexible Server | A single-region check for a requested compute SKU. | Show that the regional capabilities response supports a useful subscription-scoped verdict. Evaluate HA in a later increment. |
| `v0.7.0` | App Service | Report exact regional plan SKU evidence and tier-level Linux worker evidence. | Validate both catalogs live. Claim Linux availability for an exact SKU only if the provider exposes SKU-level Linux evidence. |
| `v0.8.0` | AKS | A single-region node-pool VM size check for a defined pool configuration. | Identify a supported read-only source for AKS-specific restrictions and document how it relates to Compute quota. |
| `v0.9.0` | Shell and CI workflows | Package a small helper for a concrete workflow built around `pick -o value` or `verify -o json`. | Identify a recurring use case and define the helper’s output and failure behavior. Runnable examples may be sufficient. |
| `v0.10.0` onward | Further Azure development | Assign additional minor versions to validated service checks and workflow improvements as they take shape. | Give each release a concrete user outcome and evidence that the planned behavior can be verified. |

### Stability milestone

Target `v1.0.0` when the command surface and script-facing contracts are ready for a published compatibility policy. Review the grammar, verdicts, upgrade behavior, and packaging before tagging. The pre-1.0 minor version can continue through `v0.10.0`, `v0.11.0`, and beyond while that work develops.

### Other clouds

Revisit another provider when Azure’s service checks have established a reusable approach to evidence and confidence. Assign a release target after choosing a discovery workflow and verifying what the provider can support.

## How roadmap tasks become issues

Use the [contributor guide](../CONTRIBUTING.md#turn-roadmap-work-into-an-issue) when turning a task into a GitHub issue. Keep research and implementation work separate when the API evidence can change the design. Use the [command standard](command-standard.md) and [JSON contracts](json-contracts.md) for any public CLI changes.
