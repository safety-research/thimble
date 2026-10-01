// The labels a view's page hears in thimble.onLabels `all` (src/files/labels.ts pageLabelList): every label over files,
// those that mark records in the view's files first with `here`, so the page can list them apart from the others.
import { describe, expect, test } from 'vitest'
import { pageLabelList, viewLabels } from '../../src/files/labels.ts'
import type { Concept } from '../../src/lib/types.ts'

const label = (id: string, name: string) =>
  ({ id, name, description: '', unit: 'record', kind: 'regex', spec: name, labels: [name, 'other'], created_by: 'analyst', ts: '', shown: false, classes: [{ name, color: 2, highlight: true }, { name: 'other', color: 0, highlight: false }] }) as unknown as Concept

const elsewhere = label('k1', 'elsewhere')
const asks = label('k2', 'asks')
const presence = new Map([
  [elsewhere.id, { 'runs/other.jsonl': { elsewhere: 3 } }],
  [asks.id, { 'board/posts.jsonl': { asks: 2 } }],
])

describe("a view's page hears which labels mark its files", () => {
  test('the labels over its files come first with here, the others after without it', () => {
    const first = viewLabels([elsewhere, asks], presence, ['board/*.jsonl'])
    const all = pageLabelList([elsewhere, asks], (t) => t, first)
    expect(all.map((l) => [l.name, l.here])).toEqual([
      ['asks', true],
      ['elsewhere', false],
    ])
  })

  test('when no label marks its files, none has here', () => {
    const first = viewLabels([elsewhere, asks], presence, ['replays/*.png'])
    expect(pageLabelList([elsewhere, asks], (t) => t, first).some((l) => l.here)).toBe(false)
  })
})
