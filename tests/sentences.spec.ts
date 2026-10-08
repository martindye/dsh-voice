import { describe, expect, it } from 'vitest'
import { sentenceBlocks, splitSentences } from '../src/sentences.ts'

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

describe('sentenceBlocks', () => {
  const SPEED = 2.5

  it('leaves the next sentence out of the block when it renders in time', () => {
    // 24 chars plays for 24 units; the 16-char follow-on renders in
    // 16/2.5 = 6.4 of those — no gap possible, so it starts a fresh block.
    const sentences = ['One two three four five.', 'Six seven eight.']
    expect(sentenceBlocks(sentences, SPEED)).toEqual([
      ['One two three four five.'],
      ['Six seven eight.'],
    ])
  })

  it('folds in a next sentence that would still render after the clip ends', () => {
    // 'A.' plays 2 units; the 40-char follow-on renders in 40/2.5 = 16 —
    // long after 'A.' has finished, so the two become one continuous clip.
    const sentences = ['A.', 'A considerably longer sentence follows.']
    expect(sentenceBlocks(sentences, SPEED)).toEqual([
      ['A.', 'A considerably longer sentence follows.'],
    ])
  })

  it('folds the whole increasing run, then starts fresh at the first safe sentence', () => {
    // lengths 2, 13, 64, 5 at speed 2.5: 13 > 2.5*2 -> fold (15 chars);
    // 64 > 2.5*15 -> fold (79 chars); 5 is not > 197.5 -> the run ends and
    // the short sentence opens its own block.
    const sentences = ['A.', 'Short enough.', 'And then a considerably longer sentence follows here.', 'Done.']
    expect(sentenceBlocks(sentences, SPEED)).toEqual([
      ['A.', 'Short enough.', 'And then a considerably longer sentence follows here.'],
      ['Done.'],
    ])
  })

  it('keeps equal-sized sentences separate', () => {
    const sentences = ['Same length one.', 'Same length two.']
    expect(sentenceBlocks(sentences, SPEED)).toEqual([
      ['Same length one.'],
      ['Same length two.'],
    ])
  })
})
