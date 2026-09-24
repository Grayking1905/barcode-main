#!/usr/bin/env node
/**
 * LabelPress Agent  v2.0
 * ─────────────────────────────────────────────────────────────────────────────
 * A zero-dependency local bridge between your deployed web app and any printer
 * connected to this PC. Runs on both Windows and Linux with no npm installs.
 *
 * ENDPOINTS
 *   GET  /api/health           → liveness check
 *   GET  /api/printers         → list system spooler printers (Windows / CUPS)
 *   GET  /api/usb-devices      → list raw USB printer device paths (Linux only)
 *   POST /api/print            → send raw ZPL / EPL / TSPL via spooler
 *   POST /api/print-usb        → send raw commands to a USB device path (Linux)
 *   POST /api/print-usb-win    → send raw commands to USB via Windows WriteFile
 *
 * USAGE
 *   node labelpress-agent.mjs
 *   node labelpress-agent.mjs --port 47474 --host 0.0.0.0
 *   node labelpress-agent.mjs --allow-origin "https://your-app.vercel.app"
 *
 * ENVIRONMENT VARIABLES (override CLI flags)
 *   LABELPRESS_PORT     default: 47474
 *   LABELPRESS_HOST     default: 0.0.0.0  (all interfaces)
 *   LABELPRESS_ORIGIN   default: *
 */

import http from 'node:http'
import { execFile, exec } from 'node:child_process'
import { mkdtemp, writeFile, rm, readdir, open } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
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
const HOST = argValue('--host') || process.env.LABELPRESS_HOST || '0.0.0.0'
const ALLOWED_ORIGIN = argValue('--allow-origin') || process.env.LABELPRESS_ORIGIN || '*'
const PLATFORM = process.platform
const IS_WIN = PLATFORM === 'win32'
const IS_LINUX = PLATFORM === 'linux'
const IS_MAC = PLATFORM === 'darwin'

// ── Logging ───────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString().replace('T', ' ').substring(0, 23)
}

function log(level, ...msg) {
  const prefix = {
    INFO: '\x1b[36mINFO \x1b[0m',
    OK:   '\x1b[32m OK  \x1b[0m',
    WARN: '\x1b[33mWARN \x1b[0m',
    ERR:  '\x1b[31m ERR \x1b[0m',
  }[level] || '     '
  console.log(`  ${ts()}  ${prefix}`, ...msg)
}

// ── Subprocess helper ─────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile)

function run(file, runArgs = [], options = {}) {
  log('INFO', `run: ${file} ${runArgs.join(' ')}`)
  return execFileAsync(file, runArgs, {
    timeout: 30_000,
    maxBuffer: 4_000_000,
    windowsHide: true,
    ...options,
  })
}

// ── Linux USB device helpers ──────────────────────────────────────────────────

/**
 * List raw USB printer device nodes on Linux.
 * Returns paths like /dev/usb/lp0, /dev/usb/lp1, etc.
 */
async function listLinuxUsbDevices() {
  const devices = []

  // Method 1: /dev/usb/lp* nodes (classic kernel usblp)
  try {
    const dir = '/dev/usb'
    const entries = await readdir(dir).catch(() => [])
    for (const e of entries) {
      if (e.startsWith('lp')) {
        devices.push({ path: `${dir}/${e}`, type: 'usblp', name: `USB Printer (${e})` })
      }
    }
  } catch {
    // usblp not loaded or no printers
  }

  // Method 2: /dev/lp* nodes (parallel port style but some USB printers use this)
  try {
    const entries = await readdir('/dev').catch(() => [])
    for (const e of entries) {
      if (e.startsWith('lp') && !devices.some(d => d.path === `/dev/${e}`)) {
        devices.push({ path: `/dev/${e}`, type: 'lp', name: `Printer port (${e})` })
      }
    }
  } catch {
    // ignore
  }

  // Method 3: Use lsusb to find USB printers by class (class 07 = Printer)
  try {
    const { stdout } = await run('lsusb', ['-v'], { timeout: 5000 }).catch(() => ({ stdout: '' }))
    // parse bInterfaceClass 7 (Printer) entries
    const vendorProductRegex = /ID\s+([0-9a-fA-F]{4}):([0-9a-fA-F]{4})\s+(.*)/g
    let m
    while ((m = vendorProductRegex.exec(stdout)) !== null) {
      // rough heuristic - include only if "print" in name or common VIDs
      if (m[3].toLowerCase().includes('print') || m[3].toLowerCase().includes('zebra') || m[3].toLowerCase().includes('tsc')) {
        const vid = m[1].toLowerCase()
        const pid = m[2].toLowerCase()
        if (!devices.some(d => d.vid === vid && d.pid === pid)) {
          devices.push({ vid, pid, type: 'usb', name: m[3].trim() || `USB ${vid}:${pid}` })
        }
      }
    }
  } catch {
    // lsusb not available
  }

  return devices
}

