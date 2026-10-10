// @vitest-environment jsdom
/**
 * Two-way conversation simulation for the unified voice button.
 *
 * Drives a real <VoiceInput/> through a scripted speak -> reply -> speak
 * conversation the way a phone does (tap, talk, pause, reply, auto-reopen,
 * talk again), and records a state trace of every change the user can see:
 * the primary action button (dictate mic, waveform, send arrow, stop square,
 * cross, transcribing dot) and the mute button.
 *
 * The trace is written to tests/sim-trace-<test>.jsonl (one entry per
 * visible change) so a flicker can be inspected line by line.
 *
 * Invariants (the "no flicker" contract):
 *  - I2: a focus loss (window blur / screen off) mid-recording must not
 *    kill the turn: the mute + cross stay put and the turn resumes.
 *  - I3: when the system starts speaking during an auto-opened
 *    microphone, there is exactly one designed handover per reply
 *    (recording -> speaking-stop-square -> recording), never a bare idle.
 *  - I4: the mute joins the row only during a voice conversation — it takes
 *    the dictate button's place and never appears with the dictate — and the
 *    default row (dictate + voice) returns when the conversation ends.
 */
import { writeFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Transcript } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { VoiceInput, type VoiceInputProps } from '../src/client/VoiceInput.tsx'
import { setMetricsSink } from '../src/client/metrics.ts'
import { Recording } from '../src/client/audio.ts'

/**
 * The published ui-primitives (0.0.1-rc.1) predates the "Regular" icon
 * generation this source tree uses; stub the two icons the buttons render so
 * the test stays machine-independent. Everything else comes from the package.
 */
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const icon = (name: string) => {
    const C = (props: Record<string, unknown>) => <svg data-icon={name} {...props} />
    C.displayName = name
    return C
  }
  return {
    ...actual,
    IconCloseOutlineRegular: icon('IconCloseOutlineRegular'),
    IconMicrophoneOutlineRegular: icon('IconMicrophoneOutlineRegular'),
  }
})

/* ------------------------------------------------------------------ trace */

type Label = string | 'none'

/** Read exactly what the user sees: the primary action button and the mute slot. */
function probe(container: HTMLElement): { unified: Label; mute: Label; all: Label[]; live: boolean } {
  const labels: Label[] = []
  for (const button of Array.from(container.querySelectorAll<HTMLButtonElement>('button'))) {
    const name = button.getAttribute('aria-label') ?? 'unnamed'
    if (!labels.includes(name)) labels.push(name)
  }
  const unifiedEl = container.querySelector<HTMLButtonElement>('[data-voice-unified="1"]')
    ?? container.querySelector<HTMLButtonElement>('button[aria-label="voiceChat.stop"], button[aria-label="transcribingShort"], button[aria-label="cancel"]')
  return {
    unified: unifiedEl?.getAttribute('aria-label') ?? 'none',
    mute: labels.includes('muteMic') ? 'muteMic' : labels.includes('unmuteMic') ? 'unmuteMic' : 'none',
    all: labels,
    // The live microphone (the data-voice-live phase row), whatever the
    // button shows: while a turn is in flight it is the stop square, which
    // is visually identical to the pending-turn square.
    live: container.querySelector('[data-voice-live="1"]') !== null,
  }
}

interface TraceEntry { at: number; event: string; primary: Label; mute: Label; all: Label[]; live: boolean }
const t0 = Date.now()
const trace: TraceEntry[] = []
let currentTest = ''

function note(container: HTMLElement, event: string): void {
  const view = probe(container)
  trace.push({ at: Date.now() - t0, event, primary: view.unified, mute: view.mute, all: view.all, live: view.live })
}

/** Record a transition whenever the visible primary/mute pair changes. */
let lastKey = ''

/** Metric lines shipped by the plugin this test (one per completed voice turn). */
const metricLines: Record<string, unknown>[] = []

function watch(container: HTMLElement, label: string): void {
  const view = probe(container)
  const key = `${view.unified}|${view.mute}|${view.live}`
  if (key !== lastKey) {
    lastKey = key
    note(container, `change ${label}`)
  }
}

