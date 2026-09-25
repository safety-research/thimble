// History's Compare (src/report/diffModel.ts): two drafts as blocks, aligned, a changed block's sentences and words
// marked, citations kept whole. Invented data.
import { describe, expect, test } from 'vitest'
import type { WriteupSection } from '../../src/lib/types.ts'
import { diffDocs, diffLine, docBlocks, foldSame, likeness, plainInline, sentenceDiff, splitRefs, tokens, wordDiff, type DiffBlock } from '../../src/report/diffModel.ts'

let k = 0
const s = (text: string, bullet?: '-' | '1.') => ({ id: `s${k++}`, text, refs: [], tags: [], bullet })
const sec = (heading: string, paras: string[][], extra: Partial<WriteupSection> = {}): WriteupSection => ({
  id: `sec${k++}`,
  heading,
  paragraphs: paras.map((p) => ({ id: `p${k++}`, sentences: p.map((t) => s(t)) })),
  figures: [],
  ...extra,
})

describe('plainInline and tokens', () => {
  test('inline markdown reads as its text; citations stay whole', () => {
    expect(plainInline('A **bold** and *em* `code` [link](https://x.y) with [[27|card:c1]].')).toBe('A bold and em code link with [[27|card:c1]].')
    expect(tokens('All [[27|card:c1]] deletions.')).toEqual(['All', ' ', '[[27|card:c1]]', ' ', 'deletions.'])
  })
  test('splitRefs reads a valued citation and a bare one', () => {
    expect(splitRefs('All [[27|card:c1]] of them [[card:c2]].')).toEqual([
      { text: 'All ' },
      { ref: 'card:c1', value: '27' },
      { text: ' of them ' },
      { ref: 'card:c2', value: null },
      { text: '.' },
    ])
    expect(splitRefs('none')).toEqual([{ text: 'none' }])
  })
})

describe('docBlocks', () => {
  test('the title, headings, paragraphs, list items and figures in reading order', () => {
    const list = { id: 'pl', sentences: [s('One.', '-'), s('Two.', '-')] }
    const blocks = docBlocks({
      title: 'T',
      sections: [
        { id: 'a', heading: 'A', paragraphs: [{ id: 'p1', sentences: [s('First.'), s('Second.')] }, list], figures: [{ id: 'f', cell: 'card:c', caption: 'Per account', after_paragraph: 'p1' }] },
        { id: 'b', heading: 'Sub', level: 3, paragraphs: [], figures: [] },
      ],
    })
    expect(blocks.map((b) => [b.kind, b.sentences.join(' ')])).toEqual([
      ['title', 'T'],
      ['heading', 'A'],
      ['para', 'First. Second.'],
      ['figure', 'Per account'],
      ['item', 'One.'],
      ['item', 'Two.'],
      ['subheading', 'Sub'],
    ])
  })
})

describe('wordDiff and sentenceDiff', () => {
  test('a changed word is deleted then inserted, the rest kept', () => {
    expect(wordDiff('One account did it.', 'Two accounts did it.')).toEqual([
      { op: 'del', text: 'One account' },
      { op: 'ins', text: 'Two accounts' },
      { op: 'eq', text: ' did it.' },
    ])
  })
  test('a changed citation is a change of its own token', () => {
    expect(wordDiff('All [[27|card:a]] deletions.', 'All [[29|card:a]] deletions.')).toEqual([
      { op: 'eq', text: 'All ' },
      { op: 'del', text: '[[27|card:a]]' },
      { op: 'ins', text: '[[29|card:a]]' },
      { op: 'eq', text: ' deletions.' },
    ])
  })
  test('a citation moved to another record with the same value is no change; a changed value is', () => {
    expect(wordDiff('All [[27|card:a]] deletions.', 'All [[27|card:b]] deletions.')).toEqual([{ op: 'eq', text: 'All [[27|card:b]] deletions.' }])
    const d = diffDocs({ sections: [sec('', [['All [[27|card:a]] deletions.']])] }, { sections: [sec('', [['All [[27|card:b]] deletions.']])] })
    expect(d.blocks.map((b) => b.op)).toEqual(['same'])
  })
  test('kept sentences stay whole, a new one is inserted, an unlike one replaced whole', () => {
    const parts = sentenceDiff(['Kept.', 'Old claim about bob.', 'Gone entirely here.'], ['Kept.', 'Old claim about alice.', 'Brand new.'])
    expect(parts).toEqual([
      { op: 'eq', text: 'Kept. Old claim about ' },
      { op: 'del', text: 'bob.' },
      { op: 'ins', text: 'alice.' },
      { op: 'eq', text: ' ' },
      { op: 'del', text: 'Gone entirely here.' },
      { op: 'eq', text: ' ' },
      { op: 'ins', text: 'Brand new.' },
    ])
  })
  test('likeness is the share of words in common', () => {
    expect(likeness('a b c d', 'a b c d')).toBe(1)
    expect(likeness('a b', 'c d')).toBe(0)
  })
})

