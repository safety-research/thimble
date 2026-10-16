// The thimble line above the prompt (band.tsx, the owner's design of 10-16): after activation and while thimble is on,
// six items in a fixed order (cards, threads, citations, labels, checks, coverage), each `name value`, the item of a
// feature that is off left out; `thimble` bold in the accent, names dim, values bold, a bold purple `•` after the value
// of an item with something new (cleared when its section opens), citations' purple `◌` while checked and bold red
// `N failed`, a zero item dim whole; no `open ›`, no `dismiss`; each item's press opens its section as the person's own
// open (placed at any width); within the band's width at 184, 100, 80 and 60 columns, the zero items cut first and an
// item with a `•` or a failure last; the proposal's, a notice's and the SSH row's `dismiss` leave the line; thimble's
// rows after another plugin's. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { LINE_LABEL_W, fitItems, percent } from '../band'
import { cid } from '../lib'
import { COLORS } from '../paint'
import { CWD, PANEL, SUMMARY, WS, aboveAt, comment, featuresOff, paneAt, panelWorld, placing, pressBrowser, shown, words } from './fixtures-panel'
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

/** The items the line draws, by key, in order; `cut` for the `…` that ends a line cut short. */
async function keys(m: M): Promise<string[]> {
  const row = (await m.find({ type: 'Box', key: 'above-summary' })) as unknown as { children: { children: unknown[] }[] }
  const keyOf = (k: unknown) => String((k as { key?: unknown }).key ?? (k as { props?: { key?: unknown } }).props?.key ?? '').replace(/^above-summary-/, '')
  return row.children[1]!.children.filter(Boolean).map(k => keyOf(k) || (words(k) === '…' ? 'cut' : '?'))
}

