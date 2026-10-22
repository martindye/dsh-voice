import { describe, expect, it } from 'vitest'
import { HEADER_SLICE_SECONDS, composeRecording } from './audio.ts'

const slice = (name: string): Blob => new Blob([name], { type: 'audio/webm' })

describe('composeRecording', () => {
  it('passes the tail straight through when no header was captured', () => {
    const tail = [slice('a'), slice('b')]
    expect(composeRecording(undefined, tail)).toEqual({ parts: tail, trimSeconds: 0 })
  })

  it('does not duplicate an unmuted header: it is already the tail head', () => {
    const head = slice('head')
    const tail = [head, slice('b')]
    const { parts, trimSeconds } = composeRecording({ chunk: head, muted: false, pushed: true }, tail)
    expect(parts).toBe(tail)
    expect(trimSeconds).toBe(0)
  })

  it('prepends a muted header so the blob decodes, and trims its audio', () => {
    const head = slice('head')
    const tail = [slice('b')]
    const { parts, trimSeconds } = composeRecording({ chunk: head, muted: true, pushed: false }, tail)
    expect(parts).toEqual([head, ...tail])
    expect(trimSeconds).toBe(HEADER_SLICE_SECONDS)
  })

  it('decodes a fully muted run as just the header slice, all trimmed away', () => {
    const head = slice('head')
    const { parts, trimSeconds } = composeRecording({ chunk: head, muted: true, pushed: false }, [])
    expect(parts).toEqual([head])
    expect(trimSeconds).toBe(HEADER_SLICE_SECONDS)
  })
})
