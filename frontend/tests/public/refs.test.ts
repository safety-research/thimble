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

  test('a database table and one of its rows', () => {
    expect(parseRef('forge.db#prs')).toEqual({ kind: 'table', path: 'forge.db', table: 'prs' })
    expect(parseRef('forge.db#prs/118')).toEqual({ kind: 'row', path: 'forge.db', table: 'prs', pk: '118' })
    expect(parseRef('runs/a/state.sqlite3#reviews/7')).toEqual({ kind: 'row', path: 'runs/a/state.sqlite3', table: 'reviews', pk: '7' })
  })

  test("any other part of a file is the file with its locator kept as text", () => {
    expect(parseRef('budget.xlsx#Q3!B2:B40')).toEqual({ kind: 'path', path: 'budget.xlsx', locator: 'Q3!B2:B40' })
    expect(parseRef('papers/a.pdf#page=4')).toEqual({ kind: 'path', path: 'papers/a.pdf', locator: 'page=4' })
    expect(parseRef('notes.txt#intro')).toEqual({ kind: 'path', path: 'notes.txt', locator: 'intro' })
    expect(refPath('budget.xlsx#Q3!B2:B40')).toBe('budget.xlsx')
    expect(refLabel('papers/a.pdf#page=4')).toBe('papers › a.pdf · page=4')
    expect(refLabel('budget.xlsx#Summary!A1:Z900-long-name')).toBe('budget.xlsx · Summary!A1:Z900-l…')
  })

  test('a mistyped line ref, a scheme, bracketed prose or a bare fragment is no ref', () => {
    for (const bad of ['a.jsonl#L', 'a.jsonl#L1-2', 'a.jsonl#L1.b', 'a.jsonl#L1:c0-3', 'x.db#', 'a b #L1', 'a b#intro', 'see the chart above', 'claim:0badf00d#1', 'http://x.org/a#b', '#count/total', '']) {
      expect(parseRef(bad), bad).toBeNull()
    }
  })

  test('a path may hold spaces inside it, and one with no line fragment counts when it looks like a file', () => {
    expect(parseRef('run 1/agents/agent one.jsonl#L2')).toEqual({ kind: 'record', path: 'run 1/agents/agent one.jsonl', line: 2 })
    expect(parseRef('Call log 3.md#L4-L9')).toEqual({ kind: 'range', path: 'Call log 3.md', line: 4, endLine: 9 })
    expect(parseRef('q3 data/sales db.sqlite#orders/7')).toEqual({ kind: 'row', path: 'q3 data/sales db.sqlite', table: 'orders', pk: '7' })
    expect(parseRef('Meeting notes.md')).toEqual({ kind: 'path', path: 'Meeting notes.md' })
    expect(parseRef('a b.txt#intro')).toEqual({ kind: 'path', path: 'a b.txt', locator: 'intro' })
    expect(refPath('run 1/agents/agent one.jsonl#L2')).toBe('run 1/agents/agent one.jsonl')
  })

  test('a nested run is named by its own folder on the chip', () => {
    expect(refLabel('runs/trial-3/agents/agent-07.jsonl#L34')).toBe('trial-3 › agent-07.jsonl L34')
    expect(refLabel('runs/trial-3/board.jsonl#L5-L9')).toBe('trial-3 › board.jsonl L5-9')
    expect(refLabel('runs/trial-3/forge.db#prs/12')).toBe('trial-3 › prs/12')
    expect(refLabel('board.jsonl#L5')).toBe('board.jsonl L5')
  })

  test('same-named files under numbered folders are told apart by the folder that numbers them', () => {
    // a team's or a trial's folder holds a digit; the folders under it are the same in every one
    expect(addressLabel('team-6/output/orient/notes.json#L2')).toBe('team-6 › … › notes.json L2')
    expect(addressLabel('team-2/output/orient/notes.json#L2')).toBe('team-2 › … › notes.json L2')
    expect(refLabel('trial-03/logs/w3_log.json#L1.b0')).toBe('trial-03 › … › w3_log.json L1.b0')
    expect(refLabel('runs/batch1-alpha/agents/agent-2.jsonl#L4')).toBe('batch1-alpha › agent-2.jsonl L4')
    expect(refLabel('meetings/round/notes.md')).toBe('round › notes.md')
    expect(runFolder('notes.md')).toBeNull()
    // the hover names the whole path wherever the chip leaves a folder out
    expect(hiddenPath('team-6/output/orient/notes.json#L2')).toBe('team-6/output/orient/notes.json')
    expect(hiddenPath('runs/batch1-alpha/agents/agent-2.jsonl#L4')).toBe('runs/batch1-alpha/agents/agent-2.jsonl')
    expect([hiddenPath('notes/week3.md'), hiddenPath('board.jsonl#L5'), hiddenPath('card:ab12cd34')]).toEqual([null, null, null])
  })

  test("an example's address keeps the file's extension and leaves out a passage's block and characters", () => {
    expect(addressLabel('changelog.jsonl#L5371.b0:c420-597')).toBe('changelog.jsonl L5371')
    expect(addressLabel('changelog.jsonl#L5371.b0')).toBe('changelog.jsonl L5371')
    expect(addressLabel('events.jsonl#L88')).toBe('events.jsonl L88')
    expect(addressLabel('runs/trial-3/agents/agent-07.jsonl#L34.b1:c0-12')).toBe('trial-3 › agent-07.jsonl L34')
    expect(addressLabel('runs/trial-3/board.jsonl#L5-L9')).toBe('trial-3 › board.jsonl L5-9')
    expect(addressLabel('notes/week3.md')).toBe('notes › week3.md')
    expect(addressLabel('view:board/t-12')).toBe(refLabel('view:board/t-12'))
  })

  test('the fragment of a ref into a file, and the line a file opens at when nothing reads the fragment', () => {
    expect(fragmentIn('events.jsonl#L61', 'events.jsonl')).toBe('L61')
    expect(fragmentIn('budget.xlsx#Q3!D17', 'budget.xlsx')).toBe('Q3!D17')
    expect(fragmentIn('budget.xlsx', 'budget.xlsx')).toBeNull()
    expect(fragmentIn('other.jsonl#L3', 'events.jsonl')).toBeNull()
    expect(fragmentIn(undefined, 'a')).toBeNull()
    expect(nearestLine('L12.b3')).toBe(12)
    expect(nearestLine('L12-L20')).toBe(12)
    expect(nearestLine('Q3!D17')).toBeNull()
    expect(nearestLine(null)).toBeNull()
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

  test('card: is written, and the older cell: prefix reads the same', () => {
    expect(cardRef('ab12')).toBe('card:ab12')
    for (const prefix of ['card:', 'cell:']) {
      expect(isCardRef(`${prefix}ab12`)).toBe(true)
      expect(parseRef(`${prefix}ab12#count/total`)).toEqual({ kind: 'cell', cellId: 'ab12', col: 'count', row: 'total' })
      expect(surfaceOf(`${prefix}ab12`)).toBe('canvas')
    }
    expect(isCardRef('cards/a.jsonl#L1')).toBe(false)
  })

  test('a table cell keeps the spaces of a raw label, stops its column at the first slash, and keeps an encoded label as written', () => {
    expect(parseRef('card:ab12#open pull requests/median days')).toEqual({ kind: 'cell', cellId: 'ab12', col: 'open pull requests', row: 'median days' })
    expect(parseRef('card:ab12#count all/a/b')).toEqual({ kind: 'cell', cellId: 'ab12', col: 'count all', row: 'a/b' })
    expect(parseRef('card:ab12#count%20all/total%20files')).toEqual({ kind: 'cell', cellId: 'ab12', col: 'count%20all', row: 'total%20files' })
    expect(parseRef('  card:ab12#reviews/total  ')).toEqual({ kind: 'cell', cellId: 'ab12', col: 'reviews', row: 'total' })
  })

  test('a fragment no form reads is the card itself', () => {
    expect(parseRef('card:ab12#no slash here')).toEqual({ kind: 'cell', cellId: 'ab12' })
    expect(parseRef('card:ab12@out0#L3 and more')).toEqual({ kind: 'cell', cellId: 'ab12' })
  })

  test("a file's line cited through the card that shows it is the file's line, where the citation opens", () => {
    // an example card's excerpt as a model cites it: no cell of the card's table, which would name a column `runs`
    expect(parseRef('card:ab12#runs/one/agent-39.jsonl#L103.b0:c12-109')).toEqual(parseRef('runs/one/agent-39.jsonl#L103.b0:c12-109'))
    expect(parseRef('card:ab12#runs/one/agent-39.jsonl#L103.b0:c12-109')?.kind).toBe('span')
    expect(parseRef('card:ab12#a b/c.jsonl#L4-L6')).toEqual({ kind: 'range', path: 'a b/c.jsonl', line: 4, endLine: 6 })
    expect(parseRef('card:ab12#runs/agent-01')).toEqual({ kind: 'cell', cellId: 'ab12', col: 'runs', row: 'agent-01' })
    const ref = 'card:ab12#runs/one/agent-39.jsonl#L103.b0:c12-109'
    expect(plainRef(ref)).toBe('runs/one/agent-39.jsonl#L103.b0:c12-109')
    expect(plainRef('card:ab12#outcome/merged')).toBe('card:ab12#outcome/merged')
    expect(fragmentIn(ref, 'runs/one/agent-39.jsonl')).toBe('L103.b0:c12-109')
    // a click opens the file at the line, not the card
    const opened: string[] = []
    const off = bus.on('openRef', (e) => opened.push(e.ref))
    teleport(ref)
    off()
    expect(opened).toEqual(['runs/one/agent-39.jsonl#L103.b0:c12-109'])
  })

  test('a bare ref into part of a card is named by the cell or the lines, with the card only from outside it', () => {
    const td = parseRef('card:0c9200c9#All%20open%20PRs/Reviews') as ParsedRef & { kind: 'cell' }
    expect(cardPartLabel(td, 'review-load', true)).toBe('All open PRs · Reviews')
    expect(cardPartLabel(td, 'review-load', false)).toBe('review-load · All open PRs · Reviews')
    const long = parseRef('card:0c9200c9#All%20open%20PRs/First%20review%20came%20after%20the%20merge') as ParsedRef & { kind: 'cell' }
    expect(cardPartLabel(long, 'x', true)).toBe('All open PRs · First review came a…')
    expect(cardPartLabel(parseRef('card:322d3030@out0#L8') as ParsedRef & { kind: 'cell' }, 'first-hour', true)).toBe('line 8')
    expect(cardPartLabel(parseRef('card:322d3030@out0#L8-L11') as ParsedRef & { kind: 'cell' }, 'first-hour', true)).toBe('lines 8–11')
    expect(cardPartLabel(parseRef('card:322d3030') as ParsedRef & { kind: 'cell' }, 'first-hour', true)).toBeNull()
  })

  test("a table cell's span encodes its labels as the backend does (cite.encode_label), and a blank label names no cell", () => {
    expect(encodeLabel('last_save')).toBe('last%5Fsave')
    expect(encodeLabel('50% merged')).toBe('50%25%20merged')
    expect(encodeLabel('a/b c')).toBe('a%2Fb%20c')
    expect(encodeLabel('naïve · x')).toBe('naïve%20·%20x')
    expect(encodeLabel('tab\there')).toBe('tab%09here')
    expect(encodeLabel('[x]|y#z')).toBe('%5Bx%5D%7Cy%23z')
    expect(decodeLabel(encodeLabel('a/b c_%'))).toBe('a/b c_%')
    expect(tdRef('c1', 'revisions', 'north')).toBe('card:c1#revisions/north')
    expect(parseRef(tdRef('c1', 'first/last', 'north wiki')!)).toMatchObject({ kind: 'cell', cellId: 'c1', col: 'first%2Flast', row: 'north%20wiki' })
    expect(tdRef('c1', ' ', 'north')).toBeNull()
  })

  test('a percent-encoded label decodes as the table shows it, and a broken escape is kept', () => {
    expect(decodeLabel('first%5Freview')).toBe('first_review')
    expect(decodeLabel('50%25 merged')).toBe('50% merged')
    expect(decodeLabel('100%')).toBe('100%')
    expect(decodeLabel('%E2%82')).toBe('%E2%82')
  })
})