/**
 * Write raw print commands directly to a Linux USB device node.
 * This bypasses CUPS entirely - pure kernel I/O.
 */
async function printLinuxUsb(devicePath, commands) {
  log('INFO', `printLinuxUsb → ${devicePath}`)

  // Validate path
  if (!devicePath || !devicePath.startsWith('/dev/')) {
    throw new Error(`Invalid device path: "${devicePath}". Must start with /dev/.`)
  }

  const data = Buffer.from(commands, 'utf8')

  // Open the device node for writing
  let fd
  try {
    fd = await open(devicePath, 'w')
  } catch (err) {
    if (err.code === 'EACCES') {
      throw new Error(
        `Permission denied on ${devicePath}.\n` +
        `Fix with: echo 'SUBSYSTEM=="usb", SUBSYSTEMS=="usb", KERNEL=="lp[0-9]*", MODE="0666"' | sudo tee /etc/udev/rules.d/99-usb-printer.rules\n` +
        `Then: sudo udevadm control --reload-rules && sudo udevadm trigger\n` +
        `Then unplug and replug your printer.`
      )
    }
    if (err.code === 'ENOENT') {
      throw new Error(
        `Device ${devicePath} not found. Is the printer plugged in?\n` +
        `Check available devices with: ls /dev/usb/`
      )
    }
    throw new Error(`Cannot open ${devicePath}: ${err.message}`)
  }

  try {
    await fd.write(data, 0, data.length, 0)
    log('OK', `Wrote ${data.length} bytes to ${devicePath}`)
  } finally {
    await fd.close().catch(() => {})
  }
}

// ── Windows USB direct helpers ─────────────────────────────────────────────────

/**
 * Send raw bytes to a USB printer on Windows via CreateFile / WriteFile Win32 API.
 * This writes to the \\.\USB00x device path that Windows exposes for USB printers
 * when using the standard usbprint.sys driver — no WinUSB needed!
 */
const RAW_USB_CS = `
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public class WinUsbRaw {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
  static extern SafeFileHandle CreateFile(
    string lpFileName, uint dwDesiredAccess, uint dwShareMode,
    IntPtr lpSecurityAttributes, uint dwCreationDisposition,
    uint dwFlagsAndAttributes, IntPtr hTemplateFile);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool WriteFile(SafeFileHandle hFile, byte[] lpBuffer,
    uint nNumberOfBytesToWrite, out uint lpNumberOfBytesWritten,
    IntPtr lpOverlapped);

  const uint GENERIC_WRITE    = 0x40000000;
  const uint FILE_SHARE_READ  = 0x00000001;
  const uint FILE_SHARE_WRITE = 0x00000002;
  const uint OPEN_EXISTING    = 3;

  public static string SendToDevice(string devicePath, byte[] data) {
    var handle = CreateFile(devicePath, GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
    if (handle.IsInvalid) {
      int err = Marshal.GetLastWin32Error();
      return "ERROR: CreateFile failed on " + devicePath +
             " (Win32 error " + err + "). Is the printer plugged in via USB and powered on?";
    }
    try {
      uint written;
      bool ok = WriteFile(handle, data, (uint)data.Length, out written, IntPtr.Zero);
      if (!ok) {
        int err = Marshal.GetLastWin32Error();
        return "ERROR: WriteFile failed (Win32 error " + err + ")";
      }
      return "OK:" + written;
    } finally {
      handle.Close();
    }
  }

  // Probe \\.\USB001 through \\.\USB020; returns port names that can be opened
  public static string[] ListUsbPorts() {
    var found = new System.Collections.Generic.List<string>();
    for (int i = 1; i <= 20; i++) {
      string portNum = i.ToString("D3");
      string p = @"\\.\USB" + portNum;
      var h = CreateFile(p, GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
      if (!h.IsInvalid) { found.Add("USB" + portNum); h.Close(); }
    }
    return found.ToArray();
  }
}
`

