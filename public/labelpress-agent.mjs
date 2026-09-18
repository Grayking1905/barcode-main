#!/usr/bin/env node
/**
 * LabelPress Agent
 * ─────────────────────────────────────────────────────────
 * Run this once on any PC that has label printers connected.
 * It listens on http://localhost:47474 and exposes:
 *
 *   GET  /api/printers  → list printers on this PC
 *   POST /api/print     → send a raw ZPL/TSPL/EPL job
 *
 * The deployed LabelPress web app will automatically discover
 * this agent and use it for printing — no extra software needed.
 *
 * Usage:
 *   node labelpress-agent.mjs
 *   node labelpress-agent.mjs --port 47474 --allow-origin "*"
 */

import http from 'node:http'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

// ── Config ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
function argValue(flag) {
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] : undefined
}

const PORT = Number(argValue('--port') || process.env.LABELPRESS_PORT || 47474)
const ALLOWED_ORIGIN = argValue('--allow-origin') || process.env.LABELPRESS_ORIGIN || '*'
const PLATFORM = process.platform

// ── Printer OS bridge (Windows + CUPS) ───────────────────────────────────────

const execFileAsync = promisify(execFile)

function run(file, runArgs, options = {}) {
  return execFileAsync(file, runArgs, {
    timeout: 20_000,
    maxBuffer: 2_000_000,
    windowsHide: true,
    ...options,
  })
}

function parseLpstatPrinters(stdout) {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[0])
    .filter(Boolean)
}

async function defaultCupsPrinter() {
  try {
    const { stdout } = await run('lpstat', ['-d'])
    const match = stdout.match(/destination:\s*(.+)\s*$/m)
    return match?.[1]?.trim() || ''
  } catch {
    return ''
  }
}

async function listCupsPrinters() {
  const { stdout } = await run('lpstat', ['-a'])
  const printers = parseLpstatPrinters(stdout)
  const defaultPrinter = (await defaultCupsPrinter()) || printers[0] || ''
  return { printers, defaultPrinter }
}

async function printCups(printer, commands) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'barcode-print-'))
  const filePath = path.join(dir, 'label.bin')
  try {
    await writeFile(filePath, commands, 'utf8')
    const lpArgs = ['-o', 'raw', '-o', 'job-sheets=none', '-n', '1']
    if (printer && printer !== 'default') lpArgs.push('-d', printer)
    lpArgs.push('--', filePath)
    await run('lp', lpArgs)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function parsePowerShellLines(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

async function listWindowsPrinters() {
  const { stdout } = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "Get-CimInstance Win32_Printer | ForEach-Object { $_.Name + [char]9 + ([bool]$_.Default) }",
  ])

  const printers = []
  let defaultPrinter = ''

  for (const line of parsePowerShellLines(stdout)) {
    const [name, isDefault] = line.split('\t')
    if (!name) continue
    printers.push(name)
    if (isDefault === 'True') defaultPrinter = name
  }

  return { printers, defaultPrinter: defaultPrinter || printers[0] || '' }
}

const RAW_PRINTER_CS = `
using System;
using System.Runtime.InteropServices;
public class RawPrinterHelper {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterA", SetLastError = true)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.drv", EntryPoint = "ClosePrinter", SetLastError = true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterA", SetLastError = true)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In] DOCINFOA di);
  [DllImport("winspool.drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", EntryPoint = "WritePrinter", SetLastError = true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);
  public static bool SendBytes(string printerName, byte[] bytes) {
    IntPtr hPrinter;
    if (!OpenPrinter(printerName.Normalize(), out hPrinter, IntPtr.Zero)) return false;
    var di = new DOCINFOA();
    di.pDocName = "Barcode";
    di.pDataType = "RAW";
    try {
      if (!StartDocPrinter(hPrinter, 1, di)) return false;
      if (!StartPagePrinter(hPrinter)) { EndDocPrinter(hPrinter); return false; }
      IntPtr p = Marshal.AllocCoTaskMem(bytes.Length);
      Marshal.Copy(bytes, 0, p, bytes.Length);
      int written;
      bool ok = WritePrinter(hPrinter, p, bytes.Length, out written);
      Marshal.FreeCoTaskMem(p);
      EndPagePrinter(hPrinter);
      EndDocPrinter(hPrinter);
      return ok;
    } finally {
      ClosePrinter(hPrinter);
    }
  }
}
`

