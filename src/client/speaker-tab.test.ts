import { describe, expect, it } from 'vitest'
import { createSpeakerElection, type SpeakerElection } from './speaker-tab.ts'

/** In-memory stand-in for a pair of tabs of one browser sharing a
 *  BroadcastChannel: a bus that mirrors each message to the other end. */
function makePair(aId: string, bId: string, now: () => number) {
  type Chan = {
    onmessage: ((e: { data: unknown }) => void) | null
    postMessage: (msg: unknown) => void
    close: () => void
    closed: boolean
  }
  const chans: Chan[] = []
  const open = (): Chan => {
    const chan: Chan = { onmessage: null, postMessage: () => {}, close: () => { chan.closed = true }, closed: false }
    chans.push(chan)
    return chan
  }
  const a = open()
  const b = open()
  const wire = (src: Chan, dst: Chan) => {
    src.postMessage = (msg: unknown) => {
      if (dst.onmessage) dst.onmessage({ data: msg })
    }
  }
  wire(a, b)
  wire(b, a)
  const mk = (id: string) =>
    createSpeakerElection({ id, channel: id === aId ? a : b, now, timers: false })
  return { a: mk(aId), b: mk(bId), chans }
}

describe('speaker election (one speaker per browser)', () => {
  it('a lone tab with a channel is silent until settled, then speaks', () => {
    let t = 0
    const { a } = makePair('aaa', 'bbb', () => t)
    expect(a.isSpeaker()).toBe(false) // young, has heard nobody
    t = 2500 // settle elapsed, nobody ever heard
    expect(a.isSpeaker()).toBe(true)
  })

  it('with no channel at all the tab is always the speaker', () => {
    const e = createSpeakerElection({ id: 'aaa', channel: null, now: () => 0, timers: false })
    expect(e.isSpeaker()).toBe(true)
  })

  it('elects the lowest live id when two tabs meet', () => {
    let t = 0
    const { a, b } = makePair('aaa', 'bbb', () => t)
    expect(a.isSpeaker()).toBe(false)
    expect(b.isSpeaker()).toBe(false)
    a.beat() // a announces; b hears a peer -> settled
    t = 2000
    b.beat() // b announces; a hears b
    expect(a.isSpeaker()).toBe(true) // 'aaa' < 'bbb'
    expect(b.isSpeaker()).toBe(false)
  })

  it('elects the lowest id regardless of which tab was created first', () => {
    let t = 0
    const { a, b } = makePair('bbb', 'aaa', () => t) // b holds the lower id 'aaa'
    a.beat()
    b.beat()
    expect(a.isSpeaker()).toBe(false)
    expect(b.isSpeaker()).toBe(true)
  })

  it('re-elects when the speaker tab goes away', () => {
    let t = 0
    const { a, b, chans } = makePair('aaa', 'bbb', () => t)
    a.beat()
    b.beat()
    expect(a.isSpeaker()).toBe(true)
    a.close() // the speaker tab dies; it will beat no more
    t = 6001 // its last beat (t=0/2000) is now over 6 s old
    b.beat()
    expect(b.isSpeaker()).toBe(true) // nobody left but b
  })

  it('ignores its own heartbeat and stale peers drop out', () => {
    let t = 0
    const { a, b } = makePair('aaa', 'bbb', () => t)
    a.beat()
    b.beat()
    expect(a.isSpeaker()).toBe(true)
    t = 5000 // b still fresh (beats at 2000), a still fresh
    expect(a.isSpeaker()).toBe(true)
    t = 9000 // both heartbeats (0 and 2000) are now > 6 s old
    expect(a.isSpeaker()).toBe(true) // no live peers: back to lone tab
    expect(b.isSpeaker()).toBe(true)
  })
})
