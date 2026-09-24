#!/usr/bin/env node
/**
 * LabelPress Agent  v3.0
 * ─────────────────────────────────────────────────────────────────────────────
 * A zero-dependency local bridge between your deployed web app and any USB
 * thermal label printer. Runs on Windows, Linux, and macOS with NO npm installs.
 *
 * DETECTION STRATEGY (tried in order on each platform):
 *
 *  Windows  → GUID_DEVINTERFACE_USBPRINT registry scan (Win32 CreateFile/WriteFile)
 *           → Spooler queue (only if a real label printer is registered)
 *
 *  Linux    → /dev/usb/lp*  (kernel usblp driver, most common)
 *           → /dev/lp*      (legacy parallel-port style)
 *           → lp/lpr via CUPS (fallback)
 *
 *  macOS    → /dev/usb/lp* / /dev/lp* (similar to Linux)
 *           → CUPS (lpstat / lp fallback)
 *
 * ENDPOINTS
 *   GET  /api/health           → liveness, platform info, discovered devices
 *   GET  /api/printers         → list system spooler / CUPS printers
 *   GET  /api/usb-devices      → list raw USB printer device paths (all platforms)
 *   POST /api/print-auto       → smart print: USB direct first, spooler/CUPS fallback
 *   POST /api/print            → spooler / CUPS print by name
 *   POST /api/print-usb        → raw write to Linux/macOS /dev/usb/lp* node
 *   POST /api/print-usb-win    → raw Win32 write via device interface path
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
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, rm, readdir, open, access } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

// ── Config ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
function argValue(flag) {
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] : undefined
}

const PORT           = Number(argValue('--port')         || process.env.LABELPRESS_PORT   || 47474)
const HOST           = argValue('--host')                || process.env.LABELPRESS_HOST   || '0.0.0.0'
const ALLOWED_ORIGIN = argValue('--allow-origin')        || process.env.LABELPRESS_ORIGIN || '*'
const PLATFORM       = process.platform    // 'win32' | 'linux' | 'darwin'
const IS_WIN         = PLATFORM === 'win32'
const IS_LINUX       = PLATFORM === 'linux'
const IS_MAC         = PLATFORM === 'darwin'
const AGENT_VERSION  = '3.0.0'

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

// ─────────────────────────────────────────────────────────────────────────────
// ██╗    ██╗██╗███╗   ██╗██████╗  ██████╗ ██╗    ██╗███████╗
// ██║    ██║██║████╗  ██║██╔══██╗██╔═══██╗██║    ██║██╔════╝
// ██║ █╗ ██║██║██╔██╗ ██║██║  ██║██║   ██║██║ █╗ ██║███████╗
// ██║███╗██║██║██║╚██╗██║██║  ██║██║   ██║██║███╗██║╚════██║
// ╚███╔███╔╝██║██║ ╚████║██████╔╝╚██████╔╝╚███╔███╔╝███████║
//  ╚══╝╚══╝ ╚═╝╚═╝  ╚═══╝╚═════╝  ╚═════╝  ╚══╝╚══╝ ╚══════╝
// ─────────────────────────────────────────────────────────────────────────────

// ── Windows: C# USB Direct via Win32 API ─────────────────────────────────────

/**
 * C# class compiled at runtime by PowerShell Add-Type.
 * Uses kernel32 CreateFile/WriteFile to open the USB device interface
 * path exposed by usbprint.sys → no driver replacement needed.
 */
const WIN_USB_CS = `
using System;
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

  // Returns "OK:<bytesWritten>" or "ERROR:<message>"
  public static string SendToDevice(string devicePath, byte[] data) {
    var handle = CreateFile(devicePath, GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
    if (handle.IsInvalid) {
      int err = Marshal.GetLastWin32Error();
      return "ERROR:CreateFile failed (Win32 " + err + ") on " + devicePath;
    }
    try {
      uint written;
      bool ok = WriteFile(handle, data, (uint)data.Length, out written, IntPtr.Zero);
      if (!ok) {
        int err = Marshal.GetLastWin32Error();
        return "ERROR:WriteFile failed (Win32 " + err + ")";
      }
      return "OK:" + written;
    } finally {
      handle.Close();
    }
  }

  // Returns true if the device path can be opened for writing
  public static bool TestDevice(string devicePath) {
    var handle = CreateFile(devicePath, GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
    if (handle.IsInvalid) return false;
    handle.Close();
    return true;
  }
}
`