async function listWindowsUsbPrinterPorts() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lp-usblist-'))
  const scriptPath = path.join(dir, 'list.ps1')
  try {
    // Three detection methods combined:
    //   1. Get-PrinterPort  — registered USB spooler ports (USB001 etc.)
    //   2. Get-Printer      — port names from installed printers
    //   3. CreateFile probe — works even with no spooler entry (raw usbprint.sys)
    const script = `
$ports = @()
try {
  $pp = Get-PrinterPort -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "USB*" }
  foreach ($p in $pp) { if ($ports -notcontains $p.Name) { $ports += $p.Name } }
} catch {}
try {
  Get-Printer -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.PortName -like "USB*" -and ($ports -notcontains $_.PortName)) { $ports += $_.PortName }
  }
} catch {}
Add-Type -TypeDefinition @'
${RAW_USB_CS}
'@
try {
  $raw = [WinUsbRaw]::ListUsbPorts()
  foreach ($p in $raw) { if ($ports -notcontains $p) { $ports += $p } }
} catch {}
if ($ports.Count -eq 0) { Write-Output "NONE" }
else { $ports | ForEach-Object { Write-Output $_ } }
`
    await writeFile(scriptPath, script, 'utf8')
    const { stdout } = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    ])
    const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    if (lines[0] === 'NONE' || lines.length === 0) return []
    return lines.map(port => ({ path: `\\\\.\\${port}`, type: 'usbport', name: `USB Printer Port (${port})` }))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}


async function printWindowsUsb(devicePath, commands) {
  log('INFO', `printWindowsUsb → ${devicePath}`)
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lp-usbprint-'))
  const payloadPath = path.join(dir, 'label.bin')
  const scriptPath = path.join(dir, 'print.ps1')
  try {
    await writeFile(payloadPath, Buffer.from(commands, 'utf8'))
    const script = `
Add-Type -TypeDefinition @'
${RAW_USB_CS}
'@
$bytes = [System.IO.File]::ReadAllBytes(${JSON.stringify(payloadPath)})
$result = [WinUsbRaw]::SendToDevice(${JSON.stringify(devicePath)}, $bytes)
Write-Output $result
`
    await writeFile(scriptPath, script, 'utf8')
    const { stdout } = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    ])
    const out = stdout.trim()
    log('INFO', `WinUsbRaw result: ${out}`)
    if (out.startsWith('ERROR:')) throw new Error(out.replace(/^ERROR:\s*/, ''))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ── Windows Spooler (RAW job) ─────────────────────────────────────────────────

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
  [DllImport("winspool.drv", EntryPoint="OpenPrinterA", SetLastError=true)]
  public static extern bool OpenPrinter(string n, out IntPtr h, IntPtr pd);
  [DllImport("winspool.drv", EntryPoint="ClosePrinter")]
  public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", EntryPoint="StartDocPrinterA", SetLastError=true)]
  public static extern bool StartDocPrinter(IntPtr h, int l, [In] DOCINFOA di);
  [DllImport("winspool.drv", EntryPoint="EndDocPrinter")]
  public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", EntryPoint="StartPagePrinter", SetLastError=true)]
  public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", EntryPoint="EndPagePrinter")]
  public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", EntryPoint="WritePrinter", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr h, IntPtr p, int n, out int w);
  public static bool SendBytes(string name, byte[] bytes) {
    IntPtr hPrinter;
    if (!OpenPrinter(name.Normalize(), out hPrinter, IntPtr.Zero)) return false;
    var di = new DOCINFOA { pDocName="LabelPress", pDataType="RAW" };
    try {
      if (!StartDocPrinter(hPrinter, 1, di)) return false;
      if (!StartPagePrinter(hPrinter)) { EndDocPrinter(hPrinter); return false; }
      IntPtr p = Marshal.AllocCoTaskMem(bytes.Length);
      Marshal.Copy(bytes, 0, p, bytes.Length);
      int w; bool ok = WritePrinter(hPrinter, p, bytes.Length, out w);
      Marshal.FreeCoTaskMem(p);
      EndPagePrinter(hPrinter); EndDocPrinter(hPrinter);
      return ok;
    } finally { ClosePrinter(hPrinter); }
  }
}
`

async function printWindows(printer, commands) {
  log('INFO', `printWindows spooler → "${printer}"`)
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lp-spooler-'))
  const payloadPath = path.join(dir, 'label.bin')
  const scriptPath = path.join(dir, 'print.ps1')
  try {
    // Write raw bytes (not utf8 string) so that EPL/ZPL control chars survive
    await writeFile(payloadPath, Buffer.from(commands, 'utf8'))
    const script = `
