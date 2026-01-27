import * as fs from "node:fs"
import * as path from "node:path"
import { readBoulderState, readPlanProgress, readPlanSteps, type PlanStep } from "../ingest/boulder"
import { deriveBackgroundTasks } from "../ingest/background-tasks"
import { deriveTimeSeriesActivity, type TimeSeriesPayload } from "../ingest/timeseries"
import { getMainSessionView, getStorageRoots, pickActiveSessionId, readMainSessionMetas, type MainSessionView, type OpenCodeStorageRoots, type SessionMetadata } from "../ingest/session"

export type DashboardPayload = {
  mainSession: {
    agent: string
    currentModel: string | null
    currentTool: string
    lastUpdatedLabel: string
    session: string
    statusPill: string
  }
  planProgress: {
    name: string
    completed: number
    total: number
    path: string
    statusPill: string
    steps: PlanStep[]
  }
  backgroundTasks: Array<{
    id: string
    description: string
    agent: string
    lastModel: string | null
    status: string
    toolCalls: number
    lastTool: string
    timeline: string
  }>
  timeSeries: TimeSeriesPayload
  raw: unknown
}

export type LegacyDashboardPayload = {
  mainSession: {
    agent: string
    currentTool: string
    lastUpdatedLabel: string
    session: string
    statusPill: string
  }
  planProgress: {
    name: string
    completed: number
    total: number
    path: string
    statusPill: string
    steps: PlanStep[]
  }
  backgroundTasks: Array<{
    id: string
    description: string
    agent: string
    status: string
    toolCalls: number
    lastTool: string
    timeline: string
  }>
  timeSeries: TimeSeriesPayload
  raw: unknown
}

export type DashboardStore = {
  getSnapshot: () => DashboardPayload | LegacyDashboardPayload
}

function formatIso(ts: number | null): string {
  if (!ts) return "never"
  try {
    return new Date(ts).toISOString()
  } catch {
    return "never"
  }
}

function planStatusPill(progress: { missing: boolean; isComplete: boolean }): string {
  if (progress.missing) return "not started"
  return progress.isComplete ? "complete" : "in progress"
}

