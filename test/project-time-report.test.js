import assert from "node:assert/strict"
import test from "node:test"

import { projectTimeDailyReport, createProjectTimeReviewBatch } from "../project-time-report.js"
import { parseProjectTimeMappings, projectTimeProjectNames } from "../project-time.js"

const evidenceState = entries => ({ format: "omp-project-time/evidence", version: 1, entries })
const at = (day, hour, minute = 0, second = 0, millisecond = 0) =>
  new Date(2026, 9, day, hour, minute, second, millisecond).getTime()
const oneDay = { from: "2026-10-19", to: "2026-10-19" }

test("when projects overlap and human and agent sources overlap, it preserves independent observations and project concurrency", () => {
  const state = evidenceState([
    { id: "human-demo", project: "Demo", sourceKind: "human_active", sessionId: "demo-session", startAtMs: at(19, 9), endAtMs: at(19, 9, 10) },
    { id: "agent-demo", project: "Demo", sourceKind: "agent_turn_elapsed", sessionId: "demo-session", startAtMs: at(19, 9, 5), endAtMs: at(19, 9, 15) },
    { id: "human-other", project: "Other", sourceKind: "human_active", sessionId: "other-session", startAtMs: at(19, 9, 3), endAtMs: at(19, 9, 8) },
  ])

  const report = projectTimeDailyReport(state, oneDay)

  assert.deepEqual(report.totals, {
    humanActiveMilliseconds: 900_000,
    agentTurnMilliseconds: 600_000,
    candidateMilliseconds: 1_200_000,
  })
  assert.deepEqual(report.days[0].projects, [
    {
      project: "Demo",
      humanActiveMilliseconds: 600_000,
      agentTurnMilliseconds: 600_000,
      sourceUnionMilliseconds: 900_000,
      bridgedGapMilliseconds: 0,
      candidateMilliseconds: 900_000,
      sourceEntryIds: ["agent-demo", "human-demo"],
      reviewReasons: ["progress_and_user_blockers_require_review"],
    },
    {
      project: "Other",
      humanActiveMilliseconds: 300_000,
      agentTurnMilliseconds: 0,
      sourceUnionMilliseconds: 300_000,
      bridgedGapMilliseconds: 0,
      candidateMilliseconds: 300_000,
      sourceEntryIds: ["human-other"],
      reviewReasons: ["progress_and_user_blockers_require_review"],
    },
  ])
})

test("when same-project sessions overlap concurrently, it unions candidate time without capping the observations", () => {
  const state = evidenceState([
    { id: "session-one", project: "Demo", sourceKind: "human_active", sessionId: "one", startAtMs: at(19, 9), endAtMs: at(19, 10) },
    { id: "session-two", project: "Demo", sourceKind: "human_active", sessionId: "two", startAtMs: at(19, 9, 30), endAtMs: at(19, 10, 30) },
  ])

  const project = projectTimeDailyReport(state, oneDay).days[0].projects[0]

  assert.equal(project.humanActiveMilliseconds, 7_200_000)
  assert.equal(project.sourceUnionMilliseconds, 5_400_000)
  assert.equal(project.candidateMilliseconds, 5_400_000)
  assert.equal(project.bridgedGapMilliseconds, 0)
})

test("when same-session gaps meet or exceed response grace, only an exact-grace gap is bridged", () => {
  const state = evidenceState([
    { id: "grace-before", project: "Demo", sourceKind: "human_active", sessionId: "grace", startAtMs: at(19, 9), endAtMs: at(19, 9, 1) },
    { id: "grace-after", project: "Demo", sourceKind: "agent_turn_elapsed", sessionId: "grace", startAtMs: at(19, 9, 6), endAtMs: at(19, 9, 7) },
    { id: "long-before", project: "Demo", sourceKind: "human_active", sessionId: "long", startAtMs: at(19, 10), endAtMs: at(19, 10, 1) },
    { id: "long-after", project: "Demo", sourceKind: "human_active", sessionId: "long", startAtMs: at(19, 10, 6, 1), endAtMs: at(19, 10, 7, 1) },
    { id: "first-session", project: "Demo", sourceKind: "human_active", sessionId: "first", startAtMs: at(19, 11), endAtMs: at(19, 11, 1) },
    { id: "second-session", project: "Demo", sourceKind: "human_active", sessionId: "second", startAtMs: at(19, 11, 3), endAtMs: at(19, 11, 4) },
    { id: "missing-first", project: "Demo", sourceKind: "human_active", startAtMs: at(19, 12), endAtMs: at(19, 12, 1) },
    { id: "missing-second", project: "Demo", sourceKind: "human_active", startAtMs: at(19, 12, 3), endAtMs: at(19, 12, 4) },
  ])

  const project = projectTimeDailyReport(state, oneDay).days[0].projects[0]

  assert.equal(project.humanActiveMilliseconds, 420_000)
  assert.equal(project.agentTurnMilliseconds, 60_000)
  assert.equal(project.sourceUnionMilliseconds, 480_000)
  assert.equal(project.bridgedGapMilliseconds, 300_000)
  assert.equal(project.candidateMilliseconds, 780_000)
  assert.deepEqual(project.reviewReasons, [
    "progress_and_user_blockers_require_review",
    "response_gaps_inferred",
    "missing_session_identity",
  ])
})

