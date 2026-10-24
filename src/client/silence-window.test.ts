// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { FRESHNESS_DEFAULT_MS, autoReadFreshnessMs, setAutoReadFreshnessMs } from './tts.ts'
import { DICTATION_PAUSE_DEFAULT_MS, dictationPauseMs, setDictationPauseMs } from './silence-window.ts'

beforeEach(() => {
  localStorage.clear()
})

describe('the pause that ends dictation (device setting)', () => {
  it('defaults to the 4-second pause', () => {
    expect(dictationPauseMs()).toBe(DICTATION_PAUSE_DEFAULT_MS)
    expect(dictationPauseMs()).toBe(4000)
  })

  it('keeps the choice per browser', () => {
    setDictationPauseMs(5000)
    expect(dictationPauseMs()).toBe(5000)
    setDictationPauseMs(1500)
    expect(dictationPauseMs()).toBe(1500)
  })

  it('keeps a broken or out-of-range stored value in bounds', () => {
    localStorage.setItem('dsh-voice:dictation-pause', 'garbage')
    expect(dictationPauseMs()).toBe(DICTATION_PAUSE_DEFAULT_MS)
    localStorage.setItem('dsh-voice:dictation-pause', '10')
    expect(dictationPauseMs()).toBe(500) // clamped up to the shortest usable pause
    localStorage.setItem('dsh-voice:dictation-pause', '999999')
    expect(dictationPauseMs()).toBe(10_000) // clamped down to the longest offered pause
  })
})

describe('the auto-read freshness cutoff (device setting)', () => {
  it('defaults to the historical two-minute window', () => {
    expect(autoReadFreshnessMs()).toBe(FRESHNESS_DEFAULT_MS)
    expect(autoReadFreshnessMs()).toBe(120_000)
  })

  it('keeps the choice per browser', () => {
    setAutoReadFreshnessMs(300_000)
    expect(autoReadFreshnessMs()).toBe(300_000)
    setAutoReadFreshnessMs(30_000)
    expect(autoReadFreshnessMs()).toBe(30_000)
  })

  it('keeps a broken or out-of-range stored value in bounds', () => {
    localStorage.setItem('dsh-voice-output:read-freshness', 'garbage')
    expect(autoReadFreshnessMs()).toBe(FRESHNESS_DEFAULT_MS)
    localStorage.setItem('dsh-voice-output:read-freshness', '500')
    expect(autoReadFreshnessMs()).toBe(30_000) // clamped up to the shortest offered window
    localStorage.setItem('dsh-voice-output:read-freshness', '999999')
    expect(autoReadFreshnessMs()).toBe(600_000) // clamped down to the longest offered window
  })
})