function mainStatusPill(status: string): string {
  if (status === "running_tool") return "running tool"
  if (status === "thinking") return "thinking"
  if (status === "busy") return "busy"
  if (status === "idle") return "idle"
  return "unknown"
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const totalHours = Math.floor(totalMinutes / 60)
  const hours = totalHours % 24
  const days = Math.floor(totalHours / 24)

  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`
  if (totalHours > 0) return minutes > 0 ? `${totalHours}h${minutes}m` : `${totalHours}h`
  if (totalMinutes > 0) return seconds > 0 ? `${totalMinutes}m${seconds}s` : `${totalMinutes}m`
  return `${seconds}s`
}

function formatMainStatusPill(status: string, nowMs: number, lastUpdated: number | null): string {
  const base = mainStatusPill(status)
  if (base !== "unknown") return base
  if (typeof lastUpdated !== "number") return base
  return `unknown (${formatElapsed(nowMs - lastUpdated)})`
}

function pickStatusElapsedAnchor(opts: {
  sessionMeta?: SessionMetadata | null
  mainLastUpdated: number | null
}): number | null {
  if (typeof opts.mainLastUpdated === "number") return opts.mainLastUpdated
  const fromMeta = opts.sessionMeta?.time?.updated ?? opts.sessionMeta?.time?.created ?? null
  return typeof fromMeta === "number" ? fromMeta : null
}

export function buildDashboardPayload(opts: {
  projectRoot: string
  storage: OpenCodeStorageRoots
  nowMs?: number
}): DashboardPayload {
  const nowMs = opts.nowMs ?? Date.now()

  const boulder = readBoulderState(opts.projectRoot)
  const planName = boulder?.plan_name ?? "(no active plan)"
  const planPath = boulder?.active_plan ?? ""
  const plan = boulder ? readPlanProgress(opts.projectRoot, boulder.active_plan) : { total: 0, completed: 0, isComplete: false, missing: true }
  const planSteps = boulder ? readPlanSteps(opts.projectRoot, boulder.active_plan) : { missing: true, steps: [] as PlanStep[] }

  const sessionId = pickActiveSessionId({
    projectRoot: opts.projectRoot,
    storage: opts.storage,
    boulderSessionIds: boulder?.session_ids,
  })

  let sessionMeta: SessionMetadata | null = null
  if (sessionId) {
    const metas = readMainSessionMetas(opts.storage.session, opts.projectRoot)
    sessionMeta = metas.find((m) => m.id === sessionId) ?? null
  }

  const main = sessionId
    ? getMainSessionView({
        projectRoot: opts.projectRoot,
        sessionId,
        storage: opts.storage,
        sessionMeta,
        nowMs,
      })
    : { agent: "unknown", currentTool: null, lastUpdated: null, sessionLabel: "(no session)", status: "unknown" as const }

  const tasks = sessionId ? deriveBackgroundTasks({ storage: opts.storage, mainSessionId: sessionId, nowMs }) : []
  const timeSeries = deriveTimeSeriesActivity({
    storage: opts.storage,
    mainSessionId: sessionId ?? null,
    nowMs,
  })
  const mainCurrentModel = "currentModel" in main
    ? (main as MainSessionView).currentModel
    : null
  const payload: DashboardPayload = {
    mainSession: {
      agent: main.agent,
      currentModel: mainCurrentModel,
      currentTool: main.currentTool ?? "-",
      lastUpdatedLabel: formatIso(main.lastUpdated),
      session: main.sessionLabel,
      statusPill: formatMainStatusPill(
        main.status,
        nowMs,
        pickStatusElapsedAnchor({ sessionMeta, mainLastUpdated: main.lastUpdated })
      ),
    },
    planProgress: {
      name: planName,
      completed: plan.completed,
      total: plan.total,
      path: planPath,
      statusPill: planStatusPill(plan),
      steps: planSteps.missing ? [] : planSteps.steps,
    },
    backgroundTasks: tasks.map((t) => ({
      id: t.id,
      description: t.description,
      agent: t.agent,
      lastModel: t.lastModel ?? null,
      status: t.status,
      toolCalls: t.toolCalls ?? 0,
      lastTool: t.lastTool ?? "-",
      timeline: typeof t.timeline === "string" ? t.timeline : "",
    })),
    timeSeries,
    raw: null,
  }

  payload.raw = {
    mainSession: payload.mainSession,
    planProgress: payload.planProgress,
    backgroundTasks: payload.backgroundTasks,
    timeSeries: payload.timeSeries,
  }
  return payload
}

function watchIfExists(target: string, onChange: () => void): fs.FSWatcher | null {
  try {
    if (!fs.existsSync(target)) return null
    return fs.watch(target, { persistent: false }, () => onChange())
  } catch {
    return null
  }
}

export function createDashboardStore(opts: {
  projectRoot: string
  storageRoot: string
  pollIntervalMs?: number
  watch?: boolean
}): DashboardStore {
  const storage = getStorageRoots(opts.storageRoot)
  const pollIntervalMs = opts.pollIntervalMs ?? 2000
  const watch = opts.watch !== false

  let lastComputedAt = 0
  let dirty = true
  let cached: DashboardPayload | null = null

  const watchers: fs.FSWatcher[] = []
  const markDirty = () => {
    dirty = true
  }

  if (watch) {
    watchers.push(...[
      watchIfExists(path.join(opts.projectRoot, ".sisyphus", "boulder.json"), markDirty),
      watchIfExists(path.join(opts.projectRoot, ".sisyphus", "plans"), markDirty),
      watchIfExists(storage.session, markDirty),
      watchIfExists(storage.message, markDirty),
      watchIfExists(storage.part, markDirty),
    ].filter(Boolean) as fs.FSWatcher[])

    // Best-effort: close watchers on process exit.
    process.on("exit", () => {
      for (const w of watchers) {
        try {
          w.close()
        } catch {
          // ignore
        }
      }
    })
  }

  return {
    getSnapshot() {
      const now = Date.now()
      if (!cached || dirty || now - lastComputedAt > pollIntervalMs) {
        cached = buildDashboardPayload({ projectRoot: opts.projectRoot, storage })
        lastComputedAt = now
        dirty = false
      }
      return cached
    },
  }
}
