/** Session header corner: the per-device auto-read toggle.
 *
 * One speaker icon with a state dot: the dot is green while this device is
 * in voice-conversation mode (has used the voice composer), the button is
 * dimmed when auto-read is switched off for this device. The choice is
 * stored per browser and never leaves the device.
 */
import { useEffect, useState } from 'react'
import { unlockPageAudio } from './audio-unlock.ts'
import { deviceOn, setDeviceOn, subscribeTts, ttsStatus, voiceChatMode } from './tts.ts'
import css from './VoiceInput.module.css'

export interface AutoReadToggleProps {
  t?: (key: string) => string
}

export function AutoReadToggle({ t }: AutoReadToggleProps) {
  const label = (key: string, fallback: string): string => (t ? t(key) : fallback)
  const [, force] = useState(0)
  useEffect(() => subscribeTts(() => force((n) => n + 1)), [])

  const on = deviceOn()
  const armed = voiceChatMode()
  const status = ttsStatus()
  const hint = on
    ? label('autovoice.on', 'Auto-read on: fresh replies are read aloud on this device')
    : label('autovoice.off', 'Auto-read off for this device')
  const title = status.known
    ? `${hint} — voice: ${status.server === 'up' ? status.engine : 'starting'}`
    : hint

  return (
    <button
      type="button"
      className={css.headerToggle}
      aria-label={label('autovoice', 'Toggle auto-read')}
      aria-pressed={on}
      title={title}
      onClick={() => { unlockPageAudio(); setDeviceOn(!on) }}
    >
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M11 5 6 9H2v6h4l5 4z" />
        <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      </svg>
      <span
        className={css.toggleDot}
        style={{ background: armed && on ? 'var(--dsw-alias-state-success-primary, #3fb950)' : 'transparent' }}
        aria-hidden
      />
    </button>
  )
}
