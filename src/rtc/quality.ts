export type NetworkQuality = 'excellent' | 'good' | 'fair' | 'poor'

export interface NetworkMetrics {
  bitrate: number
  packetLoss: number
  jitter: number
  rtt: number
  quality: NetworkQuality
}

export interface QualityProfile {
  maxBitrate: number
  maxFramerate: number
  scaleResolutionDownBy: number
  quality: NetworkQuality
}

export function measureNetwork(
  report: RTCStatsReport,
  previousBytes: number,
  elapsedMs: number,
): NetworkMetrics {
  let bytes = 0
  let packetsReceived = 0
  let packetsLost = 0
  let jitter = 0
  let rtt = 0

  report.forEach((stat) => {
    if (stat.type === 'inbound-rtp' && !stat.isRemote && stat.kind === 'video') {
      bytes += Number(stat.bytesReceived ?? 0)
      packetsReceived += Number(stat.packetsReceived ?? 0)
      packetsLost += Math.max(0, Number(stat.packetsLost ?? 0))
      jitter = Math.max(jitter, Number(stat.jitter ?? 0))
    }
    if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated) {
      rtt = Math.max(rtt, Number(stat.currentRoundTripTime ?? 0))
    }
    if (stat.type === 'remote-inbound-rtp' && stat.kind === 'video') {
      rtt = Math.max(rtt, Number(stat.roundTripTime ?? 0))
    }
  })

  const bitrate = elapsedMs > 0 ? Math.max(0, ((bytes - previousBytes) * 8000) / elapsedMs) : 0
  const packetLoss =
    packetsReceived + packetsLost > 0
      ? (packetsLost / (packetsReceived + packetsLost)) * 100
      : 0
  const quality = qualityFor({ bitrate, packetLoss, jitter, rtt })

  return { bitrate, packetLoss, jitter, rtt, quality }
}

export function qualityFor(metrics: Omit<NetworkMetrics, 'quality'>): NetworkQuality {
  if (metrics.packetLoss >= 8 || metrics.rtt >= 0.6 || metrics.jitter >= 0.15) return 'poor'
  if (metrics.packetLoss >= 3 || metrics.rtt >= 0.3 || metrics.jitter >= 0.08) return 'fair'
  if (metrics.packetLoss >= 1 || metrics.rtt >= 0.15 || metrics.bitrate < 450_000) return 'good'
  return 'excellent'
}

export function profileFor(quality: NetworkQuality): QualityProfile {
  const profiles: Record<NetworkQuality, QualityProfile> = {
    excellent: {
      maxBitrate: 1_800_000,
      maxFramerate: 30,
      scaleResolutionDownBy: 1,
      quality,
    },
    good: {
      maxBitrate: 1_000_000,
      maxFramerate: 24,
      scaleResolutionDownBy: 1.25,
      quality,
    },
    fair: {
      maxBitrate: 550_000,
      maxFramerate: 20,
      scaleResolutionDownBy: 1.75,
      quality,
    },
    poor: {
      maxBitrate: 250_000,
      maxFramerate: 15,
      scaleResolutionDownBy: 2.5,
      quality,
    },
  }
  return profiles[quality]
}

export async function adaptSender(
  sender: RTCRtpSender,
  quality: NetworkQuality,
  bitrateCap = Number.POSITIVE_INFINITY,
): Promise<void> {
  if (sender.track?.kind !== 'video') return
  const parameters = sender.getParameters()
  const encodings = parameters.encodings
  if (!encodings?.length) return
  const profile = profileFor(quality)
  const targetBitrate = Math.min(profile.maxBitrate, bitrateCap)
  parameters.encodings = encodings.map((encoding) => ({
    ...encoding,
    maxBitrate: Math.floor(targetBitrate / encodings.length),
    maxFramerate: profile.maxFramerate,
    scaleResolutionDownBy:
      (encoding.scaleResolutionDownBy ?? 1) * profile.scaleResolutionDownBy,
    active: true,
  }))
  await sender.setParameters(parameters)
}
