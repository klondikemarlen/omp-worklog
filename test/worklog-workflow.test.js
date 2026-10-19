import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { ompWorklogArgumentCompletions, parseOmpWorklogArguments } from "../index.js"
import { prepareWorklogBatch, runWorklogAction, submitWorklogBatch } from "../worklog-workflow.js"

test("preparing a private batch never approves candidate time or invents a factual note", t => {
  // Arrange
  const directory = mkdtempSync(path.join(tmpdir(), "worklog-review-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const logPath = path.join(directory, "evidence.json")
  const startAtMs = new Date(2026, 9, 18, 9).getTime()
  writeFileSync(logPath, JSON.stringify({
    format: "omp-project-time/evidence",
    version: 1,
    entries: [{ id: "source-a", project: "Demo", sessionId: "session-a", sourceKind: "agent_turn_elapsed", startAtMs, endAtMs: startAtMs + 3_600_000 }],
  }))

  // Act
  const prepared = prepareWorklogBatch({ from: "2026-10-18", to: "2026-10-18" }, {
    projectTimeLogPath: logPath,
    dataDirectory: directory,
    projectTimeMappings: '{"Demo":{"project":"Internal","task":"Development"}}',
  })

  // Assert
  const saved = JSON.parse(readFileSync(prepared.batchPath, "utf8"))
  assert.equal(saved.approved, false)
  assert.equal(saved.entries[0].reviewed, false)
  assert.equal(saved.entries[0].notes, "")
  assert.equal(saved.entries[0].milliseconds, 3_600_000)
  assert.equal(statSync(prepared.batchPath).mode & 0o777, 0o600)
  assert.equal(statSync(path.dirname(prepared.batchPath)).mode & 0o777, 0o700)
})

test("an unapproved saved batch cannot reach Harvest submission", async t => {
  // Arrange
  const directory = mkdtempSync(path.join(tmpdir(), "worklog-approval-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const batchPath = path.join(directory, "review.json")
  writeFileSync(batchPath, JSON.stringify({
    format: "omp-worklog/review-batch",
    version: 1,
    approved: false,
    entries: [{ reviewed: true, project: "Internal", task: "Development", milliseconds: 60_000, candidateMilliseconds: 60_000, notes: "Reviewed implementation" }],
  }))

  // Act / Assert
  await assert.rejects(submitWorklogBatch({ batchPath }, {
    run: async () => assert.fail("Unapproved data must not invoke the destination command"),
  }), /has not been approved/)
})

test("declining the interactive batch review leaves the destination untouched", async t => {
  // Arrange
  const directory = mkdtempSync(path.join(tmpdir(), "worklog-decline-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const batchPath = path.join(directory, "review.json")
  writeFileSync(batchPath, JSON.stringify({
    format: "omp-worklog/review-batch",
    version: 1,
    approved: false,
    policy: { responseGraceMinutes: 5 },
    entries: [{ spentDate: "2026-10-18", localProject: "Demo", reviewed: true, project: "Internal", task: "Development", milliseconds: 60_000, candidateMilliseconds: 60_000, notes: "Reviewed implementation" }],
  }))

  // Act
  const outcome = await runWorklogAction(["submit", batchPath], {
    hasUI: true,
    ui: { confirm: async () => false },
  }, { run: async () => assert.fail("Declined review must not invoke the destination command") })

  // Assert
  assert.deepEqual(outcome.details, { status: "cancelled" })
  assert.equal(JSON.parse(readFileSync(batchPath, "utf8")).approved, false)
})

test("headless slash submission requires an explicit approved-batch route", async t => {
  // Arrange
  const directory = mkdtempSync(path.join(tmpdir(), "worklog-headless-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const batchPath = path.join(directory, "review.json")
  writeFileSync(batchPath, JSON.stringify({
    format: "omp-worklog/review-batch",
    version: 1,
    approved: false,
    entries: [{ reviewed: true, project: "Internal", task: "Development", milliseconds: 60_000, candidateMilliseconds: 60_000, notes: "Reviewed implementation" }],
  }))

  // Act / Assert
  await assert.rejects(runWorklogAction(["submit", batchPath], { hasUI: false }, {
    run: async () => assert.fail("Headless slash commands cannot grant review approval"),
  }), /Interactive submission requires a batch approval dialog/)
})

test("stats and plan preserve date ranges, exact projects, and final-day cutoffs", () => {
  // Act / Assert
  assert.deepEqual(parseOmpWorklogArguments('stats 2026-10-05 2026-10-19 --project "Demo Project" --until 12:00'), {
    argv: ["stats", "2026-10-05", "2026-10-19", "--project", "Demo Project", "--until", "12:00"],
  })
  assert.deepEqual(parseOmpWorklogArguments("plan yesterday --until 12:00"), { argv: ["plan", "yesterday", "--until", "12:00"] })
  assert.equal(parseOmpWorklogArguments("plan today yesterday"), null)
  assert.equal(parseOmpWorklogArguments("stats today --until 24:00"), null)
  assert.equal(parseOmpWorklogArguments("stats today --project Demo --project Other"), null)
})

test("completion discovers exact projects after a two-date stats range", () => {
  // Act
  const choices = ompWorklogArgumentCompletions("stats 2026-10-05 2026-10-19 --project Demo", ["Demo Project", "Other"])
  const cutoff = ompWorklogArgumentCompletions("plan today --until 1")

  // Assert
  assert.deepEqual(choices.map(choice => choice.value), ['stats 2026-10-05 2026-10-19 --project "Demo Project"'])
  assert.deepEqual(cutoff.map(choice => choice.value), ["plan today --until 12:00", "plan today --until 17:00"])
})

test("daily review accepts today by default and completes agent-only projects without a date", () => {
  assert.deepEqual(parseOmpWorklogArguments("review"), { argv: ["review"] })
  assert.deepEqual(parseOmpWorklogArguments('review --project "Agent Project" --until 17:00'), {
    argv: ["review", "--project", "Agent Project", "--until", "17:00"],
  })
  assert.equal(parseOmpWorklogArguments("review today yesterday"), null)
  const choices = ompWorklogArgumentCompletions("review --project Agent", ["Agent Project"])
  assert.deepEqual(choices.map(choice => choice.value), ['review --project "Agent Project"'])
})

test("headless daily review cannot prepare or approve a provider write", async () => {
  await assert.rejects(runWorklogAction(["review"], { hasUI: false }, {
    projectTimeLogPath: "/nonexistent-worklog-evidence",
    run: async () => assert.fail("Headless daily review must never invoke the destination"),
  }), /requires interactive OMP/)
})

test("saving daily review preserves private edits and reopening resumes the same draft", async t => {
  const directory = mkdtempSync(path.join(tmpdir(), "worklog-daily-resume-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const logPath = path.join(directory, "evidence.json")
  const startAtMs = new Date(2026, 9, 18, 9).getTime()
  writeFileSync(logPath, JSON.stringify({
    format: "omp-project-time/evidence", version: 1,
    entries: [{ id: "daily-source", project: "Demo", sourceKind: "agent_turn_elapsed", sessionId: "daily-session", startAtMs, endAtMs: startAtMs + 3_600_000 }],
  }))
  const options = {
    dataDirectory: directory, projectTimeLogPath: logPath,
    projectTimeMappings: '{"Demo":{"project":"Internal","task":"Development"}}',
    run: async () => assert.fail("Saving a daily draft must not invoke the destination"),
  }
  const actions = ["project", "Edit note", "Back", "Save and close"]
  const context = { hasUI: true, ui: {
    select: async (_title, choices) => {
      const action = actions.shift()
      return action === "project" ? choices[0].label : action
    },
    editor: async () => "Reviewed daily implementation work",
    confirm: async () => assert.fail("Saving must not request provider approval"),
    notify: () => {},
  } }

  const saved = await runWorklogAction(["review", "2026-10-18"], context, options)
  const resumed = await runWorklogAction(["review", "2026-10-18"], {
    ...context, ui: { ...context.ui, select: async () => "Save and close" },
  }, options)

  const batch = JSON.parse(readFileSync(saved.details.batchPath, "utf8"))
  assert.equal(resumed.details.batchPath, saved.details.batchPath)
  assert.equal(batch.approved, false)
  assert.equal(batch.entries[0].notes, "Reviewed daily implementation work")
  assert.equal(batch.entries[0].reviewed, false)
  assert.equal(statSync(saved.details.batchPath).mode & 0o777, 0o600)
})

test("refreshing evidence preserves the edited prior draft and requires a fresh review", async t => {
  const directory = mkdtempSync(path.join(tmpdir(), "worklog-daily-refresh-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const logPath = path.join(directory, "evidence.json")
  const startAtMs = new Date(2026, 9, 18, 9).getTime()
  const evidence = {
    format: "omp-project-time/evidence", version: 1,
    entries: [{ id: "refresh-source", project: "Demo", sourceKind: "human_active", sessionId: "refresh-session", startAtMs, endAtMs: startAtMs + 3_600_000 }],
  }
  writeFileSync(logPath, JSON.stringify(evidence))
  const options = { dataDirectory: directory, projectTimeLogPath: logPath, run: async () => assert.fail("Refreshing must not invoke the provider") }
  const actions = ["project", "Edit note", "Back", "Save and close", "Refresh evidence", "Save and close"]
  const context = { hasUI: true, ui: {
    select: async (_title, choices) => {
      const action = actions.shift()
      return action === "project" ? choices[0].label : action
    },
    editor: async () => "Preserve this reviewed context",
    confirm: async () => true,
    notify: () => {},
  } }

  const initial = await runWorklogAction(["review", "2026-10-18"], context, options)
  evidence.entries[0].endAtMs = startAtMs + 7_200_000
  writeFileSync(logPath, JSON.stringify(evidence))
  await runWorklogAction(["review", "2026-10-18"], context, options)

  const reviewDirectory = path.dirname(initial.details.batchPath)
  const previous = readdirSync(reviewDirectory).find(name => name.startsWith("previous-"))
  const preserved = JSON.parse(readFileSync(path.join(reviewDirectory, previous, "review.json"), "utf8"))
  const refreshed = JSON.parse(readFileSync(initial.details.batchPath, "utf8"))
  assert.equal(preserved.entries[0].notes, "Preserve this reviewed context")
  assert.equal(preserved.entries[0].candidateMilliseconds, 3_600_000)
  assert.equal(refreshed.entries[0].candidateMilliseconds, 7_200_000)
  assert.equal(refreshed.entries[0].notes, "")
  assert.equal(refreshed.entries[0].reviewed, false)
  assert.equal(refreshed.approved, false)
})
