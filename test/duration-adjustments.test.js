import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { runWorklogAction, submitWorklogBatch } from "../worklog-workflow.js"

function correctedBatch() {
  return {
    format: "omp-worklog/review-batch",
    version: 1,
    approved: true,
    from: "2026-10-18",
    to: "2026-10-18",
    policy: { mode: "concurrent-projects", responseGraceMinutes: 5 },
    entries: [{
      id: "synthetic-entry",
      spentDate: "2026-10-18",
      localProject: "Demo",
      project: "Internal",
      task: "Development",
      candidateMilliseconds: 3_600_000,
      milliseconds: 5_400_000,
      adjustmentReason: "Independent review confirms omitted work",
      humanActiveMilliseconds: 3_600_000,
      agentTurnMilliseconds: 0,
      bridgedGapMilliseconds: 0,
      sourceEntryIds: ["source-a"],
      notes: "Reviewed synthetic progress",
      reviewed: true,
      reviewReasons: ["progress_and_user_blockers_require_review"],
    }],
  }
}

test("when an approved increase has no rationale, file submission rejects it before provider access", async t => {
  // Arrange
  const directory = mkdtempSync(path.join(tmpdir(), "worklog-correction-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const batch = correctedBatch()
  delete batch.entries[0].adjustmentReason
  const batchPath = path.join(directory, "review.json")
  writeFileSync(batchPath, JSON.stringify(batch))

  // Act / Assert
  await assert.rejects(submitWorklogBatch({ batchPath }, {
    run: async () => assert.fail("An unjustified correction must not reach the provider"),
  }), /duration_increase_requires_reason/)
})

test("when a saved rationale is not a string, submission rejects the malformed entry", async t => {
  // Arrange
  const directory = mkdtempSync(path.join(tmpdir(), "worklog-correction-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const batch = correctedBatch()
  batch.entries[0].adjustmentReason = null
  const batchPath = path.join(directory, "review.json")
  writeFileSync(batchPath, JSON.stringify(batch))

  // Act / Assert
  await assert.rejects(submitWorklogBatch({ batchPath }, {
    run: async () => assert.fail("Malformed correction provenance must not reach the provider"),
  }), /invalid_entry_schema/)
})

test("when a corrected daily draft is declined, it stays unapproved and survives resume", async t => {
  // Arrange
  const directory = mkdtempSync(path.join(tmpdir(), "worklog-correction-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const reviewDirectory = path.join(directory, "review-batches")
  mkdirSync(reviewDirectory)
  const batchPath = path.join(reviewDirectory, "daily-2026-10-18.json")
  writeFileSync(batchPath, JSON.stringify(correctedBatch()))
  const options = {
    dataDirectory: directory,
    run: async () => assert.fail("Declining or resuming a draft must not invoke the provider"),
  }
  const ui = {
    select: async () => "Submit to Harvest",
    editor: async () => assert.fail("The corrected draft is already reviewed"),
    confirm: async () => false,
  }

  // Act
  await runWorklogAction(["review", "2026-10-18"], { hasUI: true, ui }, options)
  await runWorklogAction(["review", "2026-10-18"], {
    hasUI: true,
    ui: { ...ui, select: async () => "Save and close", confirm: async () => assert.fail("Resume does not approve a draft") },
  }, options)

  // Assert
  const saved = JSON.parse(readFileSync(batchPath, "utf8"))
  assert.equal(saved.approved, false)
  assert.equal(saved.entries[0].candidateMilliseconds, 3_600_000)
  assert.equal(saved.entries[0].milliseconds, 5_400_000)
  assert.equal(saved.entries[0].adjustmentReason, "Independent review confirms omitted work")
  assert.deepEqual(saved.entries[0].sourceEntryIds, ["source-a"])
})

test("when evidence is explicitly refreshed, the prior correction is archived and the new draft needs review", async t => {
  // Arrange
  const directory = mkdtempSync(path.join(tmpdir(), "worklog-correction-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const reviewDirectory = path.join(directory, "review-batches")
  mkdirSync(reviewDirectory)
  const batchPath = path.join(reviewDirectory, "daily-2026-10-18.json")
  writeFileSync(batchPath, JSON.stringify(correctedBatch()))
  const logPath = path.join(directory, "evidence.json")
  const startAtMs = new Date(2026, 9, 18, 9).getTime()
  writeFileSync(logPath, JSON.stringify({
    format: "omp-project-time/evidence",
    version: 1,
    entries: [{ id: "fresh-source", project: "Demo", sessionId: "fresh-session", sourceKind: "human_active", startAtMs, endAtMs: startAtMs + 7_200_000 }],
  }))
  const actions = ["Refresh evidence", "Save and close"]
  const context = { hasUI: true, ui: {
    select: async () => actions.shift(),
    editor: async () => assert.fail("Refreshing evidence requires no editor"),
    confirm: async () => true,
  } }

  // Act
  await runWorklogAction(["review", "2026-10-18"], context, {
    dataDirectory: directory,
    projectTimeLogPath: logPath,
    run: async () => assert.fail("Refreshing evidence must not invoke the provider"),
  })

  // Assert
  const previousDirectory = readdirSync(reviewDirectory).find(name => name.startsWith("previous-"))
  const previous = JSON.parse(readFileSync(path.join(reviewDirectory, previousDirectory, "review.json"), "utf8"))
  const fresh = JSON.parse(readFileSync(batchPath, "utf8"))
  assert.equal(previous.entries[0].milliseconds, 5_400_000)
  assert.equal(previous.entries[0].adjustmentReason, "Independent review confirms omitted work")
  assert.equal(fresh.entries[0].candidateMilliseconds, 7_200_000)
  assert.equal(fresh.entries[0].milliseconds, 7_200_000)
  assert.equal(fresh.entries[0].adjustmentReason, "")
  assert.equal(fresh.entries[0].reviewed, false)
  assert.equal(fresh.approved, false)
})
