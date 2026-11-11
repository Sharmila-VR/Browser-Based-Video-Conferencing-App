import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { createAudioPipeline, type AudioPipeline } from './rtc/audio'
import { createBackgroundEffect, type BackgroundEffect } from './rtc/backgroundEffect'
import { PeerMesh, type RemoteParticipant } from './rtc/PeerMesh'
import { startCallRecording, type CallRecording } from './rtc/recording'
import type { NetworkMetrics } from './rtc/quality'

type PanelName = 'chat' | 'people' | 'settings' | 'stats' | null
type ChatMessage = {
  id: string
  from: string
  text: string
  time: string
  fileUrl?: string
  fileName?: string
}
type DeviceOption = { deviceId: string; label: string }

type RecognitionResultEvent = Event & { results: SpeechRecognitionResultList }
interface SpeechRecognizer {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: RecognitionResultEvent) => void) | null
  onerror: (() => void) | null
  start: () => void
  stop: () => void
}
type SpeechWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognizer
  webkitSpeechRecognition?: new () => SpeechRecognizer
}

const EMPTY_METRICS: NetworkMetrics = {
  bitrate: 0,
  packetLoss: 0,
  jitter: 0,
  rtt: 0,
  quality: 'good',
}

function makeRoomCode(): string {
  return Math.random().toString(36).slice(2, 8)
}

