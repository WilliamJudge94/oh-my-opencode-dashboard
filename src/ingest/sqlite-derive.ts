import type { BackgroundTaskRow } from "./background-tasks"
import { pickLatestModelString } from "./model"
import type { MainSessionView, SessionMetadata, StoredMessageMeta, StoredToolPart } from "./session"
import {
  readAllSessionMetasSqlite,
  readMainSessionMetasSqlite,
  readRecentMessageMetasSqlite,
  readSessionExistsSqlite,
  readTodosSqlite,
  readToolPartsForMessagesSqlite,
  type SqliteReadFailureReason,
  type TodoItem,
} from "./storage-backend"
import { aggregateTokenUsage } from "./token-usage-core"
import { MAX_TOOL_CALL_MESSAGES, MAX_TOOL_CALLS, type ToolCallSummaryResult } from "./tool-calls"
import type { TimeSeriesPayload, TimeSeriesSeries } from "./timeseries"

type SqliteDeriveResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: SqliteReadFailureReason }

const TASK_TOOL_NAMES = new Set(["delegate_task", "task", "call_omo_agent", "background_task"])
const DESCRIPTION_MAX = 120
const AGENT_MAX = 30
const SESSION_ID_MAX = 200
const TOKEN_USAGE_MESSAGE_LIMIT = 10_000

type CanonicalAgent = "sisyphus" | "prometheus" | "atlas" | "other"

type BackgroundSessionStats = {
  toolCalls: number
  lastTool: string | null
  lastUpdateAt: number | null
}

const SERIES_ORDER: Array<Pick<TimeSeriesSeries, "id" | "label" | "tone">> = [
  { id: "overall-main", label: "Overall", tone: "muted" },
  { id: "agent:sisyphus", label: "Sisyphus", tone: "teal" },
  { id: "agent:prometheus", label: "Prometheus", tone: "red" },
  { id: "agent:atlas", label: "Atlas", tone: "green" },
  { id: "background-total", label: "Background tasks (total)", tone: "muted" },
]

function readStartTimeFromToolPart(part: unknown): number | null {
  if (!part || typeof part !== "object") return null
  const rec = part as Record<string, unknown>
  const state = rec.state
  if (!state || typeof state !== "object") return null
  const time = (state as Record<string, unknown>).time
  if (!time || typeof time !== "object") return null
  const start = (time as Record<string, unknown>).start
  return typeof start === "number" && Number.isFinite(start) ? start : null
}

function clampString(value: unknown, maxLen: number): string | null {
  if (typeof value !== "string") return null
  const s = value.trim()
  if (!s) return null
  return s.length <= maxLen ? s : s.slice(0, maxLen)
}

function readSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null
  const s = value.trim()
  if (!s) return null
  if (s.length > SESSION_ID_MAX) return null
  if (s === "pending") return null
  return s
}

function readToolStateTitle(part: unknown): string | null {
  if (!part || typeof part !== "object") return null
  const rec = part as Record<string, unknown>
  const state = rec.state
  if (!state || typeof state !== "object") return null
  return clampString((state as Record<string, unknown>).title, DESCRIPTION_MAX)
}

function readToolStateSessionId(part: unknown): string | null {
  if (!part || typeof part !== "object") return null
  const rec = part as Record<string, unknown>
  const state = rec.state
  if (!state || typeof state !== "object") return null
  const meta = (state as Record<string, unknown>).metadata
  if (!meta || typeof meta !== "object") return null
  const m = meta as Record<string, unknown>
  return (
    readSessionId(m.sessionId) ??
    readSessionId(m.sessionID) ??
    readSessionId(m.session_id)
  )
}

