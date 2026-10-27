import { spawn } from "node:child_process"
import { readFileSync, statSync } from "node:fs"

import {
  defaultProjectTimeLogPath,
  formatProjectTimeCommandSummary,
  formatProjectTimeEntryDrafts,
  formatProjectTimeGeneratedSummary,
  loadProjectTimeTransform,
  parseProjectTimeMappings,
  projectTimeProjectNames,
  projectTimeSummaryPrompt,
  readProjectTimeState,
  resolveProjectTimeDate,
} from "./project-time.js"
import { createWorklogTools, runWorklogAction } from "./worklog-workflow.js"
import { registerLiveWorklogStatus } from "./live-status.js"

function normalizeHolidayRegions(regions) {
  return [...new Set(regions.map(region => region.trim().toLowerCase()).filter(Boolean))]
}

function normalizeCommand(command) {
  return command?.trim() || "omp-worklog"
}

function nonBlankString(z) {
  return z.string().regex(/\S/, "must not be blank")
}

function trimOptionalString(value) {
  return value?.trim() || undefined
}




export function timeOffArguments({
  from,
  to,
  project,
  task,
  projectId,
  taskId,
  hours,
  notes,
  holidayRegions: callHolidayRegions = [],
  dryRun = false,
}, { defaultHours = 7, holidayRegions = [] } = {}) {
  const normalizedProject = trimOptionalString(project)
  const normalizedTask = trimOptionalString(task)
  const normalizedNotes = trimOptionalString(notes)
  const args = ["time-off", from, to]
  if (normalizedProject) args.push("--project", normalizedProject)
  if (normalizedTask) args.push("--task", normalizedTask)
  if (projectId !== undefined) args.push("--project-id", String(projectId))
  if (taskId !== undefined) args.push("--task-id", String(taskId))
  args.push("--hours", String(hours ?? defaultHours))
  for (const region of normalizeHolidayRegions([...holidayRegions, ...callHolidayRegions])) args.push("--holiday-region", region)
  if (normalizedNotes) args.push("--notes", normalizedNotes)
  if (dryRun) args.push("--dry-run")
  return args
}

export function runCommand(command, args, { cwd, signal, input } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let finished = false
    const abort = () => child.kill("SIGTERM")
    const finish = (code, spawnError) => {
      if (finished) return
      finished = true
      signal?.removeEventListener("abort", abort)
      resolve({ code, stdout, stderr, spawnError })
    }

    child.stdout.on("data", chunk => { stdout += chunk })
    child.stderr.on("data", chunk => { stderr += chunk })
    child.once("error", error => finish(null, error))
    child.once("close", code => finish(code))
    signal?.addEventListener("abort", abort, { once: true })
    if (input !== undefined) {
      child.stdin.on("error", error => {
        if (error.code === "EPIPE") return

        child.kill("SIGTERM")
        finish(null, error)
      })
      child.stdin.end(input)
    }
  })
}


export function createProjectTimeTransformTool(
  z,
  {
    projectTimeMappings = "{}",
    projectTimeLogPath = "",
    loadTransform = loadProjectTimeTransform,
  } = {},
) {
  projectTimeLogPath = projectTimeLogPath.trim()
  return {
    name: "omp_worklog_preview_project_time_transforms",
    label: "Preview Project Time Evidence",
    description: "Preview local Project Time intervals grouped by date and activity. This never writes Harvest.",
    approval: "read",
    parameters: z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date"),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date"),
      repositoryId: nonBlankString(z).optional(),
      project: nonBlankString(z).optional(),
      sourceKind: nonBlankString(z).optional(),
      applyMappings: z.boolean().optional(),
    }),
    async execute(_toolCallId, params) {
      try {
        const { repositoryId, project, sourceKind, ...request } = params
        const plan = await loadTransform({
          ...request,
          repositoryId: trimOptionalString(repositoryId),
          project: trimOptionalString(project),
          sourceKind: trimOptionalString(sourceKind),
          applyMappings: params.applyMappings === true,
          mappings: parseProjectTimeMappings(projectTimeMappings),
          logPath: projectTimeLogPath || undefined,
        })
        return {
          content: [{ type: "text", text: JSON.stringify(plan) }],
          details: plan,
        }
      } catch (error) {
        const output = { error: error.message }
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          details: output,
        }
      }
    },
  }
}

