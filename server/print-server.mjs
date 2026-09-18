import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { handlePrintApi } from './print-api.mjs'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(rootDir, 'dist')
const port = Number(process.env.PORT || 5173)
const host = process.env.HOST || '0.0.0.0'

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname)
  const relative = urlPath === '/' ? '/index.html' : urlPath
  const filePath = path.normalize(path.join(distDir, relative))

  if (!filePath.startsWith(distDir)) {
    res.statusCode = 403
    res.end('Forbidden')
    return
  }

  try {
    const data = await fs.readFile(filePath)
    res.statusCode = 200
    res.setHeader('Content-Type', mime[path.extname(filePath)] || 'application/octet-stream')
    res.end(data)
  } catch {
    const index = await fs.readFile(path.join(distDir, 'index.html'))
    res.statusCode = 200
    res.setHeader('Content-Type', mime['.html'])
    res.end(index)
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (await handlePrintApi(req, res)) return
    await serveStatic(req, res)
  } catch (err) {
    res.statusCode = 500
    res.end(err instanceof Error ? err.message : 'Server error')
  }
})

server.listen(port, host, () => {
  console.log(`LabelPress running at http://${host}:${port}`)
})
