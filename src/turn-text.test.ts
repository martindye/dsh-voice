import { describe, expect, it } from 'vitest'
import { budgetTurnText } from './turn-text.ts'

describe('budgetTurnText', () => {
  it('joins everything when it fits', () => {
    expect(budgetTurnText(['step one', 'final answer'], 100)).toBe('step one\nfinal answer')
  })

  it('keeps the final answer whole and admits the newest step first', () => {
    const out = budgetTurnText(['oldest step', 'newer step', 'final answer'], 24)
    expect(out.endsWith('\nfinal answer')).toBe(true)
    expect(out).toContain('newer step')
    expect(out).not.toContain('oldest step')
  })

  it('never exceeds the cap', () => {
    const parts = Array.from({ length: 12 }, (_, i) => `step ${i} with a fair amount of text to budget`)
    for (const cap of [30, 100, 250, 4000]) {
      expect(budgetTurnText(parts, cap).length).toBeLessThanOrEqual(cap)
    }
  })

  it('cuts the final answer itself when it alone exceeds the cap', () => {
    const out = budgetTurnText(['final answer that is very long indeed'], 10)
    expect(out.length).toBeLessThanOrEqual(10)
    expect(out.startsWith('final a')).toBe(true)
  })

  it('cuts a too-long step at a sentence or word boundary', () => {
    const step = 'Now rebuild the client so the new spacing is served. Then verify it.'
    const out = budgetTurnText([step, 'ok'], 30)
    expect(out.endsWith('ok')).toBe(true)
    expect(out).toContain('Now rebuild the client')
    expect(out.length).toBeLessThanOrEqual(30)
  })

  it('handles a single part', () => {
    expect(budgetTurnText(['only one'], 100)).toBe('only one')
    expect(budgetTurnText(['only one part here'], 5)).toBe('only')
  })
})