export function createProjectTimeDraftTool(
  z,
  {
    projectTimeMappings = "{}",
    projectTimeLogPath = "",
    loadTransform = loadProjectTimeTransform,
  } = {},
) {
  projectTimeLogPath = projectTimeLogPath.trim()
  return {
    name: "omp_worklog_preview_project_time_drafts",
    label: "Preview Inferred Work Timesheet",
    description: "Create a deterministic, copyable work-timesheet draft from human-active OMP Project Time evidence. Configured mappings identify Harvest destinations; every other local project remains a review-required draft. This reads the local log only and never writes Harvest.",
    approval: "read",
    parameters: z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date"),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date"),
    }),
    async execute(_toolCallId, params) {
      try {
        const plan = await loadTransform({
          from: params.from,
          to: params.to,
          sourceKind: "human_active",
          applyMappings: true,
          mappings: parseProjectTimeMappings(projectTimeMappings),
          logPath: projectTimeLogPath || undefined,
        })
        return {
          content: [{ type: "text", text: formatProjectTimeEntryDrafts(plan) }],
          details: plan,
        }
      } catch (error) {
        const output = `Could not preview inferred work timesheet: ${error.message}`
        return { content: [{ type: "text", text: output }], details: { entries: [] } }
      }
    },
  }
}


function hasValidAssignment({ project, task, projectId, taskId }) {
  const anyNames = project !== undefined || task !== undefined
  const anyIds = projectId !== undefined || taskId !== undefined
  return (Boolean(project && task) && !anyIds) || (projectId !== undefined && taskId !== undefined && !anyNames)
}

export function createTimeOffTool(z, { command = "omp-worklog", defaultHours = 7, holidayRegions = "ca_yt", run = runCommand } = {}) {
  command = normalizeCommand(command)
  const configuredHolidayRegions = normalizeHolidayRegions(holidayRegions.split(","))
  return {
    name: "omp_worklog_record_time_off",
    label: "Record Time Off",
    description: "Create one Harvest duration entry for each local business day in an inclusive date range. Supply either project/task names or project/task IDs; optional holidayRegions add repeatable CLI regions. Verify all values before calling; this mutates Harvest.",
    approval: "write",
    parameters: z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date"),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date"),
      project: nonBlankString(z).optional(),
      task: nonBlankString(z).optional(),
      projectId: z.number().int().min(1).optional(),
      taskId: z.number().int().min(1).optional(),
      hours: z.number().min(0).optional(),
      notes: nonBlankString(z).optional(),
      holidayRegions: z.array(nonBlankString(z)).optional(),
      dryRun: z.boolean().optional(),
    })
      .refine(hasValidAssignment, { message: "supply project and task, or projectId and taskId, but not both" })
      .refine(params => params.hours === undefined || (Number.isFinite(params.hours) && params.hours > 0), { message: "hours must be a positive finite number" })
      .refine(params => configuredHolidayRegions.length > 0 || normalizeHolidayRegions(params.holidayRegions ?? []).length > 0, { message: "supply holidayRegions when no regions are configured" }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const args = timeOffArguments(params, { defaultHours, holidayRegions: configuredHolidayRegions })
      onUpdate?.({ content: [{ type: "text", text: "Recording Harvest time-off entries…" }] })
      const result = await run(command, args, { cwd: ctx.cwd, signal })
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim()

      if (result.spawnError) {
        return {
          content: [{ type: "text", text: `Could not run ${command}: ${result.spawnError.message}` }],
          details: { command, args, code: result.code },
        }
      }

      return {
        content: [{ type: "text", text: output || `${command} exited with ${result.code}` }],
        details: { command, args, code: result.code },
      }
    },
  }
}

const WORKLOG_COMMAND = "worklog"

