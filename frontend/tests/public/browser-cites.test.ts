// thimble browser: citations written as Markdown links (the terminal plugin's form) become chips, and explain marks
// fold onto the reply row whose words they mark.
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
  it('reads %20 as a space', () => {
    expect(citeLinks('[5](card:ab12cd34#failed%20runs/wrong-file)')).toBe('[[5|card:ab12cd34#failed runs/wrong-file]]')
  })
})

describe('explain marks', () => {
  it('go to the first text row of the turn that holds the term', () => {
    const records: ChatRecord[] = [
      { type: 'user', text: 'why?' },
      { type: 'text', delta: 'Counting first.' },
      { type: 'tool_use', id: 't1', name: 'Read', input: {} },
      { type: 'text', delta: 'Most are a flaky-test.' },
      { type: 'done' },
      { type: 'glosses', glosses: [{ term: 'flaky-test', body: 'A test that fails at random.' }] },
    ]
    const rows = foldRecords(records)
    const texts = rows.filter((r) => r.kind === 'text') as { text: string; glosses?: { term: string }[] }[]
    expect(texts[0].glosses).toBeUndefined()
    expect(texts[1].glosses?.map((g) => g.term)).toEqual(['flaky-test'])
  })
})
