// The labels that are on, in the order they were turned on (src/files/labels.ts): each one's column in a record's
// gutter and the mark over it, the focused label whose texts the reader fills while the others' are underlined, and
// the cells a record's gutter draws. Invented labels.
import { describe, expect, test } from 'vitest'
import { cellFill, focusOf, laneCells, laneTags, MULTI_COLOUR, recordMarks, turnedOnOrder } from '../../src/files/labels.ts'
import type { Concept, LabelRow } from '../../src/lib/types.ts'

const C = (name: string, color: number, highlight = color > 0) => ({ name, color, highlight })
const label = (id: string, name: string, classes: ReturnType<typeof C>[], marks: 'record' | 'span' | 'file' = 'record'): Concept =>
  ({ id, name, description: '', unit: marks === 'file' ? 'agent' : 'record', marks, kind: 'code', spec: '', labels: classes.map((c) => c.name), classes, created_by: 'user', ts: '', shown: true }) as Concept
const save = label('k1', 'kind of save', [C('question post', 2), C('notice page', 3), C('moderator edit', 4), C('other', 0)])
const time = label('k2', 'time reference', [C('task clock', 1), C('container UTC', 3), C('none', 0)], 'span')
const round = label('k3', 'names a round', [C('names a round', 4), C('no match', 0)], 'span')
const repo = label('k4', 'repo kind', [C('fork', 5), C('mirror', 6), C('other', 0)], 'file')
const row = (value: string, spans?: string[]): LabelRow => ({ ref: 'r.jsonl#L1', label: value, confidence: null, source: null, spans })

describe('the order of the labels that are on', () => {
  test('a label turned on joins the end; one turned off leaves, and the ones after it move up a place', () => {
    const ids = (on: Concept[], order: string[]) => turnedOnOrder(on, order).map((k) => k.id)
    expect(ids([save, time], [])).toEqual(['k1', 'k2'])
    expect(ids([save, time, round], ['k2', 'k1'])).toEqual(['k2', 'k1', 'k3'])
    expect(ids([save, round], ['k2', 'k1', 'k3'])).toEqual(['k1', 'k3'])
    // off and on again: the order kept while it was off no longer holds it, so it comes back at the end
    expect(ids([save, time, round], ids([save, round], ['k1', 'k2', 'k3']))).toEqual(['k1', 'k3', 'k2'])
    expect(laneTags(turnedOnOrder([save, round], ['k2', 'k1', 'k3'])).map((t) => t.name)).toEqual(['kind of save', 'names a round'])
  })

  test('the marks over their columns: a single-class label in its colour with no number, a multi-class one in the plain ink, numbered among them', () => {
    expect(laneTags([time, round, save])).toEqual([
      { id: 'k2', name: 'time reference', colour: MULTI_COLOUR, multi: true, n: 1 },
      { id: 'k3', name: 'names a round', colour: 'var(--label-4)', multi: false, n: 0 },
      { id: 'k1', name: 'kind of save', colour: MULTI_COLOUR, multi: true, n: 2 },
    ])
  })

  test('the focused label is the one last focused while it is on, else the one turned on last', () => {
    expect(focusOf([save, time, round], 'k2')).toBe('k2')
    expect(focusOf([save, round], 'k2')).toBe('k3')
    expect(focusOf([save, round], null)).toBe('k3')
    expect(focusOf([], 'k2')).toBe(null)
  })
})

describe("a record's gutter", () => {
  const rows = new Map<string, LabelRow>([
    ['k1', row('notice page')],
    ['k2', row('none')],
    ['k3', row('names a round', ['round 3'])],
  ])
  test("a cell per label that is on, in its order: the record's class when highlighted, empty otherwise, a file label's from the file", () => {
    const cells = laneCells([save, time, round, repo], (id) => rows.get(id), (id) => (id === 'k4' ? { fork: 3, other: 9 } : undefined))
    expect(cells.map((c) => [c.name, c.values])).toEqual([
      ['kind of save', [{ value: 'notice page', colour: 'var(--label-3)' }]],
      ['time reference', []],
      ['names a round', [{ value: 'names a round', colour: 'var(--label-4)' }]],
      ['repo kind', [{ value: 'fork', colour: 'var(--label-5)' }]],
    ])
  })

  test('a class switched off in the pane leaves its cell empty; a record no label row names has every cell empty', () => {
    const off = { ...save, classes: save.classes!.map((c) => (c.name === 'notice page' ? { ...c, highlight: false } : c)) }
    expect(laneCells([off], (id) => rows.get(id), () => undefined)[0].values).toEqual([])
    expect(laneCells([save, time], () => undefined, () => undefined).map((c) => c.values)).toEqual([[], []])
  })

  test('a cell with two classes is split in equal parts, one with one class is that colour, an empty one nothing', () => {
    const two = laneCells([repo], () => undefined, () => ({ fork: 1, mirror: 4 }))[0].values
    expect(two.map((v) => v.value)).toEqual(['fork', 'mirror'])
    expect(cellFill(two)).toBe('linear-gradient(90deg, var(--label-5) 0% 50%, var(--label-6) 50% 100%)')
    expect(cellFill([{ value: 'fork', colour: 'var(--label-5)' }])).toBe('var(--label-5)')
    expect(cellFill([])).toBe('')
  })
})

describe('the focused label in the text', () => {
  const rows = new Map<string, LabelRow>([
    ['k1', row('notice page', ['notice link'])],
    ['k2', row('task clock', ['task clock 07:41'])],
    ['k3', row('names a round', ['R5', 'task clock'])],
  ])
  test('its texts are filled and come first, so it wins an overlap; the others are underlined', () => {
    const m = recordMarks([save, time, round], (id) => rows.get(id), 'k3')
    expect(m.spans.map((s) => [s.concept, s.text, !!s.under])).toEqual([
      ['k3', 'R5', false],
      ['k3', 'task clock', false],
      ['k1', 'notice link', true],
      ['k2', 'task clock 07:41', true],
    ])
  })

  test('only the focused label tints a record it has no text in; without a focus every label marks as before', () => {
    const quiet = new Map<string, LabelRow>([['k2', row('task clock')], ['k3', row('names a round')]])
    expect(recordMarks([time, round], (id) => quiet.get(id), 'k3').tint?.concept).toBe('k3')
    expect(recordMarks([time, round], (id) => quiet.get(id), 'k1').tint).toBeUndefined()
    const all = recordMarks([save, time, round], (id) => rows.get(id))
    expect(all.spans.every((s) => !s.under)).toBe(true)
    expect(all.spans[0].concept).toBe('k1')
  })
})
