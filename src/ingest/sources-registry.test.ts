import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { addOrUpdateSource, getDefaultSourceId, listSources } from "./sources-registry"

function mkStorageRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omo-dashboard-storage-"))
}

function mkProjectRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe("sources registry", () => {
  it("creates the registry file and keeps a stable id", () => {
    const storageRoot = mkStorageRoot()
    const projectRoot = mkProjectRoot("omo-dashboard-project-")

    const now = vi.spyOn(Date, "now")
    now.mockReturnValueOnce(1_000)

    // #given a new project root
    // #when adding it to the registry
    addOrUpdateSource(storageRoot, { projectRoot, label: "Alpha" })

    const registryPath = path.join(storageRoot, "dashboard", "sources.json")
    expect(fs.existsSync(registryPath)).toBe(true)

    const firstList = listSources(storageRoot)
    expect(firstList).toHaveLength(1)
    const firstId = firstList[0]?.id

    now.mockReturnValueOnce(2_000)

    // #when adding the same project again
    addOrUpdateSource(storageRoot, { projectRoot, label: "Alpha 2" })

    // #then id stays stable and label updates
    const secondList = listSources(storageRoot)
    expect(secondList).toHaveLength(1)
    expect(secondList[0]?.id).toBe(firstId)
    expect(secondList[0]?.label).toBe("Alpha 2")

    now.mockRestore()
  })

  it("does not create duplicates when added twice", () => {
    const storageRoot = mkStorageRoot()
    const projectRoot = mkProjectRoot("omo-dashboard-project-")

    const now = vi.spyOn(Date, "now")
    now.mockReturnValueOnce(1_000)
    addOrUpdateSource(storageRoot, { projectRoot, label: "Solo" })

    now.mockReturnValueOnce(2_000)
    addOrUpdateSource(storageRoot, { projectRoot })

    const list = listSources(storageRoot)
    expect(list).toHaveLength(1)
    expect(list[0]?.updatedAt).toBe(2_000)
    expect(list[0]?.label).toBe("Solo")

    now.mockRestore()
  })

  it("orders sources by updatedAt desc", () => {
    const storageRoot = mkStorageRoot()
    const projectA = mkProjectRoot("omo-dashboard-project-a-")
    const projectB = mkProjectRoot("omo-dashboard-project-b-")

    const now = vi.spyOn(Date, "now")
    now.mockReturnValueOnce(1_000)
    addOrUpdateSource(storageRoot, { projectRoot: projectA, label: "First" })

    now.mockReturnValueOnce(2_000)
    addOrUpdateSource(storageRoot, { projectRoot: projectB, label: "Second" })

    const list = listSources(storageRoot)
    expect(list).toHaveLength(2)
    expect(list[0]?.label).toBe("Second")
    expect(list[1]?.label).toBe("First")

    now.mockRestore()
  })

  it("canonicalizes paths to collapse symlink variations", () => {
    const storageRoot = mkStorageRoot()
    const realRoot = mkProjectRoot("omo-dashboard-real-")
    const linkRoot = path.join(os.tmpdir(), `omo-dashboard-link-${Date.now()}`)
    fs.symlinkSync(realRoot, linkRoot)

    const now = vi.spyOn(Date, "now")
    now.mockReturnValueOnce(1_000)
    addOrUpdateSource(storageRoot, { projectRoot: linkRoot, label: "Linked" })

    now.mockReturnValueOnce(2_000)
    addOrUpdateSource(storageRoot, { projectRoot: realRoot })

    const list = listSources(storageRoot)
    expect(list).toHaveLength(1)
    expect(list[0]?.label).toBe("Linked")
    expect(getDefaultSourceId(storageRoot)).toBe(list[0]?.id ?? null)

    now.mockRestore()
  })
})
