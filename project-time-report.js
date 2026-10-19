import { createHash } from "node:crypto"

import { projectTimeEvidenceEntries, resolveProjectTimeDate } from "./project-time.js"

const HUMAN_SOURCE_KIND = "human_active"
const AGENT_SOURCE_KIND = "agent_turn_elapsed"
const BASE_REVIEW_REASON = "progress_and_user_blockers_require_review"

export function projectTimeDailyReport(state, options = {}) {
  const reportOptions = normalizeReportOptions(options)
  const entries = projectTimeEvidenceEntries(state)
  const intervalsByProject = new Map()

  for (const entry of entries) {
    if (
      !entry ||
      (entry.sourceKind !== HUMAN_SOURCE_KIND && entry.sourceKind !== AGENT_SOURCE_KIND) ||
      typeof entry.project !== "string" ||
      entry.project.trim().length === 0 ||
      !Number.isFinite(entry.startAtMs) ||
      !Number.isFinite(entry.endAtMs) ||
      entry.startAtMs >= entry.endAtMs ||
      !Number.isFinite(new Date(entry.startAtMs).getTime()) ||
      !Number.isFinite(new Date(entry.endAtMs).getTime()) ||
      (reportOptions.project !== undefined && entry.project !== reportOptions.project)
    ) continue

    const interval = {
      id: sourceEntryId(entry.id),
      project: entry.project,
      sourceKind: entry.sourceKind,
      startAtMs: entry.startAtMs,
      endAtMs: entry.endAtMs,
      sessionId: entry.sessionId,
    }
    const projectIntervals = intervalsByProject.get(entry.project) ?? []
    projectIntervals.push(interval)
    intervalsByProject.set(entry.project, projectIntervals)
  }
  const bridgesByProject = new Map([...intervalsByProject].map(([project, intervals]) =>
    [project, sessionBridges(intervals, reportOptions.responseGraceMinutes * 60_000)]))

  const days = reportDays(reportOptions)
  const dailyReports = days.map(day => {
    const projects = []
    let humanActiveMilliseconds = 0
    let agentTurnMilliseconds = 0
    let candidateMilliseconds = 0

    for (const [project, intervals] of intervalsByProject) {
      const projectReport = projectDayReport(project, intervals, day, bridgesByProject.get(project))
      if (projectReport.candidateMilliseconds === 0) continue
      projects.push(projectReport)
      humanActiveMilliseconds += projectReport.humanActiveMilliseconds
      agentTurnMilliseconds += projectReport.agentTurnMilliseconds
      candidateMilliseconds += projectReport.candidateMilliseconds
    }

    projects.sort((left, right) => compareStrings(left.project, right.project))
    return {
      spentDate: day.spentDate,
      humanActiveMilliseconds,
      agentTurnMilliseconds,
      candidateMilliseconds,
      projects,
    }
  })

  return {
    format: "omp-worklog/daily-report",
    version: 1,
    from: reportOptions.from,
    to: reportOptions.to,
    until: reportOptions.until,
    policy: {
      mode: "concurrent-projects",
      responseGraceMinutes: reportOptions.responseGraceMinutes,
    },
    totals: dailyReports.reduce((totals, day) => ({
      humanActiveMilliseconds: totals.humanActiveMilliseconds + day.humanActiveMilliseconds,
      agentTurnMilliseconds: totals.agentTurnMilliseconds + day.agentTurnMilliseconds,
      candidateMilliseconds: totals.candidateMilliseconds + day.candidateMilliseconds,
    }), {
      humanActiveMilliseconds: 0,
      agentTurnMilliseconds: 0,
      candidateMilliseconds: 0,
    }),
    days: dailyReports,
  }
}

export function createProjectTimeReviewBatch(state, mappings, options = {}) {
  validateMappings(mappings)
  const report = projectTimeDailyReport(state, options)
  const entries = []

  for (const day of report.days) {
    for (const projectReport of day.projects) {
      if (projectReport.candidateMilliseconds <= 0) continue
      const mapping = mappings.get(projectReport.project)
      const mapped = mapping !== undefined
      entries.push({
        id: reviewEntryId(day.spentDate, projectReport.project),
        spentDate: day.spentDate,
        localProject: projectReport.project,
        project: mapped ? mapping.project.trim() : null,
        task: mapped ? mapping.task.trim() : null,
        candidateMilliseconds: projectReport.candidateMilliseconds,
        milliseconds: projectReport.candidateMilliseconds,
        humanActiveMilliseconds: projectReport.humanActiveMilliseconds,
        agentTurnMilliseconds: projectReport.agentTurnMilliseconds,
        bridgedGapMilliseconds: projectReport.bridgedGapMilliseconds,
        sourceEntryIds: [...projectReport.sourceEntryIds],
        notes: "",
        reviewed: false,
        reviewReasons: [
          ...projectReport.reviewReasons,
          ...(mapped ? [] : ["destination_required"]),
        ],
      })
    }
  }

  return {
    format: "omp-worklog/review-batch",
    version: 1,
    approved: false,
    from: report.from,
    to: report.to,
    policy: { ...report.policy },
    entries,
  }
}

