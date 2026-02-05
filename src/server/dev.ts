#!/usr/bin/env bun
import { Hono } from "hono"
import { createApi } from "./api"
import { createDashboardStore, type DashboardStore } from "./dashboard"
import { getOpenCodeStorageDir } from "../ingest/paths"

const args = process.argv.slice(2)
let projectPath: string | undefined;
let port = 51234;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--project' && i + 1 < args.length) {
    projectPath = args[i + 1];
    i++;
  } else if (arg === '--port' && i + 1 < args.length) {
    const portValue = parseInt(args[i + 1], 10);
    if (!isNaN(portValue)) {
      port = portValue;
    }
    i++;
  }
}

const resolvedProjectPath = projectPath ?? process.cwd()

const app = new Hono()

const storageRoot = getOpenCodeStorageDir()

const store = createDashboardStore({
  projectRoot: resolvedProjectPath,
  storageRoot,
  watch: true,
  pollIntervalMs: 2000,
})

const storeBySourceId = new Map<string, DashboardStore>()
const storeByProjectRoot = new Map<string, DashboardStore>([[resolvedProjectPath, store]])

const getStoreForSource = ({ sourceId, projectRoot }: { sourceId: string; projectRoot: string }) => {
  const existing = storeBySourceId.get(sourceId)
  if (existing) return existing

  const byRoot = storeByProjectRoot.get(projectRoot)
  if (byRoot) {
    storeBySourceId.set(sourceId, byRoot)
    return byRoot
  }

  const created = createDashboardStore({
    projectRoot,
    storageRoot,
    watch: true,
    pollIntervalMs: 2000,
  })
  storeBySourceId.set(sourceId, created)
  storeByProjectRoot.set(projectRoot, created)
  return created
}

app.route("/api", createApi({ store, storageRoot, projectRoot: resolvedProjectPath, getStoreForSource }))

Bun.serve({
  fetch: app.fetch,
  hostname: '127.0.0.1',
  port,
})

console.log(`Server running at http://127.0.0.1:${port}`)
