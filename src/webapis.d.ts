/**
 * Minimal type declarations for Web USB and Web Serial APIs.
 * These supplement lib.dom for browsers that support these APIs
 * (Chrome 61+ / Edge 79+ for USB; Chrome 89+ / Edge 89+ for Serial).
 */

// ── Web USB ───────────────────────────────────────────────────────────────────

interface USBEndpoint {
  readonly endpointNumber: number
  readonly direction: 'in' | 'out'
  readonly type: 'bulk' | 'control' | 'interrupt' | 'isochronous'
  readonly packetSize: number
}

interface USBAlternateInterface {
  readonly alternateSetting: number
  readonly interfaceClass: number
  readonly interfaceSubclass: number
  readonly interfaceProtocol: number
  readonly interfaceName?: string
  readonly endpoints: ReadonlyArray<USBEndpoint>
}

interface USBInterface {
  readonly interfaceNumber: number
  readonly alternate: USBAlternateInterface
  readonly alternates: ReadonlyArray<USBAlternateInterface>
  readonly claimed: boolean
}

interface USBConfiguration {
  readonly configurationValue: number
  readonly configurationName?: string
  readonly interfaces: ReadonlyArray<USBInterface>
}

interface USBTransferResult {
  readonly status: 'ok' | 'stall' | 'babble'
  readonly data?: DataView
}

interface USBOutTransferResult {
  readonly status: 'ok' | 'stall'
  readonly bytesWritten: number
}

interface USBDeviceRequestOptions {
  filters: USBDeviceFilter[]
}

interface USBDeviceFilter {
  vendorId?: number
  productId?: number
  classCode?: number
  subclassCode?: number
  protocolCode?: number
  serialNumber?: string
}

interface USBDevice {
  readonly vendorId: number
  readonly productId: number
  readonly deviceClass: number
  readonly deviceSubclass: number
  readonly deviceProtocol: number
  readonly manufacturerName?: string
  readonly productName?: string
  readonly serialNumber?: string
  readonly configuration: USBConfiguration | null
  readonly configurations: ReadonlyArray<USBConfiguration>
  readonly opened: boolean

  open(): Promise<void>
  close(): Promise<void>
  forget(): Promise<void>
  selectConfiguration(configurationValue: number): Promise<void>
  claimInterface(interfaceNumber: number): Promise<void>
  releaseInterface(interfaceNumber: number): Promise<void>
  selectAlternateInterface(interfaceNumber: number, alternateSetting: number): Promise<void>
  controlTransferIn(setup: USBControlTransferParameters, length: number): Promise<USBTransferResult>
  controlTransferOut(setup: USBControlTransferParameters, data?: BufferSource): Promise<USBOutTransferResult>
  clearHalt(direction: 'in' | 'out', endpointNumber: number): Promise<void>
  transferIn(endpointNumber: number, length: number): Promise<USBTransferResult>
  transferOut(endpointNumber: number, data: BufferSource): Promise<USBOutTransferResult>
  isochronousTransferIn(endpointNumber: number, packetLengths: number[]): Promise<USBIsochronousInTransferResult>
  isochronousTransferOut(endpointNumber: number, data: BufferSource, packetLengths: number[]): Promise<USBIsochronousOutTransferResult>
  reset(): Promise<void>
}

interface USBControlTransferParameters {
  requestType: 'standard' | 'class' | 'vendor'
  recipient: 'device' | 'interface' | 'endpoint' | 'other'
  request: number
  value: number
  index: number
}

interface USBIsochronousInTransferPacket {
  readonly data?: DataView
  readonly status: 'ok' | 'stall' | 'babble'
}
interface USBIsochronousInTransferResult {
  readonly data?: DataView
  readonly packets: ReadonlyArray<USBIsochronousInTransferPacket>
}
interface USBIsochronousOutTransferPacket {
  readonly bytesWritten: number
  readonly status: 'ok' | 'stall'
}
interface USBIsochronousOutTransferResult {
  readonly packets: ReadonlyArray<USBIsochronousOutTransferPacket>
}

interface USB extends EventTarget {
  getDevices(): Promise<USBDevice[]>
  requestDevice(options: USBDeviceRequestOptions): Promise<USBDevice>
}

interface Navigator {
  readonly usb: USB
}

// ── Web Serial ────────────────────────────────────────────────────────────────

interface SerialPortInfo {
  readonly usbVendorId?: number
  readonly usbProductId?: number
}

interface SerialOptions {
  baudRate: number
  dataBits?: 7 | 8
  stopBits?: 1 | 2
  parity?: 'none' | 'even' | 'odd'
  bufferSize?: number
  flowControl?: 'none' | 'hardware'
}

interface SerialPort extends EventTarget {
  readonly readable: ReadableStream<Uint8Array> | null
  readonly writable: WritableStream<Uint8Array> | null
  getInfo(): SerialPortInfo
  open(options: SerialOptions): Promise<void>
  close(): Promise<void>
  forget(): Promise<void>
}

interface SerialPortRequestOptions {
  filters?: SerialPortFilter[]
}

interface SerialPortFilter {
  usbVendorId?: number
  usbProductId?: number
}

interface Serial extends EventTarget {
  getPorts(): Promise<SerialPort[]>
  requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>
}

interface Navigator {
  readonly serial: Serial
}
