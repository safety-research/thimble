// Each kind of thimble card in its drawing form (hooks/cell.ts), and how it draws: the map of card kinds.
// `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'

import { busyWords, cardOfCell, htmlTable, labelCard, linksOf, sortedBars } from '../hooks/cell'
import type { ThimbleCell } from '../hooks/cell'
import { cardLayout, cut, placeWords, share } from '../hooks/draw'
import { CHIP_MAX, chipLabel, citations, clip, cutLine, cutMiddle, dateIn, dateSpans, formatted, itemsRow, labelState, labelStateWords, noteLabelName, noteQuestion, quoted, recordFields, valueIn, width, windowAt } from '../hooks/lib'
import { plainCites } from '../hooks/cite'
import { crumbsWidth, fitCrumbs } from '../hooks/nav'
import { hintLines } from '../hooks/chrome'
import type { BarRow, Cell } from '../hooks/draw'
import { CELLS, LABEL } from './fixtures'

const of = (id: string) => CELLS[id] as unknown as ThimbleCell
const text = (id: string, cols = 70) => {
  const { card } = cardOfCell(of(id), id === 'l0label0' ? (LABEL as never) : null)
  return cardLayout(card, cols, -1).lines.map(l => l.map(s => s.s).join(''))
}

test("a pandas table's html is a table card: the index named, numbers as numbers", () => {
  const { card } = cardOfCell(of('ff73e071'))
  expect(card.kind).toBe('table')
  expect(card.columns).toEqual(['wiki', 'pages', 'revisions'])
  expect((card.rows as Cell[][])[2]).toEqual(['TOTAL', 4579, 14591])
  expect(text('ff73e071').join('\n')).toContain('probier')
  expect(htmlTable('<p>no table</p>')).toEqual([])
})

test("a table card's frame: its label column first, then the shown columns", () => {
  const { card } = cardOfCell(of('a0frame0'))
  expect(card.kind).toBe('table')
  expect(card.columns).toEqual(['file', 'records'])
  expect((card.rows as Cell[][])[1]).toEqual(['events.jsonl', 19913])
})

test('a one-layer Altair bar chart draws as text bars; a faceted one as a table of its rows', () => {
  const bar = cardOfCell(of('b0bar000')).card
  expect(bar.kind).toBe('bar')
  expect((bar.rows as BarRow[])[0]).toEqual({ label: 'dse', value: 13403, group: '' })
  expect(text('b0bar000').some(l => /dse +█+ +13,403/.test(l))).toBe(true)
  const facet = cardOfCell(of('c5466383')).card
  expect(facet.kind).toBe('table')
  expect(facet.columns).toEqual(['day', 'event_type', 'rows'])
})

test('a diagram from its payload (from and to) and a timeline from its output draw directly', () => {
  const d = cardOfCell(of('d0diag00')).card
  expect(d.kind).toBe('diagram')
  expect(d.edges).toEqual([{ source: 'agents', target: 'dse', label: 'saves' }, { source: 'admin', target: 'dse', label: 'deletions' }])
  // a node only an edge names is drawn by its name
  expect(d.nodes!.map(n => n.id)).toEqual(['agents', 'dse', 'admin'])
  expect(text('d0diag00').join('\n')).toContain('dse wiki')
  const t = cardOfCell(of('e0time00')).card
  expect(t.kind).toBe('timeline')
  expect(text('e0time00').join('\n')).toContain('peak afternoon')
})

test('an example card lists its records; a note is prose; a custom card its words; a code card what it printed', () => {
  const ex = cardOfCell(of('a20ecb55')).card
  expect(ex.kind).toBe('example')
  expect(ex.examples!.map(x => x.ref)).toEqual(['README.md#L3', 'README.md#L5'])
  expect(text('a20ecb55').join('\n')).toContain('README.md line 3')
  expect(text('n0note00')).toEqual(['The dse wiki was used as a relay and as a message board.'])
  expect(text('c0cust00')).toEqual(['45%', 'of all saves landed in one afternoon'])
  expect(text('k0code00')).toEqual(['revisions.jsonl 14591', 'events.jsonl 19913'])
})

