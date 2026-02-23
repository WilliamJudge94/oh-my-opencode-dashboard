import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { deriveCopilotTasks } from "./tasks"

describe("copilot-cli tasks", () => {
  it("deriveCopilotTasks returns empty array for non-existent session", () => {
    const nonExistentDir = path.join(os.tmpdir(), "nonexistent-copilot-state")
    const result = deriveCopilotTasks({
      sessionId: "test-session",
      stateDirOverride: nonExistentDir,
    })
    expect(result).toEqual([])
  })

  it("deriveCopilotTasks extracts task tool calls", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-test-"))
    const sessionId = "test-session-123"
    const sessionDir = path.join(tmpDir, sessionId)
    fs.mkdirSync(sessionDir, { recursive: true })

    const eventsContent = `{"type":"tool.execution_start","timestamp":1000,"data":{"tool_name":"task","call_id":"task-1","input":{"description":"Run tests","agent_type":"test-agent"}}}
{"type":"tool.execution_complete","timestamp":2000,"data":{"tool_name":"task","call_id":"task-1","success":true}}
{"type":"tool.execution_start","timestamp":3000,"data":{"tool_name":"task","call_id":"task-2","input":{"description":"Build project","agent_type":"build-agent"}}}
`
    fs.writeFileSync(path.join(sessionDir, "events.jsonl"), eventsContent, "utf8")

    const result = deriveCopilotTasks({
      sessionId,
      stateDirOverride: tmpDir,
      nowMs: 5000,
    })
    
    expect(result).toHaveLength(2)
    
    // Tasks are sorted by start time (newest first)
    expect(result[0]?.description).toBe("Build project")
    expect(result[0]?.agent).toBe("build-agent")
    expect(result[0]?.status).toBe("running")
    
    expect(result[1]?.description).toBe("Run tests")
    expect(result[1]?.agent).toBe("test-agent")
    expect(result[1]?.status).toBe("completed")

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true })
  })

  it("deriveCopilotTasks handles task errors", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-test-"))
    const sessionId = "test-session-123"
    const sessionDir = path.join(tmpDir, sessionId)
    fs.mkdirSync(sessionDir, { recursive: true })

    const eventsContent = `{"type":"tool.execution_start","timestamp":1000,"data":{"tool_name":"task","call_id":"task-1","input":{"description":"Failing task","agent_type":"test-agent"}}}
{"type":"tool.execution_complete","timestamp":2000,"data":{"tool_name":"task","call_id":"task-1","success":false}}
`
    fs.writeFileSync(path.join(sessionDir, "events.jsonl"), eventsContent, "utf8")

    const result = deriveCopilotTasks({
      sessionId,
      stateDirOverride: tmpDir,
      nowMs: 5000,
    })
    
    expect(result).toHaveLength(1)
    expect(result[0]?.status).toBe("error")

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true })
  })
})
