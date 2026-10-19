# Decisions

## D-001: OMP Project Time Is the Evidence Source

**Status:** Accepted

OMP Worklog reads persisted OMP Project Time evidence rather than measuring activity itself. This keeps collection and analytical ownership in the upstream project and lets this repository focus on transformation, review, and optional destination adapters.

## D-002: Draft Before External Write

**Status:** Accepted

Project Time-derived output is review-only. Mappings, work-item attribution, and generated summaries can be incomplete or ambiguous, so they do not authorize a Harvest write. Write-capable commands remain explicit and validate their own inputs.

## D-003: Preserve Local Identity When Mapping Is Incomplete

**Status:** Accepted

When no configured Harvest destination applies—or attribution is ambiguous or unassigned—the result keeps the exact local Project Time project and marks the destination for review. This avoids silently inventing an external assignment.

## D-004: Harvest Is a Current Adapter, Not the Canonical Model

**Status:** Accepted; identity cutover implemented

The durable product target is a provider-neutral work log expressed as `project: task: duration`, built from OMP Project Time analytics. Harvest project/task mappings are projections from that record to one current destination. Version `0.14.0` performs the identity cutover without retaining the retired Harvest Worklog interfaces.

## D-005: Keep Detailed Implementation Knowledge Local

**Status:** Accepted

Cross-cutting product boundaries, domain concepts, architecture, decisions, and QA entry points belong in `docs/`. Parsing rules, data-shape details, error handling, and fixture behavior stay adjacent to the code and tests that own them. This reduces duplicated contracts and stale implementation documentation.

## D-006: Preserve Precision Until Review

**Status:** Accepted

Draft inclusion uses raw positive milliseconds. Rounded decimal hours are a display projection and cannot decide whether evidence exists. This keeps short work and local-day fragments visible without imposing Harvest billing policy on source evidence.

## D-007: Keep the Existing Runtime Split

**Status:** Accepted

JavaScript is the OMP integration runtime; Ruby provides the existing standalone Harvest adapter and business-day dependencies. Their boundary separates local evidence analysis from explicit external writes. Consolidation needs a demonstrated benefit and equivalent behavioral proof, not a preference for a single language. See [runtime and language boundaries](/docs/architecture.md#runtime-and-language-boundaries).
