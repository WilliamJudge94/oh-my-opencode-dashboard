import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, it, expect, vi } from "vitest"
import { createApi } from "./api"
import type { DashboardPayload, DashboardStore } from "./dashboard"
import type { PlanStep } from "../ingest/boulder"
import { addOrUpdateSource } from "../ingest/sources-registry"

function mkStorageRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omo-dashboard-storage-"))
  fs.mkdirSync(path.join(root, "session"), { recursive: true })
  fs.mkdirSync(path.join(root, "message"), { recursive: true })
  fs.mkdirSync(path.join(root, "part"), { recursive: true })
  return root
}

function mkProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omo-dashboard-project-"))
}

function writeMessageMeta(opts: {
  storageRoot: string
  sessionId: string
  messageId: string
  created?: number
}): void {
  const msgDir = path.join(opts.storageRoot, "message", opts.sessionId)
  fs.mkdirSync(msgDir, { recursive: true })
  const meta: Record<string, unknown> = {
    id: opts.messageId,
    sessionID: opts.sessionId,
    role: "assistant",
  }
  if (typeof opts.created === "number") {
    meta.time = { created: opts.created }
  }
  fs.writeFileSync(path.join(msgDir, `${opts.messageId}.json`), JSON.stringify(meta), "utf8")
}

function writeToolPart(opts: {
  storageRoot: string
  sessionId: string
  messageId: string
  callId: string
  tool: string
  state?: Record<string, unknown>
}): void {
  const partDir = path.join(opts.storageRoot, "part", opts.messageId)
  fs.mkdirSync(partDir, { recursive: true })
  fs.writeFileSync(
    path.join(partDir, `${opts.callId}.json`),
    JSON.stringify({
      id: `part_${opts.callId}`,
      sessionID: opts.sessionId,
      messageID: opts.messageId,
      type: "tool",
      callID: opts.callId,
      tool: opts.tool,
      state: opts.state ?? { status: "completed", input: {} },
    }),
    "utf8"
  )
}

const sensitiveKeys = ["prompt", "input", "output", "error", "state"]

function hasSensitiveKeys(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  if (Array.isArray(value)) {
    return value.some((item) => hasSensitiveKeys(item))
  }
  for (const [key, child] of Object.entries(value)) {
    if (sensitiveKeys.includes(key)) return true
    if (hasSensitiveKeys(child)) return true
  }
  return false
}

function hasKey(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object") return false
  if (Array.isArray(value)) {
    return value.some((item) => hasKey(item, key))
  }
  for (const [entryKey, child] of Object.entries(value)) {
    if (entryKey === key) return true
    if (hasKey(child, key)) return true
  }
  return false
}

const createStore = (): DashboardStore => ({
  getSnapshot: (): DashboardPayload => ({
    mainSession: {
      agent: "x",
      currentModel: null,
      currentTool: "-",
      lastUpdatedLabel: "never",
      session: "s",
      sessionId: null,
      statusPill: "idle",
    },
    planProgress: { name: "p", completed: 0, total: 0, path: "", statusPill: "not started", steps: [] as PlanStep[] },
    backgroundTasks: [],
    mainSessionTasks: [],
    timeSeries: {
      windowMs: 0,
      bucketMs: 0,
      buckets: 0,
      anchorMs: 0,
      serverNowMs: 0,
      series: [{ id: "overall-main", label: "Overall", tone: "muted" as const, values: [] as number[] }],
    },
    raw: null,
  }),
} satisfies DashboardStore)

const createStoreWithSessionId = (sessionId: string): DashboardStore => {
  const base = createStore().getSnapshot()
  return {
    getSnapshot: () => ({
      ...base,
      mainSession: {
        ...base.mainSession,
        sessionId,
      },
    }),
  }
}

