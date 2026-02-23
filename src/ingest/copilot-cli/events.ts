import * as fs from "node:fs"
import * as path from "node:path"
import { getSessionDir } from "./paths"
import type { MainSessionView } from "../session"

/**
 * Threshold in milliseconds to consider a session as "busy" vs "idle"
 */
const BUSY_THRESHOLD_MS = 15_000 // 15 seconds

/**
 * Copilot CLI event types from events.jsonl
 */
export type CopilotEvent = {
  type: string
  timestamp?: number
  data?: Record<string, unknown>
}

export type CopilotToolExecutionStart = {
  type: "tool.execution_start"
  timestamp: number
  data: {
    tool_name: string
    call_id: string
    input?: Record<string, unknown>
  }
}

export type CopilotToolExecutionComplete = {
  type: "tool.execution_complete"
  timestamp: number
  data: {
    tool_name: string
    call_id: string
    success: boolean
    output?: unknown
  }
}

export type CopilotAssistantMessage = {
  type: "assistant.message"
  timestamp: number
  data: {
    content?: string
    model?: string
  }
}

/**
 * Read and parse events.jsonl from a Copilot CLI session directory.
 */
export function readEvents(sessionId: string, stateDirOverride?: string): CopilotEvent[] {
  const sessionDir = getSessionDir(sessionId, stateDirOverride)
  const eventsPath = path.join(sessionDir, "events.jsonl")
  
  if (!fs.existsSync(eventsPath)) {
    return []
  }
  
  try {
    const content = fs.readFileSync(eventsPath, "utf8")
    const lines = content.split("\n").filter(line => line.trim())
    const events: CopilotEvent[] = []
    
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as CopilotEvent
        events.push(event)
      } catch {
        // Skip malformed lines
        continue
      }
    }
    
    return events
  } catch {
    return []
  }
}

/**
 * Derive MainSessionView from Copilot CLI events.
 */
export function deriveMainSessionView(opts: {
  sessionId: string
  sessionLabel?: string
  stateDirOverride?: string
  nowMs?: number
}): MainSessionView {
  const nowMs = opts.nowMs ?? Date.now()
  const events = readEvents(opts.sessionId, opts.stateDirOverride)
  
  // Default values
  let agent = "copilot-cli"
  let currentTool: string | null = null
  let currentModel: string | null = null
  let lastUpdated: number | null = null
  let status: MainSessionView["status"] = "unknown"
  
  // Track active tool calls (started but not completed)
  const activeToolCalls = new Map<string, { tool: string; timestamp: number }>()
  
  // Process events in order
  for (const event of events) {
    const timestamp = event.timestamp ?? 0
    if (timestamp > 0) {
      lastUpdated = timestamp
    }
    
    // Track tool executions
    if (event.type === "tool.execution_start") {
      const startEvent = event as CopilotToolExecutionStart
      const callId = startEvent.data?.call_id
      const toolName = startEvent.data?.tool_name
      if (callId && toolName) {
        activeToolCalls.set(callId, { tool: toolName, timestamp })
      }
    } else if (event.type === "tool.execution_complete") {
      const completeEvent = event as CopilotToolExecutionComplete
      const callId = completeEvent.data?.call_id
      if (callId) {
        activeToolCalls.delete(callId)
      }
    } else if (event.type === "assistant.message") {
      const msgEvent = event as CopilotAssistantMessage
      if (msgEvent.data?.model) {
        currentModel = msgEvent.data.model
      }
    }
  }
  
  // Find the most recent active tool
  let mostRecentTool: { tool: string; timestamp: number } | null = null
  for (const [, toolInfo] of activeToolCalls) {
    if (!mostRecentTool || toolInfo.timestamp > mostRecentTool.timestamp) {
      mostRecentTool = toolInfo
    }
  }
  
  if (mostRecentTool) {
    currentTool = mostRecentTool.tool
  }
  
  // Determine status
  if (activeToolCalls.size > 0) {
    status = "running_tool"
  } else if (lastUpdated && nowMs - lastUpdated <= BUSY_THRESHOLD_MS) {
    status = "busy"
  } else if (lastUpdated) {
    status = "idle"
  }
  
  return {
    agent,
    currentTool,
    currentModel,
    lastUpdated,
    sessionLabel: opts.sessionLabel ?? opts.sessionId,
    status,
  }
}
