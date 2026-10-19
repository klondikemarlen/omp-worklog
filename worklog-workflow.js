import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { parseProjectTimeMappings, readProjectTimeState, resolveProjectTimeDate } from "./project-time.js"
import { createProjectTimeReviewBatch, formatProjectTimeDailyReport, projectTimeDailyReport } from "./project-time-report.js"

function worklogDirectory(options) {
  return options.dataDirectory || path.join(homedir(), ".omp", "worklog")
}

function evidenceOptions(params, options) {
  return { ...params, responseGraceMinutes: options.responseGraceMinutes ?? 5 }
}

export function dailyWorklogReport(params, options = {}) {
  const state = readProjectTimeState(options.projectTimeLogPath || undefined)
  return projectTimeDailyReport(state, evidenceOptions(params, options))
}

export function prepareWorklogBatch(params, options = {}) {
  const state = readProjectTimeState(options.projectTimeLogPath || undefined)
  const mappings = parseProjectTimeMappings(options.projectTimeMappings || "{}")
  const batch = createProjectTimeReviewBatch(state, mappings, evidenceOptions(params, options))
  const directory = path.join(worklogDirectory(options), "review-batches")
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const batchDirectory = mkdtempSync(path.join(directory, "batch-"))
  const batchPath = path.join(batchDirectory, "review.json")
  writeFileSync(batchPath, JSON.stringify(batch, null, 2) + "\n", { mode: 0o600, flag: "wx" })
  return { batchPath, batch }
}

function readReviewBatch(batchPath) {
  const text = readFileSync(batchPath, "utf8")
  let batch
  try {
    batch = JSON.parse(text)
  } catch {
    throw new Error("The review batch is not valid JSON; its private contents were omitted.")
  }
  if (batch?.format !== "omp-worklog/review-batch" || batch.version !== 1 || !Array.isArray(batch.entries)) {
    throw new Error("Expected an omp-worklog/review-batch v1 document.")
  }

  return batch
}

function reviewedEntries(batch) {
  return batch.entries.length > 0 && batch.entries.every(entry =>
    entry.reviewed === true &&
    typeof entry.project === "string" && entry.project.trim() &&
    typeof entry.task === "string" && entry.task.trim() &&
    typeof entry.notes === "string" && entry.notes.trim() &&
    Number.isSafeInteger(entry.milliseconds) && entry.milliseconds > 0 &&
    Number.isSafeInteger(entry.candidateMilliseconds) && entry.milliseconds <= entry.candidateMilliseconds)
}

async function submitBatchDocument(batch, params, options, context) {
  if (!reviewedEntries(batch)) {
    throw new Error("Review every record's destination, duration, progress/blockers, and factual note before filing.")
  }
  if (!params.dryRun && batch.approved !== true) {
    throw new Error("The batch has not been approved; no Harvest write was attempted.")
  }

  const args = ["work-entry-batch", "--state-dir", path.join(worklogDirectory(options), "submissions")]
  if (params.dryRun) args.push("--dry-run")
  const result = await options.run(options.command || "omp-worklog", args, {
    cwd: context.cwd,
    signal: context.signal,
    input: JSON.stringify(batch),
  })
  let output
  try {
    output = JSON.parse(result.stdout)
  } catch {
    throw new Error(`The Harvest batch command did not return a structured result (exit ${result.code ?? "unavailable"}); private diagnostics were omitted.`)
  }
  if (output?.format !== "omp-worklog/batch-result" || output.version !== 1) {
    throw new Error("The Harvest batch command returned an unsupported result.")
  }

  return output
}

export async function submitWorklogBatch(params, options, context = {}) {
  const batch = readReviewBatch(params.batchPath)
  return submitBatchDocument(batch, params, options, context)
}

function exactDuration(milliseconds) {
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000)
  const seconds = milliseconds % 60_000 / 1000
  const renderedSeconds = Number.isInteger(seconds) ? String(seconds).padStart(2, "0") : seconds.toFixed(3).padStart(6, "0")
  return `${hours}:${String(minutes).padStart(2, "0")}:${renderedSeconds}`
}

function batchReviewText(batch) {
  const lines = [
    "Concurrent-project worklog — review required",
    `Response grace: ${batch.policy.responseGraceMinutes} minutes; cross-project overlap retained.`,
    "Historical progress, user blocking, and dormancy require your review.",
  ]
  for (const entry of batch.entries) {
    lines.push("", `${entry.spentDate} / ${entry.localProject}`, `Candidate: ${exactDuration(entry.candidateMilliseconds)}; reviewed: ${exactDuration(entry.milliseconds)}`,
      `Harvest: ${entry.project || "DESTINATION REQUIRED"} / ${entry.task || "TASK REQUIRED"}`,
      `Note: ${entry.notes || "REVIEWED NOTE REQUIRED"}`)
  }
  if (batch.entries.length === 0) lines.push("No candidate records in this range.")

  return lines.join("\n")
}