function stripSessionTitlePrefix(title: string): string {
  const trimmed = title.trim()
  const stripped = trimmed.startsWith("Background: ")
    ? trimmed.slice("Background: ".length).trimStart()
    : trimmed.startsWith("Task: ")
      ? trimmed.slice("Task: ".length).trimStart()
      : trimmed
  return /^(undefined|null)(\b|\s)/i.test(stripped) ? "" : stripped
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

function isTaskTool(toolName: string): boolean {
  return TASK_TOOL_NAMES.has(toolName)
}

function deriveBackgroundStatus(opts: {
  sessionId: string | null
  stats: BackgroundSessionStats
  nowMs: number
}): BackgroundTaskRow["status"] {
  if (!opts.sessionId) return "queued"
  if (opts.stats.lastUpdateAt && opts.nowMs - opts.stats.lastUpdateAt <= 15_000) return "running"
  if (opts.stats.toolCalls > 0) return "completed"
  return "unknown"
}

function titleToFallbackAgent(title: string): string | null {
  const match = title.match(/\(@([^\s)]+) subagent\)$/)
  if (!match?.[1]) return null
  return clampString(match[1], AGENT_MAX)
}

function mapToolPartsByMessage(parts: StoredToolPart[]): Map<string, StoredToolPart[]> {
  const out = new Map<string, StoredToolPart[]>()
  for (const part of parts) {
    const list = out.get(part.messageID)
    if (list) {
      list.push(part)
    } else {
      out.set(part.messageID, [part])
    }
  }
  return out
}

function readSessionMessagesAndParts(opts: {
  sqlitePath: string
  sessionId: string
  limit: number
}): SqliteDeriveResult<{ metas: StoredMessageMeta[]; partsByMessage: Map<string, StoredToolPart[]> }> {
  const metasResult = readRecentMessageMetasSqlite({
    sqlitePath: opts.sqlitePath,
    sessionId: opts.sessionId,
    limit: opts.limit,
  })
  if (!metasResult.ok) return metasResult
  const messageIds = metasResult.rows.map((meta) => meta.id)
  const partsResult = readToolPartsForMessagesSqlite({
    sqlitePath: opts.sqlitePath,
    messageIds,
  })
  if (!partsResult.ok) return partsResult

  return {
    ok: true,
    value: {
      metas: metasResult.rows,
      partsByMessage: mapToolPartsByMessage(partsResult.rows),
    },
  }
}

function canonicalizeAgent(agent: unknown): CanonicalAgent {
  if (typeof agent !== "string") return "other"
  const trimmed = agent.trim()
  if (!trimmed) return "other"
  const lowered = trimmed.toLowerCase()
  if (lowered.startsWith("sisyphus-junior")) return "sisyphus"
  if (lowered.startsWith("sisyphus")) return "sisyphus"
  if (lowered.startsWith("prometheus")) return "prometheus"
  if (lowered.startsWith("atlas")) return "atlas"
  return "other"
}

function addToBucket(values: number[], bucketIndex: number, count: number): void {
  if (bucketIndex < 0 || bucketIndex >= values.length) return
  values[bucketIndex] += count
}

function getCreated(meta: StoredMessageMeta): number {
  const created = meta.time?.created
  return typeof created === "number" ? created : -Infinity
}

function zeroBuckets(size: number): number[] {
  return Array.from({ length: size }, () => 0)
}

