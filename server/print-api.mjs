import { listPrinters, printRaw } from './print-bridge.mjs'

const MAX_BODY = 200_000
const ALLOWED_ORIGIN = process.env.LABELPRESS_ORIGIN || '*'

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  const headers = corsHeaders()
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('Print request is too large.'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function pathnameOf(req) {
  const raw = req.url || '/'
  try {
    return new URL(raw, 'http://127.0.0.1').pathname
  } catch {
    return raw.split('?')[0]
  }
}

export async function handlePrintApi(req, res) {
  const pathname = pathnameOf(req)

  // CORS preflight
  if (req.method === 'OPTIONS' && pathname.startsWith('/api/')) {
    res.writeHead(204, corsHeaders())
    res.end()
    return true
  }

  if (pathname === '/api/printers' && req.method === 'GET') {
    try {
      const result = await listPrinters()
      sendJson(res, 200, { ok: true, ...result })
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        printers: [],
        defaultPrinter: '',
        error: err instanceof Error ? err.message : 'Could not list printers.',
      })
    }
    return true
  }

  if (pathname === '/api/print' && req.method === 'POST') {
    try {
      const text = await readBody(req)
      const payload = text ? JSON.parse(text) : {}
      const printer = typeof payload.printer === 'string' ? payload.printer : 'default'
      const commands = typeof payload.commands === 'string' ? payload.commands : ''
      const result = await printRaw(printer, commands)
      sendJson(res, 200, { ok: true, ...result })
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : 'Print failed.',
      })
    }
    return true
  }

  return false
}

export function attachPrintApi(middlewares) {
  middlewares.use((req, res, next) => {
    handlePrintApi(req, res)
      .then((handled) => {
        if (!handled) next()
      })
      .catch((err) => {
        sendJson(res, 500, {
          ok: false,
          error: err instanceof Error ? err.message : 'Print API error.',
        })
      })
  })
}
