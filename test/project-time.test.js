import assert from "node:assert/strict"
import test from "node:test"

import { createProjectTimeTransformTool } from "../index.js"
import { defaultProjectTimeLogPath, formatProjectTimeCommandSummary, formatProjectTimeEntryDrafts, loadProjectTimeTransform, parseProjectTimeMappings, projectTimeProjectNames, projectTimeSummaryPrompt, projectTimeTransform, resolveProjectTimeDate } from "../project-time.js"

const schema = () => ({
  regex() { return this },
  min() { return this },
  trim() { return this },
  positive() { return this },
  finite() { return this },
  optional() { return this },
})
const z = {
  string: schema,
  number: schema,
  boolean: schema,
  object: shape => shape,
}

const evidenceState = entries => ({ format: "omp-project-time/evidence", version: 1, entries })

test("when mapping settings are valid or invalid, it normalizes and validates them", () => {
  // Arrange
  const validMapping = { " Harvest API ": { project: " Internal ", task: " Development " } }
  const missingProject = { "Harvest API": { project: " ", task: "Development" } }
  const duplicateProject = {
    "Harvest API": { project: "Internal", task: "Development" },
    " Harvest API ": { project: "Other", task: "Development" },
  }

  // Act
  const emptyMappings = [...parseProjectTimeMappings(" ")]
  const normalizedMappings = [...parseProjectTimeMappings(validMapping)]
  const parseMissingProject = () => parseProjectTimeMappings(missingProject)
  const parseDuplicateProject = () => parseProjectTimeMappings(duplicateProject)

  // Assert
  assert.deepEqual(emptyMappings, [])
  assert.deepEqual(normalizedMappings, [["Harvest API", { project: "Internal", task: "Development" }]])
  assert.throws(parseMissingProject, /requires project and task names/)
  assert.throws(parseDuplicateProject, /duplicate project Harvest API/)
})

test("when resolving a local date, it resolves relative dates and rejects invalid input", () => {
  // Arrange
  const currentDate = new Date(2026, 6, 20, 12)

  // Act
  const today = resolveProjectTimeDate("today", currentDate)
  const yesterday = resolveProjectTimeDate("yesterday", currentDate)
  const parseInvalidDate = () => resolveProjectTimeDate("2026-02-31")

  // Assert
  assert.equal(today, "2026-07-20")
  assert.equal(yesterday, "2026-07-19")
  assert.throws(parseInvalidDate, /valid local date/)
})

test("when a transform range contains an impossible date, it rejects either endpoint", () => {
  // Arrange
  const state = evidenceState([])
  const ranges = [
    { from: "2026-02-31", to: "2026-03-01" },
    { from: "2026-02-01", to: "2026-02-31" },
    { from: "2025-02-29", to: "2025-03-01" },
  ]

  // Act / Assert
  for (const range of ranges) {
    assert.throws(() => projectTimeTransform(state, new Map(), range), /valid local date/)
  }
})

test("when a valid leap day is selected, it retains that day's evidence", () => {
  // Arrange
  const startAtMs = new Date(2024, 1, 29, 9).getTime()
  const state = evidenceState([{
    project: "Demo",
    sourceKind: "human_active",
    startAtMs,
    endAtMs: startAtMs + 60_000,
  }])

  // Act
  const plan = projectTimeTransform(state, new Map(), { from: "2024-02-29", to: "2024-02-29" })

  // Assert
  assert.equal(plan.groups[0].spentDate, "2024-02-29")
  assert.equal(plan.groups[0].milliseconds, 60_000)
})

test("when a mapped interval rounds to zero hours, its exact duration remains in the draft", () => {
  // Arrange
  const startAtMs = new Date(2026, 9, 19, 9).getTime()
  const state = evidenceState([{
    project: "Demo",
    sourceKind: "human_active",
    startAtMs,
    endAtMs: startAtMs + 10_000,
  }])
  const mappings = parseProjectTimeMappings({ Demo: { project: "Internal", task: "Development" } })

  // Act
  const plan = projectTimeTransform(state, mappings, {
    from: "2026-10-19",
    to: "2026-10-19",
    applyMappings: true,
  })

  // Assert
  assert.equal(plan.entries[0].project, "Internal")
  assert.equal(plan.entries[0].milliseconds, 10_000)
  assert.match(formatProjectTimeEntryDrafts(plan), /Duration: 0:00:10\n/)
})