function findBackgroundSessionId(opts: {
  allSessionMetas: SessionMetadata[]
  parentSessionId: string
  description: string
  subagentType?: string | null
  category?: string | null
  startedAt: number
}): string | null {
  const description = opts.description
  const subagentType = typeof opts.subagentType === "string" && opts.subagentType.trim() ? opts.subagentType.trim() : null
  const expectedTitles = [
    `Background: ${description}`,
    ...(subagentType ? [`${description} (@${subagentType} subagent)`] : []),
    `Task: ${description}`,
  ]

  const windowStart = opts.startedAt - 10_000
  const windowEnd = opts.startedAt + 15 * 60_000

  const candidates = opts.allSessionMetas.filter(
    (m) =>
      m.parentID === opts.parentSessionId &&
      m.time?.created >= windowStart &&
      m.time?.created <= windowEnd,
  )

  const exact = candidates.filter((m) => typeof m.title === "string" && expectedTitles.includes(m.title))
  const pool = exact.length > 0
    ? exact
    : candidates.filter((m) => {
        const t = typeof m.title === "string" ? m.title : ""
        if (!t) return false
        if (subagentType && t.startsWith(description) && t.includes(`@${subagentType}`)) return true
        return t.startsWith(description)
      })

  const poolFallback = pool.length > 0 ? pool : candidates
  poolFallback.sort((a, b) => {
    const at = a.time?.created ?? 0
    const bt = b.time?.created ?? 0
    const ad = Math.abs(at - opts.startedAt)
    const bd = Math.abs(bt - opts.startedAt)
    if (ad !== bd) return ad - bd
    if (bt !== at) return bt - at
    return String(a.id).localeCompare(String(b.id))
  })
  return poolFallback[0]?.id ?? null
}

function findTaskSessionId(opts: {
  allSessionMetas: SessionMetadata[]
  parentSessionId: string
  description: string
  subagentType?: string | null
  category?: string | null
  startedAt: number
}): string | null {
  const description = opts.description
  const subagentType = typeof opts.subagentType === "string" && opts.subagentType.trim() ? opts.subagentType.trim() : null
  const expectedTitles = [
    `Task: ${description}`,
    ...(subagentType ? [`${description} (@${subagentType} subagent)`] : []),
    `Background: ${description}`,
  ]

  const windowStart = opts.startedAt - 10_000
  const windowEnd = opts.startedAt + 15 * 60_000
  const candidates = opts.allSessionMetas.filter(
    (m) =>
      m.parentID === opts.parentSessionId &&
      m.time?.created >= windowStart &&
      m.time?.created <= windowEnd,
  )

  const exact = candidates.filter((m) => typeof m.title === "string" && expectedTitles.includes(m.title))
  const pool = exact.length > 0
    ? exact
    : candidates.filter((m) => {
        const t = typeof m.title === "string" ? m.title : ""
        if (!t) return false
        if (subagentType && t.startsWith(description) && t.includes(`@${subagentType}`)) return true
        return t.startsWith(description)
      })

  const poolFallback = pool.length > 0 ? pool : candidates
  poolFallback.sort((a, b) => {
    const at = a.time?.created ?? 0
    const bt = b.time?.created ?? 0
    const ad = Math.abs(at - opts.startedAt)
    const bd = Math.abs(bt - opts.startedAt)
    if (ad !== bd) return ad - bd
    if (bt !== at) return bt - at
    return String(a.id).localeCompare(String(b.id))
  })
  return poolFallback[0]?.id ?? null
}

export function pickActiveSessionIdSqlite(opts: {
  sqlitePath: string
  projectRoot: string
  boulderSessionIds?: string[]
}): SqliteDeriveResult<string | null> {
  const metasResult = readMainSessionMetasSqlite({
    sqlitePath: opts.sqlitePath,
    directoryFilter: opts.projectRoot,
  })
  if (!metasResult.ok) return metasResult

  const metas = metasResult.rows
  const metaById = new Map(metas.map((m) => [m.id, m] as const))

  let bestId: string | null = metas[0]?.id ?? null
  let bestUpdated = bestId ? (metaById.get(bestId)?.time.updated ?? -Infinity) : -Infinity
  let bestIsBoulder = false

  const consider = (candidateId: string, updatedAt: number, isBoulder: boolean): void => {
    if (!bestId) {
      bestId = candidateId
      bestUpdated = updatedAt
      bestIsBoulder = isBoulder
      return
    }
    if (updatedAt > bestUpdated) {
      bestId = candidateId
      bestUpdated = updatedAt
      bestIsBoulder = isBoulder
      return
    }
    if (updatedAt === bestUpdated && isBoulder && !bestIsBoulder) {
      bestId = candidateId
      bestUpdated = updatedAt
      bestIsBoulder = true
    }
  }

  const ids = opts.boulderSessionIds ?? []
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i]
    const messages = readRecentMessageMetasSqlite({ sqlitePath: opts.sqlitePath, sessionId: id, limit: 1 })
    if (!messages.ok) return messages
    if (messages.rows.length === 0) continue

    const meta = metaById.get(id)
    if (meta) {
      consider(id, meta.time.updated ?? meta.time.created ?? 0, true)
      continue
    }

    if (metas.length === 0) {
      const created = typeof messages.rows[0]?.time?.created === "number" ? messages.rows[0].time.created : 0
      consider(id, created, true)
    }
  }

  return { ok: true, value: bestId }
}

