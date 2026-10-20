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
  it('reads a ref with balanced brackets whole', () => {
    expect(citeLinks('[899](card:ab12cd34#edits/(no name)) had none, [a](https://x.org/A_(b))')).toBe(
      '[[899|card:ab12cd34#edits/(no name)]] had none, [a](https://x.org/A_(b))',
    )
  })
  it('reads %20 as a space', () => {
    expect(citeLinks('[5](card:ab12cd34#failed%20runs/wrong-file)')).toBe('[[5|card:ab12cd34#failed runs/wrong-file]]')
  })
})

describe('lens marks', () => {
  it('go to the first text row of the turn that holds the term, an earlier explainers record among them', () => {
    const records: ChatRecord[] = [
      { type: 'user', text: 'why?' },
      { type: 'text', delta: 'Counting first.' },
      { type: 'tool_use', id: 't1', name: 'Read', input: {} },
      { type: 'text', delta: 'Most are a flaky-test.' },
      { type: 'done' },
      { type: 'glosses', glosses: [{ term: 'flaky-test', body: 'A test that fails at random.' }] },
      { type: 'marks', marks: [{ id: 'm1', lens: 'details', term: 'Counting first', body: 'It counted one file.' }] },
    ]
    const rows = foldRecords(records)
    const texts = rows.filter((r) => r.kind === 'text') as { text: string; marks?: { term: string; lens: string }[] }[]
    expect(texts[0].marks?.map((m) => [m.lens, m.term])).toEqual([['details', 'Counting first']])
    expect(texts[1].marks?.map((m) => [m.lens, m.term])).toEqual([['explain', 'flaky-test']])
  })
})
