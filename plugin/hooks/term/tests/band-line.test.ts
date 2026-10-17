// The thimble line above the prompt (band.tsx, the owner's design of 10-16, the look of mock3/line2 A3 with A2's hover):
// after activation and while thimble is on, six items in a fixed order (cards, threads, citations, labels, checks,
// coverage), each `name value`, the item of a feature that is off left out; `thimble` bold, in the accent and
// underlined, whose press opens home; names in the accent, values bold in the text color, a bold purple `•` after the
// value of an item with something new (cleared when its section opens), citations' purple `◌` while checked; under the
// pointer the selection background on an item and the cell after it, its name underlined, no inverse; items three cells
// apart where all fit so, else two, the zero items cut first and an item with a `•` or a failure last. Above it, the
// tray's other rows, one line each: a dim label column, the words cut with `…` where the acts begin (a press shows them
// whole), the acts at the right in the accent, underlined under the pointer, the main one bold. `claude plugin test
// plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { ABOVE_LABEL, ACT_GAP, LINE_LABEL_W, MIN_WORDS, actsWidth, fitItems, percent, wordsRoom } from '../band'
import { cid, cut, width } from '../lib'
import { COLORS } from '../paint'
import { remoteWords } from '../offramp'
import { CWD, PANEL, SUMMARY, WS, aboveAt, comment, featuresOff, paneAt, panelWorld, pressBrowser, shown, words } from './fixtures-panel'
import type { PanelWorld } from './fixtures-panel'

type M = Mounted<'terminal'>
type E = Engine

async function start($: E, w: PanelWorld): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

async function band($: E, columns = 120): Promise<M> {
  return (await $.ui.mount(aboveAt(columns))) as unknown as M
}

/** The line's words, or '' when it does not show. */
async function line(m: M): Promise<string> {
  const row = await m.find({ type: 'Box', key: 'above-summary' })
  return row ? words(row) : ''
}

type Node = { type?: string; key?: unknown; props?: Record<string, unknown> & { key?: unknown; children?: unknown }; hover?: unknown; children?: unknown[] }
const keyOf = (k: unknown) => String((k as Node).key ?? (k as Node).props?.key ?? '')

/** The line's row of presses: `thimble`'s, each item's (each in its keyed Box with the cell after it), then the `…`. */
async function presses(m: M): Promise<Node> {
  const row = (await m.find({ type: 'Box', key: 'above-summary' })) as unknown as { children: Node[] }
  return row.children[1]!
}

/** The items the line draws, by key, in order; `cut` for the `…` that ends a line cut short. */
async function keys(m: M): Promise<string[]> {
  const row = await presses(m)
  return (row.children ?? [])
    .filter(Boolean)
    .map(k => (keyOf(k).startsWith('above-summary-lit-') ? keyOf(k).slice('above-summary-lit-'.length) : words(k) === '…' ? 'cut' : '?'))
    .filter(k => k !== 'thimble')
}

/** An item's runs of words and their looks, as its Button draws them. */
type Look = { s: string; color?: string; bold?: boolean; dim?: boolean; underline?: boolean; hover?: unknown }
async function looks(m: M, key: string): Promise<Look[]> {
  const out: Look[] = []
  const walk = (n: unknown) => {
    if (typeof n === 'string') out.push({ s: n })
    else if (Array.isArray(n)) n.forEach(walk)
    else if (n && typeof n === 'object') {
      const o = n as { type?: string; props?: { color?: string; bold?: boolean; dimColor?: boolean; underline?: boolean; children?: unknown }; hover?: unknown; children?: unknown }
      if (o.type === 'Text') {
        const s = words(o)
        const p = o.props
        out.push({ s, ...(p?.color ? { color: p.color } : {}), ...(p?.bold ? { bold: true } : {}), ...(p?.dimColor ? { dim: true } : {}), ...(p?.underline ? { underline: true } : {}), ...(o.hover ? { hover: o.hover } : {}) })
      } else walk(o.children ?? o.props?.children)
    }
  }
  const b = (await m.find({ type: 'Button', key: `above-summary-${key}` })) as unknown as { children?: unknown; props?: { children?: unknown } } | undefined
  if (b) walk(b.children ?? b.props?.children)
  return out.filter(x => x.s !== '')
}

