#!/usr/bin/env bun
import { Hono } from 'hono'
import { join } from 'node:path'
import { parseArgs } from 'util'
import { createApi } from "./api"
import { createDashboardStore } from "./dashboard"
import { getOpenCodeStorageDir } from "../ingest/paths"

const { values } = parseArgs({
  args: Bun.argv,
  options: {
    project: { type: 'string' },
    port: { type: 'string' },
  },
  allowPositionals: true,
})

const project = values.project ?? process.cwd()

const port = parseInt(values.port || '51234')

const app = new Hono()

const storageRoot = getOpenCodeStorageDir()

const store = createDashboardStore({
  projectRoot: project,
  storageRoot,
  watch: true,
  pollIntervalMs: 2000,
})

app.route('/api', createApi({ store, storageRoot, projectRoot: project }))

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

const hostname = process.env.OMO_DASHBOARD_HOST ?? '127.0.0.1'

Bun.serve({
  fetch: app.fetch,
  hostname,
  port,
})

console.log(`Server running on http://${hostname}:${port}`)
