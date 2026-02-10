import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { deriveBackgroundTasks } from "./background-tasks"
import { getStorageRoots } from "./session"

function mkStorageRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omo-storage-"))
  fs.mkdirSync(path.join(root, "session"), { recursive: true })
  fs.mkdirSync(path.join(root, "message"), { recursive: true })
  fs.mkdirSync(path.join(root, "part"), { recursive: true })
  return root
}

describe("deriveBackgroundTasks", () => {
  it("correlates background session using tool-call start time (not message created time)", () => {
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const mainSessionId = "ses_main"

    const msgDir = path.join(storage.message, mainSessionId)
    fs.mkdirSync(msgDir, { recursive: true })
    const messageID = "msg_1"
    fs.writeFileSync(
      path.join(msgDir, `${messageID}.json`),
      JSON.stringify({
        id: messageID,
        sessionID: mainSessionId,
        role: "assistant",
        time: { created: 1000 },
      }),
      "utf8"
    )

    // Tool part starts much later than message created.
    const partDir = path.join(storage.part, messageID)
    fs.mkdirSync(partDir, { recursive: true })
    fs.writeFileSync(
      path.join(partDir, "part_1.json"),
      JSON.stringify({
        id: "part_1",
        sessionID: mainSessionId,
        messageID,
        type: "tool",
        callID: "call_1",
        tool: "delegate_task",
        state: {
          status: "completed",
          input: {
            run_in_background: true,
            description: "Late-start background",
            subagent_type: "explore",
          },
          time: { start: 200_000, end: 200_010 },
        },
      }),
      "utf8"
    )

    const projectID = "proj"
    const sessDir = path.join(storage.session, projectID)
    fs.mkdirSync(sessDir, { recursive: true })
    fs.writeFileSync(
      path.join(sessDir, "ses_child.json"),
      JSON.stringify({
        id: "ses_child",
        projectID,
        directory: "/tmp/project",
        title: "Background: Late-start background",
        parentID: mainSessionId,
        time: { created: 200_030, updated: 200_030 },
      }),
      "utf8"
    )

    const rows = deriveBackgroundTasks({ storage, mainSessionId })
    expect(rows.length).toBe(1)
    expect(rows[0].sessionId).toBe("ses_child")
  })

  it("correlates background session even when description is truncated for UI", () => {
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const mainSessionId = "ses_main"

    const msgDir = path.join(storage.message, mainSessionId)
    fs.mkdirSync(msgDir, { recursive: true })
    const messageID = "msg_1"
    fs.writeFileSync(
      path.join(msgDir, `${messageID}.json`),
      JSON.stringify({
        id: messageID,
        sessionID: mainSessionId,
        role: "assistant",
        time: { created: 1000 },
      }),
      "utf8"
    )

    const longDescription = "X".repeat(200)
    const partDir = path.join(storage.part, messageID)
    fs.mkdirSync(partDir, { recursive: true })
    fs.writeFileSync(
      path.join(partDir, "part_1.json"),
      JSON.stringify({
        id: "part_1",
        sessionID: mainSessionId,
        messageID,
        type: "tool",
        callID: "call_1",
        tool: "delegate_task",
        state: {
          status: "completed",
          input: {
            run_in_background: true,
            description: longDescription,
            subagent_type: "explore",
          },
          time: { start: 1100, end: 1110 },
        },
      }),
      "utf8"
    )

    const projectID = "proj"
    const sessDir = path.join(storage.session, projectID)
    fs.mkdirSync(sessDir, { recursive: true })
    fs.writeFileSync(
      path.join(sessDir, "ses_child.json"),
      JSON.stringify({
        id: "ses_child",
        projectID,
        directory: "/tmp/project",
        title: `Background: ${longDescription}`,
        parentID: mainSessionId,
        time: { created: 1120, updated: 1120 },
      }),
      "utf8"
    )

    const rows = deriveBackgroundTasks({ storage, mainSessionId })
    expect(rows.length).toBe(1)
    expect(rows[0].sessionId).toBe("ses_child")
    expect(rows[0].description.length).toBeLessThanOrEqual(120)
  })

  it("extracts delegate_task background calls and correlates child sessions", () => {
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const mainSessionId = "ses_main"

    // Main session message + tool part
    const msgDir = path.join(storage.message, mainSessionId)
    fs.mkdirSync(msgDir, { recursive: true })
    const messageID = "msg_1"
    fs.writeFileSync(
      path.join(msgDir, `${messageID}.json`),
      JSON.stringify({
        id: messageID,
        sessionID: mainSessionId,
        role: "assistant",
        time: { created: 1000 },
      }),
      "utf8"
    )
    const partDir = path.join(storage.part, messageID)
    fs.mkdirSync(partDir, { recursive: true })
    fs.writeFileSync(
      path.join(partDir, "part_1.json"),
      JSON.stringify({
        id: "part_1",
        sessionID: mainSessionId,
        messageID,
        type: "tool",
        callID: "call_1",
        tool: "delegate_task",
        state: {
          status: "completed",
          input: {
            run_in_background: true,
            description: "Scan repo",
            subagent_type: "explore",
            prompt: "SECRET",
          },
        },
      }),
      "utf8"
    )

    // Child session metadata that should be correlated
    const projectID = "proj"
    const sessDir = path.join(storage.session, projectID)
    fs.mkdirSync(sessDir, { recursive: true })
    fs.writeFileSync(
      path.join(sessDir, "ses_child.json"),
      JSON.stringify({
        id: "ses_child",
        projectID,
        directory: "/tmp/project",
        title: "Background: Scan repo",
        parentID: mainSessionId,
        time: { created: 1500, updated: 1500 },
      }),
      "utf8"
    )

    // Background session message with a tool call
    const childMsgDir = path.join(storage.message, "ses_child")
    fs.mkdirSync(childMsgDir, { recursive: true })
    const childMsgId = "msg_child"
    fs.writeFileSync(
      path.join(childMsgDir, `${childMsgId}.json`),
      JSON.stringify({
        id: childMsgId,
        sessionID: "ses_child",
        role: "assistant",
        time: { created: 2000 },
      }),
      "utf8"
    )
    const childPartDir = path.join(storage.part, childMsgId)
    fs.mkdirSync(childPartDir, { recursive: true })
    fs.writeFileSync(
      path.join(childPartDir, "part_1.json"),
      JSON.stringify({
        id: "part_1",
        sessionID: "ses_child",
        messageID: childMsgId,
        type: "tool",
        callID: "call_x",
        tool: "grep",
        state: { status: "completed", input: {} },
      }),
      "utf8"
    )

    const rows = deriveBackgroundTasks({ storage, mainSessionId, nowMs: 3000 })
    expect(rows.length).toBe(1)
    expect(rows[0].description).toBe("Scan repo")
    expect(rows[0].agent).toBe("explore")
    expect(rows[0].sessionId).toBe("ses_child")
    expect(rows[0].toolCalls).toBe(1)
    expect(rows[0].lastTool).toBe("grep")
    expect(rows[0].timeline).toBe("1970-01-01T00:00:01Z: 2s")

    const completed = deriveBackgroundTasks({ storage, mainSessionId, nowMs: 20_000 })
    expect(completed.length).toBe(1)
    expect(completed[0].status).toBe("completed")
    expect(completed[0].timeline).toBe("1970-01-01T00:00:01Z: 1s")

    // Ensure no sensitive keys leak
    expect((rows[0] as unknown as Record<string, unknown>).prompt).toBeUndefined()
    expect((rows[0] as unknown as Record<string, unknown>).input).toBeUndefined()
    expect((rows[0] as unknown as Record<string, unknown>).state).toBeUndefined()
  })

  it("correlates background session when child session title uses '@<subagent> subagent' format", () => {
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const mainSessionId = "ses_main"

    // Main session message + delegate_task tool part
    const msgDir = path.join(storage.message, mainSessionId)
    fs.mkdirSync(msgDir, { recursive: true })
    const messageID = "msg_1"
    fs.writeFileSync(
      path.join(msgDir, `${messageID}.json`),
      JSON.stringify({
        id: messageID,
        sessionID: mainSessionId,
        role: "assistant",
        time: { created: 1000 },
      }),
      "utf8"
    )

    const partDir = path.join(storage.part, messageID)
    fs.mkdirSync(partDir, { recursive: true })
    fs.writeFileSync(
      path.join(partDir, "part_1.json"),
      JSON.stringify({
        id: "part_1",
        sessionID: mainSessionId,
        messageID,
        type: "tool",
        callID: "call_1",
        tool: "delegate_task",
        state: {
          status: "completed",
          input: {
            run_in_background: true,
            description: "Docs on session APIs",
            subagent_type: "librarian",
          },
        },
      }),
      "utf8"
    )

    // Child session metadata using the newer title pattern.
    const projectID = "proj"
    const sessDir = path.join(storage.session, projectID)
    fs.mkdirSync(sessDir, { recursive: true })
    fs.writeFileSync(
      path.join(sessDir, "ses_child.json"),
      JSON.stringify({
        id: "ses_child",
        projectID,
        directory: "/tmp/project",
        title: "Docs on session APIs (@librarian subagent)",
        parentID: mainSessionId,
        time: { created: 1500, updated: 1500 },
      }),
      "utf8"
    )

    const rows = deriveBackgroundTasks({ storage, mainSessionId, nowMs: 2000 })
    expect(rows.length).toBe(1)
    expect(rows[0].sessionId).toBe("ses_child")
  })

  it("selects deterministic background session when multiple candidates have identical created timestamps", () => {
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const mainSessionId = "ses_main"

    const msgDir = path.join(storage.message, mainSessionId)
    fs.mkdirSync(msgDir, { recursive: true })
    const messageID = "msg_1"
    fs.writeFileSync(
      path.join(msgDir, `${messageID}.json`),
      JSON.stringify({
        id: messageID,
        sessionID: mainSessionId,
        role: "assistant",
        time: { created: 1000 },
      }),
      "utf8"
    )
    const partDir = path.join(storage.part, messageID)
    fs.mkdirSync(partDir, { recursive: true })
    fs.writeFileSync(
      path.join(partDir, "part_tie.json"),
      JSON.stringify({
        id: "part_tie",
        sessionID: mainSessionId,
        messageID,
        type: "tool",
        callID: "call_tie",
        tool: "delegate_task",
        state: {
          status: "completed",
          input: {
            run_in_background: true,
            description: "Tie-break test",
            subagent_type: "explore",
          },
        },
      }),
      "utf8"
    )

    const projectID = "proj"
    const sessDir = path.join(storage.session, projectID)
    fs.mkdirSync(sessDir, { recursive: true })
    
    const sharedTimestamp = 1500
    fs.writeFileSync(
      path.join(sessDir, "ses_zzz.json"),
      JSON.stringify({
        id: "ses_zzz",
        projectID,
        directory: "/tmp/project",
        title: "Background: Tie-break test",
        parentID: mainSessionId,
        time: { created: sharedTimestamp, updated: sharedTimestamp },
      }),
      "utf8"
    )
    fs.writeFileSync(
      path.join(sessDir, "ses_aaa.json"),
      JSON.stringify({
        id: "ses_aaa",
        projectID,
        directory: "/tmp/project",
        title: "Background: Tie-break test",
        parentID: mainSessionId,
        time: { created: sharedTimestamp, updated: sharedTimestamp },
      }),
      "utf8"
    )

    const rows = deriveBackgroundTasks({ storage, mainSessionId })
    expect(rows.length).toBe(1)
    expect(rows[0].sessionId).toBe("ses_aaa")
    expect(rows[0].description).toBe("Tie-break test")
    expect(rows[0].agent).toBe("explore")
  })

  it("includes sync delegate_task rows when run_in_background is false", () => {
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const mainSessionId = "ses_main"

    // Main session message + sync tool part
    const msgDir = path.join(storage.message, mainSessionId)
    fs.mkdirSync(msgDir, { recursive: true })
    const messageID = "msg_1"
    fs.writeFileSync(
      path.join(msgDir, `${messageID}.json`),
      JSON.stringify({
        id: messageID,
        sessionID: mainSessionId,
        role: "assistant",
        time: { created: 1000 },
      }),
      "utf8"
    )
    const partDir = path.join(storage.part, messageID)
    fs.mkdirSync(partDir, { recursive: true })
    fs.writeFileSync(
      path.join(partDir, "part_sync.json"),
      JSON.stringify({
        id: "part_sync",
        sessionID: mainSessionId,
        messageID,
        type: "tool",
        callID: "call_sync",
        tool: "delegate_task",
        state: {
          status: "completed",
          input: {
            run_in_background: false,
            description: "Quick analysis",
            category: "quick",
            prompt: "SHOULD NOT APPEAR",
          },
        },
      }),
      "utf8"
    )

    const rows = deriveBackgroundTasks({ storage, mainSessionId })
    expect(rows.length).toBe(1)
    expect(rows[0].description).toBe("Quick analysis")
    expect(rows[0].agent).toBe("sisyphus-junior (quick)")
    expect(rows[0].sessionId).toBe(null) // No background session for sync tasks
    expect(rows[0].toolCalls).toBe(null) // No background session stats for sync tasks
    expect(rows[0].lastTool).toBe(null)
    expect(rows[0].status).toBe("queued") // Should show queued for unlinked sync tasks

    // Ensure no sensitive keys leak
    expect((rows[0] as unknown as Record<string, unknown>).prompt).toBeUndefined()
    expect((rows[0] as unknown as Record<string, unknown>).input).toBeUndefined()
    expect((rows[0] as unknown as Record<string, unknown>).state).toBeUndefined()
  })

  it("selects deterministic task session when multiple candidates have identical created timestamps", () => {
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const mainSessionId = "ses_main"

    const msgDir = path.join(storage.message, mainSessionId)
    fs.mkdirSync(msgDir, { recursive: true })
    const messageID = "msg_1"
    fs.writeFileSync(
      path.join(msgDir, `${messageID}.json`),
      JSON.stringify({
        id: messageID,
        sessionID: mainSessionId,
        role: "assistant",
        time: { created: 1000 },
      }),
      "utf8"
    )
    const partDir = path.join(storage.part, messageID)
    fs.mkdirSync(partDir, { recursive: true })
    fs.writeFileSync(
      path.join(partDir, "part_tie_task.json"),
      JSON.stringify({
        id: "part_tie_task",
        sessionID: mainSessionId,
        messageID,
        type: "tool",
        callID: "call_tie_task",
        tool: "delegate_task",
        state: {
          status: "completed",
          input: {
            run_in_background: false,
            description: "Task tie-break test",
            category: "quick",
          },
        },
      }),
      "utf8"
    )

    const projectID = "proj"
    const sessDir = path.join(storage.session, projectID)
    fs.mkdirSync(sessDir, { recursive: true })
    
    const sharedTimestamp = 1500
    fs.writeFileSync(
      path.join(sessDir, "ses_task_zzz.json"),
      JSON.stringify({
        id: "ses_task_zzz",
        projectID,
        directory: "/tmp/project",
        title: "Task: Task tie-break test",
        parentID: mainSessionId,
        time: { created: sharedTimestamp, updated: sharedTimestamp },
      }),
      "utf8"
    )
    fs.writeFileSync(
      path.join(sessDir, "ses_task_aaa.json"),
      JSON.stringify({
        id: "ses_task_aaa",
        projectID,
        directory: "/tmp/project",
        title: "Task: Task tie-break test",
        parentID: mainSessionId,
        time: { created: sharedTimestamp, updated: sharedTimestamp },
      }),
      "utf8"
    )

    const rows = deriveBackgroundTasks({ storage, mainSessionId })
    expect(rows.length).toBe(1)
    expect(rows[0].sessionId).toBe("ses_task_aaa")
    expect(rows[0].description).toBe("Task tie-break test")
    expect(rows[0].agent).toBe("sisyphus-junior (quick)")
  })

  it("links sync delegate_task rows to Task sessions when available", () => {
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const mainSessionId = "ses_main"

    // Main session message + sync tool part
    const msgDir = path.join(storage.message, mainSessionId)
    fs.mkdirSync(msgDir, { recursive: true })
    const messageID = "msg_1"
    fs.writeFileSync(
      path.join(msgDir, `${messageID}.json`),
      JSON.stringify({
        id: messageID,
        sessionID: mainSessionId,
        role: "assistant",
        time: { created: 1000 },
      }),
      "utf8"
    )
    const partDir = path.join(storage.part, messageID)
    fs.mkdirSync(partDir, { recursive: true })
    fs.writeFileSync(
      path.join(partDir, "part_sync.json"),
      JSON.stringify({
        id: "part_sync",
        sessionID: mainSessionId,
        messageID,
        type: "tool",
        callID: "call_sync",
        tool: "delegate_task",
        state: {
          status: "completed",
          input: {
            run_in_background: false,
            description: "Quick analysis",
            category: "quick",
            prompt: "SHOULD NOT APPEAR",
          },
        },
      }),
      "utf8"
    )

    // Child session metadata with Task: title that should be correlated
    const projectID = "proj"
    const sessDir = path.join(storage.session, projectID)
    fs.mkdirSync(sessDir, { recursive: true })
    fs.writeFileSync(
      path.join(sessDir, "ses_task.json"),
      JSON.stringify({
        id: "ses_task",
        projectID,
        directory: "/tmp/project",
        title: "Task: Quick analysis",
        parentID: mainSessionId,
        time: { created: 1050, updated: 1050 },
      }),
      "utf8"
    )

    // Task session message with a tool call
    const taskMsgDir = path.join(storage.message, "ses_task")
    fs.mkdirSync(taskMsgDir, { recursive: true })
    const taskMsgId = "msg_task"
    fs.writeFileSync(
      path.join(taskMsgDir, `${taskMsgId}.json`),
      JSON.stringify({
        id: taskMsgId,
        sessionID: "ses_task",
        role: "assistant",
        time: { created: 1100 },
      }),
      "utf8"
    )
    const taskPartDir = path.join(storage.part, taskMsgId)
    fs.mkdirSync(taskPartDir, { recursive: true })
    fs.writeFileSync(
      path.join(taskPartDir, "part_1.json"),
      JSON.stringify({
        id: "part_1",
        sessionID: "ses_task",
        messageID: taskMsgId,
        type: "tool",
        callID: "call_x",
        tool: "read",
        state: { status: "completed", input: {} },
      }),
      "utf8"
    )

    const rows = deriveBackgroundTasks({ storage, mainSessionId })
    expect(rows.length).toBe(1)
    expect(rows[0].description).toBe("Quick analysis")
    expect(rows[0].agent).toBe("sisyphus-junior (quick)")
    expect(rows[0].sessionId).toBe("ses_task") // Should be linked to Task session
    expect(rows[0].toolCalls).toBe(1)
    expect(rows[0].lastTool).toBe("read")
    expect(rows[0].status).toBe("completed") // Should be completed since Task session has tool calls

    // Ensure no sensitive keys leak
    expect((rows[0] as unknown as Record<string, unknown>).prompt).toBeUndefined()
    expect((rows[0] as unknown as Record<string, unknown>).input).toBeUndefined()
    expect((rows[0] as unknown as Record<string, unknown>).state).toBeUndefined()
  })

  it("links sync delegate_task rows to resumed session when resume is specified", () => {
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const mainSessionId = "ses_main"
    const resumedSessionId = "ses_resumed"

    // Main session message + sync tool part with resume
    const msgDir = path.join(storage.message, mainSessionId)
    fs.mkdirSync(msgDir, { recursive: true })
    const messageID = "msg_1"
    fs.writeFileSync(
      path.join(msgDir, `${messageID}.json`),
      JSON.stringify({
        id: messageID,
        sessionID: mainSessionId,
        role: "assistant",
        time: { created: 1000 },
      }),
      "utf8"
    )
    const partDir = path.join(storage.part, messageID)
    fs.mkdirSync(partDir, { recursive: true })
    fs.writeFileSync(
      path.join(partDir, "part_resume.json"),
      JSON.stringify({
        id: "part_resume",
        sessionID: mainSessionId,
        messageID,
        type: "tool",
        callID: "call_resume",
        tool: "delegate_task",
        state: {
          status: "completed",
          input: {
            run_in_background: false,
            description: "Resume work",
            category: "quick",
            resume: resumedSessionId,
            prompt: "SHOULD NOT APPEAR",
          },
        },
      }),
      "utf8"
    )

    // Resumed session message + tool call
    const resumedMsgDir = path.join(storage.message, resumedSessionId)
    fs.mkdirSync(resumedMsgDir, { recursive: true })
    const resumedMsgId = "msg_resumed"
    fs.writeFileSync(
      path.join(resumedMsgDir, `${resumedMsgId}.json`),
      JSON.stringify({
        id: resumedMsgId,
        sessionID: resumedSessionId,
        role: "assistant",
        time: { created: 500 },
      }),
      "utf8"
    )
    const resumedPartDir = path.join(storage.part, resumedMsgId)
    fs.mkdirSync(resumedPartDir, { recursive: true })
    fs.writeFileSync(
      path.join(resumedPartDir, "part_1.json"),
      JSON.stringify({
        id: "part_1",
        sessionID: resumedSessionId,
        messageID: resumedMsgId,
        type: "tool",
        callID: "call_grep",
        tool: "grep",
        state: { status: "completed", input: {} },
      }),
      "utf8"
    )

    const rows = deriveBackgroundTasks({ storage, mainSessionId })
    expect(rows.length).toBe(1)
    expect(rows[0].description).toBe("Resume work")
    expect(rows[0].agent).toBe("sisyphus-junior (quick)")
    expect(rows[0].sessionId).toBe(resumedSessionId) // Should be linked to resumed session
    expect(rows[0].toolCalls).toBe(1)
    expect(rows[0].lastTool).toBe("grep")
    expect(rows[0].status).toBe("completed") // Should be completed since resumed session has tool calls

    // Ensure no sensitive keys leak
    expect((rows[0] as unknown as Record<string, unknown>).prompt).toBeUndefined()
    expect((rows[0] as unknown as Record<string, unknown>).input).toBeUndefined()
    expect((rows[0] as unknown as Record<string, unknown>).state).toBeUndefined()
  })

  it("falls back to title-based matching when resume session does not exist", () => {
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const mainSessionId = "ses_main"
    const nonExistentResumeId = "ses_nonexistent"

    // Main session message + sync tool part with non-existent resume
    const msgDir = path.join(storage.message, mainSessionId)
    fs.mkdirSync(msgDir, { recursive: true })
    const messageID = "msg_1"
    fs.writeFileSync(
      path.join(msgDir, `${messageID}.json`),
      JSON.stringify({
        id: messageID,
        sessionID: mainSessionId,
        role: "assistant",
        time: { created: 1000 },
      }),
      "utf8"
    )
    const partDir = path.join(storage.part, messageID)
    fs.mkdirSync(partDir, { recursive: true })
    fs.writeFileSync(
      path.join(partDir, "part_fallback.json"),
      JSON.stringify({
        id: "part_fallback",
        sessionID: mainSessionId,
        messageID,
        type: "tool",
        callID: "call_fallback",
        tool: "delegate_task",
        state: {
          status: "completed",
          input: {
            run_in_background: false,
            description: "Fallback task",
            category: "quick",
            resume: nonExistentResumeId,
            prompt: "SHOULD NOT APPEAR",
          },
        },
      }),
      "utf8"
    )

    // Child session metadata with Task: title that should be used as fallback
    const projectID = "proj"
    const sessDir = path.join(storage.session, projectID)
    fs.mkdirSync(sessDir, { recursive: true })
    fs.writeFileSync(
      path.join(sessDir, "ses_task.json"),
      JSON.stringify({
        id: "ses_task",
        projectID,
        directory: "/tmp/project",
        title: "Task: Fallback task",
        parentID: mainSessionId,
        time: { created: 1050, updated: 1050 },
      }),
      "utf8"
    )

    const rows = deriveBackgroundTasks({ storage, mainSessionId })
    expect(rows.length).toBe(1)
    expect(rows[0].description).toBe("Fallback task")
    expect(rows[0].sessionId).toBe("ses_task") // Should fallback to Task session
    expect(rows[0].toolCalls).toBe(0) // No tool calls in fallback session
    expect(rows[0].lastTool).toBe(null)
    expect(rows[0].status).toBe("unknown") // Should be unknown since session exists but no tool calls
    expect(rows[0].timeline).toBe("") // Unknown status should emit no timeline
  })

  it("links sync delegate_task rows to Background sessions when forced-to-background but waited", () => {
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const mainSessionId = "ses_main"

    const msgDir = path.join(storage.message, mainSessionId)
    fs.mkdirSync(msgDir, { recursive: true })
    const messageID = "msg_1"
    fs.writeFileSync(
      path.join(msgDir, `${messageID}.json`),
      JSON.stringify({
        id: messageID,
        sessionID: mainSessionId,
        role: "assistant",
        time: { created: 1000 },
      }),
      "utf8"
    )
    const partDir = path.join(storage.part, messageID)
    fs.mkdirSync(partDir, { recursive: true })
    fs.writeFileSync(
      path.join(partDir, "part_forced.json"),
      JSON.stringify({
        id: "part_forced",
        sessionID: mainSessionId,
        messageID,
        type: "tool",
        callID: "call_forced",
        tool: "delegate_task",
        state: {
          status: "completed",
          input: {
            run_in_background: false,
            description: "Forced background task",
            category: "quick",
            prompt: "SHOULD NOT APPEAR",
          },
        },
      }),
      "utf8"
    )

    const projectID = "proj"
    const sessDir = path.join(storage.session, projectID)
    fs.mkdirSync(sessDir, { recursive: true })
    fs.writeFileSync(
      path.join(sessDir, "ses_background.json"),
      JSON.stringify({
        id: "ses_background",
        projectID,
        directory: "/tmp/project",
        title: "Background: Forced background task",
        parentID: mainSessionId,
        time: { created: 1050, updated: 1050 },
      }),
      "utf8"
    )

    const backgroundMsgDir = path.join(storage.message, "ses_background")
    fs.mkdirSync(backgroundMsgDir, { recursive: true })
    const backgroundMsgId = "msg_background"
    fs.writeFileSync(
      path.join(backgroundMsgDir, `${backgroundMsgId}.json`),
      JSON.stringify({
        id: backgroundMsgId,
        sessionID: "ses_background",
        role: "assistant",
        time: { created: 1100 },
      }),
      "utf8"
    )
    const backgroundPartDir = path.join(storage.part, backgroundMsgId)
    fs.mkdirSync(backgroundPartDir, { recursive: true })
    fs.writeFileSync(
      path.join(backgroundPartDir, "part_1.json"),
      JSON.stringify({
        id: "part_1",
        sessionID: "ses_background",
        messageID: backgroundMsgId,
        type: "tool",
        callID: "call_x",
        tool: "bash",
        state: { status: "completed", input: {} },
      }),
      "utf8"
    )

    const rows = deriveBackgroundTasks({ storage, mainSessionId })
    expect(rows.length).toBe(1)
    expect(rows[0].description).toBe("Forced background task")
    expect(rows[0].agent).toBe("sisyphus-junior (quick)")
    expect(rows[0].sessionId).toBe("ses_background")
    expect(rows[0].toolCalls).toBe(1)
    expect(rows[0].lastTool).toBe("bash")
    expect(rows[0].status).toBe("completed")

    expect((rows[0] as unknown as Record<string, unknown>).prompt).toBeUndefined()
    expect((rows[0] as unknown as Record<string, unknown>).input).toBeUndefined()
    expect((rows[0] as unknown as Record<string, unknown>).state).toBeUndefined()
  })

  it("derives lastModel from background session assistant metas", () => {
    // #given
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const mainSessionId = "ses_main"

    const msgDir = path.join(storage.message, mainSessionId)
    fs.mkdirSync(msgDir, { recursive: true })
    const messageID = "msg_1"
    fs.writeFileSync(
      path.join(msgDir, `${messageID}.json`),
      JSON.stringify({
        id: messageID,
        sessionID: mainSessionId,
        role: "assistant",
        time: { created: 1000 },
      }),
      "utf8"
    )
    const partDir = path.join(storage.part, messageID)
    fs.mkdirSync(partDir, { recursive: true })
    fs.writeFileSync(
      path.join(partDir, "part_1.json"),
      JSON.stringify({
        id: "part_1",
        sessionID: mainSessionId,
        messageID,
        type: "tool",
        callID: "call_1",
        tool: "delegate_task",
        state: {
          status: "completed",
          input: {
            run_in_background: true,
            description: "Model scan",
            subagent_type: "explore",
          },
        },
      }),
      "utf8"
    )

    const projectID = "proj"
    const sessDir = path.join(storage.session, projectID)
    fs.mkdirSync(sessDir, { recursive: true })
    fs.writeFileSync(
      path.join(sessDir, "ses_child.json"),
      JSON.stringify({
        id: "ses_child",
        projectID,
        directory: "/tmp/project",
        title: "Background: Model scan",
        parentID: mainSessionId,
        time: { created: 1500, updated: 1500 },
      }),
      "utf8"
    )

    const childMsgDir = path.join(storage.message, "ses_child")
    fs.mkdirSync(childMsgDir, { recursive: true })
    const childMsgId = "msg_child"
    fs.writeFileSync(
      path.join(childMsgDir, `${childMsgId}.json`),
      JSON.stringify({
        id: childMsgId,
        sessionID: "ses_child",
        role: "assistant",
        time: { created: 2000 },
        providerID: "openai",
        modelID: "gpt-5.2",
      }),
      "utf8"
    )

    // #when
    const rows = deriveBackgroundTasks({ storage, mainSessionId })

    // #then
    expect(rows.length).toBe(1)
    expect(rows[0].lastModel).toBe("openai/gpt-5.2")
  })

  it("orders lastModel by time.created over file mtime", () => {
    // #given
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const mainSessionId = "ses_main"

    const msgDir = path.join(storage.message, mainSessionId)
    fs.mkdirSync(msgDir, { recursive: true })
    const messageID = "msg_1"
    fs.writeFileSync(
      path.join(msgDir, `${messageID}.json`),
      JSON.stringify({
        id: messageID,
        sessionID: mainSessionId,
        role: "assistant",
        time: { created: 1000 },
      }),
      "utf8"
    )
    const partDir = path.join(storage.part, messageID)
    fs.mkdirSync(partDir, { recursive: true })
    fs.writeFileSync(
      path.join(partDir, "part_1.json"),
      JSON.stringify({
        id: "part_1",
        sessionID: mainSessionId,
        messageID,
        type: "tool",
        callID: "call_1",
        tool: "delegate_task",
        state: {
          status: "completed",
          input: {
            run_in_background: true,
            description: "Ordering scan",
            subagent_type: "explore",
          },
        },
      }),
      "utf8"
    )

    const projectID = "proj"
    const sessDir = path.join(storage.session, projectID)
    fs.mkdirSync(sessDir, { recursive: true })
    fs.writeFileSync(
      path.join(sessDir, "ses_child.json"),
      JSON.stringify({
        id: "ses_child",
        projectID,
        directory: "/tmp/project",
        title: "Background: Ordering scan",
        parentID: mainSessionId,
        time: { created: 1500, updated: 1500 },
      }),
      "utf8"
    )

    const childMsgDir = path.join(storage.message, "ses_child")
    fs.mkdirSync(childMsgDir, { recursive: true })
    const olderMsgId = "msg_older"
    const newerMsgId = "msg_newer"

    fs.writeFileSync(
      path.join(childMsgDir, `${newerMsgId}.json`),
      JSON.stringify({
        id: newerMsgId,
        sessionID: "ses_child",
        role: "assistant",
        time: { created: 3000 },
        providerID: "openai",
        modelID: "gpt-newer",
      }),
      "utf8"
    )
    fs.writeFileSync(
      path.join(childMsgDir, `${olderMsgId}.json`),
      JSON.stringify({
        id: olderMsgId,
        sessionID: "ses_child",
        role: "assistant",
        time: { created: 1000 },
        providerID: "openai",
        modelID: "gpt-older",
      }),
      "utf8"
    )

    // #when
    const rows = deriveBackgroundTasks({ storage, mainSessionId })

    // #then
    expect(rows.length).toBe(1)
    expect(rows[0].lastModel).toBe("openai/gpt-newer")
  })

  it("memoizes background session reads for shared sessionId", () => {
    // #given
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const mainSessionId = "ses_main"
    
    // Clear any previous mock state
    vi.clearAllMocks()

    const msgDir = path.join(storage.message, mainSessionId)
    fs.mkdirSync(msgDir, { recursive: true })
    const messageID = "msg_1"
    fs.writeFileSync(
      path.join(msgDir, `${messageID}.json`),
      JSON.stringify({
        id: messageID,
        sessionID: mainSessionId,
        role: "assistant",
        time: { created: 1000 },
      }),
      "utf8"
    )
    const partDir = path.join(storage.part, messageID)
    fs.mkdirSync(partDir, { recursive: true })
    fs.writeFileSync(
      path.join(partDir, "part_1.json"),
      JSON.stringify({
        id: "part_1",
        sessionID: mainSessionId,
        messageID,
        type: "tool",
        callID: "call_1",
        tool: "delegate_task",
        state: {
          status: "completed",
          input: {
            run_in_background: true,
            description: "Memo scan",
            subagent_type: "explore",
          },
        },
      }),
      "utf8"
    )
    fs.writeFileSync(
      path.join(partDir, "part_2.json"),
      JSON.stringify({
        id: "part_2",
        sessionID: mainSessionId,
        messageID,
        type: "tool",
        callID: "call_2",
        tool: "delegate_task",
        state: {
          status: "completed",
          input: {
            run_in_background: true,
            description: "Memo scan",
            subagent_type: "explore",
          },
        },
      }),
      "utf8"
    )

    const projectID = "proj"
    const sessDir = path.join(storage.session, projectID)
    fs.mkdirSync(sessDir, { recursive: true })
    fs.writeFileSync(
      path.join(sessDir, "ses_child.json"),
      JSON.stringify({
        id: "ses_child",
        projectID,
        directory: "/tmp/project",
        title: "Background: Memo scan",
        parentID: mainSessionId,
        time: { created: 1500, updated: 1500 },
      }),
      "utf8"
    )

    const childMsgDir = path.join(storage.message, "ses_child")
    fs.mkdirSync(childMsgDir, { recursive: true })
    const childMsgId = "msg_child"
    fs.writeFileSync(
      path.join(childMsgDir, `${childMsgId}.json`),
      JSON.stringify({
        id: childMsgId,
        sessionID: "ses_child",
        role: "assistant",
        time: { created: 2000 },
        providerID: "openai",
        modelID: "gpt-5.2",
      }),
      "utf8"
    )

    // Create typed wrapper that records calls and delegates to fs.readdirSync
    const readdirCalls: Array<[fs.PathLike]> = []
    const readdirSync = ((path: fs.PathLike, options?: any): any => {
      if (typeof options === 'object' && options.withFileTypes) {
        return fs.readdirSync(path, options)
      }
      readdirCalls.push([path])
      return fs.readdirSync(path, 'utf8')
    }) as typeof fs.readdirSync
    
    const fsLike = {
      readFileSync: fs.readFileSync,
      readdirSync,
      existsSync: fs.existsSync,
      statSync: fs.statSync,
    }

    // #when
    const rows = deriveBackgroundTasks({ storage, mainSessionId, fs: fsLike })

    // #then
    const backgroundReads = readdirCalls.filter((call) => call[0] === childMsgDir)
    expect(rows.length).toBe(2)
    expect(backgroundReads.length).toBe(1)
  })

  it.each(["delegate_task", "task"])("treats tool: '%s' the same as tool: 'delegate_task'", (toolName) => {
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const mainSessionId = "ses_main"

    const msgDir = path.join(storage.message, mainSessionId)
    fs.mkdirSync(msgDir, { recursive: true })
    const messageID = "msg_1"
    fs.writeFileSync(
      path.join(msgDir, `${messageID}.json`),
      JSON.stringify({
        id: messageID,
        sessionID: mainSessionId,
        role: "assistant",
        time: { created: 1000 },
      }),
      "utf8"
    )

    const partDir = path.join(storage.part, messageID)
    fs.mkdirSync(partDir, { recursive: true })
    fs.writeFileSync(
      path.join(partDir, `part_${toolName}.json`),
      JSON.stringify({
        id: `part_${toolName}`,
        sessionID: mainSessionId,
        messageID,
        type: "tool",
        callID: `call_${toolName}`,
        tool: toolName,
        state: {
          status: "completed",
          input: {
            run_in_background: true,
            description: "Task tool equivalence test",
            subagent_type: "explore",
          },
        },
      }),
      "utf8"
    )

    const projectID = "proj"
    const sessDir = path.join(storage.session, projectID)
    fs.mkdirSync(sessDir, { recursive: true })
    fs.writeFileSync(
      path.join(sessDir, "ses_child.json"),
      JSON.stringify({
        id: "ses_child",
        projectID,
        directory: "/tmp/project",
        title: "Background: Task tool equivalence test",
        parentID: mainSessionId,
        time: { created: 1500, updated: 1500 },
      }),
      "utf8"
    )

    // Add a message and tool call to the child session so status becomes "completed"
    const childMsgDir = path.join(storage.message, "ses_child")
    fs.mkdirSync(childMsgDir, { recursive: true })
    const childMsgId = "msg_child"
    fs.writeFileSync(
      path.join(childMsgDir, `${childMsgId}.json`),
      JSON.stringify({
        id: childMsgId,
        sessionID: "ses_child",
        role: "assistant",
        time: { created: 2000 },
      }),
      "utf8"
    )
    const childPartDir = path.join(storage.part, childMsgId)
    fs.mkdirSync(childPartDir, { recursive: true })
    fs.writeFileSync(
      path.join(childPartDir, "part_child.json"),
      JSON.stringify({
        id: "part_child",
        sessionID: "ses_child",
        messageID: childMsgId,
        type: "tool",
        callID: "call_child",
        tool: "read",
        state: { status: "completed", input: {} },
      }),
      "utf8"
    )

    const rows = deriveBackgroundTasks({ storage, mainSessionId })
    expect(rows.length).toBe(1)
    expect(rows[0].description).toBe("Task tool equivalence test")
    expect(rows[0].agent).toBe("explore")
    expect(rows[0].sessionId).toBe("ses_child")
    expect(rows[0].status).toBe("completed")
    expect(rows[0].id).toBe(`call_${toolName}`)
  })

  it("ignores non-task tools like 'bash'", () => {
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const mainSessionId = "ses_main"

    const msgDir = path.join(storage.message, mainSessionId)
    fs.mkdirSync(msgDir, { recursive: true })
    const messageID = "msg_1"
    fs.writeFileSync(
      path.join(msgDir, `${messageID}.json`),
      JSON.stringify({
        id: messageID,
        sessionID: mainSessionId,
        role: "assistant",
        time: { created: 1000 },
      }),
      "utf8"
    )

    const partDir = path.join(storage.part, messageID)
    fs.mkdirSync(partDir, { recursive: true })
    fs.writeFileSync(
      path.join(partDir, "part_bash.json"),
      JSON.stringify({
        id: "part_bash",
        sessionID: mainSessionId,
        messageID,
        type: "tool",
        callID: "call_bash",
        tool: "bash",
        state: {
          status: "completed",
          input: {
            command: "echo 'test'",
          },
        },
      }),
      "utf8"
    )

    const rows = deriveBackgroundTasks({ storage, mainSessionId })
    expect(rows.length).toBe(0)
  })
})
