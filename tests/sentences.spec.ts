import { describe, expect, it } from 'vitest'
import { splitSentences } from '../src/sentences.ts'

describe('splitSentences', () => {
  it('splits on terminal marks followed by whitespace', () => {
    expect(splitSentences('One two. Three four? Five six!')).toEqual([
      'One two.',
      'Three four?',
      'Five six!',
    ])
  })

  it('keeps a single unmarked stretch as one sentence', () => {
    expect(splitSentences('No full stops at all in here')).toEqual(['No full stops at all in here'])
  })

  it('never breaks decimals or inline dots without a following space', () => {
    expect(splitSentences('That took 3.5 seconds and 1.5 GB of RAM. Done.')).toEqual([
      'That took 3.5 seconds and 1.5 GB of RAM.',
      'Done.',
    ])
  })

  it('treats an ellipsis as a pause, not a sentence break', () => {
    expect(splitSentences('Wait... really? No.')).toEqual(['Wait, really? No.'])
    expect(splitSentences('Wait… really?')).toEqual(['Wait, really?'])
  })

  it('folds tiny fragments into the preceding sentence', () => {
    expect(splitSentences('Done. No. Not at all.')).toEqual(['Done. No.', 'Not at all.'])
  })

  it('leaves a tiny opener standing when there is nothing before it', () => {
    expect(splitSentences('No. Not really.')).toEqual(['No.', 'Not really.'])
  })

  it('returns nothing for empty or blank input', () => {
    expect(splitSentences('')).toEqual([])
    expect(splitSentences('   ')).toEqual([])
  })
})
