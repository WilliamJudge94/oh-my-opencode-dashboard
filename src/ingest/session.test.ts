import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import {
  getMainSessionView,
  getStorageRoots,
  pickActiveSessionId,
  readMainSessionMetas,
} from "./session"

function mkStorageRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omo-storage-"))
  fs.mkdirSync(path.join(root, "session"), { recursive: true })
  fs.mkdirSync(path.join(root, "message"), { recursive: true })
  fs.mkdirSync(path.join(root, "part"), { recursive: true })
  return root
}

describe("pickActiveSessionId", () => {
  it("prefers last boulder session_id that exists", () => {
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const projectRoot = "/tmp/project"

    fs.mkdirSync(path.join(storage.message, "ses_ok"), { recursive: true })

    const picked = pickActiveSessionId({
      projectRoot,
      storage,
      boulderSessionIds: ["ses_missing", "ses_ok"],
    })
    expect(picked).toBe("ses_ok")
  })

  it("falls back to newest main session metadata for directory", () => {
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const projectRoot = "/tmp/project"
    const projectID = "proj_1"
    fs.mkdirSync(path.join(storage.session, projectID), { recursive: true })

    fs.writeFileSync(
      path.join(storage.session, projectID, "ses_1.json"),
      JSON.stringify({
        id: "ses_1",
        projectID,
        directory: projectRoot,
        time: { created: 1, updated: 10 },
      }),
      "utf8"
    )
    fs.writeFileSync(
      path.join(storage.session, projectID, "ses_2.json"),
      JSON.stringify({
        id: "ses_2",
        projectID,
        directory: projectRoot,
        time: { created: 2, updated: 20 },
      }),
      "utf8"
    )

    const picked = pickActiveSessionId({ projectRoot, storage })
    expect(picked).toBe("ses_2")
  })
})

describe("getMainSessionView", () => {
  it("derives current tool and busy state from latest tool part", () => {
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const projectRoot = "/tmp/project"
    const sessionId = "ses_1"

    const messageDir = path.join(storage.message, sessionId)
    fs.mkdirSync(messageDir, { recursive: true })

    const messageID = "msg_1"
    fs.writeFileSync(
      path.join(messageDir, `${messageID}.json`),
      JSON.stringify({
        id: messageID,
        sessionID: sessionId,
        role: "assistant",
        agent: "sisyphus",
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
        sessionID: sessionId,
        messageID,
        type: "tool",
        callID: "call_1",
        tool: "delegate_task",
        state: { status: "running", input: {} },
      }),
      "utf8"
    )

    const metas = readMainSessionMetas(storage.session, projectRoot)
    const view = getMainSessionView({
      projectRoot,
      sessionId,
      storage,
      sessionMeta: metas[0] ?? null,
      nowMs: 2000,
    })

    expect(view.agent).toBe("sisyphus")
    expect(view.currentTool).toBe("delegate_task")
    expect(view.status).toBe("running_tool")
  })

  it("reproduces bug: newest meta is user, tool still running", () => {
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const projectRoot = "/tmp/project"
    const sessionId = "ses_1"

    const messageDir = path.join(storage.message, sessionId)
    fs.mkdirSync(messageDir, { recursive: true })

    // Create an older assistant message with a running tool part
    const assistantMessageID = "msg_1"
    fs.writeFileSync(
      path.join(messageDir, `${assistantMessageID}.json`),
      JSON.stringify({
        id: assistantMessageID,
        sessionID: sessionId,
        role: "assistant",
        agent: "sisyphus",
        time: { created: 1000 },
      }),
      "utf8"
    )

    const assistantPartDir = path.join(storage.part, assistantMessageID)
    fs.mkdirSync(assistantPartDir, { recursive: true })
    fs.writeFileSync(
      path.join(assistantPartDir, "part_1.json"),
      JSON.stringify({
        id: "part_1",
        sessionID: sessionId,
        messageID: assistantMessageID,
        type: "tool",
        callID: "call_1",
        tool: "grep",
        state: { status: "running", input: { query: "test" } },
      }),
      "utf8"
    )

    // Create a newer user message (this becomes the "newest meta")
    const userMessageID = "msg_2"
    fs.writeFileSync(
      path.join(messageDir, `${userMessageID}.json`),
      JSON.stringify({
        id: userMessageID,
        sessionID: sessionId,
        role: "user",
        time: { created: 2000 },
      }),
      "utf8"
    )

    const metas = readMainSessionMetas(storage.session, projectRoot)
    const view = getMainSessionView({
      projectRoot,
      sessionId,
      storage,
      sessionMeta: metas[0] ?? null,
      nowMs: 50000, // Force idle branch: nowMs - newestMeta.time.created > 15_000
    })

    // Should detect running tool and return running_tool status
    expect(view.status).toBe("running_tool")
    expect(view.currentTool).toBe("grep")
  })

  it("derives thinking state when latest assistant message is not completed", () => {
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const projectRoot = "/tmp/project"
    const sessionId = "ses_1"

    const messageDir = path.join(storage.message, sessionId)
    fs.mkdirSync(messageDir, { recursive: true })

    const messageID = "msg_1"
    fs.writeFileSync(
      path.join(messageDir, `${messageID}.json`),
      JSON.stringify({
        id: messageID,
        sessionID: sessionId,
        role: "assistant",
        agent: "sisyphus",
        time: { created: 1000 },
      }),
      "utf8"
    )

    const view = getMainSessionView({
      projectRoot,
      sessionId,
      storage,
      sessionMeta: null,
      nowMs: 50_000,
    })

    expect(view.status).toBe("thinking")
  })
})