const OMP_WORKLOG_USAGE = [
  "Usage:",
  `  /${WORKLOG_COMMAND} review [DATE] [--project PROJECT] [--until HH:MM]`,
  `  /${WORKLOG_COMMAND} timesheet DATE [--project PROJECT]`,
  `  /${WORKLOG_COMMAND} stats FROM [TO] [--project PROJECT] [--until HH:MM]`,
  `  /${WORKLOG_COMMAND} plan DATE [--project PROJECT] [--until HH:MM]`,
  `  /${WORKLOG_COMMAND} submit BATCH_PATH [--dry-run]`,
  "",
  "Dates: today, yesterday, or YYYY-MM-DD. --until clips only the final day.",
  "Review defaults to today: edit entries inside OMP, then choose Submit to Harvest.",
  "Plans remain available for file-based and programmatic review.",
].join("\n")

const DATE_COMPLETIONS = [
  { label: "today", value: "today", description: "Local date alias; YYYY-MM-DD is also accepted" },
  { label: "yesterday", value: "yesterday", description: "Previous local date; YYYY-MM-DD is also accepted" },
]

function dateCompletions() {
  const now = new Date()
  const value = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(part => String(part).padStart(2, "0")).join("-")
  return [...DATE_COMPLETIONS, { label: "YYYY-MM-DD", value, description: "Today's local ISO date; edit as needed" }]
}

const DATE_PATTERN = /^(today|yesterday|\d{4}-\d{2}-\d{2})$/i

const TIMESHEET_FLAGS = {
  "--project": "Exact OMP Project Time project name",
  "--help": "Show local Project Time timesheet help",
}

export function ompWorklogArgumentCompletions(argumentPrefix, projects = []) {
  const input = argumentPrefix
  const trimmed = input.trim()
  const choices = [
    { label: "review", value: "review", description: "Review today's worklog inside OMP, then submit" },
    { label: "timesheet", value: "timesheet", description: "Review compact human-active totals" },
    { label: "stats", value: "stats", description: "Compare daily human and AI timings by project" },
    { label: "plan", value: "plan", description: "Prepare a private concurrent-work review batch" },
    { label: "submit", value: "submit", description: "Approve and file a reviewed batch, or preflight it" },
    { label: "help", value: "help", description: "Show Worklog commands" },
  ]
  if (!trimmed || !input.includes(" ")) return choices.filter(choice => choice.value.startsWith(trimmed.toLowerCase()))

  const first = trimmed.split(/\s+/, 1)[0].toLowerCase()
  const words = trimmed.split(/\s+/)
  if (words.some(word => ["--help", "-h"].includes(word))) return null
  if (first === "submit") {
    const parsed = parseCommandArguments(input)
    if (!parsed?.[1] || parsed[1].startsWith("--")) return null

    return completionForFlag(input, { "--dry-run": "Preflight without creating Harvest entries", "--help": "Show command help" })
  }
  if (!["review", "timesheet", "stats", "plan"].includes(first)) return null

  const optionIndex = words.findIndex((word, index) => index > 0 && word.startsWith("--"))
  const positionals = words.slice(1, optionIndex === -1 ? words.length : optionIndex)
  const maximumDates = first === "stats" ? 2 : 1
  if (optionIndex === -1 && (!positionals.length || (!input.endsWith(" ") && positionals.length <= maximumDates))) {
    const partial = input.endsWith(" ") ? "" : positionals.at(-1)
    const base = [first, ...positionals.slice(0, input.endsWith(" ") ? positionals.length : -1)]
    return dateCompletions()
      .filter(choice => choice.value.startsWith(partial.toLowerCase()))
      .map(choice => ({ ...choice, value: [...base, choice.value].join(" ") }))
  }
  if ((!positionals.length && first !== "review") || positionals.length > maximumDates || positionals.some(value => !DATE_PATTERN.test(value))) return null

  const projectCompletions = completionForProject(input, projects)
  if (projectCompletions) return projectCompletions
  if (first !== "timesheet") {
    const until = /(?:^|\s)--until(?:\s|$)/.exec(input)
    if (until) {
      const entered = input.slice(until.index + until[0].length).trim()
      if (!entered.includes(" ") && !(input.endsWith(" ") && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(entered))) {
        const base = input.slice(0, until.index + until[0].length).trimEnd()
        return ["12:00", "17:00"].filter(value => value.startsWith(entered))
          .map(value => ({ label: value, value: `${base} ${value}`, description: "Local cutoff on the final day" }))
      }
    }
  }

  const flags = first === "timesheet" ? TIMESHEET_FLAGS : {
    "--project": "Exact local Project Time project",
    "--until": "Local HH:MM cutoff on the final day",
    "--help": "Show command help",
  }
  const flagChoices = completionForFlag(input, flags)
  if (first === "stats" && optionIndex === -1 && positionals.length === 1 && input.endsWith(" ")) {
    const dates = dateCompletions().map(choice => ({ ...choice, value: `${trimmed} ${choice.value}` }))
    return [...dates, ...(flagChoices || [])]
  }
  return flagChoices
}

