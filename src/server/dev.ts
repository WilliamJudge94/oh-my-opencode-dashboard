#!/usr/bin/env bun
import { Hono } from "hono"
import { createApi } from "./api"
import { createDashboardStore } from "./dashboard"
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

app.route("/api", createApi({ store, storageRoot }))

Bun.serve({
  fetch: app.fetch,
  hostname: '127.0.0.1',
  port,
})

console.log(`Server running at http://127.0.0.1:${port}`)
