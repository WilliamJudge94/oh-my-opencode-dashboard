import { Hono } from "hono"
import * as path from "node:path"
import type { DashboardStore } from "./dashboard"
import { buildDashboardPayloadCopilotCli } from "./dashboard"
import { assertAllowedPath } from "../ingest/paths"
import { getMessageDir, getStorageRoots } from "../ingest/session"
import { deriveToolCalls, MAX_TOOL_CALL_MESSAGES, MAX_TOOL_CALLS } from "../ingest/tool-calls"
import { getDefaultSourceId, getSourceById, listSources } from "../ingest/sources-registry"
import type { StorageBackend } from "../ingest/storage-backend"
import { deriveToolCallsSqlite } from "../ingest/sqlite-derive"

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

type SourceStoreResolver = (opts: { sourceId: string; projectRoot: string }) => DashboardStore

export function createApi(opts: {
  store: DashboardStore
  storageRoot: string
  projectRoot: string
  storageBackend?: StorageBackend
  getStoreForSource?: SourceStoreResolver
}): Hono {
  const api = new Hono()

  api.get("/health", (c) => {
    return c.json({ ok: true })
  })

  api.get("/sources", (c) => {
    const sources = listSources(opts.storageRoot)
    const defaultSourceId = sources[0]?.id ?? null
    return c.json({ ok: true, sources, defaultSourceId })
  })

  api.get("/dashboard", (c) => {
    const sourceId = c.req.query("sourceId")?.trim()
    if (sourceId) {
      const source = getSourceById(opts.storageRoot, sourceId)
      if (!source) {
        return c.json({ ok: false, sourceId }, 400)
      }
      
      // Route by source kind
      if (source.kind === "copilot-cli") {
        const payload = buildDashboardPayloadCopilotCli({
          sessionId: source.projectRoot, // For Copilot CLI, projectRoot is the sessionId
          nowMs: Date.now(),
        })
        return c.json(payload)
      }
      
      // Default to OpenCode handling
      const store = opts.getStoreForSource
        ? opts.getStoreForSource({ sourceId, projectRoot: source.projectRoot })
        : opts.store
      return c.json(store.getSnapshot())
    }

    const defaultSourceId = getDefaultSourceId(opts.storageRoot)
    if (defaultSourceId) {
      const source = getSourceById(opts.storageRoot, defaultSourceId)
      if (source) {
        // Route by source kind
        if (source.kind === "copilot-cli") {
          const payload = buildDashboardPayloadCopilotCli({
            sessionId: source.projectRoot, // For Copilot CLI, projectRoot is the sessionId
            nowMs: Date.now(),
          })
          return c.json(payload)
        }
        
        const store = opts.getStoreForSource
          ? opts.getStoreForSource({ sourceId: defaultSourceId, projectRoot: source.projectRoot })
          : opts.store
        return c.json(store.getSnapshot())
      }
    }

    return c.json(opts.store.getSnapshot())
  })

  api.get("/tool-calls/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId")
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return c.json({ ok: false, sessionId, toolCalls: [] }, 400)
    }

    const sqliteBackend = opts.storageBackend?.kind === "sqlite"
      ? opts.storageBackend
      : null
    if (sqliteBackend) {
      assertAllowedPath({
        candidatePath: sqliteBackend.sqlitePath,
        allowedRoots: [sqliteBackend.sqlitePath, path.dirname(sqliteBackend.sqlitePath)],
      })

      const sqliteResult = deriveToolCallsSqlite({
        sqlitePath: sqliteBackend.sqlitePath,
        sessionId,
      })
      if (sqliteResult.ok) {
        if (!sqliteResult.value.sessionExists) {
          return c.json({ ok: false, sessionId, toolCalls: [] }, 404)
        }
        return c.json({
          ok: true,
          sessionId,
          toolCalls: sqliteResult.value.toolCalls,
          caps: {
            maxMessages: MAX_TOOL_CALL_MESSAGES,
            maxToolCalls: MAX_TOOL_CALLS,
          },
          truncated: sqliteResult.value.truncated,
        })
      }
    }

    const storage = getStorageRoots(opts.storageRoot)
    const messageDir = getMessageDir(storage.message, sessionId)
    if (!messageDir) {
      return c.json({ ok: false, sessionId, toolCalls: [] }, 404)
    }

    assertAllowedPath({ candidatePath: messageDir, allowedRoots: [opts.storageRoot] })

    const { toolCalls, truncated } = deriveToolCalls({
      storage,
      sessionId,
      allowedRoots: [opts.storageRoot],
    })

    return c.json({
      ok: true,
      sessionId,
      toolCalls,
      caps: {
        maxMessages: MAX_TOOL_CALL_MESSAGES,
        maxToolCalls: MAX_TOOL_CALLS,
      },
      truncated,
    })
  })

  return api
}