/** The workspace changed on disk: the session's timer reads it again. */
async function changed(w: PanelWorld, dir: string): Promise<void> {
  w.stamps.set(`${WS}/${dir}`, (w.stamps.get(`${WS}/${dir}`) ?? 1) + 1)
  await w.clock.advance(1100)
  await w.clock.settle()
}

const CHAT = '[[4579|README.md#L3]]'
const BAD = '[[99|README.md#L99]]'
const DOT = { s: '•', color: COLORS.cite, bold: true }
/** A name: in the accent, underlined under the pointer; a zero item's dim. */
const NAME = (s: string) => ({ s, color: COLORS.accent, hover: { underline: true } })
const DIM_NAME = (s: string) => ({ s, dim: true, hover: { underline: true } })

test('after activation the line shows six items in order, `name value`, three cells apart, with no `open ›` and no `dismiss`; `thimble` bold, accent and underlined; names in the accent, values bold, `N failed` two cells after, a zero item dim whole; nothing is new at activation', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  w.t.citeIndex = [
    { id: 'c1', raw: CHAT, display: '4579', ref: 'README.md#L3', row: 'r1', at: 1 },
    { id: 'c2', raw: BAD, display: '99', ref: 'README.md#L99', row: 'r1', at: 2 },
  ]
  w.t.verdicts = { [cid(CHAT)]: { status: 'ok' }, [cid(BAD)]: { status: 'missing' } }
  w.t.coverageSummary = SUMMARY
  await start($, w)
  const m = await band($, 184)
  expect(await keys(m)).toEqual(['cards', 'threads', 'citations', 'labels', 'checks', 'coverage'])
  // each press's words and the cell after them (the gap's first cell, lit with them under the pointer)
  expect(await line(m)).toBe('  thimble cards 12 threads 2 citations 2  1 failed labels 1 checks 0 coverage 15% ')
  expect(await m.find({ type: 'Button', key: 'above-summary-open' })).toBeUndefined()
  expect(await m.find({ type: 'Button', key: 'above-summary-dismiss' })).toBeUndefined()
  // three cells from the end of one's words to the next one's: the lit cell and two more
  expect((await presses(m)).props?.columnGap).toBe(2)
  // `thimble` bold, in thimble's accent and underlined
  expect(await looks(m, 'thimble')).toEqual([{ s: 'thimble', color: COLORS.accent, bold: true, underline: true }])
  // the name in the accent, the value bold in the text color, no `•` at activation
  expect(await looks(m, 'cards')).toEqual([NAME('cards'), { s: ' ' }, { s: '12', bold: true }])
  // `1 failed` bold red, two cells after the count
  expect(await looks(m, 'citations')).toEqual([NAME('citations'), { s: ' ' }, { s: '2', bold: true }, { s: '  ' }, { s: '1 failed', color: COLORS.problem, bold: true }])
  // a zero item dim whole
  expect(await looks(m, 'checks')).toEqual([DIM_NAME('checks'), { s: ' ' }, { s: '0', dim: true }])
  await m.unmount()
  // under 1%: a decimal kept
  w.t.coverageSummary = { ...SUMMARY, size: { read: 30_000, searched: 0, total: 14_000_000 } }
  const m1 = await band($, 184)
  expect(await line(m1)).toContain(`coverage ${percent(30_000, 14_000_000)}`)
  expect(percent(30_000, 14_000_000)).toBe('0.2%')
  await m1.unmount()
  // no index yet (no size): the files read
  w.t.coverageSummary = { ...SUMMARY, records: { seen: 0, total: 0, counted: false }, size: null }
  const m2 = await band($, 184)
  expect(await line(m2)).toContain('coverage 3 of 13 files')
  await m2.unmount()
  // nothing read yet: `coverage 0%`, dim whole
  w.t.coverageSummary = null
  const m3 = await band($, 184)
  expect(await looks(m3, 'coverage')).toEqual([DIM_NAME('coverage'), { s: ' ' }, { s: '0%', dim: true }])
  await m3.unmount()
})

