# QA Evidence

## Acceptance Evidence

The current behavior is covered by focused tests in the repository:

| Behavior | Evidence location |
| --- | --- |
| Project Time evidence parsing, filtering, grouping, mappings, drafts, and compact timesheet formatting | `test/project-time.test.js` |
| OMP command parsing, completions, host-resolved settings and option precedence, read-only draft tools, write approval, and interactive summary lifecycle | `test/omp-plugin.test.js` |
| Harvest destination adapter validation and write behavior | `test_omp_worklog.rb` |
| Installed revision rejection, user-setting preservation, export failure safety, and private recovery snapshots | `test/release-plugin.test.js` |
| Daily human/AI reports, within-project deduplication, cross-project concurrency, response grace, cutoff, and review candidates | `test/project-time-report.test.js` |
| Private unapproved batches, approval rejection, headless safety, and new command completion | `test/worklog-workflow.test.js` |
| Native daily review edits, readiness, exclusion, cancellation, and exact duration boundaries | `test/daily-review.test.js` |
| Correction rationale validation, declined final approval, save/resume, and refresh preservation | `test/duration-adjustments.test.js` |
| Reviewed-batch preflight, provider scoping/pagination, idempotency, and uncertain/partial recovery | `test_batch_cli.rb` |

Run the relevant JavaScript suite with:

```bash
npm test
```

Run both Ruby CLI suites with:

```bash
npm run test:ruby
```

For a no-write CLI smoke check, run:

```bash
bin/omp-worklog --help
```

## Implementation Change Checks

Run both suites when a change reaches the OMP-to-CLI boundary; otherwise run the owning suite. There is no Docker wrapper in this repository. Tests use synthetic fixtures and must not require Harvest credentials or write to a real account.

For evidence or completion changes, also exercise the actual reader/transform with a temporary ledger. Use a live SQLite WAL writer for cache changes: warm completion, insert a different project without closing the writer, and verify that the existing loader sees it. A JSON fixture or a new loader cannot prove cache invalidation. For duration changes, include a positive interval below the decimal-hour rounding threshold and inspect its exact draft duration.

Use valid leap dates and invalid calendar endpoints when changing date-range validation. Preserve local-day splitting and source-kind separation. Concurrent different projects are permitted by policy; do not add a global cap or double-count overlapping human/agent evidence within one project. Historical elapsed observations still require progress/blocker review before billing.

For settings changes, exercise the supported host CLI from the intended project cwd, then verify both a saved user mapping and a different project override in separate fresh OMP processes. Explicit factory options must override resolved values, but an injected loader or explicit mapping alone cannot prove host scope resolution. Capability probes and public reports must omit private setting values.

Permanent regressions should verify consumer-visible data or transitions. Remove obsolete expectations that pin data loss or incidental implementation behavior rather than preserving them as policy. Keep temporary probes and private calibration snapshots out of the repository.

For batch changes, exercise the real Ruby client transport against a disposable local HTTP server with synthetic credentials and records. Prove a dry run performs no create, two concurrent approved projects both file, a repeated identity reconciles without duplication, and a later failure leaves truthful partial/uncertain state. A fake exposing invented client methods is not transport proof. Never use actual historical Harvest writes as release QA.

For daily-review changes, launch a fresh interactive OMP process with synthetic local evidence. Exercise `/worklog review`, enter a duration above its candidate, verify missing rationale blocks review, and edit a rationale and factual note using the native editor. Mark reviewed, save/resume, change the rationale to invalidate review, then inspect and decline the final approval before confirming a reviewed snapshot. Observe the actual dialogs and filing result; an injected provider boundary is UI evidence only, not real Harvest transport proof. Separately exercise the Ruby HTTP transport against a disposable provider. Keep QA credentials/data synthetic and never submit a production workday as validation.

## Documentation Verification

For a documentation change, verify every local Markdown link, then check each implementation claim against its owning source and test. The implementation and its tests remain authoritative for detailed behavior; this knowledge base must not create a conflicting second specification.

## Release Boundary

Release instructions and installed-plugin verification live in the [repository README](../README.md#release). A documentation-only change does not by itself change the gem or plugin artifact, so it does not require publishing or reinstalling one.

The plugin host deletes saved user settings on uninstall. The release wrapper therefore exports only explicit user values through the supported CLI from an isolated cwd, saves an owner-only recovery snapshot, then restores and verifies values after reinstalling. Release QA must compare saved settings before and after the real clean reinstall; successful installation or passing plugin tests alone cannot prove configuration preservation. Do not promote project overrides or defaults into global settings.
