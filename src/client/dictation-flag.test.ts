import { describe, expect, it } from 'vitest'
import { MARKER_PRESETS, SIDECAR_NOTE, flagTranscript } from './dictation-flag.ts'

const words = 'fix the dial please'

describe('flagTranscript', () => {
  it('leaves the transcript untouched when the flag is off', () => {
    expect(flagTranscript(words, 'off', MARKER_PRESETS[0])).toBe(words)
  })

  it('puts the chosen marker on its own line in front of the words', () => {
    const marker = MARKER_PRESETS[1]
    expect(flagTranscript(words, 'marker', marker)).toBe(`${marker}\n\n${words}`)
  })

  it('keeps the words first and attaches the sidecar note after them', () => {
    expect(flagTranscript(words, 'sidecar', MARKER_PRESETS[0])).toBe(`${words}\n\n${SIDECAR_NOTE}`)
  })

  it('never touches an empty transcript, in any mode', () => {
    expect(flagTranscript('', 'off', MARKER_PRESETS[0])).toBe('')
    expect(flagTranscript('', 'marker', MARKER_PRESETS[0])).toBe('')
    expect(flagTranscript('', 'sidecar', MARKER_PRESETS[0])).toBe('')
  })

  it('ships self-contained markers: each starts as a bracketed note and explains the transcript', () => {
    for (const preset of MARKER_PRESETS) {
      expect(preset.startsWith('[')).toBe(true)
      expect(preset.length).toBeGreaterThan(20)
      expect(preset.toLowerCase()).toMatch(/transcri|dictat|spoken|voice/)
      expect(preset.toLowerCase()).toMatch(/intent|expect|interpret|mishear|slip/)
    }
  })
})
