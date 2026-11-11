export interface AudioPipeline {
  stream: MediaStream
  context: AudioContext
  dispose: () => Promise<void>
}

export async function createAudioPipeline(
  input: MediaStream,
  onLevel: (level: number) => void,
): Promise<AudioPipeline> {
  const context = new AudioContext()
  await context.resume()
  const source = context.createMediaStreamSource(input)
  const analyser = context.createAnalyser()
  analyser.fftSize = 512
  const gate = context.createGain()
  const compressor = context.createDynamicsCompressor()
  const destination = context.createMediaStreamDestination()
  const samples = new Uint8Array(analyser.fftSize)
  compressor.threshold.value = -30
  compressor.knee.value = 20
  compressor.ratio.value = 4
  source.connect(analyser)
  analyser.connect(gate)
  gate.connect(compressor)
  compressor.connect(destination)

  let timer = 0
  let disposed = false
  let lastReported = 0
  const measure = () => {
    if (disposed) return
    analyser.getByteTimeDomainData(samples)
    let power = 0
    for (const sample of samples) {
      const amplitude = (sample - 128) / 128
      power += amplitude * amplitude
    }
    const level = Math.min(1, Math.sqrt(power / samples.length) * 4)
    gate.gain.setTargetAtTime(level < 0.015 ? 0 : 1, context.currentTime, 0.025)
    if (performance.now() - lastReported >= 100) {
      lastReported = performance.now()
      onLevel(level)
    }
    timer = window.setTimeout(measure, 50)
  }
  measure()

  return {
    stream: destination.stream,
    context,
    dispose: async () => {
      if (disposed) return
      disposed = true
      window.clearTimeout(timer)
      source.disconnect()
      analyser.disconnect()
      gate.disconnect()
      compressor.disconnect()
      destination.stream.getTracks().forEach((track) => track.stop())
      await context.close()
    },
  }
}
