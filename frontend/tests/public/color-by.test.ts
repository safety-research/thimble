// @vitest-environment jsdom
// Color by in Files' Transcript mode (src/files/colorChoice.ts): a key's values take the palette by frequency, the rest
// one Other, the records with none their own chip; a label's chips are its highlighted values with their counts and the
// meanings its definition gives, then Not marked; the default choice is the file's first key with few values, else Off;
// a record's value is read from a JSON line the server pages as text, or from the fields the server gives its turn
// (meta.fields); the choices and the values off are kept per file, a file kept with one choice before Color by took
// several opening on it; the choices that no longer hold fall back to the key chosen last, else the default; a key's
// lane paints its commonest value per bin. A key whose values are nearly unique per record (an id, a page) is not
// offered.
// The tracks' geometry is tracks.test.ts.
import { afterEach, describe, expect, test } from 'vitest'
import { defaultChoice, keyChips, NONE, OTHER, pickedChips, readColor, writeColor } from '../../src/files/colorChoice'
import type { SourceKey } from '../../src/lib/types'

afterEach(() => window.localStorage.clear())

const key = (name: string, n: number, more = 0, none = 0): SourceKey => ({
  key: name,
  values: Array.from({ length: n }, (_, i) => ({ value: `v${i}`, n: 100 - i })),
  more: { values: more, n: more * 2 },
  none,
  at: [],
})

describe('the chips of a choice', () => {
  test("a key's commonest values take the palette, the rest one Other, and the records with none their own", () => {
    const chips = keyChips(key('type', 14, 3, 7))
    // in the order new values take the palette's places: sky (4) after the first five, so they hold no second blue
    expect(chips.slice(0, 12).map((c) => c.color)).toEqual([1, 2, 3, 5, 6, 7, 4, 8, 9, 10, 11, 12].map((n) => `var(--label-${n})`))
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