test('nothing is new when `/thimble` turns thimble on and opens home before its first read of the workspace', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on, { active: false } as never)
  w.t.answerComments = [comment('c1')]
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  await w.clock.advance(1100)
  await w.clock.settle()
  const m = await band($, 184)
  expect(await line(m)).toBe('  thimble cards 12 threads 2 citations 0 labels 1 checks 1 coverage 0% ')
  await m.unmount()
})

test('bug hunt J9: until the session reads the workspace, the line says `…` for its counts, never 0', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  let release = () => {}
  w.holdState.home = new Promise<void>(r => (release = r))
  await start($, w)
  await w.clock.advance(1100)
  let m = await band($, 184)
  const before = await line(m)
  expect(before).toContain('cards …')
  expect(before).toContain('labels …')
  expect(before).not.toMatch(/cards 0|labels 0|threads 0/)
  await m.unmount()
  release()
  await w.clock.settle()
  await w.clock.advance(1100)
  await w.clock.settle()
  m = await band($, 184)
  expect(await line(m)).toContain('cards 12 threads 2')
  await m.unmount()
})

test('bug hunt J9: home opened before the cards are read says so, never `Cards (0)  none`', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  let release = () => {}
  w.holdState.cards = new Promise<void>(r => (release = r))
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  let pane = (await $.ui.mount(paneAt(96, 60))) as unknown as M
  const rows = (((await pane.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []).map(r => shown(r).trim())
  const at = rows.indexOf('Cards')
  expect(at).toBeGreaterThan(0)
  expect(rows[at + 1]).toBe('◌ reading')
  expect(rows.join('\n')).not.toContain('Cards (0)')
  await pane.unmount()
  release()
  await w.clock.settle()
  await w.clock.advance(1100)
  await w.clock.settle()
  pane = (await $.ui.mount(paneAt(96, 60))) as unknown as M
  const after = (((await pane.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []).map(r => shown(r).trim())
  expect(after.some(r => /^Cards \(\d+\)/.test(r))).toBe(true)
  expect(after).not.toContain('◌ reading')
  await pane.unmount()
})

test("citations count the session's answers' and its cards' takeaways' citations: a purple `◌` while any is checked, no mark for those that checked out", { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  w.t.citeIndex = [{ id: 'c1', raw: CHAT, display: '4579', ref: 'README.md#L3', row: 'r1', at: 1 }]
  await start($, w)
  // one chat citation, not checked yet
  const m = await band($, 184)
  expect(await looks(m, 'citations')).toEqual([NAME('citations'), { s: ' ' }, { s: '1', bold: true }, { s: ' ' }, { s: '◌', color: COLORS.cite }])
  await m.unmount()
  // checked: the `◌` goes, no mark in its place
  // a card shown in the session: its takeaway's two citations count too, checked as the card draws them (found here)
  w.t.verdicts = { [cid(CHAT)]: { status: 'ok' }, [cid('[[4579|card:ff73e071#pages/TOTAL]]')]: { status: 'ok' }, [cid('[[14592|card:ff73e071#revisions/TOTAL]]')]: { status: 'ok' } }
  await $.command.run({ command: 'thimble:thimble', args: 'card ff73e071' } as never)
  await w.clock.settle()
  const m1 = await band($, 184)
  expect(await line(m1)).toContain('citations 3 labels')
  expect(await looks(m1, 'citations')).toEqual([NAME('citations'), { s: ' ' }, { s: '3', bold: true }])
  await m1.unmount()
})

test('a feature that is off leaves its item out: citation marks, labels, checks, coverage; cards and threads stay, so the line stays while thimble is on', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  w.t.coverageSummary = SUMMARY
  await start($, w)
  const on1 = await band($)
  expect(await keys(on1)).toEqual(['cards', 'threads', 'citations', 'labels', 'checks', 'coverage'])
  await on1.unmount()
  w.t.settings = featuresOff('citationMarks', 'coverage', 'labels', 'checks')
  const off = await band($)
  expect(await keys(off)).toEqual(['cards', 'threads'])
  expect(await line(off)).toBe('  thimble cards 12 threads 2 ')
  await off.unmount()
})

test('labels counts the labels, not the records they could not place; refreshSummary still reads those for the Labels view', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  await start($, w)
  const m = await band($)
  w.unsure = [{ id: 'd9b51617', name: 'links through a fetch proxy', noFit: 4, unsure: 3, total: 7, rows: [] }]
  await changed(w, 'concepts')
  expect(await line(m)).toContain('labels 1 checks')
  expect(await line(m)).not.toContain('unsure')
  expect(w.calls.some(c => c[1] === 'state' && c[2] === 'label-unsure' && c.includes('--counts'))).toBe(true)
  await m.unmount()
})

test('a label made elsewhere reaches the thimble line and the labels list within seconds, while a pass of the refresh loop still runs (bug hunt D4)', { timeoutMs: 30_000 }, async ($, on) => {
  // bug hunt D4: a sub-label the orientation made, and labels made in the browser, reached the terminal minutes late
  const w = panelWorld(on)
  await start($, w)
  const m = await band($)
  await m.press({ key: 'above-summary-labels' })
  await w.clock.settle()
  expect(await line(m)).toContain('labels 1 ')
  // a pass of the refresh loop that does not end soon: its read of the agents waits, as a read does while labels run
  let release: () => void = () => undefined
  w.holdState.agents = new Promise<void>(r => (release = r))
  w.stamps.set(`${WS}/chats`, 5)
  await w.clock.advance(1100)
  // a label made elsewhere, in the browser or by the orientation
  w.states.labels = [...w.states.labels, { ...w.states.labels[0]!, id: 'e1sub000', name: 'coordinated saves' }] as never
  w.states.home = { ...w.states.home, labels: 2 }
  w.stamps.set(`${WS}/concepts/e1sub000.json`, 3)
  await w.clock.advance(2100)
  expect(await line(m)).toContain('labels 2 ')
  const pane = (await $.ui.mount(paneAt(96))) as unknown as M
  expect(words(await pane.drawn())).toContain('2 labels')
  expect(shown(await pane.drawn({ in: 'm:labels-list' }))).toContain('coordinated saves')
  await pane.unmount()
  release()
  await w.clock.advance(1100)
  await w.clock.settle()
  await m.unmount()
})

test('a bold purple `•` follows the value of cards, labels and checks with something new; it clears when the item is pressed or the panel shows its section', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  await start($, w)
  // two new cards, a new label, a new check comment; a new document and a new view are not on the line
  w.states.home = { ...w.states.home, cards: 14, labels: 2, views: 1, docs: { ...w.states.home.docs, slides: { exists: true, title: 'The relay in two slides' } } } as never
  w.t.answerComments = [comment('c1')]
  await changed(w, 'notebooks')
  const m = await band($)
  expect(await line(m)).toBe('  thimble cards 14 • threads 2 citations 0 labels 2 • checks 1 • coverage 0% ')
  expect(await looks(m, 'cards')).toEqual([NAME('cards'), { s: ' ' }, { s: '14', bold: true }, { s: ' ' }, DOT])
  expect(await line(m)).not.toContain('new')
  expect(await line(m)).not.toContain('documents')
  expect(await line(m)).not.toContain('views')
  // the labels' item opens the labels list, and its `•` clears
  await m.press({ key: 'above-summary-labels' })
  await w.clock.settle()
  expect(w.opened.at(-1)).toBe(PANEL)
  expect(await line(m)).toContain('labels 2 checks 1 •')
  // the checks' item opens the Checks view, and its `•` clears
  await m.press({ key: 'above-summary-checks' })
  await w.clock.settle()
  expect(await line(m)).toContain('checks 1 coverage')
  // the cards' item opens home, and its `•` clears
  await m.press({ key: 'above-summary-cards' })
  await w.clock.settle()
  expect(await line(m)).toBe('  thimble cards 14 threads 2 citations 0 labels 2 checks 1 coverage 0% ')
  // a card that arrives after shows its `•`; home shown by another way (the panel's own open) clears it too
  w.states.home = { ...w.states.home, cards: 15 }
  await changed(w, 'notebooks')
  expect(await line(m)).toContain('cards 15 •')
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  expect(await line(m)).toContain('cards 15 threads')
  await m.unmount()
})

