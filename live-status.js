const STATUS_KEY = "omp-worklog-time"
const LIVE_EVENT = "omp-project-time:live"
const REQUEST_EVENT = "omp-project-time:live-request"

function durationText(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}

function isDuration(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function projectText(project) {
  if (typeof project !== "string" || project.trim() === "") return "unknown project"
  const label = project.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
  return label.length > 16 ? `${label.slice(0, 15)}…` : label
}

export function registerLiveWorklogStatus(pi) {
  if (typeof pi.on !== "function" || !pi.events?.on || !pi.events?.emit) return

  let context
  let sessionId
  let observedAtMs = -Infinity

  function release() {
    if (!context) return
    const previousSessionId = sessionId
    context.ui.setStatus(STATUS_KEY, undefined)
    context = undefined
    sessionId = undefined
    pi.events.emit(REQUEST_EVENT, { sessionId: previousSessionId, presentation: undefined })
  }

  function request(_event, ctx) {
    if (context && sessionId !== ctx.sessionManager.getSessionId()) release()
    if (!ctx.hasUI || ctx.sessionManager.getHeader()?.parentSession) {
      release()
      return
    }
    context = ctx
    sessionId = ctx.sessionManager.getSessionId()
    observedAtMs = -Infinity
    ctx.ui.setStatus(STATUS_KEY, "Worklog · this thread · Dev unavailable · Agent unavailable")
    pi.events.emit(REQUEST_EVENT, { sessionId, presentation: "worklog" })
  }

  const unsubscribe = pi.events.on(LIVE_EVENT, snapshot => {
    if (!context || !snapshot || snapshot.sessionId !== sessionId || context.sessionManager.getSessionId() !== sessionId) return
    if (!Number.isFinite(snapshot.observedAtMs) || snapshot.observedAtMs < observedAtMs) return
    observedAtMs = snapshot.observedAtMs
    const prefix = `Worklog · ${projectText(snapshot.project)} · thread`
    if (snapshot.version !== 1 || !isDuration(snapshot.humanMilliseconds) || !isDuration(snapshot.agentMilliseconds) ||
        typeof snapshot.humanActive !== "boolean" || typeof snapshot.agentActive !== "boolean") {
      context.ui.setStatus(STATUS_KEY, `${prefix} · Dev unavailable · Agent unavailable`)
      return
    }
    const developer = `${durationText(snapshot.humanMilliseconds)}${snapshot.humanActive ? "" : " paused"}`
    const agent = `${durationText(snapshot.agentMilliseconds)}${snapshot.agentActive ? " running" : ""}`
    // Plain text uses the normal theme foreground; the entire line must not be dimmed.
    context.ui.setStatus(STATUS_KEY, `${prefix} · Dev ${developer} · Agent ${agent}`)
  })

  pi.on("session_start", request)
  pi.on("session_switch", request)
  pi.on("session_shutdown", () => {
    release()
    if (typeof unsubscribe === "function") unsubscribe()
  })
}
