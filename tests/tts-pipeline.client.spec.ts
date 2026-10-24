// @vitest-environment jsdom
/**
 * The sentence pipeline: plan -> one render per sentence -> back-to-back
 * scheduling on a (fake) AudioContext, with stopPlayback() aborting the
 * in-flight render.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const holder = vi.hoisted(() => ({ ctx: null as Record<string, unknown> | null }))

vi.mock('../src/client/audio-unlock.ts', () => ({
  getSharedAudioContext: () => holder.ctx,
  unlockPageAudio: () => { /* the tests need no gesture unlock */ },
}))

import { isPlaying, loadRenderSpeed, noteRenderSample, setTtsRemote, speak, stopPlayback } from '../src/client/tts.ts'

const B64 = Buffer.from('RIFFfake').toString('base64')

interface Started { at?: number; dur: number }

function makeCtx(duration = 2): Record<string, unknown> & { started: Started[] } {
  const started: Started[] = []
  return {
    state: 'running',
    currentTime: 0,
    destination: {},
    resume: async () => { /* already running */ },
    decodeAudioData: async () => ({ duration }),
    createBufferSource: () => ({
      buffer: null,
      connect: () => { /* fake destination */ },
      start: (at?: number) => { started.push({ at, dur: duration }) },
      stop: () => { /* recorded below if needed */ },
    }),
    started,
  }
}

interface RenderCall { text: string; signal?: unknown }

function fakeRemote(sentences: string[], renderDelay = 0) {
  const renders: RenderCall[] = []
  return {
    renders,
    remote: {
      status: async () => ({ server: 'up', engine: 'pocket' }),
      plan: async () => ({ stale: false, sentences }),
      render: (request: { text: string }, signal?: unknown) =>
        new Promise<unknown>((resolve, reject) => {
          renders.push({ text: request.text, signal })
          // With a render delay the FIRST sentence settles (after the delay)
          // and every later one hangs until the caller aborts it — that is
          // the "render in flight while the voice is speaking" state.
          if (renderDelay > 0 && renders.length > 1) {
            signal?.addEventListener?.('abort', () => reject(new Error('aborted')))
            return
          }
          setTimeout(() => resolve({ audioBase64: B64, engine: 'pocket' }), renderDelay)
        }),
      synthesize: undefined,
      setEngine: async () => ({ ok: true }),
    },
  }
}

beforeEach(() => {
  stopPlayback()
  localStorage.clear()
})

