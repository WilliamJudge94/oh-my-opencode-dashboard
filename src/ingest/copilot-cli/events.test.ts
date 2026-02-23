import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { readEvents, deriveMainSessionView } from "./events"

describe("copilot-cli events", () => {
  it("readEvents returns empty array for non-existent session", () => {
    const nonExistentDir = path.join(os.tmpdir(), "nonexistent-copilot-state")
    const result = readEvents("test-session", nonExistentDir)
    expect(result).toEqual([])
  })

  it("readEvents parses JSONL correctly", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-test-"))
    const sessionId = "test-session-123"
    const sessionDir = path.join(tmpDir, sessionId)
    fs.mkdirSync(sessionDir, { recursive: true })

    const eventsContent = `{"type":"session.start","timestamp":1000}
{"type":"tool.execution_start","timestamp":2000,"data":{"tool_name":"bash","call_id":"call-1"}}
{"type":"tool.execution_complete","timestamp":3000,"data":{"tool_name":"bash","call_id":"call-1","success":true}}
`
    fs.writeFileSync(path.join(sessionDir, "events.jsonl"), eventsContent, "utf8")

    const result = readEvents(sessionId, tmpDir)
    
    expect(result).toHaveLength(3)
    expect(result[0]?.type).toBe("session.start")
    expect(result[1]?.type).toBe("tool.execution_start")
    expect(result[2]?.type).toBe("tool.execution_complete")

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true })
  })

  it("deriveMainSessionView returns correct status for idle session", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-test-"))
    const sessionId = "test-session-123"
    const sessionDir = path.join(tmpDir, sessionId)
    fs.mkdirSync(sessionDir, { recursive: true })

    const eventsContent = `{"type":"session.start","timestamp":1000}
`
    fs.writeFileSync(path.join(sessionDir, "events.jsonl"), eventsContent, "utf8")

    const result = deriveMainSessionView({
      sessionId,
      stateDirOverride: tmpDir,
      nowMs: 20000, // Far in the future
    })
    
    expect(result.agent).toBe("copilot-cli")
    expect(result.status).toBe("idle")
    expect(result.currentTool).toBeNull()

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true })
  })

  it("deriveMainSessionView detects active tool", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-test-"))
    const sessionId = "test-session-123"
    const sessionDir = path.join(tmpDir, sessionId)
    fs.mkdirSync(sessionDir, { recursive: true })

    const eventsContent = `{"type":"tool.execution_start","timestamp":2000,"data":{"tool_name":"bash","call_id":"call-1"}}
`
    fs.writeFileSync(path.join(sessionDir, "events.jsonl"), eventsContent, "utf8")

    const result = deriveMainSessionView({
      sessionId,
      stateDirOverride: tmpDir,
      nowMs: 3000,
    })
    
    expect(result.status).toBe("running_tool")
    expect(result.currentTool).toBe("bash")

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true })
  })
})
