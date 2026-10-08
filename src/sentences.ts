/**
 * Split prepared reply text into sentences for pipelined TTS.
 *
 * The input is already speech-prepared (markdown stripped, whitespace
 * collapsed). A terminal mark followed by whitespace ends a sentence; an
 * ellipsis is a pause, not a break, so it becomes a comma first. Fragments
 * of 3 characters or fewer ("No.", "I.") are folded into the preceding
 * sentence so the voice never receives a one-word chop, and the TTS server
 * does not render a sub-second fragment.
 *
 * Pure on purpose: the host (plan) and the tests share it.
 */
export function splitSentences(text: string): string[] {
  const normalized = (text ?? '')
    .replace(/\.{3,}/g, ',')
    .replace(/…/g, ',')
    .trim()
  if (!normalized) return []
  const parts = normalized
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
  const out: string[] = []
  for (const part of parts) {
    if (out.length > 0 && part.length <= 3) {
      out[out.length - 1] = `${out[out.length - 1]} ${part}`
    } else {
      out.push(part)
    }
  }
  return out
}
