// thimble browser: links to cards and records become chips, and a reply's marks and v's cards fold onto the text rows
// of the turn they belong to.
import { describe, expect, it } from 'vitest'
import { citeLinks } from '../../src/chat/markdown'
import { foldRecords } from '../../src/chat/model'
import type { ChatRecord } from '../../src/lib/types'

describe('citeLinks', () => {
  it('turns ref links into tokens and keeps web links', () => {
    expect(citeLinks('[11](card:ab12cd34#runs/all failed) of 24, ["it stopped"](runs/a.jsonl#L4) [↗](card:ab12cd34) [docs](https://example.org)')).toBe(
      '[[11|card:ab12cd34#runs/all failed]] of 24, [["it stopped"|runs/a.jsonl#L4]] [[card:ab12cd34]] [docs](https://example.org)',
    )
  })
  it('reads a ref with balanced brackets whole', () => {
    expect(citeLinks('[899](card:ab12cd34#edits/(no name)) had none, [a](https://x.org/A_(b))')).toBe(
      '[[899|card:ab12cd34#edits/(no name)]] had none, [a](https://x.org/A_(b))',
    )
  })
  it('reads %20 as a space', () => {
    expect(citeLinks('[5](card:ab12cd34#failed%20runs/wrong-file)')).toBe('[[5|card:ab12cd34#failed runs/wrong-file]]')
  })
})

describe('marks', () => {
  it('go to the text of their turn they were found in, at their order there, also after the next turn started', () => {
    const item = (piece: number, k: number, words: string, status: 'verified' | 'corrected') => ({ n: piece * 10 + k, piece, k, words, sentence: '', status, shown: words })
    const records: ChatRecord[] = [
      { type: 'user', text: 'why?', turn: 'aaaa0001' },
      { type: 'text', delta: 'Counting [3](#) first.' },
      { type: 'tool_use', id: 't1', name: 'Read', input: {} },
      { type: 'text', delta: 'Most [12](#) of [40](#) are flaky.' },
      { type: 'done' },
      { type: 'user', text: 'and then?', turn: 'aaaa0002' },
      { type: 'marks', turn: 'aaaa0001', items: [item(0, 0, '3', 'verified'), item(1, 0, '12', 'verified'), item(1, 1, '40', 'corrected')] },
      { type: 'card', turn: 'aaaa0001', card: 'c00000001' },
      { type: 'text', delta: 'Then it stopped.' },
    ]
    const texts = foldRecords(records).filter((r) => r.kind === 'text') as { text: string; checks?: { words: string; status: string }[]; turnMarks?: unknown[]; cards?: string[] }[]
    expect(texts[0].checks?.map((m) => m.words)).toEqual(['3'])
    expect(texts[1].checks?.map((m) => [m.words, m.status])).toEqual([['12', 'verified'], ['40', 'corrected']])
    // the reply carries the turn's marks for its footer, and v's cards
    expect(texts[1].turnMarks).toHaveLength(3)
    expect(texts[1].cards).toEqual(['c00000001'])
    expect(texts[2].checks).toBeUndefined()
  })
})
