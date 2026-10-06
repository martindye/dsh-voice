/** Unified composer action: one button sends text, stops the running turn, and runs voice-chat turns. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TranscriptionRequest } from '@deepseek-ai/dsh-experimental-api-speech-to-text/types'
import type { SpeechPreparationOptions, SpeechProviderId, SpeechSelection, SpeechSelectionPatch, Transcript } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { RecordingError, audioBase64, type Recording } from './audio.ts'
import { runningChanged, speechStarted, voiceEnded } from './metrics.ts'
import type { SpeechReadiness } from './readiness.ts'
import { VoiceSetupDialog } from './VoiceSetupDialog.tsx'
import { NS } from './locales.ts'
import { Button, IconCloseOutlineRegular, IconMicrophoneOutlineRegular, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './VoiceInput.module.css'

/** Host calls injected without exposing a Cordis Context to React. */
export interface VoiceInputActions {
  /** Open the voice bundle details without starting preparation. */
  openSettings: () => void
  /** Cancel the running turn of one session (a no-op when nothing runs). */
  stopTurn: (sessionId: SessionId) => void
  /** @returns one microphone operation owned by the plugin lifecycle. */
  createRecording: () => Recording
  transcribe: (request: TranscriptionRequest, signal: AbortSignal) => Promise<RemoteResult<Transcript>>
  prepare: (providerId: SpeechProviderId, options?: SpeechPreparationOptions) => Promise<void>
  cancelPreparation: (providerId: SpeechProviderId) => Promise<void>
  configure: (patch: SpeechSelectionPatch) => Promise<void>
}

/** Entry-injected Host readiness and microphone operations. */
export interface VoiceInputInjected extends VoiceInputActions {
  hooks: { speechReadiness: HostObservable<SpeechReadiness> }
}

/**
 * Self-contained session signals: `useSession` arrives with every
 * session-scoped slot, and the draft emptiness is read from the composer
 * itself, so the unified button needs no host-side slot extension.
 */
export type VoiceInputProps = Pick<PropsRuntime<'conversation.input.activity'>, 'sessionId' | 'inputActions' | 'locked' | 'onActiveChange' | 'useSession'>
  & PropsLocale<typeof NS> & InjectFace<VoiceInputInjected>

/**
 * The composer draft is empty while the editable input carries neither text
 * nor file-reference chips, and the composer card stages no images.
 *
 * The watcher anchors on this plugin's own card: the row renders inside the
 * composer, so the nearest [data-composer-card] is always the composer this
 * row belongs to, even when other (hidden) composers sit earlier in the
 * document and a bare document.querySelector would track the wrong one. A
 * document-level input listener backstops the mutation observer.
 */
function useComposerEmpty(cardRef: RefObject<HTMLElement | null>): boolean {
  const [empty, setEmpty] = useState(true)
  useEffect(() => {
    let observer: MutationObserver | undefined
    let retry = 0
    let timer = 0
    let input: HTMLElement | null = null
    let card: HTMLElement | null = null
    const read = (): void => {
      if (input === null) return
      const chipFree = input.querySelector('[data-composer-chip]') === null
        && card?.querySelector('[data-composer-chip], img') === null
      setEmpty((input.textContent ?? '').trim() === '' && chipFree)
    }
    const onInput = (event: Event): void => {
      if (input === null || !(event.target instanceof Node) || !input.contains(event.target)) return
      read()
    }
    const attach = (): boolean => {
      const anchor = cardRef.current
      card = anchor?.closest<HTMLElement>('[data-composer-card]')
        ?? document.querySelector<HTMLElement>('[data-composer-card]')
      input = card?.querySelector<HTMLElement>('[data-composer-input]')
        ?? document.querySelector<HTMLElement>('[data-composer-input]')
      if (input === null) return false
      read()
      const target = card ?? document.body
      observer = new MutationObserver(read)
      observer.observe(target, { subtree: true, childList: true, characterData: true })
      document.addEventListener('input', onInput)
      return true
    }
    if (!attach()) {
      // The entry renders inside the composer, which may mount a tick later.
      timer = window.setInterval(() => {
        if (attach() || ++retry > 40) window.clearInterval(timer)
      }, 250)
    }
    return () => {
      window.clearInterval(timer)
      observer?.disconnect()
      document.removeEventListener('input', onInput)
    }
  }, [])
  return empty
}