export function getMainSessionViewSqlite(opts: {
  sqlitePath: string
  sessionId: string
  sessionMeta?: SessionMetadata | null
  nowMs?: number
}): SqliteDeriveResult<MainSessionView> {
  const nowMs = opts.nowMs ?? Date.now()
  const session = readSessionMessagesAndParts({
    sqlitePath: opts.sqlitePath,
    sessionId: opts.sessionId,
    limit: 200,
  })
  if (!session.ok) return session

  const recent = session.value.metas[0] ?? null
  const lastUpdated = recent?.time?.created ?? null
  const sessionLabel = opts.sessionMeta?.title ?? opts.sessionId
  const agent = recent?.agent ?? "unknown"
  const currentModel = pickLatestModelString(session.value.metas)

  let activeTool: { tool: string; status: string } | null = null
  for (const meta of session.value.metas) {
    const parts = session.value.partsByMessage.get(meta.id) ?? []
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i]
      if (part.state.status === "pending" || part.state.status === "running") {
        activeTool = { tool: part.tool, status: part.state.status }
        break
      }
    }
    if (activeTool) break
  }

  let status: MainSessionView["status"] = "unknown"
  if (activeTool?.status === "pending" || activeTool?.status === "running") {
    status = "running_tool"
  } else if (recent?.role === "assistant" && typeof recent.time?.created === "number" && typeof recent.time?.completed !== "number") {
    status = "thinking"
  } else if (typeof lastUpdated === "number") {
    status = nowMs - lastUpdated <= 15_000 ? "busy" : "idle"
  }

  return {
    ok: true,
    value: {
      agent,
      currentTool: activeTool?.tool ?? null,
      currentModel,
      lastUpdated,
      sessionLabel,
      status,
    },
  }
}

