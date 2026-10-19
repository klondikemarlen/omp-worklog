# Calibration

## Purpose and Ownership

Calibration asks whether Worklog reduces the work of preparing a reviewed time log. Project Time is automatic evidence, not a billable-time measurement. Harvest is an independently recorded daily reference, not a training target or permission to submit the candidate.

[Issue #133](https://github.com/klondikemarlen/omp-worklog/issues/133) owns the baseline and acceptance criteria. Project Time owns collection defects; Worklog owns downstream grouping, mappings, and review output; the human reviewer owns reference confirmation and discrepancy classification.

## Private Daily Record

Keep the dossier outside the checkout, for example `~/.omp/worklog-calibration/`, with owner-only directories and files. Never commit raw evidence, references, mappings, client names, notes, credentials, or reports. Repository visibility is not a privacy boundary for these artifacts.

For each reviewed local business day:

1. Record or confirm the normal Harvest entry **before** inspecting that day's candidate. Preserve that order; a reference copied from the candidate cannot measure independent agreement.
2. Freeze date-bounded `human_active` evidence and the deterministic Worklog draft. Keep exact milliseconds, source IDs, content hashes, and the mapping/configuration hash. Do not mix `agent_turn_elapsed` into the candidate or rewrite overlapping intervals into presumed billable duration.
3. Preserve the independently confirmed reference: entry ID, date, destination project/task IDs, and duration. Omit notes unless reconciliation actually needs them. This is a read-only snapshot; no importer is currently provided by this repository.
4. Record date, time zone, OMP/Project Time/Worklog versions, the active-window setting, and capture time. Revisions to a reference become a new record, not an overwrite of the frozen baseline.
5. Reconcile daily aggregates using a reviewer-confirmed destination project/task key. Keep unmapped local projects visible and mark them not comparable until a real join exists. Normalize reference hours only at comparison time; retain candidate milliseconds unchanged.

A daily folder can retain `evidence.json`, `candidate.json`, `reference.json`, and `reconciliation.json`. These are private operating artifacts, not a new public evidence schema. Do not backfill missing independent days as if their candidates had been frozen at day close.

## Review and Controlled Change

Freeze ten business days without tuning settings, mappings, prompts, or durations. Review the first five days for data-quality gaps without changing the baseline policy. Missing days remain missing; elapsed calendar time does not establish a complete cohort.

For each nonzero difference, assign one discrepancy class: `collection_gap`, `intentional_non_desk_time`, `concurrency_or_overlap`, `project_or_task_review`, `rounding_or_date_boundary`, `reference_correction`, or `unknown`. Daily durations cannot establish interval-level agreement.

The weekly private report presents day/destination candidate and reference durations, signed and absolute deltas, match state, and discrepancy class. Include cohort totals, median absolute daily delta, unmatched-reference and unmatched-candidate durations, and discrepancy counts. Keep not-comparable rows explicit rather than silently treating them as zero-error matches. Set a usefulness target after observing the baseline distribution.

Select one dominant actionable discrepancy and change one owning surface. Evaluate a separate five-business-day holdout; retain the change only if that mismatch improves without a material regression in another slice. A repository bug fix can be verified independently, but it is not evidence of calibration improvement without the holdout.

## Configuration and Backup

The host persists user plugin settings in `~/.omp/plugins/omp-plugins.lock.json` and project settings in `.omp/plugin-overrides.json`. These files may contain private values: keep backups outside Git and protect them like the originals. The calibration dossier needs its own private backup; backing up repository documentation does not preserve the baseline.

Persisted mappings are not currently consumed by the extension because the host has not exposed supported effective plugin settings to it. [Issue #134](https://github.com/klondikemarlen/omp-worklog/issues/134) tracks activation. A saved configuration value does not prove that a draft used it; verify the destination in a fresh installed-plugin run before starting a mapped cohort. Changes to configuration or artifact versions must remain visible in cohort metadata.
