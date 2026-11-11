export type DescriptionType = 'offer' | 'answer' | 'pranswer' | 'rollback' | null
export type SignalingState = RTCPeerConnectionState | RTCSignalingState

export interface OfferDecision {
  readyForOffer: boolean
  offerCollision: boolean
  ignoreOffer: boolean
}

export function decideOffer({
  makingOffer,
  signalingState,
  isSettingRemoteAnswerPending,
  isPolite,
  descriptionType,
}: {
  makingOffer: boolean
  signalingState: SignalingState
  isSettingRemoteAnswerPending: boolean
  isPolite: boolean
  descriptionType: DescriptionType
}): OfferDecision {
  const readyForOffer =
    !makingOffer &&
    (signalingState === 'stable' || isSettingRemoteAnswerPending)
  const offerCollision = descriptionType === 'offer' && !readyForOffer
  return {
    readyForOffer,
    offerCollision,
    ignoreOffer: !isPolite && offerCollision,
  }
}

export function isPolitePeer(localId: string, remoteId: string): boolean {
  return localId.localeCompare(remoteId) > 0
}
