// @vitest-environment jsdom
// Color by in Files' Transcript mode (src/files/colorChoice.ts): a key's values take the palette by frequency, the rest
// one Other, the records with none their own chip; a label's chips are its highlighted values with their counts and the
// meanings its definition gives, then Not marked; the default choice is the file's first key with few values, else Off;
// a record's value is read from a JSON line the server pages as text; the choice and the values off are kept per file.
// A key whose values are nearly unique per record (an id, a page) is not offered.
// The tracks' geometry is tracks.test.ts.
import { afterEach, describe, expect, test } from 'vitest'
import { chipOfKeyValue, choiceId, colorKeys, defaultChoice, definitionLead, keyChips, keyValue, labelChips, nearlyUnique, NONE, OTHER, parseChoice, pickedChips, readColor, valueMeaning, writeColor } from '../../src/files/colorChoice'
import type { Concept, SourceKey, SourceRecord } from '../../src/lib/types'

afterEach(() => window.localStorage.clear())

const key = (name: string, n: number, more = 0, none = 0): SourceKey => ({
  key: name,
  values: Array.from({ length: n }, (_, i) => ({ value: `v${i}`, n: 100 - i })),
  more: { values: more, n: more * 2 },
  none,
  at: [],
})

const DEF =
  "What this edit to the wiki page adds. 'message to other runs': the edit adds text written for other AI agents. 'posts links': the edit adds links or URLs and no message to other runs. 'other': test text, empty or default page text (such as 'Beschreibe hier die neue Seite.'), or anything else. When an edit both posts links and messages other runs, choose 'message to other runs'."

const label: Concept = {
  id: 'c1',
  name: 'edit purpose',
  description: DEF,
  unit: 'record',
  kind: 'prompt',
  spec: '',
  labels: ['message to other runs', 'posts links', 'other'],
  created_by: 'orient',
  ts: '',
  classes: [
    { name: 'message to other runs', color: 1, highlight: true },
    { name: 'posts links', color: 2, highlight: true },
    { name: 'other', color: 0, highlight: false },
  ],
}

describe('the chips of a choice', () => {
  test("a key's commonest values take the palette, the rest one Other, and the records with none their own", () => {
    const chips = keyChips(key('type', 14, 3, 7))
    expect(chips.slice(0, 12).map((c) => c.color)).toEqual(Array.from({ length: 12 }, (_, i) => `var(--label-${i + 1})`))
    expect(chips[12]).toMatchObject({
      id: OTHER,
      name: 'Other',
      n: 88 + 87 + 6,
      color: 'var(--label-none)',
    })
    expect(chips[13]).toMatchObject({
      id: NONE,
      name: 'No type',
      n: 7,
      color: null,
    })
    expect(keyChips(key('wiki', 4)).map((c) => c.id)).toEqual(['v0', 'v1', 'v2', 'v3'])
  })

  test("a label's chips are its highlighted values with their counts and meanings, then the records it does not mark", () => {
    const chips = labelChips(label, { 'message to other runs': 40, 'posts links': 50, other: 5 }, 100)
    expect(chips.map((c) => [c.name, c.n])).toEqual([
      ['message to other runs', 40],
      ['posts links', 50],
      ['Not marked', 10],
    ])
    expect(chips[0].meaning).toBe('the edit adds text written for other AI agents.')
    expect(chips[1].meaning).toBe('the edit adds links or URLs and no message to other runs.')
    // a label that marks every record has no Not marked chip
    expect(labelChips(label, { 'message to other runs': 40, 'posts links': 60 }, 100).map((c) => c.name)).toEqual(['message to other runs', 'posts links'])
  })

  test("a value's meaning stops at the next value or at the end of its sentence, and the definition's lead is its question", () => {
    expect(valueMeaning(DEF, label.labels, 'other')).toBe("test text, empty or default page text (such as 'Beschreibe hier die neue Seite.'), or anything else.")
    expect(valueMeaning(DEF, label.labels, 'missing')).toBeNull()
    expect(valueMeaning('', label.labels, 'other')).toBeNull()
    expect(definitionLead(DEF, label.labels)).toBe('What this edit to the wiki page adds.')
    expect(definitionLead('Is it a test?', ['yes', 'no'])).toBe('Is it a test?')
  })
})