/**
 * Discover USB printers on Windows.
 * Primary: scan GUID_DEVINTERFACE_USBPRINT registry class
 *   → gives \\?\USB#VID_xxxx&PID_xxxx#serial#{guid} paths
 *   → works with usbprint.sys (no Zadig / WinUSB needed)
 * Secondary: Get-PnpDevice with Service=usbprint (for older Windows)
 * Tertiary:  Get-PrinterPort USB* (spooler registered ports)
 */
async function winListUsbPrinters() {
  const dir        = await mkdtemp(path.join(os.tmpdir(), 'lp-wlist-'))
  const scriptPath = path.join(dir, 'list.ps1')
  try {
    const script = `
Add-Type -TypeDefinition @'
${WIN_USB_CS}
'@

$results = [System.Collections.Generic.List[PSCustomObject]]::new()

# ── Method 1: GUID_DEVINTERFACE_USBPRINT registry scan ──────────────────────
$guid = '{28d78fad-5a12-11d1-ae5b-0000f803a8c2}'
$regBase = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\DeviceClasses\\$guid"
Get-ChildItem -Path $regBase -ErrorAction SilentlyContinue | ForEach-Object {
  $rawName = $_.PSChildName
  # Convert ##?#USB#... registry key name to \\?\\USB#... device path
  $devPath = $rawName -replace '^##\\?#', '\\\\?\\'
  $instId  = (Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue).DeviceInstance
  $friendly = if ($instId) {
    (Get-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\$instId" -ErrorAction SilentlyContinue).FriendlyName
  }
  $openable = [WinUsbRaw]::TestDevice($devPath)
  $results.Add([PSCustomObject]@{
    path     = $devPath
    name     = if ($friendly) { $friendly } else { "USB Printer" }
    type     = "usb-direct"
    openable = $openable
    method   = "devinterface"
  })
}

# ── Method 2: PnP device enumeration (older Windows / different driver) ──────
if ($results.Count -eq 0) {
  Get-PnpDevice -Class USB -ErrorAction SilentlyContinue |
    Where-Object { $_.Service -eq 'usbprint' -and $_.Status -eq 'OK' } |
    ForEach-Object {
      $dev = $_
      # Try USBPRINT device class interface for this instance
      $usbprintGuid = '{28d78fad-5a12-11d1-ae5b-0000f803a8c2}'
      $encoded = $dev.InstanceId -replace '\\\\', '#' -replace '&', '&'
      $devPath = "\\\\?\\$($encoded)#$($usbprintGuid)"
      $openable = [WinUsbRaw]::TestDevice($devPath)
      $results.Add([PSCustomObject]@{
        path     = $devPath
        name     = if ($dev.FriendlyName) { $dev.FriendlyName } else { "USB Printer" }
        type     = "usb-direct"
        openable = $openable
        method   = "pnpdevice"
      })
    }
}

# ── Method 3: Spooler USB ports (e.g. USB001) ───────────────────────────────
# These are Print Spooler symbolic names, NOT Win32 device paths.
# We include them so the UI can show them, but they need spooler printing.
Get-PrinterPort -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^USB\\d+$' } |
  ForEach-Object {
    if (-not ($results | Where-Object { $_.name -eq $_.Description })) {
      $results.Add([PSCustomObject]@{
        path     = "spooler:" + $_.Name
        name     = if ($_.Description) { $_.Description } else { "USB Spooler Port (" + $_.Name + ")" }
        type     = "spooler-port"
        openable = $false
        method   = "spoolerport"
      })
    }
  }

if ($results.Count -eq 0) {
  Write-Output "[]"
} else {
  $results | ConvertTo-Json -Compress -Depth 3
}
`
    await writeFile(scriptPath, script, 'utf8')
    const { stdout, stderr } = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    ])
    if (stderr && stderr.trim()) log('WARN', `winListUsbPrinters stderr: ${stderr.trim().split('\n')[0]}`)
    const text = stdout.trim()
    if (!text || text === 'null' || text === '[]') return []
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : [parsed]
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Send raw bytes to a Windows USB printer via Win32 CreateFile/WriteFile.
 * devicePath must be a \\?\USB#... device interface path (from winListUsbPrinters).
 */