/** Browser-local voice-chat flag: once used, replies are read back on this device. */
const VOICE_CHAT_STORAGE_KEY = 'dsh.voice-chat.v1'

/** Voice activity during a voice turn: silence ends the turn, a dead mic gives up. */
const VOICE_RMS = 0.02
const SILENCE_MS = 2000
const NO_SPEECH_MS = 15000
const VAD_TICK_MS = 250
/** Continuous listening: reopen the mic this long after a reply ends, when no
 *  reply speech is expected (device muted). */
const LISTEN_SETTLE_MS = 3000
/** A sent turn that never reports `running` (dropped, or still walking the
 *  submit pipeline) releases the stop square after this long. */
const PENDING_TURN_EXPIRY_MS = 120_000
/** Spoken commands that park the microphone: a program on a speaker in the
 *  room would otherwise be transcribed and sent as the user's own words. */
const PAUSE_LISTENING = /(?:hold|pause)\s+(?:the\s+)?mic(?:rophone)?\b|\bstop listening\b/i

function armVoiceChat(): void {
  try { window.localStorage.setItem(VOICE_CHAT_STORAGE_KEY, '1') } catch { /* best effort */ }
}

/** ChatGPT-style voice glyph: a small audio waveform, shown while a voice turn is starting. */
function VoiceChatGlyph() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
      <path d="M4.5 10v4M8.5 7.5v9M12.5 5v14M16.5 8.5v7M20.5 10v4" />
    </svg>
  )
}

/** Up arrow for text send: the composer's native send glyph. */
function SendArrowGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" />
    </svg>
  )
}

/** Thick close cross for ending a voice turn, twice the weight of the icon set. */
function CloseGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} fill="none" aria-hidden>
      <path d="M2.5 2.5L13.5 13.5M13.5 2.5L2.5 13.5" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" />
    </svg>
  )
}

/** The dictate microphone with a strike-through: the in-call mute / unmute.
 *  Sized to match the 20px dictate microphone it replaces, so the mute
 *  button does not read as smaller mid-call. */
function MicMutedGlyph() {
  return (
    <span className={css.muteGlyph}>
      <IconMicrophoneOutlineRegular size={20} />
      <svg viewBox="0 0 16 16" width={20} height={20} fill="none" aria-hidden>
        <path d="M2.8 2.4l10.4 11.2" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
      </svg>
    </span>
  )
}

/** Filled rounded stop square: the composer's native stop glyph. */
function StopSquareGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
    </svg>
  )
}

type Phase = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'feedback'
interface ActiveRecording {
  readonly capture: Recording
  readonly abort: AbortController
  readonly span: TokenSpan
  readonly selection: SpeechSelection
  readonly maxDurationSeconds: number
  readonly maxAudioBytes: number
  phase: 'requesting' | 'recording' | 'transcribing'
  timer?: ReturnType<typeof setTimeout> | undefined
  /** Voice-activity bookkeeping kept by the recording-phase effect. */
  vadStart?: number
  vadHeardAt?: number
  vadLastVoice?: number
  /** True when continuous listening opened this turn (no tap behind it). */
  autoOpen?: boolean
}

async function disposeRecording(capture: Recording): Promise<void> {
  try { await capture.dispose() } catch (_error) {
    // Tracks stop before AudioContext.close(); a close failure must not hide the recording result.
  }
}

/**
 * The dsh-voice-output plugin (separate, no shared API) flips the speaker
 * button of the message it is reading to aria-label "Stop speaking" while
 * audio plays. That button is the cross-plugin "the system is speaking"
 * signal, and clicking it stops the audio.
 */