function printTrace(name: string): void {
  const lines = trace.map((e) =>
    `${String(e.at).padStart(7)}ms  ${e.event.padEnd(34)} primary=${String(e.primary).padEnd(16)} mute=${e.mute.padEnd(8)}${e.live ? ' live' : '       '} [${e.all.join(', ')}]`)
  console.log(`\n=== trace: ${name} (${trace.length} visible changes) ===\n${lines.join('\n')}`)
  try {
    // vitest runs from the repo root; the traces land in tests/ next to this file.
    writeFileSync('tests/sim-trace-' + name.replace(/\s+/g, '-') + '.jsonl',
      trace.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
  } catch (err) { console.error('trace write failed:', err) }
}

/** How many separate times the microphone went live (the data-voice-live
 * row on screen). A flicker from a focus event shows up as an EXTRA session:
 * a recording that was killed and later reopened is a second session. A clean
 * turn is exactly one session; the legitimate end of an utterance is not
 * counted. */
function recordingSessions(from = 0): number {
  let count = 0, inRecording = false
  for (const e of trace.slice(from)) {
    if (e.live && !inRecording) { count += 1; inRecording = true }
    else if (!e.live) inRecording = false
  }
  return count
}

/* --------------------------------------------------------------- fixture */

const transcript: Transcript = { text: 'hello world', audioSeconds: 1.4, inferenceSeconds: 0.1 }

interface Sim {
  container: HTMLElement
  input: HTMLElement
  snapshot: { running: boolean }
  inputActions: { submit: ReturnType<typeof vi.fn>; setDraft: ReturnType<typeof vi.fn> }
  capture: InstanceType<typeof Recording> & Record<string, unknown>
  rerender: () => void
  setAmplitude: (rms: number) => void
  setSpeaking: (on: boolean) => void
  blur: () => void
  focus: () => void
  hide: () => void
  show: () => void
  tapUnified: () => void
  tapMute: () => void
  waitForPrimary: (label: string) => Promise<void>
}

let speakingButton: HTMLButtonElement | null = null

function makeSim(): Sim {
  const snapshot = { running: false }
  const useSession = ((selector: (value: { running: boolean }) => unknown) => selector(snapshot)) as unknown as VoiceInputProps['useSession']
  const amplitude = { value: 0.0001 }
  const capture = Object.assign(new Recording(() => {}), {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => new Uint8Array(48)),
    amplitude: vi.fn(() => amplitude.value),
    setMuted: vi.fn(),
    dispose: vi.fn(async () => {}),
  })
  const inputActions = {
    notify: vi.fn(), captureInsertion: vi.fn(() => ({ start: 3, end: 3, draftRev: 1 })), insertText: vi.fn(() => true),
    setDraft: vi.fn(), addAttachments: vi.fn(() => true), removeAttachment: vi.fn(), pruneAttachments: vi.fn(),
    submit: vi.fn(),
  }
  const transcribe = vi.fn(async () => ({ ok: true, value: transcript }) as RemoteResult<Transcript>)
  const t = ((key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key)) as VoiceInputProps['t']
  const props: VoiceInputProps = {
    sessionId: 'sim' as SessionId, inputActions: inputActions as never, transcribe: transcribe as never,
    locked: false, onActiveChange: vi.fn(), useSession,
    openSettings: vi.fn(), prepare: vi.fn(async () => {}), cancelPreparation: vi.fn(async () => {}),
    configure: vi.fn(async () => {}),
    useSpeechReadiness: (() => ({
      connected: true, error: null,
      catalog: {
        providers: [{ id: 'sim', name: 'Sim', location: 'host-local' as const, languages: ['auto'], preparation: { phase: 'ready' as const } }],
        selection: { providerId: 'sim' as never, language: 'auto' }, maxAudioBytes: 1_000_000, maxDurationSeconds: 120,
      },
    })) as unknown as VoiceInputProps['useSpeechReadiness'],
    createRecording: () => capture,
    stopTurn: vi.fn(),
    t,
  }
  // The composer the host renders around the plugin entry: card → input, and
  // the seat the plugin row lands in — the plugin is INSIDE its composer card.
  const card = document.createElement('div'); card.setAttribute('data-composer-card', '')
  const input = document.createElement('div'); input.setAttribute('data-composer-input', ''); input.setAttribute('contenteditable', 'true')
  const seat = document.createElement('div'); seat.setAttribute('data-composer-seat', '')
  card.append(input, seat); document.body.append(card)
  const view = render(<VoiceInput {...props} />, { container: seat })
  const container = view.container
  return {
    container, input, snapshot, inputActions, capture,
    rerender: () => { view.rerender(<VoiceInput {...props} />) },
    setAmplitude: (rms: number) => { amplitude.value = rms },
    setSpeaking: (on: boolean) => {
      if (on && !speakingButton) {
        speakingButton = document.createElement('button')
        speakingButton.setAttribute('aria-label', 'Stop speaking')
        document.body.appendChild(speakingButton)
      }
      if (!on && speakingButton) { speakingButton.remove(); speakingButton = null }
    },
    blur: () => fireEvent.blur(window),
    focus: () => fireEvent.focus(window),
    hide: () => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); fireEvent(document, new Event('visibilitychange')) },
    show: () => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); fireEvent(document, new Event('visibilitychange')) },
    tapUnified: () => {
      const unified = container.querySelector<HTMLButtonElement>('[data-voice-unified="1"]')
      if (!unified) throw new Error('no unified button rendered')
      fireEvent.click(unified)
    },
    tapMute: () => {
      const mute = container.querySelector<HTMLButtonElement>('button[aria-label="muteMic"], button[aria-label="unmuteMic"]')
      if (!mute) throw new Error('no mute button rendered')
      fireEvent.click(mute)
    },
    waitForPrimary: async (label: string) => {
      await waitFor(() => {
        const el = container.querySelector<HTMLButtonElement>('[data-voice-unified="1"]')
          ?? container.querySelector<HTMLButtonElement>('button[aria-label="voiceChat.stop"], button[aria-label="transcribingShort"]')
        if (el?.getAttribute('aria-label') !== label) throw new Error(`primary is ${el?.getAttribute('aria-label')}, want ${label}`)
      }, { timeout: 9000, interval: 50 })
    },
  }
}

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** One user utterance: voice for a bit, then silence, so the VAD sends it. */
async function speak(s: Sim, wordsMs = 700): Promise<void> {
  s.setAmplitude(0.2)
  await sleep(wordsMs)
  s.setAmplitude(0.0001)
}

