/**
 * Flagging dictated (voice-transcribed) messages for the AI.
 *
 * The composer has no metadata channel — a sent message is exactly the draft
 * text — so the flag travels inside the transcript text itself. Two delivery
 * styles, chosen in the plugin settings card:
 *
 * - `marker`:  a short self-contained tag in front of the words, so any model
 *              reading the message — with no prior notes or skills — knows it
 *              is a speech transcript and should read intent over wording.
 * - `sidecar`: the message starts clean with the user's words; the note is
 *              attached after them, set apart, like a side note on the page.
 *
 * Typed messages are never touched: only the voice path (the transcript
 * submitted straight from the recognizer) passes through here.
 */

export type DictationFlagMode = 'off' | 'marker' | 'sidecar'

/**
 * Preset markers, each one self-contained: an AI seeing the line with no
 * context at all should understand the text after it is a voice transcript
 * and may carry transcription errors.
 */
export const MARKER_PRESETS = [
  '[Spoken — transcribed from voice; may contain mishearings and missing punctuation; read by intent]',
  '[Dictated — speech-to-text transcript; interpret intent over wording; homophones and word slips possible]',
  '[voice input: transcribed from dictation, expect mishearings and typos]',
] as const

/** The fixed note the sidecar style attaches after the user's words. */
export const SIDECAR_NOTE =
  '(Dictated: this message was spoken and transcribed from speech; expect homophones, word slips and missing punctuation — read it by intent.)'

const MODE_KEY = 'dsh-voice:dictation-flag-mode'
const MARKER_KEY = 'dsh-voice:dictation-flag-marker'

/** Pure transform: prepend (marker) or append (sidecar) the flag. */
export function flagTranscript(text: string, mode: DictationFlagMode, marker: string): string {
  if (text === '' || mode === 'off') return text
  if (mode === 'marker') return `${marker}\n\n${text}`
  return `${text}\n\n${SIDECAR_NOTE}`
}

/* ------------------------------------------------------- persisted choice */

export function dictationFlagMode(): DictationFlagMode {
  try {
    const raw = localStorage.getItem(MODE_KEY)
    return raw === 'marker' || raw === 'sidecar' ? raw : 'off'
  } catch { return 'off' }
}

export function setDictationFlagMode(mode: DictationFlagMode): void {
  try { localStorage.setItem(MODE_KEY, mode) } catch { /* best effort */ }
}

/** The chosen marker text (the selected preset, else the default). */
export function dictationMarker(): string {
  try {
    const raw = localStorage.getItem(MARKER_KEY)
    if (raw !== null && (MARKER_PRESETS as readonly string[]).includes(raw)) return raw
  } catch { /* best effort */ }
  return MARKER_PRESETS[0]
}

export function setDictationMarker(marker: string): void {
  try { localStorage.setItem(MARKER_KEY, marker) } catch { /* best effort */ }
}

/** Convenience for the send path: the persisted style applied to a transcript. */
export function applyDictationFlag(text: string): string {
  return flagTranscript(text, dictationFlagMode(), dictationMarker())
}
