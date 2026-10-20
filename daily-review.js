const MAIN_ACTIONS = ["Submit to Harvest", "Save and close", "Refresh evidence"]
const ENTRY_ACTIONS = ["Edit duration", "Edit adjustment reason", "Edit destination project", "Edit task", "Edit note", "Mark reviewed", "Exclude entry", "Back"]

function formatDuration(milliseconds) {
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000)
  const seconds = Math.floor(milliseconds % 60_000 / 1000)
  const fraction = milliseconds % 1000
  const renderedSeconds = fraction === 0
    ? String(seconds).padStart(2, "0")
    : `${String(seconds).padStart(2, "0")}.${String(fraction).padStart(3, "0")}`
  return `${hours}:${String(minutes).padStart(2, "0")}:${renderedSeconds}`
}

function parseDuration(value) {
  const match = /^(\d+):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value.trim())
  if (!match) return null

  const hours = Number(match[1])
  const minutes = Number(match[2])
  const seconds = Number(match[3] || 0)
  const milliseconds = Number((match[4] || "").padEnd(3, "0") || 0)
  if (minutes > 59 || seconds > 59) return null

  const total = hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + milliseconds
  return Number.isSafeInteger(total) ? total : null
}

function hasReadyFields(entry) {
  const hasValidDuration = Number.isSafeInteger(entry.milliseconds) && entry.milliseconds > 0 &&
    Number.isSafeInteger(entry.candidateMilliseconds) && entry.candidateMilliseconds > 0
  const increaseHasReason = entry.milliseconds <= entry.candidateMilliseconds ||
    (typeof entry.adjustmentReason === "string" && entry.adjustmentReason.trim().length > 0)
  const hasValidReason = !Object.hasOwn(entry, "adjustmentReason") || typeof entry.adjustmentReason === "string"
  return typeof entry.project === "string" && entry.project.trim().length > 0 &&
    typeof entry.task === "string" && entry.task.trim().length > 0 &&
    typeof entry.notes === "string" && entry.notes.trim().length > 0 &&
    hasValidDuration && hasValidReason && increaseHasReason
}

function isReadyToSubmit(batch) {
  return batch.entries.length > 0 && batch.entries.every(entry => entry.reviewed === true && hasReadyFields(entry))
}

function entryLabel(entry, index) {
  const reviewState = entry.reviewed ? "reviewed" : "unreviewed"
  const correction = entry.milliseconds > entry.candidateMilliseconds ? " — human correction" : ""
  return `${index + 1}. ${entry.localProject} — ${reviewState}${correction} — ${formatDuration(entry.milliseconds)}`
}

function entryDescription(entry) {
  const humanActive = formatDuration(entry.humanActiveMilliseconds || 0)
  const agentTurns = formatDuration(entry.agentTurnMilliseconds || 0)
  const uncertainty = entry.reviewReasons?.length
    ? `Review uncertainty: ${entry.reviewReasons.map(reason => reason.replaceAll("_", " ")).join("; ")}. Historical blockers/progress are not reconstructed.`
    : "Review uncertainty: confirm progress and user blockers; historical details are not reconstructed."
  return [
    "Concurrent-project overlap is retained; intervals within each project are unioned.",
    `Human-active: ${humanActive}; AI observations: ${agentTurns}; candidate: ${formatDuration(entry.candidateMilliseconds)}; reviewed duration: ${formatDuration(entry.milliseconds)}.`,
    `Human correction: ${entry.milliseconds > entry.candidateMilliseconds ? "yes" : "no"}. Adjustment reason: ${entry.adjustmentReason || "none"}.`,
    `Destination: ${entry.project || "required"} / ${entry.task || "required"}. Note: ${entry.notes || "required"}.`,
    uncertainty,
  ].join(" ")
}

