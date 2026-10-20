import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"

import ompWorklogExtension, { createProjectTimeDraftTool, createProjectTimeProjectNamesLoader, createTimeOffTool, ompWorklogArgumentCompletions, parseCommandArguments, parseOmpWorklogArguments, timeOffArguments } from "../index.js"

const schema = () => ({
  regex() { return this },
  min() { return this },
  int() { return this },
  optional() { return this },
})
const z = {
  string: schema,
  number: schema,
  boolean: schema,
  array: schema,
  object: shape => ({
    shape,
    refinements: [],
    refine(predicate) {
      this.refinements.push(predicate)
      return this
    },
  }),
}

test("when creating CLI arguments, it normalizes supplied parameters", () => {
  // Arrange
  const namedTimeOff = {
    from: "2026-07-17",
    to: "2026-07-20",
    project: " Time Off - Marlen ",
    task: " Vacation / PTO ",
    hours: 7.5,
    notes: " Vacation ",
    dryRun: true,
  }
  const identifiedTimeOff = {
    from: "2026-07-17",
    to: "2026-07-20",
    projectId: 123,
    taskId: 456,
    holidayRegions: [" US_CA ", "ca_yt", " "],
  }

  // Act
  const namedArguments = timeOffArguments(namedTimeOff)
  const identifiedArguments = timeOffArguments(identifiedTimeOff, { defaultHours: 6.5, holidayRegions: ["ca_yt", "CA_YT"] })

  // Assert
  assert.deepEqual(
    namedArguments,
    [
      "time-off", "2026-07-17", "2026-07-20", "--project", "Time Off - Marlen", "--task", "Vacation / PTO",
      "--hours", "7.5", "--notes", "Vacation", "--dry-run",
    ],
  )
  assert.deepEqual(
    identifiedArguments,
    [
      "time-off", "2026-07-17", "2026-07-20", "--project-id", "123", "--task-id", "456",
      "--hours", "6.5", "--holiday-region", "ca_yt", "--holiday-region", "us_ca",
    ],
  )
})



test("when reading local evidence, it creates a review-only draft", async () => {
  // Arrange
  const loads = []
  const tool = createProjectTimeDraftTool(z, {
    loadTransform: async options => {
      loads.push(options)
      return {
        sourceKind: "human_active",
        entries: [{
          spentDate: "2026-07-20",
          project: "wrap",
          task: "Review destination",
          destination: "Local Project Time project — no configured Harvest destination; choose a Harvest project and task before submitting.",
          milliseconds: 5_430_000,
          sources: [{ spentDate: "2026-07-20", project: "wrap", repositoryId: "repo-a", sourceKind: "human_active", activity: "Build", milliseconds: 5_430_000 }],
        }],
        excluded: [],
      }
    },
  })

  // Act
  const result = await tool.execute("draft", { from: "2026-07-20", to: "2026-07-20" })

  // Assert
  assert.equal(tool.approval, "read")
  assert.deepEqual(loads, [{
    from: "2026-07-20",
    to: "2026-07-20",
    sourceKind: "human_active",
    applyMappings: true,
    mappings: new Map(),
    logPath: undefined,
  }])
  assert.match(result.content[0].text, /Project: wrap\nTask: Review destination\nDestination: Local Project Time project/)
  assert.match(result.content[0].text, /Duration: 1:30:30\nNotes \(required before submitting\)\n- Add a factual Harvest note; automatic activity labels are reference only\.\nSource evidence/)
})