test("when an unmapped interval lasts one millisecond, it remains available for review", () => {
  // Arrange
  const startAtMs = new Date(2026, 9, 19, 9).getTime()
  const state = evidenceState([{
    project: "Demo",
    sourceKind: "human_active",
    startAtMs,
    endAtMs: startAtMs + 1,
  }])

  // Act
  const plan = projectTimeTransform(state, new Map(), {
    from: "2026-10-19",
    to: "2026-10-19",
    applyMappings: true,
  })

  // Assert
  assert.equal(plan.entries[0].task, "Review destination")
  assert.equal(plan.entries[0].milliseconds, 1)
  assert.match(formatProjectTimeEntryDrafts(plan), /Duration: 0:00:00\.001\n/)
})

test("when evidence has human-active projects, it returns distinct project names", () => {
  // Arrange
  const state = evidenceState([
    { sourceKind: "human_active", project: "wrap" },
    { sourceKind: "agent_turn_elapsed", project: "ignored" },
    { sourceKind: "human_active", project: "Ice Fog Analytics" },
    { sourceKind: "human_active", project: "wrap" },
    { sourceKind: "human_active", project: " " },
  ])

  // Act
  const projects = projectTimeProjectNames(state)

  // Assert
  assert.deepEqual(projects, ["Ice Fog Analytics", "wrap"])
})

test("when reading current SQLite evidence, it loads the expected Project Time plan", async () => {
  // Arrange
  const startAtMs = new Date(2026, 6, 17, 9).getTime()
  const entry = {
    id: "entry-1",
    project: "OMP Worklog",
    repositoryId: "github.com/klondikemarlen/omp-worklog",
    sourceKind: "human_active",
    activity: "implementation",
    startAtMs,
    endAtMs: startAtMs + 3_600_000,
  }
  let closed = false
  // Act
  const plan = await loadProjectTimeTransform({
    from: "2026-07-17",
    to: "2026-07-17",
    mappings: new Map(),
    logPath: "/tmp/time-log.sqlite",
    openDatabase(logPath) {
      assert.equal(logPath, "/tmp/time-log.sqlite")
      return {
        query(sql) {
          assert.equal(sql, "SELECT entry_json FROM entries ORDER BY rowid")
          return { all: () => [{ entry_json: JSON.stringify(entry) }] }
        },
        close() { closed = true },
      }
    },
  })

  const legacyPlan = await loadProjectTimeTransform({
    from: "2026-07-17",
    to: "2026-07-17",
    mappings: new Map(),
    logPath: "/tmp/time-log.json",
    read: async () => JSON.stringify(evidenceState([entry])),
  })

  // Assert
  assert.match(defaultProjectTimeLogPath(), /time-log\.sqlite$/)
  assert.equal(plan.groups[0].hours, 1)
  assert.equal(legacyPlan.groups[0].hours, 1)
  assert.equal(closed, true)
})







test("when destinations are configured or require review, it creates a multi-project draft", () => {
  // Arrange
  const at = (hour, minute = 0) => new Date(2026, 6, 17, hour, minute).getTime()
  // Act
  const plan = projectTimeTransform(
    evidenceState([
      {
        id: "entry-mapped",
        project: "wrap",
        repositoryId: "wrap-repository",
        sourceKind: "human_active",
        activity: "Implement",
        workItemAttribution: "explicit_prompt",
        startAtMs: at(9),
        endAtMs: at(10),
      },
      {
        id: "entry-unassigned",
        project: "wrap",
        repositoryId: "wrap-repository",
        sourceKind: "human_active",
        activity: "Review",
        workItemAttribution: "unassigned",
        startAtMs: at(10),
        endAtMs: at(11),
      },
      {
        id: "entry-unmapped-project",
        project: "Administration",
        repositoryId: "administration-repository",
        sourceKind: "human_active",
        workItemAttribution: "explicit_prompt",
        startAtMs: at(11),
        endAtMs: at(11, 45),
      },
    ]),
    parseProjectTimeMappings({ wrap: { project: "WRAP", task: "Programming" } }),
    { from: "2026-07-17", to: "2026-07-17", applyMappings: true },
  )

  // Assert
  assert.deepEqual(
    plan.entries.map(({ project, task, destination, hours }) => ({ project, task, destination, hours })),
    [
      { project: "Administration", task: "Review destination", destination: "Local Project Time project — no configured Harvest destination; choose a Harvest project and task before submitting.", hours: 0.75 },
      { project: "wrap", task: "Review destination", destination: "Local Project Time project — unassigned work item; choose a Harvest project and task before submitting.", hours: 1 },
      { project: "WRAP", task: "Programming", destination: "Configured Harvest destination", hours: 1 },
    ],
  )
  const draft = formatProjectTimeEntryDrafts(plan)
  assert.match(draft, /Project: Administration\nTask: Review destination\nDestination: Local Project Time project/)
  assert.match(draft, /Project: WRAP\nTask: Programming\nDestination: Configured Harvest destination/)
  assert.match(draft, /Project: wrap\nTask: Review destination\nDestination: Local Project Time project — unassigned work item/)
  assert.match(draft, /source entry-mapped/)
  assert.match(draft, /source entry-unassigned/)
  assert.match(draft, /source entry-unmapped-project/)
})

