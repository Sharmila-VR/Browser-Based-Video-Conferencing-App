export interface BackgroundEffect {
  stream: MediaStream
  dispose: () => void
}

export async function createBackgroundEffect(track: MediaStreamTrack): Promise<BackgroundEffect> {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    throw new Error('Background effects require OffscreenCanvas support')
  }
  const worker = new Worker(new URL('../workers/background.worker.ts', import.meta.url), {
    type: 'module',
  })
  const input = document.createElement('video')
  input.muted = true
  input.playsInline = true
  input.srcObject = new MediaStream([track])
  try {
    await input.play()
  } catch (error) {
    worker.terminate()
    input.srcObject = null
    throw error
  }

  const output = document.createElement('canvas')
  const width = Math.min(track.getSettings().width ?? 1280, 1280)
  const height = Math.min(track.getSettings().height ?? 720, 720)
  output.width = width
  output.height = height
  const context = output.getContext('2d')
  if (!context) {
    worker.terminate()
    input.pause()
    input.srcObject = null
    throw new Error('Canvas effects are not supported in this browser')
  }
  const stream = output.captureStream(30)
  let busy = false
  let stopped = false
  let frameHandle = 0

  worker.onmessage = (event: MessageEvent<ImageBitmap>) => {
    busy = false
    if (stopped) {
      event.data.close()
      return
    }
    context.drawImage(event.data, 0, 0, width, height)
    event.data.close()
  }

  const processFrame = async () => {
    if (stopped) return
    if (!busy && input.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      busy = true
      try {
        const bitmap = await createImageBitmap(input, {
          resizeWidth: width,
          resizeHeight: height,
        })
        if (stopped) {
          bitmap.close()
          return
        }
        worker.postMessage(bitmap, [bitmap])
      } catch {
        busy = false
      }
    }
    frameHandle = requestAnimationFrame(() => void processFrame())
  }
  void processFrame()

  return {
    stream,
    dispose: () => {
      stopped = true
      cancelAnimationFrame(frameHandle)
      worker.terminate()
      input.pause()
      input.srcObject = null
      stream.getTracks().forEach((item) => item.stop())
    },
  }
}