test("when time off is requested, it registers an approved write tool", async () => {
  // Arrange
  const calls = []
  const tool = createTimeOffTool(z, {
    command: "omp-worklog",
    run: async (...args) => {
      calls.push(args)
      return { code: 0, stdout: "Created 2026-07-17", stderr: "" }
    },
  })

  // Act
  const result = await tool.execute(
    "call-1",
    { from: "2026-07-17", to: "2026-07-17", project: "Time Off - Marlen", task: "Vacation / PTO" },
    undefined,
    undefined,
    { cwd: "/tmp" },
  )

  // Assert
  assert.equal(tool.approval, "write")
  const accepts = params => tool.parameters.refinements.every(refinement => refinement(params))
  assert.equal(accepts({ project: "PTO", task: "Vacation" }), true)
  assert.equal(accepts({ projectId: 123, taskId: 456 }), true)
  assert.equal(accepts({}), false)
  assert.equal(accepts({ project: "PTO" }), false)
  assert.equal(accepts({ project: "PTO", task: "Vacation", projectId: 123, taskId: 456 }), false)
  const unconfiguredTool = createTimeOffTool(z, { holidayRegions: "" })
  const acceptsUnconfigured = params => unconfiguredTool.parameters.refinements.every(refinement => refinement(params))
  assert.equal(acceptsUnconfigured({ project: "PTO", task: "Vacation" }), false)
  assert.equal(acceptsUnconfigured({ project: "PTO", task: "Vacation", holidayRegions: ["ca_yt"] }), true)
  assert.deepEqual(calls, [[
    "omp-worklog",
    [
      "time-off", "2026-07-17", "2026-07-17", "--project", "Time Off - Marlen", "--task", "Vacation / PTO",
      "--hours", "7", "--holiday-region", "ca_yt",
    ],
    { cwd: "/tmp", signal: undefined },
  ]])
  assert.equal(result.content[0].text, "Created 2026-07-17")
})

test("when time-off hours are nonpositive or nonfinite, it rejects the request", () => {
  // Arrange
  const tool = createTimeOffTool(z)
  const assignment = { project: "PTO", task: "Vacation" }

  // Act
  const accepted = [0, -1, NaN, Infinity, -Infinity].map(hours =>
    tool.parameters.refinements.every(refinement => refinement({ ...assignment, hours })))

  // Assert
  assert.deepEqual(accepted, [false, false, false, false, false])
})

test("when time-off hours are fractional or omitted, it accepts the request", () => {
  // Arrange
  const tool = createTimeOffTool(z)
  const assignment = { project: "PTO", task: "Vacation" }

  // Act
  const accepted = [undefined, 0.001, 0.25, 7.5].map(hours =>
    tool.parameters.refinements.every(refinement => refinement({ ...assignment, hours })))

  // Assert
  assert.deepEqual(accepted, [true, true, true, true])
})

test("when defaults and explicit regions are configured, it includes both", async () => {
  // Arrange
  const calls = []
  const tool = createTimeOffTool(z, {
    defaultHours: 6.5,
    holidayRegions: "ca_yt, ca",
    run: async (...args) => {
      calls.push(args)
      return { code: 0, stdout: "Created", stderr: "" }
    },
  })

  // Act
  await tool.execute(
    "call-2",
    {
      from: "2026-08-17",
      to: "2026-08-28",
      project: "Time Off - Marlen",
      task: "Vacation / PTO",
      holidayRegions: ["us_ca"],
    },
    undefined,
    undefined,
    { cwd: "/tmp" },
  )

  // Assert
  assert.deepEqual(calls[0][1], [
    "time-off", "2026-08-17", "2026-08-28", "--project", "Time Off - Marlen", "--task", "Vacation / PTO",
    "--hours", "6.5", "--holiday-region", "ca_yt", "--holiday-region", "ca", "--holiday-region", "us_ca",
  ])
})