Add-Type -TypeDefinition @'
${RAW_PRINTER_CS}
'@
$bytes = [System.IO.File]::ReadAllBytes(${JSON.stringify(payloadPath)})
$ok = [RawPrinterHelper]::SendBytes(${JSON.stringify(printer)}, $bytes)
if (-not $ok) {
  $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  throw "Spooler rejected RAW job for '${printer}' (Win32 error $err). Is the printer online?"
}
Write-Output "OK"
`
    await writeFile(scriptPath, script, 'utf8')
    const { stdout, stderr } = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    ])
    log('INFO', `PS stdout: ${stdout.trim()}`)
    if (stderr.trim()) log('WARN', `PS stderr: ${stderr.trim()}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ── CUPS (Linux / macOS) ──────────────────────────────────────────────────────

function parseLpstatPrinters(stdout) {
  return stdout
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => l.split(/\s+/)[0])
    .filter(Boolean)
}

async function defaultCupsPrinter() {
  try {
    const { stdout } = await run('lpstat', ['-d'])
    const m = stdout.match(/destination:\s*(.+)\s*$/m)
    return m?.[1]?.trim() || ''
  } catch {
    return ''
  }
}

async function listCupsPrinters() {
  try {
    const { stdout } = await run('lpstat', ['-a'])
    const printers = parseLpstatPrinters(stdout)
    const defaultPrinter = (await defaultCupsPrinter()) || printers[0] || ''
    return { printers, defaultPrinter }
  } catch (err) {
    log('WARN', `lpstat failed: ${err.message}. No CUPS printers found.`)
    return { printers: [], defaultPrinter: '' }
  }
}