export function formatProjectTimeDailyReport(report) {
  const range = report.from === report.to ? report.from : `${report.from} through ${report.to}`
  const cutoff = report.until === null ? "" : ` (local cutoff ${report.until} on the final date)`
  const lines = [
    `OMP Worklog daily report: ${range}${cutoff}`,
    `Human and AI observations remain separate. Candidates require progress/blocker review, with ${report.policy.responseGraceMinutes}-minute inferred response grace.`,
    "Concurrent projects remain independent; overlap within one project is counted once.",
    "",
    "| Date | Local project | Human-active | AI elapsed | Candidate (review) |",
    "| --- | --- | ---: | ---: | ---: |",
  ]
  for (const day of report.days) {
    lines.push(`| ${day.spentDate} | **Daily total** | ${formatReportDuration(day.humanActiveMilliseconds)} | ${formatReportDuration(day.agentTurnMilliseconds)} | ${formatReportDuration(day.candidateMilliseconds)} |`)
    for (const project of day.projects) {
      const label = project.project.replace(/\s+/g, " ").replaceAll("|", "\\|")
      const inferred = project.bridgedGapMilliseconds > 0 ? " *" : ""
      lines.push(`| ${day.spentDate} | ${label}${inferred} | ${formatReportDuration(project.humanActiveMilliseconds)} | ${formatReportDuration(project.agentTurnMilliseconds)} | ${formatReportDuration(project.candidateMilliseconds)} |`)
    }
  }
  lines.push(`| Total | All projects | ${formatReportDuration(report.totals.humanActiveMilliseconds)} | ${formatReportDuration(report.totals.agentTurnMilliseconds)} | ${formatReportDuration(report.totals.candidateMilliseconds)} |`)
  if (report.days.some(day => day.projects.some(project => project.bridgedGapMilliseconds > 0))) {
    lines.push("", "* Includes inferred same-session response gaps, not verified productive time.")
  }
  return lines.join("\n")
}

function normalizeReportOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("report options must be an object")
  }
  const { from, to, project, until = null, responseGraceMinutes = 5 } = options
  if (
    typeof from !== "string" ||
    typeof to !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(to)
  ) {
    throw new Error("from and to must be an inclusive ISO date range")
  }
  resolveProjectTimeDate(from)
  resolveProjectTimeDate(to)
  if (to < from) throw new Error("from and to must be an inclusive ISO date range")
  if (project !== undefined && (typeof project !== "string" || project.trim().length === 0)) {
    throw new Error("project must be a nonblank exact local project name")
  }
  if (!Number.isInteger(responseGraceMinutes) || responseGraceMinutes < 0) {
    throw new Error("responseGraceMinutes must be a nonnegative integer")
  }
  if (until !== null) {
    const match = typeof until === "string" ? /^(\d{2}):(\d{2})$/.exec(until) : null
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
      throw new Error("until must be a local HH:MM time")
    }
  }
  return { from, to, project, until, responseGraceMinutes }
}

function validateMappings(mappings) {
  if (!(mappings instanceof Map)) throw new Error("mappings must be a parsed project mapping Map")
  for (const [localProject, mapping] of mappings) {
    if (
      typeof localProject !== "string" ||
      localProject.trim().length === 0 ||
      !mapping ||
      typeof mapping !== "object" ||
      Array.isArray(mapping) ||
      typeof mapping.project !== "string" ||
      mapping.project.trim().length === 0 ||
      typeof mapping.task !== "string" ||
      mapping.task.trim().length === 0
    ) {
      throw new Error("mappings must contain nonblank project and task names")
    }
  }
}

function projectDayReport(project, intervals, day, bridges) {
  const dayIntervals = []
  let humanActiveMilliseconds = 0
  let agentTurnMilliseconds = 0
  const sourceEntryIds = new Set()
  let missingSessionIdentity = false

  for (const interval of intervals) {
    const startAtMs = Math.max(day.startAtMs, interval.startAtMs)
    const endAtMs = Math.min(day.endAtMs, interval.endAtMs)
    if (endAtMs <= startAtMs) continue
    dayIntervals.push({ startAtMs, endAtMs })
    if (interval.sourceKind === HUMAN_SOURCE_KIND) humanActiveMilliseconds += endAtMs - startAtMs
    else agentTurnMilliseconds += endAtMs - startAtMs
    if (interval.id !== null) sourceEntryIds.add(interval.id)
    if (!hasSessionIdentity(interval.sessionId)) missingSessionIdentity = true
  }

  const sourceUnionMilliseconds = unionDuration(dayIntervals)
  const candidateRanges = [...intervals, ...bridges].map(interval => ({
    startAtMs: Math.max(day.startAtMs, interval.startAtMs),
    endAtMs: Math.min(day.endAtMs, interval.endAtMs),
  })).filter(interval => interval.endAtMs > interval.startAtMs)
  const candidateMilliseconds = unionDuration(candidateRanges)
  const bridgedGapMilliseconds = Math.max(0, candidateMilliseconds - sourceUnionMilliseconds)

  for (const bridge of bridges) {
    if (Math.min(day.endAtMs, bridge.endAtMs) <= Math.max(day.startAtMs, bridge.startAtMs)) continue
    for (const id of bridge.sourceEntryIds) sourceEntryIds.add(id)
  }

  const reviewReasons = [BASE_REVIEW_REASON]
  if (bridgedGapMilliseconds > 0) reviewReasons.push("response_gaps_inferred")
  if (missingSessionIdentity) reviewReasons.push("missing_session_identity")

  return {
    project,
    humanActiveMilliseconds,
    agentTurnMilliseconds,
    sourceUnionMilliseconds,
    bridgedGapMilliseconds,
    candidateMilliseconds,
    sourceEntryIds: [...sourceEntryIds].sort(compareStrings),
    reviewReasons,
  }
}

