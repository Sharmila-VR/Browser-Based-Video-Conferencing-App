import { describe, expect, it, vi } from 'vitest'
import { adaptSender, measureNetwork, profileFor, qualityFor } from './quality'

function statsReport(entries: object[]): RTCStatsReport {
  const report = new Map(entries.map((entry, index) => [String(index), entry]))
  return report as RTCStatsReport
}

describe('network quality adaptation', () => {
  it('measures bitrate, loss, jitter and round-trip time', () => {
    const report = statsReport([
      { type: 'inbound-rtp', isRemote: false, kind: 'video', bytesReceived: 125_000, packetsReceived: 97, packetsLost: 3, jitter: 0.02 },
      { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.04 },
      { type: 'remote-inbound-rtp', kind: 'video', roundTripTime: 0.05, packetsLost: 0 },
    ])
    expect(measureNetwork(report, 0, 1000)).toEqual({
      bitrate: 1_000_000,
      packetLoss: 3,
      jitter: 0.02,
      rtt: 0.05,
      quality: 'fair',
    })
  })

  it('handles empty reports and invalid elapsed time', () => {
    expect(measureNetwork(statsReport([]), 100, 0)).toEqual({
      bitrate: 0,
      packetLoss: 0,
      jitter: 0,
      rtt: 0,
      quality: 'good',
    })
  })

  it('ignores unrelated streams and safely handles missing counters', () => {
    const report = statsReport([
      { type: 'inbound-rtp', isRemote: true, kind: 'video', bytesReceived: 5000 },
      { type: 'inbound-rtp', isRemote: false, kind: 'audio', bytesReceived: 5000 },
      { type: 'candidate-pair', state: 'failed', nominated: true, currentRoundTripTime: 0.3 },
      { type: 'candidate-pair', state: 'succeeded', nominated: false, currentRoundTripTime: 0.3 },
      { type: 'candidate-pair', state: 'succeeded', nominated: true },
      { type: 'remote-inbound-rtp', kind: 'audio', roundTripTime: 0.3 },
      { type: 'remote-inbound-rtp', kind: 'video' },
      { type: 'inbound-rtp', isRemote: false, kind: 'video' },
    ])
    expect(measureNetwork(report, 500, 1000)).toEqual({
      bitrate: 0,
      packetLoss: 0,
      jitter: 0,
      rtt: 0,
      quality: 'good',
    })
  })

  it.each([
    [{ packetLoss: 8, rtt: 0, jitter: 0, bitrate: 1_000_000 }, 'poor'],
    [{ packetLoss: 0, rtt: 0.6, jitter: 0, bitrate: 1_000_000 }, 'poor'],
    [{ packetLoss: 0, rtt: 0, jitter: 0.15, bitrate: 1_000_000 }, 'poor'],
    [{ packetLoss: 3, rtt: 0, jitter: 0, bitrate: 1_000_000 }, 'fair'],
    [{ packetLoss: 0, rtt: 0.3, jitter: 0, bitrate: 1_000_000 }, 'fair'],
    [{ packetLoss: 0, rtt: 0, jitter: 0.08, bitrate: 1_000_000 }, 'fair'],
    [{ packetLoss: 1, rtt: 0, jitter: 0, bitrate: 1_000_000 }, 'good'],
    [{ packetLoss: 0, rtt: 0.15, jitter: 0, bitrate: 1_000_000 }, 'good'],
    [{ packetLoss: 0, rtt: 0, jitter: 0, bitrate: 449_999 }, 'good'],
    [{ packetLoss: 0, rtt: 0, jitter: 0, bitrate: 450_000 }, 'excellent'],
  ] as const)('classifies network conditions', (metrics, expected) => {
    expect(qualityFor(metrics)).toBe(expected)
  })

  it('provides monotonic adaptation profiles', () => {
    expect(profileFor('excellent').maxBitrate).toBeGreaterThan(profileFor('good').maxBitrate)
    expect(profileFor('good').maxBitrate).toBeGreaterThan(profileFor('fair').maxBitrate)
    expect(profileFor('fair').maxBitrate).toBeGreaterThan(profileFor('poor').maxBitrate)
    expect(profileFor('poor').scaleResolutionDownBy).toBeGreaterThan(profileFor('excellent').scaleResolutionDownBy)
  })

  it('updates every simulcast encoding on a video sender', async () => {
    const parameters = {
      encodings: [
        { rid: 'high', scaleResolutionDownBy: 1 },
        { rid: 'low', scaleResolutionDownBy: 2 },
      ],
    }
    const sender = {
      track: { kind: 'video' },
      getParameters: vi.fn(() => parameters),
      setParameters: vi.fn().mockResolvedValue(undefined),
    } as unknown as RTCRtpSender
    await adaptSender(sender, 'fair')
    expect(sender.setParameters).toHaveBeenCalledWith({
      encodings: [
        { rid: 'high', scaleResolutionDownBy: 1.75, maxBitrate: 275_000, maxFramerate: 20, active: true },
        { rid: 'low', scaleResolutionDownBy: 3.5, maxBitrate: 275_000, maxFramerate: 20, active: true },
      ],
    })
  })

  it('leaves senders unchanged when encoding parameters are unavailable', async () => {
    const sender = {
      track: { kind: 'video' },
      getParameters: () => ({}),
      setParameters: vi.fn().mockResolvedValue(undefined),
    } as unknown as RTCRtpSender
    await adaptSender(sender, 'poor')
    expect(sender.setParameters).not.toHaveBeenCalled()
  })

  it('respects a caller bandwidth cap', async () => {
    const sender = {
      track: { kind: 'video' },
      getParameters: () => ({ encodings: [{}, {}] }),
      setParameters: vi.fn().mockResolvedValue(undefined),
    } as unknown as RTCRtpSender
    await adaptSender(sender, 'excellent', 600_000)
    expect(sender.setParameters).toHaveBeenCalledWith({
      encodings: [
        { maxBitrate: 300_000, maxFramerate: 30, scaleResolutionDownBy: 1, active: true },
        { maxBitrate: 300_000, maxFramerate: 30, scaleResolutionDownBy: 1, active: true },
      ],
    })
  })

  it('does not update audio senders', async () => {
    const setParameters = vi.fn()
    await adaptSender({
      track: { kind: 'audio' },
      getParameters: vi.fn(),
      setParameters,
    } as unknown as RTCRtpSender, 'excellent')
    expect(setParameters).not.toHaveBeenCalled()
  })
})
