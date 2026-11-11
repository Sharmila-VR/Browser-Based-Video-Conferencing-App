export interface CallRecording {
  stop: () => Promise<void>
  pause: () => void
  resume: () => void
  state: () => RecordingState
}

type WritableFile = {
  write: (data: Blob) => Promise<void>
  close: () => Promise<void>
  abort?: () => Promise<void>
}

type SaveFileWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string
    types: { description: string; accept: Record<string, string[]> }[]
  }) => Promise<{ createWritable: () => Promise<WritableFile> }>
}

export async function startCallRecording(
  videos: HTMLVideoElement[],
  streams: MediaStream[],
  onState: (state: RecordingState) => void,
  onError: (message: string) => void,
): Promise<CallRecording> {
  const picker = (window as SaveFileWindow).showSaveFilePicker
  if (!picker) {
    throw new Error('Streamed recording downloads require a browser with the File System Access API.')
  }
  const canvas = document.createElement('canvas')
  canvas.width = 1280
  canvas.height = 720
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas recording is not supported in this browser')
  const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find((type) => MediaRecorder.isTypeSupported(type))
  if (!mimeType) throw new Error('MediaRecorder is not supported in this browser')

  const fileHandlePromise = picker({
    suggestedName: `room-recording-${new Date().toISOString().slice(0, 10)}.webm`,
    types: [{ description: 'WebM video', accept: { 'video/webm': ['.webm'] } }],
  })
  const audioContext = new AudioContext()
  const contextReady = audioContext.resume()
  let writable: WritableFile | undefined
  let stream: MediaStream | undefined
  let animationFrame = 0
  const sources: MediaStreamAudioSourceNode[] = []
  let recorder: MediaRecorder | undefined

  const cleanup = async () => {
    cancelAnimationFrame(animationFrame)
    stream?.getTracks().forEach((track) => track.stop())
    sources.forEach((source) => source.disconnect())
    if (audioContext.state !== 'closed') await audioContext.close()
  }

  try {
    const handle = await fileHandlePromise
    writable = await handle.createWritable()
    await contextReady
    const destination = audioContext.createMediaStreamDestination()
    streams.forEach((sourceStream) => {
      sourceStream.getAudioTracks().forEach((track) => {
        const source = audioContext.createMediaStreamSource(new MediaStream([track]))
        const gain = audioContext.createGain()
        gain.gain.value = Math.max(0.15, 1 / Math.sqrt(streams.length))
        source.connect(gain).connect(destination)
        sources.push(source)
      })
    })

    const draw = () => {
      context.fillStyle = '#111a20'
      context.fillRect(0, 0, canvas.width, canvas.height)
      const visible = videos.filter((video) => video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA)
      const columns = Math.ceil(Math.sqrt(Math.max(visible.length, 1)))
      const rows = Math.ceil(Math.max(visible.length, 1) / columns)
      visible.forEach((video, index) => {
        const width = canvas.width / columns
        const height = canvas.height / rows
        const x = (index % columns) * width
        const y = Math.floor(index / columns) * height
        context.drawImage(video, x, y, width, height)
      })
      animationFrame = requestAnimationFrame(draw)
    }
    animationFrame = requestAnimationFrame(draw)
    stream = canvas.captureStream(15)
    destination.stream.getAudioTracks().forEach((track) => stream?.addTrack(track))
    recorder = new MediaRecorder(stream, { mimeType })
  } catch (error) {
    await cleanup()
    throw error
  }

  let writeQueue = Promise.resolve()
  let pendingWrites = 0
  let manuallyPaused = false
  let backpressurePaused = false
  let resolveStop: (() => void) | undefined
  let rejectStop: ((error: unknown) => void) | undefined
  const stopPromise = new Promise<void>((resolve, reject) => {
    resolveStop = resolve
    rejectStop = reject
  })
  void stopPromise.catch(() => undefined)

  recorder.ondataavailable = (event) => {
    if (!event.data.size || !writable) return
    pendingWrites += 1
    if (pendingWrites >= 4 && recorder?.state === 'recording') {
      backpressurePaused = true
      recorder.pause()
    }
    writeQueue = writeQueue.then(async () => {
      await writable!.write(event.data)
      pendingWrites -= 1
      if (backpressurePaused && pendingWrites < 2 && !manuallyPaused && recorder?.state === 'paused') {
        backpressurePaused = false
        recorder.resume()
      }
    })
    void writeQueue.catch(() => {
      onState('inactive')
      if (recorder?.state !== 'inactive') recorder?.stop()
    })
  }
  recorder.onstart = () => onState('recording')
  recorder.onpause = () => onState('paused')
  recorder.onresume = () => onState('recording')
  recorder.onstop = () => {
    void writeQueue
      .then(() => writable?.close())
      .then(() => cleanup())
      .then(() => resolveStop?.(), async (error: unknown) => {
        await cleanup()
        onError(error instanceof Error ? error.message : 'The recording could not be saved.')
        rejectStop?.(error)
      })
  }
  try {
    recorder.start(1000)
  } catch (error) {
    await writable?.abort?.()
    await cleanup()
    throw error
  }

  return {
    pause: () => {
      manuallyPaused = true
      if (recorder?.state === 'recording') recorder.pause()
    },
    resume: () => {
      manuallyPaused = false
      if (recorder?.state === 'paused' && pendingWrites < 4) {
        backpressurePaused = false
        recorder.resume()
      }
    },
    state: () => recorder?.state ?? 'inactive',
    stop: () => {
      if (recorder?.state !== 'inactive') recorder?.stop()
      return stopPromise
    },
  }
}
