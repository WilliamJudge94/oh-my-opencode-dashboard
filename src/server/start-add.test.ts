import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { listSources } from "../ingest/sources-registry"

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function runAddCommand(args: string[], opts: { cwd: string; dataRoot: string }) {
  const startPath = fileURLToPath(new URL("./start.ts", import.meta.url))
  return spawnSync("bun", [startPath, "add", ...args], {
    cwd: opts.cwd,
    env: { ...process.env, XDG_DATA_HOME: opts.dataRoot },
    encoding: "utf8",
  })
}

describe("start add subcommand", () => {
  it("adds the current working directory with the provided name", () => {
    const projectRoot = mkTempDir("omo-dashboard-project-")
    const dataRoot = mkTempDir("omo-dashboard-data-")

    const result = runAddCommand(["--name", "Alpha"], { cwd: projectRoot, dataRoot })
    expect(result.status).toBe(0)

    const storageRoot = path.join(dataRoot, "opencode", "storage")
    const sources = listSources(storageRoot)
    expect(sources).toHaveLength(1)
    expect(sources[0]?.label).toBe("Alpha")
    expect(result.stdout).toContain(sources[0]?.id ?? "")
    expect(result.stdout).toContain("Alpha")
    expect(result.stdout).not.toContain(projectRoot)
  })

  it("adds a provided project root with a default label", () => {
    const projectRoot = mkTempDir("omo-dashboard-project-")
    const dataRoot = mkTempDir("omo-dashboard-data-")

    const result = runAddCommand(["--project", projectRoot], { cwd: process.cwd(), dataRoot })
    expect(result.status).toBe(0)

    const storageRoot = path.join(dataRoot, "opencode", "storage")
    const sources = listSources(storageRoot)
    expect(sources).toHaveLength(1)
    expect(sources[0]?.label).toBe(path.basename(projectRoot))
  })

  it("rejects empty names", () => {
    const projectRoot = mkTempDir("omo-dashboard-project-")
    const dataRoot = mkTempDir("omo-dashboard-data-")

    const result = runAddCommand(["--name", ""], { cwd: projectRoot, dataRoot })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("name")
  })
})
