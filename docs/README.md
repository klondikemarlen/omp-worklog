# OMP Worklog Knowledge Base

OMP Worklog turns local OMP Project Time evidence into reviewable work-log output. Its current published package contains a Harvest-specific write adapter, but the durable product direction is a provider-neutral time log that can project to Harvest or another destination only after review.

## Start Here

- [Product direction](product.md) — present scope, the target `project: task: duration` log, and non-goals.
- [Domain model](domain.md) — the terms and ownership boundaries behind evidence, drafts, mappings, and destinations.
- [Architecture](architecture.md) — the current local data flow and side-effect boundary.
- [Decisions](decisions.md) — durable decisions that explain why the current behavior is constrained.
- [QA evidence](qa.md) — how to validate documented behavior and where detailed test evidence lives.
- [Calibration](/docs/calibration.md) — independent private references, frozen daily evidence, discrepancy review, and holdout evaluation.

## Authority Boundaries

| Question | Authoritative source |
| --- | --- |
| Product purpose, boundaries, and intended direction | This knowledge base |
| Public installation, settings, command usage, and release procedure | [repository README](../README.md) |
| Runtime behavior and implementation decisions at component level | The owning source file and its adjacent tests |
| Automated acceptance evidence | `test/`, `test_omp_worklog.rb`, and command output from the relevant check |
| OMP Project Time evidence schema and collection semantics | The upstream OMP Project Time project |

Keep component-local details—function contracts, parsing rules, error cases, and test fixtures—beside the code that owns them. Summarize only durable cross-component knowledge here.

## Repository and Publication Boundary

These are repository-local Markdown files, not a documentation site. They describe public behavior and intended direction without copying credentials, personal time evidence, account identifiers, or other confidential operational data. The Ruby gem currently packages the repository README; this knowledge base remains source-repository documentation unless a future publication decision changes that boundary.
