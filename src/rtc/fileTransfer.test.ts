import { describe, expect, it, vi } from 'vitest'
import {
  chunksFor,
  decodeBytes,
  encodeBytes,
  FileAssembler,
  isTransferPacket,
  sendFile,
  TRANSFER_BUFFER_LIMIT,
  TRANSFER_CHUNK_SIZE,
  type TransferPacket,
} from './fileTransfer'

describe('chunked file transfer', () => {
  it('encodes and decodes byte sequences', () => {
    const bytes = new Uint8Array([0, 1, 120, 255])
    expect([...decodeBytes(encodeBytes(bytes))]).toEqual([...bytes])
    expect(decodeBytes(encodeBytes(new Uint8Array()))).toHaveLength(0)
  })

  it('splits bytes into bounded chunks', () => {
    const bytes = new Uint8Array(TRANSFER_CHUNK_SIZE + 3)
    const chunks = chunksFor(bytes)
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([TRANSFER_CHUNK_SIZE, 3])
    expect(chunksFor(new Uint8Array())).toEqual([])
  })

  it('rejects invalid chunk sizes', () => {
    expect(() => chunksFor(new Uint8Array(2), 0)).toThrow(RangeError)
    expect(() => chunksFor(new Uint8Array(2), 1.5)).toThrow(RangeError)
  })

  it('validates incoming transfer packet shapes', () => {
    expect(isTransferPacket({ kind: 'file-start', id: 'one', name: 'a', mime: '', size: 0 })).toBe(true)
    expect(isTransferPacket({ kind: 'file-chunk', id: 'one', index: 0, data: 'eA==' })).toBe(true)
    expect(isTransferPacket({ kind: 'file-end', id: 'one' })).toBe(true)
    expect(isTransferPacket({ kind: 'file-end', id: 3 })).toBe(false)
    expect(isTransferPacket({ kind: 'file-start', id: 'one', name: 'a', mime: '', size: '2' })).toBe(false)
    expect(isTransferPacket({ kind: 'file-chunk', id: 'one', index: 0 })).toBe(false)
    expect(isTransferPacket({ kind: 'chat', id: 'one' })).toBe(false)
  })

  it('assembles the file only after all ordered chunks arrive', () => {
    const assembler = new FileAssembler()
    const bytes = new Uint8Array([10, 20, 30, 40])
    const packets: TransferPacket[] = [
      { kind: 'file-start', id: 'one', name: 'notes.txt', mime: 'text/plain', size: bytes.length },
      { kind: 'file-chunk', id: 'one', index: 0, data: encodeBytes(bytes.slice(0, 2)) },
      { kind: 'file-chunk', id: 'one', index: 1, data: encodeBytes(bytes.slice(2)) },
      { kind: 'file-end', id: 'one' },
    ]
    expect(assembler.accept(packets[0])).toBeNull()
    expect(assembler.accept(packets[1])).toBeNull()
    expect(assembler.accept(packets[2])).toBeNull()
    const result = assembler.accept(packets[3])
    expect(result?.name).toBe('notes.txt')
    expect(result?.blob.type).toBe('text/plain')
    return result?.blob.arrayBuffer().then((buffer) => {
      expect([...new Uint8Array(buffer)]).toEqual([...bytes])
    })
  })

  it('validates transfer size, packet sequence and completion size', () => {
    const assembler = new FileAssembler()
    expect(() => assembler.accept({ kind: 'file-start', id: 'bad', name: 'x', mime: '', size: -1 })).toThrow(RangeError)
    expect(() => assembler.accept({ kind: 'file-chunk', id: 'missing', index: 0, data: '' })).toThrow('unknown file transfer')
    assembler.accept({ kind: 'file-start', id: 'order', name: 'x', mime: '', size: 2 })
    expect(() => assembler.accept({ kind: 'file-chunk', id: 'order', index: 1, data: '' })).toThrow('chunk order')
    assembler.accept({ kind: 'file-start', id: 'size', name: 'x', mime: '', size: 2 })
    assembler.accept({ kind: 'file-chunk', id: 'size', index: 0, data: encodeBytes(new Uint8Array([1])) })
    expect(() => assembler.accept({ kind: 'file-end', id: 'size' })).toThrow('size does not match')
  })

  it('sends chunks in order and reports progress', async () => {
    const sent: string[] = []
    const channel = {
      readyState: 'open',
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      send: (packet: string) => sent.push(packet),
      addEventListener: vi.fn(),
    } as unknown as RTCDataChannel
    const progress: { sent: number; complete: boolean }[] = []
    const file = new File([new Uint8Array(TRANSFER_CHUNK_SIZE + 1)], 'data.bin', { type: 'application/octet-stream' })
    await sendFile(channel, file, 'transfer', (value) => progress.push(value))
    expect(sent.map((packet) => JSON.parse(packet).kind)).toEqual([
      'file-start',
      'file-chunk',
      'file-chunk',
      'file-end',
    ])
    expect(progress.at(-1)).toMatchObject({ sent: file.size, complete: true })
  })

  it('waits for backpressure before sending file data', async () => {
    const sent: string[] = []
    let low: (() => void) | undefined
    let bufferedAmount = TRANSFER_BUFFER_LIMIT + 1
    const channel = {
      readyState: 'open',
      get bufferedAmount() {
        return bufferedAmount
      },
      bufferedAmountLowThreshold: 0,
      send: (packet: string) => sent.push(packet),
      addEventListener: (_name: string, listener: () => void) => {
        low = listener
        queueMicrotask(() => {
          bufferedAmount = 0
          low?.()
        })
      },
    } as unknown as RTCDataChannel
    const file = new File(['x'], 'one.txt')
    await sendFile(channel, file, 'flow', () => undefined)
    expect(sent).toHaveLength(3)
  })

  it('rejects transfers when the data channel is not open', async () => {
    await expect(sendFile(
      { readyState: 'connecting' } as RTCDataChannel,
      new File(['x'], 'x.txt'),
      'closed',
      () => undefined,
    )).rejects.toThrow('not ready')
  })
})
