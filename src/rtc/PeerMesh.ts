import { FileAssembler, isTransferPacket, sendFile } from './fileTransfer'
import { adaptSender, measureNetwork, type NetworkMetrics } from './quality'
import { decideOffer, isPolitePeer } from './negotiation'

export interface RemoteParticipant {
  id: string
  name: string
  stream?: MediaStream
  screenStream?: MediaStream
  connectionState: RTCPeerConnectionState
  metrics: NetworkMetrics
  muted: boolean
  cameraOff: boolean
  handRaised: boolean
  reaction: string
}

export interface MeshCallbacks {
  onParticipants: (participants: RemoteParticipant[]) => void
  onData: (data: Record<string, unknown>, peerId: string) => void
  onNotice: (message: string) => void
}

interface SignalMessage {
  type: 'hello' | 'signal' | 'leave'
  room: string
  from: string
  name?: string
  to?: string
  description?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
}

interface PeerState {
  participant: RemoteParticipant
  connection: RTCPeerConnection
  channel?: RTCDataChannel
  assembler: FileAssembler
  previousBytes: number
  restartTimer?: number
  lastRestart: number
  lastQualityUpdate: number
  makingOffer: boolean
  isSettingRemoteAnswerPending: boolean
  ignoreOffer: boolean
  pendingCandidates: RTCIceCandidateInit[]
  pendingMessages: string[]
  screenTransceiver?: RTCRtpTransceiver
  screenMids: Set<string>
  videoTracks: Map<string, MediaStreamTrack>
  reactionTimer?: number
}

const EMPTY_METRICS: NetworkMetrics = {
  bitrate: 0,
  packetLoss: 0,
  jitter: 0,
  rtt: 0,
  quality: 'good',
}

export class PeerMesh {
  private readonly room: string
  private readonly id: string
  private readonly name: string
  private readonly localStream: MediaStream
  private readonly callbacks: MeshCallbacks
  private readonly peers = new Map<string, PeerState>()
  private readonly rejectedPeers = new Set<string>()
  private readonly signaling: BroadcastChannel | null
  private readonly statsTimer: number
  private readonly retryHelloTimer: number
  private closed = false
  private simulation = { latency: 0, jitter: 0, loss: 0 }
  private qualityCap = Number.POSITIVE_INFINITY
  private currentScreenTrack: MediaStreamTrack | null = null
  private readonly onMessage = (event: MessageEvent<SignalMessage>) => {
    void this.receiveSignal(event.data).catch((error: unknown) => {
      this.callbacks.onNotice(
        error instanceof Error ? `Room signaling failed: ${error.message}` : 'Room signaling failed.',
      )
    })
  }
  private readonly onNetworkChange = () => {
    for (const peer of this.peers.values()) this.restart(peer)
  }

  constructor(
    room: string,
    id: string,
    name: string,
    localStream: MediaStream,
    callbacks: MeshCallbacks,
  ) {
    this.room = room
    this.id = id
    this.name = name
    this.localStream = localStream
    this.callbacks = callbacks
    this.signaling =
      typeof BroadcastChannel === 'undefined'
        ? null
        : new BroadcastChannel(`meet-room-${room}`)
    if (!this.signaling) {
      this.callbacks.onNotice('Room discovery requires BroadcastChannel support in this browser.')
    }
    if (this.signaling) this.signaling.onmessage = this.onMessage
    window.addEventListener('online', this.onNetworkChange)
    window.addEventListener('offline', this.onNetworkChange)
    this.announce('hello')
    this.retryHelloTimer = window.setInterval(() => this.announce('hello'), 2500)
    this.statsTimer = window.setInterval(() => void this.collectStats(), 2000)
  }

  send(data: Record<string, unknown>): void {
    for (const peer of this.peers.values()) {
      this.sendToPeer(peer, data)
    }
  }