async function printCups(printer, commands) {
  log('INFO', `printCups → "${printer}"`)
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lp-cups-'))
  const filePath = path.join(dir, 'label.bin')
  try {
    await writeFile(filePath, Buffer.from(commands, 'utf8'))
    const lpArgs = ['-o', 'raw', '-o', 'job-sheets=none', '-n', '1']
    if (printer && printer !== 'default') lpArgs.push('-d', printer)
    lpArgs.push('--', filePath)
    const { stdout, stderr } = await run('lp', lpArgs)
    log('INFO', `lp stdout: ${stdout.trim()}`)
    if (stderr.trim()) log('WARN', `lp stderr: ${stderr.trim()}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ── Windows Spooler printer list ──────────────────────────────────────────────

async function listWindowsPrinters() {
  log('INFO', 'Listing Windows printers via Get-Printer / Get-CimInstance...')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lp-printers-'))
  const scriptPath = path.join(dir, 'printers.ps1')
  const script = `
$printers = @()
# Method 1: Get-Printer (modern, most complete)
try {
  $p = Get-Printer -ErrorAction Stop
  foreach ($item in $p) {
    $isDefault = if ($item.Default -eq $true) { "True" } else { "False" }
    $printers += $item.Name + [char]9 + $isDefault
  }
} catch {}
# Method 2: WMI fallback
if ($printers.Count -eq 0) {
  try {
    $p = Get-CimInstance Win32_Printer -ErrorAction Stop
    foreach ($item in $p) {
      $isDefault = if ($item.Default -eq $true) { "True" } else { "False" }
      $printers += $item.Name + [char]9 + $isDefault
    }
  } catch {}
}
$printers | ForEach-Object { Write-Output $_ }
`
  try {
    await writeFile(scriptPath, script, 'utf8')
    const { stdout } = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    ])
    const printers = []
    let defaultPrinter = ''
    for (const line of stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
      const [name, isDefault] = line.split('\t')
      if (!name) continue
      printers.push(name)
      if (isDefault === 'True' && !defaultPrinter) defaultPrinter = name
    }
    log('OK', `Found ${printers.length} spooler printer(s)`)
    return { printers, defaultPrinter: defaultPrinter || printers[0] || '' }
  } catch (err) {
    log('ERR', `Failed to list Windows printers: ${err.message}`)
    return { printers: [], defaultPrinter: '' }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// ── Unified printer / USB lists ───────────────────────────────────────────────

async function listPrinters() {
  if (IS_WIN) return listWindowsPrinters()
  return listCupsPrinters()
}

async function listUsbDevices() {
  if (IS_WIN) {
    try {
      return await listWindowsUsbPrinterPorts()
    } catch (err) {
      log('WARN', `Windows USB port list failed: ${err.message}`)
      return []
    }
  }
  if (IS_LINUX || IS_MAC) {
    return listLinuxUsbDevices()
  }
  return []
}

async function printRaw(printerName, commands) {
  if (typeof commands !== 'string' || !commands.trim()) {
    throw new Error('Print payload is empty.')
  }
  const { printers, defaultPrinter } = await listPrinters()
  const target = printerName === 'default' || !printerName ? defaultPrinter : printerName
  if (!target) throw new Error('No printers found. Is the printer installed in your OS?')
  if (!printers.includes(target)) {
    throw new Error(
      `Printer "${target}" was not found.\n` +
      `Available printers: ${printers.length > 0 ? printers.join(', ') : '(none)'}`
    )
  }
  if (IS_WIN) {
    await printWindows(target, commands)
  } else {
    await printCups(target, commands)
  }
  return { printer: target }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

const MAX_BODY = 500_000

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGIN === '*' ? '*' : (origin || ALLOWED_ORIGIN)
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  }
}

function sendJson(res, status, payload, origin) {
  const body = JSON.stringify(payload)
  const headers = {
    ...corsHeaders(origin),
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
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('Request body too large (max 500 KB).'))
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
  const origin = req.headers['origin'] || ''
  const method = req.method || 'GET'

  log('INFO', `${method} ${pathname}  [${origin || req.headers['host'] || 'local'}]`)

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin))
    res.end()
    return
  }

  // ── GET /api/health ──────────────────────────────────────────────────────
  if (pathname === '/api/health' && method === 'GET') {
    const localIPs = Object.values(os.networkInterfaces())
      .flat()
      .filter(i => i && !i.internal && i.family === 'IPv4')
      .map(i => i.address)
    sendJson(res, 200, {
      ok: true,
      agent: 'labelpress',
      version: '2.0.0',
      platform: PLATFORM,
      hostname: os.hostname(),
      localIPs,
    }, origin)
    log('OK', 'Health check')
    return
  }

  // ── GET /api/printers ────────────────────────────────────────────────────
  if (pathname === '/api/printers' && method === 'GET') {
    try {
      const result = await listPrinters()
      log('OK', `Printers: [${result.printers.join(', ')}]  default="${result.defaultPrinter}"`)
      sendJson(res, 200, { ok: true, ...result }, origin)
    } catch (err) {
      log('ERR', err.message)
      sendJson(res, 500, { ok: false, printers: [], defaultPrinter: '', error: err.message }, origin)
    }
    return
  }

  // ── GET /api/usb-devices ─────────────────────────────────────────────────
  if (pathname === '/api/usb-devices' && method === 'GET') {
    try {
      const devices = await listUsbDevices()
      log('OK', `USB devices: ${JSON.stringify(devices)}`)
      sendJson(res, 200, { ok: true, devices }, origin)
    } catch (err) {
      log('ERR', err.message)
      sendJson(res, 500, { ok: false, devices: [], error: err.message }, origin)
    }
    return
  }

  // ── POST /api/print ──────────────────────────────────────────────────────
  if (pathname === '/api/print' && method === 'POST') {
    try {
      const text = await readBody(req)
      const payload = text ? JSON.parse(text) : {}
      const printer = typeof payload.printer === 'string' ? payload.printer : 'default'
      const commands = typeof payload.commands === 'string' ? payload.commands : ''
      log('INFO', `Print job → printer="${printer}" commands=${commands.length} chars`)
      const result = await printRaw(printer, commands)
      log('OK', `Printed to "${result.printer}"`)
      sendJson(res, 200, { ok: true, ...result }, origin)
    } catch (err) {
      log('ERR', `Print failed: ${err.message}`)
      sendJson(res, 500, { ok: false, error: err.message }, origin)
    }
    return
  }

  // ── POST /api/print-usb (Linux/Mac raw USB device path) ──────────────────
  if (pathname === '/api/print-usb' && method === 'POST') {
    if (IS_WIN) {
      sendJson(res, 400, {
        ok: false,
        error: 'Use /api/print-usb-win on Windows. /api/print-usb is for Linux/macOS.',
      }, origin)
      return
    }
    try {
      const text = await readBody(req)
      const payload = text ? JSON.parse(text) : {}
      const devicePath = typeof payload.devicePath === 'string' ? payload.devicePath : ''
      const commands = typeof payload.commands === 'string' ? payload.commands : ''
      if (!devicePath) throw new Error('Missing "devicePath" in request body (e.g. "/dev/usb/lp0").')
      if (!commands) throw new Error('Missing "commands" in request body.')
      log('INFO', `Raw USB write → ${devicePath}  ${commands.length} chars`)
      await printLinuxUsb(devicePath, commands)
      log('OK', `Raw USB write done → ${devicePath}`)
      sendJson(res, 200, { ok: true, devicePath }, origin)
    } catch (err) {
      log('ERR', `USB print failed: ${err.message}`)
      sendJson(res, 500, { ok: false, error: err.message }, origin)
    }
    return
  }

  // ── POST /api/print-usb-win (Windows raw USB port: \\.\USB001) ───────────
  if (pathname === '/api/print-usb-win' && method === 'POST') {
    if (!IS_WIN) {
      sendJson(res, 400, {
        ok: false,
        error: 'Use /api/print-usb on Linux/macOS. /api/print-usb-win is for Windows.',
      }, origin)
      return
    }
    try {
      const text = await readBody(req)
      const payload = text ? JSON.parse(text) : {}
      const devicePath = typeof payload.devicePath === 'string' ? payload.devicePath : ''
      const commands = typeof payload.commands === 'string' ? payload.commands : ''
      if (!devicePath) throw new Error('Missing "devicePath" in request body (e.g. "\\\\.\\USB001").')
      if (!commands) throw new Error('Missing "commands" in request body.')
      log('INFO', `Windows USB write → ${devicePath}  ${commands.length} chars`)
      await printWindowsUsb(devicePath, commands)
      log('OK', `Windows USB write done → ${devicePath}`)
      sendJson(res, 200, { ok: true, devicePath }, origin)
    } catch (err) {
      log('ERR', `Windows USB print failed: ${err.message}`)
      sendJson(res, 500, { ok: false, error: err.message }, origin)
    }
    return
  }

  // ── POST /api/print-auto (Windows: auto USB → spooler fallback) ───────────
  if (pathname === '/api/print-auto' && method === 'POST') {
    if (!IS_WIN) {
      sendJson(res, 400, { ok: false, error: 'Use /api/print on Linux/macOS. /api/print-auto is Windows-only.' }, origin)
      return
    }
    try {
      const text = await readBody(req)
      const payload = text ? JSON.parse(text) : {}
      const commands      = typeof payload.commands   === 'string' ? payload.commands   : ''
      const preferredPort = typeof payload.devicePath === 'string' ? payload.devicePath : ''
      if (!commands) throw new Error('Missing "commands" in request body.')
      log('INFO', `Auto-print: ${commands.length} chars, preferredPort="${preferredPort}"`)
      let usedMethod = ''
      // 1. Try the caller's preferred port
      if (preferredPort) {
        try { await printWindowsUsb(preferredPort, commands); usedMethod = `usb:${preferredPort}` }
        catch (e) { log('WARN', `Preferred port failed: ${e.message}`) }
      }
      // 2. Try all auto-detected USB ports
      if (!usedMethod) {
        for (const dev of await listUsbDevices()) {
          try { await printWindowsUsb(dev.path, commands); usedMethod = `usb:${dev.path}`; break }
          catch (e) { log('WARN', `USB ${dev.path} failed: ${e.message}`) }
        }
      }
      // 3. Fall back to Windows spooler
      if (!usedMethod) {
        log('INFO', 'No USB port succeeded — falling back to Windows spooler')
        const result = await printRaw('default', commands)
        usedMethod = `spooler:${result.printer}`
      }
      log('OK', `Auto-print done via ${usedMethod}`)
      sendJson(res, 200, { ok: true, method: usedMethod }, origin)
    } catch (err) {
      log('ERR', `Auto-print failed: ${err.message}`)
      sendJson(res, 500, { ok: false, error: err.message }, origin)
    }
    return
  }

  // ── 404 ──────────────────────────────────────────────────────────────────
  sendJson(res, 404, {
    ok: false,
    error: `No route: ${method} ${pathname}`,
    routes: [
      'GET  /api/health',
      'GET  /api/printers',
      'GET  /api/usb-devices',
      'POST /api/print              { printer, commands }',
      'POST /api/print-usb          { devicePath, commands }  (Linux)',
      'POST /api/print-usb-win      { devicePath, commands }  (Windows)',
      'POST /api/print-auto         { commands [, devicePath] }  (Windows auto)',
    ],
  }, origin)
}

// ── Start ─────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res)
  } catch (err) {
    log('ERR', `Unhandled: ${err.message}`)
    try {
      const origin = req.headers['origin'] || ''
      sendJson(res, 500, { ok: false, error: err.message || 'Internal error.' }, origin)
    } catch { /* response already sent */ }
  }
})

server.listen(PORT, HOST, () => {
  const localIPs = Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i && !i.internal && i.family === 'IPv4')
    .map(i => `  http://${i.address}:${PORT}`)

  console.log('')
  console.log('  \x1b[36m██╗      █████╗ ██████╗ ███████╗██╗     \x1b[0m')
  console.log('  \x1b[36m██║     ██╔══██╗██╔══██╗██╔════╝██║     \x1b[0m')
  console.log('  \x1b[36m██║     ███████║██████╔╝█████╗  ██║     \x1b[0m')
  console.log('  \x1b[36m██║     ██╔══██║██╔══██╗██╔══╝  ██║     \x1b[0m')
  console.log('  \x1b[36m███████╗██║  ██║██████╔╝███████╗███████╗\x1b[0m')
  console.log('  \x1b[36m╚══════╝╚═╝  ╚═╝╚═════╝ ╚══════╝╚══════╝\x1b[0m')
  console.log('')
  console.log('  \x1b[32mLabelPress Agent v2.0 is running!\x1b[0m')
  console.log(`  Platform     : \x1b[33m${PLATFORM}\x1b[0m`)
  console.log(`  Allowed from : \x1b[33m${ALLOWED_ORIGIN}\x1b[0m`)
  console.log('')
  console.log('  \x1b[1mListening on:\x1b[0m')
  console.log(`  http://localhost:${PORT}`)
  localIPs.forEach(ip => console.log(ip))
  console.log('')
  console.log('  \x1b[1mEndpoints:\x1b[0m')
  console.log(`  GET  http://localhost:${PORT}/api/health`)
  console.log(`  GET  http://localhost:${PORT}/api/printers`)
  console.log(`  GET  http://localhost:${PORT}/api/usb-devices`)
  console.log(`  POST http://localhost:${PORT}/api/print          (spooler)`)
  if (IS_WIN) {
    console.log(`  POST http://localhost:${PORT}/api/print-usb-win  (raw USB \\\\.\\USB00x)`)
  } else {
    console.log(`  POST http://localhost:${PORT}/api/print-usb      (raw /dev/usb/lp0)`)
  }
  console.log('')
  console.log('  Press Ctrl+C to stop.')
  console.log('')

  // Auto-print discovered printers and USB devices on startup
  listPrinters().then(({ printers, defaultPrinter }) => {
    if (printers.length > 0) {
      log('OK', `System printers found: ${printers.join(', ')}`)
      log('INFO', `Default printer: "${defaultPrinter}"`)
    } else {
      log('WARN', 'No system printers found (spooler/CUPS).')
    }
  }).catch(() => {})

  listUsbDevices().then(devices => {
    if (devices.length > 0) {
      log('OK', `USB printer devices: ${devices.map(d => d.path || d.name).join(', ')}`)
    } else {
      log('INFO', 'No raw USB printer devices found.')
    }
  }).catch(() => {})
})

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  \x1b[31m✖ Port ${PORT} is already in use.\x1b[0m`)
    console.error(`    Is the agent already running? Try: node labelpress-agent.mjs --port 47475\n`)
  } else {
    console.error(`\n  \x1b[31m✖ Server error: ${err.message}\x1b[0m\n`)
  }
  process.exit(1)
})

process.on('SIGINT', () => {
  console.log('\n\n  Shutting down LabelPress Agent. Goodbye!\n')
  server.close(() => process.exit(0))
})