describe('the choice', () => {
  test("the default is the file's first key with few values, else its first key, else Off", () => {
    expect(defaultChoice([key('page', 60, 400), key('wiki', 4)])).toEqual({
      by: 'key',
      key: 'wiki',
    })
    expect(defaultChoice([key('page', 60, 400)])).toEqual({
      by: 'key',
      key: 'page',
    })
    expect(defaultChoice([])).toEqual({ by: 'off' })
  })

  test('a choice reads back from its id', () => {
    for (const c of [{ by: 'off' }, { by: 'key', key: 'type' }, { by: 'label', id: 'c1' }] as const) expect(parseChoice(choiceId(c))).toEqual(c)
    expect(parseChoice('x')).toBeNull()
  })

  test('the choice and the values off are kept per file', () => {
    writeColor('ws', 'a.jsonl', { by: 'off', off: { 'k:type': ['v1'] } })
    expect(readColor('ws', 'a.jsonl')).toEqual({
      by: 'off',
      off: { 'k:type': ['v1'] },
    })
    expect(readColor('ws', 'b.jsonl')).toEqual({ by: null, off: {} })
  })

  test("the colors picked for a key's values are kept per file, and its chips take them", () => {
    writeColor('ws', 'a.jsonl', { by: 'k:wiki', off: {}, colors: { 'k:wiki': { dse: 7, bad: 99 } } })
    const kept = readColor('ws', 'a.jsonl')
    expect(kept.colors).toEqual({ 'k:wiki': { dse: 7 } })
    expect(readColor('ws', 'b.jsonl').colors).toBeUndefined()
    const chips = pickedChips(keyChips({ key: 'wiki', values: [{ value: 'dse', n: 9 }, { value: 'probier', n: 3 }], more: { values: 0, n: 0 }, none: 2, at: [] }), kept.colors?.['k:wiki'])
    expect(chips.map((c) => [c.id, c.color])).toEqual([
      ['dse', 'var(--label-7)'],
      ['probier', 'var(--label-2)'],
      [NONE, null],
    ])
  })
})

test("a record's value is read from its object or from a JSON line's text, and falls under its chip", () => {
  const rec = (record: unknown, line = 1): SourceRecord => ({
    line,
    record,
    blocks: [],
    meta: {},
  })
  const k = key('type', 14)
  expect(keyValue(rec({ type: 'v3' }), 'type')).toBe('v3')
  expect(keyValue(rec({ text: '{"type": "v13", "n": 2}' }), 'type')).toBe('v13')
  expect(keyValue(rec({ text: '{"n": 2}' }), 'n')).toBe('2')
  expect(keyValue(rec({ text: 'plain words' }), 'type')).toBeNull()
  expect(chipOfKeyValue(k, 'v3')).toBe('v3')
  expect(chipOfKeyValue(k, 'v13')).toBe(OTHER)
  expect(chipOfKeyValue(k, null)).toBe(NONE)
})

test('a key whose values are nearly unique per record is not offered, one with few values or many records each is', () => {
  // collusion-wiki's revisions.jsonl: 4,579 page ids over 14,591 records, about 3 each
  const pageId: SourceKey = { key: 'page_id', values: Array.from({ length: 60 }, (_, i) => ({ value: `p${i}`, n: 10 })), more: { values: 4519, n: 13991 }, none: 0, at: [] }
  const wiki: SourceKey = { key: 'wiki', values: [{ value: 'dse', n: 9000 }, { value: 'probier', n: 5591 }], more: { values: 0, n: 0 }, none: 0, at: [] }
  // two hundred users with fifty records each colors by the commonest twelve
  const user: SourceKey = { key: 'user', values: Array.from({ length: 60 }, (_, i) => ({ value: `u${i}`, n: 50 })), more: { values: 140, n: 7000 }, none: 0, at: [] }
  // a small file whose few values are each on one record keeps them: no more than the palette's colors
  const few: SourceKey = { key: 'type', values: Array.from({ length: 5 }, (_, i) => ({ value: `t${i}`, n: 1 })), more: { values: 0, n: 0 }, none: 0, at: [] }
  expect(nearlyUnique(pageId)).toBe(true)
  expect(nearlyUnique(wiki)).toBe(false)
  expect(nearlyUnique(user)).toBe(false)
  expect(nearlyUnique(few)).toBe(false)
  expect(colorKeys([pageId, wiki, user, few]).map((k) => k.key)).toEqual(['wiki', 'user', 'type'])
  expect(defaultChoice(colorKeys([pageId, wiki]))).toEqual({ by: 'key', key: 'wiki' })
})
