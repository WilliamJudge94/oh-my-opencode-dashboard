import * as fs from "node:fs"
import * as path from "node:path"
import { readBoulderState, readPlanProgress, readPlanSteps, type PlanStep } from "../ingest/boulder"
import { deriveBackgroundTasks, type BackgroundTaskRow } from "../ingest/background-tasks"
import { deriveTimeSeriesActivity, type TimeSeriesPayload } from "../ingest/timeseries"
import { getMainSessionView, getStorageRoots, pickActiveSessionId, readMainSessionMetas, type MainSessionView, type OpenCodeStorageRoots, type SessionMetadata } from "../ingest/session"
import { deriveToolCalls } from "../ingest/tool-calls"
import { deriveTokenUsage } from "../ingest/token-usage"
import type { StorageBackend } from "../ingest/storage-backend"
import {
  deriveBackgroundTasksSqlite,
  deriveTimeSeriesActivitySqlite,
  deriveTokenUsageSqlite,
  deriveToolCallsSqlite,
  getMainSessionViewSqlite,
  pickActiveSessionIdSqlite,
} from "../ingest/sqlite-derive"
import { readMainSessionMetasSqlite } from "../ingest/storage-backend"

export type DashboardPayload = {
  mainSession: {
    agent: string
    currentModel: string | null
    currentTool: string
    lastUpdatedLabel: string
    session: string
    sessionId: string | null
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
    sessionId: string | null
  }>
  mainSessionTasks: Array<{
    id: string
    description: string
    subline?: string
    agent: string
    lastModel: string | null
    status: string
    toolCalls: number
    lastTool: string
    timeline: string
    sessionId: string | null
  }>
  timeSeries: TimeSeriesPayload
  tokenUsage?: ReturnType<typeof deriveTokenUsage>
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

function formatIsoNoMs(ts: number): string {
  const iso = new Date(ts).toISOString()
  return iso.replace(/\.\d{3}Z$/, "Z")
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

function formatTimeline(startAt: number | null, endAtMs: number): string {
  if (typeof startAt !== "number") return ""
  const start = formatIsoNoMs(startAt)
  const elapsed = formatElapsed(endAtMs - startAt)
  return `${start}: ${elapsed}`
}

function buildDashboardPayloadFiles(opts: {
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

  const mainSessionTasks = (() => {
    if (!sessionId) return []

    const mainStatus = main.status
    const status = mainStatus === "running_tool" || mainStatus === "thinking" || mainStatus === "busy"
      ? "running"
      : mainStatus === "idle"
        ? "idle"
        : "unknown"

    const { toolCalls } = deriveToolCalls({
      storage: opts.storage,
      sessionId,
    })

    const startAt = sessionMeta?.time?.created ?? null
    const endAtMs = status === "running" ? nowMs : (main.lastUpdated ?? nowMs)

    return [
      {
        id: "main-session",
        description: "Main session",
        subline: sessionId,
        agent: main.agent,
        lastModel: mainCurrentModel,
        status,
        toolCalls: toolCalls.length,
        lastTool: toolCalls[0]?.tool ?? "-",
        timeline: formatTimeline(startAt, endAtMs),
        sessionId,
      },
    ]
  })()

  const tokenUsage = deriveTokenUsage({
    storage: opts.storage,
    mainSessionId: sessionId ?? null,
    backgroundSessionIds: tasks.map((task) => task.sessionId ?? null),
  })

  const payload: DashboardPayload = {
    mainSession: {
      agent: main.agent,
      currentModel: mainCurrentModel,
      currentTool: main.currentTool ?? "-",
      lastUpdatedLabel: formatIso(main.lastUpdated),
      session: main.sessionLabel,
      sessionId: sessionId ?? null,
      statusPill: mainStatusPill(main.status),
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
      sessionId: t.sessionId ?? null,
    })),
    mainSessionTasks,
    timeSeries,
    tokenUsage,
    raw: null,
  }

  payload.raw = {
    mainSession: payload.mainSession,
    planProgress: payload.planProgress,
    backgroundTasks: payload.backgroundTasks,
    mainSessionTasks: payload.mainSessionTasks,
    timeSeries: payload.timeSeries,
  }
  return payload
}

function hasLegacyStorageRoots(storage: OpenCodeStorageRoots): boolean {
  return fs.existsSync(storage.session) && fs.existsSync(storage.message) && fs.existsSync(storage.part)
}

export function buildDashboardPayload(opts: {
  projectRoot: string
  storage: OpenCodeStorageRoots
  nowMs?: number
  storageBackend?: StorageBackend
}): DashboardPayload {
  const nowMs = opts.nowMs ?? Date.now()
  const backend = opts.storageBackend
  if (!backend || backend.kind !== "sqlite") {
    return buildDashboardPayloadFiles({
      projectRoot: opts.projectRoot,
      storage: opts.storage,
      nowMs,
    })
  }

  const boulder = readBoulderState(opts.projectRoot)
  const planName = boulder?.plan_name ?? "(no active plan)"
  const planPath = boulder?.active_plan ?? ""
  const plan = boulder ? readPlanProgress(opts.projectRoot, boulder.active_plan) : { total: 0, completed: 0, isComplete: false, missing: true }
  const planSteps = boulder ? readPlanSteps(opts.projectRoot, boulder.active_plan) : { missing: true, steps: [] as PlanStep[] }

  const active = pickActiveSessionIdSqlite({
    sqlitePath: backend.sqlitePath,
    projectRoot: opts.projectRoot,
    boulderSessionIds: boulder?.session_ids,
  })
  if (!active.ok) {
    if (hasLegacyStorageRoots(opts.storage)) {
      return buildDashboardPayloadFiles({ projectRoot: opts.projectRoot, storage: opts.storage, nowMs })
    }
    return buildDashboardPayloadFiles({ projectRoot: opts.projectRoot, storage: opts.storage, nowMs })
  }

  const sessionId = active.value
  let sessionMeta: SessionMetadata | null = null
  if (sessionId) {
    const metas = readMainSessionMetasSqlite({ sqlitePath: backend.sqlitePath, directoryFilter: opts.projectRoot })
    if (!metas.ok) {
      if (hasLegacyStorageRoots(opts.storage)) {
        return buildDashboardPayloadFiles({ projectRoot: opts.projectRoot, storage: opts.storage, nowMs })
      }
      return buildDashboardPayloadFiles({ projectRoot: opts.projectRoot, storage: opts.storage, nowMs })
    }
    sessionMeta = metas.rows.find((m) => m.id === sessionId) ?? null
  }

  const main = sessionId
    ? (() => {
        const result = getMainSessionViewSqlite({
          sqlitePath: backend.sqlitePath,
          sessionId,
          sessionMeta,
          nowMs,
        })
        if (!result.ok) return null
        return result.value
      })()
    : { agent: "unknown", currentTool: null, currentModel: null, lastUpdated: null, sessionLabel: "(no session)", status: "unknown" as const }
  if (!main) {
    if (hasLegacyStorageRoots(opts.storage)) {
      return buildDashboardPayloadFiles({ projectRoot: opts.projectRoot, storage: opts.storage, nowMs })
    }
    return buildDashboardPayloadFiles({ projectRoot: opts.projectRoot, storage: opts.storage, nowMs })
  }

  const tasksResult = sessionId
    ? deriveBackgroundTasksSqlite({
        sqlitePath: backend.sqlitePath,
        mainSessionId: sessionId,
        nowMs,
      })
    : { ok: true as const, value: [] }
  if (!tasksResult.ok) {
    if (hasLegacyStorageRoots(opts.storage)) {
      return buildDashboardPayloadFiles({ projectRoot: opts.projectRoot, storage: opts.storage, nowMs })
    }
    return buildDashboardPayloadFiles({ projectRoot: opts.projectRoot, storage: opts.storage, nowMs })
  }

  const timeSeriesResult = deriveTimeSeriesActivitySqlite({
    sqlitePath: backend.sqlitePath,
    mainSessionId: sessionId ?? null,
    nowMs,
  })
  if (!timeSeriesResult.ok) {
    if (hasLegacyStorageRoots(opts.storage)) {
      return buildDashboardPayloadFiles({ projectRoot: opts.projectRoot, storage: opts.storage, nowMs })
    }
    return buildDashboardPayloadFiles({ projectRoot: opts.projectRoot, storage: opts.storage, nowMs })
  }

  const mainCurrentModel = main.currentModel
  const mainSessionTasks = (() => {
    if (!sessionId) return []

    const mainStatus = main.status
    const status = mainStatus === "running_tool" || mainStatus === "thinking" || mainStatus === "busy"
      ? "running"
      : mainStatus === "idle"
        ? "idle"
        : "unknown"

    const callsResult = deriveToolCallsSqlite({ sqlitePath: backend.sqlitePath, sessionId })
    if (!callsResult.ok) {
      return []
    }

    const startAt = sessionMeta?.time?.created ?? null
    const endAtMs = status === "running" ? nowMs : (main.lastUpdated ?? nowMs)

    return [
      {
        id: "main-session",
        description: "Main session",
        subline: sessionId,
        agent: main.agent,
        lastModel: mainCurrentModel,
        status,
        toolCalls: callsResult.value.toolCalls.length,
        lastTool: callsResult.value.toolCalls[0]?.tool ?? "-",
        timeline: formatTimeline(startAt, endAtMs),
        sessionId,
      },
    ]
  })()

  const tokenUsageResult = deriveTokenUsageSqlite({
    sqlitePath: backend.sqlitePath,
    mainSessionId: sessionId ?? null,
    backgroundSessionIds: tasksResult.value.map((task) => task.sessionId ?? null),
  })
  if (!tokenUsageResult.ok) {
    if (hasLegacyStorageRoots(opts.storage)) {
      return buildDashboardPayloadFiles({ projectRoot: opts.projectRoot, storage: opts.storage, nowMs })
    }
    return buildDashboardPayloadFiles({ projectRoot: opts.projectRoot, storage: opts.storage, nowMs })
  }

  const payload: DashboardPayload = {
    mainSession: {
      agent: main.agent,
      currentModel: mainCurrentModel,
      currentTool: main.currentTool ?? "-",
      lastUpdatedLabel: formatIso(main.lastUpdated),
      session: main.sessionLabel,
      sessionId: sessionId ?? null,
      statusPill: mainStatusPill(main.status),
    },
    planProgress: {
      name: planName,
      completed: plan.completed,
      total: plan.total,
      path: planPath,
      statusPill: planStatusPill(plan),
      steps: planSteps.missing ? [] : planSteps.steps,
    },
    backgroundTasks: tasksResult.value.map((t) => ({
      id: t.id,
      description: t.description,
      agent: t.agent,
      lastModel: t.lastModel ?? null,
      status: t.status,
      toolCalls: t.toolCalls ?? 0,
      lastTool: t.lastTool ?? "-",
      timeline: typeof t.timeline === "string" ? t.timeline : "",
      sessionId: t.sessionId ?? null,
    })),
    mainSessionTasks,
    timeSeries: timeSeriesResult.value,
    tokenUsage: tokenUsageResult.value,
    raw: null,
  }

  payload.raw = {
    mainSession: payload.mainSession,
    planProgress: payload.planProgress,
    backgroundTasks: payload.backgroundTasks,
    mainSessionTasks: payload.mainSessionTasks,
    timeSeries: payload.timeSeries,
  }
  return payload
}

/**
 * Build dashboard payload for a Copilot CLI session.
 */
export function buildDashboardPayloadCopilotCli(opts: {
  sessionId: string
  stateDirOverride?: string
  nowMs?: number
}): DashboardPayload {
  const nowMs = opts.nowMs ?? Date.now()
  
  // Import Copilot CLI modules
  const { readWorkspaceMetadata } = require("../ingest/copilot-cli/session")
  const { deriveMainSessionView } = require("../ingest/copilot-cli/events")
  const { deriveCopilotTasks } = require("../ingest/copilot-cli/tasks")
  
  const workspace = readWorkspaceMetadata(opts.sessionId, opts.stateDirOverride)
  const sessionLabel = workspace?.summary ?? opts.sessionId
  
  const main = deriveMainSessionView({
    sessionId: opts.sessionId,
    sessionLabel,
    stateDirOverride: opts.stateDirOverride,
    nowMs,
  })
  
  const tasks = deriveCopilotTasks({
    sessionId: opts.sessionId,
    stateDirOverride: opts.stateDirOverride,
    nowMs,
  })
  
  // Copilot CLI doesn't have plan files
  const planProgress = {
    name: "(no plan)",
    completed: 0,
    total: 0,
    path: "",
    statusPill: "not started",
    steps: [],
  }
  
  // Create main session task entry
  const mainSessionTasks = [{
    id: "main-session",
    description: "Main session",
    subline: opts.sessionId,
    agent: main.agent,
    lastModel: main.currentModel,
    status: main.status === "running_tool" || main.status === "thinking" || main.status === "busy"
      ? "running"
      : main.status === "idle"
        ? "idle"
        : "unknown",
    toolCalls: tasks.length,
    lastTool: main.currentTool ?? "-",
    timeline: formatTimeline(workspace?.created_at ?? null, nowMs),
    sessionId: opts.sessionId,
  }]
  
  // Copilot CLI doesn't track time series or token usage yet
  const timeSeries: TimeSeriesPayload = {
    windowMs: 3600000, // 1 hour
    bucketMs: 300000, // 5 minutes
    buckets: 12,
    anchorMs: nowMs,
    serverNowMs: nowMs,
    series: [],
  }
  
  const payload: DashboardPayload = {
    mainSession: {
      agent: main.agent,
      currentModel: main.currentModel,
      currentTool: main.currentTool ?? "-",
      lastUpdatedLabel: formatIso(main.lastUpdated),
      session: sessionLabel,
      sessionId: opts.sessionId,
      statusPill: mainStatusPill(main.status),
    },
    planProgress,
    backgroundTasks: tasks.map((t: BackgroundTaskRow) => ({
      id: t.id,
      description: t.description,
      agent: t.agent,
      lastModel: t.lastModel ?? null,
      status: t.status,
      toolCalls: t.toolCalls ?? 0,
      lastTool: t.lastTool ?? "-",
      timeline: t.timeline,
      sessionId: t.sessionId ?? null,
    })),
    mainSessionTasks,
    timeSeries,
    tokenUsage: undefined,
    raw: null,
  }
  
  payload.raw = {
    mainSession: payload.mainSession,
    planProgress: payload.planProgress,
    backgroundTasks: payload.backgroundTasks,
    mainSessionTasks: payload.mainSessionTasks,
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
  storageBackend?: StorageBackend
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
    const baseWatchers = [
      watchIfExists(path.join(opts.projectRoot, ".sisyphus", "boulder.json"), markDirty),
      watchIfExists(path.join(opts.projectRoot, ".sisyphus", "plans"), markDirty),
    ]
    const backendWatchers = opts.storageBackend?.kind === "sqlite"
      ? [
          watchIfExists(opts.storageBackend.sqlitePath, markDirty),
          watchIfExists(`${opts.storageBackend.sqlitePath}-wal`, markDirty),
          watchIfExists(`${opts.storageBackend.sqlitePath}-shm`, markDirty),
        ]
      : [
          watchIfExists(storage.session, markDirty),
          watchIfExists(storage.message, markDirty),
          watchIfExists(storage.part, markDirty),
        ]

    watchers.push(...[...baseWatchers, ...backendWatchers].filter(Boolean) as fs.FSWatcher[])

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
        cached = buildDashboardPayload({
          projectRoot: opts.projectRoot,
          storage,
          nowMs: now,
          storageBackend: opts.storageBackend,
        })
        lastComputedAt = now
        dirty = false
      }
      return cached
    },
  }
}