test("when completing timesheet arguments, it suggests contextual values", () => {
  // Arrange
  const projects = ["Ice Fog Analytics", "wrap", "WRAP"]

  // Act
  const root = ompWorklogArgumentCompletions("")
  const prefix = ompWorklogArgumentCompletions("ti")
  const dates = ompWorklogArgumentCompletions("timesheet ")
  const timesheet = ompWorklogArgumentCompletions("timesheet")
  const todayPrefix = ompWorklogArgumentCompletions("timesheet t")
  const todayOptions = ompWorklogArgumentCompletions("timesheet today ")
  const projectOptions = ompWorklogArgumentCompletions("timesheet today --project ", projects)
  const projectPrefix = ompWorklogArgumentCompletions("timesheet today --project w", projects)
  const spacedProject = ompWorklogArgumentCompletions("timesheet today --project Ice F", projects)
  const preservedProject = ompWorklogArgumentCompletions("timesheet today --project w", [" wrap "])
  const selectedProject = ompWorklogArgumentCompletions("timesheet today --project i", projects)[0].value
  const contextualOptions = ompWorklogArgumentCompletions("timesheet today --project WRAP ")
  const contextualHelp = contextualOptions.find(item => item.label === "--help")
  const parsedProject = parseOmpWorklogArguments(selectedProject)
  const parsedContextualHelp = parseOmpWorklogArguments(contextualHelp.value)
  const invalidInputs = [
    ompWorklogArgumentCompletions(`${contextualHelp.value} `),
    ompWorklogArgumentCompletions("timesheet nonsense "),
    ompWorklogArgumentCompletions("timesheet today extra "),
    ompWorklogArgumentCompletions("today "),
    ompWorklogArgumentCompletions("aggregate "),
  ]

  // Assert
  assert.deepEqual(root.map(item => item.value), ["review", "timesheet", "stats", "plan", "submit", "help"])
  assert.deepEqual(prefix.map(item => item.value), ["timesheet"])
  assert.deepEqual(dates.slice(0, 2).map(item => item.value), ["timesheet today", "timesheet yesterday"])
  assert.match(dates[2].value, /^timesheet \d{4}-\d{2}-\d{2}$/)
  assert.deepEqual(timesheet.map(item => item.value), ["timesheet"])
  assert.deepEqual(todayPrefix.map(item => item.value), ["timesheet today"])
  assert.deepEqual(todayOptions.map(item => item.value), ["timesheet today --project", "timesheet today --help"])
  assert.deepEqual(projectOptions.map(item => item.value), ["timesheet today --project \"Ice Fog Analytics\"", "timesheet today --project wrap", "timesheet today --project WRAP"])
  assert.deepEqual(projectPrefix.map(item => item.value), ["timesheet today --project wrap", "timesheet today --project WRAP"])
  assert.deepEqual(spacedProject.map(item => item.value), ["timesheet today --project \"Ice Fog Analytics\""])
  assert.deepEqual(preservedProject.map(item => item.value), ["timesheet today --project \" wrap \""])
  assert.deepEqual(parsedProject, { argv: ["timesheet", "today", "--project", "Ice Fog Analytics"] })
  assert.deepEqual(contextualOptions.map(item => item.value), ["timesheet today --project WRAP --help"])
  assert.deepEqual(parsedContextualHelp, { help: true })
  assert.deepEqual(invalidInputs, [null, null, null, null, null])
})

test("when log metadata is unchanged, it caches local project names", () => {
  // Arrange
  let reads = 0
  let mtimeMs = 1
  const loader = createProjectTimeProjectNamesLoader({
    stat: () => ({ mtimeMs, size: 10 }),
    read: () => {
      reads += 1
      return JSON.stringify({ format: "omp-project-time/evidence", version: 1, entries: [{ sourceKind: "human_active", project: "wrap" }] })
    },
  })

  // Act
  const initialNames = loader("/tmp/project-time.json")
  const cachedNames = loader("/tmp/project-time.json")
  const readsBeforeChange = reads
  mtimeMs = 2
  const changedNames = loader("/tmp/project-time.json")

  // Assert
  assert.deepEqual(initialNames, ["wrap"])
  assert.deepEqual(cachedNames, ["wrap"])
  assert.equal(readsBeforeChange, 1)
  assert.deepEqual(changedNames, ["wrap"])
  assert.equal(reads, 2)
})

test("when a project is committed to SQLite WAL, completion sees it without restarting", t => {
  // Arrange
  const directory = mkdtempSync(join(tmpdir(), "worklog-completion-"))
  const logPath = join(directory, "time-log.sqlite")
  const database = new DatabaseSync(logPath)
  t.after(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })
  database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE entries (entry_json TEXT NOT NULL)")
  const insert = database.prepare("INSERT INTO entries (entry_json) VALUES (?)")
  insert.run(JSON.stringify({ sourceKind: "human_active", project: "Demo" }))
  const loader = createProjectTimeProjectNamesLoader()
  assert.deepEqual(loader(logPath), ["Demo"])

  // Act
  insert.run(JSON.stringify({ sourceKind: "human_active", project: "New Project" }))
  const projects = loader(logPath)

  // Assert
  assert.deepEqual(projects, ["Demo", "New Project"])
})