describe('other refs', () => {
  test('group, report, concept, chat and ui refs', () => {
    expect(parseRef('group:g1a2')).toEqual({ kind: 'group', groupId: 'g1a2' })
    expect(parseRef('report:report')).toEqual({ kind: 'report', slug: 'report' })
    expect(parseRef('report:report#p3')).toEqual({ kind: 'report', slug: 'report', unit: 'p3' })
    expect(parseRef('report:story#s12')).toEqual({ kind: 'report', slug: 'story', unit: 's12' })
    expect(parseRef('concept:c1')).toEqual({ kind: 'concept', conceptId: 'c1' })
    expect(parseRef('chat:t9')).toEqual({ kind: 'chat', chatId: 't9', eventIndex: undefined })
    expect(parseRef('chat:t9#4')).toEqual({ kind: 'chat', chatId: 't9', eventIndex: 4 })
    expect(parseRef('ui:canvas.toolbar')).toEqual({ kind: 'ui', name: 'canvas.toolbar' })
  })

  test("one value of a label, raw or encoded, is the label's ref with the value", () => {
    expect(parseRef('concept:c1/needs a review')).toEqual({ kind: 'concept', conceptId: 'c1', value: 'needs a review' })
    expect(parseRef('concept:c1/test%20or%20blank')).toEqual({ kind: 'concept', conceptId: 'c1', value: 'test or blank' })
    expect(refLabel('concept:c1/needs a review')).toBe('label · needs a review')
    expect(refLabel('concept:c1')).toBe('label')
  })

  test('a view, and a unit only that view defines', () => {
    expect(parseRef('view:review-threads')).toEqual({ kind: 'view', slug: 'review-threads' })
    expect(parseRef('view:review-threads/pr-118')).toEqual({ kind: 'view', slug: 'review-threads', key: 'pr-118' })
    expect(parseRef('view:budget/Q3/row4')).toEqual({ kind: 'view', slug: 'budget', key: 'Q3/row4' })
    expect(parseRef('view:Review_Threads')).toBeNull()
    expect(refPath('view:review-threads/pr-118')).toBeNull()
    expect(refLabel('view:review-threads')).toBe('view review-threads')
    expect(refLabel('view:review-threads/a-very-long-key-for-one-unit')).toBe('review-threads · a-very-long-key-f…')
  })

  test('a call of the orientation, whole or lines of its output, and nothing else under call:', () => {
    expect(parseRef('call:or1/12')).toEqual({ kind: 'call', chat: 'or1', n: 12 })
    expect(parseRef('call:or1/12#L3')).toEqual({ kind: 'call', chat: 'or1', n: 12, line: 3 })
    expect(parseRef('call:or1/12#L3-L5')).toEqual({ kind: 'call', chat: 'or1', n: 12, line: 3, endLine: 5 })
    expect(parseRef('call:or1/12#L3-5')).toEqual({ kind: 'call', chat: 'or1', n: 12, line: 3, endLine: 5 })
    expect(parseRef('call:or1/12#x')).toBeNull()
    expect(parseRef('call:or1')).toBeNull()
    expect(callRef('or1', 12)).toBe('call:or1/12')
    expect(callRef('or1', 12, 3)).toBe('call:or1/12#L3')
    expect(callRef('or1', 12, 3, 5)).toBe('call:or1/12#L3-L5')
    expect(callRef('or1', 12, 3, 3)).toBe('call:or1/12#L3')
    expect(refLabel('call:or1/12#L3-L5')).toBe('call 12 · lines 3–5')
  })

  test('every form parses back from what callRef and cardRef write', () => {
    for (const ref of [callRef('or1', 2), callRef('or1', 2, 7), callRef('or1', 2, 7, 9)]) expect(parseRef(ref)?.kind).toBe('call')
    expect(parseRef(cardRef('ab12cd34'))).toEqual({ kind: 'cell', cellId: 'ab12cd34' })
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

  test('a value-ref token splits at its first bar; a bare token has no value', () => {
    expect(splitValueRef('31|card:ab12#merged/total')).toEqual({ value: '31', ref: 'card:ab12#merged/total' })
    expect(splitValueRef(' 4.2 days | forge.db#prs/7 ')).toEqual({ value: '4.2 days', ref: 'forge.db#prs/7' })
    expect(splitValueRef('card:ab12')).toEqual({ ref: 'card:ab12' })
  })

  test('a long whole number in a citation takes thousands separators; a year, an id and text stay as written', () => {
    expect(shownValue('6355')).toBe('6,355')
    expect(shownValue('13339')).toBe('13,339')
    expect(shownValue('-1234567.25')).toBe('-1,234,567.25')
    expect(shownValue('2026')).toBe('2026')
    expect(shownValue('0042')).toBe('0042')
    expect(shownValue('412')).toBe('412')
    expect(shownValue('12,480')).toBe('12,480')
    expect(shownValue('44%')).toBe('44%')
    expect(shownValue('run 7')).toBe('run 7')
  })
})
