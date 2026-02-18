import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { getCopilotStateDir, listSessionDirs, getSessionDir, sessionDirExists } from "./paths"

describe("copilot-cli paths", () => {
  it("getCopilotStateDir returns correct path", () => {
    const home = "/home/testuser"
    const result = getCopilotStateDir({}, home)
    expect(result).toBe(path.join(home, ".copilot", "session-state"))
  })

  it("listSessionDirs returns empty array when directory doesn't exist", () => {
    const nonExistentDir = path.join(os.tmpdir(), "nonexistent-copilot-state")
    const result = listSessionDirs(nonExistentDir)
    expect(result).toEqual([])
  })

  it("getSessionDir returns correct path", () => {
    const sessionId = "test-session-123"
    const stateDir = "/test/state"
    const result = getSessionDir(sessionId, stateDir)
    expect(result).toBe(path.join(stateDir, sessionId))
  })

  it("sessionDirExists returns false for non-existent session", () => {
    const nonExistentDir = path.join(os.tmpdir(), "nonexistent-copilot-state")
    const result = sessionDirExists("test-session", nonExistentDir)
    expect(result).toBe(false)
  })
})