  async setScreenTrack(track: MediaStreamTrack | null): Promise<void> {
    const peers = [...this.peers.values()].map((peer) => {
      const screenTransceiver = peer.screenTransceiver
      if (!screenTransceiver) {
        throw new Error('This browser does not support a separate screen-sharing video track.')
      }
      return { peer, screenTransceiver }
    })
    this.currentScreenTrack = track
    for (const { peer, screenTransceiver } of peers) {
      await screenTransceiver.sender.replaceTrack(track)
      const mid = screenTransceiver.mid
      if (mid) this.sendToPeer(peer, { kind: 'screen-state', mid, active: Boolean(track) })
    }
  }

  setSimulation(simulation: { latency: number; jitter: number; loss: number }): void {
    this.simulation = simulation
  }

  setAudioTrack(track: MediaStreamTrack): void {
    for (const peer of this.peers.values()) {
      const sender = peer.connection.getSenders().find((item) => item.track?.kind === 'audio')
      if (sender) {
        void sender.replaceTrack(track).catch((error: unknown) => {
          this.callbacks.onNotice(
            error instanceof Error ? `Microphone change failed: ${error.message}` : 'Microphone change failed.',
          )
        })
      }
    }
  }

  async sendFile(
    file: File,
    onProgress: (sent: number, total: number) => void,
  ): Promise<void> {
    const channels = [...this.peers.values()]
      .map((peer) => peer.channel)
      .filter((channel): channel is RTCDataChannel => channel?.readyState === 'open')
    if (!channels.length) throw new Error('No connected participants are ready to receive files')
    const transferId = crypto.randomUUID()
    const sentByChannel = new Map<RTCDataChannel, number>()
    await Promise.all(
      channels.map((channel) =>
        sendFile(channel, file, transferId, (progress) => {
          sentByChannel.set(channel, progress.sent)
          onProgress(
            [...sentByChannel.values()].reduce((total, sent) => total + sent, 0),
            file.size * channels.length,
          )
        }),
      ),
    )
  }

  setVideoTrack(track: MediaStreamTrack): void {
    for (const peer of this.peers.values()) {
      const sender = peer.connection.getSenders().find((item) => item.track?.kind === 'video')
      if (sender) {
        void sender.replaceTrack(track).catch((error: unknown) => {
          this.callbacks.onNotice(
            error instanceof Error ? `Camera change failed: ${error.message}` : 'Camera change failed.',
          )
        })
      }
    }
  }

  async setQualityCap(maxBitrate: number): Promise<void> {
    this.qualityCap = maxBitrate
    for (const peer of this.peers.values()) {
      const senders = peer.connection.getSenders().filter((item) => item.track?.kind === 'video')
      for (const sender of senders) {
        const params = sender.getParameters()
        const encodings = params.encodings
        if (!encodings?.length) continue
        params.encodings = encodings.map((encoding) => ({
          ...encoding,
          maxBitrate: Math.floor(maxBitrate / encodings.length),
        }))
        await sender.setParameters(params)
      }
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.announce('leave')
    window.clearInterval(this.retryHelloTimer)
    window.clearInterval(this.statsTimer)
    window.removeEventListener('online', this.onNetworkChange)
    window.removeEventListener('offline', this.onNetworkChange)
    this.signaling?.close()
    for (const peer of this.peers.values()) {
      if (peer.restartTimer) window.clearTimeout(peer.restartTimer)
      if (peer.reactionTimer) window.clearTimeout(peer.reactionTimer)
      peer.channel?.close()
      peer.connection.ontrack = null
      peer.connection.onicecandidate = null
      peer.connection.onnegotiationneeded = null
      peer.connection.onconnectionstatechange = null
      peer.connection.ondatachannel = null
      peer.connection.close()
    }
    this.peers.clear()
  }

  private announce(type: SignalMessage['type']): void {
    this.signaling?.postMessage({ type, room: this.room, from: this.id, name: this.name })
  }

  private signal(peerId: string, signal: Partial<SignalMessage>): void {
    this.signaling?.postMessage({
      type: 'signal',
      room: this.room,
      from: this.id,
      to: peerId,
      ...signal,
    })
  }

  private async receiveSignal(message: SignalMessage): Promise<void> {
    if (this.closed || !message || message.room !== this.room || message.from === this.id) return
    if (message.type === 'leave') {
      this.removePeer(message.from)
      return
    }
    if (message.type === 'hello') {
      this.ensurePeer(message.from, message.name ?? 'Participant')
      return
    }
    if (message.type !== 'signal' || message.to !== this.id) return

    const peer = this.ensurePeer(message.from, message.name ?? 'Participant')
    if (!peer) return
    try {
      if (message.description) {
        const description = message.description
        const decision = decideOffer({
          makingOffer: peer.makingOffer,
          signalingState: peer.connection.signalingState,
          isSettingRemoteAnswerPending: peer.isSettingRemoteAnswerPending,
          isPolite: isPolitePeer(this.id, peer.participant.id),
          descriptionType: description.type,
        })
        peer.ignoreOffer = decision.ignoreOffer
        if (decision.ignoreOffer) {
          peer.pendingCandidates = []
          return
        }
        if (decision.offerCollision) {
          await peer.connection.setLocalDescription({ type: 'rollback' })
        }
        peer.isSettingRemoteAnswerPending = description.type === 'answer'
        try {
          await peer.connection.setRemoteDescription(description)
        } finally {
          peer.isSettingRemoteAnswerPending = false
        }
        for (const candidate of peer.pendingCandidates.splice(0)) {
          await peer.connection.addIceCandidate(candidate)
        }
        if (description.type === 'offer') {
          await peer.connection.setLocalDescription()
          this.signal(message.from, {
            name: this.name,
            description: peer.connection.localDescription?.toJSON(),
          })
        }
      } else if (message.candidate) {
        if (peer.ignoreOffer) return
        if (peer.connection.remoteDescription) {
          await peer.connection.addIceCandidate(message.candidate)
        } else {
          peer.pendingCandidates.push(message.candidate)
        }
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'InvalidStateError')) {
        this.callbacks.onNotice(
          `Connection negotiation with ${peer.participant.name} encountered an error.`,
        )
      }
    }
  }

