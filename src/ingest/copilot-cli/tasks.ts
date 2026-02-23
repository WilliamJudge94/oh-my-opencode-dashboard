import type { BackgroundTaskRow } from "../background-tasks"
import { readEvents, type CopilotToolExecutionStart, type CopilotToolExecutionComplete } from "./events"

/**
 * Derive BackgroundTaskRow[] from Copilot CLI task tool execution events.
 */
export function deriveCopilotTasks(opts: {
  sessionId: string
  stateDirOverride?: string
  nowMs?: number
}): BackgroundTaskRow[] {
  const nowMs = opts.nowMs ?? Date.now()
  const events = readEvents(opts.sessionId, opts.stateDirOverride)
  
  // Map call_id to task information
  const taskMap = new Map<string, {
    description: string
    agent: string
    status: BackgroundTaskRow["status"]
    startTime: number
    endTime: number | null
    model: string | null
  }>()
  
  // Process events to track task tool calls
  for (const event of events) {
    if (event.type === "tool.execution_start") {
      const startEvent = event as CopilotToolExecutionStart
      const callId = startEvent.data?.call_id
      const toolName = startEvent.data?.tool_name
      
      // Only track "task" tool calls
      if (callId && toolName === "task") {
        const input = startEvent.data?.input ?? {}
        const description = typeof input.description === "string" 
          ? input.description.slice(0, 120).trim()
          : "Task"
        
        const agentType = typeof input.agent_type === "string"
          ? input.agent_type.slice(0, 30).trim()
          : "unknown"
        
        taskMap.set(callId, {
          description,
          agent: agentType,
          status: "running",
          startTime: startEvent.timestamp ?? 0,
          endTime: null,
          model: null,
        })
      }
    } else if (event.type === "tool.execution_complete") {
      const completeEvent = event as CopilotToolExecutionComplete
      const callId = completeEvent.data?.call_id
      
      if (callId && taskMap.has(callId)) {
        const task = taskMap.get(callId)!
        task.endTime = completeEvent.timestamp ?? 0
        task.status = completeEvent.data?.success === true ? "completed" : "error"
      }
    }
  }
  
  // Convert to BackgroundTaskRow format
  const rows: BackgroundTaskRow[] = []
  
  for (const [callId, task] of taskMap) {
    const timeline = formatTimeline(task.startTime, task.endTime ?? nowMs)
    
    rows.push({
      id: callId,
      description: task.description,
      agent: task.agent,
      status: task.status,
      toolCalls: null, // Not tracked for Copilot CLI yet
      lastTool: null,
      lastModel: task.model,
      timeline,
      sessionId: null, // Sub-agents don't create separate sessions in Copilot CLI
    })
  }
  
  // Sort by start time (newest first)
  return rows.sort((a, b) => {
    const aStart = taskMap.get(a.id)?.startTime ?? 0
    const bStart = taskMap.get(b.id)?.startTime ?? 0
    return bStart - aStart
  })
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

function formatTimeline(startAt: number, endAtMs: number): string {
  if (!startAt) return ""
  const start = formatIsoNoMs(startAt)
  const elapsed = formatElapsed(endAtMs - startAt)
  return `${start}: ${elapsed}`
}