test("a card whose run failed says why; one waiting for its run says so", () => {
  const { error } = cardOfCell(of('x0err000'))
  expect(error).toBe("KeyError: 'wiki'")
  expect(busyWords(of('w0wait00'))).toBe('waiting for its run')
  expect(busyWords(of('ff73e071'))).toBe('')
})

test("a label card: its counts as bars in the label's order; the records it carries are drawn in the label panel, not on it", () => {
  const card = labelCard(of('l0label0'), LABEL as never)
  expect(card.kind).toBe('label')
  expect((card.rows as BarRow[]).map(r => [r.label, r.value])).toEqual([['proxy-link', 5191], ['none', 9400]])
  expect(card.label).toMatchObject({ slug: 'd9b51617', kind: 'regex', labeled: 14591, total: 14591, trial: false, paths: ['revisions.jsonl'] })
  expect(card.examples![0]).toMatchObject({ ref: 'revisions.jsonl#L10566', value: 'proxy-link', why: 'r.jina.ai link', set: false })
  expect(card.examples![1]).toMatchObject({ value: 'none', set: true })
  const lines = text('l0label0', 90)
  expect(lines.some(l => /proxy-link .*5,191/.test(l))).toBe(true)
  // a label card is a bar card of its counts: its records and their verdicts are the label panel's
  expect(lines.some(l => l.includes('agree'))).toBe(false)
  // before the label is read, a line that says so
  expect(labelCard(of('l0label0'), null).kind).toBe('note')
  // the counts with the analyst's verdicts, as the label panel shows them (live check term-fix6, new quirk 1: the card
  // kept the label's own counts after a verdict)
  const set = labelCard(of('l0label0'), { ...LABEL, verdicts: { counts: { none: 9401, 'proxy-link': 5190 }, set: 1 } } as never)
  expect((set.rows as BarRow[]).map(r => [r.label, r.value])).toEqual([['proxy-link', 5190], ['none', 9401]])
})

test('no card drawing shows a hex id', () => {
  for (const id of Object.keys(CELLS)) {
    const lines = text(id, 90).join('\n')
    expect(lines).not.toMatch(/\b(card|cell):[0-9a-f]{6,}/)
    expect(lines).not.toContain(id)
  }
})

test("a place reads in words: a file's line or lines, a row, a JSON list's item, a command's output; never `#L` or an id", () => {
  expect(placeWords('revisions.jsonl#L10566')).toBe('revisions.jsonl line 10566')
  expect(placeWords('README.md#L3-L8')).toBe('README.md lines 3-8')
  expect(placeWords('data.csv#row=12')).toBe('data.csv row 12')
  expect(placeWords('results.json#/runs/3')).toBe('results.json item 4')
  expect(placeWords('call:abc123#L2')).toBe("the command's output line 2")
  expect(placeWords('call:abc123')).toBe("the command's output")
})

test("a card's takeaway as thimble's links check left it: linked and contradicted citations by value and ref", () => {
  const links = linksOf({ id: 'x', verification: { links: { status: 'partial', checked: true, resolved: [{ value: '4579', ref: 'card:x#pages/TOTAL' }], broken: [{ value: '12', ref: 'a.csv#row=1', why: 'the place shows 13', source: '13' }] } } } as ThimbleCell)
  expect(links).toEqual({ pending: false, checked: true, ok: ['4579|card:x#pages/TOTAL'], broken: [{ key: '12|a.csv#row=1', why: 'the place shows 13', source: '13' }] })
  expect(linksOf({ id: 'y' } as ThimbleCell)).toBeUndefined()
})

test("a Markdown link to a card's output line (`card:<id>@out0#L8`, as main writes it for the terminal) is a citation, never a link with its place in parentheses", () => {
  const [c] = citations('at least [1,397](card:652e26ae@out0#L8) revisions')
  expect(c).toMatchObject({ display: '1,397', ref: 'card:652e26ae@out0#L8' })
  expect(plainCites('at least [1,397](card:652e26ae@out0#L8) revisions')).toBe('at least 1,397 revisions')
})