test("when more than twenty-one totals exist, it limits the interactive summary", () => {
  // Arrange
  // Act
  const output = formatProjectTimeCommandSummary({
    groups: Array.from({ length: 40 }, (_, index) => ({
      spentDate: "2026-07-20",
      project: index === 0 ? "wrap 0\nhidden" : `wrap ${index}`,
      milliseconds: 60_000,
    })),
  })

  // Assert
  assert.equal(output.split("\n").length <= 22, true)
  assert.match(output, /Date: 2026-07-20\nProject: wrap 0 hidden\nDuration: 0:01\nHarvest: Review destination/)
  assert.match(output, /36 additional totals omitted; use omp_worklog_preview_project_time_drafts for detailed review\./)
  assert.doesNotMatch(output, /\|/)
})

test("when a project is selected from high-cardinality evidence, it excludes unrelated evidence", () => {
  // Arrange
  const startAtMs = new Date(2026, 6, 20, 9).getTime()
  const state = evidenceState([
    ...Array.from({ length: 40 }, (_, index) => ({
      id: `wrap-${index}`,
      project: "wrap",
      repositoryId: "wrap-repository",
      repositoryIdentity: "github.com/icefoganalytics/wrap",
      sourceKind: "human_active",
      activity: `Workflow search optimization ${index}`,
      workItem: {
        kind: "pull_request",
        number: index < 30 ? 584 : 583,
        repository: "github.com/icefoganalytics/wrap",
      },
      narrative: { text: `QA and fixup for workflow search optimization WRAP-${index}.` },
      startAtMs: startAtMs + index * 60_000,
      endAtMs: startAtMs + (index + 1) * 60_000,
    })),
    {
      id: "unrelated-source",
      project: "other",
      repositoryId: "other-repository",
      sourceKind: "human_active",
      activity: "Unrelated work",
      narrative: { text: "This must not appear." },
      startAtMs,
      endAtMs: startAtMs + 60_000,
    },
  ])
  // Act
  const plan = projectTimeTransform(
    state,
    new Map(),
    { from: "2026-07-20", to: "2026-07-20", project: "wrap", applyMappings: true },
  )
  const output = formatProjectTimeCommandSummary(plan)
  const prompt = projectTimeSummaryPrompt(plan)
  const evidence = JSON.parse(prompt.split("<evidence>\n")[1].split("\n</evidence>")[0])

  // Assert
  assert.equal(
    output,
    "Timesheet totals (review only)\nDate: 2026-07-20\nProject: wrap\nDuration: 0:40\nHarvest: Review destination",
  )
  assert.doesNotMatch(output, /source|Narrative|other|\|/)
  assert.equal(evidence.length, 8)
  assert.equal(evidence.every(entry => entry.project === "wrap"), true)
  assert.equal(evidence.every(entry => entry.repository === "github.com/icefoganalytics/wrap"), true)
  assert.equal(evidence.every(entry => entry.workItem.number === 584), true)
  assert.equal(evidence.every(entry => entry.workstreamDuration === "0:30"), true)
  assert.doesNotMatch(JSON.stringify(evidence), /other|unrelated/)
  assert.match(prompt, /lead with the workstream having the greatest cumulative duration/)
  assert.match(prompt, /"references":\["GitHub PR #584","Jira WRAP-0"\]/)
})