function completionForFlag(input, flags) {
  const trimmed = input.trim()
  const words = trimmed.split(/\s+/)
  const current = input.endsWith(" ") ? "" : words.at(-1)
  const previous = input.endsWith(" ") ? words.at(-1) : words.at(-2)
  if (!current && previous?.startsWith("--")) return null
  if (current && !current.startsWith("--")) return null

  const base = current ? trimmed.slice(0, -current.length).trimEnd() : trimmed
  const choices = Object.entries(flags)
    .filter(([flag]) => !words.includes(flag) && (!current || flag.startsWith(current)))
    .map(([flag, description]) => ({ label: flag, value: `${base} ${flag}`.trim(), description }))
  return choices.length > 0 ? choices : null
}

function completionForProject(input, projects) {
  const match = /(?:^|\s)--project(?:\s|$)/.exec(input)
  if (!match) return null

  const valueStart = (match.index ?? 0) + match[0].length
  const entered = input.slice(valueStart)
  if (/\s--/.test(entered)) return null
  const parsed = parseCommandArguments(input)
  const projectIndex = parsed?.indexOf("--project") ?? -1
  const completedProject = projectIndex === -1 ? undefined : parsed[projectIndex + 1]
  if (input.endsWith(" ") && projects.includes(completedProject)) return null

  const prefix = entered.trim().replace(/^['"]/, "")
  const base = input.slice(0, valueStart).trimEnd()
  const choices = projects
    .filter(project => project.trim().toLowerCase().startsWith(prefix.toLowerCase()))
    .map(project => ({
      label: project,
      value: `${base} ${/^[^\s"'\\]+$/.test(project) ? project : JSON.stringify(project)}`,
      description: "Local OMP Project Time project",
    }))
  return choices.length > 0 ? choices : null
}

export function createProjectTimeProjectNamesLoader({ read = readFileSync, stat = statSync, includeAgentTurns = false } = {}) {
  let cachedPath
  let cachedStamp
  let cachedProjects = []

  return logPath => {
    const path = logPath || defaultProjectTimeLogPath()
    try {
      const { mtimeMs, size } = stat(path)
      let stamp = `${mtimeMs}:${size}`
      if (path.endsWith(".sqlite")) {
        // Committed WAL writes need not touch the main database until a checkpoint.
        try {
          const wal = stat(`${path}-wal`)
          stamp += `:${wal.mtimeMs}:${wal.size}`
        } catch (error) {
          if (error.code !== "ENOENT") throw error
        }
      }
      if (cachedPath === path && cachedStamp === stamp) return cachedProjects

      cachedProjects = projectTimeProjectNames(readProjectTimeState(path, { read }), { includeAgentTurns })
      cachedPath = path
      cachedStamp = stamp
      return cachedProjects
    } catch {
      return []
    }
  }
}

function hasFlagValue(words, flag) {
  const index = words.indexOf(flag)
  return index >= 0 && Boolean(words[index + 1]) && !words[index + 1].startsWith("--")
}

export function parseCommandArguments(input) {
  const words = []
  let word = ""
  let quote = null
  let started = false
  let escaped = false

  for (const character of input.trim()) {
    if (escaped) {
      word += character
      started = true
      escaped = false
    } else if (character === "\\" && quote !== "'") {
      escaped = true
    } else if (quote) {
      if (character === quote) quote = null
      else word += character
    } else if (character === "'" || character === "\"") {
      quote = character
      started = true
    } else if (/\s/.test(character)) {
      if (started) {
        words.push(word)
        word = ""
        started = false
      }
    } else {
      word += character
      started = true
    }
  }

  if (quote || escaped) return null
  if (started) words.push(word)
  return words
}

function isWorklogForm(words, allowIncomplete = false) {
  const command = words[0]
  if (!["review", "timesheet", "stats", "plan", "submit"].includes(command)) return false
  if ((allowIncomplete || command === "review") && words.length === 1) return true
  if (command === "submit") {
    return Boolean(words[1]) && !words[1].startsWith("--") &&
      (words.length === 2 || (words.length === 3 && words[2] === "--dry-run"))
  }

  const optionIndex = words.findIndex((word, index) => index > 0 && word.startsWith("--"))
  const dates = words.slice(1, optionIndex === -1 ? undefined : optionIndex)
  if ((!dates.length && command !== "review") || dates.length > (command === "stats" ? 2 : 1) || dates.some(date => !DATE_PATTERN.test(date))) return false
  if (optionIndex === -1) return true

  const seen = new Set()
  for (let index = optionIndex; index < words.length; index += 2) {
    const flag = words[index]
    const value = words[index + 1]
    if (seen.has(flag) || !value || value.startsWith("--")) return false
    if (flag !== "--project" && !(flag === "--until" && command !== "timesheet")) return false
    if (flag === "--until" && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return false

    seen.add(flag)
  }
  return true
}

export function parseOmpWorklogArguments(args) {
  const input = args.trim()
  if (input === "help") return { help: true }

  const words = parseCommandArguments(input)
  if (!words || words.length === 0) return null
  const help = ["--help", "-h"].includes(words.at(-1))
  const form = help ? words.slice(0, -1) : words
  if (!isWorklogForm(form, help)) return null
  return help ? { help: true } : { argv: words }
}

async function completeProjectTimeSummary(ctx, plan) {
  const { complete } = await import("@oh-my-pi/pi-ai")
  const apiKey = await ctx.modelRegistry.getApiKey(ctx.model)
  const response = await complete(
    ctx.model,
    {
      messages: [{
        role: "user",
        content: [{ type: "text", text: projectTimeSummaryPrompt(plan) }],
        timestamp: Date.now(),
      }],
    },
    { apiKey },
  )
  return response.content.filter(content => content.type === "text").map(content => content.text).join("\n")
}

async function requestProjectTimeSummary(pi, ctx, plan, completeSummary) {
  const widgetKey = "omp-worklog-timesheet-summary"
  const replaceInWidget = ctx.hasUI && typeof ctx.ui.setWidget === "function"
  let summary = ""
  if (ctx.model) {
    if (replaceInWidget) {
      ctx.ui.setWidget(widgetKey, ["Generating work summary…"], { placement: "aboveEditor" })
    }
    try {
      summary = await completeSummary(ctx, plan)
    } catch {
      ctx.ui.notify("Could not generate Project Time summary; showing totals only.", "warning")
    }
  }

  const content = formatProjectTimeGeneratedSummary(summary, plan)
  if (replaceInWidget) {
    ctx.ui.setWidget(widgetKey, content.split("\n"), { placement: "aboveEditor" })
    return
  }

  pi.sendMessage({
    customType: widgetKey,
    content,
    display: true,
    attribution: "assistant",
  }, { triggerTurn: false })
}

async function loadOmpPluginSettings(cwd) {
  const diagnostic = "Could not resolve OMP Worklog settings; run omp plugin config list omp-worklog --json in this project."
  const result = await runCommand("omp", ["plugin", "config", "list", "omp-worklog", "--json"], { cwd })
  if (result.code !== 0) throw new Error(diagnostic)

  try {
    const { settings } = JSON.parse(result.stdout)
    if (settings && typeof settings === "object" && !Array.isArray(settings)) return settings
  } catch {
    // CLI diagnostics may contain private values; expose only the recovery command.
  }
  throw new Error(diagnostic)
}

export default async function ompWorklogExtension(pi, options = {}) {
  const loadSettings = options.loadPluginSettings ?? loadOmpPluginSettings
  const settings = pi.cwd ? await loadSettings(pi.cwd) : {}
  options = { ...settings, ...options }
  pi.setLabel?.("OMP Worklog")
  registerLiveWorklogStatus(pi)
  const command = normalizeCommand(options.command)
  const projectTimeMappings = options.projectTimeMappings?.trim() || "{}"
  const projectTimeLogPath = options.projectTimeLogPath?.trim() || ""
  const loadTransform = options.loadProjectTimeTransform ?? loadProjectTimeTransform
  const loadProjects = options.loadProjectTimeProjectNames ?? createProjectTimeProjectNamesLoader()
  const loadReportProjects = options.loadProjectTimeProjectNames ?? createProjectTimeProjectNamesLoader({ includeAgentTurns: true })
  const completeSummary = options.completeProjectTimeSummary ?? completeProjectTimeSummary
  const workflowOptions = {
    command,
    projectTimeMappings,
    projectTimeLogPath,
    responseGraceMinutes: options.responseGraceMinutes ?? 5,
    dataDirectory: options.worklogDataDirectory,
    run: options.runWorklogCommand ?? runCommand,
  }
  pi.registerCommand(WORKLOG_COMMAND, {
    description: "Review today's worklog and submit it, or inspect human/AI evidence and private plans",
    getArgumentCompletions: input => {
      const loader = /^(review|stats|plan)(?:\s|$)/i.test(input.trimStart()) ? loadReportProjects : loadProjects
      return ompWorklogArgumentCompletions(input, loader(projectTimeLogPath))
    },
    handler: async (args, ctx) => {
      const parsed = parseOmpWorklogArguments(args)
      if (!parsed || parsed.help) {
        ctx.ui.notify(OMP_WORKLOG_USAGE, parsed?.help ? "info" : "error")
        return
      }

      try {
        if (parsed.argv[0] !== "timesheet") {
          const outcome = await runWorklogAction(parsed.argv, ctx, workflowOptions)
          pi.sendMessage({
            customType: "omp-worklog-workflow",
            content: outcome.content,
            display: true,
            attribution: "assistant",
          }, { triggerTurn: false })
          return
        }

        const spentDate = resolveProjectTimeDate(parsed.argv[1])
        const project = parsed.argv[2] === "--project" ? parsed.argv[3] : undefined
        const mappings = parseProjectTimeMappings(projectTimeMappings)
        const plan = await loadTransform({
          from: spentDate,
          to: spentDate,
          project,
          mappings,
          applyMappings: true,
          logPath: projectTimeLogPath || undefined,
        })

        pi.sendMessage({
          customType: "omp-worklog-timesheet",
          content: formatProjectTimeCommandSummary(plan),
          display: true,
          attribution: "assistant",
        }, { triggerTurn: false })
        await requestProjectTimeSummary(pi, ctx, plan, completeSummary)
      } catch (error) {
        ctx.ui.notify(`Could not complete Worklog command: ${error.message}`, "error")
      }
    },
  })
  pi.registerTool(createTimeOffTool(pi.zod.z, {
    command,
    defaultHours: options.defaultHours,
    holidayRegions: options.holidayRegions,
  }))
  pi.registerTool(createProjectTimeDraftTool(pi.zod.z, {
    projectTimeMappings,
    projectTimeLogPath,
  }))
  pi.registerTool(createProjectTimeTransformTool(pi.zod.z, {
    projectTimeMappings,
    projectTimeLogPath,
  }))
  for (const tool of createWorklogTools(pi.zod.z, workflowOptions)) pi.registerTool(tool)
}
