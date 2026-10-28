const STATUS_KEY = "omp-worklog-time"
const LIVE_EVENT = "omp-project-time:live"
const REQUEST_EVENT = "omp-project-time:live-request"

function durationText(milliseconds) {
  const hours = milliseconds / 3_600_000
  const rounded = hours.toFixed(1).replace(/\.0$/, "")
  return hours > 0 && rounded === "0" ? "<0.1h" : `${rounded}h`
}

function isDuration(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function contextText(project, activity, budget) {
  const clean = value => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim() : ""
  const label = [clean(project), clean(activity)].filter(Boolean).join("/")
  if (!label || budget < 2) return ""
  return label.length > budget ? `${label.slice(0, budget - 1)}…` : label
}

function hasDailyEvidence(snapshot) {
  const dayStart = new Date(snapshot.observedAtMs)
  dayStart.setHours(0, 0, 0, 0)
  return snapshot.version === 1 && snapshot.dayStartAtMs === dayStart.getTime() &&
    isDuration(snapshot.humanMilliseconds) && isDuration(snapshot.agentMilliseconds) &&
    isDuration(snapshot.todayHumanMilliseconds) && isDuration(snapshot.todayAgentMilliseconds) &&
    snapshot.todayHumanMilliseconds <= snapshot.humanMilliseconds &&
    snapshot.todayAgentMilliseconds <= snapshot.agentMilliseconds
}

export function registerLiveWorklogStatus(pi, { enabled = true } = {}) {
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
    ctx.ui.setStatus(STATUS_KEY, enabled ? "Dev unavailable · Agent unavailable" : undefined)
    pi.events.emit(REQUEST_EVENT, { sessionId, presentation: "worklog" })
  }

  const unsubscribe = pi.events.on(LIVE_EVENT, snapshot => {
    if (!enabled) return
    if (!context || !snapshot || snapshot.sessionId !== sessionId || context.sessionManager.getSessionId() !== sessionId) return
    if (!Number.isFinite(snapshot.observedAtMs) || snapshot.observedAtMs < observedAtMs) return
    observedAtMs = snapshot.observedAtMs
    if (!hasDailyEvidence(snapshot)) {
      context.ui.setStatus(STATUS_KEY, "Dev unavailable · Agent unavailable")
      return
    }
    const developer = `${durationText(snapshot.todayHumanMilliseconds)} / ${durationText(snapshot.humanMilliseconds)} total`
    const agent = `${durationText(snapshot.todayAgentMilliseconds)} / ${durationText(snapshot.agentMilliseconds)} total`
    const summary = `Dev ${developer} · Agent ${agent}`
    const label = contextText(snapshot.project, snapshot.activity, 80 - summary.length - 3)
    // Prioritize hours; the host may truncate the less important trailing context.
    context.ui.setStatus(STATUS_KEY, label ? `${summary} — ${label}` : summary)
  })

  pi.on("session_start", request)
  pi.on("session_switch", request)
  pi.on("session_shutdown", () => {
    release()
    if (typeof unsubscribe === "function") unsubscribe()
  })
}
