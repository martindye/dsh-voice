/**
 * Browser half of the two-way voice output: the `tts` Remote client, one
 * speaker button per finalized assistant message (rendered by SpeakerButton),
 * a device auto-read toggle, and the shared playback engine.
 *
 * Auto-read follows the device's own choice, never the retired PC voice
 * bridge: a reply is read aloud on this device when (1) the device toggle is
 * on and (2) this device has used the voice composer at least once
 * (dsh.voice-chat.v1, armed by VoiceInput). Freshness is enforced on the
 * host (replies older than two minutes are skipped, not spoken).
 */
import { sentenceBlocks } from '../sentences.ts'
import { getSharedAudioContext, unlockPageAudio } from './audio-unlock.ts'

/** Strict-codec pass-through (the bundle has no zod; the host runs raw JSON). */
function passThroughCodec(typeSymbol: string): unknown {
  return {
    mode: 'strict',
    typeSymbol,
    create: () => ({
      parse: (value: unknown) => value,
      safeParse: (value: unknown) => ({ success: true, data: value }),
    }),
  }
}

/** The host's `tts` namespace, hand-written (same contract as the host). */
export const TTS_REMOTE = {
  package: '@martindye/dsh-voice',
  descriptors: [
    {
      id: '@martindye/dsh-voice#tts/status',
      service: 'ttsController',
      namespace: 'tts',
      method: 'status',
      invocation: { kind: 'direct' },
      parameters: [],
      result: passThroughCodec('@martindye/dsh-voice#TtsStatus'),
    },
    {
      id: '@martindye/dsh-voice#tts/synthesize',
      service: 'ttsController',
      namespace: 'tts',
      method: 'synthesize',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'request', wire: 'request', source: 'json', codec: passThroughCodec('@martindye/dsh-voice#SynthesizeRequest') },
      ],
      cancellation: { parameter: 'signal' },
      result: passThroughCodec('@martindye/dsh-voice#SynthesizeResult'),
    },
    {
      id: '@martindye/dsh-voice#tts/plan',
      service: 'ttsController',
      namespace: 'tts',
      method: 'plan',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'request', wire: 'request', source: 'json', codec: passThroughCodec('@martindye/dsh-voice#PlanRequest') },
      ],
      cancellation: { parameter: 'signal' },
      result: passThroughCodec('@martindye/dsh-voice#PlanResult'),
    },
    {
      id: '@martindye/dsh-voice#tts/render',
      service: 'ttsController',
      namespace: 'tts',
      method: 'render',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'request', wire: 'request', source: 'json', codec: passThroughCodec('@martindye/dsh-voice#RenderRequest') },
      ],
      cancellation: { parameter: 'signal' },
      result: passThroughCodec('@martindye/dsh-voice#RenderResult'),
    },
    {
      id: '@martindye/dsh-voice#tts/setEngine',
      service: 'ttsController',
      namespace: 'tts',
      method: 'setEngine',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'engine', wire: 'engine', source: 'json', codec: passThroughCodec('@martindye/dsh-voice#EngineChoice') },
      ],
      result: passThroughCodec('@martindye/dsh-voice#EngineChoiceResult'),
    },
  ],
} as const

export type VoiceEngineChoice = 'pocket' | 'qwen3'

/**
 * The host's tts namespace. plan/render are runtime-checked (an old host
 * simply does not have them); declared plainly because this bundle is the
 * only caller of its own contract.
 */
interface TtsNamespace {
  status(): Promise<unknown>
  synthesize(request: { sessionId: string; messageId: string; auto: boolean; scope?: 'final' | 'steps' }, signal?: unknown): Promise<unknown>
  plan(request: { sessionId: string; messageId: string; auto: boolean; scope?: 'final' | 'steps' }, signal?: unknown): Promise<unknown>
  render(request: { text: string }, signal?: unknown): Promise<unknown>
  setEngine(engine: VoiceEngineChoice): Promise<unknown>
}

let ns: TtsNamespace | null = null

/** Called once from mountVoiceInput with the mounted remote namespace. */
export function setTtsRemote(remote: unknown): void {
  ns = (remote as { tts?: TtsNamespace } | undefined)?.tts ?? null
}

/* ---------------------------------------------------------- shared state */

export interface TtsStatus {
  server: 'up' | 'off'
  engine: string
  known: boolean
}