function mainOptions(batch) {
  const rows = batch.entries.map((entry, index) => ({
    label: entryLabel(entry, index),
    description: entryDescription(entry),
  }))
  if (batch.entries.length > 0) {
    rows.push({ label: MAIN_ACTIONS[0], description: isReadyToSubmit(batch)
      ? "Approve this reviewed batch and submit it to Harvest."
      : "Unavailable until every retained entry is reviewed and has a valid destination, note, duration, and correction reason when needed." })
  }
  rows.push({ label: MAIN_ACTIONS[1], description: "Save progress privately and close without approval." })
  rows.push({ label: MAIN_ACTIONS[2], description: "Replace this draft with refreshed evidence after confirmation." })
  return rows
}

async function editDuration(ui, entry, save) {
  const value = await ui.editor("Edit duration (H:MM[:SS[.sss]])", formatDuration(entry.milliseconds))
  if (value === undefined) return

  const milliseconds = parseDuration(value)
  if (milliseconds === null || milliseconds <= 0) {
    ui.notify("Enter a duration greater than zero.", "error")
    return
  }
  entry.milliseconds = milliseconds
  entry.reviewed = false
  save()
}

async function editField(ui, entry, field, title, save) {
  const currentValue = typeof entry[field] === "string" ? entry[field] : ""
  const value = await ui.editor(title, currentValue)
  if (value === undefined) return

  entry[field] = value.trim()
  entry.reviewed = false
  save()
}

function markReviewed(ui, entry, save) {
  if (!hasReadyFields(entry)) {
    ui.notify("Add a nonblank destination project, task, factual note, valid duration, and correction reason when duration exceeds candidate before marking reviewed.", "error")
    return false
  }
  entry.reviewed = true
  save()
  return true
}

async function reviewEntry(batch, index, ui, save) {
  const entry = batch.entries[index]
  while (entry && batch.entries.includes(entry)) {
    const selection = await ui.select(entryLabel(entry, index), [
      { label: ENTRY_ACTIONS[0] },
      { label: ENTRY_ACTIONS[1] },
      { label: ENTRY_ACTIONS[2] },
      { label: ENTRY_ACTIONS[3] },
      { label: ENTRY_ACTIONS[4] },
      { label: ENTRY_ACTIONS[5] },
      { label: ENTRY_ACTIONS[6] },
      { label: ENTRY_ACTIONS[7] },
    ])
    if (selection === undefined || selection === ENTRY_ACTIONS[7]) return

    if (selection === ENTRY_ACTIONS[0]) await editDuration(ui, entry, save)
    if (selection === ENTRY_ACTIONS[1]) await editField(ui, entry, "adjustmentReason", "Edit adjustment reason", save)
    if (selection === ENTRY_ACTIONS[2]) await editField(ui, entry, "project", "Edit destination project", save)
    if (selection === ENTRY_ACTIONS[3]) await editField(ui, entry, "task", "Edit task", save)
    if (selection === ENTRY_ACTIONS[4]) await editField(ui, entry, "notes", "Edit note", save)
    if (selection === ENTRY_ACTIONS[5] && markReviewed(ui, entry, save)) return
    if (selection === ENTRY_ACTIONS[6]) {
      batch.entries.splice(index, 1)
      save()
      return
    }
  }
}

/**
 * Runs the native daily-review dialogs and persists each committed draft change.
 * The caller owns private storage and the single approval transition.
 */
export async function reviewDailyWorklog(batch, ui, save) {
  const persist = () => {
    batch.approved = false
    save(batch)
  }
  while (true) {
    const selection = await ui.select(`Daily worklog review — ${batch.from}`, mainOptions(batch))
    if (selection === undefined || selection === MAIN_ACTIONS[1]) return { action: "save", batch }
    if (selection === MAIN_ACTIONS[2]) return { action: "refresh", batch }
    if (selection === MAIN_ACTIONS[0]) {
      if (!isReadyToSubmit(batch)) {
        ui.notify("Review every retained entry and provide a valid destination, factual note, duration, and correction reason when needed before submitting.", "error")
        continue
      }
      return { action: "submit", batch }
    }

    const index = batch.entries.findIndex((entry, entryIndex) => entryLabel(entry, entryIndex) === selection)
    if (index !== -1) await reviewEntry(batch, index, ui, persist)
  }
}