function formatBitrate(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} Mbps`
  return `${Math.round(value / 1000)} Kbps`
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
}

function VideoTile({
  id,
  name,
  stream,
  screenStream,
  isLocal = false,
  muted = false,
  cameraOff = false,
  quality = EMPTY_METRICS.quality,
  active = false,
  pinned = false,
  handRaised = false,
  reaction = '',
  mirrorVideo = isLocal,
  onPin,
  onSpeaker,
  videoRef,
}: {
  id: string
  name: string
  stream?: MediaStream | null
  screenStream?: MediaStream | null
  isLocal?: boolean
  muted?: boolean
  cameraOff?: boolean
  quality?: NetworkMetrics['quality']
  active?: boolean
  pinned?: boolean
  handRaised?: boolean
  reaction?: string
  mirrorVideo?: boolean
  onPin?: (id: string) => void
  onSpeaker?: (id: string, speaking: boolean) => void
  videoRef?: (id: string, element: HTMLVideoElement | null) => void
}) {
  const elementRef = useRef<HTMLVideoElement>(null)
  const cameraRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = elementRef.current
    if (!video) return
    const activeStream = screenStream ?? stream
    video.srcObject = activeStream ?? null
    if (activeStream) void video.play().catch(() => undefined)
    return () => {
      video.srcObject = null
    }
  }, [screenStream, stream])

  useEffect(() => {
    const video = cameraRef.current
    if (!video) return
    video.srcObject = screenStream && !cameraOff ? stream ?? null : null
    if (video.srcObject) void video.play().catch(() => undefined)
    return () => {
      video.srcObject = null
    }
  }, [cameraOff, screenStream, stream])

  useEffect(() => {
    if (!stream?.getAudioTracks().some((track) => track.readyState === 'live') || isLocal) return
    const context = new AudioContext()
    const source = context.createMediaStreamSource(stream)
    const analyser = context.createAnalyser()
    const data = new Uint8Array(analyser.fftSize)
    source.connect(analyser)
    let activeUntil = 0
    const sample = () => {
      analyser.getByteTimeDomainData(data)
      let total = 0
      for (const value of data) total += ((value - 128) / 128) ** 2
      const rms = Math.sqrt(total / data.length)
      if (rms > 0.045) {
        activeUntil = performance.now() + 700
        onSpeaker?.(id, true)
      } else if (performance.now() > activeUntil) {
        onSpeaker?.(id, false)
      }
      timer = window.setTimeout(sample, 180)
    }
    let timer = window.setTimeout(sample, 180)
    return () => {
      window.clearTimeout(timer)
      source.disconnect()
      analyser.disconnect()
      void context.close()
    }
  }, [id, isLocal, onSpeaker, stream])

  return (
    <article
      className={`video-tile${active ? ' is-active' : ''}${pinned ? ' is-pinned' : ''}${isLocal ? ' is-local' : ''}${isLocal && !mirrorVideo ? ' is-screen-share' : ''}`}
      aria-label={`${name}${muted ? ', microphone muted' : ''}${cameraOff ? ', camera off' : ''}`}
    >
      <video
        ref={(element) => {
          elementRef.current = element
          videoRef?.(id, element)
        }}
        autoPlay
        playsInline
        muted={isLocal}
        className={cameraOff && !screenStream ? 'video-hidden' : ''}
        aria-label={`${name} video`}
      />
      {screenStream && (
        <video
          ref={(element) => {
            cameraRef.current = element
            videoRef?.(`${id}:camera`, element)
          }}
          autoPlay
          muted
          playsInline
          className={`tile-camera-preview${cameraOff ? ' video-hidden' : ''}`}
          aria-label={`${name} camera preview while sharing a screen`}
        />
      )}
      {cameraOff && !screenStream && (
        <div className="avatar-placeholder" aria-hidden="true">
          <span>{initials(name)}</span>
        </div>
      )}
      <div className="tile-gradient" />
      <div className="tile-person">
        <span className={`connection-dot quality-${quality}`} aria-label={`${quality} connection`} />
        <span>{name}{isLocal ? ' (you)' : ''}</span>
        {muted && <span className="tile-state">Muted</span>}
      </div>
      {handRaised && <div className="tile-banner">Hand raised</div>}
      {reaction && <div className="reaction-banner" role="status">{reaction}</div>}
      {onPin && (
        <button
          className="tile-pin"
          type="button"
          onClick={() => onPin(id)}
          aria-label={pinned ? `Unpin ${name}` : `Pin ${name}`}
        >
          {pinned ? 'Unpin' : 'Pin'}
        </button>
      )}
    </article>
  )
}

function MetricGraph({ values, label }: { values: number[]; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    const width = canvas.clientWidth * devicePixelRatio
    const height = canvas.clientHeight * devicePixelRatio
    canvas.width = width
    canvas.height = height
    context.clearRect(0, 0, width, height)
    context.strokeStyle = '#29423e'
    context.lineWidth = devicePixelRatio
    for (let row = 1; row < 4; row += 1) {
      context.beginPath()
      context.moveTo(0, (height * row) / 4)
      context.lineTo(width, (height * row) / 4)
      context.stroke()
    }
    if (values.length < 2) return
    const max = Math.max(...values, 1)
    context.strokeStyle = '#91d1b3'
    context.lineWidth = 2 * devicePixelRatio
    context.beginPath()
    values.forEach((value, index) => {
      const x = (index / (values.length - 1)) * width
      const y = height - (value / max) * (height * 0.82) - height * 0.08
      if (index === 0) context.moveTo(x, y)
      else context.lineTo(x, y)
    })
    context.stroke()
  }, [values])
  return <canvas ref={canvasRef} className="metric-graph" role="img" aria-label={`${label} history`} />
}

function App() {
  const [name, setName] = useState('')
  const [room, setRoom] = useState(() => new URLSearchParams(location.search).get('room') || makeRoomCode())
  const [inCall, setInCall] = useState(false)
  const [mediaBusy, setMediaBusy] = useState(false)
  const [mediaError, setMediaError] = useState('')
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null)
  const [cameraOn, setCameraOn] = useState(true)
  const [microphoneOn, setMicrophoneOn] = useState(true)
  const [videoDevices, setVideoDevices] = useState<DeviceOption[]>([])
  const [audioDevices, setAudioDevices] = useState<DeviceOption[]>([])
  const [videoDevice, setVideoDevice] = useState('')
  const [audioDevice, setAudioDevice] = useState('')
  const [inputLevel, setInputLevel] = useState(0)
  const [loopback, setLoopback] = useState(false)
  const [participants, setParticipants] = useState<RemoteParticipant[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [panel, setPanel] = useState<PanelName>(null)
  const [notice, setNotice] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const [activeSpeaker, setActiveSpeaker] = useState('')
  const [pinnedParticipant, setPinnedParticipant] = useState('')
  const [handRaised, setHandRaised] = useState(false)
  const [highContrast, setHighContrast] = useState(false)
  const [blurEnabled, setBlurEnabled] = useState(false)
  const [screenSharing, setScreenSharing] = useState(false)
  const [captionsEnabled, setCaptionsEnabled] = useState(false)
  const [captionText, setCaptionText] = useState('')
  const [recordingState, setRecordingState] = useState<RecordingState>('inactive')
  const [reactionMenuOpen, setReactionMenuOpen] = useState(false)
  const [fileProgress, setFileProgress] = useState<{ sent: number; total: number } | null>(null)
  const [simLatency, setSimLatency] = useState(0)
  const [simJitter, setSimJitter] = useState(0)
  const [simLoss, setSimLoss] = useState(0)
  const [simBandwidth, setSimBandwidth] = useState(1800)
  const [history, setHistory] = useState<{ bitrate: number; loss: number; rtt: number }[]>([])
  const [inviteCopied, setInviteCopied] = useState(false)
  const [reactions, setReactions] = useState<Record<string, string>>({})

  const rawStreamRef = useRef<MediaStream | null>(null)
  const outputStreamRef = useRef<MediaStream | null>(null)
  const pipelineRef = useRef<AudioPipeline | null>(null)
  const effectRef = useRef<BackgroundEffect | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const meshRef = useRef<PeerMesh | null>(null)
  const recorderRef = useRef<CallRecording | null>(null)
  const videoElements = useRef(new Map<string, HTMLVideoElement>())
  const chatEndRef = useRef<HTMLDivElement>(null)
  const loopbackAudioRef = useRef<HTMLAudioElement>(null)
  const recognitionRef = useRef<SpeechRecognizer | null>(null)
  const participantsRef = useRef(participants)
  const activeSpeakerRef = useRef('')
  participantsRef.current = participants

  const reportNotice = useCallback((message: string) => {
    setNotice(message)
    setAnnouncement(message)
    window.setTimeout(() => setNotice((current) => current === message ? '' : current), 4500)
  }, [])

  const updateSpeaker = useCallback((id: string, speaking: boolean) => {
    if (speaking && activeSpeakerRef.current !== id) {
      activeSpeakerRef.current = id
      setActiveSpeaker(id)
      const speakerName =
        id === 'self'
          ? name.trim() || 'You'
          : participantsRef.current.find((participant) => participant.id === id)?.name ?? 'A participant'
      setAnnouncement(`${speakerName} is speaking.`)
    } else if (!speaking && activeSpeakerRef.current === id) {
      activeSpeakerRef.current = ''
      setActiveSpeaker('')
      setAnnouncement('No one is speaking.')
    }
  }, [name])

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    const devices = await navigator.mediaDevices.enumerateDevices()
    setVideoDevices(
      devices
        .filter((device) => device.kind === 'videoinput')
        .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Camera ${index + 1}` })),
    )
    setAudioDevices(
      devices
        .filter((device) => device.kind === 'audioinput')
        .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Microphone ${index + 1}` })),
    )
  }, [])

  const disposeMedia = useCallback(() => {
    meshRef.current?.close()
    meshRef.current = null
    recorderRef.current?.stop().catch((error: unknown) => {
      reportNotice(error instanceof Error ? error.message : 'The recording could not be saved.')
    })
    recorderRef.current = null
    recognitionRef.current?.stop()
    recognitionRef.current = null
    effectRef.current?.dispose()
    effectRef.current = null
    screenStreamRef.current?.getTracks().forEach((track) => track.stop())
    screenStreamRef.current = null
    rawStreamRef.current?.getTracks().forEach((track) => track.stop())
    rawStreamRef.current = null
    outputStreamRef.current?.getTracks().forEach((track) => track.stop())
    outputStreamRef.current = null
    const pipeline = pipelineRef.current
    pipelineRef.current = null
    if (pipeline) void pipeline.dispose()
    setPreviewStream(null)
    setParticipants([])
    setScreenSharing(false)
    setBlurEnabled(false)
    setLoopback(false)
    setRecordingState('inactive')
  }, [reportNotice])

  useEffect(() => {
    const updateDevices = () => {
      void refreshDevices().catch((error: unknown) => {
        reportNotice(error instanceof Error ? error.message : 'Device list could not be refreshed.')
      })
    }
    navigator.mediaDevices?.addEventListener('devicechange', updateDevices)
    return () => {
      navigator.mediaDevices?.removeEventListener('devicechange', updateDevices)
      disposeMedia()
    }
  }, [disposeMedia, refreshDevices, reportNotice])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages])

  useEffect(() => {
    if (!inCall || inputLevel <= 0.045) {
      updateSpeaker('self', false)
    } else {
      updateSpeaker('self', true)
    }
  }, [inCall, inputLevel, updateSpeaker])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
      const key = event.key.toLowerCase()
      if (key === 'm') toggleMicrophone()
      if (key === 'v') toggleCamera()
      if (key === 'r' && inCall) toggleHand()
      if (event.key === 'Escape' && inCall) leaveCall()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  useEffect(() => {
    meshRef.current?.setSimulation({ latency: simLatency, jitter: simJitter, loss: simLoss })
    void meshRef.current?.setQualityCap(simBandwidth * 1000).catch((error: unknown) => {
      reportNotice(error instanceof Error ? error.message : 'Bandwidth cap could not be applied.')
    })
  }, [reportNotice, simBandwidth, simJitter, simLatency, simLoss])

  useEffect(() => {
    if (!inCall || participants.length === 0) return
    const latest = participants.reduce(
      (value, participant) => ({
        bitrate: value.bitrate + participant.metrics.bitrate,
        loss: Math.max(value.loss, participant.metrics.packetLoss),
        rtt: Math.max(value.rtt, participant.metrics.rtt * 1000),
      }),
      { bitrate: 0, loss: 0, rtt: 0 },
    )
    setHistory((values) => [...values.slice(-29), latest])
  }, [inCall, participants])

  const requestMedia = useCallback(async (selectedVideo = videoDevice, selectedAudio = audioDevice) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMediaError('Camera and microphone access requires a supported browser on HTTPS or localhost.')
      return null
    }
    setMediaBusy(true)
    setMediaError('')
    let acquired: MediaStream | null = null
    try {
      const raw = await navigator.mediaDevices.getUserMedia({
        video: selectedVideo
          ? { deviceId: { exact: selectedVideo }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }
          : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
        audio: selectedAudio
          ? { deviceId: { exact: selectedAudio }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
          : { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      acquired = raw
      const pipeline = await createAudioPipeline(raw, setInputLevel)
      const output = new MediaStream([
        ...raw.getVideoTracks(),
        ...pipeline.stream.getAudioTracks(),
      ])
      const oldRaw = rawStreamRef.current
      const oldOutput = outputStreamRef.current
      const oldPipeline = pipelineRef.current
      effectRef.current?.dispose()
      effectRef.current = null
      rawStreamRef.current = raw
      outputStreamRef.current = output
      pipelineRef.current = pipeline
      setPreviewStream(raw)
      setCameraOn(raw.getVideoTracks().some((track) => track.enabled))
      setMicrophoneOn(raw.getAudioTracks().some((track) => track.enabled))
      void refreshDevices().catch((error: unknown) => {
        reportNotice(error instanceof Error ? error.message : 'Device list could not be refreshed.')
      })
      oldRaw?.getTracks().forEach((track) => track.stop())
      oldOutput?.getTracks().forEach((track) => track.stop())
      if (oldPipeline) {
        void oldPipeline.dispose().catch((error: unknown) => {
          reportNotice(error instanceof Error ? error.message : 'The previous audio pipeline could not be closed.')
        })
      }
      if (meshRef.current) {
        const videoTrack = raw.getVideoTracks()[0]
        const audioTrack = pipeline.stream.getAudioTracks()[0]
        if (videoTrack) meshRef.current.setVideoTrack(videoTrack)
        if (audioTrack) meshRef.current.setAudioTrack(audioTrack)
      }
      setBlurEnabled(false)
      acquired = null
      return raw
    } catch (error) {
      acquired?.getTracks().forEach((track) => track.stop())
      setMediaError(error instanceof Error ? error.message : 'Camera and microphone could not be started.')
      if (inCall) reportNotice(error instanceof Error ? error.message : 'Camera and microphone could not be switched.')
      return null
    } finally {
      setMediaBusy(false)
    }
  }, [audioDevice, inCall, refreshDevices, reportNotice, videoDevice])

  const toggleMicrophone = useCallback(() => {
    const tracks = rawStreamRef.current?.getAudioTracks() ?? []
    if (!tracks.length) {
      reportNotice('Enable your microphone before joining the room.')
      return
    }
    const next = !tracks[0].enabled
    tracks.forEach((track) => {
      track.enabled = next
    })
    setMicrophoneOn(next)
    meshRef.current?.send({ kind: 'participant-state', muted: !next })
    setAnnouncement(next ? 'Microphone on.' : 'Microphone muted.')
  }, [reportNotice])

  const toggleCamera = useCallback(() => {
    const tracks = rawStreamRef.current?.getVideoTracks() ?? []
    if (!tracks.length) {
      reportNotice('Enable your camera before joining the room.')
      return
    }
    const next = !tracks[0].enabled
    tracks.forEach((track) => {
      track.enabled = next
    })
    effectRef.current?.stream.getVideoTracks().forEach((track) => {
      track.enabled = next
    })
    setCameraOn(next)
    meshRef.current?.send({ kind: 'participant-state', cameraOff: !next })
    setAnnouncement(next ? 'Camera on.' : 'Camera off.')
  }, [reportNotice])

  const startCall = useCallback(async () => {
    if (!name.trim()) {
      setMediaError('Enter your name to continue.')
      return
    }
    if (typeof RTCPeerConnection === 'undefined' || typeof BroadcastChannel === 'undefined') {
      setMediaError('This browser does not support the native peer connection and room signaling APIs required by Gather.')
      return
    }
    const stream = rawStreamRef.current ?? await requestMedia()
    if (!stream) return
    const output = outputStreamRef.current
    if (!output) {
      setMediaError('Audio processing could not be started. Please enable your devices again.')
      return
    }
    const normalizedRoom = room.trim().replace(/[^a-zA-Z0-9-]/g, '').slice(0, 32)
    if (!normalizedRoom) {
      setMediaError('Choose a room code using letters, numbers, or hyphens.')
      return
    }
    setRoom(normalizedRoom)
    const localId = crypto.randomUUID()
    activeSpeakerRef.current = ''
    setActiveSpeaker('')
    const mesh = new PeerMesh(normalizedRoom, localId, name.trim(), output, {
      onParticipants: (current) => {
        setParticipants(current)
      },
      onData: (data, peerId) => {
        const senderName = participantsRef.current.find((participant) => participant.id === peerId)?.name ?? 'Participant'
        if (data.kind === 'chat' && typeof data.text === 'string') {
          const text = data.text
          setMessages((current) => [
            ...current,
            { id: crypto.randomUUID(), from: senderName, text, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
          ])
        } else if (data.kind === 'participant-state') {
          setParticipants((current) => current.map((participant) =>
            participant.id === peerId
              ? { ...participant, muted: Boolean(data.muted ?? participant.muted), cameraOff: Boolean(data.cameraOff ?? participant.cameraOff), handRaised: Boolean(data.handRaised ?? participant.handRaised) }
              : participant,
          ))
        } else if (data.kind === 'reaction' && typeof data.text === 'string') {
          const text = data.text
          setReactions((current) => ({ ...current, [peerId]: text }))
          window.setTimeout(() => setReactions((current) =>
            current[peerId] === text ? { ...current, [peerId]: '' } : current,
          ), 2600)
        } else if (data.kind === 'file-received' && data.blob instanceof Blob && typeof data.name === 'string') {
          const fileName = data.name
          const fileUrl = URL.createObjectURL(data.blob)
          setMessages((current) => [
            ...current,
            { id: crypto.randomUUID(), from: senderName, text: 'Shared a file', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), fileUrl, fileName },
          ])
        }
      },
      onNotice: reportNotice,
    })
    meshRef.current = mesh
    setPanel(null)
    setInCall(true)
    setMediaError('')
  }, [name, reportNotice, requestMedia, room])

  const leaveCall = useCallback(() => {
    disposeMedia()
    setInCall(false)
    setMessages((current) => {
      current.forEach((message) => {
        if (message.fileUrl) URL.revokeObjectURL(message.fileUrl)
      })
      return []
    })
    setPanel(null)
    setHistory([])
    setAnnouncement('You left the room. Camera and microphone have been released.')
  }, [disposeMedia])

  const toggleHand = useCallback(() => {
    const next = !handRaised
    setHandRaised(next)
    meshRef.current?.send({ kind: 'participant-state', handRaised: next })
    setAnnouncement(next ? 'Hand raised.' : 'Hand lowered.')
  }, [handRaised])

  const toggleScreenShare = useCallback(async () => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => track.stop())
      return
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      reportNotice('Screen sharing is not available in this browser.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      const track = stream.getVideoTracks()[0]
      if (!track) throw new Error('No screen video track was selected.')
      try {
        await meshRef.current?.setScreenTrack(track)
      } catch (error) {
        stream.getTracks().forEach((item) => item.stop())
        throw error
      }
      screenStreamRef.current = stream
      setScreenSharing(true)
      track.onended = () => {
        const current = screenStreamRef.current
        current?.getTracks().forEach((item) => item.stop())
        screenStreamRef.current = null
        void meshRef.current?.setScreenTrack(null).catch((error: unknown) => {
          reportNotice(error instanceof Error ? error.message : 'Screen sharing could not be stopped.')
        })
        setScreenSharing(false)
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotAllowedError')) {
        reportNotice(error instanceof Error ? error.message : 'Screen sharing could not be started.')
      }
    }
  }, [reportNotice])

  const toggleBackground = useCallback(async () => {
    if (screenSharing) {
      reportNotice('Stop screen sharing before enabling background softening.')
      return
    }
    if (effectRef.current) {
      effectRef.current.dispose()
      effectRef.current = null
      const raw = rawStreamRef.current
      if (raw) {
        setPreviewStream(raw)
        const track = raw.getVideoTracks()[0]
        if (track) meshRef.current?.setVideoTrack(track)
      }
      setBlurEnabled(false)
      return
    }
    if (!cameraOn) {
      reportNotice('Turn on your camera before enabling background softening.')
      return
    }
    const track = rawStreamRef.current?.getVideoTracks()[0]
    if (!track) {
      reportNotice('Enable your camera before turning on background blur.')
      return
    }
    try {
      const effect = await createBackgroundEffect(track)
      effectRef.current = effect
      setPreviewStream(effect.stream)
      const effectTrack = effect.stream.getVideoTracks()[0]
      if (effectTrack) meshRef.current?.setVideoTrack(effectTrack)
      setBlurEnabled(true)
    } catch (error) {
      reportNotice(error instanceof Error ? error.message : 'Background blur could not be started.')
    }
  }, [cameraOn, reportNotice, screenSharing])

  const sendReaction = useCallback((text: string) => {
    meshRef.current?.send({ kind: 'reaction', text })
    setReactions((current) => ({ ...current, self: text }))
    window.setTimeout(() => setReactions((current) => ({ ...current, self: '' })), 2600)
    setReactionMenuOpen(false)
  }, [])

  const sendMessage = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const text = draft.trim()
    if (!text) return
    const message = {
      kind: 'chat',
      text,
      from: name.trim(),
      time: Date.now(),
    }
    meshRef.current?.send(message)
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), from: `${name.trim()} (you)`, text, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
    ])
    setDraft('')
  }, [draft, name])

  const shareFile = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > 25 * 1024 * 1024) {
      reportNotice('Files are limited to 25 MB per transfer.')
      return
    }
    setFileProgress({ sent: 0, total: file.size })
    try {
      await meshRef.current?.sendFile(file, (sent, total) => setFileProgress({ sent, total }))
      setMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), from: `${name.trim()} (you)`, text: 'Shared a file', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), fileName: file.name },
      ])
    } catch (error) {
      reportNotice(error instanceof Error ? error.message : 'File transfer failed.')
    } finally {
      window.setTimeout(() => setFileProgress(null), 1500)
    }
  }, [name, reportNotice])

  const toggleLoopback = useCallback(async () => {
    const audio = loopbackAudioRef.current
    const output = outputStreamRef.current
    if (!audio || !output) {
      reportNotice('Enable your devices before testing the microphone.')
      return
    }
    if (loopback) {
      audio.pause()
      audio.srcObject = null
      setLoopback(false)
      return
    }
    audio.srcObject = new MediaStream(output.getAudioTracks())
    try {
      await audio.play()
      setLoopback(true)
    } catch (error) {
      reportNotice(error instanceof Error ? error.message : 'Microphone loopback could not be started.')
    }
  }, [loopback, reportNotice])

  const toggleCaptions = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop()
      recognitionRef.current = null
      setCaptionsEnabled(false)
      setCaptionText('')
      return
    }
    const Recognition =
      (window as SpeechWindow).SpeechRecognition ??
      (window as SpeechWindow).webkitSpeechRecognition
    if (!Recognition) {
      reportNotice('Live captions are not supported in this browser.')
      return
    }
    const recognition = new Recognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = navigator.language
    recognition.onresult = (event) => {
      const last = event.results[event.results.length - 1]
      if (last) setCaptionText(last[0].transcript)
    }
    recognition.onerror = () => {
      recognitionRef.current = null
      setCaptionsEnabled(false)
      reportNotice('Live captions stopped because speech recognition reported an error.')
    }
    recognition.start()
    recognitionRef.current = recognition
    setCaptionsEnabled(true)
  }, [reportNotice])

  const toggleRecording = useCallback(async () => {
    if (recorderRef.current) {
      const recorder = recorderRef.current
      recorderRef.current = null
      try {
        await recorder.stop()
        setRecordingState('inactive')
      } catch (error) {
        reportNotice(error instanceof Error ? error.message : 'The recording could not be saved.')
      }
      return
    }
    const videos = [...videoElements.current.values()]
    const streams = [
      outputStreamRef.current,
      ...participants.map((participant) => participant.stream),
    ].filter((stream): stream is MediaStream => Boolean(stream))
    try {
      recorderRef.current = await startCallRecording(
        videos,
        streams,
        setRecordingState,
        reportNotice,
      )
    } catch (error) {
      reportNotice(error instanceof Error ? error.message : 'Recording could not be started.')
    }
  }, [participants, reportNotice])

  const copyInvite = useCallback(async () => {
    const invite = `${location.origin}${location.pathname}?room=${encodeURIComponent(room)}`
    try {
      await navigator.clipboard.writeText(invite)
      setInviteCopied(true)
      window.setTimeout(() => setInviteCopied(false), 1800)
    } catch (error) {
      reportNotice(error instanceof Error ? error.message : 'Invite link could not be copied.')
    }
  }, [reportNotice, room])

  const changeDevice = useCallback(async (kind: 'video' | 'audio', deviceId: string) => {
    if (kind === 'video') setVideoDevice(deviceId)
    else setAudioDevice(deviceId)
    await requestMedia(kind === 'video' ? deviceId : videoDevice, kind === 'audio' ? deviceId : audioDevice)
  }, [audioDevice, requestMedia, videoDevice])

  const togglePanel = (next: PanelName) => setPanel((current) => current === next ? null : next)
  const pin = (id: string) => setPinnedParticipant((current) => current === id ? '' : id)

  const people = [
    {
      id: 'self',
      name: name.trim() || 'You',
      stream: previewStream,
      screenStream: screenSharing ? screenStreamRef.current : null,
      local: true,
      muted: !microphoneOn,
      cameraOff: !cameraOn,
      metrics: EMPTY_METRICS,
      handRaised,
      reaction: reactions.self ?? '',
    },
    ...participants.map((participant) => ({
      ...participant,
      local: false,
      cameraOff: participant.cameraOff || !participant.stream?.getVideoTracks().some((track) => track.enabled),
      reaction: reactions[participant.id] ?? participant.reaction,
    })),
  ]
  const featuredId = pinnedParticipant || activeSpeaker
  const featured = people.find((person) => person.id === featuredId)
  return (
    <main className={highContrast ? 'app high-contrast' : 'app'}>
      <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
      <audio ref={loopbackAudioRef} className="sr-only" aria-label="Microphone loopback test" />
      {notice && <div className="notice" role="status">{notice}</div>}
      {!inCall ? (
        <div className="lobby">
          <header className="brand-header">
            <a className="brand" href="#" aria-label="Gather home"><span className="brand-mark">G</span> gather</a>
            <span className="header-caption">Private rooms for good conversations</span>
          </header>
          <section className="lobby-layout">
            <div className="lobby-copy">
              <p className="eyebrow">A calmer kind of meeting</p>
              <h1>Make room for<br /><span>better conversations.</span></h1>
              <p className="intro-copy">A simple, thoughtful place to meet face to face. No downloads, no fuss. Just share a room and get started.</p>
              <div className="room-form">
                <label htmlFor="display-name">Your name</label>
                <input id="display-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="How should people address you?" autoComplete="name" maxLength={48} />
                <label htmlFor="room-code">Room code</label>
                <div className="room-input">
                  <input id="room-code" value={room} onChange={(event) => setRoom(event.target.value)} maxLength={32} />
                  <button type="button" className="text-button" onClick={() => setRoom(makeRoomCode())}>New room</button>
                </div>
                <button className="primary-button join-button" type="button" onClick={() => void startCall()} disabled={mediaBusy}>
                  {mediaBusy ? 'Preparing your room' : 'Join room'}
                </button>
                <p className="helper-text">Joining as <strong>{name.trim() || 'Guest'}</strong></p>
                {mediaError && <p className="form-error" role="alert">{mediaError}</p>}
              </div>
            </div>
            <section className="device-card" aria-label="Camera and microphone preview">
              <div className="preview-stage">
                {previewStream ? (
                  <>
                    <video
                      ref={(element) => {
                        if (element) {
                          element.srcObject = previewStream
                          void element.play().catch(() => undefined)
                        }
                      }}
                      autoPlay
                      muted
                      playsInline
                      className={cameraOn ? '' : 'video-hidden'}
                      aria-label="Your camera preview"
                    />
                    {!cameraOn && <div className="preview-avatar">{initials(name || 'Guest')}</div>}
                  </>
                ) : (
                  <div className="camera-empty">
                    <span className="camera-empty-mark">G</span>
                    <p>Your camera preview appears here</p>
                  </div>
                )}
                <span className="preview-label">{previewStream ? 'Camera preview' : 'Device check'}</span>
                {previewStream && <span className="preview-name">{name.trim() || 'Guest'}</span>}
              </div>
              <div className="meter-row">
                <span>Microphone level</span>
                <div className="level-meter" role="meter" aria-label="Microphone input level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(inputLevel * 100)}>
                  <span style={{ width: `${Math.min(inputLevel * 100, 100)}%` }} />
                </div>
              </div>
              <div className="device-selectors">
                <label htmlFor="camera-select">Camera</label>
                <select id="camera-select" value={videoDevice} onChange={(event) => void changeDevice('video', event.target.value)} disabled={!videoDevices.length}>
                  <option value="">Default camera</option>
                  {videoDevices.map((device) => <option value={device.deviceId} key={device.deviceId}>{device.label}</option>)}
                </select>
                <label htmlFor="microphone-select">Microphone</label>
                <select id="microphone-select" value={audioDevice} onChange={(event) => void changeDevice('audio', event.target.value)} disabled={!audioDevices.length}>
                  <option value="">Default microphone</option>
                  {audioDevices.map((device) => <option value={device.deviceId} key={device.deviceId}>{device.label}</option>)}
                </select>
              </div>
              <div className="device-actions">
                <button className="secondary-button" type="button" onClick={() => void requestMedia()} disabled={mediaBusy}>
                  {mediaBusy ? 'Enabling devices' : previewStream ? 'Refresh devices' : 'Enable camera and mic'}
                </button>
                <button className={`text-button${loopback ? ' is-selected' : ''}`} type="button" onClick={() => void toggleLoopback()}>
                  {loopback ? 'Stop mic test' : 'Test microphone'}
                </button>
              </div>
            </section>
          </section>
          <footer className="lobby-footer">
            <span>Built for conversations, not conference rooms.</span>
            <span>Use the invite link in another tab to test a room.</span>
          </footer>
        </div>
      ) : (
        <div className="meeting-shell">
          <header className="meeting-header">
            <a className="brand brand-small" href="#" aria-label="Gather home"><span className="brand-mark">G</span> gather</a>
            <div className="meeting-room-label">
              <span className="live-indicator" />
              <span>{room}</span>
              <span className="room-separator">/</span>
              <span>{people.length} {people.length === 1 ? 'person' : 'people'}</span>
            </div>
            <div className="meeting-header-actions">
              <button className="header-button" type="button" onClick={() => void copyInvite()}>{inviteCopied ? 'Link copied' : 'Copy invite'}</button>
              <button className="header-button contrast-button" type="button" onClick={() => setHighContrast((value) => !value)} aria-pressed={highContrast}>
                {highContrast ? 'Standard contrast' : 'High contrast'}
              </button>
            </div>
          </header>
          <div className="meeting-content">
            <section className={`stage ${panel ? 'stage-with-panel' : ''}`} aria-label="Meeting video grid">
              {featured && people.length > 1 ? (
                <div className="spotlight-layout">
                  <VideoTile
                    key={featured.id}
                    id={featured.id}
                    name={featured.name}
                    stream={featured.stream}
                    screenStream={featured.screenStream}
                    isLocal={featured.local}
                    muted={featured.muted}
                    cameraOff={featured.cameraOff}
                    quality={featured.metrics.quality}
                    active={featured.id === activeSpeaker}
                    pinned={featured.id === pinnedParticipant}
                    handRaised={featured.handRaised}
                    reaction={featured.reaction}
                    mirrorVideo={!featured.local || !screenSharing}
                    onPin={pin}
                    onSpeaker={updateSpeaker}
                    videoRef={(id, element) => element ? videoElements.current.set(id, element) : videoElements.current.delete(id)}
                  />
                  <div className="spotlight-strip">
                    {people.filter((person) => person.id !== featured.id).map((person) => (
                      <VideoTile
                        key={person.id}
                        id={person.id}
                        name={person.name}
                        stream={person.stream}
                        screenStream={person.screenStream}
                        isLocal={person.local}
                        muted={person.muted}
                        cameraOff={person.cameraOff}
                        quality={person.metrics.quality}
                        active={person.id === activeSpeaker}
                        pinned={person.id === pinnedParticipant}
                        handRaised={person.handRaised}
                        reaction={person.reaction}
                        mirrorVideo={!person.local || !screenSharing}
                        onPin={pin}
                        onSpeaker={updateSpeaker}
                        videoRef={(id, element) => element ? videoElements.current.set(id, element) : videoElements.current.delete(id)}
                      />
                    ))}
                  </div>
                </div>
              ) : (
                <div className={`video-grid participant-count-${Math.min(people.length, 6)}`}>
                  {people.map((person) => (
                    <VideoTile
                      key={person.id}
                      id={person.id}
                      name={person.name}
                      stream={person.stream}
                      screenStream={person.screenStream}
                      isLocal={person.local}
                      muted={person.muted}
                      cameraOff={person.cameraOff}
                      quality={person.metrics.quality}
                      active={person.id === activeSpeaker}
                      pinned={person.id === pinnedParticipant}
                      handRaised={person.handRaised}
                      reaction={person.reaction}
                      mirrorVideo={!person.local || !screenSharing}
                      onPin={pin}
                      onSpeaker={updateSpeaker}
                      videoRef={(id, element) => element ? videoElements.current.set(id, element) : videoElements.current.delete(id)}
                    />
                  ))}
                </div>
              )}
              {participants.length === 0 && (
                <div className="waiting-note" role="status">
                  <span>Waiting for others to join</span>
                  <button type="button" onClick={() => void copyInvite()}>{inviteCopied ? 'Invite copied' : 'Copy room link'}</button>
                </div>
              )}
              {captionsEnabled && captionText && <div className="caption-box" aria-live="polite">{captionText}</div>}
              <div className="stage-footnote">End-to-end peer connections · Up to 6 participants</div>
            </section>
            {panel && (
              <aside className="side-panel" aria-label={`${panel} panel`}>
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">{room}</p>
                    <h2>{panel === 'chat' ? 'Room chat' : panel === 'people' ? 'People' : panel === 'stats' ? 'Connection stats' : 'Room settings'}</h2>
                  </div>
                  <button className="close-button" type="button" onClick={() => setPanel(null)} aria-label="Close panel">Close</button>
                </div>
                {panel === 'chat' && (
                  <>
                    <div className="chat-messages" aria-live="polite">
                      {messages.length === 0 && <p className="panel-empty">Messages shared here are delivered directly to connected participants.</p>}
                      {messages.map((message) => (
                        <article className="chat-message" key={message.id}>
                          <div className="chat-meta"><strong>{message.from}</strong><time>{message.time}</time></div>
                          <p>{message.text}</p>
                          {message.fileName && (
                            message.fileUrl
                              ? <a href={message.fileUrl} download={message.fileName} className="file-link">{message.fileName}</a>
                              : <span className="file-link">{message.fileName}</span>
                          )}
                        </article>
                      ))}
                      {fileProgress && (
                        <div className="transfer-progress">
                          <span>Sending file</span>
                          <progress value={fileProgress.sent} max={Math.max(fileProgress.total, 1)} />
                          <span>{Math.round((fileProgress.sent / Math.max(fileProgress.total, 1)) * 100)}%</span>
                        </div>
                      )}
                      <div ref={chatEndRef} />
                    </div>
                    <form className="chat-composer" onSubmit={sendMessage}>
                      <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Write a message" rows={2} maxLength={2000} aria-label="Chat message" />
                      <div className="composer-actions">
                        <label className="file-picker">Share file<input type="file" onChange={(event) => void shareFile(event)} /></label>
                        <button className="primary-button send-button" type="submit" disabled={!draft.trim()}>Send</button>
                      </div>
                    </form>
                  </>
                )}
                {panel === 'people' && (
                  <div className="participant-list">
                    {people.map((person) => (
                      <div className="participant-row" key={person.id}>
                        <span className="participant-avatar">{initials(person.name)}</span>
                        <div className="participant-description">
                          <strong>{person.name}{person.local ? ' (you)' : ''}</strong>
                          <span>{person.muted ? 'Microphone muted' : 'Microphone on'}</span>
                        </div>
                        <span className={`connection-dot quality-${person.metrics.quality}`} aria-label={`${person.metrics.quality} connection`} />
                      </div>
                    ))}
                    <button className="secondary-button full-button" type="button" onClick={() => void copyInvite()}>{inviteCopied ? 'Invite copied' : 'Copy invite link'}</button>
                  </div>
                )}
                {panel === 'settings' && (
                  <div className="settings-content">
                    <section className="settings-section">
                      <p className="section-label">Your devices</p>
                      <label htmlFor="call-camera">Camera</label>
                      <select id="call-camera" value={videoDevice} onChange={(event) => void changeDevice('video', event.target.value)}>
                        <option value="">Default camera</option>
                        {videoDevices.map((device) => <option value={device.deviceId} key={device.deviceId}>{device.label}</option>)}
                      </select>
                      <label htmlFor="call-mic">Microphone</label>
                      <select id="call-mic" value={audioDevice} onChange={(event) => void changeDevice('audio', event.target.value)}>
                        <option value="">Default microphone</option>
                        {audioDevices.map((device) => <option value={device.deviceId} key={device.deviceId}>{device.label}</option>)}
                      </select>
                    </section>
                    <section className="settings-section">
                      <p className="section-label">Effects and accessibility</p>
                      <button className="setting-row" type="button" onClick={() => void toggleBackground()} aria-pressed={blurEnabled}>
                        <span>Background softening</span><span>{blurEnabled ? 'On' : 'Off'}</span>
                      </button>
                      <button className="setting-row" type="button" onClick={toggleCaptions} aria-pressed={captionsEnabled}>
                        <span>Live captions</span><span>{captionsEnabled ? 'On' : 'Off'}</span>
                      </button>
                      <button className="setting-row" type="button" onClick={() => setHighContrast((value) => !value)} aria-pressed={highContrast}>
                        <span>High contrast</span><span>{highContrast ? 'On' : 'Off'}</span>
                      </button>
                    </section>
                    <section className="settings-section">
                      <p className="section-label">Keyboard shortcuts</p>
                      <p className="shortcut-row"><span>Microphone</span><kbd>M</kbd></p>
                      <p className="shortcut-row"><span>Camera</span><kbd>V</kbd></p>
                      <p className="shortcut-row"><span>Raise hand</span><kbd>R</kbd></p>
                      <p className="shortcut-row"><span>Leave room</span><kbd>Esc</kbd></p>
                    </section>
                  </div>
                )}
                {panel === 'stats' && (
                  <div className="stats-content">
                    <div className="stat-grid">
                      <MetricGraph values={history.map((item) => item.bitrate)} label="Bitrate" />
                      <MetricGraph values={history.map((item) => item.loss)} label="Packet loss" />
                      <MetricGraph values={history.map((item) => item.rtt)} label="Round-trip time" />
                    </div>
                    <div className="stat-legend"><span>Bitrate</span><span>Packet loss</span><span>Round-trip time</span></div>
                    {participants.map((participant) => (
                      <div className="peer-stat" key={participant.id}>
                        <div><strong>{participant.name}</strong><span className={`quality-text quality-text-${participant.metrics.quality}`}>{participant.metrics.quality} connection</span></div>
                        <dl>
                          <div><dt>Bitrate</dt><dd>{formatBitrate(participant.metrics.bitrate)}</dd></div>
                          <div><dt>Packet loss</dt><dd>{participant.metrics.packetLoss.toFixed(1)}%</dd></div>
                          <div><dt>Jitter</dt><dd>{Math.round(participant.metrics.jitter * 1000)} ms</dd></div>
                          <div><dt>Round trip</dt><dd>{Math.round(participant.metrics.rtt * 1000)} ms</dd></div>
                        </dl>
                      </div>
                    ))}
                    {participants.length === 0 && <p className="panel-empty">Detailed peer measurements appear when someone joins.</p>}
                  </div>
                )}
              </aside>
            )}
          </div>
          {panel === 'settings' && (
            <section className="network-lab" aria-label="Network simulation controls">
              <div className="lab-heading"><div><p className="eyebrow">Local test tools</p><strong>Network simulation</strong></div><span>Simulated messaging impairment and video bitrate cap</span></div>
              <label>Latency <input type="range" min="0" max="800" step="25" value={simLatency} onChange={(event) => setSimLatency(Number(event.target.value))} /><output>{simLatency} ms</output></label>
              <label>Jitter <input type="range" min="0" max="300" step="10" value={simJitter} onChange={(event) => setSimJitter(Number(event.target.value))} /><output>{simJitter} ms</output></label>
              <label>Message loss <input type="range" min="0" max="40" step="1" value={simLoss} onChange={(event) => setSimLoss(Number(event.target.value))} /><output>{simLoss}%</output></label>
              <label>Video cap <input type="range" min="150" max="1800" step="50" value={simBandwidth} onChange={(event) => setSimBandwidth(Number(event.target.value))} /><output>{simBandwidth} Kbps</output></label>
              <p className="lab-note">Browser APIs cannot inject RTP packet loss or real network latency. Delay and loss apply to room data messages.</p>
            </section>
          )}
          <footer className="control-bar">
            <div className="call-info"><strong>{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong><span>{room}</span></div>
            <div className="call-controls" role="toolbar" aria-label="Call controls">
              <ControlButton label={microphoneOn ? 'Mute' : 'Unmute'} state={microphoneOn ? 'on' : 'off'} onClick={toggleMicrophone} />
              <ControlButton label={cameraOn ? 'Stop video' : 'Start video'} state={cameraOn ? 'on' : 'off'} onClick={toggleCamera} />
              <ControlButton label={screenSharing ? 'Stop share' : 'Share screen'} state={screenSharing ? 'selected' : 'on'} onClick={() => void toggleScreenShare()} />
              <ControlButton label={handRaised ? 'Lower hand' : 'Raise hand'} state={handRaised ? 'selected' : 'on'} onClick={toggleHand} />
              <ControlButton label={recordingState === 'recording' ? 'Pause recording' : recordingState === 'paused' ? 'Resume recording' : 'Record'} state={recordingState !== 'inactive' ? 'selected' : 'on'} onClick={() => {
                if (recordingState === 'recording') recorderRef.current?.pause()
                else if (recordingState === 'paused') recorderRef.current?.resume()
                else void toggleRecording()
              }} />
              <ControlButton label={captionsEnabled ? 'Turn captions off' : 'Turn captions on'} state={captionsEnabled ? 'selected' : 'on'} onClick={toggleCaptions} />
              <ControlButton label="Background blur" state={blurEnabled ? 'selected' : 'on'} onClick={() => void toggleBackground()} />
              <div className="reaction-picker">
                <button className="reaction-trigger" type="button" aria-expanded={reactionMenuOpen} onClick={() => setReactionMenuOpen((value) => !value)}>React</button>
                {reactionMenuOpen && (
                  <div className="reaction-menu" role="group" aria-label="Choose a reaction">
                    {['Applause', 'Thank you', 'Well done'].map((reaction) => (
                      <button key={reaction} type="button" onClick={() => sendReaction(reaction)}>{reaction}</button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="toolbar-actions">
              <ControlButton label="People" state={panel === 'people' ? 'selected' : 'on'} onClick={() => togglePanel('people')} />
              <ControlButton label="Chat" state={panel === 'chat' ? 'selected' : 'on'} onClick={() => togglePanel('chat')} />
              <ControlButton label="Stats" state={panel === 'stats' ? 'selected' : 'on'} onClick={() => togglePanel('stats')} />
              <ControlButton label="Settings" state={panel === 'settings' ? 'selected' : 'on'} onClick={() => togglePanel('settings')} />
              <button className="leave-button" type="button" onClick={leaveCall}>Leave</button>
            </div>
          </footer>
        </div>
      )}
    </main>
  )
}

function ControlButton({
  label,
  state,
  onClick,
}: {
  label: string
  state: 'on' | 'off' | 'selected'
  onClick: () => void
}) {
  return (
    <button className={`control-button control-${state}`} type="button" onClick={onClick} aria-label={label} aria-pressed={state !== 'on'}>
      <span>{label}</span>
    </button>
  )
}

export default App
