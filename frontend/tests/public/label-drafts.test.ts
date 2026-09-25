// A label drafted from a prompt, as the Files pane creates it (src/files/labels.ts, LabelPrompt.tsx): its classes, the
// body POST /concepts takes, a name no label has, and the prompt label a description falls back to; and a view's labels:
// the files its claims name, the labels that mark them, and the orientation's labels it turns on by default. Invented
// labels.
import { describe, expect, test } from 'vitest'
import { promptDraft } from '../../src/files/LabelPrompt.tsx'
import { claimMatches, draftBody, draftClasses, freeName, isMultiClass, mainColour, MULTI_COLOUR, nextColour, ownColour, presenceOf, viewDefaults, viewLabels } from '../../src/files/labels.ts'
import type { Concept, LabelDraft } from '../../src/lib/types.ts'

const draft = (extra: Partial<LabelDraft> = {}): LabelDraft => ({ name: 'links out', over: 'files', marks: 'span', glob: 'posts/*.jsonl', kind: 'regex', text: '(?i)https?://', values: ['link', 'no match'], ...extra })

describe('a drafted label', () => {
  test('its classes: the first value in the colour, a negative in the grey and off, the others in the colours after', () => {
    expect(draftClasses(['link', 'no match'], 3)).toEqual([
      { name: 'link', color: 3, highlight: true },
      { name: 'no match', color: 0, highlight: false },
    ])
    expect(draftClasses(['save', 'delete', 'revert', 'other'], 11)).toEqual([
      { name: 'save', color: 11, highlight: true },
      { name: 'delete', color: 12, highlight: true },
      { name: 'revert', color: 1, highlight: true },
      { name: 'other', color: 0, highlight: false },
    ])
  })

  test("a class's colour square steps past the colours the label's other classes have, and a new class takes a free one", () => {
    expect(nextColour(3, [4, 5])).toBe(6)
    expect(nextColour(8, [1])).toBe(9)
    expect(nextColour(12, [1])).toBe(0)
    expect(nextColour(0, [1, 2])).toBe(3)
    expect(nextColour(2, [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])).toBe(0)
    const eight = [1, 2, 3, 4, 5, 6, 7, 8]
    expect([ownColour(6, [1, 2, 3, 4, 5, 6]), ownColour(6, [1, 2]), ownColour(0, [0]), ownColour(4, eight), ownColour(4, [...eight, 9, 10, 11, 12])]).toEqual([7, 6, 0, 9, 4])
  })

  test("a multi-class label is marked as a whole in an ink none of its classes has, as a glyph; a file label's stripe takes the file's value's colour", () => {
    const kind = { id: 'k1', name: 'edit kind', labels: ['fix', 'feature', 'other'], classes: [{ name: 'fix', color: 3, highlight: true }, { name: 'feature', color: 5, highlight: true }, { name: 'other', color: 0, highlight: false }] }
    const flaky = { id: 'k2', name: 'flaky', labels: ['flaky', 'no'], classes: [{ name: 'flaky', color: 1, highlight: true }, { name: 'no', color: 0, highlight: false }] }
    expect([isMultiClass(kind.classes), isMultiClass(flaky.classes)]).toEqual([true, false])
    expect([mainColour(kind), mainColour(flaky)]).toEqual([MULTI_COLOUR, 'var(--label-1)'])
    const presence = new Map<string, Record<string, Record<string, number>>>([['k1', { 'a.jsonl': { feature: 2 } }], ['k2', { 'a.jsonl': { flaky: 1 } }]])
    const labels = [{ ...kind, unit: 'record', marks: 'span' }, { ...flaky, unit: 'record', marks: 'span' }] as never[]
    expect(presenceOf(labels, presence, 'a.jsonl').dots).toEqual([
      { id: 'k1', name: 'edit kind', colour: MULTI_COLOUR, multi: true },
      { id: 'k2', name: 'flaky', colour: 'var(--label-1)', multi: false },
    ])
    const fileKind = { ...kind, unit: 'file', marks: 'file' } as never
    expect(presenceOf([fileKind], presence, 'a.jsonl').stripes).toEqual([{ id: 'k1', name: 'edit kind', colour: 'var(--label-5)' }])
  })

  test('over files it marks and applies to what the draft says and is on; a prompt is a description, a regex a spec', () => {
    const regex = draftBody(draft(), 2)
    expect(regex).toMatchObject({ name: 'links out', unit: 'record', marks: 'span', glob: 'posts/*.jsonl', kind: 'regex', spec: '(?i)https?://', shown: true })
    expect('description' in regex).toBe(false)
    const cards = draftBody(draft({ over: 'cards', marks: null, glob: '', kind: 'prompt', text: 'The card is about deletions.' }), 2)
    expect(cards).toMatchObject({ unit: 'cell', kind: 'prompt', description: 'The card is about deletions.', spec: '', shown: false })
    expect('marks' in cards || 'glob' in cards).toBe(false)
    expect(draftBody(draft({ marks: 'file' }), 1).unit).toBe('agent')
  })

  test('a name no label has, and a description as a prompt label over the files in view', () => {
    expect(freeName('links out', ['other'])).toBe('links out')
    expect(freeName('links out', ['Links out', 'links out 2'])).toBe('links out 3')
    expect(promptDraft('posts that sound unsure', ['a.jsonl', 'b.jsonl'])).toEqual({ name: '', over: 'files', marks: 'span', glob: 'a.jsonl, b.jsonl', kind: 'prompt', text: 'posts that sound unsure', values: ['match', 'no match'] })
  })
})