test("a text's citations as their shown words: the `[[…]]` form and the Markdown link main writes for the terminal; a web link stays", () => {
  expect(plainCites('It has [[4579|card:x#pages/TOTAL]] and [14,591](card:e11488a9#lines/revisions.jsonl) lines, see [the docs](https://example.com).')).toBe('It has 4579 and 14,591 lines, see [the docs](https://example.com).')
})

test("a bar card keeps the order its chart's label axis sorts: by the value with `-y` or `y`, a list, `descending`, a sort field; A to Z with none, as the browser draws it", () => {
  const rows = [{ wiki: 'dorfwiki', revisions: 6 }, { wiki: 'probier', revisions: 1013 }, { wiki: 'dse', revisions: 2994 }]
  const chart = (sort: unknown, horizontal = false) => {
    const lab = { field: 'wiki', type: 'nominal', ...(sort === undefined ? {} : { sort }) }
    const val = { field: 'revisions', type: 'quantitative' }
    const spec = { mark: 'bar', encoding: horizontal ? { y: lab, x: val } : { x: lab, y: val }, data: { values: rows } }
    return ((cardOfCell({ id: 'b1', kind: 'plot', title: 'q', outputs: [{ 'application/vnd.vegalite.v6.json': spec }] } as ThimbleCell).card.rows ?? []) as BarRow[]).map(r => r.label)
  }
  // the live check's chart: `sort: '-y'` puts dse first (New 1)
  expect(chart('-y')).toEqual(['dse', 'probier', 'dorfwiki'])
  expect(chart('y')).toEqual(['dorfwiki', 'probier', 'dse'])
  expect(chart('-x', true)).toEqual(['dse', 'probier', 'dorfwiki'])
  expect(chart(undefined)).toEqual(['dorfwiki', 'dse', 'probier'])
  expect(chart('descending')).toEqual(['probier', 'dse', 'dorfwiki'])
  expect(chart(['probier', 'dse'])).toEqual(['probier', 'dse', 'dorfwiki'])
  expect(chart(null)).toEqual(['dorfwiki', 'probier', 'dse'])
  expect(chart({ field: 'revisions', order: 'descending' })).toEqual(['dse', 'probier', 'dorfwiki'])
  expect(chart({ encoding: 'y' })).toEqual(['dorfwiki', 'probier', 'dse'])
  // the live check's chart: bars with their values written on them, a text layer on the same fields (`bars + labels`)
  const layered = { layer: [{ mark: { type: 'bar' }, encoding: { x: { field: 'wiki', sort: '-y', type: 'nominal' }, y: { field: 'revisions', type: 'quantitative' } } }, { mark: { type: 'text', dy: -6 }, encoding: { text: { field: 'revisions', type: 'quantitative' }, x: { field: 'wiki', sort: '-y', type: 'nominal' }, y: { field: 'revisions', type: 'quantitative' } } }], data: { name: 'd' }, datasets: { d: [{ wiki: 'dorfwiki', revisions: 6 }, { wiki: 'dse', revisions: 2994 }] } }
  const drawn = cardOfCell({ id: 'b2', kind: 'plot', title: 'q', outputs: [{ 'application/vnd.vegalite.v6.json': layered }] } as ThimbleCell).card
  expect(drawn.kind).toBe('bar')
  expect((drawn.rows as BarRow[]).map(r => r.label)).toEqual(['dse', 'dorfwiki'])
  // a layer of another kind (a rule, a line) is no bar card: a table of its rows
  const mixed = { ...layered, layer: [layered.layer[0], { mark: 'rule', encoding: { y: { field: 'revisions' } } }] }
  expect(cardOfCell({ id: 'b3', kind: 'plot', title: 'q', outputs: [{ 'application/vnd.vegalite.v6.json': mixed }] } as ThimbleCell).card.kind).toBe('table')
  // bars of one label stay together, summed for the sort
  const stacked = [{ wiki: 'a', n: 1, kind: 'x' }, { wiki: 'b', n: 5, kind: 'x' }, { wiki: 'a', n: 9, kind: 'y' }]
  expect(sortedBars(stacked, { x: { field: 'wiki', sort: '-y' }, y: { field: 'n' } }, 'x', 'wiki').map(r => `${r.wiki}${r.kind}`)).toEqual(['ax', 'ay', 'bx'])
})

