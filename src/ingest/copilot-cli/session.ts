import * as fs from "node:fs"
import * as path from "node:path"
import { getSessionDir, listSessionDirs } from "./paths"

/**
 * Copilot CLI workspace metadata from workspace.yaml
 */
export type CopilotWorkspaceMetadata = {
  id: string
  cwd: string
  summary?: string
  created_at: number
  updated_at: number
}

/**
 * Parse a simple YAML file with key: value pairs.
 * This is a minimal parser that handles the workspace.yaml format.
 */
function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  const lines = content.split("\n")
  
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    
    const colonIndex = trimmed.indexOf(":")
    if (colonIndex === -1) continue
    
    const key = trimmed.slice(0, colonIndex).trim()
    let value = trimmed.slice(colonIndex + 1).trim()
    
    // Remove quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) || 
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    
    result[key] = value
  }
  
  return result
}

/**
 * Read workspace.yaml from a Copilot CLI session directory.
 */
export function readWorkspaceMetadata(sessionId: string, stateDirOverride?: string): CopilotWorkspaceMetadata | null {
  const sessionDir = getSessionDir(sessionId, stateDirOverride)
  const workspacePath = path.join(sessionDir, "workspace.yaml")
  
  if (!fs.existsSync(workspacePath)) {
    return null
  }
  
  try {
    const content = fs.readFileSync(workspacePath, "utf8")
    const parsed = parseSimpleYaml(content)
    
    return {
      id: parsed.id ?? sessionId,
      cwd: parsed.cwd ?? "",
      summary: parsed.summary,
      created_at: parsed.created_at ? parseInt(parsed.created_at, 10) : 0,
      updated_at: parsed.updated_at ? parseInt(parsed.updated_at, 10) : 0,
    }
  } catch {
    return null
  }
}

/**
 * List all Copilot CLI sessions with their metadata.
 */
export function listCopilotSessions(stateDirOverride?: string): CopilotWorkspaceMetadata[] {
  const sessionIds = listSessionDirs(stateDirOverride)
  
  const sessions: CopilotWorkspaceMetadata[] = []
  for (const sessionId of sessionIds) {
    const metadata = readWorkspaceMetadata(sessionId, stateDirOverride)
    if (metadata) {
      sessions.push(metadata)
    }
  }
  
  return sessions.sort((a, b) => b.updated_at - a.updated_at)
}