/** An item's runs of words and their looks, as its Button draws them. */
type Look = { s: string; color?: string; bold?: boolean; dim?: boolean }
async function looks(m: M, key: string): Promise<Look[]> {
  const out: Look[] = []
  const walk = (n: unknown) => {
    if (typeof n === 'string') out.push({ s: n })
    else if (Array.isArray(n)) n.forEach(walk)
    else if (n && typeof n === 'object') {
      const o = n as { type?: string; props?: { color?: string; bold?: boolean; dimColor?: boolean; children?: unknown }; children?: unknown }
      if (o.type === 'Text') {
        const s = words(o)
        out.push({ s, ...(o.props?.color ? { color: o.props.color } : {}), ...(o.props?.bold ? { bold: true } : {}), ...(o.props?.dimColor ? { dim: true } : {}) })
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

test('no line before activation', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on, { ws: null })
  await start($, w)
  const before = await band($)
  expect(await before.find({ type: 'Box', key: 'above-summary' })).toBeUndefined()
  expect(shown(await before.drawn())).not.toContain('thimble')
  await before.unmount()
})

test('after activation the line shows six items in order, `name value`, with no `open ›` and no `dismiss`; `thimble` bold in the accent, names dim, values bold, a zero item dim whole; nothing is new at activation', { timeoutMs: 30_000 }, async ($, on) => {
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
  expect(await line(m)).toBe('  thimblecards 12threads 2citations 2 1 failedlabels 1checks 0coverage 15%')
  expect(await m.find({ type: 'Button', key: 'above-summary-open' })).toBeUndefined()
  expect(await m.find({ type: 'Button', key: 'above-summary-dismiss' })).toBeUndefined()
  // `thimble` bold in thimble's accent
  expect(JSON.stringify(await m.find({ type: 'Box', key: 'above-summary' }))).toContain(`{"type":"Text","props":{"bold":true,"color":"${COLORS.accent}"},"children":["  thimble"]}`)
  // the name dim, the value bold, no `•` at activation
  expect(await looks(m, 'cards')).toEqual([{ s: 'cards', dim: true }, { s: ' ' }, { s: '12', bold: true }])
  // `1 failed` bold red after the count
  expect(await looks(m, 'citations')).toEqual([{ s: 'citations', dim: true }, { s: ' ' }, { s: '2', bold: true }, { s: ' ' }, { s: '1 failed', color: COLORS.problem, bold: true }])
  // a zero item dim whole
  expect(await looks(m, 'checks')).toEqual([{ s: 'checks 0', dim: true }])
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
  expect(await looks(m3, 'coverage')).toEqual([{ s: 'coverage 0%', dim: true }])
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
  expect(await line(m)).toBe('  thimblecards 12threads 2citations 0labels 1checks 1coverage 0%')
  await m.unmount()
})

test("citations count the session's answers' and its cards' takeaways' citations: a purple `◌` while any is checked, no mark for those that checked out", { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  w.t.citeIndex = [{ id: 'c1', raw: CHAT, display: '4579', ref: 'README.md#L3', row: 'r1', at: 1 }]
  await start($, w)
  // one chat citation, not checked yet
  const m = await band($, 184)
  expect(await looks(m, 'citations')).toEqual([{ s: 'citations', dim: true }, { s: ' ' }, { s: '1', bold: true }, { s: ' ' }, { s: '◌', color: COLORS.cite }])
  await m.unmount()
  // checked: the `◌` goes, no mark in its place
  w.t.verdicts = { [cid(CHAT)]: { status: 'ok' } }
  // a card shown in the session: its takeaway's two citations count too
  await $.command.run({ command: 'thimble:thimble', args: 'card ff73e071' } as never)
  await w.clock.settle()
  const m1 = await band($, 184)
  expect(await line(m1)).toContain('citations 3labels')
  expect(await looks(m1, 'citations')).toEqual([{ s: 'citations', dim: true }, { s: ' ' }, { s: '3', bold: true }])
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
  expect(await line(off)).toBe('  thimblecards 12threads 2')
  await off.unmount()
})

test('labels counts the labels, not the records they could not place; refreshSummary still reads those for the Labels view', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  await start($, w)
  const m = await band($)
  w.unsure = [{ id: 'd9b51617', name: 'links through a fetch proxy', noFit: 4, unsure: 3, total: 7, rows: [] }]
  await changed(w, 'concepts')
  expect(await line(m)).toContain('labels 1checks')
  expect(await line(m)).not.toContain('unsure')
  expect(w.calls.some(c => c[1] === 'state' && c[2] === 'label-unsure' && c.includes('--counts'))).toBe(true)
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
  expect(await line(m)).toBe('  thimblecards 14 •threads 2citations 0labels 2 •checks 1 •coverage 0%')
  expect(await looks(m, 'cards')).toEqual([{ s: 'cards', dim: true }, { s: ' ' }, { s: '14', bold: true }, { s: ' ' }, DOT])
  expect(await line(m)).not.toContain('new')
  expect(await line(m)).not.toContain('documents')
  expect(await line(m)).not.toContain('views')
  // the labels' item opens the labels list, and its `•` clears
  await m.press({ key: 'above-summary-labels' })
  await w.clock.settle()
  expect(w.opened.at(-1)).toBe(PANEL)
  expect(await line(m)).toContain('labels 2checks 1 •')
  // the checks' item opens the Checks view, and its `•` clears
  await m.press({ key: 'above-summary-checks' })
  await w.clock.settle()
  expect(await line(m)).toContain('checks 1coverage')
  // the cards' item opens home, and its `•` clears
  await m.press({ key: 'above-summary-cards' })
  await w.clock.settle()
  expect(await line(m)).toBe('  thimblecards 14threads 2citations 0labels 2checks 1coverage 0%')
  // a card that arrives after shows its `•`; home shown by another way (the panel's own open) clears it too
  w.states.home = { ...w.states.home, cards: 15 }
  await changed(w, 'notebooks')
  expect(await line(m)).toContain('cards 15 •')
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  expect(await line(m)).toContain('cards 15threads')
  await m.unmount()
})

test("`N failed` counts the chat citations not found and the problems of the cards' links checks", { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  w.cells.ff73e071 = { ...w.cells.ff73e071, verification: { links: { status: 'done', checked: true, resolved: [], broken: [{ value: '14592', ref: 'card:ff73e071#revisions/TOTAL', why: 'a script got 14591', source: '14591' }], typed: [{ value: '4579', ref: 'card:ff73e071#pages/TOTAL', why: 'the code types it in' }] } } }
  w.t.citeIndex = [{ id: 'c2', raw: BAD, display: '99', ref: 'README.md#L99', row: 'r1', at: 2 }]
  w.t.verdicts = { [cid(BAD)]: { status: 'missing' } }
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'card ff73e071' } as never)
  await w.clock.settle()
  const m = await band($)
  expect(await line(m)).toContain('citations 3 3 failed')
  await m.unmount()
})