test('text cut short has no space before `…`; a question in a row is cut at a word; shares side by side read in whole percent', () => {
  expect(cut('removed in under an hour', 12)).toBe('removed in…')
  expect(clip('Two of the three card checks', 8)).toBe('Two of…')
  expect(clip('short', 8)).toBe('short')
  expect(clip('Which five pages have the most revisions in the corpus?', 40)).toBe('Which five pages have the most…')
  expect(clip('What are the main events in the corpus, in order?', 40)).toBe('What are the main events in the corpus…')
  expect(clip('Supercalifragilisticexpialidocious-and-more', 20)).toBe('Supercalifragilisti…')
  // 6.6% beside 93% read 7% and 93%; a part under one percent keeps a decimal; a part that rounds to the whole is >99%
  expect([share(33, 500), share(467, 500)]).toEqual(['7%', '93%'])
  expect(share(3, 1000)).toBe('0.3%')
  expect(share(999, 1000)).toBe('>99%')
  expect(share(0, 10)).toBe('0%')
})

test("a label's example from a JSON record: the field the rule reads first, then the others; words that are no JSON object stay words", () => {
  const page = '{ "page_id": "dorfwiki/AgentOpenResearchDataJune18", "wiki": "dorfwiki", "name": "AgentOpenResearchDataJune18", "n_revs": 4, "labels": ["a", "b"] }'
  // the live check's code label reads `unit.get('name')` (New 13)
  const code = recordFields(page, { kind: 'code', spec: "import re\ndef label(unit):\n    return ('yes' if re.search(r'june', unit.get('name') or '', re.I) else 'no', 1.0)" })
  expect(code!.read).toEqual([['name', 'AgentOpenResearchDataJune18']])
  expect(code!.rest).toEqual([['page_id', 'dorfwiki/AgentOpenResearchDataJune18'], ['wiki', 'dorfwiki'], ['n_revs', '4']])
  expect(recordFields(page, { kind: 'code', spec: "unit['wiki'] == 'dse'" })!.read).toEqual([['wiki', 'dorfwiki']])
  // a pattern: the field it matches; a prompt: the fields it names
  expect(recordFields(page, { kind: 'regex', spec: 'Research' })!.read.map(r => r[0])).toEqual(['page_id', 'name'])
  expect(recordFields(page, { kind: 'prompt', spec: 'Is the page name about June?' })!.read.map(r => r[0])).toEqual(['name'])
  // a record cut short is read as far as it goes
  const cutShort = recordFields('{ "page_id": "dse/--help", "name": "--help", "n_revs": 19, "first_write": "2026-06-…', { kind: 'code', spec: "unit['name']" })
  expect(cutShort!.read).toEqual([['name', '--help']])
  expect(cutShort!.rest).toEqual([['page_id', 'dse/--help'], ['n_revs', '19']])
  expect(recordFields('SEC download https://r.jina.ai/x', { kind: 'regex', spec: 'jina' })).toBeNull()
})

test('one cut everywhere: at the last word that fits, mid-word only when that keeps less than half, no space or punctuation before `…`', () => {
  // live check New 3: `deleted on 1…`, `with a ca…`, `in o…`, `Can s…`
  expect(cut('The event log does not support the claim of 3,898 pages deleted on 16 June', 64)).toBe('The event log does not support the claim of 3,898 pages deleted…')
  expect(cut('How many delete events does events.jsonl have on 16 June? One number, with a card.', 80)).toBe('How many delete events does events.jsonl have on 16 June? One number, with a…')
  expect(cut('What did the organizer, the reviewer and the editor say in the agent chat, in order?', 80)).toBe('What did the organizer, the reviewer and the editor say in the agent chat, in…')
  expect(cut('organizer: Can someone check the deletion count?', 20)).toBe('organizer: Can…')
  // a word that ends where the room does is whole; one word longer than the room is cut inside it
  expect(cut('one two three', 8)).toBe('one two…')
  expect(cut('Supercalifragilistic', 8)).toBe('Superca…')
  // the cells of wide characters count twice
  expect(cut('四月 五月 六月', 10)).toBe('四月 五月…')
  expect(cut('四月 五月 六月', 9)).toBe('四月 五…')
  expect(clip('  a  b\n c ', 10)).toBe('a b c')
})

