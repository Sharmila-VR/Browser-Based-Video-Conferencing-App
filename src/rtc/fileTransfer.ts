export const TRANSFER_CHUNK_SIZE = 16 * 1024
export const TRANSFER_BUFFER_LIMIT = 512 * 1024

export type TransferPacket =
  | { kind: 'file-start'; id: string; name: string; mime: string; size: number }
  | { kind: 'file-chunk'; id: string; index: number; data: string }
  | { kind: 'file-end'; id: string }

export function isTransferPacket(value: Record<string, unknown>): value is TransferPacket {
  if (typeof value.id !== 'string') return false
  if (value.kind === 'file-start') {
    return (
      typeof value.name === 'string' &&
      typeof value.mime === 'string' &&
      typeof value.size === 'number'
    )
  }
  if (value.kind === 'file-chunk') {
    return (
      typeof value.index === 'number' &&
      typeof value.data === 'string'
    )
  }
  return value.kind === 'file-end'
}

export interface TransferProgress {
  id: string
  name: string
  sent: number
  size: number
  complete: boolean
}

export function encodeBytes(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

export function decodeBytes(encoded: string): Uint8Array {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export function chunksFor(
  bytes: Uint8Array,
  chunkSize = TRANSFER_CHUNK_SIZE,
): Uint8Array<ArrayBuffer>[] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError('Chunk size must be a positive integer')
  }
  const chunks: Uint8Array<ArrayBuffer>[] = []
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const length = Math.min(chunkSize, bytes.length - offset)
    const chunk = new Uint8Array(new ArrayBuffer(length))
    chunk.set(bytes.subarray(offset, offset + length))
    chunks.push(chunk)
  }
  return chunks
}

export class FileAssembler {
  private readonly transfers = new Map<
    string,
    { name: string; mime: string; size: number;     chunks: Uint8Array<ArrayBuffer>[] }
  >()

  accept(packet: TransferPacket): { name: string; blob: Blob } | null {
    if (packet.kind === 'file-start') {
      if (!Number.isSafeInteger(packet.size) || packet.size < 0) {
        throw new RangeError('Invalid file size')
      }
      this.transfers.set(packet.id, {
        name: packet.name,
        mime: packet.mime || 'application/octet-stream',
        size: packet.size,
        chunks: [],
      })
      return null
    }

    const transfer = this.transfers.get(packet.id)
    if (!transfer) throw new Error('Received data for an unknown file transfer')

    if (packet.kind === 'file-chunk') {
      if (packet.index !== transfer.chunks.length) {
        throw new Error('File transfer chunk order is invalid')
      }
      const decoded = decodeBytes(packet.data)
      const chunk = new Uint8Array(new ArrayBuffer(decoded.length))
      chunk.set(decoded)
      transfer.chunks.push(chunk)
      return null
    }

    this.transfers.delete(packet.id)
    const received = transfer.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    if (received !== transfer.size) throw new Error('File transfer size does not match')
    return {
      name: transfer.name,
      blob: new Blob(transfer.chunks, { type: transfer.mime }),
    }
  }
}

export async function sendFile(
  channel: RTCDataChannel,
  file: File,
  id: string,
  onProgress: (progress: TransferProgress) => void,
): Promise<void> {
  if (channel.readyState !== 'open') throw new Error('The peer connection is not ready')
  const send = async (packet: TransferPacket) => {
    if (channel.bufferedAmount > TRANSFER_BUFFER_LIMIT) {
      await new Promise<void>((resolve) => {
        channel.bufferedAmountLowThreshold = TRANSFER_BUFFER_LIMIT / 2
        channel.addEventListener('bufferedamountlow', () => resolve(), { once: true })
      })
    }
    channel.send(JSON.stringify(packet))
  }

  await send({ kind: 'file-start', id, name: file.name, mime: file.type, size: file.size })
  onProgress({ id, name: file.name, sent: 0, size: file.size, complete: false })
  for (let offset = 0, index = 0; offset < file.size; offset += TRANSFER_CHUNK_SIZE, index += 1) {
    const bytes = new Uint8Array(
      await file.slice(offset, offset + TRANSFER_CHUNK_SIZE).arrayBuffer(),
    )
    await send({ kind: 'file-chunk', id, index, data: encodeBytes(bytes) })
    onProgress({
      id,
      name: file.name,
      sent: Math.min(offset + bytes.length, file.size),
      size: file.size,
      complete: false,
    })
  }
  await send({ kind: 'file-end', id })
  onProgress({ id, name: file.name, sent: file.size, size: file.size, complete: true })
}
