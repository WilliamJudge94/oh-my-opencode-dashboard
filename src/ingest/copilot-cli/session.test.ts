import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { readWorkspaceMetadata, listCopilotSessions } from "./session"

describe("copilot-cli session", () => {
  it("readWorkspaceMetadata returns null for non-existent session", () => {
    const nonExistentDir = path.join(os.tmpdir(), "nonexistent-copilot-state")
    const result = readWorkspaceMetadata("test-session", nonExistentDir)
    expect(result).toBeNull()
  })

  it("listCopilotSessions returns empty array when directory doesn't exist", () => {
    const nonExistentDir = path.join(os.tmpdir(), "nonexistent-copilot-state")
    const result = listCopilotSessions(nonExistentDir)
    expect(result).toEqual([])
  })

  it("readWorkspaceMetadata parses simple YAML correctly", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-test-"))
    const sessionId = "test-session-123"
    const sessionDir = path.join(tmpDir, sessionId)
    fs.mkdirSync(sessionDir, { recursive: true })

    const yamlContent = `id: ${sessionId}
cwd: /test/workspace
summary: Test summary
created_at: 1234567890
updated_at: 1234567900
`
    fs.writeFileSync(path.join(sessionDir, "workspace.yaml"), yamlContent, "utf8")

    const result = readWorkspaceMetadata(sessionId, tmpDir)
    
    expect(result).not.toBeNull()
    expect(result?.id).toBe(sessionId)
    expect(result?.cwd).toBe("/test/workspace")
    expect(result?.summary).toBe("Test summary")
    expect(result?.created_at).toBe(1234567890)
    expect(result?.updated_at).toBe(1234567900)

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true })
  })
})
