# OMP Worklog

OMP Worklog is a Project Time-driven Ruby CLI and OMP plugin that builds reviewable personal work logs from local evidence. Harvest is currently one manual destination: the only Harvest operations are explicitly requested time-off and ordinary-work writes.

## Documentation

The repository-local [knowledge base](docs/README.md) defines the product direction, domain, architecture, decisions, and QA boundaries. It distinguishes the provider-neutral work-log direction from the current Harvest-specific adapters.

## Credentials

1. Open [Harvest ID Developers](https://id.getharvest.com/developers) and create a Personal Access Token for this local tool.
2. Harvest displays the token and the available Harvest account IDs once. Copy the account ID for the account to track time in.
3. Fill the ignored `.envrc` in this repository:

   ```bash
   export HARVEST_ACCESS_TOKEN="your-personal-access-token"
   export HARVEST_ACCOUNT_ID="your-harvest-account-id"
   ```

4. Run `direnv allow` if you use direnv; otherwise run `source .envrc` in the shell that starts OMP or the CLI.

Personal Access Tokens are the intended Harvest authentication method for personal scripts. Revoke and replace a token from Harvest ID if it is exposed. [Harvest authentication documentation](https://help.getharvest.com/api-v2/authentication-api/authentication/authentication/).

## CLI

```text
omp-worklog time-off FROM TO --project NAME --task NAME [options]
omp-worklog time-off FROM TO --project-id ID --task-id ID [options]
omp-worklog work-entry DATE --project NAME --task NAME --hours HOURS --notes NOTES [options]
omp-worklog work-entry DATE --project-id ID --task-id ID --hours HOURS --notes NOTES [options]
```

### Time off

The `time-off` command creates one 7-hour entry for each Yukon business day in an inclusive range. It skips weekends and observed Yukon holidays by default.

```bash
omp-worklog time-off 2026-08-17 2026-08-28 \
  --project 'Time Off - Marlen' \
  --task 'Vacation / PTO' \
  --notes 'regular time off' \
  --dry-run
```

The default holiday region is `ca_yt`. Add `--holiday-region REGION` or set `HARVEST_HOLIDAY_REGIONS` to include other [Holidays](https://github.com/holidays/holidays) regions. `business_time` calculates business days and `holidays` supplies observed statutory holidays.

A time-off block never creates weekend entries. When names are supplied, it resolves them from your active personal Harvest assignments, so a Project Manager role is not required.

The `omp_worklog_record_time_off` OMP tool accepts the same name pair or ID pair. Its optional `holidayRegions` array adds per-call regions to the configured defaults.

### Reviewed ordinary work

The `work-entry` command checks for existing or locked entries for its project, task, and date before creating a new duration entry. Use `--dry-run` to complete that preflight without a write.

### Project Time timesheets

`/worklog timesheet DATE` reads local `human_active` Project Time evidence and produces one review-only draft for every local project active on that day. It does not call Harvest or require Harvest credentials.

Use `--project PROJECT` only to restrict the draft to one exact local Project Time project:

```text
/worklog timesheet yesterday
/worklog timesheet yesterday --project wrap
```

A configured `projectTimeMappings` destination becomes the draft's Harvest `Project` and `Task`. Evidence with no mapping, an ambiguous work item, or an unassigned work item remains visible under its exact local project with `Harvest: Review destination`; choose the Harvest project and task before submitting. The command first renders date, local project, duration, and Harvest destination on separate lines in a single column, bounded to 22 physical lines. In interactive OMP sessions, a keyed `Generating work summary…` widget appears while the active model works and is replaced in place by the final summary or unavailable fallback. Summary evidence is ranked by cumulative workstream duration so structured repository and GitHub issue/PR context outweighs fragmented individual prompts. The final generated section contains one to three broad outcome bullets and a suggested Harvest note, remains bounded before display, and keeps the combined result within 30 logical lines. GitHub issue/PR numbers and Jira ticket IDs are extracted as facts, not inferred by the model. `harvest_preview_project_time_drafts` retains source IDs, source kinds, repository identities, intervals, work-item attribution, and narratives for detailed review. Nothing is submitted automatically.

#### Interactive Timesheet Specification

User stories:

- As a worker preparing a Harvest entry, I see one vertical column containing the date, exact local project, total duration, Harvest project/task or review warning, a short work summary, and a suggested note.
- As a worker waiting for the summary, I see one generation widget replaced in place by the final output.
- As a worker using `--project`, I see only that exact local project; unrelated projects and excluded records stay hidden.
- As a reviewer, I see broad duration-weighted work outcomes, generated prose marked for review, and only ticket identifiers grounded in selected evidence.
- As an auditor, I use the explicit preview tools when I need source IDs, intervals, repository metadata, raw narratives, or attribution details.

The observable contract is a deterministic block of at most 22 physical lines followed by a generated section of at most six lines, keeping the complete result within 30 logical lines. Every total stacks date, exact local project, aggregate duration, and configured Harvest project/task or `Review destination` on separate lines. The generated section uses the `AI-generated work summary (review before use)` heading, one to three concise outcome bullets derived from at most eight duration-ranked evidence records, and a clearly review-marked suggested Harvest note. Generated lines are capped at 100 characters with an ellipsis so one verbose model line cannot consume the screen. In interactive mode, one keyed OMP widget is updated from the generation state to final content; print and RPC modes retain a normal transcript message. The command remains review-only and never writes Harvest.

Type `/worklog ` in OMP to discover `timesheet`; date aliases appear after selecting `timesheet `. After `--project`, Tab lists local human-active Project Time project names. Completion preserves the exact local project name.

## OMP settings

The manifest declares the following settings. **Persisted settings are currently inactive in the extension**: OMP does not expose resolved user-plus-project plugin settings at factory initialization. Explicit factory options work for programmatic callers and tests. [Issue #134](https://github.com/klondikemarlen/omp-worklog/issues/134) tracks the host dependency; do not assume a successful `omp plugin config set` changed runtime behavior.

- `defaultHours`: hours per business day when a time-off tool call omits `hours`; defaults to `7`.
- `holidayRegions`: comma-separated Holidays regions; defaults to `ca_yt`.
- `command`: direct path to the `omp-worklog` executable.
- `projectTimeLogPath`: optional path to Project Time v1 evidence; defaults to `~/.omp/project-time/time-log.sqlite`. A legacy versioned JSON snapshot is also supported.
- `projectTimeMappings`: optional JSON mapping of exact local projects to Harvest project/task names; defaults to `{}`.

The host stores user plugin settings in `~/.omp/plugins/omp-plugins.lock.json` and project overrides in `.omp/plugin-overrides.json`. Back up private configuration outside Git before uninstalling/reinstalling a plugin. Worklog deliberately does not parse these files itself or bypass project precedence.

## OMP Project Time integration

Configure `projectTimeMappings` with the recorded OMP Project Time project name as the key:

```json
{
  "Harvest API": { "project": "Internal", "task": "Development" }
}
```

OMP Worklog reads Project Time's persisted `omp-project-time/evidence` v1 entries. An absent, unsupported, or malformed ledger produces a no-write diagnostic; run a current Project Time session to create the SQLite ledger before retrying.

`omp_worklog_preview_project_time_drafts` produces deterministic, copyable Date/Project/Task/Duration blocks from all local `human_active` evidence in an inclusive date range. Mapped evidence uses its configured Harvest destination; unmapped, ambiguous, and unassigned evidence remains an explicit local-project draft. It preserves source entry IDs, intervals, source kind, repository identity, narratives, work items, and task-attribution provenance. Generated narratives are review evidence, never task identity or a factual Harvest note. The tool reads the local log only; it never calls or mutates Harvest.

Drafts preserve every positive interval using raw milliseconds, even when rounded decimal `hours` are zero. Exact displayed duration is review evidence, not a Harvest rounding or billable-time policy. Both range endpoints must be real calendar dates.

For independent comparison with manually recorded Harvest entries, follow the [private calibration workflow](/docs/calibration.md). Do not tune from incomplete baselines or commit personal evidence.

### Activity transforms

`omp_worklog_preview_project_time_transforms` emits deterministic JSON for local raw intervals. It accepts an inclusive date range and optional exact `repositoryId`, `project`, and `sourceKind` filters; each matching interval is split by local date and grouped by activity, with missing labels reported as `unlabelled`. It defaults to `human_active` and returns the effective top-level `sourceKind`; selecting `agent_turn_elapsed` requires an explicit source-kind request. Set `applyMappings` to create configured Harvest destinations or review-required local destinations for every included group. The output reports groups and draft entries; it never writes Harvest.



## Migration from Harvest Worklog

Version `0.14.0` is a clean identity cutover. Uninstall the retired `harvest-worklog` gem and OMP plugin, then install `omp-worklog`; replace former `harvest-worklog` CLI and `/harvest-worklog` command invocations with `omp-worklog` and `/omp-worklog`. The retired package, executable, command, tools, module, and settings aliases are not retained.

Version `0.14.3` renames the OMP slash command from `/omp-worklog` to `/worklog`; the `omp-worklog` package identity and CLI executable are unchanged.

## Changes in 0.14.4

- Preserve short positive durations in mapped and review-required drafts.
- Refresh project-name completion when SQLite commits evidence through its write-ahead log.
- Reject impossible calendar dates in transform ranges.
- Document configuration activation limits, runtime ownership, and private calibration.

## Release

Before merging a release PR, self-review its complete diff, address every actionable review comment, and rerun focused QA after fixups. Record the review and QA evidence on the PR. Then merge to `main`, build and publish the Ruby gem, install the released OMP plugin from GitHub, and verify it:

```bash
ruby test_omp_worklog.rb
npm run test:omp
bin/omp-worklog --help
VERSION="$(ruby -Ilib -romp_worklog/version -e 'puts OmpWorklog::VERSION')"
gem build omp-worklog.gemspec
gem push "omp-worklog-${VERSION}.gem"
gem uninstall omp-worklog --all --executables --ignore-dependencies
gem install --clear-sources --source https://rubygems.org omp-worklog --version "$VERSION" --no-document
npm run release
npm run verify:release
omp-worklog --help
```

`npm run release` owns the plugin uninstall/force-install mutation, including removal of the retired plugin when present. `npm run verify:release` never changes the installation: it checks the installed package version, resolved Git revision, and plugin path, then runs the installed JavaScript test suite. It exits after verification; tests alone do not exercise a fresh OMP host.

After installation, start a new OMP process and exercise `/worklog` completion and a timesheet against synthetic local evidence. Verify that a newly committed SQLite project appears without restarting that process. Existing sessions retain startup-loaded extension code and cannot prove the released artifact. Use explicit factory options for a mapped smoke until #134 is resolved; do not claim persisted-setting activation from that smoke.