async function waitSubmitted(s: Sim): Promise<void> {
  await waitFor(() => { expect(s.inputActions.submit).toHaveBeenCalled() }, { timeout: 10000, interval: 50 })
}

/** Tap the voice-chat entry (waveform) and wait for the live recording. */
async function startTurn(s: Sim): Promise<void> {
  s.tapUnified()
  await s.waitForPrimary('voiceChat.stop')
}

beforeEach(() => {
  trace.length = 0
  lastKey = ''
  metricLines.length = 0
  setMetricsSink((entry) => { metricLines.push(entry) })
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

afterEach(() => {
  if (speakingButton) { speakingButton.remove(); speakingButton = null }
  document.querySelectorAll('[data-composer-card]').forEach((node) => node.remove())
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/* ------------------------------------------------------------------ tests */

it('converses two turns with no focus events: the rhythm is clean', async () => {
  currentTest = 'two-turn conversation'
  const s = makeSim()
  watch(s.container, 'mount')

  // Turn one: tap the waveform, talk, silence, send.
  await startTurn(s)
  watch(s.container, 'turn1 recording')
  await speak(s)
  await waitSubmitted(s)
  watch(s.container, 'turn1 submitted')

  // The agent thinks, then replies (device muted: no speech).
  s.snapshot.running = true; s.rerender(); watch(s.container, 'turn1 agent running')
  await s.waitForPrimary('stopGenerating')
  s.snapshot.running = false; s.rerender()
  watch(s.container, 'turn1 reply ended')

  // Continuous listening reopens the microphone ~3 s after the reply.
  await s.waitForPrimary('voiceChat.stop')
  watch(s.container, 'turn2 auto-open')

  // Turn two: talk again, silence, send.
  await speak(s)
  await waitSubmitted(s)
  await s.waitForPrimary('stopGenerating')
  watch(s.container, 'turn2 handover')

  printTrace(currentTest)

  // The microphone went live exactly twice: once per turn. Any extra session
  // would mean the live recording was killed and reopened mid-conversation.
  expect(recordingSessions()).toBe(2)

  // Every completed voice turn ships a latency line (end of his words ->
  // agent start, agent think time) that the host appends to its log.
  expect(metricLines.length).toBeGreaterThanOrEqual(1)
  for (const line of metricLines) {
    expect(line).toMatchObject({ toAgentMs: expect.any(Number), thinkMs: expect.any(Number) })
    expect((line as { toAgentMs: number }).toAgentMs).toBeGreaterThanOrEqual(0)
    expect((line as { thinkMs: number }).thinkMs).toBeGreaterThanOrEqual(0)
  }
}, 60000)

it('keeps a live recording through a window blur (I2)', async () => {
  currentTest = 'blur during recording'
  const s = makeSim()
  watch(s.container, 'mount')
  await startTurn(s)
  await speak(s, 300)

  // A notification steals focus mid-utterance.
  s.blur()
  await sleep(250)
  watch(s.container, 'after blur')
  // The turn is still live: cross + mute still on screen, no idle excursion.
  expect(s.container.querySelector('button[aria-label="voiceChat.stop"]')).toBeTruthy()
  expect(s.container.querySelector('button[aria-label="muteMic"], button[aria-label="unmuteMic"]')).toBeTruthy()
  expect(recordingSessions()).toBe(1) // one live recording, never killed

  // Focus returns; the user keeps talking and the turn still sends.
  s.focus()
  await speak(s, 400)
  await waitSubmitted(s)
  watch(s.container, 'resumed and sent')

  printTrace(currentTest)
  expect(recordingSessions()).toBe(1) // the whole turn was one recording session
  expect(s.inputActions.submit).toHaveBeenCalled()
}, 60000)

it('keeps a live recording through a screen-off (visibility hidden) (I2)', async () => {
  currentTest = 'screen-off during recording'
  const s = makeSim()
  watch(s.container, 'mount')
  await startTurn(s)
  await speak(s, 300)

  s.hide()
  await sleep(250)
  watch(s.container, 'after screen-off')
  expect(s.container.querySelector('button[aria-label="voiceChat.stop"]')).toBeTruthy()
  expect(recordingSessions()).toBe(1) // one live recording, never killed

  s.show()
  await speak(s, 400)
  await waitSubmitted(s)
  watch(s.container, 'resumed and sent')

  printTrace(currentTest)
  expect(recordingSessions()).toBe(1) // the whole turn was one recording session
  expect(s.inputActions.submit).toHaveBeenCalled()
}, 60000)

it('shows exactly one designed handover when speech starts during an auto-open (I3)', async () => {
  currentTest = 'speech during auto-open'
  const s = makeSim()
  watch(s.container, 'mount')

  // Arm continuous listening with one full turn.
  await startTurn(s)
  await speak(s)
  await waitSubmitted(s)
  s.snapshot.running = true; s.rerender()
  s.snapshot.running = false; s.rerender()
  await s.waitForPrimary('voiceChat.stop') // auto-open number one
  const atAutoOpen = trace.length
  watch(s.container, 'auto-open 1')

  // Slow TTS: the reply's speech starts WHILE the microphone is open.
  s.setSpeaking(true)
  await s.waitForPrimary('stopSpeech')
  watch(s.container, 'speech starts mid auto-open')
  await sleep(1200) // the reply speaks
  s.setSpeaking(false)
  await s.waitForPrimary('voiceChat.stop') // reopens for the next words
  watch(s.container, 'auto-open 2')

  printTrace(currentTest)

  // Between the auto-open and the reopen, the only state the user ever sees
  // is the designed speaking handover (stop square) — never a bare idle — and
  // the microphone went live exactly twice (the designed open/handover/reopen).
  const window = trace.slice(atAutoOpen)
  for (const e of window) {
    expect(['voiceChat.stop', 'stopSpeech']).toContain(e.primary)
  }
  expect(recordingSessions(atAutoOpen)).toBe(2)
}, 60000)

it('exits speech mode on stop: the default row returns and the mic does not reopen', async () => {
  currentTest = 'stop exits speech mode'
  const s = makeSim()
  watch(s.container, 'mount')

  // One full turn puts the conversation into speech mode (the dictate mic goes away).
  await startTurn(s)
  watch(s.container, 'turn1 recording')
  await speak(s)
  await waitSubmitted(s)
  watch(s.container, 'turn1 submitted')
  s.snapshot.running = true; s.rerender()
  // While the agent thinks the microphone stays open (mid-turn words queue)
  // and the button is the stop square.
  await s.waitForPrimary('stopGenerating')
  watch(s.container, 'agent running, mic open')
  expect(s.container.querySelector('button[aria-label="start"]')).toBeNull() // speech mode: no dictate

  // The user stops the reply.
  s.tapUnified()
  s.snapshot.running = false; s.rerender()
  watch(s.container, 'stopped')

  // Back to the default row: the dictate mic is back, the button is the
  // voice entry, and nothing is recording.
  expect(s.container.querySelector('button[aria-label="start"]')).toBeTruthy()
  await s.waitForPrimary('voiceChat.start')

  // And it stays there: no auto-open crosses into a live microphone.
  await sleep(4200)
  watch(s.container, 'settle window passed')
  expect(s.container.querySelector('button[aria-label="voiceChat.stop"]')).toBeNull()
  expect(probe(s.container).unified).toBe('voiceChat.start')
  // turn one's tap-open and the thinking-phase auto-open; nothing after the stop
  expect(recordingSessions()).toBe(2)

  printTrace(currentTest)
}, 60000)

it('the mute joins the row only during a voice conversation', async () => {
  const s = makeSim()
  currentTest = 'mute-in-conversation-only'
  watch(s.container, 'mount')

  // The default row before a conversation: dictate + voice entry, no mute.
  expect(probe(s.container).mute).toBe('none')
  expect(s.container.querySelector('button[aria-label="start"]')).toBeTruthy()

  // The conversation starts: the mute takes the dictate button's place.
  await startTurn(s)
  expect(probe(s.container).mute).toBe('muteMic')
  expect(s.container.querySelector('button[aria-label="start"]')).toBeNull()

  // Mute while recording: the microphone is genuinely quiet.
  s.tapMute()
  watch(s.container, 'muted recording')
  expect(probe(s.container).mute).toBe('unmuteMic')
  await speak(s)
  await sleep(2600) // well past the 2 s silence window
  expect(s.inputActions.submit).not.toHaveBeenCalled()

  // Unmute and finish the turn the ordinary way.
  s.tapMute()
  expect(probe(s.container).mute).toBe('muteMic')
  await speak(s)
  await waitSubmitted(s)

  // The pending reply shows the stop square; the mute holds its place.
  await s.waitForPrimary('stopGenerating')
  watch(s.container, 'turn pending')
  expect(probe(s.container).mute).toBe('muteMic')

  // The session reports the turn running: the mic stays open (mid-turn words
  // queue) and the square and the mute stay.
  s.snapshot.running = true; s.rerender()
  await s.waitForPrimary('stopGenerating')
  watch(s.container, 'agent running, mic open')
  expect(probe(s.container).mute).toBe('muteMic')

  // Stop the reply: the default row returns and the mute leaves with it.
  s.tapUnified()
  s.snapshot.running = false; s.rerender()
  await s.waitForPrimary('voiceChat.start')
  expect(s.container.querySelector('button[aria-label="start"]')).toBeTruthy()
  expect(probe(s.container).mute).toBe('none')

  printTrace(currentTest)
}, 60000)

it('turns the voice button into a send arrow while a draft is typed', async () => {
  const s = makeSim()
  currentTest = 'draft send arrow'
  watch(s.container, 'mount')

  expect(probe(s.container).unified).toBe('voiceChat.start')

  // Typing in the composer flips the button to the send arrow.
  s.input.textContent = 'hello there'
  s.input.dispatchEvent(new Event('input', { bubbles: true }))
  await waitFor(() => { expect(probe(s.container).unified).toBe('send') }, { timeout: 4000, interval: 50 })
  watch(s.container, 'typed')

  // Clearing the draft brings the voice entry back.
  s.input.textContent = ''
  s.input.dispatchEvent(new Event('input', { bubbles: true }))
  await waitFor(() => { expect(probe(s.container).unified).toBe('voiceChat.start') }, { timeout: 4000, interval: 50 })
  watch(s.container, 'cleared')

  printTrace(currentTest)
}, 60000)

it('watches its own composer when a hidden one sits earlier in the document', async () => {
  // The shape of the production page on a phone: another (hidden) composer
  // earlier in document order. A bare document.querySelector would track its
  // empty input and the arrow would never appear.
  const decoy = document.createElement('div'); decoy.setAttribute('data-composer-card', ''); decoy.setAttribute('hidden', '')
  const decoyInput = document.createElement('div'); decoyInput.setAttribute('data-composer-input', '')
  decoy.append(decoyInput); document.body.prepend(decoy)

  const s = makeSim()
  currentTest = 'own-composer'
  watch(s.container, 'mount')

  s.input.textContent = 'hello'
  s.input.dispatchEvent(new Event('input', { bubbles: true }))
  await waitFor(() => { expect(probe(s.container).unified).toBe('send') }, { timeout: 4000, interval: 50 })
  watch(s.container, 'typed on own composer')

  printTrace(currentTest)
}, 60000)
