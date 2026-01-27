import * as fs from "node:fs"
import * as path from "node:path"
import type { OpenCodeStorageRoots, StoredMessageMeta } from "./session"
import { getMessageDir } from "./session"
import { assertAllowedPath } from "./paths"

type FsLike = Pick<typeof fs, "readFileSync" | "readdirSync" | "existsSync" | "statSync">

export const MAX_TOOL_CALL_MESSAGES = 200
export const MAX_TOOL_CALLS = 300

export type ToolCallSummary = {
  sessionId: string
  messageId: string
  callId: string
  tool: string
  status: "pending" | "running" | "completed" | "error" | "unknown"
  createdAtMs: number | null
}

export type ToolCallSummaryResult = {
  toolCalls: ToolCallSummary[]
  truncated: boolean
}

type StoredToolPartMeta = {
  type?: string
  callID?: string
  tool?: string
  state?: { status?: string }
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

function readRecentMessageMetas(
  messageDir: string,
  maxMessages: number,
  fsLike: FsLike
): { metas: StoredMessageMeta[]; totalMessages: number } {
  if (!messageDir || !fsLike.existsSync(messageDir)) return { metas: [], totalMessages: 0 }
  const files = listJsonFiles(messageDir, fsLike)
  const ranked = files
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
  for (const item of ranked) {
    const meta = readJsonFile<StoredMessageMeta>(path.join(messageDir, item.f), fsLike)
    if (meta && typeof meta.id === "string") metas.push(meta)
  }
  return { metas, totalMessages: files.length }
}

function readToolPartsForMessage(
  partStorage: string,
  messageId: string,
  fsLike: FsLike,
  allowedRoots?: string[]
): StoredToolPartMeta[] {
  const partDir = path.join(partStorage, messageId)
  if (allowedRoots && allowedRoots.length > 0) {
    assertAllowedPath({ candidatePath: partDir, allowedRoots })
  }
  if (!fsLike.existsSync(partDir)) return []

  const files = listJsonFiles(partDir, fsLike).sort()
  const parts: StoredToolPartMeta[] = []
  for (const file of files) {
    const part = readJsonFile<StoredToolPartMeta>(path.join(partDir, file), fsLike)
    if (part && part.type === "tool" && typeof part.tool === "string" && typeof part.callID === "string") {
      parts.push(part)
    }
  }
  return parts
}

function readStatus(value: StoredToolPartMeta["state"]): ToolCallSummary["status"] {
  const status = value?.status
  if (status === "pending" || status === "running" || status === "completed" || status === "error") {
    return status
  }
  return "unknown"
}

export function deriveToolCalls(opts: {
  storage: OpenCodeStorageRoots
  sessionId: string
  fs?: FsLike
  allowedRoots?: string[]
}): ToolCallSummaryResult {
  const fsLike: FsLike = opts.fs ?? fs
  const messageDir = getMessageDir(opts.storage.message, opts.sessionId)
  if (messageDir && opts.allowedRoots && opts.allowedRoots.length > 0) {
    assertAllowedPath({ candidatePath: messageDir, allowedRoots: opts.allowedRoots })
  }
  const { metas, totalMessages } = readRecentMessageMetas(messageDir, MAX_TOOL_CALL_MESSAGES, fsLike)
  const truncatedByMessages = totalMessages > MAX_TOOL_CALL_MESSAGES

  const calls: Array<ToolCallSummary & { createdSortKey: number }> = []
  for (const meta of metas) {
    const createdAtMs = typeof meta.time?.created === "number" ? meta.time.created : null
    const createdSortKey = createdAtMs ?? Infinity
    const parts = readToolPartsForMessage(opts.storage.part, meta.id, fsLike, opts.allowedRoots)
    for (const part of parts) {
      calls.push({
        sessionId: opts.sessionId,
        messageId: meta.id,
        callId: part.callID ?? "",
        tool: part.tool ?? "",
        status: readStatus(part.state),
        createdAtMs,
        createdSortKey,
      })
    }
  }

  const truncatedByCalls = calls.length > MAX_TOOL_CALLS
  const toolCalls = calls
    .sort((a, b) => {
      if (a.createdSortKey !== b.createdSortKey) return a.createdSortKey - b.createdSortKey
      const messageCompare = String(a.messageId).localeCompare(String(b.messageId))
      if (messageCompare !== 0) return messageCompare
      return String(a.callId).localeCompare(String(b.callId))
    })
    .slice(0, MAX_TOOL_CALLS)
    .map(({ createdSortKey, ...row }) => row)

  return {
    toolCalls,
    truncated: truncatedByMessages || truncatedByCalls,
  }
}