test('`thimble` opens the panel at home, as `open ›` did, and clears the cards\' `•`', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  await start($, w)
  w.states.home = { ...w.states.home, cards: 14 }
  await changed(w, 'notebooks')
  const m = await band($)
  expect(await line(m)).toContain('cards 14 •')
  const before = w.opened.length
  await m.press({ key: 'above-summary-thimble' })
  await w.clock.settle()
  expect(w.opened.length).toBeGreaterThan(before)
  expect(w.opened.at(-1)).toBe(PANEL)
  // the panel shows home: the cards' `•` clears (the panel showing home marks the cards seen)
  expect(await line(m)).toContain('cards 14 threads')
  await m.unmount()
})

test('under the pointer a press keeps its look (no background, no inverse) and only its name underlines', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  w.t.coverageSummary = SUMMARY
  await start($, w)
  const m = await band($, 184)
  // (a found element's own hover is not in what find hands back: each is read from the row that holds it)
  const lits = ((await presses(m)).children ?? []).filter(Boolean) as Node[]
  expect(lits.map(keyOf)).toEqual(['thimble', 'cards', 'threads', 'citations', 'labels', 'checks', 'coverage'].map(k => `above-summary-lit-${k}`))
  for (const lit of lits) {
    // a keyed Box with no hover look of its own (no background): the Button, then the one cell after its words
    expect(lit.hover).toBeUndefined()
    const kids = (lit.children ?? []).filter(Boolean) as Node[]
    expect(kids.map(k => k.type)).toEqual(['Button', 'Text'])
    expect(words(kids[1])).toBe(' ')
    // the Button keeps its look under the pointer, no inverse; the focus still inverts it
    expect(kids[0]!.hover).toEqual({ inverse: false })
  }
  // the name underlines under the pointer; the value and the marks do not
  const cards = await looks(m, 'cards')
  expect(cards[0]!.hover).toEqual({ underline: true })
  expect(cards.slice(1).some(x => x.hover)).toBe(false)
  await m.unmount()
})