export function deriveBackgroundTasksSqlite(opts: {
  sqlitePath: string
  mainSessionId: string
  nowMs?: number
}): SqliteDeriveResult<BackgroundTaskRow[]> {
  const nowMs = opts.nowMs ?? Date.now()
  const main = readSessionMessagesAndParts({
    sqlitePath: opts.sqlitePath,
    sessionId: opts.mainSessionId,
    limit: 200,
  })
  if (!main.ok) return main

  const allSessionMetasResult = readAllSessionMetasSqlite({ sqlitePath: opts.sqlitePath })
  if (!allSessionMetasResult.ok) return allSessionMetasResult
  const allSessionMetas = allSessionMetasResult.rows
  const sessionMetaById = new Map(allSessionMetas.map((m) => [m.id, m] as const))

  const backgroundMessageCache = new Map<string, StoredMessageMeta[]>()
  const backgroundPartsCache = new Map<string, Map<string, StoredToolPart[]>>()

  const readBackgroundStats = (sessionId: string): SqliteDeriveResult<BackgroundSessionStats> => {
    const background = readBackgroundSession(sessionId)
    if (!background.ok) return background

    let toolCalls = 0
    let lastTool: string | null = null
    let lastUpdateAt: number | null = null

    const statsOrdered = [...background.value.metas].sort((a, b) => {
      const at = a.time?.created ?? 0
      const bt = b.time?.created ?? 0
      if (at !== bt) return at - bt
      return String(a.id).localeCompare(String(b.id))
    })
    for (const backgroundMeta of statsOrdered) {
      const created = backgroundMeta.time?.created
      if (typeof created === "number") lastUpdateAt = created
      const backgroundParts = background.value.partsByMessage.get(backgroundMeta.id) ?? []
      for (const backgroundPart of backgroundParts) {
        toolCalls += 1
        lastTool = backgroundPart.tool
      }
    }

    return {
      ok: true,
      value: { toolCalls, lastTool, lastUpdateAt },
    }
  }

  const readBackgroundSession = (sessionId: string): SqliteDeriveResult<{ metas: StoredMessageMeta[]; partsByMessage: Map<string, StoredToolPart[]> }> => {
    const existingMetas = backgroundMessageCache.get(sessionId)
    const existingParts = backgroundPartsCache.get(sessionId)
    if (existingMetas && existingParts) {
      return { ok: true, value: { metas: existingMetas, partsByMessage: existingParts } }
    }

    const loaded = readSessionMessagesAndParts({
      sqlitePath: opts.sqlitePath,
      sessionId,
      limit: 200,
    })
    if (!loaded.ok) return loaded
    backgroundMessageCache.set(sessionId, loaded.value.metas)
    backgroundPartsCache.set(sessionId, loaded.value.partsByMessage)
    return loaded
  }

  const rows: BackgroundTaskRow[] = []
  const seenSessionIds = new Set<string>()
  const ordered = [...main.value.metas].sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0))
  for (const meta of ordered) {
    const messageCreatedAt = meta.time?.created ?? null
    if (typeof messageCreatedAt !== "number") continue
    const parts = main.value.partsByMessage.get(meta.id) ?? []

    for (const part of parts) {
      if (!isTaskTool(part.tool)) continue
      if (!part.state || typeof part.state !== "object") continue
      const input = part.state.input ?? {}
      if (typeof input !== "object" || input === null) continue

      const rec = input as Record<string, unknown>
      const runInBackground = part.tool === "background_task" ? true : rec.run_in_background
      if (runInBackground !== true && runInBackground !== false) continue

      const rawDescription = typeof rec.description === "string" ? rec.description.trim() : ""

      const subagentType = clampString(rec.subagent_type ?? rec.agent, AGENT_MAX)
      const category = clampString(rec.category, AGENT_MAX)
      const agent = subagentType ?? (category ? `sisyphus-junior (${category})` : "unknown")

      let backgroundSessionId: string | null = null
      const startedAt = readStartTimeFromToolPart(part) ?? messageCreatedAt

      backgroundSessionId = readToolStateSessionId(part)

      if (runInBackground) {
        if (!backgroundSessionId && rawDescription) {
          backgroundSessionId = findBackgroundSessionId({
            allSessionMetas,
            parentSessionId: opts.mainSessionId,
            description: rawDescription,
            subagentType,
            category,
            startedAt,
          })
        }
      } else {
        const resume = typeof rec.resume === "string" ? rec.resume.trim() : ""
        if (resume) {
          const resumed = readBackgroundSession(resume)
          if (!resumed.ok) return resumed
          if (resumed.value.metas.length > 0) backgroundSessionId = resume
        }
        if (!backgroundSessionId && rawDescription) {
          backgroundSessionId = findBackgroundSessionId({
            allSessionMetas,
            parentSessionId: opts.mainSessionId,
            description: rawDescription,
            subagentType,
            category,
            startedAt,
          })
          if (!backgroundSessionId) {
            backgroundSessionId = findTaskSessionId({
              allSessionMetas,
              parentSessionId: opts.mainSessionId,
              description: rawDescription,
              subagentType,
              category,
              startedAt,
            })
          }
        }
      }

      const description = (
        clampString(rawDescription, DESCRIPTION_MAX) ??
        readToolStateTitle(part) ??
        (() => {
          const t = sessionMetaById.get(backgroundSessionId ?? "")?.title
          if (typeof t !== "string") return null
          return clampString(stripSessionTitlePrefix(t), DESCRIPTION_MAX)
        })() ??
        (subagentType ? `${subagentType} task` : category ? `${category} task` : "Task")
      )

      const background = backgroundSessionId ? readBackgroundSession(backgroundSessionId) : null
      if (background && !background.ok) return background
      const backgroundMetas = background && background.ok ? background.value.metas : []
      const stats = backgroundSessionId
        ? readBackgroundStats(backgroundSessionId)
        : { ok: true as const, value: { toolCalls: 0, lastTool: null, lastUpdateAt: startedAt } }
      if (!stats.ok) return stats

      const lastModel = backgroundMetas.length > 0 ? pickLatestModelString(backgroundMetas) : null
      const status = deriveBackgroundStatus({
        sessionId: backgroundSessionId,
        stats: stats.value,
        nowMs,
      })

      const timelineEndMs = status === "completed" ? (stats.value.lastUpdateAt ?? nowMs) : nowMs

      if (backgroundSessionId) seenSessionIds.add(backgroundSessionId)

      rows.push({
        id: part.callID,
        description,
        agent,
        status,
        toolCalls: backgroundSessionId ? stats.value.toolCalls : null,
        lastTool: stats.value.lastTool,
        lastModel,
        timeline: status === "unknown" ? "" : formatTimeline(startedAt, timelineEndMs),
        sessionId: backgroundSessionId,
      })
    }

    if (rows.length >= 50) break
  }

  const childSessions = allSessionMetas
    .filter((meta) => meta.parentID === opts.mainSessionId)
    .sort((a, b) => {
      const at = a.time?.updated ?? 0
      const bt = b.time?.updated ?? 0
      if (bt !== at) return bt - at
      return String(a.id).localeCompare(String(b.id))
    })

  for (const child of childSessions) {
    if (rows.length >= 50) break
    if (seenSessionIds.has(child.id)) continue

    const background = readBackgroundSession(child.id)
    if (!background.ok) return background
    const stats = readBackgroundStats(child.id)
    if (!stats.ok) return stats

    const status = deriveBackgroundStatus({
      sessionId: child.id,
      stats: stats.value,
      nowMs,
    })
    if (status === "unknown" && stats.value.toolCalls <= 0) continue

    const startAt = child.time?.created ?? null
    const timelineEndMs = status === "completed" ? (stats.value.lastUpdateAt ?? nowMs) : nowMs
    const title = typeof child.title === "string" ? child.title : ""
    const description = (
      clampString(stripSessionTitlePrefix(title), DESCRIPTION_MAX) ??
      clampString(title, DESCRIPTION_MAX) ??
      "Task"
    )
    const agent = (
      titleToFallbackAgent(title) ??
      clampString(background.value.metas[0]?.agent, AGENT_MAX) ??
      "unknown"
    )

    seenSessionIds.add(child.id)
    rows.push({
      id: `session:${child.id}`,
      description,
      agent,
      status,
      toolCalls: stats.value.toolCalls,
      lastTool: stats.value.lastTool,
      lastModel: background.value.metas.length > 0 ? pickLatestModelString(background.value.metas) : null,
      timeline: status === "unknown" ? "" : formatTimeline(startAt, timelineEndMs),
      sessionId: child.id,
    })
  }

  return { ok: true, value: rows }
}

