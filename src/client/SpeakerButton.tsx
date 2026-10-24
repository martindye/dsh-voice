/** Per-message speaker button: speak/stop one finalized assistant reply.
 *
 * Rendered by the app's conversation.chat.assistant-actions slot, one
 * instance per finalized assistant message. The first render of a message
 * also claims the auto-read: fresh replies are spoken on this device when
 * the device toggle is on and the device has used the voice composer
 * (dsh.voice-chat.v1); the host declines stale replies.
 */
import { useEffect, useRef, useState } from 'react'
import { unlockPageAudio } from './audio-unlock.ts'
import { isSpeakerTab } from './speaker-tab.ts'
import {
  autoReadScope, currentError, deviceOn, isPlaying, markMessageHandled, messageHandled,
  speak, stopPlayback, subscribeTts, voiceChatMode,
} from './tts.ts'
import css from './VoiceInput.module.css'

export interface SpeakerButtonProps {
  messageId?: string
  sessionId?: string
  t?: (key: string) => string
}

function speakerIcon(playing: boolean) {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 5 6 9H2v6h4l5 4z" />
      {playing
        ? (
          <>
            <path d="M15.5 8.5a5 5 0 0 1 0 7" />
            <path d="M18.4 5.6a9 9 0 0 1 0 12.8" />
          </>
        )
          : null}
    </svg>
  )
}

export function SpeakerButton({ messageId, sessionId, t }: SpeakerButtonProps) {
  const label = (key: string, fallback: string): string => (t ? t(key) : fallback)
  const [, force] = useState(0)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  useEffect(() => subscribeTts(() => force((n) => n + 1)), [])

  // Auto-read: once per message, only for fresh replies while this device
  // has the toggle on and has used the voice composer (the arm flag).
  // Across tabs of the same browser, only the elected speaker tab speaks
  // (a reboot restores every tab, so two of them would otherwise both
  // read the same reply); the manual button below is never gated.
  useEffect(() => {
    if (!messageId || !sessionId) return
    if (messageHandled(messageId)) return
    markMessageHandled(messageId)
    if (!deviceOn() || !voiceChatMode()) return
    if (!isSpeakerTab()) return
    void speak(sessionId, messageId, { auto: true, scope: autoReadScope() })
  }, [messageId, sessionId])

  const playing = isPlaying()
  const error = currentError()
  const onToggle = () => {
    if (!messageId || !sessionId) return
    if (busyRef.current) return
    if (playing) { stopPlayback(); return }
    // The unlock must run inside the tap gesture (iOS).
    unlockPageAudio()
    busyRef.current = true
    setBusy(true)
    void speak(sessionId, messageId, { auto: false, scope: autoReadScope() }).finally(() => {
      busyRef.current = false
      setBusy(false)
    })
  }
  const title = playing
    ? label('speakStop', 'Stop speaking')
    : busy
      ? label('speakPreparing', 'Preparing speech…')
      : error
        ? `${label('speak', 'Speak this message')} — ${error}`
        : label('speak', 'Speak this message')

  return (
    <span>
      <button
        type="button"
        className={`${css.speakButton} ${busy && !playing ? css.speakBusy : ''}`}
        aria-label={playing ? label('speakStop', 'Stop speaking') : label('speak', 'Speak this message')}
        aria-pressed={playing || undefined}
        title={title}
        onClick={onToggle}
      >
        {speakerIcon(playing)}
      </button>
      {error && !playing
        ? (
          <span className={css.speakError} aria-hidden title={error}>
            {error}
          </span>
        )
          : null}
    </span>
  )
}