test('fitItems keeps every item 3 apart when all fit so, else 2 apart; else the zero items go first, then the others from the end, an item with a `•` or a failure last, and `…` ends the line', () => {
  const it = (s: string, o: { zero?: boolean; keep?: boolean } = {}) => ({ segs: [{ s }], zero: false, keep: false, ...o })
  const cards = it('cards 12 •', { keep: true })
  const threads = it('threads 2')
  const cites = it('citations 18  1 failed', { keep: true })
  const labels = it('labels 0', { zero: true })
  const checks = it('checks 2 •', { keep: true })
  const coverage = it('coverage 15%')
  const items = [cards, threads, cites, labels, checks, coverage]
  const sum = 10 + 9 + 22 + 8 + 10 + 12
  // each item a gap past the one before, the first a gap past `thimble` (room is the width less LINE_LABEL_W)
  expect(fitItems(items, sum + 6 * 3)).toEqual({ shown: items, cut: false, gap: 3 })
  // one cell short of 3 apart: 2 apart, every item kept
  expect(fitItems(items, sum + 6 * 3 - 1)).toEqual({ shown: items, cut: false, gap: 2 })
  const all = sum + 6 * 2
  expect(fitItems(items, all)).toEqual({ shown: items, cut: false, gap: 2 })
  // one cell short of 2 apart: the zero item goes first, `…` a gap after the last item
  expect(fitItems(items, all - 1)).toEqual({ shown: [cards, threads, cites, checks, coverage], cut: true, gap: 2 })
  // then the plain items from the end: coverage (one cell short of the five and the `…`), then threads
  expect(fitItems(items, 10 + 9 + 22 + 10 + 12 + 5 * 2 + 2 - 1).shown).toEqual([cards, threads, cites, checks])
  expect(fitItems(items, 10 + 22 + 10 + 3 * 2 + 2).shown).toEqual([cards, cites, checks])
  // the items with a `•` or a failure only when nothing else is left, from the end
  expect(fitItems(items, 10 + 22 + 2 * 2 + 2).shown).toEqual([cards, cites])
  expect(fitItems(items, 3)).toEqual({ shown: [], cut: true, gap: 2 })
  expect(LINE_LABEL_W).toBe('  thimble '.length)
  expect(percent(0, 10)).toBe('0%')
  // the Coverage view's forms (coverageview.tsx percent): a share below 1% keeps one decimal, cut (owner's notes, 10-16)
  expect(percent(1, 1000)).toBe('0.1%')
  expect(percent(25, 1000)).toBe('3%')
})