test("when parsing quoted timesheet arguments, it preserves project values", () => {
  // Arrange
  const inputs = [
    "timesheet today --project 'Ice Fog Analytics'",
    "timesheet today",
    "timesheet --help",
    "timesheet today --help",
    "today Ice Fog Analytics --task Programming",
    "timesheet",
    "timesheet today --task Programming",
    "timesheet today --project WRAP --task",
    "timesheet today --project WRAP --task Programming",
    "timesheet today --project WRAP --bogus x",
    "timesheet today --project WRAP --project Other",
    "timesheet nonsense --help",
    "timesheet --bogus --help",
    "time-off --help",
    "timesheet today --project 'WRAP",
  ]

  // Act
  const parsedCommand = parseCommandArguments(inputs[0])
  const parsedOmpArguments = inputs.slice(0, -1).map(parseOmpWorklogArguments)
  const unclosedQuote = parseCommandArguments(inputs.at(-1))

  // Assert
  assert.deepEqual(parsedCommand, ["timesheet", "today", "--project", "Ice Fog Analytics"])
  assert.deepEqual(parsedOmpArguments, [
    { argv: ["timesheet", "today", "--project", "Ice Fog Analytics"] },
    { argv: ["timesheet", "today"] },
    { help: true },
    { help: true },
    null, null, null, null, null, null, null, null, null, null,
  ])
  assert.equal(unclosedQuote, null)
})

