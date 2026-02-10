import * as fs from "node:fs"
import * as path from "node:path"
import type { OpenCodeStorageRoots, SessionMetadata, StoredMessageMeta, StoredToolPart } from "./session"
import { getMessageDir } from "./session"
import { pickLatestModelString } from "./model"

type FsLike = Pick<typeof fs, "readFileSync" | "readdirSync" | "existsSync" | "statSync"> 

export type BackgroundTaskRow = {
  id: string
  description: string
  agent: string
  status: "queued" | "running" | "completed" | "error" | "unknown"
  toolCalls: number | null
  lastTool: string | null
  lastModel: string | null
  timeline: string
  sessionId: string | null
}

const DESCRIPTION_MAX = 120
const AGENT_MAX = 30

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

function readJsonFile<T>(filePath: string, fsLike: FsLike): T | null {
  try {
    const content = fsLike.readFileSync(filePath, "utf8")
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

function listJsonFiles(dir: string, fsLike: FsLike): string[] {
  try {
    return fsLike.readdirSync(dir).filter((f) => f.endsWith(".json"))
  } catch {
    return []
  }
}

function readToolPartsForMessage(storage: OpenCodeStorageRoots, messageID: string, fsLike: FsLike): StoredToolPart[] {
  const partDir = path.join(storage.part, messageID)
  if (!fsLike.existsSync(partDir)) return []

  const files = listJsonFiles(partDir, fsLike).sort()
  const parts: StoredToolPart[] = []
  for (const f of files) {
    const p = readJsonFile<StoredToolPart>(path.join(partDir, f), fsLike)
    if (p && p.type === "tool" && typeof p.tool === "string" && p.state && typeof p.state === "object") {
      parts.push(p)
    }
  }
  return parts
}

function readRecentMessageMetas(messageDir: string, maxMessages: number, fsLike: FsLike): StoredMessageMeta[] {
  if (!messageDir || !fsLike.existsSync(messageDir)) return []
  const files = listJsonFiles(messageDir, fsLike)
    .map((f) => ({
      f,
      mtime: (() => {
        try {
          return fsLike.statSync(path.join(messageDir, f)).mtimeMs
        } catch {
          return 0
        }
      })(),
    }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, maxMessages)

  const metas: StoredMessageMeta[] = []
  for (const item of files) {
    const meta = readJsonFile<StoredMessageMeta>(path.join(messageDir, item.f), fsLike)
    if (meta && typeof meta.id === "string") metas.push(meta)
  }
  return metas
}

export function readAllSessionMetas(sessionStorage: string, fsLike: FsLike = fs): SessionMetadata[] {
  if (!fsLike.existsSync(sessionStorage)) return []
  const metas: SessionMetadata[] = []
  try {
    const projectDirs = fsLike.readdirSync(sessionStorage, { withFileTypes: true })
    for (const d of projectDirs) {
      if (!d.isDirectory()) continue
      const projectPath = path.join(sessionStorage, d.name)
      for (const file of listJsonFiles(projectPath, fsLike)) {
        const meta = readJsonFile<SessionMetadata>(path.join(projectPath, file), fsLike)
        if (meta && typeof meta.id === "string") metas.push(meta)
      }
    }
  } catch {
    return []
  }
  return metas
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
  const category = typeof opts.category === "string" && opts.category.trim() ? opts.category.trim() : null

  // OpenCode/oh-my-opencode session title formats have changed over time.
  // Prefer exact matches, but allow safe fallbacks within a bounded time window.
  const expectedTitles = [
    // Legacy
    `Background: ${description}`,
    // Current (observed): "<description> (@<subagent> subagent)"
    ...(subagentType ? [`${description} (@${subagentType} subagent)`] : []),
    // Best-effort fallback (older sync style can leak into bg)
    `Task: ${description}`,
  ]

  const windowStart = opts.startedAt - 10_000
  // Background tasks can remain queued before a child session is created.
  const windowEnd = opts.startedAt + 15 * 60_000

  const candidates = opts.allSessionMetas.filter(
    (m) =>
      m.parentID === opts.parentSessionId &&
      m.time?.created >= windowStart &&
      m.time?.created <= windowEnd
  )

  // Prefer exact title matches (most precise).
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

  // Deterministic tie-breaking: max by time.created, then lexicographic id
  poolFallback.sort((a, b) => {
    const at = a.time?.created ?? 0
    const bt = b.time?.created ?? 0

    // Prefer the closest session to the tool start time (covers long queue delays).
    const ad = Math.abs(at - opts.startedAt)
    const bd = Math.abs(bt - opts.startedAt)
    if (ad !== bd) return ad - bd

    // Then prefer newer.
    if (bt !== at) return bt - at

    // Finally stable by id.
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
  const category = typeof opts.category === "string" && opts.category.trim() ? opts.category.trim() : null

  const expectedTitles = [
    // Legacy
    `Task: ${description}`,
    // Current (observed): "<description> (@<subagent> subagent)"
    ...(subagentType ? [`${description} (@${subagentType} subagent)`] : []),
    // Best-effort fallback
    `Background: ${description}`,
  ]

  const windowStart = opts.startedAt - 10_000
  const windowEnd = opts.startedAt + 15 * 60_000

  const candidates = opts.allSessionMetas.filter(
    (m) =>
      m.parentID === opts.parentSessionId &&
      m.time?.created >= windowStart &&
      m.time?.created <= windowEnd
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

function deriveBackgroundSessionStats(
  storage: OpenCodeStorageRoots,
  metas: StoredMessageMeta[],
  fsLike: FsLike
): { toolCalls: number; lastTool: string | null; lastUpdateAt: number | null } {
  let toolCalls = 0
  let lastTool: string | null = null
  let lastUpdateAt: number | null = null

  // Deterministic ordering by time.created then id.
  const ordered = [...metas].sort((a, b) => {
    const at = a.time?.created ?? 0
    const bt = b.time?.created ?? 0
    if (at !== bt) return at - bt
    return String(a.id).localeCompare(String(b.id))
  })

  for (const meta of ordered) {
    const created = meta.time?.created
    if (typeof created === "number") lastUpdateAt = created
    const parts = readToolPartsForMessage(storage, meta.id, fsLike)
    for (const p of parts) {
      toolCalls += 1
      lastTool = p.tool
    }
  }

  return { toolCalls, lastTool, lastUpdateAt }
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

const TASK_TOOL_NAMES = new Set(["delegate_task", "task"])

function isTaskTool(toolName: string): boolean {
  return TASK_TOOL_NAMES.has(toolName)
}

export function deriveBackgroundTasks(opts: {
  storage: OpenCodeStorageRoots
  mainSessionId: string
  nowMs?: number
  fs?: FsLike
}): BackgroundTaskRow[] {
  const fsLike: FsLike = opts.fs ?? fs
  const nowMs = opts.nowMs ?? Date.now()
  const messageDir = getMessageDir(opts.storage.message, opts.mainSessionId)
  const metas = readRecentMessageMetas(messageDir, 200, fsLike)
  const allSessionMetas = readAllSessionMetas(opts.storage.session, fsLike)
  const backgroundMessageCache = new Map<string, StoredMessageMeta[]>()
  const backgroundStatsCache = new Map<string, { toolCalls: number; lastTool: string | null; lastUpdateAt: number | null }>()
  const backgroundModelCache = new Map<string, string | null>()

  const readBackgroundMetas = (sessionId: string): StoredMessageMeta[] => {
    const cached = backgroundMessageCache.get(sessionId)
    if (cached) return cached
    const backgroundMessageDir = getMessageDir(opts.storage.message, sessionId)
    const recent = readRecentMessageMetas(backgroundMessageDir, 200, fsLike)
    backgroundMessageCache.set(sessionId, recent)
    return recent
  }

  const readBackgroundStats = (sessionId: string) => {
    const cached = backgroundStatsCache.get(sessionId)
    if (cached) return cached
    const recent = readBackgroundMetas(sessionId)
    const stats = deriveBackgroundSessionStats(opts.storage, recent, fsLike)
    backgroundStatsCache.set(sessionId, stats)
    return stats
  }

  const readBackgroundModel = (sessionId: string): string | null => {
    if (backgroundModelCache.has(sessionId)) return backgroundModelCache.get(sessionId) ?? null
    const recent = readBackgroundMetas(sessionId)
    const model = pickLatestModelString(recent as unknown[])
    backgroundModelCache.set(sessionId, model)
    return model
  }

  const rows: BackgroundTaskRow[] = []

  // Iterate newest-first to cap list and keep latest tasks.
  const ordered = [...metas].sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0))
  for (const meta of ordered) {
    const messageCreatedAt = meta.time?.created ?? null
    if (typeof messageCreatedAt !== "number") continue

    const parts = readToolPartsForMessage(opts.storage, meta.id, fsLike)
    for (const part of parts) {
      if (!isTaskTool(part.tool)) continue
      if (!part.state || typeof part.state !== "object") continue

      const input = part.state.input ?? {}
      if (typeof input !== "object" || input === null) continue

      const runInBackground = (input as Record<string, unknown>).run_in_background
      if (runInBackground !== true && runInBackground !== false) continue

      const rawDescription = (() => {
        const v = (input as Record<string, unknown>).description
        if (typeof v !== "string") return null
        const s = v.trim()
        return s.length > 0 ? s : null
      })()
      if (!rawDescription) continue

      const description = clampString(rawDescription, DESCRIPTION_MAX)
      if (!description) continue

      const subagentType = clampString((input as Record<string, unknown>).subagent_type, AGENT_MAX)
      const category = clampString((input as Record<string, unknown>).category, AGENT_MAX)
      const agent = subagentType ?? (category ? `sisyphus-junior (${category})` : "unknown")

      let backgroundSessionId: string | null = null

      // Use tool-call start time when available; message meta created can be much earlier.
      const startedAt = readStartTimeFromToolPart(part) ?? messageCreatedAt
      
      if (runInBackground) {
        backgroundSessionId = findBackgroundSessionId({
          allSessionMetas,
          parentSessionId: opts.mainSessionId,
          description: rawDescription,
          subagentType,
          category,
          startedAt,
        })
      } else {
        // For sync tasks, check if resume is specified
        const resume = (input as Record<string, unknown>).resume
        if (typeof resume === "string" && resume.trim() !== "") {
          // Check if resumed session exists (has readable messages dir)
          const resumeMessageDir = getMessageDir(opts.storage.message, resume.trim())
          if (fsLike.existsSync(resumeMessageDir) && fsLike.readdirSync(resumeMessageDir).length > 0) {
            backgroundSessionId = resume.trim()
          }
        }
        
        if (!backgroundSessionId) {
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

      const stats = backgroundSessionId
        ? readBackgroundStats(backgroundSessionId)
        : { toolCalls: 0, lastTool: null, lastUpdateAt: startedAt }
      const lastModel = backgroundSessionId ? readBackgroundModel(backgroundSessionId) : null

      // Best-effort status: if background session exists and has any tool calls, treat as running unless idle.
      let status: BackgroundTaskRow["status"] = "unknown"
      if (!backgroundSessionId) {
        status = "queued"
      } else if (stats.lastUpdateAt && nowMs - stats.lastUpdateAt <= 15_000) {
        status = "running"
      } else if (stats.toolCalls > 0) {
        status = "completed"
      }

      const timelineEndMs = status === "completed" ? (stats.lastUpdateAt ?? nowMs) : nowMs

      rows.push({
        id: part.callID,
        description,
        agent,
        status,
        toolCalls: backgroundSessionId ? stats.toolCalls : null,
        lastTool: stats.lastTool,
        lastModel,
        timeline: status === "unknown" ? "" : formatTimeline(startedAt, timelineEndMs),
        sessionId: backgroundSessionId,
      })
    }

    if (rows.length >= 50) break
  }

  return rows
}