// ------------------------------------------------------------------------------------------------ the tray's rows

const OFFER = {
  slug: 'page-histories',
  name: 'Page Histories',
  description: "Each wiki page as a strip of its saves over time, colored by the agent that saved it, so you can see which agents edited a page together and when its content settled.",
  task: 'Find out when the agents edited together.',
  claims: ['revisions.jsonl'],
}
const OFFER_ACTS = ['build it', "don't build it", 'stop suggesting pages', 'dismiss']

/** The Text runs inside an element, each with its look. */
function texts(n: unknown, out: { s: string; color?: unknown; bold?: unknown; dim?: unknown; hover?: unknown; wrap?: unknown }[] = []): typeof out {
  if (Array.isArray(n)) n.forEach(x => texts(x, out))
  else if (n && typeof n === 'object') {
    const o = n as Node & { hover?: unknown }
    const kids = [o.children ?? o.props?.children].flat()
    // a Text that holds Texts: each of its runs (its strings plain)
    if (o.type === 'Text' && kids.some(k => (k as Node | null)?.type === 'Text')) kids.forEach(k => (typeof k === 'string' ? out.push({ s: k }) : texts(k, out)))
    else if (o.type === 'Text') out.push({ s: words(o), color: o.props?.color, bold: o.props?.bold, dim: o.props?.dimColor, hover: o.hover ?? o.props?.hover, wrap: o.props?.wrap })
    else texts(o.children ?? o.props?.children, out)
  }
  return out
}

test("the view proposal says what the analyst gets: `view` dim, `thimble can build a page for these records:` and the name bold, its acts saying what they do at the right in the accent (`build it` bold), and what the page would show whole and wrapped under it", { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  w.states.home = { ...w.states.home, offer: OFFER } as never
  await start($, w)
  for (const cols of [150, 100]) {
    const m = await band($, cols)
    const row = await m.find({ type: 'Box', key: 'above-offer' })
    expect(ABOVE_LABEL).toBe(17)
    // the whole description, never cut (the owner, 10-17)
    expect(words(row)).toContain(OFFER.description)
    expect(words(row)).not.toContain('…')
    expect(await m.find({ type: 'Box', key: 'above-offer-desc' })).toBeDefined()
    const looks = texts(row)
    expect(looks[0]).toMatchObject({ s: '  view', dim: true })
    expect(words(row)).toContain('thimble can build a page for these records: Page Histories')
    expect(looks.find(l => l.s === 'Page Histories')).toMatchObject({ bold: true, hover: { underline: true } })
    expect(looks.find(l => l.s === 'build it')).toMatchObject({ color: COLORS.accent, bold: true, hover: { underline: true } })
    // the words whole on their row: at 100 columns the acts take a row of their own under the words
    const ownActs = await m.find({ type: 'Box', key: 'above-offer-own-acts' })
    if (cols === 100) expect(words(ownActs)).toBe(`  ${OFFER_ACTS.join('')}`)
    else expect(ownActs).toBeUndefined()
    for (const a of OFFER_ACTS.slice(1)) {
      expect(looks.find(l => l.s === a)).toMatchObject({ color: COLORS.accent, hover: { underline: true } })
      expect(looks.find(l => l.s === a)!.bold).toBeUndefined()
    }
    expect(await m.find({ type: 'Box', key: 'above-offer-files' })).toBeUndefined()
    await m.unmount()
  }
})

