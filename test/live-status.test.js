import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"

import { registerLiveWorklogStatus } from "../live-status.js"

function setup() {
  const emitter = new EventEmitter()
  const dayStart = new Date(0)
  dayStart.setHours(0, 0, 0, 0)
  const handlers = new Map()
  const statuses = new Map()
  const events = {
    emit: (channel, data) => emitter.emit(channel, data),
    on(channel, handler) {
      emitter.on(channel, handler)
      return () => emitter.off(channel, handler)
    },
  }
  registerLiveWorklogStatus({ events, on: (event, handler) => handlers.set(event, handler) })
  const context = (id, parentSession) => ({
    hasUI: true,
    sessionManager: { getSessionId: () => id, getHeader: () => ({ parentSession }) },
    ui: { setStatus: (key, value) => statuses.set(key, value) },
  })
  const publish = data => events.emit("omp-project-time:live", {
    version: 1,
    sessionId: "thread-a",
    project: "worklog",
    activity: "implementation",
    humanMilliseconds: 7 * 3_600_000,
    agentMilliseconds: 100 * 3_600_000,
    todayHumanMilliseconds: 7 * 3_600_000,
    todayAgentMilliseconds: 15 * 3_600_000,
    dayStartAtMs: dayStart.getTime(),
    observedAtMs: 100,
    ...data,
  })
  return { handlers, statuses, context, publish }
}

test("when daily and retained durations differ, both source-specific totals remain visible", () => {
  // Arrange
  const { handlers, statuses, context, publish } = setup()
  handlers.get("session_start")({}, context("thread-a"))
  // Act
  publish({})
  // Assert
  assert.equal(statuses.get("omp-worklog-time"), "Dev 7h / 7h total · Agent 15h / 100h total — worklog/implementation")
})

test("when duration contains fractional hours, decimals are rounded without hiding positive evidence", () => {
  // Arrange
  const { handlers, statuses, context, publish } = setup()
  handlers.get("session_start")({}, context("thread-a"))
  // Act
  publish({ todayHumanMilliseconds: 30000, humanMilliseconds: 7.25 * 3_600_000, todayAgentMilliseconds: 0, agentMilliseconds: 0 })
  // Assert
  assert.match(statuses.get("omp-worklog-time"), /^Dev <0\.1h \/ 7\.3h total · Agent 0h \/ 0h total/)
})

test("when threads switch, late snapshots cannot overwrite the new thread", () => {
  // Arrange
  const { handlers, statuses, context, publish } = setup()
  handlers.get("session_start")({}, context("thread-a"))
  publish({})
  // Act
  handlers.get("session_switch")({}, context("thread-b"))
  publish({ observedAtMs: 200 })
  // Assert
  assert.equal(statuses.get("omp-worklog-time"), "Dev unavailable · Agent unavailable")
  publish({ sessionId: "thread-b", project: "other", observedAtMs: 300, todayHumanMilliseconds: 2 * 3_600_000 })
  assert.match(statuses.get("omp-worklog-time"), /^Dev 2h \/ 7h total .* — other\/implementation$/)
})

test("when evidence arrives out of order, the current project remains visible", () => {
  // Arrange
  const { handlers, statuses, context, publish } = setup()
  handlers.get("session_start")({}, context("thread-a"))
  // Act
  publish({ observedAtMs: 300, project: "new-project" })
  publish({ observedAtMs: 100, project: "old-project" })
  // Assert
  assert.match(statuses.get("omp-worklog-time"), /new-project/)
})

test("when daily evidence is absent or belongs to another local day, retained totals are not relabelled as today", () => {
  // Arrange
  const { handlers, statuses, context, publish } = setup()
  handlers.get("session_start")({}, context("thread-a"))
  publish({})
  // Act
  publish({ observedAtMs: 200, todayHumanMilliseconds: undefined })
  // Assert
  assert.equal(statuses.get("omp-worklog-time"), "Dev unavailable · Agent unavailable")
  publish({ observedAtMs: 300, dayStartAtMs: -1 })
  assert.equal(statuses.get("omp-worklog-time"), "Dev unavailable · Agent unavailable")
})

test("when a session shuts down, later evidence cannot restore its display", () => {
  // Arrange
  const { handlers, statuses, context, publish } = setup()
  handlers.get("session_start")({}, context("thread-a"))
  publish({})
  // Act
  handlers.get("session_shutdown")()
  publish({ observedAtMs: 200 })
  // Assert
  assert.equal(statuses.get("omp-worklog-time"), undefined)
})

test("when a session is a subagent, it never displays parent evidence", () => {
  // Arrange
  const { handlers, statuses, context, publish } = setup()
  // Act
  handlers.get("session_start")({}, context("child", "parent"))
  publish({ sessionId: "child" })
  // Assert
  assert.equal(statuses.get("omp-worklog-time"), undefined)
})

test("when trailing context is long, both daily and retained counters fit before it", () => {
  // Arrange
  const { handlers, statuses, context, publish } = setup()
  handlers.get("session_start")({}, context("thread-a"))
  // Act
  publish({ project: "a-project-with-a-long-repository-name", activity: "a long activity description" })
  // Assert
  assert.match(statuses.get("omp-worklog-time").slice(0, 80), /^Dev 7h \/ 7h total · Agent 15h \/ 100h total — /)
})