test('a context line keeps its value in view, each end cut at a word with `…` against the words', () => {
  const line = 'The organizer wrote that the review is closed, and then the reviewer said that all of the talk pages were read before anyone checked the count.'
  const at = line.indexOf('talk pages')
  const w = windowAt(line, at, 60)
  expect(w.text.startsWith('…')).toBe(true)
  expect(w.text.endsWith('…')).toBe(true)
  expect(w.text).not.toMatch(/… | …/)
  // the words at each end are whole
  const inner = w.text.slice(1, -1)
  expect(line).toContain(inner)
  expect(line[line.indexOf(inner) - 1]).toBe(' ')
  expect(/[\s,]/.test(line[line.indexOf(inner) + inner.length] ?? ' ')).toBe(true)
  // a position moves by `shift`
  expect(w.text.slice(at - w.shift, at - w.shift + 10)).toBe('talk pages')
})

test('words in quotation marks: straight, curly when they hold straight ones, none when they hold both', () => {
  expect(quoted('How many pages?')).toBe('"How many pages?"')
  expect(quoted('How many pages have "June" in their title?')).toBe('“How many pages have "June" in their title?”')
  expect(quoted('The reviewer\'s claim: "I counted" and “more”')).toBe('The reviewer\'s claim: "I counted" and “more”')
})

test("a table card's numbers take its columns' formats, as the browser's table writes them: `19,913`", () => {
  const card = cardOfCell(CELLS.a0frame0 as unknown as ThimbleCell).card
  expect(card.formats).toEqual({ records: ',d' })
  const lay = cardLayout(card, 60, -1)
  const text = lay.lines.map(l => l.map(s => s.s).join('')).join('\n')
  expect(text).toContain('19,913')
  expect(text).not.toContain('19913')
  // the value a click cites is the value shown; the row stays named by its label as the ref names it
  expect(lay.items.find(i => i.open === 'card:a0frame0#records/events.jsonl')?.cite).toBe('[[19,913|card:a0frame0#records/events.jsonl]]')
  expect(formatted(1446, ',d')).toBe('1,446')
  expect(formatted(1987, 'd')).toBe('1987')
  expect(formatted(0.12345, ',.3~f')).toBe('0.123')
  expect(formatted(2.5, ',.2~f')).toBe('2.5')
  expect(formatted(-1234.5, ',.1~f')).toBe('−1,234.5')
  expect(formatted(12, '.0%')).toBeNull()
})

