// The ref grammar (src/lib/refs.ts), which backend/app/refs.py keeps in step: every form a citation can take parses to
// its parts, a malformed ref is no ref, and each ref maps to the surface its chip opens and the label it shows.
import { describe, expect, test } from 'vitest'
import { bus } from '../../src/lib/bus.ts'
import { teleport } from '../../src/lib/teleport.ts'
import {
  addressLabel,
  callRef,
  cardPartLabel,
  cardRef,
  decodeLabel,
  encodeLabel,
  fragmentIn,
  hiddenPath,
  isCardRef,
  nearestLine,
  parseRef,
  plainRef,
  refLabel,
  refPath,
  runFolder,
  shownValue,
  splitValueRef,
  surfaceOf,
  tdRef,
  type ParsedRef,
} from '../../src/lib/refs.ts'

describe('file refs', () => {
  test('a record, a range, a block and a span of a line', () => {
    expect(parseRef('agents/agent-04.jsonl#L12')).toEqual({ kind: 'record', path: 'agents/agent-04.jsonl', line: 12 })
    expect(parseRef('agents/agent-04.jsonl#L12-L20')).toEqual({ kind: 'range', path: 'agents/agent-04.jsonl', line: 12, endLine: 20 })
    expect(parseRef('agents/agent-04.jsonl#L12.b1')).toEqual({ kind: 'block', path: 'agents/agent-04.jsonl', line: 12, block: 1 })
    expect(parseRef('agents/agent-04.jsonl#L12.b1:c3-9')).toEqual({ kind: 'span', path: 'agents/agent-04.jsonl', line: 12, block: 1, start: 3, end: 9 })
    expect(parseRef('README.md')).toEqual({ kind: 'path', path: 'README.md' })
  })
})

describe('card refs', () => {
  test('a card, a run of it, a cell of its table and lines of its output', () => {
    expect(parseRef('card:ab12cd34')).toEqual({ kind: 'cell', cellId: 'ab12cd34' })
    expect(parseRef('card:ab12cd34@3')).toEqual({ kind: 'cell', cellId: 'ab12cd34', exec: 3 })
    expect(parseRef('card:ab12cd34#merged/total')).toEqual({ kind: 'cell', cellId: 'ab12cd34', col: 'merged', row: 'total' })
    expect(parseRef('card:ab12cd34@out0#L3')).toEqual({ kind: 'cell', cellId: 'ab12cd34', out: 0, line: 3 })
    expect(parseRef('card:ab12cd34@out1#L3-L5')).toEqual({ kind: 'cell', cellId: 'ab12cd34', out: 1, line: 3, endLine: 5 })
    expect(parseRef('card:ab12cd34@out0#L4-L4')).toEqual({ kind: 'cell', cellId: 'ab12cd34', out: 0, line: 4 })
  })
})

describe('surfaces and values', () => {
  test('each ref opens its surface: cards, groups and labels on the canvas, documents in the report, files in Files', () => {
    const cases: [string, string | null][] = [
      ['card:ab12', 'canvas'],
      ['group:g1', 'canvas'],
      ['concept:c1/yes', 'canvas'],
      ['report:report#p3', 'report'],
      ['view:review-threads', 'files'],
      ['forge.db#prs', 'files'],
      ['forge.db#prs/1', 'files'],
      ['a.jsonl#L1', 'files'],
      ['a.jsonl#L1-L2', 'files'],
      ['a.jsonl#L1.b0', 'files'],
      ['a.jsonl#L1.b0:c0-4', 'files'],
      ['budget.xlsx#Q3!A1', 'files'],
      ['call:or1/3', null],
      ['chat:t1', null],
      ['ui:x', null],
      ['not a ref', null],
    ]
    for (const [ref, surface] of cases) expect(surfaceOf(ref), ref).toBe(surface)
  })
})
