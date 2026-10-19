# QA Evidence

## Acceptance Evidence

The current behavior is covered by focused tests in the repository:

| Behavior | Evidence location |
| --- | --- |
| Project Time evidence parsing, filtering, grouping, mappings, drafts, and compact timesheet formatting | `test/project-time.test.js` |
| OMP command parsing, completions, host-resolved settings and option precedence, read-only draft tools, write approval, and interactive summary lifecycle | `test/omp-plugin.test.js` |
| Harvest destination adapter validation and write behavior | `test_omp_worklog.rb` |
| Installed revision rejection, user-setting preservation, export failure safety, and private recovery snapshots | `test/release-plugin.test.js` |

Run the relevant JavaScript suite with:

```bash
npm test
```

Run the Ruby CLI suite with:

```bash
ruby test_omp_worklog.rb
```

For a no-write CLI smoke check, run:

```bash
bin/omp-worklog --help
```

## Implementation Change Checks

Run both suites when a change reaches the OMP-to-CLI boundary; otherwise run the owning suite. There is no Docker wrapper in this repository. Tests use synthetic fixtures and must not require Harvest credentials or write to a real account.

For evidence or completion changes, also exercise the actual reader/transform with a temporary ledger. Use a live SQLite WAL writer for cache changes: warm completion, insert a different project without closing the writer, and verify that the existing loader sees it. A JSON fixture or a new loader cannot prove cache invalidation. For duration changes, include a positive interval below the decimal-hour rounding threshold and inspect its exact draft duration.

Use valid leap dates and invalid calendar endpoints when changing date-range validation. Preserve local-day splitting and source-kind separation; do not treat summed overlapping intervals as billable time.

For settings changes, exercise the supported host CLI from the intended project cwd, then verify both a saved user mapping and a different project override in separate fresh OMP processes. Explicit factory options must override resolved values, but an injected loader or explicit mapping alone cannot prove host scope resolution. Capability probes and public reports must omit private setting values.

Permanent regressions should verify consumer-visible data or transitions. Remove obsolete expectations that pin data loss or incidental implementation behavior rather than preserving them as policy. Keep temporary probes and private calibration snapshots out of the repository.

## Documentation Verification

For a documentation change, verify every local Markdown link, then check each implementation claim against its owning source and test. The implementation and its tests remain authoritative for detailed behavior; this knowledge base must not create a conflicting second specification.

## Release Boundary

Release instructions and installed-plugin verification live in the [repository README](../README.md#release). A documentation-only change does not by itself change the gem or plugin artifact, so it does not require publishing or reinstalling one.

The plugin host deletes saved user settings on uninstall. The release wrapper therefore exports only explicit user values through the supported CLI from an isolated cwd, saves an owner-only recovery snapshot, then restores and verifies values after reinstalling. Release QA must compare saved settings before and after the real clean reinstall; successful installation or passing plugin tests alone cannot prove configuration preservation. Do not promote project overrides or defaults into global settings.
