import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"

import { registerLiveWorklogStatus } from "../live-status.js"

function setup() {
  const emitter = new EventEmitter()
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
    humanMilliseconds: 300000,
    agentMilliseconds: 3723000,
    humanActive: false,
    agentActive: true,
    observedAtMs: 100,
    ...data,
  })
  return { handlers, statuses, context, publish }
}

test("when human activity expires, the independent agent duration remains visible", () => {
  // Arrange
  const { handlers, statuses, context, publish } = setup()
  // Act
  handlers.get("session_start")({}, context("thread-a"))
  publish({})
  // Assert
  const status = statuses.get("omp-worklog-time")
  assert.match(status, /Dev 0:05:00 paused/)
  assert.match(status, /Agent 1:02:03 running/)
  publish({ observedAtMs: 200, agentMilliseconds: 3783000, agentActive: false })
  assert.match(statuses.get("omp-worklog-time"), /Agent 1:03:03$/)
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
  assert.match(statuses.get("omp-worklog-time"), /Dev unavailable · Agent unavailable$/)
  publish({ sessionId: "thread-b", project: "other", observedAtMs: 300, humanMilliseconds: 2000 })
  assert.match(statuses.get("omp-worklog-time"), /other · thread · Dev 0:00:02/)
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

test("when evidence is unsupported or unavailable, previous totals are cleared", () => {
  // Arrange
  const { handlers, statuses, context, publish } = setup()
  handlers.get("session_start")({}, context("thread-a"))
  publish({})
  // Act
  publish({ observedAtMs: 200, version: 2 })
  // Assert
  assert.match(statuses.get("omp-worklog-time"), /Dev unavailable · Agent unavailable$/)
  publish({ observedAtMs: 300, humanMilliseconds: undefined, agentMilliseconds: undefined })
  assert.match(statuses.get("omp-worklog-time"), /Dev unavailable · Agent unavailable$/)
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

test("when a project label is long, both source counters fit an 80-column status line", () => {
  // Arrange
  const { handlers, statuses, context, publish } = setup()
  handlers.get("session_start")({}, context("thread-a"))
  // Act
  publish({ project: "a-project-with-a-long-repository-name" })
  // Assert
  assert.match(statuses.get("omp-worklog-time").slice(0, 80), /Dev 0:05:00 paused · Agent 1:02:03 running/)
})