async function winPrintUsb(devicePath, commands) {
  log('INFO', `winPrintUsb → ${devicePath}  (${commands.length} chars)`)
  const dir        = await mkdtemp(path.join(os.tmpdir(), 'lp-wprint-'))
  const payloadPath = path.join(dir, 'label.bin')
  const scriptPath  = path.join(dir, 'print.ps1')
  try {
    await writeFile(payloadPath, Buffer.from(commands, 'utf8'))
    // Single-quoted PS string: backslashes are NOT processed
    const psDp = devicePath.replace(/'/g, "''")
    const script = `
Add-Type -TypeDefinition @'
${WIN_USB_CS}
'@
$bytes  = [System.IO.File]::ReadAllBytes(${JSON.stringify(payloadPath)})
$dp     = '${psDp}'
$result = [WinUsbRaw]::SendToDevice($dp, $bytes)
Write-Output $result
`
    await writeFile(scriptPath, script, 'utf8')
    const { stdout, stderr } = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    ])
    const out = stdout.trim()
    log('INFO', `WinUsbRaw → "${out}"`)
    if (stderr && stderr.trim()) log('WARN', `PS stderr: ${stderr.trim().split('\n')[0]}`)
    if (!out.startsWith('OK:')) {
      throw new Error(out.replace(/^ERROR:/, '') || stderr.trim() || 'USB write returned empty output')
    }
    const bytes = parseInt(out.slice(3), 10)
    log('OK', `Written ${bytes} bytes to ${devicePath}`)
    return bytes
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// ── Windows Spooler (RAW job) ─────────────────────────────────────────────────

const WIN_SPOOLER_CS = `
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
    var di = new DOCINFOA { pDocName = "LabelPress", pDataType = "RAW" };
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

async function winPrintSpooler(printerName, commands) {
  log('INFO', `winPrintSpooler → "${printerName}"`)
  const dir         = await mkdtemp(path.join(os.tmpdir(), 'lp-spooler-'))
  const payloadPath = path.join(dir, 'label.bin')
  const scriptPath  = path.join(dir, 'print.ps1')
  try {
    await writeFile(payloadPath, Buffer.from(commands, 'utf8'))
    const script = `
Add-Type -TypeDefinition @'
${WIN_SPOOLER_CS}
'@
$bytes = [System.IO.File]::ReadAllBytes(${JSON.stringify(payloadPath)})
$ok    = [RawPrinterHelper]::SendBytes(${JSON.stringify(printerName)}, $bytes)
if (-not $ok) {
  $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  Write-Error "Spooler RAW job failed for '${printerName}' (Win32 $err)"
  exit 1
}
Write-Output "OK"
`
    await writeFile(scriptPath, script, 'utf8')
    const { stdout, stderr } = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    ])
    const out = stdout.trim()
    if (stderr.trim()) log('WARN', `PS spooler stderr: ${stderr.trim().split('\n')[0]}`)
    if (!out.startsWith('OK')) throw new Error(`Spooler print failed: ${out || stderr.trim()}`)
    log('OK', `Spooler print done → "${printerName}"`)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function winListSpoolerPrinters() {
  log('INFO', 'Listing Windows spooler printers...')
  const dir        = await mkdtemp(path.join(os.tmpdir(), 'lp-printers-'))
  const scriptPath = path.join(dir, 'printers.ps1')
  const script = `
$printers = @()
try {
  $p = Get-Printer -ErrorAction Stop
  foreach ($item in $p) {
    $isDefault = if ($item.Default -eq $true) { "True" } else { "False" }
    $printers += $item.Name + [char]9 + $isDefault
  }
} catch {}
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
      const [name, isDef] = line.split('\t')
      if (!name) continue
      printers.push(name)
      if (isDef === 'True' && !defaultPrinter) defaultPrinter = name
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

// ─────────────────────────────────────────────────────────────────────────────
// ██╗     ██╗███╗   ██╗██╗   ██╗██╗  ██╗
// ██║     ██║████╗  ██║██║   ██║╚██╗██╔╝
// ██║     ██║██╔██╗ ██║██║   ██║ ╚███╔╝
// ██║     ██║██║╚██╗██║██║   ██║ ██╔██╗
// ███████╗██║██║ ╚████║╚██████╔╝██╔╝ ██╗
// ╚══════╝╚═╝╚═╝  ╚═══╝ ╚═════╝ ╚═╝  ╚═╝
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Discover USB printer device nodes on Linux / macOS.
 * Returns paths like /dev/usb/lp0, /dev/lp0, etc.
 */
async function unixListUsbPrinters() {
  const devices = []
  const seen    = new Set()

  function add(p, type, name, openable = true, note = '') {
    if (!seen.has(p)) {
      seen.add(p)
      devices.push({ path: p, name, type, openable, method: type, note })
    }
  }

  // Method 1: /dev/usb/lp* — usblp kernel driver (most common on Linux)
  try {
    const entries = await readdir('/dev/usb').catch(() => [])
    for (const e of entries.filter(e => e.startsWith('lp'))) {
      const p = `/dev/usb/${e}`
      const writable = await access(p, fsConstants.W_OK).then(() => true).catch(() => false)
      add(
        p,
        'usblp',
        `USB Printer (/dev/usb/${e})`,
        writable,
        writable ? 'Ready' : 'Permission needed: sudo usermod -a -G lp $USER'
      )
    }
  } catch { /* /dev/usb not present */ }

  // Method 2: /dev/lp* — legacy or macOS usb printing
  try {
    const entries = await readdir('/dev').catch(() => [])
    for (const e of entries.filter(e => /^lp\d+$/.test(e))) {
      const p = `/dev/${e}`
      const writable = await access(p, fsConstants.W_OK).then(() => true).catch(() => false)
      add(
        p,
        'lp',
        `Printer port (/dev/${e})`,
        writable,
        writable ? 'Ready' : 'Permission needed: sudo usermod -a -G lp $USER'
      )
    }
  } catch { /* ignore */ }

  // Method 3: macOS IOKit / system_profiler to detect USB printers
  if (IS_MAC && devices.length === 0) {
    try {
      const { stdout } = await run('system_profiler', ['SPUSBDataType', '-json'], { timeout: 8000 })
        .catch(() => ({ stdout: '' }))
      if (stdout) {
        const data = JSON.parse(stdout)
        const usb = data.SPUSBDataType || []
        function walkUsb(items) {
          for (const item of items || []) {
            if (item._name && (item._name.toLowerCase().includes('print') ||
              item._name.toLowerCase().includes('zebra') ||
              item._name.toLowerCase().includes('tsc') ||
              item._name.toLowerCase().includes('dymo'))) {
              // macOS USB printers typically appear at /dev/lp* after IOKit loads
              devices.push({
                path: '', name: item._name, type: 'usb-detected',
                openable: false, method: 'sysprofile',
                note: 'Detected via system_profiler; path may be /dev/usb/lp0'
              })
            }
            walkUsb(item._items)
          }
        }
        walkUsb(usb)
      }
    } catch { /* system_profiler not available */ }
  }

  // Method 4: lsusb on Linux for identification (path resolution via /dev/usb/lp*)
  if (IS_LINUX && devices.length === 0) {
    try {
      const { stdout } = await run('lsusb', [], { timeout: 5000 }).catch(() => ({ stdout: '' }))
      for (const line of stdout.split('\n')) {
        const m = line.match(/Bus (\d+) Device (\d+): ID [0-9a-f:]+\s+(.+)/)
        if (m && /print|zebra|tsc|dymo|brother|bixolon/i.test(m[3])) {
          devices.push({
            path: '', name: m[3].trim(), type: 'usb-detected',
            openable: false, method: 'lsusb',
            note: 'Detected via lsusb; path likely /dev/usb/lp0 — check ls /dev/usb/'
          })
        }
      }
    } catch { /* lsusb not installed */ }
  }

  return devices
}

/**
 * Write raw bytes to a Linux/macOS /dev/usb/lp* or /dev/lp* node.
 * Completely bypasses CUPS — pure kernel I/O via usblp.
 */
async function unixPrintUsb(devicePath, commands) {
  log('INFO', `unixPrintUsb → ${devicePath}  (${commands.length} chars)`)

  if (!devicePath || !devicePath.startsWith('/dev/')) {
    throw new Error(`Invalid device path "${devicePath}". Must start with /dev/.`)
  }

  const data = Buffer.from(commands, 'utf8')
  let fd
  try {
    fd = await open(devicePath, 'w')
  } catch (err) {
    if (err.code === 'EACCES') {
      throw new Error(
        `Permission denied on ${devicePath}.\n` +
        `Fix with:\n` +
        `  sudo chmod 666 ${devicePath}\n` +
        `Or permanently:\n` +
        `  echo 'SUBSYSTEM=="usb", KERNEL=="lp[0-9]*", MODE="0666"' | sudo tee /etc/udev/rules.d/99-usb-printer.rules\n` +
        `  sudo udevadm control --reload-rules && sudo udevadm trigger\n` +
        `  (then unplug and replug the printer)`
      )
    }
    if (err.code === 'ENOENT') {
      throw new Error(
        `Device ${devicePath} not found. Is the printer plugged in?\n` +
        `Check: ls /dev/usb/ or ls /dev/lp*`
      )
    }
    throw new Error(`Cannot open ${devicePath}: ${err.message}`)
  }

  try {
    const { bytesWritten } = await fd.write(data)
    log('OK', `Written ${bytesWritten} bytes to ${devicePath}`)
    return bytesWritten
  } finally {
    await fd.close().catch(() => {})
  }
}

// ── CUPS (Linux / macOS) ──────────────────────────────────────────────────────

async function cupsListPrinters() {
  try {
    const { stdout } = await run('lpstat', ['-a'], { timeout: 8000 })
    const printers = stdout.split('\n')
      .map(l => l.trim()).filter(Boolean)
      .map(l => l.split(/\s+/)[0]).filter(Boolean)
    let defaultPrinter = ''
    try {
      const { stdout: d } = await run('lpstat', ['-d'])
      const m = d.match(/destination:\s*(.+)\s*$/m)
      defaultPrinter = m?.[1]?.trim() || ''
    } catch { /* ignore */ }
    return { printers, defaultPrinter: defaultPrinter || printers[0] || '' }
  } catch {
    return { printers: [], defaultPrinter: '' }
  }
}

async function cupsPrint(printerName, commands) {
  log('INFO', `cupsPrint → "${printerName}"`)
  const dir      = await mkdtemp(path.join(os.tmpdir(), 'lp-cups-'))
  const filePath = path.join(dir, 'label.bin')
  try {
    await writeFile(filePath, Buffer.from(commands, 'utf8'))
    const lpArgs = ['-o', 'raw', '-o', 'job-sheets=none', '-n', '1']
    if (printerName && printerName !== 'default') lpArgs.push('-d', printerName)
    lpArgs.push('--', filePath)
    const { stdout, stderr } = await run('lp', lpArgs)
    if (stdout.trim()) log('INFO', `lp: ${stdout.trim()}`)
    if (stderr.trim()) log('WARN', `lp stderr: ${stderr.trim()}`)
    log('OK', `CUPS print done → "${printerName}"`)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UNIFIED PLATFORM API
// ─────────────────────────────────────────────────────────────────────────────

/** List all printer-capable USB devices on current platform */
async function listUsbDevices() {
  try {
    if (IS_WIN)              return await winListUsbPrinters()
    if (IS_LINUX || IS_MAC)  return await unixListUsbPrinters()
  } catch (err) {
    log('WARN', `listUsbDevices error: ${err.message}`)
  }
  return []
}

/** List all system spooler / CUPS printers on current platform */
async function listSystemPrinters() {
  if (IS_WIN)              return winListSpoolerPrinters()
  if (IS_LINUX || IS_MAC)  return cupsListPrinters()
  return { printers: [], defaultPrinter: '' }
}

/**
 * Smart auto-print.
 * Tries in order:
 *  1. Direct USB write (preferred: fastest, no spooler, no driver needed)
 *  2. System spooler / CUPS (only real label printers; skips virtual printers)
 *
 * Returns { method, detail } describing what was used.
 */
async function autoPrint(commands, preferredDevicePath = '') {
  if (!commands || !commands.trim()) throw new Error('Print payload is empty.')

  const SKIP   = /OneNote|PDF|XPS|Fax|Microsoft|Snip|Send to|Scan|Virtual|cups-pdf/i
  const PREFER = /Zebra|ZTC|TSC|Dymo|Brother|Bixolon|SATO|Honeywell|label|pos|thermal/i

  // ── Windows path ────────────────────────────────────────────────────────────
  if (IS_WIN) {
    // 1a. Try caller-provided preferred device path (must be Win32 \\?\ path)
    if (preferredDevicePath && preferredDevicePath.startsWith('\\\\?\\')) {
      try {
        const b = await winPrintUsb(preferredDevicePath, commands)
        return { method: 'usb-direct', detail: preferredDevicePath, bytes: b }
      } catch (e) {
        log('WARN', `Preferred path failed: ${e.message}`)
      }
    }

    // 1b. Auto-detect and try all openable USB direct interfaces
    const usbDevices = await winListUsbPrinters()
    for (const dev of usbDevices.filter(d => d.type === 'usb-direct' && d.openable)) {
      try {
        const b = await winPrintUsb(dev.path, commands)
        return { method: 'usb-direct', detail: dev.path, name: dev.name, bytes: b }
      } catch (e) {
        log('WARN', `USB device ${dev.path} failed: ${e.message}`)
      }
    }

    // 2. Windows Spooler fallback — only real label printers
    log('INFO', 'No direct USB write succeeded → trying Windows Spooler')
    const { printers } = await winListSpoolerPrinters()
    let target = printers.find(p => PREFER.test(p)) ?? printers.find(p => !SKIP.test(p))
    if (!target) {
      throw new Error(
        'No physical printer found on Windows.\n' +
        'Ensure your printer is powered on and USB-connected.\n' +
        `USB devices found: ${usbDevices.map(d => d.name).join(', ') || 'none'}\n` +
        `Spooler printers: ${printers.join(', ') || 'none'}`
      )
    }
    await winPrintSpooler(target, commands)
    return { method: 'spooler', detail: target }
  }

  // ── Linux / macOS path ──────────────────────────────────────────────────────
  if (IS_LINUX || IS_MAC) {
    // 1a. Try caller-provided preferred /dev path
    if (preferredDevicePath && preferredDevicePath.startsWith('/dev/')) {
      try {
        const b = await unixPrintUsb(preferredDevicePath, commands)
        return { method: 'usb-direct', detail: preferredDevicePath, bytes: b }
      } catch (e) {
        log('WARN', `Preferred path failed: ${e.message}`)
      }
    }

    // 1b. Auto-detect /dev/usb/lp* and /dev/lp* nodes
    const usbDevices = await unixListUsbPrinters()
    for (const dev of usbDevices.filter(d => d.path && d.path.startsWith('/dev/') && d.openable)) {
      try {
        const b = await unixPrintUsb(dev.path, commands)
        return { method: 'usb-direct', detail: dev.path, name: dev.name, bytes: b }
      } catch (e) {
        log('WARN', `${dev.path} failed: ${e.message}`)
      }
    }

    // 2. CUPS fallback
    log('INFO', 'No direct USB write succeeded → trying CUPS')
    const { printers, defaultPrinter } = await cupsListPrinters()
    let target = printers.find(p => PREFER.test(p))
      ?? printers.find(p => !SKIP.test(p))
      ?? defaultPrinter
    if (!target) {
      throw new Error(
        'No physical printer found on Linux/macOS.\n' +
        `USB devices checked: ${usbDevices.map(d => d.path || d.name).join(', ') || 'none'}\n` +
        `CUPS printers: ${printers.join(', ') || 'none'}\n` +
        'Check: ls /dev/usb/  and  lpstat -a'
      )
    }
    await cupsPrint(target, commands)
    return { method: 'cups', detail: target }
  }

  throw new Error(`Unsupported platform: ${PLATFORM}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP LAYER
// ─────────────────────────────────────────────────────────────────────────────

const MAX_BODY = 500_000

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGIN === '*' ? (origin || '*') : ALLOWED_ORIGIN
  return {
    'Access-Control-Allow-Origin':          allow,
    'Access-Control-Allow-Methods':         'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':         'Content-Type, Authorization, X-Requested-With, *',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age':               '86400',
    'Vary':                                 'Origin',
  }
}

function sendJson(res, status, payload, origin) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    ...corsHeaders(origin),
    'Content-Type':   'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) { reject(new Error('Request body too large (max 500 KB).')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end',   () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function pathnameOf(req) {
  try   { return new URL(req.url || '/', 'http://localhost').pathname }
  catch { return (req.url || '/').split('?')[0] }
}

// ── Request handler ───────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const pathname = pathnameOf(req)
  const origin   = req.headers['origin'] || ''
  const method   = req.method || 'GET'

  log('INFO', `${method} ${pathname}  [${origin || req.headers['host'] || 'local'}]`)

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin))
    res.end()
    return
  }

  // ── GET /api/health ────────────────────────────────────────────────────────
  if (pathname === '/api/health' && method === 'GET') {
    const localIPs = Object.values(os.networkInterfaces())
      .flat().filter(i => i && !i.internal && i.family === 'IPv4').map(i => i.address)
    sendJson(res, 200, {
      ok: true, agent: 'labelpress', version: AGENT_VERSION,
      platform: PLATFORM, hostname: os.hostname(), localIPs,
    }, origin)
    log('OK', 'Health check')
    return
  }

  // ── GET /api/printers ──────────────────────────────────────────────────────
  if (pathname === '/api/printers' && method === 'GET') {
    try {
      const result = await listSystemPrinters()
      log('OK', `Printers: [${result.printers.join(', ')}]  default="${result.defaultPrinter}"`)
      sendJson(res, 200, { ok: true, ...result }, origin)
    } catch (err) {
      log('ERR', err.message)
      sendJson(res, 500, { ok: false, printers: [], defaultPrinter: '', error: err.message }, origin)
    }
    return
  }

  // ── GET /api/usb-devices ───────────────────────────────────────────────────
  if (pathname === '/api/usb-devices' && method === 'GET') {
    try {
      const devices = await listUsbDevices()
      log('OK', `USB devices (${devices.length}): ${JSON.stringify(devices.map(d => d.name || d.path))}`)
      sendJson(res, 200, { ok: true, devices, platform: PLATFORM }, origin)
    } catch (err) {
      log('ERR', err.message)
      sendJson(res, 500, { ok: false, devices: [], error: err.message }, origin)
    }
    return
  }

  // ── POST /api/print-auto ───────────────────────────────────────────────────
  // Universal endpoint: works on ALL platforms, tries USB direct first
  if (pathname === '/api/print-auto' && method === 'POST') {
    try {
      const text    = await readBody(req)
      const payload = text ? JSON.parse(text) : {}
      const commands      = typeof payload.commands   === 'string' ? payload.commands   : ''
      const preferredPort = typeof payload.devicePath === 'string' ? payload.devicePath : ''
      if (!commands) throw new Error('Missing "commands" in request body.')
      log('INFO', `Auto-print: ${commands.length} chars, preferred="${preferredPort}" [${PLATFORM}]`)
      const result = await autoPrint(commands, preferredPort)
      log('OK', `Auto-print via ${result.method}: ${result.detail}`)
      sendJson(res, 200, { ok: true, ...result }, origin)
    } catch (err) {
      log('ERR', `Auto-print failed: ${err.message}`)
      sendJson(res, 500, { ok: false, error: err.message }, origin)
    }
    return
  }

  // ── POST /api/print (spooler/CUPS by name) ─────────────────────────────────
  if (pathname === '/api/print' && method === 'POST') {
    try {
      const text    = await readBody(req)
      const payload = text ? JSON.parse(text) : {}
      const printer  = typeof payload.printer  === 'string' ? payload.printer  : 'default'
      const commands = typeof payload.commands === 'string' ? payload.commands : ''
      if (!commands) throw new Error('Missing "commands" in request body.')
      log('INFO', `Spooler print → printer="${printer}" (${commands.length} chars)`)
      const { printers, defaultPrinter } = await listSystemPrinters()
      const target = printer === 'default' || !printer ? defaultPrinter : printer
      if (!target) throw new Error('No printers found.')
      if (!printers.includes(target)) throw new Error(`Printer "${target}" not found. Available: ${printers.join(', ')}`)
      if (IS_WIN) await winPrintSpooler(target, commands)
      else        await cupsPrint(target, commands)
      log('OK', `Printed to "${target}"`)
      sendJson(res, 200, { ok: true, printer: target }, origin)
    } catch (err) {
      log('ERR', `Print failed: ${err.message}`)
      sendJson(res, 500, { ok: false, error: err.message }, origin)
    }
    return
  }

  // ── POST /api/print-usb (Linux/macOS /dev/usb/lp* path) ──────────────────
  if (pathname === '/api/print-usb' && method === 'POST') {
    try {
      const text    = await readBody(req)
      const payload = text ? JSON.parse(text) : {}
      const devicePath = typeof payload.devicePath === 'string' ? payload.devicePath : ''
      const commands   = typeof payload.commands   === 'string' ? payload.commands   : ''
      if (!devicePath) throw new Error('Missing "devicePath" (e.g. "/dev/usb/lp0").')
      if (!commands)   throw new Error('Missing "commands".')
      if (IS_WIN) throw new Error('Use /api/print-usb-win on Windows, or /api/print-auto for cross-platform.')
      const b = await unixPrintUsb(devicePath, commands)
      sendJson(res, 200, { ok: true, devicePath, bytes: b }, origin)
    } catch (err) {
      log('ERR', `print-usb failed: ${err.message}`)
      sendJson(res, 500, { ok: false, error: err.message }, origin)
    }
    return
  }

  // ── POST /api/print-usb-win (Windows \\?\ device path) ───────────────────
  if (pathname === '/api/print-usb-win' && method === 'POST') {
    try {
      const text    = await readBody(req)
      const payload = text ? JSON.parse(text) : {}
      const devicePath = typeof payload.devicePath === 'string' ? payload.devicePath : ''
      const commands   = typeof payload.commands   === 'string' ? payload.commands   : ''
      if (!devicePath) throw new Error('Missing "devicePath" (e.g. "\\\\?\\USB#...").')
      if (!commands)   throw new Error('Missing "commands".')
      if (!IS_WIN) throw new Error('Use /api/print-usb on Linux/macOS, or /api/print-auto for cross-platform.')
      const b = await winPrintUsb(devicePath, commands)
      sendJson(res, 200, { ok: true, devicePath, bytes: b }, origin)
    } catch (err) {
      log('ERR', `print-usb-win failed: ${err.message}`)
      sendJson(res, 500, { ok: false, error: err.message }, origin)
    }
    return
  }

  // ── 404 ────────────────────────────────────────────────────────────────────
  sendJson(res, 404, {
    ok: false,
    error: `No route: ${method} ${pathname}`,
    routes: [
      'GET  /api/health',
      'GET  /api/printers',
      'GET  /api/usb-devices',
      'POST /api/print-auto       { commands [, devicePath] }  ← Universal: all platforms',
      'POST /api/print            { printer, commands }         ← Spooler/CUPS by name',
      'POST /api/print-usb        { devicePath, commands }      ← Linux/macOS /dev/usb/lp*',
      'POST /api/print-usb-win    { devicePath, commands }      ← Windows \\\\?\\USB#...',
    ],
  }, origin)
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVER STARTUP
// ─────────────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res)
  } catch (err) {
    log('ERR', `Unhandled: ${err.message}`)
    try {
      sendJson(res, 500, { ok: false, error: err.message || 'Internal error.' }, req.headers['origin'] || '')
    } catch { /* response already sent */ }
  }
})

server.listen(PORT, HOST, async () => {
  const localIPs = Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i && !i.internal && i.family === 'IPv4')
    .map(i => `  http://${i.address}:${PORT}`)

  console.log('')
  console.log('  \x1b[36m██╗      █████╗ ██████╗ ███████╗██╗     ██████╗ ██████╗ ███████╗███████╗███████╗\x1b[0m')
  console.log('  \x1b[36m██║     ██╔══██╗██╔══██╗██╔════╝██║     ██╔══██╗██╔══██╗██╔════╝██╔════╝██╔════╝\x1b[0m')
  console.log('  \x1b[36m██║     ███████║██████╔╝█████╗  ██║     ██████╔╝██████╔╝█████╗  ███████╗███████╗\x1b[0m')
  console.log('  \x1b[36m██║     ██╔══██║██╔══██╗██╔══╝  ██║     ██╔═══╝ ██╔══██╗██╔══╝  ╚════██║╚════██║\x1b[0m')
  console.log('  \x1b[36m███████╗██║  ██║██████╔╝███████╗███████╗██║     ██║  ██║███████╗███████║███████║\x1b[0m')
  console.log('  \x1b[36m╚══════╝╚═╝  ╚═╝╚═════╝ ╚══════╝╚══════╝╚═╝     ╚═╝  ╚═╝╚══════╝╚══════╝╚══════╝\x1b[0m')
  console.log('')
  console.log(`  \x1b[32mLabelPress Agent v${AGENT_VERSION} is running!\x1b[0m`)
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
  console.log(`  POST http://localhost:${PORT}/api/print-auto       ← Use this from your app`)
  console.log('')
  console.log('  Press Ctrl+C to stop.')
  console.log('')

  // Startup discovery
  try {
    const { printers, defaultPrinter } = await listSystemPrinters()
    if (printers.length > 0) {
      log('OK', `System printers: ${printers.join(', ')}`)
      if (defaultPrinter) log('INFO', `Default printer: "${defaultPrinter}"`)
    } else {
      log('INFO', 'No system spooler/CUPS printers found.')
    }
  } catch { /* ignore */ }

  try {
    const devices = await listUsbDevices()
    if (devices.length > 0) {
      log('OK', `USB printer devices: ${devices.map(d => d.name || d.path).join(', ')}`)
      const openable = devices.filter(d => d.openable)
      if (openable.length > 0) {
        log('OK', `\x1b[32m✔ Ready to print directly to: ${openable.map(d => d.name).join(', ')}\x1b[0m`)
      }
    } else {
      log('INFO', 'No USB printer devices found. Plug in your printer and re-check /api/usb-devices.')
    }
  } catch { /* ignore */ }
})

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  \x1b[31m✖ Port ${PORT} is already in use.\x1b[0m`)
    console.error(`    Try: node labelpress-agent.mjs --port ${PORT + 1}\n`)
  } else {
    console.error(`\n  \x1b[31m✖ Server error: ${err.message}\x1b[0m\n`)
  }
  process.exit(1)
})

process.on('SIGINT', () => {
  console.log('\n\n  Shutting down LabelPress Agent. Goodbye!\n')
  server.close(() => process.exit(0))
})