for (const columns of [104, 80]) {
  test(`each item's press opens its section as the person's own open, placed inline at ${columns} columns`, { timeoutMs: 30_000 }, async ($, on) => {
    const w = panelWorld(on)
    w.t.coverageSummary = SUMMARY
    w.t.citeIndex = [{ id: 'c1', raw: CHAT, display: '4579', ref: 'README.md#L3', row: 'r1', at: 1 }]
    w.t.verdicts = { [cid(CHAT)]: { status: 'missing' } }
    w.t.answerComments = [comment('c1')]
    const pl = placing(w, columns)
    await start($, w)
    w.states.home = { ...w.states.home, cards: 13 }
    await changed(w, 'notebooks')
    const m = await band($, columns)
    // the items the width leaves (at 80 columns the zero and the plain items go first)
    const drawn = await keys(m)
    expect(drawn).toContain('cards')
    expect(drawn).toContain('citations')
    for (const key of drawn.filter(k => k !== 'cut')) {
      const before = pl.log.length
      await m.press({ key: `above-summary-${key}` })
      await w.clock.settle()
      expect(pl.log.length).toBeGreaterThan(before)
      expect(pl.log.at(-1)).toEqual({ id: PANEL, asked: true, placed: true })
      // closed again, so the next press opens it anew
      const pane = (await $.ui.mount(paneAt(columns - 8))) as unknown as M
      await pane.press({ key: 'hk-close' })
      await pane.unmount()
      await w.clock.settle()
    }
    await m.unmount()
  })
}

test('fitItems keeps every item when all fit, 2 apart; else the zero items go first, then the others from the end, an item with a `•` or a failure last, and `…` ends the line', () => {
  const it = (s: string, o: { zero?: boolean; keep?: boolean } = {}) => ({ segs: [{ s }], zero: false, keep: false, ...o })
  const cards = it('cards 12 •', { keep: true })
  const threads = it('threads 2')
  const cites = it('citations 18 1 failed', { keep: true })
  const labels = it('labels 0', { zero: true })
  const checks = it('checks 2 •', { keep: true })
  const coverage = it('coverage 15%')
  const items = [cards, threads, cites, labels, checks, coverage]
  const all = 10 + 9 + 21 + 8 + 10 + 12 + 5 * 2
  expect(fitItems(items, all)).toEqual({ shown: items, cut: false })
  // one cell short: the zero item goes first, `…` after the last item
  expect(fitItems(items, all - 1)).toEqual({ shown: [cards, threads, cites, checks, coverage], cut: true })
  // then the plain items from the end: coverage, then threads
  expect(fitItems(items, all - 8 - 2).shown).toEqual([cards, threads, cites, checks])
  expect(fitItems(items, 10 + 2 + 21 + 2 + 10 + 2 + 1).shown).toEqual([cards, cites, checks])
  // the items with a `•` or a failure only when nothing else is left, from the end
  expect(fitItems(items, 10 + 2 + 21 + 2 + 1).shown).toEqual([cards, cites])
  expect(fitItems(items, 3)).toEqual({ shown: [], cut: true })
  expect(percent(0, 10)).toBe('0%')
  // the Coverage view's forms (coverageview.tsx percent): a share below 1% keeps one decimal, cut (owner's notes, 10-16)
  expect(percent(1, 1000)).toBe('0.1%')
  expect(percent(25, 1000)).toBe('3%')
})

for (const columns of [184, 100, 80, 60]) {
  test(`at ${columns} columns the line stays within the width and keeps every item with a \`•\` or a failure; a notice's acts and the SSH row's acts are never cut`, { timeoutMs: 30_000 }, async ($, on) => {
    const w = panelWorld(on)
    w.t.coverageSummary = SUMMARY
    w.t.citeIndex = [{ id: 'c1', raw: CHAT, display: '4579', ref: 'README.md#L3', row: 'r1', at: 1 }]
    w.t.verdicts = { [cid(CHAT)]: { status: 'missing' } }
    w.states.home.notices = [{ id: 'n1', key: 'agent:view:x', kind: 'view', text: 'The build of the view Edit Bursts failed: its check found no rows in the file it reads.', agent: 'View build', chat: 'b1', at: '2026-10-14T11:05:00Z', acts: [{ label: 'Retry', act: 'view-retry', slug: 'x' }], open: 'agent' }]
    w.open = { ...w.open, remote: true, opened: false, tunnel: 'ssh -N -L 29321:127.0.0.1:29321 <your ssh host>', link_file: '/home/a/.thimble/links/s1.json' }
    await start($, w)
    w.states.home = { ...w.states.home, cards: 14 }
    w.t.answerComments = [comment('c1'), comment('c2')]
    await changed(w, 'notebooks')
    await pressBrowser($, w)
    const m = await band($, columns)
    // `  thimble` and the gap before the first item
    const label = LINE_LABEL_W
    expect(label).toBe(11)
    const summary = await m.find({ type: 'Box', key: 'above-summary' })
    // the label column, then the line's own words, which stand 2 apart
    const parts = (summary as unknown as { children: unknown[] }).children
    const row = (parts[1] as { children: unknown[] }).children.filter(Boolean)
    const width = label + row.map(k => [...words(k)].length).reduce((a, b) => a + b, 0) + 2 * (row.length - 1)
    expect(width).toBeLessThanOrEqual(columns)
    const drawn = await keys(m)
    // cards (•), citations (failed) and checks (•) whatever the width; at 80 and 60 columns the others go, `…` last
    for (const key of ['cards', 'citations', 'checks']) expect(drawn).toContain(key)
    if (columns >= 100) expect(drawn).toEqual(['cards', 'threads', 'citations', 'labels', 'checks', 'coverage'])
    else expect(drawn.at(-1)).toBe('cut')
    if (columns === 60) expect(drawn).toEqual(['cards', 'citations', 'checks', 'cut'])
    // a notice's acts and the SSH row's acts stand in a box that never shrinks
    for (const key of ['above-notice-n1', 'above-remote']) {
      const r = JSON.stringify(await m.find({ type: 'Box', key }))
      expect(r).toContain('"flexShrink":0')
    }
    expect(await m.find({ type: 'Button', key: 'above-notice-n1-dismiss' })).toBeDefined()
    expect(await m.find({ type: 'Button', key: 'above-remote-link' })).toBeDefined()
    await m.unmount()
  })
}

