# Roadmap

[Quick start](../README.md#find-a-region) · [Changelog](../CHANGELOG.md) · [GitHub Issues](https://github.com/VidGuiCode/az-where/issues)

`az-where` helps people choose Azure regions for a VM or a set of resources before they deploy. The next step is to answer narrower questions, such as whether Azure advertises a specific Storage account kind and replication SKU in a region for the selected subscription.

## Where the project stands

[v0.4.10](https://github.com/VidGuiCode/az-where/releases/tag/v0.4.10) can compare VM sizes using SKU, policy, subscription restrictions, and live VM-family quota. It can also compare generic resource types, pick a region that advertises all of them, and preflight literal Terraform and Bicep values. Generic resource checks currently stop at provider-catalog availability.

## Work queue

| Order | Task | Status | Deliverable |
| --- | --- | --- | --- |
| 1 | [Research Storage SKU availability](#research-storage-sku-availability) | Ready for research | Evidence from the Storage SKU API and a decision on which verdicts it can support. |
| 2 | [Build a single-region Storage check](#build-a-single-region-storage-check) | Depends on Storage research | One read-only check for account kind, SKU, and region, with explanations and JSON output. |
| 3 | [Research PostgreSQL and App Service](#research-postgresql-and-app-service) | Queued | One feasibility note per service, using the same evidence criteria as Storage. |
| 4 | [Revisit AKS node-size checks](#revisit-aks-node-size-checks) | Deferred | A decision on a supported source for AKS-specific node-size restrictions. |

This is the proposed order. Implementation scope and release targets follow the research findings.

## Research Storage SKU availability

**User question.** Can my current subscription use a `StorageV2` account with `Standard_ZRS` in the region I’m considering?

**Starting point.** Microsoft documents a subscription-scoped SKU list with account kinds, SKU names, locations, and restrictions. Use it to investigate which fields establish that a specific combination is advertised or explicitly restricted. [Storage SKUs List API](https://learn.microsoft.com/en-us/rest/api/storagerp/skus/list?view=rest-storagerp-2026-09-01)

**Work to do**

1. Compare an advertised kind and SKU combination with a region where the combination is absent or explicitly restricted. Record which response fields explain each result.
2. Check how region names, pagination, and provider registration affect the result. Probe what a limited-permission account can read when one is available.
3. Capture representative redacted responses. Include an API failure case through a fixture if it is impractical to reproduce live.
4. Write a short decision note that maps each evidence case to an advertised, restricted, or unknown outcome. Document whether a missing row is authoritative enough to report an unsupported combination and which conditions remain outside the API’s scope.

**Done when** another contributor can reproduce the observations and explain what the check would say for an advertised SKU, a region restriction, missing evidence, and a failed request. If the evidence is incomplete, propose a narrower answer or leave Storage on the generic catalog check.

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
| App Service | Does the region appear for the requested plan SKU and Linux worker requirement? Verify what the SKU and worker filters actually establish before treating absence as definitive. | [List Geo Regions API](https://learn.microsoft.com/en-us/rest/api/appservice/list-geo-regions/list-geo-regions?view=rest-appservice-2026-07-15) |

**Done when** each note recommends a command, a narrower result, or keeping the existing generic behavior. Each proposed command should identify the exact claim the API can support.

## Revisit AKS node-size checks

An AKS node-size check needs evidence that the size can be used in a node pool. Microsoft documents `az aks list-vm-skus` as a preview feature. Use it as a research reference and look for a supported, read-only source before making it part of the normal CLI workflow. [AKS VM SKU discovery documentation](https://learn.microsoft.com/en-us/azure/aks/aks-list-skus)

**Done when** a feasibility note explains which AKS-specific restrictions can be observed, how those relate to the existing VM quota and SKU checks, and whether the resulting confidence is useful enough to ship. While deferred, `availability resource aks` remains the catalog-level check.

## Longer-term ideas

- **Shell and CI helpers.** Evaluate small snippets built around `pick -o value` and `verify -o json` once there is a concrete workflow that needs them.
- **Other clouds.** Revisit expansion after service-specific Azure checks have established a reusable way to represent provider evidence and uncertainty.

## How roadmap tasks become issues

Use the [contributor guide](../CONTRIBUTING.md#turn-roadmap-work-into-an-issue) when turning a task into a GitHub issue. Keep research and implementation work separate when the API evidence can change the design. Use the [command standard](command-standard.md) and [JSON contracts](json-contracts.md) for any public CLI changes.