test("when registering the OMP extension, it exposes a deterministic no-write draft command", async () => {
  // Arrange
  const tools = []
  const commands = []
  const messages = []
  const widgets = []
  const notifications = []
  const transformLoads = []
  const summaryPlans = []
  let failSummary = false
  // Act
  await ompWorklogExtension({
    zod: { z },
    registerTool(tool) { tools.push(tool) },
    registerCommand(name, command) { commands.push({ name, command }) },
    sendMessage(message, options) { messages.push({ message, options }) },
  }, {
    command: " ",
    projectTimeMappings: '{"wrap":{"project":"WRAP (YG - SIS)","task":"Programming"}}',
    projectTimeLogPath: " /tmp/project-time.json ",
    loadProjectTimeProjectNames: logPath => {
      assert.equal(logPath, "/tmp/project-time.json")
      return ["Ice Fog Analytics", "wrap"]
    },
    loadProjectTimeTransform: async options => {
      transformLoads.push(options)
      return {
        sourceKind: "human_active",
        entries: [{
          spentDate: "2026-07-20",
          project: "WRAP (YG - SIS)",
          task: "Programming",
          destination: "Configured Harvest destination",
          milliseconds: 24_040_000,
          sources: Array.from({ length: 40 }, (_, index) => ({
            id: `entry-${index}`,
            spentDate: "2026-07-20",
            sourceKind: "human_active",
            project: "wrap",
            repositoryId: "repository-id",
            repositoryIdentity: "github.com/klondikemarlen/wrap",
            activity: `Activity ${index}`,
            workItemAttribution: "explicit_prompt",
            workItem: { kind: "issue", number: 91 + index, repository: "klondikemarlen/omp-worklog" },
            narrative: { text: `Narrative ${index} for WRAP-${123 + index}.` },
            milliseconds: 601_000,
          })),
        }],
      }
    },
    completeProjectTimeSummary: async (ctx, plan) => {
      if (ctx.hasUI) {
        assert.deepEqual(widgets.at(-1), {
          key: "omp-worklog-timesheet-summary",
          content: ["Generating work summary…"],
          options: { placement: "aboveEditor" },
        })
      }
      if (failSummary) throw new Error("summary failed")

      summaryPlans.push(plan)
      return ["Narrative 0 for WRAP-123.", "Summary line 0", "x".repeat(200), ...Array.from({ length: 9 }, (_, index) => `Summary line ${index + 1}`), "Suggested Harvest note: Ready for Harvest."].join("\n")
    },
  })

  const ui = {
    notify(message, type) { notifications.push({ message, type }) },
    setWidget(key, content, options) { widgets.push({ key, content, options }) },
  }
  const command = commands[0].command

  // Assert
  assert.equal(commands[0].name, "worklog")
  assert.deepEqual(
    command.getArgumentCompletions("timesheet today --project w").map(item => item.value),
    ["timesheet today --project wrap"],
  )
  await command.handler("", { cwd: "/tmp", ui })
  assert.match(notifications[0].message, /\/worklog timesheet DATE \[--project PROJECT\]/)

  await command.handler("timesheet 2026-07-20", { cwd: "/tmp", ui })
  await command.handler("timesheet 2026-07-20 --project wrap", { cwd: "/tmp", ui, model: {}, hasUI: true })
  assert.deepEqual(transformLoads, [
    {
      from: "2026-07-20",
      to: "2026-07-20",
      project: undefined,
      mappings: new Map([["wrap", { project: "WRAP (YG - SIS)", task: "Programming" }]]),
      applyMappings: true,
      logPath: "/tmp/project-time.json",
    },
    {
      from: "2026-07-20",
      to: "2026-07-20",
      project: "wrap",
      mappings: new Map([["wrap", { project: "WRAP (YG - SIS)", task: "Programming" }]]),
      applyMappings: true,
      logPath: "/tmp/project-time.json",
    },
  ])
  assert.equal(
    messages[0].message.content,
    "Timesheet totals (review only)\nDate: 2026-07-20\nProject: wrap\nDuration: 6:40:40\nHarvest: WRAP (YG - SIS) / Programming",
  )
  assert.doesNotMatch(messages[0].message.content, /Task:|Review:|Work items|Source evidence|entry-0|repository-id|Narrative 0/)
  assert.equal(messages.length, 3)
  assert.equal(messages[1].message.customType, "omp-worklog-timesheet-summary")
  assert.equal(messages[1].message.content, "AI-generated work summary unavailable (review before use).")
  assert.equal(messages[2].message.customType, "omp-worklog-timesheet")
  assert.equal(messages[2].message.content.split("\n").length <= 22, true)
  assert.deepEqual(messages[2].options, { triggerTurn: false })
  assert.equal(summaryPlans[0].entries[0].sources.length, 40)
  assert.equal(widgets.length, 2)
  assert.deepEqual(widgets[0], {
    key: "omp-worklog-timesheet-summary",
    content: ["Generating work summary…"],
    options: { placement: "aboveEditor" },
  })
  assert.equal(widgets[1].key, widgets[0].key)
  assert.deepEqual(widgets[1].options, widgets[0].options)
  const renderedSummary = widgets[1].content.join("\n")
  assert.equal(widgets[1].content.length, 5)
  assert.match(renderedSummary, /Summary line 1/)
  assert.doesNotMatch(renderedSummary, /Summary line 2/)
  assert.match(renderedSummary, /…/)
  assert.equal(widgets[1].content.every(line => line.length <= 100), true)
  assert.match(renderedSummary, /Suggested Harvest note \(review before use\): Ready for Harvest\./)
  assert.doesNotMatch(renderedSummary, /Narrative 0 for WRAP-123/)
  assert.equal(messages[2].message.content.split("\n").length + widgets[1].content.length <= 30, true)

  failSummary = true
  await command.handler("timesheet 2026-07-20 --project wrap", { cwd: "/tmp", ui, model: {}, hasUI: true })
  assert.deepEqual(transformLoads[2], transformLoads[1])
  assert.equal(messages.length, 4)
  assert.deepEqual(widgets[3], {
    key: "omp-worklog-timesheet-summary",
    content: ["AI-generated work summary unavailable (review before use)."],
    options: { placement: "aboveEditor" },
  })
  assert.deepEqual(notifications.at(-1), {
    message: "Could not generate Project Time summary; showing totals only.",
    type: "warning",
  })

  failSummary = false
  await command.handler("timesheet 2026-07-20 --project wrap", { cwd: "/tmp", ui, model: {}, hasUI: false })
  assert.deepEqual(transformLoads[3], transformLoads[1])
  assert.equal(widgets.length, 4)
  assert.equal(messages[5].message.customType, "omp-worklog-timesheet-summary")
  assert.match(messages[5].message.content, /Suggested Harvest note \(review before use\): Ready for Harvest\./)
  await command.handler("timesheet 2026-07-20 --project wrap", { cwd: "/tmp", ui, hasUI: true })
  assert.deepEqual(transformLoads[4], transformLoads[1])
  assert.equal(messages.length, 7)
  assert.deepEqual(widgets.at(-1), {
    key: "omp-worklog-timesheet-summary",
    content: ["AI-generated work summary unavailable (review before use)."],
    options: { placement: "aboveEditor" },
  })
  await command.handler("time-off --help", { cwd: "/tmp", ui })
  assert.equal(messages.length, 7)
  assert.deepEqual(tools.filter(tool => tool.approval === "write").map(tool => tool.name), [
    "omp_worklog_record_time_off",
    "omp_worklog_prepare_review_batch",
    "omp_worklog_submit_reviewed_batch",
  ])
})