export function deriveTimeSeriesActivitySqlite(opts: {
  sqlitePath: string
  mainSessionId: string | null
  nowMs?: number
  windowMs?: number
  bucketMs?: number
}): SqliteDeriveResult<TimeSeriesPayload> {
  const windowMs = opts.windowMs ?? 300_000
  const bucketMs = opts.bucketMs ?? 2_000
  const buckets = Math.floor(windowMs / bucketMs)
  const nowMs = opts.nowMs ?? Date.now()
  const anchorMs = Math.floor(nowMs / bucketMs) * bucketMs
  const startMs = anchorMs - windowMs

  const overall = zeroBuckets(buckets)
  const sisyphus = zeroBuckets(buckets)
  const prometheus = zeroBuckets(buckets)
  const atlas = zeroBuckets(buckets)
  const background = zeroBuckets(buckets)

  const allSessionMetas = readAllSessionMetasSqlite({ sqlitePath: opts.sqlitePath })
  if (!allSessionMetas.ok) return allSessionMetas

  const perSessionCache = new Map<string, { metas: StoredMessageMeta[]; partsByMessage: Map<string, StoredToolPart[]> }>()
  const loadSession = (sessionId: string): SqliteDeriveResult<{ metas: StoredMessageMeta[]; partsByMessage: Map<string, StoredToolPart[]> }> => {
    const cached = perSessionCache.get(sessionId)
    if (cached) return { ok: true, value: cached }
    const loaded = readSessionMessagesAndParts({
      sqlitePath: opts.sqlitePath,
      sessionId,
      limit: 200,
    })
    if (!loaded.ok) return loaded
    perSessionCache.set(sessionId, loaded.value)
    return loaded
  }

  const bucketSession = (sessionId: string, includePerAgent: boolean, isBackground: boolean): SqliteDeriveResult<void> => {
    const session = loadSession(sessionId)
    if (!session.ok) return session
    const ordered = [...session.value.metas].sort((a, b) => {
      const at = getCreated(a)
      const bt = getCreated(b)
      if (bt !== at) return bt - at
      return String(a.id).localeCompare(String(b.id))
    })

    for (const meta of ordered) {
      const created = getCreated(meta)
      if (created < startMs) break
      if (created >= anchorMs) continue
      const bucketIndex = Math.floor((created - startMs) / bucketMs)
      const toolCount = (session.value.partsByMessage.get(meta.id) ?? []).length
      if (toolCount <= 0) continue
      addToBucket(overall, bucketIndex, toolCount)
      if (isBackground) {
        addToBucket(background, bucketIndex, toolCount)
      }
      if (includePerAgent) {
        const agent = canonicalizeAgent(meta.agent)
        if (agent === "sisyphus") addToBucket(sisyphus, bucketIndex, toolCount)
        if (agent === "prometheus") addToBucket(prometheus, bucketIndex, toolCount)
        if (agent === "atlas") addToBucket(atlas, bucketIndex, toolCount)
      }
    }

    return { ok: true, value: undefined }
  }

  if (opts.mainSessionId) {
    const mainResult = bucketSession(opts.mainSessionId, true, false)
    if (!mainResult.ok) return mainResult

    const childSessions = allSessionMetas.rows
      .filter((meta) => meta.parentID === opts.mainSessionId)
      .sort((a, b) => {
        const at = a.time?.updated ?? 0
        const bt = b.time?.updated ?? 0
        if (bt !== at) return bt - at
        return String(a.id).localeCompare(String(b.id))
      })
      .slice(0, 25)
      .map((meta) => meta.id)

    for (const childSessionId of childSessions) {
      const childResult = bucketSession(childSessionId, false, true)
      if (!childResult.ok) return childResult
    }
  }

  return {
    ok: true,
    value: {
      windowMs,
      bucketMs,
      buckets,
      anchorMs,
      serverNowMs: nowMs,
      series: [
        { ...SERIES_ORDER[0], values: overall },
        { ...SERIES_ORDER[1], values: sisyphus },
        { ...SERIES_ORDER[2], values: prometheus },
        { ...SERIES_ORDER[3], values: atlas },
        { ...SERIES_ORDER[4], values: background },
      ],
    },
  }
}