function useSpeakingSignal(): [boolean, () => void] {
  const SELECTOR = 'button[aria-label="Stop speaking"]'
  const [speaking, setSpeaking] = useState(false)
  useEffect(() => {
    const check = (): void => setSpeaking(Boolean(document.querySelector(SELECTOR)))
    check()
    const observer = new MutationObserver(check)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-label'] })
    const interval = window.setInterval(check, 1000)
    return () => { observer.disconnect(); window.clearInterval(interval) }
  }, [])
  const stopSpeaking = useCallback((): void => {
    document.querySelector<HTMLButtonElement>(SELECTOR)?.click()
  }, [])
  return [speaking, stopSpeaking]
}

/** One blue circle: up arrow sends text, stop square halts the turn, cross ends a voice turn. */
export function VoiceInput({ sessionId, inputActions, locked, onActiveChange, useSession,
  createRecording, transcribe, openSettings, useSpeechReadiness, t, stopTurn }: VoiceInputProps) {
  // Turn and draft state read from the session and the composer itself, so
  // the button works on a host that never heard of the slot extension.
  const running = useSession(snapshot => snapshot.running) ?? false
  // Anchor of this row, rendered inside its composer card: it pins the draft
  // watcher to THIS composer even when other composers mount in the document.
  const cardRef = useRef<HTMLElement | null>(null)
  const empty = useComposerEmpty(cardRef)
  const stop: (() => void) | undefined = running ? () => { stopTurn(sessionId) } : undefined
  const readiness = useSpeechReadiness(value => value), catalog = readiness.catalog
  const [speaking, stopSpeaking] = useSpeakingSignal()
  const provider = catalog?.providers.find(item => item.id === catalog.selection.providerId)
  const usable = readiness.connected && (provider?.preparation.phase === 'ready' || provider?.preparation.phase === 'standby'
    || provider?.preparation.phase === 'waking')
  const [phase, setPhase] = useState<Phase>('idle'), [message, setMessage] = useState('')
  const [muted, setMuted] = useState(false), mutedRef = useRef(false)
  const [setupOpen, setSetupOpen] = useState(false)
  useEffect(() => { if (usable) setSetupOpen(false) }, [usable])
  const current = useRef<ActiveRecording>(), generation = useRef(0)
  // Continuous listening: once a voice turn completes, the next reply ending
  // reopens the microphone so the conversation continues without a tap.
  const [armed, setArmed] = useState(false)
  const turnEndedAt = useRef<number>(), sawSpeech = useRef(false), prevRunning = useRef(running)
  // A sent message whose turn the session has not reported as running yet
  // (still in the submit pipeline, or the status event lags): while it is in
  // flight the button keeps the stop square instead of falling back to the
  // dictate/waveform affordance, which read as "voice chat mode is lost".
  const turnInFlight = useRef(false), turnInFlightAt = useRef(0)
  const [, bumpPending] = useState(0)
  // A spoken "hold the mic" parks the loop until a deliberate tap.
  const paused = useRef(false)
  // Focus loss (a notification, screen lock, app switch) pauses a live
  // recording instead of killing it; cleared on every cancel so a stale
  // pause never lingers into the next turn.
  const focusPaused = useRef(false)
  useEffect(() => {
    runningChanged(running)
    if (prevRunning.current && running === false) {
      turnEndedAt.current = Date.now(); sawSpeech.current = false
      turnInFlight.current = false
      // The reset lives in refs, so bump a state: without a re-render the
      // button keeps showing the stop square it computed before the flag
      // cleared (the row then reads "still mid-conversation" forever).
      bumpPending(n => n + 1)
    }
    prevRunning.current = running
  }, [running])
  // A submitted turn that never reports running (dropped, or stuck in the
  // submit pipeline) must not pin the stop square: release it and seed the
  // end mark so an armed microphone can still revive the conversation.
  useEffect(() => {
    const iv = window.setInterval(() => {
      if (turnInFlight.current && running === false && Date.now() - turnInFlightAt.current >= PENDING_TURN_EXPIRY_MS) {
        turnInFlight.current = false
        turnEndedAt.current = Date.now()
        bumpPending(n => n + 1)
      }
    }, 1000)
    return () => window.clearInterval(iv)
  }, [running])
  useEffect(() => {
    if (speaking) { speechStarted(); if (turnEndedAt.current !== undefined) sawSpeech.current = true }
  }, [speaking])
  // Only the feedback row claims the whole toolbar width; a live turn keeps the
  // composer intact and just swaps the button for the cross.
  const expanded = phase === 'feedback'
  useLayoutEffect(() => { onActiveChange(expanded); return () => { onActiveChange(false) } }, [expanded, onActiveChange])

  const cancel = (): void => {
    generation.current++
    focusPaused.current = false
    const active = current.current
    current.current = undefined
    if (active) { clearTimeout(active.timer); active.abort.abort(); void disposeRecording(active.capture) }
    setMessage(''); setPhase('idle'); setSetupOpen(false)
  }
  useEffect(() => {
    setMessage(''); setPhase('idle'); setSetupOpen(false)
    setArmed(false); turnEndedAt.current = undefined; sawSpeech.current = false
    turnInFlight.current = false
    paused.current = false; focusPaused.current = false
    // Focus loss (a notification, screen lock, app switch) pauses a live
    // recording instead of ending it: on a phone the window blurs all the
    // time, and a killed turn flickered the mute button back to the dictate
    // mic and dropped the user's words. Pausing mutes the capture (audio
    // discarded, VAD clocks frozen); focus resumes it where it left off.
    const quit = (): void => { cancel(); turnEndedAt.current = undefined }
    const pauseForFocus = (): void => {
      const active = current.current
      if (!active || active.phase !== 'recording' || focusPaused.current) return
      focusPaused.current = true
      active.capture.setMuted(true)
    }
    const resumeFromFocus = (): void => {
      if (!focusPaused.current) return
      focusPaused.current = false
      const active = current.current
      if (active && active.phase === 'recording') {
        active.capture.setMuted(mutedRef.current)
        active.vadStart = undefined; active.vadHeardAt = undefined; active.vadLastVoice = undefined
      }
    }
    const blur = (): void => { pauseForFocus() }
    const focus = (): void => { resumeFromFocus() }
    const visibility = (): void => {
      if (document.hidden) pauseForFocus()
      else resumeFromFocus()
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && current.current) { event.preventDefault(); quit() }
    }
    window.addEventListener('blur', blur); window.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', visibility)
    document.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('blur', blur); window.removeEventListener('focus', focus)
      document.removeEventListener('visibilitychange', visibility)
      document.removeEventListener('keydown', escape)
      generation.current++
      const active = current.current
      current.current = undefined
      if (active) { clearTimeout(active.timer); active.abort.abort(); void disposeRecording(active.capture) }
    }
  }, [sessionId])

  const feedback = (text: string): void => { setMessage(text); setPhase('feedback') }
  const failureText = (failure: unknown): string => failure instanceof RecordingError ? t(failure.kind)
    : t('failed', { message: failure instanceof Error ? failure.message : String(failure) })
  // In-call mute: the microphone stays open, but its audio is discarded and
  // the voice-activity clocks freeze, so a muted stretch neither reaches the
  // recognizer nor ends the turn early.
  const toggleMute = (): void => {
    const next = !mutedRef.current
    mutedRef.current = next
    setMuted(next)
    const capture = current.current?.capture
    if (capture) capture.setMuted(next)
  }
  /** Mark a just-submitted message as a turn in flight, for the button. */
  const beginTurn = (): void => {
    turnInFlight.current = true
    turnInFlightAt.current = Date.now()
  }
  const finish = async (): Promise<void> => {
    const active = current.current
    if (!active || active.phase !== 'recording') return
    voiceEnded() // the user's words are final: the latency clock starts here
    active.phase = 'transcribing'
    const run = generation.current
    clearTimeout(active.timer); setPhase('transcribing')
    try {
      const audio = await active.capture.stop(active.maxDurationSeconds)
      if (run !== generation.current) return
      if (audio.byteLength > active.maxAudioBytes) { feedback(t('tooLarge')); return }
      const result = await transcribe({ audioBase64: audioBase64(audio), ...active.selection }, active.abort.signal)
      if (run !== generation.current) return
      if (!result.ok) { feedback(t('failed', { message: result.error.message })); return }
      if (result.value.text === '') {
        // Nothing worth sending: settle back to the composer exactly as found,
        // buttons included — a tapped tap that caught no words is no different
        // from an auto-open that drew no air. No feedback row, no dead end.
        cancel()
        return
      }
      if (PAUSE_LISTENING.test(result.value.text)) {
        // The user asked for quiet: nothing is sent, the listening loop parks
        // (no re-offers) until a deliberate tap on the microphone.
        paused.current = true; turnEndedAt.current = undefined
        current.current = undefined; setPhase('idle')
        void disposeRecording(active.capture)
        feedback(t('listeningPaused'))
        return
      }
      inputActions.setDraft(result.value.text); beginTurn(); inputActions.submit(); current.current = undefined; setPhase('idle')
      setArmed(true)
    } catch (failure) {
      if (failure instanceof RecordingError && failure.kind === 'empty' && run === generation.current) {
        // A fully muted (or dead) microphone captured nothing: settle back to
        // the buttons quietly, for a tapped turn as much as an auto-open.
        // cancel() releases the capture.
        cancel()
        return
      }
      await disposeRecording(active.capture)
      if (run === generation.current) feedback(failureText(failure))
    } finally { if (run === generation.current) current.current = undefined }
  }
  const start = async (autoOpen = false): Promise<void> => {
    if (!catalog || !usable || locked || current.current) return
    if (!autoOpen) paused.current = false // a deliberate tap resumes a parked mic
    armVoiceChat()
    const run = ++generation.current
    const active: ActiveRecording = { capture: createRecording(), abort: new AbortController(),
      span: inputActions.captureInsertion(), selection: catalog.selection,
      maxDurationSeconds: catalog.maxDurationSeconds, maxAudioBytes: catalog.maxAudioBytes, phase: 'requesting', autoOpen }
    current.current = active
    setMessage(''); setPhase('requesting')
    try {
      await active.capture.start((failure) => {
        if (run !== generation.current || current.current !== active || active.phase === 'transcribing') return
        current.current = undefined
        clearTimeout(active.timer); active.abort.abort()
        feedback(failureText(failure))
      })
      if (run !== generation.current || current.current !== active) return
      active.capture.setMuted(mutedRef.current) // persistent mute: open in its current state
      active.phase = 'recording'
      setPhase('recording')
      active.timer = setTimeout(() => { void finish() }, active.maxDurationSeconds * 1000)
    } catch (failure) {
      await disposeRecording(active.capture)
      if (run === generation.current) { current.current = undefined; feedback(failureText(failure)) }
    }
  }
  // Voice activity: a couple of seconds of silence after the last word ends
  // the turn and sends it, exactly like tapping the cross; a microphone that
  // never delivers speech gives up instead of recording until the max length.
  useEffect(() => {
    if (phase !== 'recording') return
    const tick = (): void => {
      const active = current.current
      if (!active || active.phase !== 'recording') return
      if (mutedRef.current) return // muted: the silence is deliberate, freeze the clocks
      if (focusPaused.current) return // focus lost: the window is away, freeze the clocks
      const now = Date.now()
      if (active.vadStart === undefined) active.vadStart = now
      if (active.capture.amplitude() >= VOICE_RMS) {
        if (active.vadHeardAt === undefined) active.vadHeardAt = now
        active.vadLastVoice = now
        return
      }
      if (active.vadHeardAt === undefined) {
        if (now - active.vadStart >= NO_SPEECH_MS) {
          // A tapped turn that draws no words gives up with an explanation.
          // An auto-opened one simply keeps listening: speech mode runs
          // until the user says otherwise, and the max-duration timer
          // re-arms it quietly when the buffer has grown too stale.
          if (active.autoOpen) return
          cancel(); feedback(t('interrupted'))
        }
        return
      }
      if (now - (active.vadLastVoice ?? active.vadHeardAt) >= SILENCE_MS) void finish()
    }
    const iv = window.setInterval(tick, VAD_TICK_MS)
    return () => window.clearInterval(iv)
  }, [phase, cancel, feedback, finish, t])
  // Continuous listening: when a reply has ended (thought AND, if spoken,
  // heard), reopen the microphone so the next words need no tap. An
  // auto-open that draws no words is quietly re-offered again, so the
  // conversation stays open until the user says otherwise.
  useEffect(() => {
    if (!armed || !empty || locked || running || speaking || phase !== 'idle') return
    const tick = (): void => {
      // A muted mic stays closed: opening it would only churn, and the tick
      // re-opens it the moment the user unmutes.
      if (paused.current || mutedRef.current || current.current || phase !== 'idle') return
      const ended = turnEndedAt.current
      if (ended === undefined) return
      if (sawSpeech.current || Date.now() - ended >= LISTEN_SETTLE_MS) {
        // The mark is deliberately not consumed: a settled auto-open re-
        // offers the microphone (see the VAD above) until words arrive or
        // the empty listens run out.
        void start(true)
      }
    }
    tick()
    const iv = window.setInterval(tick, 500)
    return () => window.clearInterval(iv)
  }, [armed, empty, locked, running, speaking, phase])
  // A reply that starts speaking after the mic already reopened (slow TTS
  // warm-up) voids the auto-opened turn; it reopens once the speech is done.
  useEffect(() => {
    if (speaking && current.current?.autoOpen) cancel()
  }, [speaking])
  // The mute joins the row for the duration of a voice conversation: it takes
  // the dictate button's place (left of the voice button) and leaves with the
  // conversation, which always returns to the plain dictate + voice row. Its
  // state is persistent: a muted microphone stays muted across turns until
  // toggled back.
  const muteButton = (
    <span className={css.triggerAnchor}><Button type="button" className={`${css.voiceChat} ${muted ? css.micToggleMuted : css.voiceChatOn}`} size="sm"
      aria-label={muted ? t('unmuteMic') : t('muteMic')}
      onMouseDown={(event) => { event.preventDefault() }}
      onClick={toggleMute}><MicMutedGlyph /></Button></span>
  )
  if (phase === 'requesting' || phase === 'recording' || phase === 'transcribing') {
    const label = phase === 'recording' ? t('voiceChat.stop') : phase === 'requesting' ? t('cancel') : t('transcribingShort')
    return (
      <span className={css.voiceChatPair} ref={cardRef}>
        {muteButton}
        <Tooltip label={label} side="top" portal>
          <span className={css.triggerAnchor}><Button type="button" className={`${css.voiceChat} ${css.voiceChatOn}`} size="sm"
            aria-label={label} aria-busy={phase === 'transcribing'} disabled={phase === 'transcribing'}
            onMouseDown={(event) => { event.preventDefault() }}
            onClick={() => { if (phase === 'requesting') cancel(); else if (phase === 'recording') void finish() }}>
            {phase === 'transcribing' ? <StateDot state="ongoing" /> : phase === 'recording' ? <CloseGlyph /> : <VoiceChatGlyph />}</Button></span>
        </Tooltip>
      </span>
    )
  }
  if (phase === 'feedback') return <div className={css.captureRow} data-voice-activity={phase} ref={cardRef}>
    <Button type="button" className={css.roundButton} size="sm" aria-label={t('cancel')}
      onClick={cancel}><IconCloseOutlineRegular size={14} /></Button>
    <span className={css.activityMessage} role="status" title={message}>{message}</span>
    <Button type="button" className={css.roundButton} size="sm" aria-label={t('retryRecording')} disabled={!usable || locked}
      onClick={() => { void start() }}><IconMicrophoneOutlineRegular size={18} /></Button>
    {armed && muteButton}
  </div>
  // Stop square while a turn is in flight — the session reports it running, OR
  // this plugin sent a message that has not reported running yet — or the
  // system speaks (empty draft); typing any text reverts to the send arrow so
  // a reply can be sent either way.
  const pendingTurn = turnInFlight.current && running !== true
  const busyTurn = (running === true && stop !== undefined) || pendingTurn
  const stopMode = !locked && empty === true && (busyTurn || speaking)
  // With an empty draft the button is the voice-chat entry (waveform); typing
  // any text switches it to the send arrow.
  const voiceMode = !stopMode && empty
  const sendDisabled = locked || (running ? empty && stop === undefined : empty)
  const label = stopMode ? (busyTurn ? t('stopGenerating') : t('stopSpeech')) : voiceMode ? t('voiceChat.start') : t('send')
  return <>
    {/* The dictate mic is a pre-voice-conversation affordance. Once speech
        mode is on (armed) it must never appear: the unified button alone
        carries the voice entry (waveform), the stop square, and the send
        arrow, so the button row can't flip back to a dictate mic mid-talk. */}
    {!armed && (
      <Tooltip label={t('dictate')} disabled={!usable} side="top" portal>
        <span className={css.triggerAnchor}><Button className={css.trigger} size="sm" disabled={locked}
          aria-label={t(usable ? 'start' : 'setupPrompt.trigger')} aria-haspopup={usable ? undefined : 'dialog'}
          onMouseDown={(event) => { event.preventDefault() }}
          onClick={() => { if (usable) void start(); else setSetupOpen(true) }}><IconMicrophoneOutlineRegular size={20} /></Button></span>
      </Tooltip>
    )}
    {armed && muteButton}
    <Tooltip label={label} side="top" portal>
      <span className={css.triggerAnchor} ref={cardRef}><Button type="button" data-voice-unified="1" className={`${css.voiceChat} ${css.voiceChatOn}`} size="sm"
        aria-label={label}
        disabled={stopMode ? false : voiceMode ? locked || !usable : sendDisabled}
        onMouseDown={(event) => { event.preventDefault() }}
        onClick={() => {
          if (stopMode) {
            // pendingTurn: the turn is in the pipeline, not the session's
            // `running` flag yet — the stop path still reaches it (native stop
            // button if rendered, else the session-scoped cancel).
            if (busyTurn) { if (running === true) stop?.(); else stopTurn(sessionId) }
            if (speaking) stopSpeaking()
            // Stopping is the "further notice" for speech mode: go back to the
            // default [dictate + waveform] row, and keep continuous listening
            // from reopening the microphone into a mid-conversation cross.
            setArmed(false)
            turnEndedAt.current = undefined
            sawSpeech.current = false
            return
          }
          if (voiceMode) { if (usable) void start(); else setSetupOpen(true); return }
          if (!sendDisabled) { beginTurn(); inputActions.submit() }
        }}>
        {stopMode ? <StopSquareGlyph /> : voiceMode ? <VoiceChatGlyph /> : <SendArrowGlyph />}</Button></span>
    </Tooltip>
    <VoiceSetupDialog open={setupOpen && !usable}
      needsInstallation={readiness.connected && provider?.location === 'host-local' && provider.preparation.phase === 'unprepared'}
      onDismiss={() => { setSetupOpen(false) }} onOpenDetails={() => { setSetupOpen(false); openSettings() }} t={t} />
  </>
}