test("the path row's steps are cut at a word", () => {
  const steps = fitCrumbs(['home', 'threads', '"How many delete events does events.jsonl have on 16 June? One number."', 'citation "I counted 3,898 pages deleted on 16 June"'], 70)
  for (const s of steps) if (s && s.endsWith('…')) expect(s).toMatch(/[A-Za-z0-9,"]…$/)
  const words = '"How many delete events does events.jsonl have on 16 June? One number." citation "I counted 3,898 pages deleted on 16 June"'.split(/\s+/)
  // each cut step ends with a whole word of its own
  for (const s of steps) if (s && s.endsWith('…')) expect(words.some(x => x.replace(/[?.,]+$/, '') === s.slice(0, -1).split(' ').at(-1))).toBe(true)
})

test('a cut keeps the closing quotation mark of the words it cuts: a path step, a card by its question', () => {
  expect(cut('thread "Which line of events.jsonl is the first delete event after the reviewer wrote this?"', 40)).toBe('thread "Which line of events.jsonl is…"')
  expect(cut('card “How many pages in pages.jsonl have "June" in their name?”', 30)).toBe('card “How many pages in…”')
  // too little room for the quoted words: cut as any words are
  expect(cut('documents › "The reviewer\'s claim"', 14)).toBe('documents ›…')
  const steps = fitCrumbs(['home', 'threads', '"Which line of events.jsonl is the first delete event after the reviewer wrote this?"'], 50)
  expect(steps.at(-1)).toMatch(/^"Which line of[^"]*…"$/)
  // quoted words inside a step's words, which go on after the closing mark, keep that mark (live check term-fix5, new
  // quirk 10: `… › citation card "How…`)
  const deep = fitCrumbs(['home', 'documents', '"The reviewer\'s count of 3,898…"', 'citation card "How many saves and deletions does…" output line 1'], 60)
  expect(deep.at(-1)).toMatch(/^citation card "How[^"]*…"$/)
  expect(cut('card “How many saves and deletions” output line 1', 20)).toBe('card “How many…”')
})

test("a label example's fields cut at whole pairs, never `·…` or a key without its value; a file's JSON line at the cell edge", () => {
  const pairs = ['n_revs 19', 'n_revs_before 0', 'page_key dorfwiki/AgentDataUSAProbeFebX2']
  // the pairs left out counted (`+1`), never a `…` against a whole value, which reads as a cut one (`n_revs_before 0…`)
  expect(itemsRow(pairs, 34)).toBe('n_revs 19 · n_revs_before 0 · +1')
  expect(itemsRow(pairs, 30)).toBe('n_revs 19 · +2')
  expect(itemsRow(pairs, 30)).not.toMatch(/\d…$/)
  expect(itemsRow(pairs, 200)).toBe(pairs.join(' · '))
  expect(itemsRow(['page_key dorfwiki/AgentDataUSAProbeFebX2'], 20)).toBe('page_key dorfwiki/A…')
  expect(cut('n_revs 19 · n_revs_before 0 · page_key x', 30)).not.toMatch(/·…$/)
  const json = '{"page_id": "dorfwiki/AgentDataUSAProbeFebX2", "page_key": "dorfwiki/AgentDataUSAProbeFebX2", "n_revs": 19}'
  // at the cell edge, never a space or a sentence's punctuation right before the `…` (live check term-fix9, low quirk:
  // `Some …`, `alone.…`)
  expect(cutLine(json, 60)).toBe(`${json.slice(0, 58)}…`)
  expect(cutLine('{"text": "Some words stand alone. Others go on and on"}', 15)).toBe('{"text": "Some…')
  expect(cutLine('{"text": "It stood alone. Then more"}', 26)).toBe('{"text": "It stood alone…')
  expect(cutLine('Words of a Markdown file run on past the room they have here', 30)).toBe(cut('Words of a Markdown file run on past the room they have here', 30))
})

test("a place cited with a passage of its line reads as its line; a chip names its place short, a card `card`, a file's line by the file's name and the line", () => {
  // live check term-fix5, new quirks 3 and 4: `↗ agent-chat.jsonl#L2.b0:c0-120`, and `card L1`
  expect(placeWords('collusion-wiki/agent-chat.jsonl#L2.b0:c0-120')).toBe('collusion-wiki/agent-chat.jsonl line 2')
  expect(placeWords('collusion-wiki/agent-chat.jsonl#L2.b1')).toBe('collusion-wiki/agent-chat.jsonl line 2')
  // a chip (Matt, 2026-10-07): `[ card ]`, `[ events.jsonl line 12 ]`, `[ label name ]`; never `agent-chat:2`, which
  // reads as an id (live check term-fix9, low quirk)
  const chip = (ref: string) => chipLabel({ raw: `[[${ref}]]`, ref, display: null })
  expect(chip('agent-chat.jsonl#L2.b0:c0-120')).toBe('[ agent-chat.jsonl line 2 ]')
  expect(chip('events.jsonl#L12')).toBe('[ events.jsonl line 12 ]')
  expect(chip('agent-chat.jsonl#L1-L2')).toBe('[ agent-chat.jsonl lines 1-2 ]')
  expect(chip('data/runs.json#/runs/3')).toBe('[ runs.json item 4 ]')
  expect(chip('README.md')).toBe('[ README.md ]')
  // a long name cut in its middle, its line kept, the chip short
  const long = chip('a/collusion-wiki-revisions-of-every-page.jsonl#L10879')
  expect(long).toMatch(/^\[ collus\S*…\S*-page\.jsonl line 10879 \]$/)
  expect(width(long)).toBeLessThanOrEqual(CHIP_MAX + 4)
  expect(chip('card:c0ffee00')).toBe('[ card ]')
  expect(chip('card:c0ffee00#wiki/dse')).toBe('[ card ]')
  expect(chip('card:c0ffee00@out0#L1')).toBe('[ card output line 1 ]')
  expect(chip('card:c0ffee00@out0#L1-L3')).toBe('[ card output lines 1-3 ]')
  expect(chip('call:a1b2c3#L4')).toBe('[ output line 4 ]')
  expect(chip('report:report#4255ef27')).toBe('[ report ]')
  expect(chip('report:slides')).toBe('[ slides ]')
  expect(chip('concept:eb534ca4')).toBe('[ label ]')
  noteLabelName('eb534ca4', 'edit purpose')
  expect(chip('concept:eb534ca4')).toBe('[ edit purpose ]')
  expect(chip('concept:eb534ca4/yes')).toBe('[ edit purpose · yes ]')
  // a citation with words is its words, a chip or not
  expect(chipLabel({ raw: '[[3|card:c0ffee00#n/all]]', ref: 'card:c0ffee00#n/all', display: '3' })).toBe('3')
})

test('a chip reads as `[ card ]` in plain words too, as the reply draws it, without brackets main put around it', () => {
  // Matt, 2026-10-07: a chip is its own kind of citation, alike everywhere; live check term-fix5, item 6: the New thread
  // preview read `…deletion claim" card "How…`
  noteQuestion('ab12cd34', 'How many deletions per day?')
  expect(plainCites('The 16 June deletion claim holds up [[card:ab12cd34]].')).toBe('The 16 June deletion claim holds up [ card ].')
  expect(plainCites('See ([[card:ab12cd34]]).')).toBe('See [ card ].')
  expect(plainCites('See ( [↗](events.jsonl#L12) ) for it.')).toBe('See [ events.jsonl line 12 ] for it.')
  expect(plainCites('[[card:ab12cd34]] says so.')).toBe('[ card ] says so.')
  // words in brackets that hold more than the chip keep them
  expect(plainCites('(as [[card:ab12cd34]] shows)')).toBe('(as [ card ] shows)')
  expect(plainCites('It has [[3|card:ab12cd34#n/all]] rows.')).toBe('It has 3 rows.')
  // a place alone, written as main writes it for the terminal (`[↗](ref)`), a card's printed line too
  expect(plainCites('That is out of 500 pages [↗](card:ab12cd34).')).toBe('That is out of 500 pages [ card ].')
  expect(plainCites('It began on 18 June [↗](card:c0ffee00@out0#L1). That is all.')).toBe('It began on 18 June [ card output line 1 ]. That is all.')
  expect(plainCites('See [[README.md#L5]] for the format.')).toBe('See [ README.md line 5 ] for the format.')
  expect(plainCites('It has [3](card:ab12cd34#n/all) rows and [33](concept:9e40be16/yes) yes.')).toBe('It has 3 rows and 33 yes.')
  // a tool's own words in Claude Code's rows: the chip's words, with no brackets
  expect(plainCites('as line 12 says [↗](events.jsonl#L12).', false)).toBe('as line 12 says events.jsonl line 12.')
})


test('a date in words is in a text that writes it in words too, as the backend reads it: the same day and month, the year and the time when both give one', () => {
  // live check term-fix9, quirk 11 (backend cite.date_in)
  for (const [display, text] of [['23 June', '23 June'], ['June 23', 'busiest on 23 June'], ['30 June', 'last delete on 30 June'], ['30 June 2026 at 22:47 UTC', '30 June 2026 at 22:47:51 UTC'], ['23 June', '2026-06-23']]) {
    expect(dateIn(display!, text!)).toBe(true)
    expect(valueIn(display!, text!)).toBe(true)
  }
  for (const [display, text] of [['23 June', '24 June'], ['30 June 2025', '30 June 2026'], ['30 June 2026 at 21:00', '30 June 2026 at 22:47:51 UTC'], ['3 May', 'it 3 may fail']]) expect(dateIn(display!, text!)).toBe(false)
  // the citation panel marks the date in words where the line writes it
  expect(dateSpans('23 June', 'alpha started on 23 June at 10:53')).toEqual([[17, 33]])
  expect(dateSpans('23 June', 'gamma, 24 June; alpha, 23 June.')).toEqual([[23, 30]])
})

test('a row cut in its middle keeps its end; a quoted name with a short tail cut inside its marks, the tail kept; a line of data cut at the cell edge', () => {
  // live check term-fix9, quirk 8 and low quirks
  const q = 'How many deletes does events.jsonl record in each hour (UTC) of 27 June?'
  expect(cutMiddle(q, 40)).toBe('How many deletes does… (UTC) of 27 June?')
  expect(cutMiddle(q, 200)).toBe(q)
  expect(cutMiddle(q, 24)).toBe('How many… of 27 June?')
  expect(cutMiddle(q, 12)).toBe(cut(q, 12))
  expect(cut('card "How many deletes does events.jsonl record on each day?" · code', 34)).toBe('card "How many deletes…" · code')
  const json = '{"label": "A2Research17817720", "stored_revisions": 12, "first": "2026-06-23"}'
  const a = windowAt(json, 40, 30)
  const b = windowAt(json, 60, 30)
  expect(a.text.length).toBe(30)
  expect(b.text.length).toBe(30)
  expect(json.slice(a.shift + 1, a.shift + 5)).toBe(a.text.slice(1, 5))
})

test('key hints wrap at whole hints, never cut; the path fits its room', () => {
  // live check term-fix9, quirks 3 and 5
  const rows = hintLines(['↑↓ to choose', 'Enter to open', 'Space to fold', 'b to go back', 'x to close'], 41).map(l => l.map(x => x.s).join(''))
  expect(rows).toEqual(['↑↓ to choose · Enter to open', 'Space to fold · b to go back · x to close'])
  expect(hintLines(['x to close'], 40)).toHaveLength(1)
  for (const room of [4, 8, 14, 20, 30]) {
    const fitted = fitCrumbs(['home', 'files', 'collusion-wiki/labels.jsonl'], room)
    expect(crumbsWidth(fitted)).toBeLessThanOrEqual(room)
    expect(fitted[0]).toBe('home')
  }
})

test("a label's state in words: a run going, a first run stopped part way, none, or a run that ended", () => {
  // live check term-fix9, quirk 4
  const agents = [{ label: 'label says probe', state: 'running', role: 'labels' }]
  const midway = { name: 'says probe', last_run: null, applications: [], label_stats: { n_labeled: 3000, counts: { yes: 1000, no: 2000 } }, scope_total: 4579 }
  expect(labelStateWords(labelState(midway, agents))).toBe('◌ labeling 3,000 of 4,579')
  expect(labelStateWords(labelState(midway, []))).toBe('stopped at 3,000 of 4,579')
  expect(labelStateWords(labelState({ ...midway, scope_total: undefined }, []))).toBe('stopped at 3,000')
  expect(labelStateWords(labelState({ ...midway, label_stats: { n_labeled: 0, counts: {} } }, []))).toBe('not run yet')
  expect(labelStateWords(labelState({ ...midway, label_stats: { n_labeled: 0, counts: {} } }, agents))).toBe('◌ labeling')
  const ran = { ...midway, last_run: { total: 4579, matched_total: 4579, labeled: 4579, status: 'done' } }
  expect(labelState(ran, []).ran).toBe(true)
  expect(labelStateWords(labelState(ran, []))).toBe('')
  // the label card of one stopped part way: its counts, and where it stopped
  const card = labelCard({ ...(CELLS.l0label0 as unknown as ThimbleCell) }, { ...LABEL, last_run: null, applications: [], label_stats: { n_labeled: 3150, counts: { none: 2100, 'proxy-link': 1050 } }, scope_total: 4579 } as never)
  expect(card.note).toBe('stopped at 3,150 of 4,579')
  expect((card.rows ?? []).length).toBe(2)
  expect(cardLayout(card, 60, -1).lines.map(l => l.map(x => x.s).join('')).at(-1)).toBe('stopped at 3,150 of 4,579')
})
