# Reviewed Concurrent Worklogs

## Policy and Evidence

Worklog supports independent billing candidates for concurrent projects. Productive work on one project does not lose time merely because another project is progressing simultaneously. Within one local project, overlapping human/agent evidence and overlapping sessions are merged so the same project-minute is not counted twice.

The default response grace is **five minutes**, as selected by the maintainer. A gap no longer than that may be bridged only between observations from the same recorded project and session. It is an inferred response gap, not proof of meaningful progress. Longer gaps and missing/different session identities are not bridged. The algorithm does not extrapolate an open turn or invent an ending after the last observation.

`human_active` is presumed prompt-driven collaboration; `agent_turn_elapsed` is elapsed lifecycle time, not CPU or token-generation time. They remain separate observations. Neither label certifies billable work. Historical evidence does not show user/permission waits, continuous meaningful progress, or dormancy transitions. Review those conditions and reduce candidate durations where the user was blocking work or the session was dormant. More authoritative prospective signals are tracked in [issue #141](https://github.com/klondikemarlen/omp-worklog/issues/141).

## Daily Reports

```text
/worklog stats 2026-10-05 2026-10-18
/worklog stats 2026-10-19 --until 12:00
/worklog stats yesterday --project "Demo Project"
```

`stats` reports every selected local day, including days without evidence, and separates human-active and agent-turn durations by exact local project. A candidate is the within-project union plus eligible inferred response gaps, not the sum of those source totals. Different projects keep independent candidates with no global wall-clock cap.

`--until HH:MM` clips only the final date in a range. Dates and midnight boundaries use the local timezone of the process generating the report. Exact milliseconds remain available in structured results; the formatted view shows durations without discarding short positive intervals.

The legacy `/worklog timesheet DATE` remains a compact human-active-only preview. It does not become an approved billing total when this workflow is enabled.

## End-of-Workday Review

```text
/worklog review
/worklog review yesterday
```

`review` defaults to today and opens native OMP dialogs, not a JSON document. It also accepts an explicit date, optional `--project PROJECT`, and `--until HH:MM`.

1. Select a project to inspect its human/AI observations, candidate duration, destination, factual note, and review status.
2. Use **Edit duration**, **Edit adjustment reason**, **Edit destination project**, **Edit task**, or **Edit note** as needed. Duration accepts `H:MM[:SS[.sss]]` and must be a positive safe-integer number of milliseconds. An increase above the automatic candidate requires a nonblank adjustment reason; it is shown as a human correction, not additional measured evidence. Use the editor's displayed submit shortcut to save a field; plain Enter may insert a newline.
3. Choose **Mark reviewed** after checking progress/blockers, the retained duration, any correction reason, destination, and factual note. An incomplete increase cannot be reviewed. Any edit clears review and prior approval. Choose **Exclude entry** for work that should not be submitted.
4. Choose **Submit to Harvest** after every retained entry is reviewed. A final confirmation shows the automatic candidate, reviewed duration, correction reason, destination, and factual note. Confirming approves that exact snapshot; declining saves without approval or provider access.

**Save and close**, or cancelling the main list, saves progress without approval. Reopening with the same date and filters resumes that private draft, including corrections and their reasons. Drafts are snapshots, not live-running totals: **Refresh evidence** rebuilds from the current ledger and mappings after confirmation, retains the prior draft in a private `previous-*` directory, and clears corrections, reasons, review, and approval in the new snapshot.

Daily drafts live alongside other review batches under `~/.omp/worklog/review-batches/`, with owner-only directories and files. Different project/cutoff filters retain separate drafts. No source evidence is rewritten. Headless callers cannot implicitly approve this interactive flow; use the explicit file-based interfaces below.

## Prepare and Review a Daily Batch

```text
/worklog plan yesterday
/worklog plan yesterday --project "Demo Project"
```

Preparation reads local evidence only and saves an owner-only JSON file beneath `~/.omp/worklog/review-batches/`. It displays the generated path. No Harvest request or write occurs.

The draft has format `omp-worklog/review-batch`, version `1`, and `approved: false`. Every positive project/day candidate remains visible. A configured project/task mapping may prefill a destination even when source work-item attribution needs review; this does not certify the destination. Unmapped records have null destinations and cannot be submitted until resolved.

Version 1 entries may include the optional string `adjustmentReason`. Existing version 1 drafts without it remain valid when the reviewed duration does not exceed the candidate. A present non-string reason is malformed, and an above-candidate duration without a nonblank reason is rejected. Older submitters may reject the additional field; upgrade the plugin and Ruby CLI together rather than removing correction provenance. Unsupported document versions and unknown Ruby batch fields remain errors.

For **each** entry:

1. Review its exact local project, source evidence, inferred response gaps, and progress/blocker uncertainty. Source IDs are retained for audit; original evidence is never rewritten.
2. Confirm or correct the destination `project` and `task`.
3. Set the reviewed `milliseconds` after excluding blocked, dormant, or otherwise non-billable time. It must be a positive safe integer. If independently confirmed work exceeds `candidateMilliseconds`, record a nonblank `adjustmentReason`; leave the candidate, source observations, and source IDs unchanged. This is a human adjustment, never an automatic inference that missing time was productive. Remove a record when no work should be filed.
4. Write a factual `notes` value. Generated narratives and activity labels are review aids, not an automatically approved note.
5. Set `reviewed: true` only after completing those checks. Editing the duration, reason, destination, or factual note requires review and approval again.

Keep generated `id`, `spentDate`, and `localProject` unchanged. The stable identity represents one local project's reviewed record for one date. Changing hours, notes, or a mapping after filing does not create a new identity and must not silently add another entry.

## One Approval, Then Batch Filing

Interactive OMP:

```text
/worklog submit "PATH-PRINTED-BY-PLAN" --dry-run
/worklog submit "PATH-PRINTED-BY-PLAN"
```

The dry run preflights complete reviewed records and reads existing recovery receipts without changing them or creating entries. It may read Harvest and therefore needs the normal credentials. A real interactive submit presents the actual reviewed destinations, candidate and reviewed durations, correction reasons, notes, and policy for one final confirmation. Declining makes no external write. Approval applies to that in-memory batch snapshot; it does not turn future evidence or batches into approved work. Adjustment reasons remain private review provenance and are not appended to Harvest notes.

Headless/programmatic use requires an explicitly approved document (`approved: true`, with every record reviewed):

```sh
omp-worklog work-entry-batch --dry-run < reviewed-batch.json
omp-worklog work-entry-batch < approved-batch.json
```

The `omp_worklog_submit_reviewed_batch` write tool accepts the saved approved batch path and optional `dryRun`. It cannot approve an unreviewed candidate. There is no unattended scheduler or implicit daily submission. Keep the file private and out of Git.

## Submission Safety and Recovery

The Ruby adapter validates the whole document before provider access and preflights the whole batch before any create. It resolves active personal assignments, scopes reads and writes to the authenticated user/account, and enumerates relevant pages. Missing/ambiguous destinations, malformed records, conflicts, and unrelated or locked entries block rather than being silently skipped or overwritten.

The batch adapter supports duration-entry accounts; timestamp-timer accounts are rejected before creates. Two local projects resolving to the same date/project/task are a destination conflict and require review rather than duplicate filing.

Each create carries a stable external reference. Exact reruns reconcile as already filed; changed content under an existing identity is a conflict. Private account/user-scoped receipts and a local lock serialize submissions on one workstation. This is not a claim of atomic duplicate protection across different machines; submit from one managed workstation.

A pending receipt is saved before sending a create. If a response is uncertain, remaining writes stop and a later run checks for the exact remote record. If no matching remote record is found, the uncertain identity stays blocked rather than automatically retrying a potentially accepted POST. Do not delete receipts or retry with a new identity to bypass that protection. Inspect the provider and resolve the uncertain outcome deliberately.

A batch can partially succeed if a later create fails. Results identify created, already-filed, blocked, conflicting, uncertain, or not-submitted records; batch-level validation failures also include a machine-readable reason. Timeouts, including HTTP 408, remain uncertain rather than proving rejection. There is no destructive rollback. Existing provider entries are never modified or deleted by this workflow.

Back up `~/.omp/worklog/` privately along with the approved documents and submission receipts. Protect directories/files with owner-only permissions. Do not publish client names, notes, raw evidence, credentials, or recovery files in issues or PRs. Configuration backup and the independent calibration dossier remain separate concerns; see [calibration](/docs/calibration.md).
