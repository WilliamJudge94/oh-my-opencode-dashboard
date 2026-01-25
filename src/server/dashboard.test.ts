import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { buildDashboardPayload } from "./dashboard"
import { getStorageRoots } from "../ingest/session"

function mkStorageRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omo-storage-"))
  fs.mkdirSync(path.join(root, "session"), { recursive: true })
  fs.mkdirSync(path.join(root, "message"), { recursive: true })
  fs.mkdirSync(path.join(root, "part"), { recursive: true })
  return root
}

describe("buildDashboardPayload", () => {
  it("surfaces 'running tool' status when session has in-flight tool", () => {
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-project-"))
    const sessionId = "ses_running_tool"
    const messageId = "msg_1"
    const projectID = "proj_1"

    try {
      const sessionMetaDir = path.join(storage.session, projectID)
      fs.mkdirSync(sessionMetaDir, { recursive: true })
      fs.writeFileSync(
        path.join(sessionMetaDir, `${sessionId}.json`),
        JSON.stringify({
          id: sessionId,
          projectID,
          directory: projectRoot,
          time: { created: 1000, updated: 1000 },
        }),
        "utf8"
      )

      const messageDir = path.join(storage.message, sessionId)
      fs.mkdirSync(messageDir, { recursive: true })
      fs.writeFileSync(
        path.join(messageDir, `${messageId}.json`),
        JSON.stringify({
          id: messageId,
          sessionID: sessionId,
          role: "assistant",
          agent: "sisyphus",
          time: { created: 1000 },
        }),
        "utf8"
      )

      const partDir = path.join(storage.part, messageId)
      fs.mkdirSync(partDir, { recursive: true })
      fs.writeFileSync(
        path.join(partDir, "part_1.json"),
        JSON.stringify({
          id: "part_1",
          sessionID: sessionId,
          messageID: messageId,
          type: "tool",
          callID: "call_1",
          tool: "delegate_task",
          state: { status: "running", input: {} },
        }),
        "utf8"
      )

      const payload = buildDashboardPayload({
        projectRoot,
        storage,
        nowMs: 2000,
      })

      expect(payload.mainSession.statusPill).toBe("running tool")
      expect(payload.mainSession.currentTool).toBe("delegate_task")
      expect(payload.mainSession.agent).toBe("sisyphus")
      
      expect(payload.raw).not.toHaveProperty("prompt")
      expect(payload.raw).not.toHaveProperty("input")
    } finally {
      fs.rmSync(storageRoot, { recursive: true, force: true })
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it("surfaces 'thinking' status when latest assistant message is not completed", () => {
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-project-"))
    const sessionId = "ses_thinking"
    const messageId = "msg_1"
    const projectID = "proj_1"

    try {
      const sessionMetaDir = path.join(storage.session, projectID)
      fs.mkdirSync(sessionMetaDir, { recursive: true })
      fs.writeFileSync(
        path.join(sessionMetaDir, `${sessionId}.json`),
        JSON.stringify({
          id: sessionId,
          projectID,
          directory: projectRoot,
          time: { created: 1000, updated: 1000 },
        }),
        "utf8"
      )

      const messageDir = path.join(storage.message, sessionId)
      fs.mkdirSync(messageDir, { recursive: true })
      fs.writeFileSync(
        path.join(messageDir, `${messageId}.json`),
        JSON.stringify({
          id: messageId,
          sessionID: sessionId,
          role: "assistant",
          agent: "sisyphus",
          time: { created: 1000 },
        }),
        "utf8"
      )

      const payload = buildDashboardPayload({
        projectRoot,
        storage,
        nowMs: 50_000,
      })

      expect(payload.mainSession.statusPill).toBe("thinking")
    } finally {
      fs.rmSync(storageRoot, { recursive: true, force: true })
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})
