import { Hono } from "hono"
import type { DashboardStore } from "./dashboard"
import { assertAllowedPath } from "../ingest/paths"
import { getMessageDir, getStorageRoots } from "../ingest/session"
import { deriveToolCalls, MAX_TOOL_CALL_MESSAGES, MAX_TOOL_CALLS } from "../ingest/tool-calls"

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export function createApi(opts: { store: DashboardStore; storageRoot: string }): Hono {
  const api = new Hono()

  api.get("/health", (c) => {
    return c.json({ ok: true })
  })

  api.get("/dashboard", (c) => {
    return c.json(opts.store.getSnapshot())
  })

  api.get("/tool-calls/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId")
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return c.json({ ok: false, sessionId, toolCalls: [] }, 400)
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
