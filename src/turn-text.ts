/**
 * Budget a turn's step texts for speech.
 *
 * The final answer always keeps priority: if it alone exceeds the cap it is
 * cut on its own; otherwise the earlier steps are admitted newest-first until
 * the budget is spent, and the first step that no longer fits is cut at a
 * sentence or word boundary. The oldest steps are the first to go.
 *
 * Pure on purpose: the host (plan/synthesize) and the tests share it.
 */
export function budgetTurnText(parts: readonly string[], cap: number): string {
  const total = parts.reduce((n, p) => n + p.length, 0) + Math.max(0, parts.length - 1)
  if (total <= cap) return parts.join('\n')
  const last = parts[parts.length - 1] ?? ''
  const rest = parts.slice(0, -1)
  if (last.length > cap) return cutAtBoundary(last, cap)
  let used = last.length + 1
  const picked: string[] = []
  for (let i = rest.length - 1; i >= 0; i--) {
    const room = cap - used
    if (room <= 1) break
    const part = rest[i]
    if (part.length + 1 <= room) { picked.unshift(part); used += part.length + 1; continue }
    const cut = cutAtBoundary(part, room - 1)
    if (cut) picked.unshift(cut)
    break
  }
  return picked.length > 0 ? `${picked.join('\n')}\n${last}` : last
}

/** Cut to at most max characters, preferring a sentence or word boundary. */
function cutAtBoundary(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  for (const mark of ['. ', '! ', '? ']) {
    const at = cut.lastIndexOf(mark)
    if (at > max / 2) return cut.slice(0, at + 1)
  }
  const space = cut.lastIndexOf(' ')
  if (space > max / 2) return cut.slice(0, space)
  return cut
}
