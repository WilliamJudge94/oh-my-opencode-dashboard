import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { realpathSafe } from "./paths"

export type SourceRegistryEntry = {
  id: string
  projectRoot: string
  label?: string
  createdAt: number
  updatedAt: number
}

type SourcesRegistry = {
  version: 1
  sources: Record<string, SourceRegistryEntry>
}

export type SourceListItem = {
  id: string
  label?: string
  updatedAt: number
}

const REGISTRY_VERSION = 1 as const

function getRegistryPath(storageRoot: string): string {
  return path.join(storageRoot, "dashboard", "sources.json")
}

function canonicalizeProjectRoot(projectRoot: string): string {
  const resolved = path.resolve(projectRoot)
  const real = realpathSafe(resolved) ?? resolved
  return path.normalize(real)
}

function hashProjectRoot(projectRoot: string): string {
  return createHash("sha256").update(projectRoot).digest("hex")
}

function emptyRegistry(): SourcesRegistry {
  return { version: REGISTRY_VERSION, sources: {} }
}

function writeRegistry(storageRoot: string, registry: SourcesRegistry): void {
  const registryPath = getRegistryPath(storageRoot)
  fs.mkdirSync(path.dirname(registryPath), { recursive: true })
  const tmpPath = `${registryPath}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(registry), "utf8")
  fs.renameSync(tmpPath, registryPath)
}

export function loadRegistry(storageRoot: string): SourcesRegistry {
  const registryPath = getRegistryPath(storageRoot)
  if (!fs.existsSync(registryPath)) return emptyRegistry()

  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8")) as SourcesRegistry
    if (parsed?.version !== REGISTRY_VERSION || typeof parsed.sources !== "object" || !parsed.sources) {
      return emptyRegistry()
    }
    return parsed
  } catch {
    return emptyRegistry()
  }
}

export function addOrUpdateSource(
  storageRoot: string,
  input: { projectRoot: string; label?: string }
): string {
  const canonical = canonicalizeProjectRoot(input.projectRoot)
  const id = hashProjectRoot(canonical)
  const now = Date.now()

  const registry = loadRegistry(storageRoot)
  const existing = registry.sources[id]
  if (existing) {
    registry.sources[id] = {
      ...existing,
      label: input.label ?? existing.label,
      updatedAt: now,
    }
  } else {
    registry.sources[id] = {
      id,
      projectRoot: canonical,
      label: input.label,
      createdAt: now,
      updatedAt: now,
    }
  }

  writeRegistry(storageRoot, registry)
  return id
}

export function listSources(storageRoot: string): SourceListItem[] {
  const registry = loadRegistry(storageRoot)
  return Object.values(registry.sources)
    .map((source) => ({
      id: source.id,
      label: source.label,
      updatedAt: source.updatedAt,
    }))
    .sort((a, b) => {
      if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
      return a.id.localeCompare(b.id)
    })
}

export function getDefaultSourceId(storageRoot: string): string | null {
  return listSources(storageRoot)[0]?.id ?? null
}

export function getSourceById(storageRoot: string, sourceId: string): SourceRegistryEntry | null {
  const registry = loadRegistry(storageRoot)
  return registry.sources[sourceId] ?? null
}