test("when a same-session response gap crosses midnight, it is bridged before each day's cutoff clipping", () => {
  const state = evidenceState([
    { id: "before-midnight", project: "Demo", sourceKind: "human_active", sessionId: "night", startAtMs: at(19, 23, 58), endAtMs: at(19, 23, 59) },
    { id: "after-midnight", project: "Demo", sourceKind: "human_active", sessionId: "night", startAtMs: at(20, 0, 3), endAtMs: at(20, 0, 4) },
  ])

  const report = projectTimeDailyReport(state, {
    from: "2026-10-19",
    to: "2026-10-20",
    until: "00:02",
  })

  assert.deepEqual(report.days.map(day => ({
    spentDate: day.spentDate,
    humanActiveMilliseconds: day.humanActiveMilliseconds,
    candidateMilliseconds: day.candidateMilliseconds,
    project: day.projects[0] && {
      sourceUnionMilliseconds: day.projects[0].sourceUnionMilliseconds,
      bridgedGapMilliseconds: day.projects[0].bridgedGapMilliseconds,
      candidateMilliseconds: day.projects[0].candidateMilliseconds,
    },
  })), [
    {
      spentDate: "2026-10-19",
      humanActiveMilliseconds: 60_000,
      candidateMilliseconds: 120_000,
      project: { sourceUnionMilliseconds: 60_000, bridgedGapMilliseconds: 60_000, candidateMilliseconds: 120_000 },
    },
    {
      spentDate: "2026-10-20",
      humanActiveMilliseconds: 0,
      candidateMilliseconds: 120_000,
      project: { sourceUnionMilliseconds: 0, bridgedGapMilliseconds: 120_000, candidateMilliseconds: 120_000 },
    },
  ])
})

test("when report dates or mappings are invalid, it rejects them and still emits zero-evidence days", () => {
  const emptyState = evidenceState([])

  assert.throws(() => projectTimeDailyReport(emptyState, { from: "2026-02-30", to: "2026-03-01" }), /valid local date/)
  assert.throws(() => projectTimeDailyReport(emptyState, { from: "today", to: "2026-10-19" }), /ISO date range/)
  assert.throws(() => projectTimeDailyReport(emptyState, { ...oneDay, until: "24:00" }), /HH:MM/)
  assert.throws(() => createProjectTimeReviewBatch(emptyState, {}, oneDay), /parsed project mapping Map/)
  assert.throws(() => createProjectTimeReviewBatch(emptyState, new Map([["Demo", { project: " ", task: "Development" }]]), oneDay), /nonblank project and task/)

  const report = projectTimeDailyReport(emptyState, { from: "2026-10-19", to: "2026-10-20" })
  assert.deepEqual(report.days.map(day => day.spentDate), ["2026-10-19", "2026-10-20"])
  assert.deepEqual(report.days.map(day => day.candidateMilliseconds), [0, 0])
})

test("when unassigned work has an explicit project mapping, the review batch keeps it unapproved and requires notes", () => {
  const state = evidenceState([
    { id: "demo-source", project: "Demo", sourceKind: "human_active", sessionId: "session-1", workItemAttribution: "unassigned", startAtMs: at(19, 9), endAtMs: at(19, 9, 10) },
    { id: "unmapped-source", project: "Unmapped", sourceKind: "human_active", sessionId: "session-2", startAtMs: at(19, 10), endAtMs: at(19, 10, 5) },
  ])
  const mappings = parseProjectTimeMappings({ Demo: { project: "Internal", task: "Development" } })

  const batch = createProjectTimeReviewBatch(state, mappings, oneDay)

  assert.equal(batch.approved, false)
  assert.deepEqual(batch.policy, { mode: "concurrent-projects", responseGraceMinutes: 5 })
  assert.deepEqual(batch.entries, [
    {
      id: "omp-worklog-v1:bdc164829636df3119cda6ae8967ff6cdec52610cbabb4833312f6b5dd5344d7",
      spentDate: "2026-10-19",
      localProject: "Demo",
      project: "Internal",
      task: "Development",
      candidateMilliseconds: 600_000,
      milliseconds: 600_000,
      humanActiveMilliseconds: 600_000,
      agentTurnMilliseconds: 0,
      bridgedGapMilliseconds: 0,
      sourceEntryIds: ["demo-source"],
      notes: "",
      reviewed: false,
      reviewReasons: ["progress_and_user_blockers_require_review"],
    },
    {
      id: "omp-worklog-v1:95414949954e7e7d6cc8d9c6f75b3ad953e5ec4e8953a45da3043a00d7d58d47",
      spentDate: "2026-10-19",
      localProject: "Unmapped",
      project: null,
      task: null,
      candidateMilliseconds: 300_000,
      milliseconds: 300_000,
      humanActiveMilliseconds: 300_000,
      agentTurnMilliseconds: 0,
      bridgedGapMilliseconds: 0,
      sourceEntryIds: ["unmapped-source"],
      notes: "",
      reviewed: false,
      reviewReasons: ["progress_and_user_blockers_require_review", "destination_required"],
    },
  ])
})

test("report project discovery includes agent-only projects but excludes unrelated source kinds", () => {
  const state = evidenceState([
    { project: "Agent-only", sourceKind: "agent_turn_elapsed" },
    { project: "Human", sourceKind: "human_active" },
    { project: "Unrelated", sourceKind: "unknown" },
  ])

  assert.deepEqual(projectTimeProjectNames(state, { includeAgentTurns: true }), ["Agent-only", "Human"])
})