test("when host settings resolve, the timesheet uses the persisted destination", async t => {
  // Arrange
  const directory = mkdtempSync(join(tmpdir(), "worklog-settings-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const logPath = join(directory, "evidence.json")
  const startAtMs = new Date(2026, 9, 19, 9).getTime()
  writeFileSync(logPath, JSON.stringify({
    format: "omp-project-time/evidence",
    version: 1,
    entries: [{ project: "Demo", sourceKind: "human_active", startAtMs, endAtMs: startAtMs + 60_000 }],
  }))
  const messages = []
  let command

  // Act
  await ompWorklogExtension({
    cwd: directory,
    zod: { z },
    registerTool() {},
    registerCommand(_name, definition) { command = definition },
    sendMessage(message) { messages.push(message) },
  }, {
    projectTimeLogPath: logPath,
    loadPluginSettings: async () => ({
      projectTimeMappings: '{"Demo":{"project":"Internal","task":"Development"}}',
    }),
  })
  await command.handler("timesheet 2026-10-19", { ui: { notify: message => assert.fail(message) } })

  // Assert
  assert.equal(messages[0].content, "Timesheet totals (review only)\nDate: 2026-10-19\nProject: Demo\nDuration: 0:01\nHarvest: Internal / Development")
})

test("when factory options override host settings, the timesheet uses the explicit destination", async t => {
  // Arrange
  const directory = mkdtempSync(join(tmpdir(), "worklog-settings-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const logPath = join(directory, "evidence.json")
  const startAtMs = new Date(2026, 9, 19, 9).getTime()
  writeFileSync(logPath, JSON.stringify({
    format: "omp-project-time/evidence",
    version: 1,
    entries: [{ project: "Demo", sourceKind: "human_active", startAtMs, endAtMs: startAtMs + 60_000 }],
  }))
  const messages = []
  let command

  // Act
  await ompWorklogExtension({
    cwd: directory,
    zod: { z },
    registerTool() {},
    registerCommand(_name, definition) { command = definition },
    sendMessage(message) { messages.push(message) },
  }, {
    projectTimeLogPath: logPath,
    projectTimeMappings: '{"Demo":{"project":"Explicit Destination","task":"Review"}}',
    loadPluginSettings: async () => ({
      projectTimeMappings: '{"Demo":{"project":"Internal","task":"Development"}}',
    }),
  })
  await command.handler("timesheet 2026-10-19", { ui: { notify: message => assert.fail(message) } })

  // Assert
  assert.equal(messages[0].content, "Timesheet totals (review only)\nDate: 2026-10-19\nProject: Demo\nDuration: 0:01\nHarvest: Explicit Destination / Review")
})