describe('diffDocs', () => {
  const older = { title: 'One account', sections: [sec('Findings', [['Alice deleted 27.', 'Bob none.'], ['A paragraph that stays.']]), sec('Caveats', [['One week only.']])] }
  const newer = {
    title: 'One account',
    sections: [sec('Findings', [['Alice deleted 29.', 'Bob none.'], ['A paragraph that stays.'], ['A new paragraph.']])],
  }
  const d = diffDocs(older, newer)
  const view = (b: DiffBlock) => [b.op, b.kind, b.parts.map((p) => (p.op === 'eq' ? p.text : `${p.op === 'ins' ? '+' : '-'}{${p.text}}`)).join('')]

  test('blocks kept, changed, added and removed, in reading order, what was removed before what took its place', () => {
    expect(d.blocks.map(view)).toEqual([
      ['same', 'title', 'One account'],
      ['same', 'heading', 'Findings'],
      ['mod', 'para', 'Alice deleted -{27.}+{29.} Bob none.'],
      ['same', 'para', 'A paragraph that stays.'],
      ['del', 'heading', '-{Caveats}'],
      ['del', 'para', '-{One week only.}'],
      ['ins', 'para', '+{A new paragraph.}'],
    ])
    expect([d.added, d.removed, d.changed]).toEqual([1, 2, 1])
    expect(diffLine(d)).toBe('1 added · 2 removed · 1 changed')
  })
  test('the same draft has no changes', () => {
    const same = diffDocs(older, older)
    expect(same.blocks.every((b) => b.op === 'same')).toBe(true)
    expect(diffLine(same)).toBe('No changes')
  })
  test('a heading is never paired with a paragraph', () => {
    const x = diffDocs({ sections: [sec('Alpha beta', [])] }, { sections: [sec('', [['Alpha beta']])] })
    expect(x.blocks.map((b) => b.op)).toEqual(['del', 'ins'])
  })
})

describe('foldSame', () => {
  const b = (op: DiffBlock['op'], t: string): DiffBlock => ({ op, kind: 'para', parts: [{ op: op === 'same' ? 'eq' : 'ins', text: t }] })
  test('a long run of unchanged blocks folds but for one beside each change', () => {
    const items = foldSame([b('same', '1'), b('same', '2'), b('same', '3'), b('same', '4'), b('ins', 'x'), b('same', '5'), b('same', '6'), b('same', '7'), b('same', '8'), b('same', '9'), b('mod', 'y'), b('same', 'z')])
    const shape = items.map((it) => ('fold' in it ? `fold:${it.fold.length}` : it.blocks.map((x) => x.parts[0].text).join('')))
    expect(shape).toEqual(['fold:3', '4x5', 'fold:3', '9yz'])
  })
  test('a diff with no change folds nothing', () => {
    const items = foldSame([b('same', '1'), b('same', '2'), b('same', '3'), b('same', '4')])
    expect(items).toHaveLength(1)
    expect(foldSame([])).toEqual([])
  })
})
