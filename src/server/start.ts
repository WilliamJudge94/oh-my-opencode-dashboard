#!/usr/bin/env bun
import { Hono } from 'hono'
import * as fs from "node:fs"
import { basename, join } from 'node:path'
import { parseArgs } from 'util'
import { createApi } from "./api"
import { createDashboardStore, type DashboardStore } from "./dashboard"
import { getOpenCodeStorageDir } from "../ingest/paths"
import { addOrUpdateSource } from "../ingest/sources-registry"

const { values, positionals } = parseArgs({
  args: Bun.argv,
  options: {
    project: { type: 'string' },
    port: { type: 'string' },
    name: { type: 'string' },
  },
  allowPositionals: true,
})

const project = values.project ?? process.cwd()

const port = parseInt(values.port || '51234')

const cleanedPositionals = [...positionals]
if (cleanedPositionals[0] === Bun.argv[0]) cleanedPositionals.shift()
if (cleanedPositionals[0] === Bun.argv[1]) cleanedPositionals.shift()
const command = cleanedPositionals[0]

if (command === "add") {
  const projectRoot = project
  if (!fs.existsSync(projectRoot)) {
    console.error("Project path does not exist.")
    process.exit(1)
  }
  if (!fs.statSync(projectRoot).isDirectory()) {
    console.error("Project path must be a directory.")
    process.exit(1)
  }

  const rawLabel = values.name ?? basename(projectRoot)
  const trimmedLabel = rawLabel.trim()
  const MAX_LABEL_LENGTH = 80
  const label = trimmedLabel.slice(0, MAX_LABEL_LENGTH)
  if (!label) {
    console.error("Source name is required.")
    process.exit(1)
  }

  const storageRoot = getOpenCodeStorageDir()
  const id = addOrUpdateSource(storageRoot, { projectRoot, label })
  console.log(`Added source ${id}: ${label}`)
  process.exit(0)
}

const app = new Hono()

const storageRoot = getOpenCodeStorageDir()

const store = createDashboardStore({
  projectRoot: project,
  storageRoot,
  watch: true,
  pollIntervalMs: 2000,
})

const storeBySourceId = new Map<string, DashboardStore>()
const storeByProjectRoot = new Map<string, DashboardStore>([[project, store]])

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

app.route('/api', createApi({ store, storageRoot, projectRoot: project, getStoreForSource }))

const distRoot = join(import.meta.dir, '../../dist')

// SPA fallback middleware
app.use('*', async (c, next) => {
  const path = c.req.path
  
  // Skip API routes - let them pass through
  if (path.startsWith('/api/')) {
    return await next()
  }
  
  // For non-API routes without extensions, serve index.html
  if (!path.includes('.')) {
    const indexFile = Bun.file(join(distRoot, 'index.html'))
    if (await indexFile.exists()) {
      return c.html(await indexFile.text())
    }
    return c.notFound()
  }
  
  // For static files with extensions, try to serve them
  const relativePath = path.startsWith('/') ? path.slice(1) : path
  const file = Bun.file(join(distRoot, relativePath))
  if (await file.exists()) {
    const ext = path.split('.').pop() || ''
    const contentType = getContentType(ext)
    return new Response(file, {
      headers: { 'Content-Type': contentType }
    })
  }
  
  return c.notFound()
})

function getContentType(ext: string): string {
  const types: Record<string, string> = {
    'html': 'text/html',
    'js': 'application/javascript',
    'css': 'text/css',
    'json': 'application/json',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'ico': 'image/x-icon',
    'woff': 'font/woff',
    'woff2': 'font/woff2',
    'ttf': 'font/ttf',
    'eot': 'application/vnd.ms-fontobject',
  }
  return types[ext] || 'text/plain'
}

Bun.serve({
  fetch: app.fetch,
  hostname: '127.0.0.1',
  port,
})

console.log(`Server running on http://127.0.0.1:${port}`)
