import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"
import { describe, expect, it } from "vitest"
import { deriveToolCalls, MAX_TOOL_CALL_MESSAGES, MAX_TOOL_CALLS } from "./tool-calls"
import { getStorageRoots } from "./session"

function mkStorageRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omo-storage-"))
  fs.mkdirSync(path.join(root, "session"), { recursive: true })
  fs.mkdirSync(path.join(root, "message"), { recursive: true })
  fs.mkdirSync(path.join(root, "part"), { recursive: true })
  return root
}

function writeMessageMeta(opts: {
  storageRoot: string
  sessionId: string
  messageId: string
  created?: number
}): void {
  const storage = getStorageRoots(opts.storageRoot)
  const msgDir = path.join(storage.message, opts.sessionId)
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
  const storage = getStorageRoots(opts.storageRoot)
  const partDir = path.join(storage.part, opts.messageId)
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

function hasBannedKeys(value: unknown, banned: Set<string>): boolean {
  if (!value || typeof value !== "object") return false
  if (Array.isArray(value)) {
    return value.some((item) => hasBannedKeys(item, banned))
  }
  for (const [key, child] of Object.entries(value)) {
    if (banned.has(key)) return true
    if (hasBannedKeys(child, banned)) return true
  }
  return false
}

describe("deriveToolCalls", () => {
  it("orders tool calls deterministically and sorts null timestamps last", () => {
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const sessionId = "ses_main"

    writeMessageMeta({ storageRoot, sessionId, messageId: "msg_0", created: 500 })
    writeToolPart({ storageRoot, sessionId, messageId: "msg_0", callId: "call_a", tool: "read" })

    writeMessageMeta({ storageRoot, sessionId, messageId: "msg_1", created: 1000 })
    writeToolPart({ storageRoot, sessionId, messageId: "msg_1", callId: "call_a", tool: "bash" })

    writeMessageMeta({ storageRoot, sessionId, messageId: "msg_2", created: 1000 })
    writeToolPart({ storageRoot, sessionId, messageId: "msg_2", callId: "call_b", tool: "grep" })
    writeToolPart({ storageRoot, sessionId, messageId: "msg_2", callId: "call_a", tool: "grep" })

    writeMessageMeta({ storageRoot, sessionId, messageId: "msg_3" })
    writeToolPart({ storageRoot, sessionId, messageId: "msg_3", callId: "call_z", tool: "read" })

    const result = deriveToolCalls({ storage, sessionId })
    expect(result.toolCalls.map((row) => `${row.messageId}:${row.callId}`)).toEqual([
      "msg_1:call_a",
      "msg_2:call_a",
      "msg_2:call_b",
      "msg_0:call_a",
      "msg_3:call_z",
    ])
    expect(result.toolCalls[0].createdAtMs).toBe(1000)
    expect(result.toolCalls[4].createdAtMs).toBe(null)
    expect(result.truncated).toBe(false)
  })

  it("caps message scan and tool call output", () => {
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const sessionId = "ses_main"

    const totalMessages = MAX_TOOL_CALL_MESSAGES + 5
    for (let i = 0; i < totalMessages; i += 1) {
      const suffix = String(i).padStart(3, "0")
      const messageId = `msg_${suffix}`
      writeMessageMeta({ storageRoot, sessionId, messageId, created: i })
      writeToolPart({ storageRoot, sessionId, messageId, callId: `call_${suffix}_a`, tool: "bash" })
      writeToolPart({ storageRoot, sessionId, messageId, callId: `call_${suffix}_b`, tool: "read" })
    }

    const result = deriveToolCalls({ storage, sessionId })
    expect(result.toolCalls.length).toBe(MAX_TOOL_CALLS)
    expect(result.truncated).toBe(true)

    const messageIds = new Set(result.toolCalls.map((row) => row.messageId))
    for (let i = 0; i < 5; i += 1) {
      const suffix = String(i).padStart(3, "0")
      expect(messageIds.has(`msg_${suffix}`)).toBe(false)
    }
    for (let i = totalMessages - 5; i < totalMessages; i += 1) {
      const suffix = String(i).padStart(3, "0")
      expect(messageIds.has(`msg_${suffix}`)).toBe(true)
    }
  })

  it("redacts tool call payload fields", () => {
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const sessionId = "ses_main"

    writeMessageMeta({ storageRoot, sessionId, messageId: "msg_1", created: 1000 })
    writeToolPart({
      storageRoot,
      sessionId,
      messageId: "msg_1",
      callId: "call_secret",
      tool: "bash",
      state: {
        status: "completed",
        input: { prompt: "SECRET", nested: { output: "HIDDEN" } },
        output: "NOPE",
        error: "NOPE",
      },
    })

    const result = deriveToolCalls({ storage, sessionId })
    expect(result.toolCalls.length).toBe(1)

    const banned = new Set(["prompt", "input", "output", "error", "state"])
    expect(hasBannedKeys(result.toolCalls[0], banned)).toBe(false)
  })
})
