import { useCallback, useRef, useState } from 'react'
import './App.css'

// ── Printer language builders ─────────────────────────────────────────────────

type PrinterLang = 'ZPL' | 'TSPL' | 'EPL'

function buildZpl(value: string): string {
  const data = value.replace(/[\^~]/g, '')
  return `^XA
^FO40,40^BY2^BCN,120,N,N,N^FD${data}^FS
^XZ`
}

function buildTspl(value: string): string {
  const data = value.replace(/"/g, '')
  return `SIZE 50 mm, 30 mm
GAP 2 mm, 0
DIRECTION 1
CLS
BARCODE 40,40,"128",100,0,0,2,4,"${data}"
PRINT 1,1
`
}

function buildEpl(value: string): string {
  const data = value.replace(/"/g, '')
  return `N
q400
Q240,24
B40,40,0,1,2,4,120,N,"${data}"
P1
`
}

function buildCommands(lang: PrinterLang, value: string): string {
  if (lang === 'TSPL') return buildTspl(value)
  if (lang === 'EPL') return buildEpl(value)
  return buildZpl(value)
}

function guessLang(name: string): PrinterLang {
  const n = name.toLowerCase()
  if (/\btsc\b|tspl/.test(n)) return 'TSPL'
  if (/\bepl\b/.test(n)) return 'EPL'
  return 'ZPL'
}

// ── Browser capability detection ──────────────────────────────────────────────

const supportsUSB = typeof navigator !== 'undefined' && 'usb' in navigator
const supportsSerial = typeof navigator !== 'undefined' && 'serial' in navigator

// ── USB helpers ───────────────────────────────────────────────────────────────

interface BulkOutEp {
  interfaceNumber: number
  endpointNumber: number
}

function findBulkOutEp(device: USBDevice): BulkOutEp | null {
  const config = device.configuration
  if (!config) return null
  for (const iface of config.interfaces) {
    for (const alt of iface.alternates) {
      for (const ep of alt.endpoints) {
        if (ep.direction === 'out' && ep.type === 'bulk') {
          return { interfaceNumber: iface.interfaceNumber, endpointNumber: ep.endpointNumber }
        }
      }
    }
  }
  return null
}

async function openUSBDevice(): Promise<{ device: USBDevice; name: string }> {
  const device = await navigator.usb.requestDevice({ filters: [] })
  await device.open()
  if (device.configuration === null) {
    await device.selectConfiguration(1)
  }
  const ep = findBulkOutEp(device)
  if (!ep) {
    await device.close()
    throw new Error(
      'No compatible bulk-output endpoint found. Make sure this is a label printer or try System Printer mode.',
    )
  }
  await device.claimInterface(ep.interfaceNumber)
  const nameParts = [device.manufacturerName, device.productName].filter(Boolean)
  const name =
    nameParts.join(' ') ||
    `USB Device (${device.vendorId.toString(16).toUpperCase()}:${device.productId.toString(16).toUpperCase()})`
  return { device, name }
}

async function sendUSB(device: USBDevice, commands: string): Promise<void> {
  if (!device.opened) {
    await device.open()
    if (device.configuration === null) await device.selectConfiguration(1)
    const ep = findBulkOutEp(device)
    if (ep) await device.claimInterface(ep.interfaceNumber)
  }
  const ep = findBulkOutEp(device)
  if (!ep) throw new Error('USB printer endpoint not found.')
  const result = await device.transferOut(ep.endpointNumber, new TextEncoder().encode(commands))
  if (result.status !== 'ok') throw new Error(`USB transfer status: ${result.status}`)
}

// ── Serial helpers ────────────────────────────────────────────────────────────

async function openSerialPort(): Promise<{ port: SerialPort; name: string }> {
  const port = await navigator.serial.requestPort()
  await port.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' })
  const info = port.getInfo()
  const name = info.usbVendorId
    ? `COM Port · USB ${info.usbVendorId.toString(16).toUpperCase()}:${(info.usbProductId ?? 0).toString(16).toUpperCase()}`
    : 'Serial / COM Port'
  return { port, name }
}

async function sendSerial(port: SerialPort, commands: string): Promise<void> {
  if (!port.writable) throw new Error('Serial port is not writable — is the printer still connected?')
  const writer = port.writable.getWriter()
  try {
    await writer.write(new TextEncoder().encode(commands))
  } finally {
    writer.releaseLock()
  }
}

// ── Connection state ──────────────────────────────────────────────────────────

type ConnSource =
  | { kind: 'usb'; device: USBDevice }
  | { kind: 'serial'; port: SerialPort }
  | { kind: 'system'; printerName: string; agentUrl: string }
  | { kind: 'agent-usb'; agentUrl: string; devicePath: string }

type Phase =
  | 'disconnected'
  | 'connecting-usb'
  | 'connecting-serial'
  | 'connecting-system'
  | 'connecting-agent-usb'
  | 'connected'
  | 'printing'

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [value, setValue] = useState('SAMPLE-001')
  const [lang, setLang] = useState<PrinterLang>('EPL')
  const [phase, setPhase] = useState<Phase>('disconnected')
  const [conn, setConn] = useState<ConnSource | null>(null)
  const [printerName, setPrinterName] = useState('')
  const [message, setMessage] = useState('')
  const [usbBlocked, setUsbBlocked] = useState(false)
  const [systemPrinters, setSystemPrinters] = useState<string[]>([])
  const [showDriverGuide, setShowDriverGuide] = useState(false)
  const connRef = useRef<ConnSource | null>(null)

  const updateConn = (c: ConnSource | null, name: string) => {
    connRef.current = c
    setConn(c)
    setPrinterName(name)
    if (c) setPhase('connected')
    else setPhase('disconnected')
  }

  // ── Connect USB ─────────────────────────────────────────────────────────────

  const connectUSB = useCallback(async () => {
    setMessage('')
    setUsbBlocked(false)
    setPhase('connecting-usb')
    try {
      const { device, name } = await openUSBDevice()
      updateConn({ kind: 'usb', device }, name)
      if (name) setLang(guessLang(name))
    } catch (err) {
      setPhase('disconnected')
      if (err instanceof Error) {
        if (err.name === 'NotFoundError') {
          // User cancelled picker — no message
        } else if (
          err.message.toLowerCase().includes('access denied') ||
          err.message.toLowerCase().includes('access is denied') ||
          err.name === 'SecurityError'
        ) {
          // Windows: usbprint.sys is claiming the USB device
          setUsbBlocked(true)
          setShowDriverGuide(true)
          setMessage(
            'Windows is blocking USB access because usbprint.sys owns this device. See the fix instructions below.',
          )
        } else {
          setMessage(`USB error: ${err.message}`)
        }
      }
    }
  }, [])

  // ── Connect Serial ──────────────────────────────────────────────────────────

  const connectSerial = useCallback(async () => {
    setMessage('')
    setPhase('connecting-serial')
    try {
      const { port, name } = await openSerialPort()
      updateConn({ kind: 'serial', port }, name)
    } catch (err) {
      setPhase('disconnected')
      if (err instanceof Error && err.name !== 'NotFoundError') {
        setMessage(`Serial: ${err.message}`)
      }
    }
  }, [])

  // ── Helper to find working Agent URL (checks 127.0.0.1, localhost, custom IP) ─
  const getAgentUrl = useCallback(async (): Promise<string> => {
    const custom = localStorage.getItem('lp_agent_url')
    const candidates = [
      custom,
      'http://127.0.0.1:47474',
      'http://localhost:47474',
    ].filter(Boolean) as string[]

    for (const url of candidates) {
      try {
        const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1200) })
        if (res.ok) return url
      } catch {}
    }
    return custom || 'http://127.0.0.1:47474'
  }, [])

  // ── Connect System Printer (via Local Agent / Spooler / CUPS) ───────────────

  const connectSystem = useCallback(async () => {
    setMessage('')
    setPhase('connecting-system')
    const agentUrl = await getAgentUrl()
    try {
      const res = await fetch(`${agentUrl}/api/printers`)
      if (!res.ok) throw new Error(`Agent HTTP ${res.status}`)
      const data = await res.json()
      if (!data.ok || !Array.isArray(data.printers) || data.printers.length === 0) {
        throw new Error(data.error || 'No system printers detected.')
      }
      setSystemPrinters(data.printers)
      const selected = data.defaultPrinter || data.printers[0]
      updateConn({ kind: 'system', printerName: selected, agentUrl }, selected)
      setLang(guessLang(selected))
      setMessage(`Connected to system printer: ${selected}`)
    } catch (err) {
      setPhase('disconnected')
      setMessage(
        'Could not reach local print bridge on ' + agentUrl + '.\n' +
        '• Windows: Run start-agent.bat\n' +
        '• Linux: Run ./start-agent.sh (or bash start-agent.sh)',
      )
    }
  }, [getAgentUrl])

  // ── Connect Agent Direct USB (no driver change needed) ──────────────────────

  const connectAgentUsb = useCallback(async () => {
    setMessage('')
    setPhase('connecting-agent-usb')
    const agentUrl = await getAgentUrl()
    try {
      const res = await fetch(`${agentUrl}/api/usb-devices`)
      if (!res.ok) throw new Error(`Agent HTTP ${res.status}`)
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || 'USB device scan failed.')

      // Pick the best device: prefer openable (can directly write), then any USB direct
      const devices: Array<{path: string; name: string; type: string; openable: boolean; note?: string}> = data.devices || []
      const openable = devices.filter(d => d.openable && d.type === 'usb-direct')
      const direct   = devices.filter(d => d.type === 'usb-direct')
      const best     = openable[0] ?? direct[0] ?? devices[0]

      const devicePath = best?.path  ?? ''
      const deviceName = best?.name  ?? ''
      // Don't store a stale path — pass empty so agent always re-discovers at print time
      // This makes it resilient to printer reconnects / power cycles
      const storedPath = best?.openable ? devicePath : ''

      const label = deviceName
        ? `${deviceName}${devices.length > 1 ? ` (+${devices.length - 1} more)` : ''}`
        : 'Printer (auto-detect)'

      updateConn({ kind: 'agent-usb', agentUrl, devicePath: storedPath }, label)

      // Auto-detect language from printer name
      const nameLower = deviceName.toLowerCase()
      if (/\bepl\b/.test(nameLower)) setLang('EPL')
      else if (/\btspl\b|tsc/.test(nameLower)) setLang('TSPL')
      else setLang('EPL') // default for Zebra GC420t

      const status = best?.openable
        ? `✅ Ready to print to: ${deviceName}`
        : devices.length > 0
          ? `⚡ Agent connected — ${devices.length} printer(s) found, will auto-detect on print`
          : '⚡ Agent connected — no USB printers detected yet (will retry on print)'

      setMessage(status)
    } catch (err) {
      setPhase('disconnected')
      setMessage(
        '❌ Could not reach local print bridge on ' + agentUrl + '.\n' +
        '• Make sure the agent is running in terminal:\n' +
        '    Linux:   chmod +x start-agent.sh && ./start-agent.sh\n' +
        '    Windows: double-click start-agent.bat\n' +
        '• In browser: ensure you allow access to local network if prompted.',
      )
    }
  }, [getAgentUrl])

  // ── Switch System Printer ───────────────────────────────────────────────────

  const handleSystemPrinterChange = (name: string) => {
    if (conn?.kind === 'system') {
      updateConn({ ...conn, printerName: name }, name)
      setLang(guessLang(name))
    }
  }

  // ── Disconnect ──────────────────────────────────────────────────────────────

  const disconnect = useCallback(async () => {
    const c = connRef.current
    if (!c) return
    try {
      if (c.kind === 'usb') await c.device.close()
      else if (c.kind === 'serial') await c.port.close()
    } catch {
      /* ignore */
    }
    updateConn(null, '')
    setMessage('')
    setUsbBlocked(false)
  }, [])

  // ── Print ───────────────────────────────────────────────────────────────────

  const barcodeValue = value.trim()
  const canPrint = barcodeValue.length > 0 && (phase === 'connected' || phase === 'printing')

  const handlePrint = useCallback(async () => {
    const c = connRef.current
    if (!c || !canPrint) return
    setPhase('printing')
    setMessage('')
    try {
      const commands = buildCommands(lang, barcodeValue)
      if (c.kind === 'usb') {
        await sendUSB(c.device, commands)
      } else if (c.kind === 'serial') {
        await sendSerial(c.port, commands)
      } else if (c.kind === 'agent-usb') {
        const res = await fetch(`${c.agentUrl}/api/print-auto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ commands, devicePath: c.devicePath }),
        })
        const data = await res.json()
        if (!data.ok) throw new Error(data.error || 'Print failed.')
        const methodLabel = data.method === 'usb-direct' ? 'Direct USB' : (data.method === 'cups' ? 'CUPS' : 'Spooler')
        setMessage(`✓ Printed successfully via ${methodLabel}${data.name ? ` (${data.name})` : ''}!`)
        return
      } else if (c.kind === 'system') {
        const res = await fetch(`${c.agentUrl}/api/print`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ printer: c.printerName, commands }),
        })
        const data = await res.json()
        if (!data.ok) throw new Error(data.error || 'Print failed.')
        setMessage(`✓ Printed via Spooler (${c.printerName})!`)
        return
      }
      setMessage('✓ Label sent to printer.')
    } catch (err) {
      setMessage(`✗ ${err instanceof Error ? err.message : 'Print failed.'}`)
    } finally {
      setPhase('connected')
    }
  }, [canPrint, lang, barcodeValue])

  // ── Render ──────────────────────────────────────────────────────────────────

  const isConnected = phase === 'connected' || phase === 'printing'
  const isConnecting =
    phase === 'connecting-usb' || phase === 'connecting-serial' ||
    phase === 'connecting-system' || phase === 'connecting-agent-usb'
  const noBrowserSupport = !supportsUSB && !supportsSerial

  return (
    <div className="app">
      <div className="shell">

        {/* ── Header ── */}
        <header className="header">
          <p className="brand">LabelPress</p>
          <h1>Direct Barcode Print</h1>
          <p className="subtitle">
            Print directly to your Zebra, TSC, or compatible label printer from Chrome or Edge.
          </p>
        </header>

        {/* ── Browser support warning ── */}
        {noBrowserSupport && (
          <div className="warn-banner" role="alert">
            <span className="warn-icon">⚠️</span>
            <div>
              <strong>Browser not supported.</strong> Direct WebUSB and WebSerial require Google Chrome or Microsoft Edge.
            </div>
          </div>
        )}

        {/* ── Connect panel (when not connected) ── */}
        {!isConnected && !isConnecting && (
          <div className="connect-panel">
            <div className="connect-header">
              <div className="connect-icon">🖨️</div>
              <h2 className="connect-title">Choose Connection Method</h2>
              <p className="connect-sub">
                Select how you would like to connect your printer:
              </p>
            </div>

            <div className="connect-methods">
              {/* Option 1: Direct Web USB */}
              <button
                type="button"
                className={`connect-btn${usbBlocked ? ' connect-btn-highlighted' : ''}`}
                id="connect-usb-btn"
                disabled={!supportsUSB}
                onClick={() => void connectUSB()}
              >
                <span className="connect-btn-icon">🔌</span>
                <span className="connect-btn-label">
                  <strong>
                    USB (Direct Browser Access)
                    {usbBlocked && <span className="connect-btn-tag">Driver Action Needed</span>}
                  </strong>
                  <small>
                    ⚡ Zero install on Linux / Android / ChromeOS · Windows requires WinUSB driver
                  </small>
                </span>
                <span className="connect-btn-arrow">→</span>
              </button>

              {/* Option 2: Agent Direct USB — RAW \\.\USB001 via local agent */}
              <button
                type="button"
                className="connect-btn connect-btn-primary"
                id="connect-agent-usb-btn"
                onClick={() => void connectAgentUsb()}
              >
                <span className="connect-btn-icon">⚡</span>
                <span className="connect-btn-label">
                  <strong>
                    Agent Direct USB
                    <span className="connect-btn-tag connect-btn-tag-green">Recommended for Windows</span>
                  </strong>
                  <small>
                    🖨️ Writes raw ESC/ZPL directly to \\.\ USB port — no WinUSB or Zadig needed
                  </small>
                </span>
                <span className="connect-btn-arrow">→</span>
              </button>

              {/* Option 3: System Printer via Spooler */}
              <button
                type="button"
                className="connect-btn"
                id="connect-system-btn"
                onClick={() => void connectSystem()}
              >
                <span className="connect-btn-icon">💻</span>
                <span className="connect-btn-label">
                  <strong>System Printer (Windows Spooler / CUPS)</strong>
                  <small>
                    ✅ Works with existing Zebra / TSC Windows drivers (via local bridge)
                  </small>
                </span>
                <span className="connect-btn-arrow">→</span>
              </button>

              {/* Option 3: COM / Serial */}
              <button
                type="button"
                className="connect-btn"
                id="connect-serial-btn"
                disabled={!supportsSerial}
                onClick={() => void connectSerial()}
              >
                <span className="connect-btn-icon">🔗</span>
                <span className="connect-btn-label">
                  <strong>COM / Serial Port</strong>
                  <small>For RS-232 serial cables or USB-to-UART bridges</small>
                </span>
                <span className="connect-btn-arrow">→</span>
              </button>
            </div>

            <div className="guide-toggle-row">
              <button
                type="button"
                className="guide-toggle-btn"
                onClick={() => setShowDriverGuide(!showDriverGuide)}
              >
                {showDriverGuide ? '▲ Hide Driver Setup Guide' : '⚙️ How to make USB Direct work on Windows & Linux'}
              </button>
            </div>
          </div>
        )}

        {/* ── Windows / Linux Driver Setup Guide ── */}
        {showDriverGuide && !isConnected && (
          <section className="driver-guide-card" aria-label="OS Driver Configuration Guide">
            <div className="guide-header">
              <span className="guide-icon">💡</span>
              <div>
                <h3 className="guide-title">Why does Windows say "Access denied" on USB?</h3>
                <p className="guide-desc">
                  Even when you uninstall the Zebra driver, Windows automatically binds its built-in{' '}
                  <code>usbprint.sys</code> driver to any USB printer. WebUSB in Chrome requires the{' '}
                  <strong>WinUSB</strong> driver to communicate directly.
                </p>
              </div>
            </div>

            <div className="guide-steps">
              <h4>To fix USB Direct on Windows (1-time, 30 seconds):</h4>
              <ol>
                <li>
                  We already downloaded <strong>Zadig</strong> to your PC:{' '}
                  <code>C:\Users\shriv\Downloads\zadig-2.9.exe</code> (double-click to open it).
                </li>
                <li>
                  Click <strong>Options</strong> menu → Check <strong>List All Devices</strong>.
                </li>
                <li>
                  In the dropdown, select your printer:{' '}
                  <strong>ZTC GC420t</strong> or <strong>USB Printing Support (VID 0A5F, PID 00D3)</strong>.
                </li>
                <li>
                  On the right side of the green arrow, select <strong>WinUSB</strong>.
                </li>
                <li>
                  Click <strong>Replace Driver</strong>. Done! Now click <strong>USB (Direct)</strong> above.
                </li>
              </ol>

              <h4>On Linux:</h4>
              <p className="guide-linux-note">
                Grant USB access to your user with a 1-line rule:
                <br />
                <code>echo 'SUBSYSTEM=="usb", ATTR&#123;idVendor&#125;=="0a5f", MODE="0666"' | sudo tee /etc/udev/rules.d/99-zebra.rules</code>
                <br />
                <code>sudo udevadm control --reload-rules && sudo udevadm trigger</code>
              </p>

              <h4>Prefer to keep your existing Windows Zebra driver?</h4>
              <p className="guide-alt-note">
                You don't need to change drivers! Just double-click <strong>start-agent.bat</strong> in your project folder and click <strong>System Printer</strong> above.
              </p>
            </div>
          </section>
        )}

        {/* ── Connecting spinner ── */}
        {isConnecting && (
          <div className="connecting-state" role="status" aria-live="polite">
            <div className="spinner" aria-hidden="true" />
            <p>
              {phase === 'connecting-usb'
                ? 'Waiting for USB device selection…'
                : phase === 'connecting-serial'
                  ? 'Waiting for serial port selection…'
                  : 'Connecting to Windows Print Spooler…'}
            </p>
            <p className="connecting-hint">
              {phase === 'connecting-system'
                ? 'Talking to local bridge on port 47474'
                : 'Select your printer from the browser popup.'}
            </p>
          </div>
        )}

        {/* ── Connected — print controls ── */}
        {isConnected && (
          <>
            <div className="printer-status-bar">
              <span className="status-dot" aria-hidden="true" />
              <span className="status-printer-name">{printerName}</span>
              <span className="status-badge">
                {conn?.kind === 'usb' ? 'USB' : conn?.kind === 'serial' ? 'Serial' : 'Spooler'}
              </span>
              <button
                type="button"
                className="disconnect-btn"
                id="disconnect-btn"
                onClick={() => void disconnect()}
              >
                Disconnect
              </button>
            </div>

            <section className="controls" aria-label="Print settings">
              {conn?.kind === 'system' && systemPrinters.length > 1 && (
                <>
                  <label htmlFor="system-printer-select" className="field-label">
                    Selected System Printer
                  </label>
                  <select
                    id="system-printer-select"
                    className="select-input"
                    value={conn.printerName}
                    onChange={(e) => handleSystemPrinterChange(e.target.value)}
                  >
                    {systemPrinters.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </>
              )}

              <label htmlFor="barcode-input" className="field-label">
                Barcode text
              </label>
              <input
                id="barcode-input"
                className="barcode-input"
                type="text"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="Enter text or SKU…"
                autoComplete="off"
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handlePrint()
                }}
              />

              <label htmlFor="lang-select" className="field-label">
                Command language
              </label>
              <select
                id="lang-select"
                className="select-input"
                value={lang}
                onChange={(e) => setLang(e.target.value as PrinterLang)}
              >
                <option value="EPL">EPL — Zebra GC420t / LP2844 / 2824</option>
                <option value="ZPL">ZPL — Zebra ZD / ZT / standard</option>
                <option value="TSPL">TSPL — TSC printers</option>
              </select>
            </section>

            <div className="actions">
              <button
                type="button"
                className="print-btn"
                id="print-barcode-btn"
                disabled={!canPrint}
                onClick={() => void handlePrint()}
              >
                {phase === 'printing' ? 'Sending…' : 'Print Barcode'}
              </button>
            </div>

            {message && (
              <p
                className={`message ${message.startsWith('✓') ? 'message-ok' : 'message-err'}`}
                role="status"
              >
                {message}
              </p>
            )}
          </>
        )}

        {/* Error message when not connected */}
        {!isConnected && !isConnecting && message && (
          <p className="message message-err" role="alert">
            {message}
          </p>
        )}

        {/* ── How it works ── */}
        <aside className="tips" aria-label="How it works">
          <h2>Quick Reference</h2>
          <ul>
            <li>
              <strong>Direct USB (Zero Agent):</strong> Works on Linux, Chromebooks, and Android out of the box. On Windows, change the device driver to WinUSB once with Zadig.
            </li>
            <li>
              <strong>System Printer:</strong> Works with installed Windows/CUPS drivers via the lightweight <code>start-agent.bat</code> bridge.
            </li>
            <li>
              <strong>Zebra GC420t:</strong> Uses <strong>EPL</strong> language by default (Eltron Page Language).
            </li>
          </ul>
        </aside>

      </div>
    </div>
  )
}