describe('API Routes', () => {
  it('should return health check', async () => {
    const storageRoot = mkStorageRoot()
    const projectRoot = mkProjectRoot()
    const store = createStore()
    const api = createApi({ store, storageRoot, projectRoot })

    const res = await api.request("/health")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('should return dashboard data without sensitive keys', async () => {
    const storageRoot = mkStorageRoot()
    const projectRoot = mkProjectRoot()
    const store = createStore()
    const api = createApi({ store, storageRoot, projectRoot })

    const res = await api.request("/dashboard")
    expect(res.status).toBe(200)
    
    const data = await res.json()
    
    expect(data).toHaveProperty("mainSession")
    expect(data).toHaveProperty("planProgress")
    expect(data).toHaveProperty("backgroundTasks")
    expect(data).toHaveProperty("timeSeries")
    expect(data).toHaveProperty("raw")
    
    expect(hasSensitiveKeys(data)).toBe(false)
  })

  it('should return sources list without project roots', async () => {
    const storageRoot = mkStorageRoot()
    const projectRoot = mkProjectRoot()

    const now = vi.spyOn(Date, "now")
    let firstId: string
    let secondId: string
    try {
      now.mockReturnValueOnce(Date.parse("2024-01-01T00:00:00Z"))
      firstId = addOrUpdateSource(storageRoot, { projectRoot: mkProjectRoot(), label: "Alpha" })

      now.mockReturnValueOnce(Date.parse("2024-01-02T00:00:00Z"))
      secondId = addOrUpdateSource(storageRoot, { projectRoot: mkProjectRoot(), label: "Beta" })
    } finally {
      now.mockRestore()
    }

    const store = createStore()
    const api = createApi({ store, storageRoot, projectRoot })

    const res = await api.request("/sources")
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(data.defaultSourceId).toBe(secondId)
    expect(data.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstId, label: "Alpha" }),
      expect.objectContaining({ id: secondId, label: "Beta" }),
    ]))
    expect(hasKey(data, "projectRoot")).toBe(false)
  })

  it('should return dashboard data for selected source', async () => {
    const storageRoot = mkStorageRoot()
    const projectRoot = mkProjectRoot()
    const sourceProjectA = mkProjectRoot()
    const sourceProjectB = mkProjectRoot()
    const sourceA = addOrUpdateSource(storageRoot, { projectRoot: sourceProjectA, label: "A" })
    const sourceB = addOrUpdateSource(storageRoot, { projectRoot: sourceProjectB, label: "B" })

    const storeMap = new Map<string, DashboardStore>([
      [sourceA, createStoreWithSessionId("ses_a")],
      [sourceB, createStoreWithSessionId("ses_b")],
    ])

    const api = createApi({
      store: createStoreWithSessionId("ses_default"),
      storageRoot,
      projectRoot,
      getStoreForSource: ({ sourceId }) => storeMap.get(sourceId) ?? createStoreWithSessionId("ses_missing"),
    })

    const resA = await api.request(`/dashboard?sourceId=${sourceA}`)
    expect(resA.status).toBe(200)
    expect((await resA.json()).mainSession.sessionId).toBe("ses_a")

    const resB = await api.request(`/dashboard?sourceId=${sourceB}`)
    expect(resB.status).toBe(200)
    expect((await resB.json()).mainSession.sessionId).toBe("ses_b")
  })

  it('should return 400 for unknown sources', async () => {
    const storageRoot = mkStorageRoot()
    const projectRoot = mkProjectRoot()
    const store = createStore()
    const api = createApi({ store, storageRoot, projectRoot })

    const res = await api.request("/dashboard?sourceId=unknown")
    expect(res.status).toBe(400)
    expect((await res.json()).ok).toBe(false)
  })

  it('should use default source when sourceId is missing', async () => {
    const storageRoot = mkStorageRoot()
    const projectRoot = mkProjectRoot()
    const firstRoot = mkProjectRoot()
    const secondRoot = mkProjectRoot()

    const now = vi.spyOn(Date, "now")
    let firstId: string
    let secondId: string
    try {
      now.mockReturnValueOnce(Date.parse("2024-01-01T00:00:00Z"))
      firstId = addOrUpdateSource(storageRoot, { projectRoot: firstRoot, label: "First" })

      now.mockReturnValueOnce(Date.parse("2024-01-02T00:00:00Z"))
      secondId = addOrUpdateSource(storageRoot, { projectRoot: secondRoot, label: "Second" })
    } finally {
      now.mockRestore()
    }

    const storeMap = new Map<string, DashboardStore>([
      [firstId, createStoreWithSessionId("ses_first")],
      [secondId, createStoreWithSessionId("ses_second")],
    ])

    const api = createApi({
      store: createStoreWithSessionId("ses_fallback"),
      storageRoot,
      projectRoot,
      getStoreForSource: ({ sourceId }) => storeMap.get(sourceId) ?? createStoreWithSessionId("ses_missing"),
    })

    const res = await api.request("/dashboard")
    expect(res.status).toBe(200)
    expect((await res.json()).mainSession.sessionId).toBe("ses_second")
  })

  it('should reject invalid session IDs', async () => {
    const storageRoot = mkStorageRoot()
    const projectRoot = mkProjectRoot()
    const store = createStore()
    const api = createApi({ store, storageRoot, projectRoot })

    const res = await api.request("/tool-calls/not_valid!")
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, sessionId: "not_valid!", toolCalls: [] })
  })

  it('should return 404 for missing sessions', async () => {
    const storageRoot = mkStorageRoot()
    const projectRoot = mkProjectRoot()
    const store = createStore()
    const api = createApi({ store, storageRoot, projectRoot })

    const res = await api.request("/tool-calls/ses_missing")
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, sessionId: "ses_missing", toolCalls: [] })
  })

  it('should return empty tool calls for existing sessions', async () => {
    const storageRoot = mkStorageRoot()
    const projectRoot = mkProjectRoot()
    writeMessageMeta({ storageRoot, sessionId: "ses_empty", messageId: "msg_1", created: 1000 })
    const store = createStore()
    const api = createApi({ store, storageRoot, projectRoot })

    const res = await api.request("/tool-calls/ses_empty")
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(data.sessionId).toBe("ses_empty")
    expect(data.toolCalls).toEqual([])
    expect(data.caps).toEqual({ maxMessages: 200, maxToolCalls: 300 })
    expect(data.truncated).toBe(false)
    expect(hasSensitiveKeys(data)).toBe(false)
  })

  it('should redact tool call payload fields', async () => {
    const storageRoot = mkStorageRoot()
    const projectRoot = mkProjectRoot()
    writeMessageMeta({ storageRoot, sessionId: "ses_redact", messageId: "msg_1", created: 1000 })
    writeToolPart({
      storageRoot,
      sessionId: "ses_redact",
      messageId: "msg_1",
      callId: "call_1",
      tool: "bash",
      state: {
        status: "completed",
        input: { prompt: "SECRET", nested: { output: "HIDDEN" } },
        output: "NOPE",
        error: "NOPE",
      },
    })
    const store = createStore()
    const api = createApi({ store, storageRoot, projectRoot })

    const res = await api.request("/tool-calls/ses_redact")
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(data.toolCalls.length).toBe(1)
    expect(hasSensitiveKeys(data)).toBe(false)
  })

  // /sessions was intentionally removed along with the manual session picker.
})