export function deriveTokenUsageSqlite(opts: {
  sqlitePath: string
  mainSessionId: string | null
  backgroundSessionIds?: Array<string | null | undefined>
}): SqliteDeriveResult<ReturnType<typeof aggregateTokenUsage>> {
  const sessionIds: string[] = []
  const seen = new Set<string>()
  const push = (value: unknown): void => {
    if (typeof value !== "string") return
    const id = value.trim()
    if (!id || seen.has(id)) return
    seen.add(id)
    sessionIds.push(id)
  }

  push(opts.mainSessionId)
  for (const id of opts.backgroundSessionIds ?? []) push(id)

  const metas: unknown[] = []
  for (const sessionId of sessionIds) {
    const result = readRecentMessageMetasSqlite({
      sqlitePath: opts.sqlitePath,
      sessionId,
      limit: TOKEN_USAGE_MESSAGE_LIMIT,
    })
    if (!result.ok) return result
    metas.push(...result.rows)
  }

  return {
    ok: true,
    value: aggregateTokenUsage(metas),
  }
}

export function deriveToolCallsSqlite(opts: {
  sqlitePath: string
  sessionId: string
}): SqliteDeriveResult<ToolCallSummaryResult & { sessionExists: boolean }> {
  const metasResult = readRecentMessageMetasSqlite({
    sqlitePath: opts.sqlitePath,
    sessionId: opts.sessionId,
    limit: MAX_TOOL_CALL_MESSAGES,
  })
  if (!metasResult.ok) return metasResult

  if (metasResult.rows.length === 0) {
    const existsResult = readSessionExistsSqlite({
      sqlitePath: opts.sqlitePath,
      sessionId: opts.sessionId,
    })
    if (!existsResult.ok) return existsResult
    return {
      ok: true,
      value: {
        toolCalls: [],
        truncated: false,
        sessionExists: existsResult.rows.length > 0,
      },
    }
  }

  const partsResult = readToolPartsForMessagesSqlite({
    sqlitePath: opts.sqlitePath,
    messageIds: metasResult.rows.map((meta) => meta.id),
  })
  if (!partsResult.ok) return partsResult

  const partsByMessage = mapToolPartsByMessage(partsResult.rows)
  const calls: Array<{
    sessionId: string
    messageId: string
    callId: string
    tool: string
    status: "pending" | "running" | "completed" | "error" | "unknown"
    createdAtMs: number | null
    createdSortKey: number
  }> = []

  for (const meta of metasResult.rows) {
    const createdAtMs = typeof meta.time?.created === "number" ? meta.time.created : null
    const createdSortKey = createdAtMs ?? -Infinity
    const parts = partsByMessage.get(meta.id) ?? []
    for (const part of parts) {
      calls.push({
        sessionId: opts.sessionId,
        messageId: meta.id,
        callId: part.callID,
        tool: part.tool,
        status: part.state.status,
        createdAtMs,
        createdSortKey,
      })
    }
  }

  const truncatedByMessages = metasResult.rows.length >= MAX_TOOL_CALL_MESSAGES
  const truncatedByCalls = calls.length > MAX_TOOL_CALLS
  const toolCalls = calls
    .sort((a, b) => {
      if (a.createdSortKey !== b.createdSortKey) return b.createdSortKey - a.createdSortKey
      const messageCompare = String(a.messageId).localeCompare(String(b.messageId))
      if (messageCompare !== 0) return messageCompare
      return String(a.callId).localeCompare(String(b.callId))
    })
    .slice(0, MAX_TOOL_CALLS)
    .map(({ createdSortKey, ...row }) => row)

  return {
    ok: true,
    value: {
      toolCalls,
      truncated: truncatedByMessages || truncatedByCalls,
      sessionExists: true,
    },
  }
}

export function deriveTodosSqlite(opts: {
  sqlitePath: string
  sessionId: string
}): SqliteDeriveResult<TodoItem[]> {
  const result = readTodosSqlite({
    sqlitePath: opts.sqlitePath,
    sessionId: opts.sessionId,
  })
  if (!result.ok) return result

  return {
    ok: true,
    value: result.rows,
  }
}