function sessionBridges(intervals, graceMilliseconds) {
  const sessions = new Map()
  for (const interval of intervals) {
    if (!hasSessionIdentity(interval.sessionId)) continue
    const sessionIntervals = sessions.get(interval.sessionId) ?? []
    sessionIntervals.push(interval)
    sessions.set(interval.sessionId, sessionIntervals)
  }

  const bridges = []
  for (const sessionIntervals of sessions.values()) {
    sessionIntervals.sort((left, right) => left.startAtMs - right.startAtMs || left.endAtMs - right.endAtMs)
    let current = null
    for (const interval of sessionIntervals) {
      if (current === null) {
        current = { startAtMs: interval.startAtMs, endAtMs: interval.endAtMs, sourceEntryIds: new Set() }
        if (interval.id !== null) current.sourceEntryIds.add(interval.id)
        continue
      }
      if (interval.startAtMs <= current.endAtMs) {
        current.endAtMs = Math.max(current.endAtMs, interval.endAtMs)
        if (interval.id !== null) current.sourceEntryIds.add(interval.id)
        continue
      }

      const gapMilliseconds = interval.startAtMs - current.endAtMs
      if (gapMilliseconds <= graceMilliseconds) {
        const sourceIds = new Set(current.sourceEntryIds)
        if (interval.id !== null) sourceIds.add(interval.id)
        bridges.push({
          startAtMs: current.endAtMs,
          endAtMs: interval.startAtMs,
          sourceEntryIds: [...sourceIds],
        })
      }
      current = { startAtMs: interval.startAtMs, endAtMs: interval.endAtMs, sourceEntryIds: new Set() }
      if (interval.id !== null) current.sourceEntryIds.add(interval.id)
    }
  }
  return bridges
}

function reportDays({ from, to, until }) {
  const days = []
  let date = dateFromIso(from)
  const finalDate = dateFromIso(to)
  while (date.getTime() <= finalDate.getTime()) {
    const spentDate = localDate(date)
    const nextDate = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1)
    const isFinalDay = spentDate === to
    const endAtMs = isFinalDay && until !== null
      ? localCutoff(date, until)
      : nextDate.getTime()
    days.push({ spentDate, startAtMs: date.getTime(), endAtMs })
    date = nextDate
  }
  return days
}

function dateFromIso(value) {
  const [year, month, day] = value.split("-").map(Number)
  return new Date(year, month - 1, day)
}

function localCutoff(date, until) {
  const [hour, minute] = until.split(":").map(Number)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute).getTime()
}

function localDate(date) {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

function unionDuration(intervals) {
  if (intervals.length === 0) return 0
  intervals.sort((left, right) => left.startAtMs - right.startAtMs || left.endAtMs - right.endAtMs)
  let total = 0
  let startAtMs = intervals[0].startAtMs
  let endAtMs = intervals[0].endAtMs
  for (let index = 1; index < intervals.length; index += 1) {
    const interval = intervals[index]
    if (interval.startAtMs <= endAtMs) {
      endAtMs = Math.max(endAtMs, interval.endAtMs)
    } else {
      total += endAtMs - startAtMs
      startAtMs = interval.startAtMs
      endAtMs = interval.endAtMs
    }
  }
  return total + endAtMs - startAtMs
}

function hasSessionIdentity(sessionId) {
  return typeof sessionId === "string" && sessionId.trim().length > 0
}

function sourceEntryId(value) {
  if (typeof value === "string" && value.length > 0) return value
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return null
}

function reviewEntryId(spentDate, localProject) {
  const value = JSON.stringify(["omp-worklog/v1", spentDate, localProject])
  const digest = createHash("sha256").update(value, "utf8").digest("hex")
  return `omp-worklog-v1:${digest}`
}

function formatReportDuration(milliseconds) {
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000)
  const seconds = Math.floor((milliseconds % 60_000) / 1000)
  const remainder = milliseconds % 1000
  const fraction = remainder === 0 ? "" : `.${String(remainder).padStart(3, "0")}`
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${fraction}`
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}
