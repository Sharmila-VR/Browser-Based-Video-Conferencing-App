# Gather

Gather is a lightweight, browser-based video room built with React and native browser APIs. It uses no hosted call SDK, WebRTC wrapper, or signaling package.

## Run locally

```powershell
npm install
npm run dev
```

Open the displayed localhost URL in two browser tabs, use the same room code in both, and allow camera and microphone access. Room discovery is limited to tabs on the same origin and browser profile.

```powershell
npm run build
npm test
npm run test:coverage
```

The negotiation, quality adaptation, and file-transfer modules are covered by unit tests. The current coverage run reports 100% statements, branches, functions, and lines across those modules.

## Negotiation design

`src/rtc/PeerMesh.ts` owns one native `RTCPeerConnection` per remote participant. A `BroadcastChannel` announces room presence and carries offer, answer, and ICE messages. ICE candidates are sent as they are gathered. Candidates that arrive before the remote description are held and applied after that description is installed.

Perfect negotiation is implemented per connection. Participant IDs establish a deterministic polite and impolite side. The polite peer rolls back its local offer when offers collide; the impolite peer ignores the colliding offer and its candidates. Device changes and mute controls replace or disable tracks without rebuilding the connection. Network change events and disconnected or failed states trigger ICE restarts on the existing connection.

The room supports up to six participants in a full mesh. Each connection uses a Google STUN server for candidate discovery. There is no TURN relay or hosted signaling service.

## Quality adaptation

The app samples `getStats()` for inbound video bytes, packet loss, jitter, and round-trip time. Each peer gets an independent quality estimate and video sender profile. The profile adjusts maximum bitrate, frame rate, and resolution scaling through `RTCRtpSender.setParameters()`.

Video senders request two simulcast encodings where supported: a lower-resolution layer and a full-resolution layer. The selected profile's bitrate is divided across available encodings. Browsers that reject the simulcast configuration fall back to a normal video sender.

The quality indicator and stats panel show browser-reported measurements. The network controls can cap outgoing video bitrate, and can delay, jitter, or drop application data-channel messages. Browser APIs do not expose a way for a page to inject real packet loss or physical network latency into WebRTC; those controls are not a substitute for OS-level network shaping.

## Audio and devices

Camera and microphone access is requested when the user joins or enables their devices. Camera selection, microphone selection, device-change refresh, mute, camera-off, and screen capture use `MediaDevices` and `MediaStreamTrack` directly.

The local audio path uses a Web Audio analyser, a threshold noise gate, and a dynamics compressor. The microphone level meter is sampled independently of the React render loop. The browser's echo-cancellation constraint is enabled when available. The optional loopback test plays the processed microphone signal through the selected output route.

## Background effect

The optional background softening effect runs in a Web Worker with `OffscreenCanvas`. Its custom segmentation method stores the first frame as a static background reference and compares later pixels against that reference. Pixels that change enough are treated as foreground; the remaining image is blurred.

This is a deliberately small, dependency-free approximation, not a person-segmentation model. It works best with a stationary background, consistent lighting, and a moving subject. It can leave halos, blur stationary foreground objects, or miss parts of a subject. Worker processing avoids putting the pixel loop on the UI thread, but browser, device, and camera performance vary; a sustained 30 fps at 720p is not guaranteed.

## Chat, reactions, and files

Each peer connection has an ordered, reliable `RTCDataChannel`. Chat, participant state, hand raises, and text reactions travel directly over that channel.

Files are read and sent in 16 KiB chunks. The sender pauses when the channel buffer exceeds its threshold and reports aggregate progress. The receiver checks chunk ordering and the final byte count before offering a download. The interface limits a transfer to 25 MB.

## Recording

Recording composites the visible video tiles at 720p and 15 fps, mixes local and remote audio through Web Audio, and records WebM with `MediaRecorder`. It writes each recording segment directly to a user-selected file using the File System Access API. Recording is unavailable in browsers without that API; the app does not fall back to retaining the entire recording in memory. Slow disk writes pause capture until the write queue drains.

## Accessibility

Controls are native keyboard-focusable buttons with labels and pressed states. The room includes shortcuts for microphone, camera, hand raise, and leaving; live announcements cover participant changes, mute state, and detected speakers. Live captions use the browser's Web Speech API when available and require the user to enable them. A high-contrast mode and reduced-motion styles are included.

## Browser-only limits

- `BroadcastChannel` only connects tabs in the same browser profile and origin. It cannot provide room rendezvous between different devices, browsers, or networks. Cross-device rooms require a signaling service.
- STUN-only connectivity cannot traverse every NAT or firewall. There is no TURN relay, so a connection is not guaranteed on restrictive networks.
- Reconnection is attempted with ICE restarts, but a recovery time under five seconds cannot be guaranteed across real network changes.
- Web Speech recognition, screen capture, background effects, and streamed recording depend on browser support and secure-context rules.
- The production build and unit-test coverage are verified locally. The six-participant Chrome Performance-panel threshold, real hardware camera release in `chrome://webrtc-internals`, and recovery after a controlled ten-second network outage require device and browser validation and are not claimed as verified here.