async function printWindows(printer, commands) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'barcode-print-'))
  const payloadPath = path.join(dir, 'label.bin')
  const scriptPath = path.join(dir, 'print.ps1')

  try {
    await writeFile(payloadPath, commands, 'utf8')
    const script = `
Add-Type -TypeDefinition @'
${RAW_PRINTER_CS}
'@
$bytes = [System.IO.File]::ReadAllBytes(${JSON.stringify(payloadPath)})
$ok = [RawPrinterHelper]::SendBytes(${JSON.stringify(printer)}, $bytes)
if (-not $ok) { throw "Windows spooler rejected RAW job for printer ${printer}" }
`
    await writeFile(scriptPath, script, 'utf8')
    await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function listPrinters() {
  if (PLATFORM === 'win32') return listWindowsPrinters()
  return listCupsPrinters()
}

async function printRaw(printerName, commands) {
  if (typeof commands !== 'string' || !commands.trim()) {
    throw new Error('Print payload is empty.')
  }

  const { printers, defaultPrinter } = await listPrinters()
  const target = printerName === 'default' || !printerName ? defaultPrinter : printerName

  if (!target) throw new Error('No printers are installed on this computer.')
  if (!printers.includes(target)) throw new Error(`Printer "${target}" was not found.`)

  if (PLATFORM === 'win32') {
    await printWindows(target, commands)
  } else {
    await printCups(target, commands)
  }

  return { printer: target }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

const MAX_BODY = 200_000

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
  const headers = {
    ...corsHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  }
  res.writeHead(status, headers)
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('Request too large.'))
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
  try {
    return new URL(req.url || '/', 'http://localhost').pathname
  } catch {
    return (req.url || '/').split('?')[0]
  }
}

// ── Request handler ───────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const pathname = pathnameOf(req)

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders())
    res.end()
    return
  }

  // Health / discovery
  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, agent: 'labelpress', version: '1.0.0', platform: PLATFORM })
    return
  }

  // List printers
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
    return
  }

  // Print job
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
    return
  }

  // 404
  sendJson(res, 404, { ok: false, error: 'Not found.' })
}

// ── Start ─────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res)
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : 'Internal error.',
    })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('')
  console.log('  ██╗      █████╗ ██████╗ ███████╗██╗     ')
  console.log('  ██║     ██╔══██╗██╔══██╗██╔════╝██║     ')
  console.log('  ██║     ███████║██████╔╝█████╗  ██║     ')
  console.log('  ██║     ██╔══██║██╔══██╗██╔══╝  ██║     ')
  console.log('  ███████╗██║  ██║██████╔╝███████╗███████╗')
  console.log('  ╚══════╝╚═╝  ╚═╝╚═════╝ ╚══════╝╚══════╝')
  console.log('')
  console.log('  LabelPress Agent is running!')
  console.log(`  Listening on : http://localhost:${PORT}`)
  console.log(`  Platform     : ${PLATFORM}`)
  console.log(`  Allowed from : ${ALLOWED_ORIGIN}`)
  console.log('')
  console.log('  Keep this window open while printing.')
  console.log('  Press Ctrl+C to stop.')
  console.log('')
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ✖ Port ${PORT} is already in use.`)
    console.error(`    Is the agent already running? If so, you\'re all set!`)
    console.error(`    To use a different port: node labelpress-agent.mjs --port 47475\n`)
  } else {
    console.error('\n  ✖ Server error:', err.message, '\n')
  }
  process.exit(1)
})