  private ensurePeer(id: string, name: string): PeerState | undefined {
    const current = this.peers.get(id)
    if (current) {
      current.participant.name = name
      return current
    }
    if (this.peers.size >= 5) {
      if (!this.rejectedPeers.has(id)) {
        this.rejectedPeers.add(id)
        this.callbacks.onNotice('This room supports up to six participants.')
      }
      return undefined
    }

    const connection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    })
    const state: PeerState = {
      participant: {
        id,
        name,
        connectionState: 'new',
        metrics: { ...EMPTY_METRICS },
        muted: false,
        cameraOff: false,
        handRaised: false,
        reaction: '',
      },
      connection,
      assembler: new FileAssembler(),
      previousBytes: 0,
      lastRestart: 0,
      lastQualityUpdate: 0,
      makingOffer: false,
      isSettingRemoteAnswerPending: false,
      ignoreOffer: false,
      pendingCandidates: [],
      pendingMessages: [],
      screenMids: new Set(),
      videoTracks: new Map(),
    }
    this.peers.set(id, state)
    this.callbacks.onNotice(`${name} joined the room.`)

    connection.ontrack = (event) => {
      if (event.track.kind === 'audio') {
        const stream = state.participant.stream ?? new MediaStream()
        if (!stream.getTracks().includes(event.track)) stream.addTrack(event.track)
        state.participant.stream = stream
      } else if (event.transceiver.mid) {
        state.videoTracks.set(event.transceiver.mid, event.track)
        this.updateRemoteVideoStreams(state)
      }
      this.publishParticipants()
    }
    connection.onicecandidate = (event) => {
      if (event.candidate) this.signal(id, { candidate: event.candidate.toJSON() })
    }
    connection.onnegotiationneeded = () => void this.negotiate(state)
    connection.onconnectionstatechange = () => {
      if (this.closed) return
      state.participant.connectionState = connection.connectionState
      if (connection.connectionState === 'disconnected' || connection.connectionState === 'failed') {
        this.restart(state)
      }
      this.publishParticipants()
    }
    connection.ondatachannel = (event) => this.attachDataChannel(state, event.channel)
    for (const track of this.localStream.getTracks()) {
      if (track.kind === 'video') {
        try {
          connection.addTransceiver(track, {
            direction: 'sendrecv',
            streams: [this.localStream],
            sendEncodings: [
              { rid: 'low', scaleResolutionDownBy: 2 },
              { rid: 'high', scaleResolutionDownBy: 1 },
            ],
          })
        } catch {
          connection.addTrack(track, this.localStream)
        }
      } else {
        connection.addTrack(track, this.localStream)
      }
    }
    try {
      state.screenTransceiver = connection.addTransceiver('video', {
        direction: 'sendonly',
        streams: [this.localStream],
      })
      if (this.currentScreenTrack) {
        void state.screenTransceiver.sender.replaceTrack(this.currentScreenTrack)
      }
    } catch {
      this.callbacks.onNotice('Separate camera and screen tracks are not available in this browser.')
    }
    if (isPolitePeer(this.id, id)) {
      this.attachDataChannel(state, connection.createDataChannel('room-data', { ordered: true }))
    }
    this.publishParticipants()
    return state
  }

  private async negotiate(peer: PeerState): Promise<void> {
    if (this.closed || peer.connection.signalingState !== 'stable') return
    try {
      peer.makingOffer = true
      try {
        await peer.connection.setLocalDescription()
        if (peer.connection.localDescription) {
          this.signal(peer.participant.id, {
            name: this.name,
            description: peer.connection.localDescription.toJSON(),
          })
        }
      } finally {
        peer.makingOffer = false
      }
    } catch {
      this.callbacks.onNotice(`Could not establish a connection with ${peer.participant.name}.`)
    }
  }

  private attachDataChannel(peer: PeerState, channel: RTCDataChannel): void {
    peer.channel = channel
    channel.onmessage = (event: MessageEvent<string>) => {
      try {
        const parsed: unknown = JSON.parse(event.data)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('The data message is not an object.')
        }
        const data = parsed as Record<string, unknown>
        if (typeof data.kind === 'string' && data.kind.startsWith('file-')) {
          if (!isTransferPacket(data)) throw new Error('The file transfer packet is invalid.')
          const result = peer.assembler.accept(data)
          if (result) {
            this.callbacks.onData(
              { kind: 'file-received', name: result.name, blob: result.blob },
              peer.participant.id,
            )
          }
          return
        }
        if (data.kind === 'participant-state') {
          peer.participant.muted = Boolean(data.muted ?? peer.participant.muted)
          peer.participant.cameraOff = Boolean(data.cameraOff ?? peer.participant.cameraOff)
          peer.participant.handRaised = Boolean(data.handRaised ?? peer.participant.handRaised)
          this.publishParticipants()
        } else if (
          data.kind === 'screen-state' &&
          typeof data.mid === 'string' &&
          typeof data.active === 'boolean'
        ) {
          if (data.active) peer.screenMids.add(data.mid)
          else {
            peer.screenMids.delete(data.mid)
            peer.videoTracks.delete(data.mid)
          }
          this.updateRemoteVideoStreams(peer)
          this.publishParticipants()
        } else if (data.kind === 'reaction' && typeof data.text === 'string') {
          peer.participant.reaction = data.text
          if (peer.reactionTimer) window.clearTimeout(peer.reactionTimer)
          peer.reactionTimer = window.setTimeout(() => {
            peer.participant.reaction = ''
            this.publishParticipants()
          }, 2600)
          this.publishParticipants()
        }
        this.callbacks.onData(data, peer.participant.id)
      } catch {
        this.callbacks.onNotice(`A data message from ${peer.participant.name} could not be read.`)
      }
    }
    channel.onopen = () => {
      for (const message of peer.pendingMessages.splice(0)) {
        if (channel.readyState !== 'open') break
        try {
          channel.send(message)
        } catch (error) {
          this.callbacks.onNotice(
            error instanceof Error ? `Message delivery failed: ${error.message}` : 'Message delivery failed.',
          )
          break
        }
      }
      if (this.currentScreenTrack && peer.screenTransceiver?.mid) {
        channel.send(JSON.stringify({
          kind: 'screen-state',
          mid: peer.screenTransceiver.mid,
          active: true,
        }))
      }
      this.publishParticipants()
    }
    channel.onclose = () => this.publishParticipants()
  }

  private async collectStats(): Promise<void> {
    const now = performance.now()
    for (const peer of this.peers.values()) {
      try {
        if (peer.connection.connectionState === 'disconnected' || peer.connection.connectionState === 'failed') {
          this.restart(peer)
        }
        const report = await peer.connection.getStats()
        const metrics = measureNetwork(report, peer.previousBytes, 2000)
        let videoBytes = 0
        report.forEach((stat) => {
          if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
            videoBytes += Number(stat.bytesReceived ?? 0)
          }
        })
        peer.previousBytes = videoBytes
        peer.participant.metrics = metrics
        const senders = peer.connection.getSenders().filter((item) => item.track?.kind === 'video')
        if (senders.length && now - peer.lastQualityUpdate > 1500) {
          peer.lastQualityUpdate = now
          await Promise.all(senders.map((sender) =>
            adaptSender(sender, metrics.quality, this.qualityCap),
          ))
        }
      } catch {
        this.callbacks.onNotice(`Network statistics for ${peer.participant.name} are unavailable.`)
      }
    }
    this.publishParticipants()
  }

  private restart(peer: PeerState): void {
    if (this.closed || peer.restartTimer || performance.now() - peer.lastRestart < 4000) return
    peer.restartTimer = window.setTimeout(() => {
      peer.restartTimer = undefined
      if (this.closed || peer.connection.connectionState === 'closed') return
      peer.lastRestart = performance.now()
      try {
        peer.connection.restartIce()
      } catch {
        this.callbacks.onNotice(`Could not restart the connection with ${peer.participant.name}.`)
      }
    }, 500)
  }

  private sendToPeer(peer: PeerState, data: Record<string, unknown>): void {
    if (Math.random() * 100 < this.simulation.loss) return
    const message = JSON.stringify(data)
    const delay = Math.max(
      0,
      this.simulation.latency + (Math.random() * 2 - 1) * this.simulation.jitter,
    )
    window.setTimeout(() => {
      if (this.closed) return
      if (peer.channel?.readyState === 'open') {
        try {
          peer.channel.send(message)
        } catch (error) {
          this.callbacks.onNotice(
            error instanceof Error ? `Message delivery failed: ${error.message}` : 'Message delivery failed.',
          )
        }
      } else {
        peer.pendingMessages.push(message)
      }
    }, delay)
  }

  private updateRemoteVideoStreams(peer: PeerState): void {
    const cameraTracks = [...peer.videoTracks.entries()]
      .filter(([mid]) => !peer.screenMids.has(mid))
      .map(([, track]) => track)
    const screenTracks = [...peer.videoTracks.entries()]
      .filter(([mid]) => peer.screenMids.has(mid))
      .map(([, track]) => track)
    const cameraStream = peer.participant.stream ?? new MediaStream()
    cameraStream.getVideoTracks().forEach((track) => cameraStream.removeTrack(track))
    cameraTracks.forEach((track) => cameraStream.addTrack(track))
    peer.participant.stream = cameraStream
    if (screenTracks.length) {
      const screenStream = peer.participant.screenStream ?? new MediaStream()
      screenStream.getVideoTracks().forEach((track) => screenStream.removeTrack(track))
      screenTracks.forEach((track) => screenStream.addTrack(track))
      peer.participant.screenStream = screenStream
    } else {
      peer.participant.screenStream = undefined
    }
  }

  private removePeer(id: string): void {
    const peer = this.peers.get(id)
    if (!peer) return
    if (peer.restartTimer) window.clearTimeout(peer.restartTimer)
    if (peer.reactionTimer) window.clearTimeout(peer.reactionTimer)
    peer.channel?.close()
    peer.connection.ontrack = null
    peer.connection.onicecandidate = null
    peer.connection.onnegotiationneeded = null
    peer.connection.onconnectionstatechange = null
    peer.connection.ondatachannel = null
    peer.connection.close()
    this.peers.delete(id)
    this.rejectedPeers.delete(id)
    this.callbacks.onNotice(`${peer.participant.name} left the room.`)
    this.publishParticipants()
  }

  private publishParticipants(): void {
    this.callbacks.onParticipants([...this.peers.values()].map((peer) => peer.participant))
  }
}