function result(content, details) {
  return { content: [{ type: "text", text: content }], details }
}

export function createWorklogTools(z, options) {
  const range = {
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    project: z.string().regex(/\S/).optional(),
    until: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
  }
  return [
    {
      name: "omp_worklog_report_daily_time",
      label: "Daily Human and AI Time",
      description: "Report independent human-active and agent-turn timings by local day and project. Concurrent-project candidates require review; until HH:MM cuts off only the final day. Never writes Harvest.",
      approval: "read",
      parameters: z.object(range),
      async execute(_id, params) {
        try {
          const report = dailyWorklogReport(params, options)
          return result(formatProjectTimeDailyReport(report), report)
        } catch (error) {
          return result(`Could not report worklog time: ${error.message}`, { error: error.message })
        }
      },
    },
    {
      name: "omp_worklog_prepare_review_batch",
      label: "Prepare Private Worklog Review Batch",
      description: "Create an owner-only, unapproved JSON batch from concurrent-project candidates. Review progress/blockers, reduce durations as needed, fill destinations and factual notes, and mark records reviewed before any submission. Writes local review data only, never Harvest.",
      approval: "write",
      parameters: z.object(range),
      async execute(_id, params) {
        try {
          const prepared = prepareWorklogBatch(params, options)
          return result(`${batchReviewText(prepared.batch)}\n\nPrivate batch: ${prepared.batchPath}\nEdit this file, then use /worklog submit with its path for one interactive batch approval.`, prepared)
        } catch (error) {
          return result(`Could not prepare worklog review: ${error.message}`, { error: error.message })
        }
      },
    },
    {
      name: "omp_worklog_submit_reviewed_batch",
      label: "File Approved Worklog Batch",
      description: "Preflight and file an explicitly approved, individually reviewed JSON batch. The saved batch must have approved:true for writes; dryRun only preflights. Preserves concurrent projects, never overwrites existing entries, and blocks uncertain retries. Never use this to approve an unreviewed candidate.",
      approval: "write",
      parameters: z.object({
        batchPath: z.string().regex(/\S/),
        dryRun: z.boolean().optional(),
      }),
      async execute(_id, params, signal, _update, context = {}) {
        try {
          const submitted = await submitWorklogBatch(params, options, { ...context, signal })
          return result(JSON.stringify(submitted, null, 2), submitted)
        } catch (error) {
          return result(`Could not file worklog batch: ${error.message}`, { error: error.message })
        }
      },
    },
  ]
}

export async function runWorklogAction(argv, context, options) {
  if (argv[0] === "submit") {
    const batch = readReviewBatch(argv[1])
    const params = { dryRun: argv.includes("--dry-run") }
    if (!params.dryRun) {
      if (!reviewedEntries(batch)) throw new Error("Complete every record's review, destination, duration, and factual note first.")
      if (!context.hasUI || typeof context.ui.confirm !== "function") {
        throw new Error("Interactive submission requires a batch approval dialog. Headless callers must use an explicitly approved batch with the CLI or write tool.")
      }
      const approved = await context.ui.confirm("File this reviewed batch to Harvest?", batchReviewText(batch))
      if (!approved) return { content: "Batch approval declined; no Harvest write was attempted.", details: { status: "cancelled" } }
      batch.approved = true
    }
    const submitted = await submitBatchDocument(batch, params, options, context)
    return { content: JSON.stringify(submitted, null, 2), details: submitted }
  }

  const flagsAt = argv.findIndex(word => word.startsWith("--"))
  const positionals = argv.slice(1, flagsAt === -1 ? undefined : flagsAt)
  const from = resolveProjectTimeDate(positionals[0])
  const to = resolveProjectTimeDate(positionals[1] || positionals[0])
  const value = flag => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined
  const params = { from, to, project: value("--project"), until: value("--until") }
  if (argv[0] === "stats") {
    const report = dailyWorklogReport(params, options)
    return { content: formatProjectTimeDailyReport(report), details: report }
  }

  const prepared = prepareWorklogBatch(params, options)
  return {
    content: `${batchReviewText(prepared.batch)}\n\nPrivate batch: ${prepared.batchPath}\nReview each record, then /worklog submit ${JSON.stringify(prepared.batchPath)}. Nothing filed.`,
    details: prepared,
  }
}
