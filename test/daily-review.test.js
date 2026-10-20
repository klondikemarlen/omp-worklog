import assert from "node:assert/strict"
import test from "node:test"

import { reviewDailyWorklog } from "../daily-review.js"

function makeEntry(overrides = {}) {
  return {
    id: "entry-1",
    spentDate: "2026-10-18",
    localProject: "Demo",
    project: "Internal",
    task: "Development",
    candidateMilliseconds: 3_661_234,
    milliseconds: 3_661_234,
    humanActiveMilliseconds: 1_200_000,
    agentTurnMilliseconds: 2_400_000,
    notes: "Reviewed progress",
    reviewed: false,
    reviewReasons: ["progress_and_user_blockers_require_review"],
    ...overrides,
  }
}

function makeBatch(entries = [makeEntry()]) {
  return { format: "omp-worklog/review-batch", version: 1, from: "2026-10-18", to: "2026-10-18", approved: false, entries }
}

function createUI(selections, edits = []) {
  const observed = { selectors: [] }
  return {
    observed,
    ui: {
      select: async (title, options) => {
        observed.selectors.push({ title, options })
        assert.ok(selections.length > 0, "the scenario must account for every selector")
        return selections.shift()
      },
      editor: async () => edits.shift(),
      notify: () => {},
    },
  }
}

function projectRow(index = 0) {
  return `1. Demo — ${index ? "reviewed" : "unreviewed"} — 1:01:01.234`
}

test("when an above-candidate duration needs a reason before review, it saves and reviews the human correction", async () => {
  // Arrange
  const batch = makeBatch([makeEntry()])
  const { ui } = createUI([
    projectRow(),
    "Edit duration",
    "Mark reviewed",
    "Edit adjustment reason",
    "Mark reviewed",
    "Submit to Harvest",
  ], ["1:02:01.234", "Worked beyond tracked sessions"])

  // Act
  const outcome = await reviewDailyWorklog(batch, ui, () => {})

  // Assert
  assert.equal(outcome.action, "submit")
  assert.equal(batch.entries[0].milliseconds, 3_721_234)
  assert.equal(batch.entries[0].adjustmentReason, "Worked beyond tracked sessions")
  assert.equal(batch.entries[0].reviewed, true)
})

test("when an adjustment reason changes, a reviewed correction must be reviewed again", async () => {
  // Arrange
  const batch = makeBatch([makeEntry({
    milliseconds: 3_721_234,
    adjustmentReason: "Initial correction reason",
    reviewed: true,
  })])
  batch.approved = true
  const { ui } = createUI([
    "1. Demo — reviewed — human correction — 1:02:01.234",
    "Edit adjustment reason",
    "Mark reviewed",
    "Submit to Harvest",
  ], ["Corrected explanation"])
  const savedReviewStates = []

  // Act
  const outcome = await reviewDailyWorklog(batch, ui, draft => {
    savedReviewStates.push(draft.entries[0].reviewed)
  })

  // Assert
  assert.equal(outcome.action, "submit")
  assert.equal(batch.entries[0].adjustmentReason, "Corrected explanation")
  assert.deepEqual(savedReviewStates, [false, true])
  assert.equal(batch.approved, false)
})

test("when a reviewed note changes, review is cleared and must be repeated before submission", async () => {
  // Arrange
  const batch = makeBatch([makeEntry({ reviewed: true })])
  const { ui } = createUI([
    projectRow(1),
    "Edit note",
    "Mark reviewed",
    "Submit to Harvest",
  ], ["Updated factual progress"])
  const savedStates = []

  // Act
  const outcome = await reviewDailyWorklog(batch, ui, draft => savedStates.push({ ...draft.entries[0] }))

  // Assert
  assert.equal(outcome.action, "submit")
  assert.equal(batch.entries[0].notes, "Updated factual progress")
  assert.equal(batch.entries[0].reviewed, true)
  assert.equal(savedStates.length, 2)
  assert.equal(savedStates[0].reviewed, false)
  assert.equal(savedStates[1].reviewed, true)
})

