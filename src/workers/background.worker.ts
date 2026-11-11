let sourceCanvas: OffscreenCanvas | undefined
let outputCanvas: OffscreenCanvas | undefined
let sourceContext: OffscreenCanvasRenderingContext2D | null = null
let outputContext: OffscreenCanvasRenderingContext2D | null = null
let background: Uint8ClampedArray | undefined
let width = 0
let height = 0

const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ImageBitmap>) => void) | null
  postMessage: (message: ImageBitmap, transfer: Transferable[]) => void
}

workerScope.onmessage = (event: MessageEvent<ImageBitmap>) => {
  const frame = event.data
  width = frame.width
  height = frame.height
  if (!sourceCanvas || sourceCanvas.width !== width || sourceCanvas.height !== height) {
    sourceCanvas = new OffscreenCanvas(width, height)
    outputCanvas = new OffscreenCanvas(width, height)
    sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true })
    outputContext = outputCanvas.getContext('2d')
    background = undefined
  }
  if (!sourceContext || !outputContext || !outputCanvas) {
    frame.close()
    return
  }

  sourceContext.drawImage(frame, 0, 0, width, height)
  const current = sourceContext.getImageData(0, 0, width, height)
  if (!background) background = new Uint8ClampedArray(current.data)
  outputContext.filter = 'blur(14px)'
  outputContext.drawImage(frame, 0, 0, width, height)
  outputContext.filter = 'none'

  const foreground = new ImageData(width, height)
  for (let index = 0; index < current.data.length; index += 4) {
    const red = current.data[index] - background[index]
    const green = current.data[index + 1] - background[index + 1]
    const blue = current.data[index + 2] - background[index + 2]
    if (red * red + green * green + blue * blue > 2500) {
      foreground.data[index] = current.data[index]
      foreground.data[index + 1] = current.data[index + 1]
      foreground.data[index + 2] = current.data[index + 2]
      foreground.data[index + 3] = 255
    }
  }
  outputContext.putImageData(foreground, 0, 0)
  frame.close()
  const result = outputCanvas.transferToImageBitmap()
  workerScope.postMessage(result, [result])
}
