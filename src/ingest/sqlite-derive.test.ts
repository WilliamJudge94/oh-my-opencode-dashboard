import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Database as BunDatabase } from "bun:sqlite"
import { describe, expect, it } from "vitest"
import {
  deriveBackgroundTasksSqlite,
  deriveTimeSeriesActivitySqlite,
  deriveTokenUsageSqlite,
  deriveToolCallsSqlite,
  getMainSessionViewSqlite,
  pickActiveSessionIdSqlite,
} from "./sqlite-derive"

function mkTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function mkSqliteDb(): string {
  const root = mkTmpDir("omo-dashboard-sqlite-derive-")
  const sqlitePath = path.join(root, "opencode.db")
  const db = new BunDatabase(sqlitePath)
  db.run("CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)")
  db.run("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
  db.run("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
  db.close()
  return sqlitePath
}

function insertSession(db: BunDatabase, opts: {
  id: string
  directory: string
  projectID?: string
  parentID?: string | null
  title?: string
  created?: number
  updated?: number
}): void {
  db.run(
    "INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [opts.id, opts.projectID ?? "proj", opts.parentID ?? null, opts.directory, opts.title ?? null, opts.created ?? 0, opts.updated ?? opts.created ?? 0],
  )
}

function insertMessage(db: BunDatabase, opts: {
  id: string
  sessionId: string
  created: number
  role?: "assistant" | "user"
  agent?: string
  providerID?: string
  modelID?: string
  tokens?: Record<string, unknown>
}): void {
  const data: Record<string, unknown> = {
    id: opts.id,
    sessionID: opts.sessionId,
    role: opts.role ?? "assistant",
    time: { created: opts.created },
  }
  if (opts.agent) data.agent = opts.agent
  if (opts.providerID) data.providerID = opts.providerID
  if (opts.modelID) data.modelID = opts.modelID
  if (opts.tokens) data.tokens = opts.tokens
  db.run(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    [opts.id, opts.sessionId, opts.created, opts.created, JSON.stringify(data)],
  )
}

function insertToolPart(db: BunDatabase, opts: {
  id: string
  messageId: string
  sessionId: string
  callID: string
  tool: string
  status: "pending" | "running" | "completed" | "error"
  input?: Record<string, unknown>
  stateTitle?: string
  stateMeta?: Record<string, unknown>
  created?: number
  startTime?: number
}): void {
  const state: Record<string, unknown> = {
    status: opts.status,
    input: opts.input ?? {},
  }
  if (typeof opts.stateTitle === "string") {
    state.title = opts.stateTitle
  }
  if (opts.stateMeta && typeof opts.stateMeta === "object") {
    state.metadata = opts.stateMeta
  }
  if (typeof opts.startTime === "number") {
    state.time = { start: opts.startTime }
  }
  db.run(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
    [
      opts.id,
      opts.messageId,
      opts.sessionId,
      opts.created ?? 0,
      opts.created ?? 0,
      JSON.stringify({
        id: opts.id,
        messageID: opts.messageId,
        sessionID: opts.sessionId,
        type: "tool",
        callID: opts.callID,
        tool: opts.tool,
        state,
      }),
    ],
  )
}

describe("sqlite derive helpers", () => {
  it("deriveToolCallsSqlite returns tool + status from part state", () => {
    const sqlitePath = mkSqliteDb()
    const db = new BunDatabase(sqlitePath)
    insertSession(db, { id: "ses_main", directory: "/repo" })
    insertMessage(db, { id: "msg_a", sessionId: "ses_main", created: 1000 })
    insertToolPart(db, {
      id: "part_a",
      messageId: "msg_a",
      sessionId: "ses_main",
      callID: "call_a",
      tool: "bash",
      status: "running",
      input: { command: "pwd" },
      created: 1000,
    })
    insertMessage(db, { id: "msg_b", sessionId: "ses_main", created: 900 })
    insertToolPart(db, {
      id: "part_b",
      messageId: "msg_b",
      sessionId: "ses_main",
      callID: "call_b",
      tool: "glob",
      status: "error",
      input: { pattern: "*.ts" },
      created: 900,
    })
    db.close()

    const result = deriveToolCallsSqlite({ sqlitePath, sessionId: "ses_main" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.toolCalls.map((row) => [row.tool, row.status])).toEqual([
      ["bash", "running"],
      ["glob", "error"],
    ])
  })

  it("deriveTokenUsageSqlite aggregates provider/model token totals from message metadata", () => {
    const sqlitePath = mkSqliteDb()
    const db = new BunDatabase(sqlitePath)
    insertSession(db, { id: "ses_main", directory: "/repo" })
    insertSession(db, { id: "ses_bg", directory: "/repo", parentID: "ses_main" })
    insertMessage(db, {
      id: "msg_main_a",
      sessionId: "ses_main",
      created: 1000,
      role: "assistant",
      providerID: "openai",
      modelID: "gpt-5.3",
      tokens: { input: 3, output: 2, reasoning: 1, cache: { read: 0, write: 0 } },
    })
    insertMessage(db, {
      id: "msg_bg_a",
      sessionId: "ses_bg",
      created: 1100,
      role: "assistant",
      providerID: "openai",
      modelID: "gpt-5.3",
      tokens: { input: 4, output: 1, reasoning: 0, cache: { read: 2, write: 0 } },
    })
    insertMessage(db, {
      id: "msg_bg_b",
      sessionId: "ses_bg",
      created: 1200,
      role: "assistant",
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
      tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 1, write: 1 } },
    })
    insertMessage(db, {
      id: "msg_user",
      sessionId: "ses_main",
      created: 1300,
      role: "user",
      providerID: "openai",
      modelID: "gpt-5.3",
      tokens: { input: 999, output: 999, reasoning: 999, cache: { read: 999, write: 999 } },
    })
    db.close()

    const result = deriveTokenUsageSqlite({
      sqlitePath,
      mainSessionId: "ses_main",
      backgroundSessionIds: ["ses_bg"],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.rows).toEqual([
      {
        model: "openai/gpt-5.3",
        input: 7,
        output: 3,
        reasoning: 1,
        cacheRead: 2,
        cacheWrite: 0,
        total: 13,
      },
      {
        model: "anthropic/claude-sonnet-4-5",
        input: 2,
        output: 3,
        reasoning: 0,
        cacheRead: 1,
        cacheWrite: 1,
        total: 7,
      },
    ])
  })

  it("getMainSessionViewSqlite returns currentModel when provider/model metadata exists", () => {
    const sqlitePath = mkSqliteDb()
    const db = new BunDatabase(sqlitePath)
    insertSession(db, { id: "ses_main", directory: "/repo", title: "Main" })
    insertMessage(db, {
      id: "msg_a",
      sessionId: "ses_main",
      created: 1_000,
      role: "assistant",
      providerID: "openai",
      modelID: "gpt-5.3",
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    db.close()

    const result = getMainSessionViewSqlite({ sqlitePath, sessionId: "ses_main" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.currentModel).toBe("openai/gpt-5.3")
  })

  it("deriveTimeSeriesActivitySqlite increments buckets by tool-part count", () => {
    const sqlitePath = mkSqliteDb()
    const db = new BunDatabase(sqlitePath)
    insertSession(db, { id: "ses_main", directory: "/repo" })
    insertMessage(db, { id: "msg_a", sessionId: "ses_main", created: 1_000, agent: "Sisyphus" })
    insertToolPart(db, {
      id: "part_a_1",
      messageId: "msg_a",
      sessionId: "ses_main",
      callID: "call_a_1",
      tool: "read",
      status: "completed",
      created: 1_000,
    })
    insertToolPart(db, {
      id: "part_a_2",
      messageId: "msg_a",
      sessionId: "ses_main",
      callID: "call_a_2",
      tool: "grep",
      status: "completed",
      created: 1_001,
    })
    insertMessage(db, { id: "msg_b", sessionId: "ses_main", created: 2_500, agent: "Prometheus" })
    insertToolPart(db, {
      id: "part_b_1",
      messageId: "msg_b",
      sessionId: "ses_main",
      callID: "call_b_1",
      tool: "bash",
      status: "completed",
      created: 2_500,
    })
    db.close()

    const result = deriveTimeSeriesActivitySqlite({
      sqlitePath,
      mainSessionId: "ses_main",
      nowMs: 10_000,
      windowMs: 10_000,
      bucketMs: 2_000,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const overall = result.value.series.find((s) => s.id === "overall-main")
    const sisyphus = result.value.series.find((s) => s.id === "agent:sisyphus")
    const prometheus = result.value.series.find((s) => s.id === "agent:prometheus")
    expect(overall?.values).toEqual([2, 1, 0, 0, 0])
    expect(sisyphus?.values).toEqual([2, 0, 0, 0, 0])
    expect(prometheus?.values).toEqual([0, 1, 0, 0, 0])
  })

  it.each(["delegate_task", "task"])(
    "deriveBackgroundTasksSqlite returns description + agent for %s parts",
    (taskToolName) => {
      const sqlitePath = mkSqliteDb()
      const db = new BunDatabase(sqlitePath)
      insertSession(db, { id: "ses_main", directory: "/repo", created: 500, updated: 500 })
      insertMessage(db, { id: "msg_main", sessionId: "ses_main", created: 1000 })
      insertToolPart(db, {
        id: "part_task",
        messageId: "msg_main",
        sessionId: "ses_main",
        callID: "call_task",
        tool: taskToolName,
        status: "completed",
        input: {
          run_in_background: false,
          description: "Index docs",
          subagent_type: "explore",
        },
        created: 1000,
        startTime: 1000,
      })
      db.close()

      const result = deriveBackgroundTasksSqlite({
        sqlitePath,
        mainSessionId: "ses_main",
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value).toHaveLength(1)
      expect(result.value[0]).toMatchObject({
        id: "call_task",
        description: "Index docs",
        agent: "explore",
      })
    },
  )

  it("deriveBackgroundTasksSqlite includes rows when description is missing but state.metadata.sessionId is present", () => {
    const sqlitePath = mkSqliteDb()
    const db = new BunDatabase(sqlitePath)
    insertSession(db, { id: "ses_main", directory: "/repo", created: 500, updated: 500 })
    insertMessage(db, { id: "msg_main", sessionId: "ses_main", created: 1000 })
    insertToolPart(db, {
      id: "part_task",
      messageId: "msg_main",
      sessionId: "ses_main",
      callID: "call_task",
      tool: "task",
      status: "completed",
      input: {
        run_in_background: true,
        subagent_type: "explore",
      },
      stateMeta: {
        sessionId: "ses_child",
      },
      created: 1000,
      startTime: 1000,
    })
    insertSession(db, {
      id: "ses_child",
      directory: "/repo",
      parentID: "ses_main",
      title: "Docs on session APIs (@explore subagent)",
      created: 1100,
      updated: 1100,
    })
    db.close()

    const result = deriveBackgroundTasksSqlite({
      sqlitePath,
      mainSessionId: "ses_main",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(1)
    expect(result.value[0]).toMatchObject({
      id: "call_task",
      sessionId: "ses_child",
      description: "Docs on session APIs (@explore subagent)",
      agent: "explore",
    })
  })

  it("pickActiveSessionIdSqlite prefers newest main session metadata over a stale boulder session_id", () => {
    const sqlitePath = mkSqliteDb()
    const db = new BunDatabase(sqlitePath)
    insertSession(db, { id: "ses_project_latest", directory: "/repo", created: 10, updated: 5000 })
    insertSession(db, { id: "ses_boulder", directory: "/repo", created: 20, updated: 100 })
    insertMessage(db, { id: "msg_latest", sessionId: "ses_project_latest", created: 5000 })
    insertMessage(db, { id: "msg_boulder", sessionId: "ses_boulder", created: 100 })
    db.close()

    const result = pickActiveSessionIdSqlite({
      sqlitePath,
      projectRoot: "/repo",
      boulderSessionIds: ["ses_missing", "ses_boulder"],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe("ses_project_latest")
  })

  it("pickActiveSessionIdSqlite prefers a boulder session_id when it is most recent", () => {
    const sqlitePath = mkSqliteDb()
    const db = new BunDatabase(sqlitePath)
    insertSession(db, { id: "ses_project_latest", directory: "/repo", created: 10, updated: 5000 })
    insertSession(db, { id: "ses_boulder", directory: "/repo", created: 20, updated: 6000 })
    insertMessage(db, { id: "msg_latest", sessionId: "ses_project_latest", created: 5000 })
    insertMessage(db, { id: "msg_boulder", sessionId: "ses_boulder", created: 6000 })
    db.close()

    const result = pickActiveSessionIdSqlite({
      sqlitePath,
      projectRoot: "/repo",
      boulderSessionIds: ["ses_boulder"],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe("ses_boulder")
  })

  it("deriveBackgroundTasksSqlite adds a fallback row when the launch message is outside the 200-message scan window", () => {
    const sqlitePath = mkSqliteDb()
    const db = new BunDatabase(sqlitePath)
    insertSession(db, { id: "ses_main", directory: "/repo", created: 0, updated: 500 })

    for (let i = 0; i < 205; i++) {
      insertMessage(db, {
        id: `msg_${String(i).padStart(3, "0")}`,
        sessionId: "ses_main",
        created: i + 1,
      })
    }
    insertToolPart(db, {
      id: "part_old",
      messageId: "msg_000",
      sessionId: "ses_main",
      callID: "call_old",
      tool: "delegate_task",
      status: "completed",
      input: {
        run_in_background: true,
        description: "Old sqlite background launch",
        subagent_type: "explore",
      },
      created: 1,
      startTime: 1,
    })

    insertSession(db, {
      id: "ses_child",
      directory: "/repo",
      parentID: "ses_main",
      title: "Old sqlite background launch (@explore subagent)",
      created: 50,
      updated: 1000,
    })
    insertMessage(db, {
      id: "msg_child",
      sessionId: "ses_child",
      created: 990,
      agent: "explore",
      providerID: "openai",
      modelID: "gpt-5.4",
    })
    insertToolPart(db, {
      id: "part_child",
      messageId: "msg_child",
      sessionId: "ses_child",
      callID: "call_child",
      tool: "grep",
      status: "completed",
      created: 990,
    })
    db.close()

    const result = deriveBackgroundTasksSqlite({
      sqlitePath,
      mainSessionId: "ses_main",
      nowMs: 30_000,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(1)
    expect(result.value[0]).toMatchObject({
      id: "session:ses_child",
      description: "Old sqlite background launch (@explore subagent)",
      agent: "explore",
      sessionId: "ses_child",
      toolCalls: 1,
      lastTool: "grep",
      lastModel: "openai/gpt-5.4",
      status: "completed",
    })
  })

  it("deriveBackgroundTasksSqlite does not duplicate a linked child session when fallback synthesis runs", () => {
    const sqlitePath = mkSqliteDb()
    const db = new BunDatabase(sqlitePath)
    insertSession(db, { id: "ses_main", directory: "/repo", created: 0, updated: 500 })
    insertMessage(db, { id: "msg_main", sessionId: "ses_main", created: 1000 })
    insertToolPart(db, {
      id: "part_main",
      messageId: "msg_main",
      sessionId: "ses_main",
      callID: "call_main",
      tool: "delegate_task",
      status: "completed",
      input: {
        run_in_background: true,
        description: "Linked sqlite task",
        subagent_type: "explore",
      },
      created: 1000,
      startTime: 1000,
    })
    insertSession(db, {
      id: "ses_child",
      directory: "/repo",
      parentID: "ses_main",
      title: "Linked sqlite task (@explore subagent)",
      created: 1100,
      updated: 1100,
    })
    insertMessage(db, { id: "msg_child", sessionId: "ses_child", created: 1200 })
    insertToolPart(db, {
      id: "part_child",
      messageId: "msg_child",
      sessionId: "ses_child",
      callID: "call_child",
      tool: "read",
      status: "completed",
      created: 1200,
    })
    db.close()

    const result = deriveBackgroundTasksSqlite({
      sqlitePath,
      mainSessionId: "ses_main",
      nowMs: 30_000,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(1)
    expect(result.value[0]).toMatchObject({
      id: "call_main",
      sessionId: "ses_child",
    })
  })
})