describe('sentence pipeline', () => {
  it('plans once, renders sentence by sentence, and schedules them back-to-back', async () => {
    const ctx = makeCtx()
    holder.ctx = ctx
    const plans: unknown[] = []
    const fake = fakeRemote(['One one.', 'Two two.', 'Three three.'])
    const planSpy = async (request: unknown): Promise<unknown> => {
      plans.push(request)
      return { stale: false, sentences: ['One one.', 'Two two.', 'Three three.'] }
    }
    setTtsRemote({ tts: { ...fake.remote, plan: planSpy } } as never)

    const outcome = await speak('s1', 'm1')
    expect(outcome).toEqual({ audio: true })
    expect(isPlaying()).toBe(true)

    // All three sentences render (in order) even though speak() already
    // settled after the first was scheduled.
    await vi.waitFor(() => {
      expect(ctx.started.length).toBe(3)
    }, { timeout: 3000, interval: 10 })

    expect(plans).toEqual([{ sessionId: 's1', messageId: 'm1', auto: false, scope: 'final' }])
    expect(fake.renders.map((r) => r.text)).toEqual(['One one.', 'Two two.', 'Three three.'])
    // Back-to-back: 0.08 start, then +2 s (the fake duration) each.
    expect(ctx.started[0]?.at).toBeCloseTo(0.08, 5)
    expect(ctx.started[1]?.at).toBeCloseTo(2.08, 5)
    expect(ctx.started[2]?.at).toBeCloseTo(4.08, 5)
    stopPlayback()
    expect(isPlaying()).toBe(false)
  })

  it('stopPlayback aborts the render that is in flight', async () => {
    const ctx = makeCtx()
    holder.ctx = ctx
    const fake = fakeRemote(['First.', 'Second.', 'Third.'], 30) // later renders hang
    setTtsRemote({ tts: fake.remote } as never)

    const outcome = await speak('s2', 'm2')
    expect(outcome).toEqual({ audio: true })
    expect(isPlaying()).toBe(true)

    stopPlayback()

    expect(isPlaying()).toBe(false)
    // The second sentence was requested but never settled: it was aborted
    // in flight, and the third was never requested.
    expect(fake.renders.map((r) => r.text)).toEqual(['First.', 'Second.'])
    expect(fake.renders[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(fake.renders[1]?.signal?.aborted).toBe(true)
    expect(ctx.started).toHaveLength(1)
  })

  it('falls back to the whole-message render when the host has no plan', async () => {
    const ctx = makeCtx()
    holder.ctx = ctx
    const synthesized: unknown[] = []
    setTtsRemote({
      tts: {
        status: async () => ({ server: 'up', engine: 'pocket' }),
        synthesize: async (request: unknown) => {
          synthesized.push(request)
          return { audioBase64: B64, elapsedMs: 1 }
        },
        setEngine: async () => ({ ok: true }),
      },
    } as never)

    const outcome = await speak('s3', 'm3', { auto: false })
    expect(outcome).toEqual({ audio: true })
    expect(synthesized).toEqual([{ sessionId: 's3', messageId: 'm3', auto: false, scope: 'final' }])
    await vi.waitFor(() => {
      expect((ctx as { started?: Started[] }).started?.length).toBe(1)
    }, { timeout: 3000, interval: 10 })
    stopPlayback()
  })

  it('surfaces a stale plan without rendering anything', async () => {
    const ctx = makeCtx()
    holder.ctx = ctx
    const fake = fakeRemote(['Never spoken.'])
    setTtsRemote({
      tts: {
        ...fake.remote,
        plan: async () => ({ stale: true, ageSeconds: 99 }),
      },
    } as never)

    const outcome = await speak('s4', 'm4', { auto: true })
    expect(outcome).toEqual({ stale: true })
    expect(fake.renders).toHaveLength(0)
    expect(isPlaying()).toBe(false)
  })

  it('passes the read scope through to plan', async () => {
    const ctx = makeCtx()
    holder.ctx = ctx
    const plans: unknown[] = []
    const fake = fakeRemote(['One.'])
    const planSpy = async (request: unknown): Promise<unknown> => {
      plans.push(request)
      return { stale: false, sentences: ['One.'] }
    }
    setTtsRemote({ tts: { ...fake.remote, plan: planSpy } } as never)

    await speak('s7', 'm7', { auto: true, scope: 'steps' })
    // An auto-read carries the device's freshness window (the default 2
    // minutes here); the host declines replies older than it.
    expect(plans).toEqual([{ sessionId: 's7', messageId: 'm7', auto: true, scope: 'steps', maxAgeMs: 120_000 }])
    stopPlayback()
  })

  it('folds a gapping follow-on into one render block', async () => {
    const ctx = makeCtx()
    holder.ctx = ctx
    const fake = fakeRemote(['A.', 'A considerably longer sentence follows.'])
    setTtsRemote({ tts: fake.remote } as never)

    const outcome = await speak('s5', 'm5')
    expect(outcome).toEqual({ audio: true })
    await vi.waitFor(() => {
      expect(ctx.started.length).toBe(1)
    }, { timeout: 3000, interval: 10 })
    // One clip, not two: the follow-on would still have been rendering
    // while 'A.' had already finished, so the two render as one clip.
    expect(fake.renders).toHaveLength(1)
    expect(fake.renders[0]?.text).toBe('A. A considerably longer sentence follows.')
    stopPlayback()
  })
})

describe('serial audio queue', () => {
  /** Plan by message id: m1 is two sentences, m2 is two different ones. */
  function queueRemote() {
    const renders: string[] = []
    return {
      renders,
      tts: {
        status: async () => ({ server: 'up', engine: 'pocket' }),
        plan: async (request: { messageId: string }) => ({
          stale: false,
          sentences: request.messageId === 'm1' ? ['First.', 'Second.'] : ['Third.', 'Fourth.'],
        }),
        render: (request: { text: string }, signal?: unknown) =>
          new Promise<unknown>((resolve, reject) => {
            renders.push(request.text)
            signal?.addEventListener?.('abort', () => reject(new Error('aborted')))
            setTimeout(() => resolve({ audioBase64: B64, engine: 'pocket' }), 0)
          }),
        synthesize: undefined,
        setEngine: async () => ({ ok: true }),
      },
    }
  }

  it('lines an auto-read up behind playing audio instead of cutting in', async () => {
    const ctx = makeCtx(0.5)
    holder.ctx = ctx
    const fake = queueRemote()
    setTtsRemote({ tts: fake.tts } as never)

    const [first, second] = await Promise.all([
      speak('s1', 'm1', { auto: true }), // triggered first: speaks first
      speak('s1', 'm2', { auto: true }), // triggered second: must wait its turn
    ])
    expect(first).toEqual({ audio: true })

    // Strictly serial: the second read's sentences are not even rendered
    // until the first read has gone silent — no interleaving, no cut-in.
    await vi.waitFor(() => {
      expect(ctx.started).toHaveLength(4)
    }, { timeout: 6000, interval: 10 })
    expect(fake.renders).toEqual(['First.', 'Second.', 'Third.', 'Fourth.'])
    expect(second).toEqual({ audio: true })
    stopPlayback()
  })

  it('gives up a queued auto-read when a stop happens while it waits', async () => {
    const ctx = makeCtx(0.5)
    holder.ctx = ctx
    const fake = queueRemote()
    setTtsRemote({ tts: fake.tts } as never)

    await speak('s1', 'm1') // the manual read is playing
    expect(isPlaying()).toBe(true)
    const second = speak('s1', 'm2', { auto: true }) // lines up behind m1
    stopPlayback() // silence while m2 is still waiting

    const outcome = await second
    expect(outcome).toEqual({})
    expect(isPlaying()).toBe(false)
    // m2 gave up: none of its sentences were ever rendered.
    expect(fake.renders).toEqual(['First.', 'Second.'])
    stopPlayback()
  })
})

describe('render-speed calibration', () => {
  it('assumes 2.5 until the first measured render lands', () => {
    expect(loadRenderSpeed()).toBe(2.5)
  })

  it('stores the first clean sample outright, then blends toward later ones', () => {
    noteRenderSample(2, 0.8) // sample 2.5, first-ever: stored outright
    expect(loadRenderSpeed()).toBe(2.5)
    noteRenderSample(2, 0.5) // sample 4.0: blended 60/40 -> 3.1
    expect(loadRenderSpeed()).toBeCloseTo(3.1, 5)
  })

  it('ignores cold-start and cache-hit renders', () => {
    noteRenderSample(2, 40) // sample 0.05: model load, not a render
    noteRenderSample(2, 0)  // cache hit: no render time at all
    expect(loadRenderSpeed()).toBe(2.5)
  })
})