test("when invalid duration and missing note block submission, correcting them allows review", async () => {
  // Arrange
  const batch = makeBatch([makeEntry({ notes: "", reviewed: true })])
  const { ui } = createUI([
    "Submit to Harvest",
    projectRow(1),
    "Mark reviewed",
    "Edit duration",
    "Edit note",
    "Mark reviewed",
    "Submit to Harvest",
  ], ["0:00:00.000", "A factual note"])
  let saveCount = 0

  // Act
  const outcome = await reviewDailyWorklog(batch, ui, () => { saveCount += 1 })

  // Assert
  assert.equal(outcome.action, "submit")
  assert.equal(batch.entries[0].milliseconds, 3_661_234)
  assert.equal(batch.entries[0].notes, "A factual note")
  assert.equal(batch.entries[0].reviewed, true)
  assert.equal(saveCount, 2)
})

test("when a ready entry is submitted, the explicit action returns the reviewed batch", async () => {
  // Arrange
  const batch = makeBatch([makeEntry({ reviewed: true })])
  const { ui } = createUI(["Submit to Harvest"])

  // Act
  const outcome = await reviewDailyWorklog(batch, ui, () => assert.fail("No draft edits occurred"))

  // Assert
  assert.deepEqual(outcome, { action: "submit", batch })
  assert.equal(batch.approved, false)
})

test("when an entry is excluded, it is removed from the retained batch", async () => {
  // Arrange
  const batch = makeBatch([makeEntry(), makeEntry({ id: "entry-2", localProject: "Other", reviewed: true })])
  const { ui } = createUI([
    "1. Demo — unreviewed — 1:01:01.234",
    "Exclude entry",
    "Submit to Harvest",
  ])

  // Act
  const outcome = await reviewDailyWorklog(batch, ui, () => {})

  // Assert
  assert.equal(outcome.action, "submit")
  assert.deepEqual(batch.entries.map(entry => entry.localProject), ["Other"])
})

test("when review closes after an edit, it saves the draft without approval", async () => {
  // Arrange
  const batch = makeBatch([makeEntry({ reviewed: true })])
  const { ui } = createUI([projectRow(1), "Edit note", undefined, undefined], ["Saved factual note"])
  let saveCount = 0

  // Act
  const outcome = await reviewDailyWorklog(batch, ui, () => { saveCount += 1 })

  // Assert
  assert.equal(outcome.action, "save")
  assert.equal(outcome.batch, batch)
  assert.equal(batch.entries[0].notes, "Saved factual note")
  assert.equal(batch.entries[0].reviewed, false)
  assert.equal(batch.approved, false)
  assert.equal(saveCount, 1)
})

test("when duration is edited, exact millisecond values are accepted through candidate time", async () => {
  // Arrange
  const batch = makeBatch([makeEntry({ milliseconds: 1 })])
  const { ui } = createUI([
    "1. Demo — unreviewed — 0:00:00.001",
    "Edit duration",
    "Edit duration",
    "Mark reviewed",
    "Submit to Harvest",
  ], ["0:00:00.001", "1:01:01.234"])
  const savedDurations = []

  // Act
  const outcome = await reviewDailyWorklog(batch, ui, draft => savedDurations.push(draft.entries[0].milliseconds))

  // Assert
  assert.equal(outcome.action, "submit")
  assert.deepEqual(savedDurations, [1, 3_661_234, 3_661_234])
  assert.equal(batch.entries[0].milliseconds, 3_661_234)
})

test("when the batch is empty, submission is unavailable", async () => {
  // Arrange
  const batch = makeBatch([])
  const { ui, observed } = createUI(["Save and close"])

  // Act
  const outcome = await reviewDailyWorklog(batch, ui, () => assert.fail("No draft changes occurred"))

  // Assert
  assert.equal(outcome.batch, batch)
  assert.equal(observed.selectors[0].options.some(option => option.label === "Submit to Harvest"), false)
})

test("when a destination is edited, surrounding line endings are trimmed", async () => {
  // Arrange
  const batch = makeBatch()
  const { ui } = createUI([
    projectRow(), "Edit destination project", "Mark reviewed", "Submit to Harvest",
  ], ["  Corrected destination\n"])

  // Act
  await reviewDailyWorklog(batch, ui, () => {})

  // Assert
  assert.equal(batch.entries[0].project, "Corrected destination")
})

test("when correction provenance is malformed, a ready entry cannot submit", async () => {
  // Arrange
  const batch = makeBatch([makeEntry({ reviewed: true, adjustmentReason: null })])
  const { ui } = createUI(["Submit to Harvest", "Save and close"])

  // Act
  const outcome = await reviewDailyWorklog(batch, ui, () => assert.fail("No entry was edited"))

  // Assert
  assert.equal(outcome.action, "save")
})
