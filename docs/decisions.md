# Decisions

## D-001: OMP Project Time Is the Evidence Source

**Status:** Accepted

OMP Worklog reads persisted OMP Project Time evidence rather than measuring activity itself. This keeps collection and analytical ownership in the upstream project and lets this repository focus on transformation, review, and optional destination adapters.

## D-002: Draft Before External Write

**Status:** Accepted

Unapproved Project Time-derived output is review-only. Mappings, work-item attribution, elapsed intervals, and generated summaries do not authorize a Harvest write. A reviewed batch may be filed after one explicit approval of its exact destinations, durations, and factual notes; subsequent batches do not inherit that approval.

## D-003: Preserve Local Identity When Mapping Is Incomplete

**Status:** Accepted

When no configured Harvest destination applies, keep the exact local project and require destination review. Attribution-only draft surfaces also keep ambiguous/unassigned work items under the local project. A project-scoped review batch may prefill an explicit project/task mapping despite uncertain work-item context, but the reviewer still confirms its destination and factual note.

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

## D-008: Concurrent Value Is a Downstream Review Policy

**Status:** Accepted

Concurrent different projects can each retain their full reviewed duration when work provides meaningful value and the user responds before the session becomes dormant. Worklog merges overlap within each project and infers only same-session gaps within the selected five-minute response grace. Raw human and agent streams remain independent observations, not automatic billing claims.

Historical evidence lacks blocker/progress transitions, so a human reviews those conditions before approving a daily batch. Approval leads to automatic filing of that snapshot, not unattended future submission. The evidence collector remains provider-neutral. See [billing policy and review](/docs/billing.md).

## D-009: Separate Human Corrections from Automatic Candidates

**Status:** Accepted

Incomplete automatic evidence must not become an uncorrectable ceiling on independently confirmed work. A reviewed duration may exceed its candidate when the reviewer supplies a nonblank private adjustment reason. Keep the measured candidate, source observations, and stable identity unchanged; never enlarge the candidate to bypass validation.

The optional string `adjustmentReason` extends review-batch version 1. Existing non-increased drafts may omit it; malformed metadata is rejected. Edits require fresh review and approval, final approval displays both durations and the reason, and confirmed evidence refresh archives the prior correction before rebuilding an unapproved draft. The reason stays out of provider notes. This revises the earlier candidate ceiling, not the independent calibration policy or the requirement for authoritative signals before unattended billing.