const status: TtsStatus = { server: 'off', engine: 'pocket', known: false }

/** Last host-reported facts (status polling refreshes these). */
export function ttsStatus(): TtsStatus {
  return status
}

export function noteTtsStatus(s: { server?: string; engine?: string } | null | undefined): void {
  if (!s) return
  status.server = s.server === 'up' ? 'up' : 'off'
  if (typeof s.engine === 'string' && s.engine) status.engine = s.engine
  status.known = true
}

let lastError: string | null = null
const listeners = new Set<() => void>()

export function subscribeTts(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function emit(): void {
  for (const listener of [...listeners]) listener()
}

export function currentError(): string | null {
  return lastError
}

/* ------------------------------------------------------------- playback */

interface PlaybackHandle { stop: () => void }

let currentAudio: PlaybackHandle | null = null

export function isPlaying(): boolean {
  return currentAudio !== null
}

export function stopPlayback(): void {
  generation += 1
  if (pipelineAbort) {
    try { pipelineAbort.abort() } catch { /* already stopped */ }
    pipelineAbort = null
  }
  if (!currentAudio) return
  try { currentAudio.stop() } catch { /* already stopped */ }
  currentAudio = null
  emit()
}

/* ------------------------------------------------------ serial audio queue */

/**
 * The serial audio queue: one voice at a time, in order.
 *
 * A manual read (the speaker button) and an explicit stop cut in at once —
 * those are deliberate human actions. An auto-read never cuts in: it lines
 * up behind whatever is playing, so a fast reply reads after the previous
 * sentence finishes instead of interrupting it mid-word. While an auto-read
 * is waiting, a stop or a manual read bumps the generation; the waiter wakes,
 * sees the mismatch, and gives up silently.
 */
interface Tail {
  /** Settles when this playback is (or has become) fully silent. */
  readonly promise: Promise<void>
  /** Idempotent: safe to call from every exit path. */
  settle: () => void
}

/** The tail of the queue: when it settles, everything ahead is silent. */
let tail: Tail = { promise: Promise.resolve(), settle: () => { /* nothing playing */ } }

/** Bumped on every stop/cut-in: queued auto-reads that miss it give up. */
let generation = 0

function makeTail(): Tail {
  let done = false
  let resolve = () => { /* already settled */ }
  const promise = new Promise<void>((r) => { resolve = r })
  return {
    promise,
    settle: () => { if (!done) { done = true; resolve() } },
  }
}

/**
 * Line up in the queue and claim the next slot. Returns the tail this read
 * owns — installed synchronously, so two admissions can never interleave —
 * or null when the read must give up. `baseline` is the generation at the
 * moment the read was triggered, so a stop or a manual read that happened
 * even before it got to line up still cancels it. A manual read while
 * waiting does NOT cancel: the read lines up behind the manual one instead.
 */
async function admitToQueue(baseline: number): Promise<Tail | null> {
  let since = baseline
  for (;;) {
    const wait = tail
    await wait.promise
    if (generation === since) {
      if (tail !== wait) continue // someone got ahead of us: line up again
      const mine = makeTail()
      tail = mine
      return mine
    }
    if (tail !== wait) { since = generation; continue } // a manual read: behind it
    return null // a pure stop: silence was asked for
  }
}

function blockedMessage(): string {
  return 'audio is blocked by the phone — check the speaker icon in the top address bar of Safari (tap it to unmute), then tap again'
}

function webAudioBlocked(error: unknown): boolean {
  const message = String((error as { message?: unknown } | null)?.message ?? error)
  const name = (error as { name?: unknown } | null)?.name
  return name === 'NotAllowedError' || name === 'InvalidStateError'
    || /not allowed|suspended|security/i.test(message)
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

async function playB64(b64: string, mine: Tail): Promise<void> {
  let bytes: Uint8Array
  try {
    bytes = decodeBase64(b64)
  } catch {
    lastError = 'could not decode the audio'
    emit()
    return
  }
  const finish = (h: PlaybackHandle): void => { if (currentAudio === h) { currentAudio = null; emit() } mine.settle() }
  // Preferred path: WebAudio through the gesture-unlocked shared context.
  const ac = getSharedAudioContext()
  if (ac && ac.state !== 'closed') {
    try {
      if (ac.state === 'suspended') await ac.resume()
      const decoded = await ac.decodeAudioData(bytes.buffer.slice(0))
      const src = ac.createBufferSource()
      src.buffer = decoded
      src.connect(ac.destination)
      const handle: PlaybackHandle = { stop: () => { try { src.stop() } catch { /* ignore */ } mine.settle() } }
      src.onended = () => finish(handle)
      currentAudio = handle
      src.start()
      lastError = null
      emit()
    } catch (error) {
      currentAudio = null
      mine.settle()
      lastError = webAudioBlocked(error)
        ? blockedMessage()
        : 'audio playback failed: ' + String((error as { message?: unknown })?.message ?? error)
      emit()
    }
    return
  }
  // Fallback: plain media element (works once the domain is unlocked).
  const a = new Audio(`data:audio/wav;base64,${b64}`)
  const handle: PlaybackHandle = { stop: () => { try { a.pause() } catch { /* ignore */ } mine.settle() } }
  a.onended = () => finish(handle)
  a.onerror = () => { if (currentAudio === handle) { currentAudio = null; lastError = 'the audio element failed to load'; emit() } mine.settle() }
  currentAudio = handle
  void a.play().catch((error: unknown) => {
    currentAudio = null
    mine.settle()
    lastError = (error as { name?: string })?.name === 'NotAllowedError'
      ? blockedMessage()
      : 'audio playback failed: ' + String((error as { message?: unknown })?.message ?? error)
    emit()
  })
  emit()
}

/* ------------------------------------------------ sentence pipeline (T) */

/** Abort handle of the in-flight sentence pipeline, if any. */
let pipelineAbort: AbortController | null = null

/** Unwrap a remote result: bare value, or the {ok,value,error} envelope. */
function unwrapValue(result: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const r = result as { ok?: boolean; value?: unknown; error?: { message?: string } } | Record<string, unknown> | null
  if (r && typeof r === 'object' && 'ok' in r) {
    if (r.ok) return { ok: true, value: (r.value as Record<string, unknown>) ?? {} }
    return { ok: false, error: r.error?.message ?? 'tts failed' }
  }
  return { ok: true, value: (r as Record<string, unknown>) ?? {} }
}

/* ------------------------------------------- render-speed calibration (T) */

const SPEED_KEY = 'dsh-voice-output:render-speed'
export const DEFAULT_RENDER_SPEED = 2.5
const SPEED_MIN = 0.8
const SPEED_MAX = 5

/**
 * Calibrated render speed: audio-seconds per render-second, per machine.
 * The TTS server's speed varies with the host CPU and load, so the value is
 * stored after the first measured render and blends toward each fresh
 * sample. Until a measurement exists the assumed 2.5 is used (normal
 * behaviour can be assumed), so block-building works from the very first
 * reply and refines itself from the second sentence onward.
 */
export function loadRenderSpeed(): number {
  try {
    const raw = localStorage.getItem(SPEED_KEY)
    const n = raw === null ? NaN : Number(raw)
    if (Number.isFinite(n) && n >= SPEED_MIN && n <= SPEED_MAX) return n
  } catch { /* private mode etc. */ }
  return DEFAULT_RENDER_SPEED
}

/**
 * Fold one measured render (audio seconds vs render seconds) into the stored
 * speed. First-ever sample sets it outright; later samples blend 60/40 so a
 * single hiccup does not move it. Out-of-range samples (cold server load,
 * cache hits, hiccups) are dropped.
 */
export function noteRenderSample(audioSeconds: number, renderSeconds: number): void {
  if (!(audioSeconds > 0.2) || !(renderSeconds > 0.05)) return
  const sample = audioSeconds / renderSeconds
  if (sample < 0.5 || sample > 6) return
  const clamped = Math.min(SPEED_MAX, Math.max(SPEED_MIN, sample))
  let prev: number | null = null
  try {
    const raw = localStorage.getItem(SPEED_KEY)
    const n = raw === null ? NaN : Number(raw)
    if (Number.isFinite(n)) prev = n
  } catch { /* best effort */ }
  const next = prev === null
    ? clamped
    : Math.min(SPEED_MAX, Math.max(SPEED_MIN, 0.6 * prev + 0.4 * clamped))
  try { localStorage.setItem(SPEED_KEY, String(next)) } catch { /* best effort */ }
}

/**
 * Play a block plan as a pipeline: blocks enter the host's render pipe one
 * at a time, and each one is decoded and scheduled back-to-back on the
 * shared AudioContext the moment it arrives. The engine renders faster than
 * real time, so the first block is spoken while the rest is still rendering
 * — the reply is heard as it is made, not after it is finished. Each block
 * is speed-aware (see sentenceBlocks): a clip is never scheduled to finish
 * before the one after it is rendered, so the voice does not run dry.
 * The returned promise settles when the FIRST block is scheduled (or the
 * pipeline dies before that), which is when the "speaking" state becomes real.
 */
/**
 * Stop whatever is playing and take the queue slot for a deliberate read
 * (speaker button, tap-to-speak). All synchronous, so no other read can
 * interleave between the stop and the claim.
 */
function claimFreshTail(): Tail {
  stopPlayback()
  const mine = makeTail()
  tail = mine
  return mine
}

/** A manual read cuts in at once: stop the current audio, start this now. */
function runManualPipeline(blocks: string[], remote: TtsNamespace): Promise<boolean> {
  return runPipelined(blocks, remote, claimFreshTail())
}

function runPipelined(blocks: string[], remote: TtsNamespace, mine: Tail): Promise<boolean> {
  const ac = getSharedAudioContext()
  if (!ac || ac.state === 'closed') {
    mine.settle()
    lastError = 'audio is not ready on this device'
    emit()
    return Promise.resolve(true)
  }
  const abort = new AbortController()
  pipelineAbort = abort
  const sources: { stop: () => void }[] = []
  let endTimer = 0
  let firstScheduled: (() => void) | null = null
  const firstSentence = new Promise<boolean>((resolve) => { firstScheduled = () => { resolve(true) } })
  const handle: PlaybackHandle = {
    stop: () => {
      try { abort.abort() } catch { /* already stopped */ }
      for (const src of sources) { try { src.stop() } catch { /* ignore */ } }
      window.clearTimeout(endTimer)
      if (pipelineAbort === abort) pipelineAbort = null
      if (currentAudio === handle) currentAudio = null
      firstScheduled?.()
      mine.settle()
    },
  }
  void (async () => {
    try {
      if (ac.state === 'suspended') await ac.resume()
      let nextStart = ac.currentTime + 0.08
      for (let i = 0; i < blocks.length; i++) {
        if (abort.signal.aborted) { mine.settle(); return }
        const rendered = unwrapValue(await remote.render({ text: blocks[i] }, abort.signal))
        if (abort.signal.aborted) { mine.settle(); return }
        if (!rendered.ok) throw new Error(rendered.error)
        const b64 = rendered.value?.audioBase64
        if (typeof b64 !== 'string' || !b64) throw new Error(`no audio for block ${i + 1}`)
        const renderMs = typeof rendered.value?.elapsedMs === 'number' ? (rendered.value.elapsedMs as number) : 0
        const bytes = decodeBase64(b64)
        const decoded = await ac.decodeAudioData(bytes.buffer.slice(0))
        // Calibrate the render speed from what the host just reported, so
        // the NEXT reply's blocks are cut for this machine.
        noteRenderSample(decoded.duration, renderMs / 1000)
        if (abort.signal.aborted) { mine.settle(); return }
        const src = ac.createBufferSource()
        src.buffer = decoded
        src.connect(ac.destination)
        sources.push(src)
        const startAt = Math.max(ac.currentTime + 0.02, nextStart)
        src.start(startAt)
        nextStart = startAt + decoded.duration
        if (i === 0) {
          currentAudio = handle
          lastError = null
          emit()
          firstScheduled?.()
          firstScheduled = null
        }
      }
      // Keep the "speaking" state until the last sample has landed.
      const endMs = Math.max(0, (nextStart - ac.currentTime) * 1000)
      endTimer = window.setTimeout(() => {
        if (currentAudio === handle) { currentAudio = null; emit() }
        mine.settle()
      }, endMs + 150)
    } catch (error) {
      mine.settle()
      if (!abort.signal.aborted) {
        lastError = webAudioBlocked(error)
          ? blockedMessage()
          : 'voice reply failed: ' + String((error as { message?: unknown })?.message ?? error)
        if (currentAudio === handle) currentAudio = null
        emit()
      }
    } finally {
      if (pipelineAbort === abort) pipelineAbort = null
      firstScheduled?.()
      firstScheduled = null
    }
  })()
  return firstSentence
}

/* ------------------------------------------------------- device choices */

const AUTOMATIC_KEY = 'dsh-voice-output:autovoice'
const VOICE_CHAT_KEY = 'dsh.voice-chat.v1'

/** The per-device auto-read toggle (default on; shared key with the old kit
 *  so an existing choice carries over). */
export function deviceOn(): boolean {
  try { return (localStorage.getItem(AUTOMATIC_KEY) ?? '1') !== '0' } catch { return true }
}

export function setDeviceOn(on: boolean): void {
  try { localStorage.setItem(AUTOMATIC_KEY, on ? '1' : '0') } catch { /* best effort */ }
  emit()
}

/** This device has used the voice composer (armed by VoiceInput on first use). */
export function voiceChatMode(): boolean {
  try { return localStorage.getItem(VOICE_CHAT_KEY) === '1' } catch { return false }
}

/* -------------------------------------------- what gets read aloud (scope) */

/**
 * What a device reads aloud: 'final' is the turn's last answer only (the
 * historical behaviour); 'steps' also speaks the intermediate steps, in
 * order, ending with the final answer. Stored per browser; never leaves it.
 */
export type AutoReadScope = 'final' | 'steps'

const READ_SCOPE_KEY = 'dsh-voice-output:read-scope'

export function autoReadScope(): AutoReadScope {
  try { return localStorage.getItem(READ_SCOPE_KEY) === 'steps' ? 'steps' : 'final' } catch { return 'final' }
}

export function setAutoReadScope(scope: AutoReadScope): void {
  try { localStorage.setItem(READ_SCOPE_KEY, scope) } catch { /* best effort */ }
  emit()
}

/* ---------------------------------------------------------------- speak */

/** Message ids already considered for auto-read (once per browser per message). */
const handled = new Set<string>()

export function markMessageHandled(messageId: string): void {
  handled.add(messageId)
}

export function messageHandled(messageId: string): boolean {
  return handled.has(messageId)
}

export interface SpeakOutcome {
  audio?: boolean
  stale?: boolean
  error?: string
}

/**
 * Speak one finalized assistant message. auto=true is the reply auto-read:
 * the host declines stale replies with { stale: true } instead of audio.
 *
 * Fast path: the host splits the reply into sentences (plan), the client
 * groups them into speed-aware blocks and pipelines one render per block,
 * so the first words are heard while the rest is still rendering.
 * Fallback: one whole-message render (legacy host, or no AudioContext).
 */
export async function speak(
  sessionId: string,
  messageId: string,
  opts: { auto?: boolean; scope?: 'final' | 'steps' } = {},
): Promise<SpeakOutcome> {
  if (!ns) {
    lastError = 'tts remote not ready (page reload needed?)'
    if (!opts.auto) emit()
    return { error: lastError }
  }
  const auto = !!opts.auto
  // An auto-read reserves its slot in the serial queue the moment it is
  // triggered — before the plan is even fetched — so two fast replies line
  // up in trigger order no matter how the host orders the plan calls. A
  // stop or a manual read while it waits, or while the plan is in flight,
  // makes it give up.
  const baseline = generation
  const reserved = auto ? await admitToQueue(baseline) : null
  if (auto && !reserved) return {}
  let claimed = false
  const q = { reserved, baseline, claim: () => { claimed = true } }
  try {
    return await speakWithPlan(sessionId, messageId, opts, q)
  } finally {
    // A slot never handed to a pipeline (stale plan, an error, a stop while
    // the plan was in flight) must be released, or the queue jams.
    if (reserved && !claimed) reserved.settle()
  }
}

async function speakWithPlan(
  sessionId: string,
  messageId: string,
  opts: { auto?: boolean; scope?: 'final' | 'steps' },
  q: { reserved: Tail | null; baseline: number; claim: () => void },
): Promise<SpeakOutcome> {
  if (typeof ns!.plan === 'function' && typeof ns!.render === 'function' && getSharedAudioContext()) {
    const remote = ns!
    let plan: unknown
    try {
      plan = await remote.plan({ sessionId, messageId, auto: !!opts.auto, scope: opts.scope ?? 'final' })
    } catch (error) {
      lastError = String((error as { message?: unknown })?.message ?? error)
      console.warn('[dsh-voice tts] plan failed:', error)
      if (!opts.auto) emit()
      return { error: lastError }
    }
    const planOut = unwrapValue(plan)
    if (!planOut.ok) {
      lastError = planOut.error
      if (!opts.auto) emit()
      return { error: lastError }
    }
    if (planOut.value.stale) return { stale: true }
    const sentences = Array.isArray(planOut.value.sentences)
      ? (planOut.value.sentences as unknown[]).filter((s): s is string => typeof s === 'string' && s.length > 0)
      : []
    if (sentences.length === 0) {
      lastError = 'no speakable sentences'
      if (!opts.auto) emit()
      return { error: lastError }
    }
    // Group into speed-aware blocks: a sentence that would still be
    // rendering when the previous clip has finished plays inside the
    // previous clip's block instead, so no gap can open between them.
    const blocks = sentenceBlocks(sentences, loadRenderSpeed()).map((block) => block.join(' '))
    let ran = false
    if (q.reserved) {
      // A stop or a manual read that happened while the plan was in flight
      // cancels this auto-read.
      if (generation !== q.baseline) return {}
      q.claim()
      ran = await runPipelined(blocks, remote, q.reserved)
    } else {
      ran = await runManualPipeline(blocks, remote)
    }
    if (!ran) return {}
    if (isPlaying()) return { audio: true }
    return lastError ? { error: lastError } : { audio: true }
  }
  // Legacy path: one whole-message render (old host, or no AudioContext).
  if (typeof ns.synthesize !== 'function') {
    lastError = 'tts remote not ready (page reload needed?)'
    if (!opts.auto) emit()
    return { error: lastError }
  }
  try {
    const r = (await ns.synthesize({ sessionId, messageId, auto: !!opts.auto, scope: opts.scope ?? 'final' })) as
      | { ok?: boolean; value?: { audioBase64?: string; stale?: boolean; elapsedMs?: number }; error?: { message?: string; code?: unknown } }
      | { audioBase64?: string; stale?: boolean; elapsedMs?: number }
    const envelope = r && typeof r === 'object' && 'ok' in r ? r : { ok: true, value: r }
    if (!envelope.ok) {
      const message = envelope.error?.message ?? 'tts failed'
      lastError = message
      console.warn('[dsh-voice tts] synthesize failed:', message)
      emit()
      return { error: message }
    }
    const out = envelope.value ?? {}
    if (out.stale) return { stale: true }
    if (!out.audioBase64) {
      lastError = 'no audio returned'
      emit()
      return { error: lastError }
    }
    lastError = null
    emit()
    if (q.reserved) {
      if (generation !== q.baseline) return {}
      q.claim()
      void playB64(out.audioBase64, q.reserved)
    } else {
      void playB64(out.audioBase64, claimFreshTail())
    }
    return { audio: true }
  } catch (error) {
    lastError = String((error as { message?: unknown })?.message ?? error)
    console.warn('[dsh-voice tts] speak threw:', error)
    emit()
    return { error: lastError }
  }
}

/** Tap-gesture entry point: the unlock must run inside the gesture (iOS). */
export function speakNow(sessionId: string, messageId: string): void {
  unlockPageAudio()
  if (isPlaying()) { stopPlayback(); return }
  void speak(sessionId, messageId, { auto: false })
}

/* ------------------------------------------------- voice engine choice */

export interface EngineChoiceResult {
  engine: VoiceEngineChoice
  /** 'up' | 'starting' | 'starter-missing' | 'not-requested' */
  gpu: string
}

/**
 * Persist the user's speaking-voice choice on the host. 'qwen3' is the GPU
 * voice: the host starts its chain on demand (3-5 min load) and it never
 * auto-restarts. 'pocket' is the small CPU voice (the default).
 */
export async function setSpeechEngine(engine: VoiceEngineChoice): Promise<EngineChoiceResult> {
  if (!ns || typeof ns.setEngine !== 'function') throw new Error('tts remote not ready (page reload needed?)')
  const r = (await ns.setEngine(engine)) as
    | { ok?: boolean; value?: { engine?: string; gpu?: string }; error?: { message?: string } }
    | { engine?: string; gpu?: string }
  const envelope = r && typeof r === 'object' && 'ok' in r ? r : { ok: true, value: r }
  if (!envelope.ok) throw new Error(envelope.error?.message ?? 'engine change failed')
  const value = (envelope.value ?? {}) as { engine?: string; gpu?: string }
  return { engine: (value.engine as VoiceEngineChoice) ?? engine, gpu: value.gpu ?? 'not-requested' }
}
