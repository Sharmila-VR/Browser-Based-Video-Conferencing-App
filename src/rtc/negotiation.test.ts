import { describe, expect, it } from 'vitest'
import { decideOffer, isPolitePeer } from './negotiation'

describe('perfect negotiation decisions', () => {
  it('accepts an offer when the connection is stable', () => {
    expect(decideOffer({
      makingOffer: false,
      signalingState: 'stable',
      isSettingRemoteAnswerPending: false,
      isPolite: false,
      descriptionType: 'offer',
    })).toEqual({ readyForOffer: true, offerCollision: false, ignoreOffer: false })
  })

  it('ignores a colliding offer from an impolite peer', () => {
    expect(decideOffer({
      makingOffer: true,
      signalingState: 'have-local-offer',
      isSettingRemoteAnswerPending: false,
      isPolite: false,
      descriptionType: 'offer',
    })).toEqual({ readyForOffer: false, offerCollision: true, ignoreOffer: true })
  })

  it('rolls back a colliding offer from the polite peer', () => {
    expect(decideOffer({
      makingOffer: false,
      signalingState: 'have-local-offer',
      isSettingRemoteAnswerPending: false,
      isPolite: true,
      descriptionType: 'offer',
    })).toEqual({ readyForOffer: false, offerCollision: true, ignoreOffer: false })
  })

  it('accepts an offer while a remote answer is being set', () => {
    expect(decideOffer({
      makingOffer: false,
      signalingState: 'have-local-offer',
      isSettingRemoteAnswerPending: true,
      isPolite: false,
      descriptionType: 'offer',
    })).toEqual({ readyForOffer: true, offerCollision: false, ignoreOffer: false })
  })

  it('does not classify answers as offer collisions', () => {
    expect(decideOffer({
      makingOffer: true,
      signalingState: 'have-local-offer',
      isSettingRemoteAnswerPending: false,
      isPolite: false,
      descriptionType: 'answer',
    })).toEqual({ readyForOffer: false, offerCollision: false, ignoreOffer: false })
  })

  it('chooses a single polite side deterministically', () => {
    expect(isPolitePeer('peer-b', 'peer-a')).toBe(true)
    expect(isPolitePeer('peer-a', 'peer-b')).toBe(false)
    expect(isPolitePeer('peer-a', 'peer-a')).toBe(false)
  })
})