test('the proposal, a notice and the SSH row each keep their `dismiss`; once each is dismissed the line stays', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  w.t.coverageSummary = SUMMARY
  w.states.home.offer = { slug: 'edit-bursts', name: 'Edit Bursts', description: 'Each wiki page as a strip of its saves.', task: 'Find out when.', claims: ['revisions.jsonl'] }
  w.states.home.notices = [{ id: 'n1', key: 'agent:x', kind: 'view', text: 'The build failed.', agent: 'View build', chat: '', at: '2026-10-14T11:05:00Z', acts: [] }]
  w.open = { ...w.open, remote: true, opened: false, tunnel: 'ssh -N -L 29321:127.0.0.1:29321 <your ssh host>' }
  await start($, w)
  await pressBrowser($, w)
  const m = await band($)
  const rows = async () => ((await m.drawn()) as unknown as { children?: unknown[] }).children?.filter(k => /"key":"above-(?!summary)[a-z]+(-[a-z0-9]+)?"/.test(JSON.stringify(k).slice(0, 80)) || /"key":"above-summary"/.test(JSON.stringify(k).slice(0, 80))).length ?? 0
  expect(await rows()).toBeGreaterThanOrEqual(4)
  await m.press({ key: 'above-offer-dismiss' })
  await m.press({ key: 'above-notice-n1-dismiss' })
  await m.press({ key: 'above-remote-dismiss' })
  await w.clock.settle()
  expect(await m.find({ type: 'Box', key: 'above-offer' })).toBeUndefined()
  expect(await m.find({ type: 'Box', key: 'above-notice-n1' })).toBeUndefined()
  expect(await m.find({ type: 'Box', key: 'above-remote' })).toBeUndefined()
  expect(await m.find({ type: 'Box', key: 'above-summary' })).toBeDefined()
  await m.unmount()
})

/** Another plugin that draws a row in the band, after the rows beneath it. */
const OTHER = {
  name: 'other-band',
  register: ((on: (ev: string, m: unknown, h: unknown) => void) => {
    on('ui.render', { component: 'AbovePrompt' }, async ($: { ui: { resolve: (e: unknown) => Record<string, (p: unknown) => unknown> } }, e: unknown, next: (e: unknown) => Promise<unknown>) => {
      const { Box, Text } = $.ui.resolve(e)
      const below = await next(e)
      return Box!({ flexDirection: 'column', children: [below, Box!({ key: 'other-row', children: [Text!({ children: 'another plugin\'s row' })] })] })
    })
  }) as never,
}

test("thimble's rows stand after the rows of the plugins beneath it; another plugin's row draws too", { plugins: [OTHER], timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  w.t.coverageSummary = SUMMARY
  await start($, w)
  const m = await band($)
  const json = JSON.stringify(await m.drawn())
  expect(json).toContain("another plugin's row")
  expect(json).toContain('above-summary')
  // what stands beneath thimble's hook (the engine's own row here) comes before thimble's rows
  expect(json.indexOf('(the engine row)')).toBeGreaterThanOrEqual(0)
  expect(json.indexOf('(the engine row)')).toBeLessThan(json.indexOf('above-summary'))
  await m.unmount()
})
