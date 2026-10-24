/**
 * The pause that ends a dictated turn.
 *
 * While the microphone is open, the VAD watches the level; once it has heard
 * words, this much trailing silence ends the turn and sends it — the same
 * rule a human would apply to "the user has stopped talking". The device's
 * choice of how long that pause must be, stored per browser; never leaves it.
 *
 * The voice-activity watcher reads it live (once per tick), so the settings
 * card applies from the very next pause, mid-conversation included.
 */

const PAUSE_KEY = 'dsh-voice:dictation-pause'

/** The historical pause (two seconds); the device default since 24/10. */
export const DICTATION_PAUSE_DEFAULT_MS = 4_000
const DICTATION_PAUSE_MIN_MS = 500
const DICTATION_PAUSE_MAX_MS = 10_000

export function dictationPauseMs(): number {
  try {
    const raw = Number(localStorage.getItem(PAUSE_KEY))
    if (Number.isFinite(raw) && raw > 0) {
      return Math.min(DICTATION_PAUSE_MAX_MS, Math.max(DICTATION_PAUSE_MIN_MS, Math.round(raw)))
    }
  } catch { /* best effort */ }
  return DICTATION_PAUSE_DEFAULT_MS
}

export function setDictationPauseMs(ms: number): void {
  try { localStorage.setItem(PAUSE_KEY, String(Math.round(ms))) } catch { /* best effort */ }
}
