import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export type Env = Record<string, string | undefined>

/**
 * Get the Copilot CLI session state directory.
 * Defaults to ~/.copilot/session-state/
 */
export function getCopilotStateDir(env: Env = process.env, homedir: string = os.homedir()): string {
  return path.join(homedir, ".copilot", "session-state")
}

/**
 * List all session directories in the Copilot state directory.
 * Returns an array of session IDs.
 */
export function listSessionDirs(stateDirOverride?: string): string[] {
  const stateDir = stateDirOverride ?? getCopilotStateDir()
  
  if (!fs.existsSync(stateDir)) {
    return []
  }

  try {
    const entries = fs.readdirSync(stateDir, { withFileTypes: true })
    return entries
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * Get the path to a specific session directory.
 */
export function getSessionDir(sessionId: string, stateDirOverride?: string): string {
  const stateDir = stateDirOverride ?? getCopilotStateDir()
  return path.join(stateDir, sessionId)
}

/**
 * Check if a session directory exists.
 */
export function sessionDirExists(sessionId: string, stateDirOverride?: string): boolean {
  const sessionDir = getSessionDir(sessionId, stateDirOverride)
  return fs.existsSync(sessionDir) && fs.statSync(sessionDir).isDirectory()
}