test("when filtering Project Time evidence, it groups, maps, and limits the requested scope", () => {
  // Arrange
  const at = (hour, minute = 0) => new Date(2026, 6, 17, hour, minute).getTime()
  const nextDay = new Date(2026, 6, 18, 9).getTime()
  const mappings = parseProjectTimeMappings(JSON.stringify({
    "Harvest API": { project: "Internal", task: "Development" },
  }))
  const state = evidenceState([
    { project: "Harvest API", repositoryId: "repo", sourceKind: "human_active", activity: "implementation", startAtMs: at(9), endAtMs: at(9, 30) },
    { project: "Harvest API", repositoryId: "repo", sourceKind: "human_active", activity: "implementation", startAtMs: at(10), endAtMs: at(10, 30) },
    { project: "Harvest API", repositoryId: "repo", sourceKind: "human_active", startAtMs: at(11), endAtMs: at(11, 15) },
    { project: "Other", repositoryId: "repo", sourceKind: "human_active", activity: "review", startAtMs: at(12), endAtMs: at(12, 30) },
    { project: "Harvest API", repositoryId: "repo", sourceKind: "idle", activity: "implementation", startAtMs: at(13), endAtMs: at(13, 30) },
    { project: "Harvest API", repositoryId: "repo", sourceKind: "human_active", activity: "invalid", startAtMs: at(14), endAtMs: at(14) },
    { project: "Harvest API", repositoryId: "repo", sourceKind: "human_active", activity: "out-of-range", startAtMs: nextDay, endAtMs: nextDay + 1_800_000 },
  ])
  const options = {
    from: "2026-07-17",
    to: "2026-07-17",
    project: "Harvest API",
    sourceKind: "human_active",
    applyMappings: true,
  }

  // Act
  const plan = projectTimeTransform(state, mappings, options)

  // Assert
  assert.deepEqual(
    plan.groups.map(({ spentDate, activity, hours, harvest }) => ({ spentDate, activity, hours, harvest })),
    [
      { spentDate: "2026-07-17", activity: "implementation", hours: 1, harvest: { project: "Internal", task: "Development" } },
      { spentDate: "2026-07-17", activity: "unlabelled", hours: 0.25, harvest: { project: "Internal", task: "Development" } },
    ],
  )
  assert.deepEqual(
    plan.entries.map(({ spentDate, project, task, destination, hours }) => ({ spentDate, project, task, destination, hours })),
    [
      { spentDate: "2026-07-17", project: "Internal", task: "Development", destination: "Configured Harvest destination", hours: 1.25 },
    ],
  )
  assert.equal("excluded" in plan, false)
  const draft = formatProjectTimeEntryDrafts({
    ...plan,
    excluded: [{ project: "unrelated", repositoryId: "other", milliseconds: 0, reason: "date_range" }],
  })
  assert.doesNotMatch(draft, /Excluded Project Time evidence|unrelated/)
  assert.equal(JSON.stringify(plan), JSON.stringify(projectTimeTransform(state, mappings, options)))
})

test("when no source kind is supplied, it defaults transforms to human-active intervals", () => {
  // Arrange
  const startAtMs = new Date(2026, 6, 17, 9).getTime()
  const mappings = parseProjectTimeMappings({ "Harvest API": { project: "Internal", task: "Development" } })
  const state = evidenceState([{ project: "Harvest API", repositoryId: "repo", sourceKind: "agent_turn_elapsed", activity: "implementation", startAtMs, endAtMs: startAtMs + 3_600_000 }])
  // Act
  const defaultPlan = projectTimeTransform(
    state,
    mappings,
    { from: "2026-07-17", to: "2026-07-17", applyMappings: true },
  )
  const explicitPlan = projectTimeTransform(
    state,
    mappings,
    { from: "2026-07-17", to: "2026-07-17", sourceKind: "agent_turn_elapsed", applyMappings: true },
  )

  // Assert
  assert.equal(defaultPlan.sourceKind, "human_active")
  assert.equal(explicitPlan.sourceKind, "agent_turn_elapsed")
  assert.deepEqual(defaultPlan.groups, [])
  assert.deepEqual(defaultPlan.entries, [])
  assert.equal("excluded" in defaultPlan, false)
  assert.deepEqual(explicitPlan.entries.map(({ hours }) => hours), [1])
})

test("when previewing JSON transforms, it returns data without writing activity entries", async () => {
  // Arrange
  const plan = {
    groups: [],
    entries: [
      { spentDate: "2026-07-17", project: "Internal", task: "Development", activity: "implementation", hours: 1, notes: "OMP Project Time activity: \"implementation\"\nHarvest API (repo)" },
      { spentDate: "2026-07-17", project: "Internal", task: "Development", activity: "review", hours: 0.5, notes: "OMP Project Time activity: \"review\"\nHarvest API (repo)" },
    ],
    unmapped: [],
    excluded: [],
  }
  const previewCalls = []
  const preview = createProjectTimeTransformTool(z, {
    loadTransform: async options => {
      previewCalls.push(options)
      return plan
    },
  })

  // Act
  const previewResult = await preview.execute("preview", {
    from: "2026-07-17",
    to: "2026-07-17",
    repositoryId: "repo",
    sourceKind: "human_active",
    applyMappings: true,
  })

  // Assert
  assert.equal(preview.approval, "read")
  assert.deepEqual(JSON.parse(previewResult.content[0].text), plan)
  assert.equal(previewCalls[0].applyMappings, true)
})
