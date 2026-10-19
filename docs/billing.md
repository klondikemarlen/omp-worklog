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

## Prepare and Review a Daily Batch

```text
/worklog plan yesterday
/worklog plan yesterday --project "Demo Project"
```

Preparation reads local evidence only and saves an owner-only JSON file beneath `~/.omp/worklog/review-batches/`. It displays the generated path. No Harvest request or write occurs.

The draft has format `omp-worklog/review-batch`, version `1`, and `approved: false`. Every positive project/day candidate remains visible. A configured project/task mapping may prefill a destination even when source work-item attribution needs review; this does not certify the destination. Unmapped records have null destinations and cannot be submitted until resolved.

For **each** entry:

1. Review its exact local project, source evidence, inferred response gaps, and progress/blocker uncertainty. Source IDs are retained for audit; original evidence is never rewritten.
2. Confirm or correct the destination `project` and `task`.
3. Reduce `milliseconds` as needed to exclude blocked, dormant, or otherwise non-billable time. It must remain positive and cannot exceed `candidateMilliseconds`. Remove a record from the reviewed batch if none of its candidate should be filed.
4. Write a factual `notes` value. Generated narratives and activity labels are review aids, not an automatically approved note.
5. Set `reviewed: true` only after completing those checks.

Keep generated `id`, `spentDate`, and `localProject` unchanged. The stable identity represents one local project's reviewed record for one date. Changing hours, notes, or a mapping after filing does not create a new identity and must not silently add another entry.

## One Approval, Then Batch Filing

Interactive OMP:

```text
/worklog submit "PATH-PRINTED-BY-PLAN" --dry-run
/worklog submit "PATH-PRINTED-BY-PLAN"
```

The dry run preflights complete reviewed records and reads existing recovery receipts without changing them or creating entries. It may read Harvest and therefore needs the normal credentials. A real interactive submit presents the actual reviewed destinations, durations, notes, and policy for one final confirmation. Declining makes no external write. Approval applies to that in-memory batch snapshot; it does not turn future evidence or batches into approved work.

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
