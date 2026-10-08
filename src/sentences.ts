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
/**
 * Join sentences into render blocks at a calibrated render speed.
 *
 * The TTS engine renders `speed` times faster than real time, so a clip
 * plays without a gap after it as long as its own render fits inside the
 * PREVIOUS clip's playing time: next.length / speed <= current.length
 * (both are proportional to speech duration). While that does not hold —
 * the next sentence would still be rendering when the current one has
 * finished — the next sentence is folded into the current block and the
 * pair is rendered as one continuous clip. The first sentence that cannot
 * gap starts the next block, and the walk continues from there.
 */
export function sentenceBlocks(sentences: string[], speed: number): string[][] {
  const blocks: string[][] = []
  let i = 0
  while (i < sentences.length) {
    const block: string[] = [sentences[i]]
    let chars = sentences[i].length
    i += 1
    while (i < sentences.length && sentences[i].length > speed * chars) {
      block.push(sentences[i])
      chars += sentences[i].length
      i += 1
    }
    blocks.push(block)
  }
  return blocks
}

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