test("a viewer of a file type shows its files on the name's press; why accept could not start is one red row under it; on a narrow band the acts take a row of their own", { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  const refused = 'the view builder could not start: thimble server is not running. Run `thimble server restart` in a shell, then press accept again.'
  w.states.home = { ...w.states.home, offer: { ...OFFER, task: '', claims: ['**/*.vtt'], refused } } as never
  await start($, w)
  const m = await band($, 100)
  expect(await m.find({ type: 'Box', key: 'above-offer-files' })).toBeUndefined()
  const why = await m.find({ type: 'Box', key: 'above-offer-refused' })
  expect(words(why)).toBe(`  ${cut(refused, 100 - ABOVE_LABEL)}`)
  expect(texts(why).at(-1)).toMatchObject({ color: COLORS.problem })
  await m.press({ key: 'above-offer-name' })
  await w.clock.settle()
  await m.unmount()
  const open = await band($, 100)
  expect(words(await open.find({ type: 'Box', key: 'above-offer-files' }))).toBe('  files  **/*.vtt')
  expect(words(await open.find({ type: 'Box', key: 'above-offer-refused' }))).toBe(`  ${refused}`)
  await open.press({ key: 'above-offer-name' })
  await w.clock.settle()
  await open.unmount()
  // 60 columns: the label column is 11, and the acts would leave the words under MIN_WORDS cells
  expect(wordsRoom(60, 11, OFFER_ACTS.map(label => ({ label })))).toEqual({ room: 49, own: true })
  expect(wordsRoom(150, ABOVE_LABEL, OFFER_ACTS.map(label => ({ label })))).toEqual({ room: 75, own: false })
  expect(MIN_WORDS).toBe(12)
  const narrow = await band($, 60)
  const row = await narrow.find({ type: 'Box', key: 'above-offer' })
  expect(words(row).startsWith('  viewthimble can build a page for these records: Page Histories')).toBe(true)
  expect(words(await narrow.find({ type: 'Box', key: 'above-offer-own-acts' }))).toBe(`  ${OFFER_ACTS.join('')}`)
  await narrow.unmount()
})

test("the SSH row of a remote press is one row: its words (no browser here, the command to run, then copy link) cut where its acts begin (`copy` bold), whole on a press", { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  const tunnel = 'ssh -N -L 29321:127.0.0.1:29321 -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 analyst@devbox.example.internal'
  w.open = { ...w.open, remote: true, opened: false, tunnel }
  await start($, w)
  await pressBrowser($, w)
  await w.clock.settle()
  expect(actsWidth([{ label: 'copy' }, { label: 'copy link' }, { label: 'dismiss' }])).toBe(4 + ACT_GAP + 9 + ACT_GAP + 7)
  const m = await band($, 120)
  const row = await m.find({ type: 'Box', key: 'above-remote' })
  const room = 120 - ABOVE_LABEL - 24 - ACT_GAP
  expect(words(row)).toBe(`  browser${cut(remoteWords({ tunnel, et: null }), room)}copycopy linkdismiss`)
  expect(texts(row).find(l => l.s === 'copy')).toMatchObject({ color: COLORS.accent, bold: true })
  await m.press({ key: 'above-remote-more' })
  await w.clock.settle()
  await m.unmount()
  const open = await band($, 120)
  expect(words(await open.find({ type: 'Box', key: 'above-remote' }))).toBe(`  browser${remoteWords({ tunnel, et: null })}copycopy linkdismiss`)
  await open.unmount()
})
