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

test("editing a reviewed entry clears review and requires a new review before submit", async () => {
  const batch = makeBatch([makeEntry({ reviewed: true })])
  const { ui } = createUI([
    projectRow(1),
    "Edit note",
    "Mark reviewed",
    "Submit to Harvest",
  ], ["Updated factual progress"])
  const savedStates = []

  const outcome = await reviewDailyWorklog(batch, ui, draft => savedStates.push({ ...draft.entries[0] }))

  assert.equal(outcome.action, "submit")
  assert.equal(batch.entries[0].notes, "Updated factual progress")
  assert.equal(batch.entries[0].reviewed, true)
  assert.equal(savedStates.length, 2)
  assert.equal(savedStates[0].reviewed, false)
  assert.equal(savedStates[1].reviewed, true)
})

test("invalid duration and missing note keep Submit blocked until corrected", async () => {
  const batch = makeBatch([makeEntry({ notes: "", reviewed: true })])
  const { ui } = createUI([
    "Submit to Harvest",
    projectRow(1),
    "Mark reviewed",
    "Edit duration",
    "Edit note",
    "Mark reviewed",
    "Submit to Harvest",
  ], ["1:01:01.235", "A factual note"])
  let saveCount = 0

  const outcome = await reviewDailyWorklog(batch, ui, () => { saveCount += 1 })

  assert.equal(outcome.action, "submit")
  assert.equal(batch.entries[0].milliseconds, 3_661_234)
  assert.equal(batch.entries[0].notes, "A factual note")
  assert.equal(batch.entries[0].reviewed, true)
  assert.equal(saveCount, 2)
})

test("valid reviewed entry can be submitted with one explicit selection", async () => {
  const batch = makeBatch([makeEntry({ reviewed: true })])
  const { ui } = createUI(["Submit to Harvest"])

  const outcome = await reviewDailyWorklog(batch, ui, () => assert.fail("No draft edits occurred"))

  assert.deepEqual(outcome, { action: "submit", batch })
  assert.equal(batch.approved, false)
})

test("excluding an entry removes it from the retained batch and submission", async () => {
  const batch = makeBatch([makeEntry(), makeEntry({ id: "entry-2", localProject: "Other", reviewed: true })])
  const { ui } = createUI([
    "1. Demo — unreviewed — 1:01:01.234",
    "Exclude entry",
    "Submit to Harvest",
  ])

  const outcome = await reviewDailyWorklog(batch, ui, () => {})

  assert.equal(outcome.action, "submit")
  assert.deepEqual(batch.entries.map(entry => entry.localProject), ["Other"])
})

test("cancelling after an edit saves the draft without approval", async () => {
  const batch = makeBatch([makeEntry({ reviewed: true })])
  const { ui } = createUI([projectRow(1), "Edit note", undefined, undefined], ["Saved factual note"])
  let saveCount = 0

  const outcome = await reviewDailyWorklog(batch, ui, () => { saveCount += 1 })

  assert.equal(outcome.action, "save")
  assert.equal(outcome.batch, batch)
  assert.equal(batch.entries[0].notes, "Saved factual note")
  assert.equal(batch.entries[0].reviewed, false)
  assert.equal(batch.approved, false)
  assert.equal(saveCount, 1)
})

test("duration editor accepts exact millisecond values through the candidate boundary", async () => {
  const batch = makeBatch([makeEntry({ milliseconds: 1 })])
  const { ui } = createUI([
    "1. Demo — unreviewed — 0:00:00.001",
    "Edit duration",
    "Edit duration",
    "Mark reviewed",
    "Submit to Harvest",
  ], ["0:00:00.001", "1:01:01.234"])
  const savedDurations = []

  const outcome = await reviewDailyWorklog(batch, ui, draft => savedDurations.push(draft.entries[0].milliseconds))

  assert.equal(outcome.action, "submit")
  assert.deepEqual(savedDurations, [1, 3_661_234, 3_661_234])
  assert.equal(batch.entries[0].milliseconds, 3_661_234)
})

test("an empty batch never offers or returns submission", async () => {
  const batch = makeBatch([])
  const { ui, observed } = createUI(["Save and close"])

  const outcome = await reviewDailyWorklog(batch, ui, () => assert.fail("No draft changes occurred"))

  assert.equal(outcome.action, "save")
  assert.equal(outcome.batch, batch)
  assert.equal(observed.selectors[0].options.some(option => option.label === "Submit to Harvest"), false)
})

test("editing a destination trims editor line endings before review and submission", async () => {
  const batch = makeBatch()
  const { ui } = createUI([
    projectRow(), "Edit destination project", "Mark reviewed", "Submit to Harvest",
  ], ["  Corrected destination\n"])

  const outcome = await reviewDailyWorklog(batch, ui, () => {})

  assert.equal(outcome.action, "submit")
  assert.equal(batch.entries[0].project, "Corrected destination")
})