const k = (id: string, by: string, ts: string, extra: Partial<Concept> = {}): Concept => ({ id, name: id, description: '', unit: 'record', kind: 'regex', spec: 'x', labels: ['yes', 'no'], created_by: by, ts, shown: false, ...extra })

describe("a view's labels", () => {
  test("a claim names a file by its whole path or its name, `*` spanning folders, as the server's claims do", () => {
    expect(claimMatches('runs/r1/clock.jsonl', 'runs/*/clock.jsonl')).toBe(true)
    expect(claimMatches('runs/r1/deep/clock.jsonl', 'runs/*.jsonl')).toBe(true)
    expect(claimMatches('boards/b.jsonl', '*.jsonl')).toBe(true)
    expect(claimMatches('boards/b.json', '*.jsonl')).toBe(false)
    expect(claimMatches('boards/posts.jsonl', 'posts.jsonl')).toBe(true)
    expect(claimMatches('a1.txt', 'a[0-9].txt')).toBe(true)
    expect(claimMatches('ab.txt', 'a[!b].txt')).toBe(false)
    expect(claimMatches('x.y', 'x.y') && !claimMatches('xzy', 'x.y')).toBe(true)
    expect(claimMatches('any/file', '')).toBe(true)
  })

  test("the labels that mark its files, and the orientation's it turns on while none of them is on, oldest first", () => {
    const all = [k('u1', 'user', '2026-09-24T09:00Z'), k('o1', 'chat:or1', '2026-09-24T10:00Z'), k('o0', 'chat:or1', '2026-09-24T08:00Z'), k('o3', 'chat:or1', '2026-09-24T11:00Z'), k('t1', 'chat:or1', '2026-09-24T07:00Z', { trial: true }), k('c1', 'chat:or1', '2026-09-24T07:00Z', { unit: 'cell' })]
    const presence = new Map(Object.entries({ u1: { 'posts.jsonl': { yes: 1 } }, o1: { 'posts.jsonl': { yes: 2 } }, o0: { 'posts.jsonl': { yes: 1 } }, o3: { 'posts.jsonl': { yes: 5 } }, t1: { 'posts.jsonl': { yes: 1 } } }))
    expect([...viewLabels(all, presence, ['posts.jsonl'])].sort()).toEqual(['o0', 'o1', 'o3', 't1', 'u1'])
    expect(viewLabels(all, presence, ['events.jsonl']).size).toBe(0)
    expect(viewDefaults(all, presence, ['posts.jsonl'], new Set(['or1']))).toEqual(['o0', 'o1'])
    expect(viewDefaults(all, presence, ['posts.jsonl'], new Set(['other'])), 'another chat made them').toEqual([])
    const on = all.map((x) => (x.id === 'u1' ? { ...x, shown: true } : x))
    expect(viewDefaults(on, presence, ['posts.jsonl'], new Set(['or1'])), 'a label of its files is on already').toEqual([])
  })
})
