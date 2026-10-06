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
  package: '@martin/dsh-voice',
  descriptors: [
    {
      id: '@martin/dsh-voice#tts/status',
      service: 'ttsController',
      namespace: 'tts',
      method: 'status',
      invocation: { kind: 'direct' },
      parameters: [],
      result: passThroughCodec('@martin/dsh-voice#TtsStatus'),
    },
    {
      id: '@martin/dsh-voice#tts/synthesize',
      service: 'ttsController',
      namespace: 'tts',
      method: 'synthesize',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'request', wire: 'request', source: 'json', codec: passThroughCodec('@martin/dsh-voice#SynthesizeRequest') },
      ],
      cancellation: { parameter: 'signal' },
      result: passThroughCodec('@martin/dsh-voice#SynthesizeResult'),
    },
  ],
} as const

interface TtsNamespace {
  status(): Promise<unknown>
  synthesize(request: { sessionId: string; messageId: string; auto: boolean }, signal?: unknown): Promise<unknown>
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
  if (!currentAudio) return
  try { currentAudio.stop() } catch { /* already stopped */ }
  currentAudio = null
  emit()
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

async function playB64(b64: string): Promise<void> {
  stopPlayback()
  let bytes: Uint8Array
  try {
    bytes = decodeBase64(b64)
  } catch {
    lastError = 'could not decode the audio'
    emit()
    return
  }
  // Preferred path: WebAudio through the gesture-unlocked shared context.
  const ac = getSharedAudioContext()
  if (ac && ac.state !== 'closed') {
    try {
      if (ac.state === 'suspended') await ac.resume()
      const decoded = await ac.decodeAudioData(bytes.buffer.slice(0))
      const src = ac.createBufferSource()
      src.buffer = decoded
      src.connect(ac.destination)
      const handle: PlaybackHandle = { stop: () => { try { src.stop() } catch { /* ignore */ } } }
      src.onended = () => { if (currentAudio === handle) { currentAudio = null; emit() } }
      currentAudio = handle
      src.start()
      lastError = null
      emit()
    } catch (error) {
      currentAudio = null
      lastError = webAudioBlocked(error)
        ? blockedMessage()
        : 'audio playback failed: ' + String((error as { message?: unknown })?.message ?? error)
      emit()
    }
    return
  }
  // Fallback: plain media element (works once the domain is unlocked).
  const a = new Audio(`data:audio/wav;base64,${b64}`)
  const handle: PlaybackHandle = { stop: () => { try { a.pause() } catch { /* ignore */ } } }
  a.onended = () => { if (currentAudio === handle) { currentAudio = null; emit() } }
  a.onerror = () => { if (currentAudio === handle) { currentAudio = null; lastError = 'the audio element failed to load'; emit() } }
  currentAudio = handle
  void a.play().catch((error: unknown) => {
    currentAudio = null
    lastError = (error as { name?: string })?.name === 'NotAllowedError'
      ? blockedMessage()
      : 'audio playback failed: ' + String((error as { message?: unknown })?.message ?? error)
    emit()
  })
  emit()
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
 */
export async function speak(
  sessionId: string,
  messageId: string,
  opts: { auto?: boolean } = {},
): Promise<SpeakOutcome> {
  if (!ns || typeof ns.synthesize !== 'function') {
    lastError = 'tts remote not ready (page reload needed?)'
    if (!opts.auto) emit()
    return { error: lastError }
  }
  try {
    const r = (await ns.synthesize({ sessionId, messageId, auto: !!opts.auto })) as
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
    void playB64(out.audioBase64)
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
