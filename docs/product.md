# Product Direction

## Purpose

OMP Worklog converts local OMP Project Time evidence into a human-reviewable record of work. The immediate user job is to inspect a concise daily record, correct destination details if necessary, and choose whether to create an external entry.

## Current Product

The current package provides:

1. A compact human-active-only timesheet plus daily human/AI reports with exact project and local-date boundaries.
2. Configurable projections from local projects to Harvest destinations.
3. Private concurrent-project review batches: within-project overlap is merged, cross-project overlap is retained, and inferred response gaps use a five-minute default grace.
4. Explicit time-off, ordinary-work, and reviewed-batch Harvest writes through the Ruby adapter, with OMP approval surfaces.
5. A compact status prioritizing today's and retained developer/agent decimal hours for the current thread/project, with project/activity secondary at the end.

Reading evidence and preparing candidates need no Harvest credentials. Batch preflight reads Harvest; submission creates entries only after review and explicit approval. There is no unattended scheduler.

## Product Direction

The core product is a time-log and workflow tracker, not a Harvest client. Its standard output should be a concise, provider-neutral, line-oriented time log:

```text
Project: task: duration
```

Each standard record carries a source-side project, reviewable task label, and duration. OMP Project Time is the analytical source. The work-log layer should turn that evidence into clear records without making an external destination part of the canonical record. A Harvest mapping is a downstream projection used when a person deliberately chooses Harvest as the destination.

The reviewed-batch integration writes approved records to Harvest without making Harvest the analytical source of truth. Another destination can consume the same review boundary without redefining evidence collection.

## Experience Rules

- Prefer compact, standard work-log output over raw interval dumps.
- Preserve enough provenance in explicit diagnostics for review, but do not make source metadata the normal interactive output.
- Treat generated summaries and destination mappings as review aids, never as factual replacement for evidence or user approval.
- Require an explicit user action for any external write.
- Keep the local project/task/duration record useful when no external mapping exists.
- Support legitimate concurrent-project value without imposing a global wall-clock billing cap.
- Keep source observations, inferred candidates, and approved durations visibly distinct.
- Live status uses normal foreground contrast and prioritizes local-day/retained source durations over identity, state labels, or seconds. Project/activity appears only as trailing context. It never combines developer and agent hours or silently broadens thread/project scope.
- The time line is enabled by default and optional through Worklog's `showTimeStatus`; hiding presentation does not stop source collection or restore a duplicate collector line.

## Non-goals for the Current Release

This release does not alter Project Time's evidence schema, reconstruct historical blocker/dormancy state, certify elapsed AI time automatically, submit unattended, or modify existing destination entries. Authoritative prospective blocker evidence is tracked separately in issue #141; the independent private calibration study remains issue #133.
