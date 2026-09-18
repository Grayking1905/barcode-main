import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const PLATFORM = process.platform

function run(file, args, options = {}) {
  return execFileAsync(file, args, {
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
    const args = ['-o', 'raw', '-o', 'job-sheets=none', '-n', '1']
    if (printer && printer !== 'default') {
      args.push('-d', printer)
    }
    args.push('--', filePath)
    await run('lp', args)
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

export async function listPrinters() {
  try {
    if (PLATFORM === 'win32') return await listWindowsPrinters()
    return await listCupsPrinters()
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not list printers: ${detail}`)
  }
}

export async function printRaw(printerName, commands) {
  if (typeof commands !== 'string' || !commands.trim()) {
    throw new Error('Print payload is empty.')
  }

  const { printers, defaultPrinter } = await listPrinters()
  let target = printerName === 'default' || !printerName ? defaultPrinter : printerName

  if (!target) {
    throw new Error('No printers are installed on this computer.')
  }

  if (!printers.includes(target)) {
    throw new Error(`Printer "${target}" was not found.`)
  }

  try {
    if (PLATFORM === 'win32') {
      await printWindows(target, commands)
    } else {
      await printCups(target, commands)
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`Print failed: ${detail}`)
  }

  return { printer: target }
}
