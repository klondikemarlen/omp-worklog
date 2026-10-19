import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
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
