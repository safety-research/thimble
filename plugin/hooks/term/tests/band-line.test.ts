// The summary line above the prompt (band.tsx, SPEC-v2 3.8): items only after activation and only for the features that
// are on, counts from the session's state, `new` cleared when its section opens, `dismiss` clearing every `new`; each
// item's press opens the panel at its section as the person's own open (placed at any width); the line within the
// band's width at 104, 80 and 60 columns with `open ›` and `dismiss` never cut; at most one row left once every row
// that can be dismissed is; thimble's rows after another plugin's. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { fitItems, percent } from '../band'
import { cid } from '../lib'
import { CWD, PANEL, SUMMARY, WS, aboveAt, featuresOff, paneAt, panelWorld, placing, pressBrowser, shown, words } from './fixtures-panel'
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

/** The summary line's words, or '' when it does not show. */
async function line(m: M): Promise<string> {
  const row = await m.find({ type: 'Box', key: 'above-summary' })
  return row ? words(row) : ''
}

/** The workspace changed on disk: the session's timer reads it again. */
async function changed(w: PanelWorld, dir: string): Promise<void> {
  w.stamps.set(`${WS}/${dir}`, (w.stamps.get(`${WS}/${dir}`) ?? 1) + 1)
  await w.clock.advance(1100)
  await w.clock.settle()
}

const CHAT = '[[4579|README.md#L3]]'
const BAD = '[[99|README.md#L99]]'

test('no summary line before activation; after it, citations and coverage, `open ›`, and no `dismiss` while nothing is new', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on, { ws: null })
  await start($, w)
  const before = await band($)
  expect(await before.find({ type: 'Box', key: 'above-summary' })).toBeUndefined()
  expect(shown(await before.drawn())).not.toContain('thimble')
  await before.unmount()
})

test('after activation the line counts from state: citations that failed (none for those that checked out), coverage as the read share of the data by size, or the files read with no index yet; nothing is new at activation', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  w.t.citeIndex = [
    { id: 'c1', raw: CHAT, display: '4579', ref: 'README.md#L3', row: 'r1', at: 1 },
    { id: 'c2', raw: BAD, display: '99', ref: 'README.md#L99', row: 'r1', at: 2 },
  ]
  w.t.verdicts = { [cid(CHAT)]: { status: 'ok' }, [cid(BAD)]: { status: 'missing' } }
  w.t.coverageSummary = SUMMARY
  await start($, w)
  const m = await band($)
  expect(await line(m)).toBe('  thimblecitations 1 failedcoverage 15%open ›')
  expect(await m.find({ type: 'Button', key: 'above-summary-dismiss' })).toBeUndefined()
  // `1 failed` in red
  expect(JSON.stringify(await m.find({ type: 'Box', key: 'above-summary' }))).toContain('"color":"error"},"children":["1 failed"]')
  await m.unmount()
  // under 1%: a decimal kept
  w.t.coverageSummary = { ...SUMMARY, size: { read: 30_000, searched: 0, total: 14_000_000 } }
  const m1 = await band($)
  expect(await line(m1)).toContain(`coverage ${percent(30_000, 14_000_000)}`)
  expect(percent(30_000, 14_000_000)).toBe('0.2%')
  await m1.unmount()
  // no index yet (no size): the files read
  w.t.coverageSummary = { ...SUMMARY, records: { seen: 0, total: 0, counted: false }, size: null }
  const m2 = await band($)
  expect(await line(m2)).toContain('coverage 3 of 13 files')
  await m2.unmount()
  // a summary without totals (the transcript lane's stand-in): the files, as before
  w.t.coverageSummary = { files: SUMMARY.files, records: { seen: 0, total: 0, counted: false }, line: 'read 3 of 13 files' }
  const m3 = await band($)
  expect(await line(m3)).toContain('coverage 3 of 13 files')
  await m3.unmount()
})

test("a feature that is off shows no item: citation marks, coverage, labels' unsure, checks", { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  w.t.citeIndex = [{ id: 'c1', raw: CHAT, display: '4579', ref: 'README.md#L3', row: 'r1', at: 1 }]
  w.t.verdicts = { [cid(CHAT)]: { status: 'ok' } }
  w.t.coverageSummary = SUMMARY
  w.t.checksRunning = 1
  w.unsure = [{ id: 'd9b51617', name: 'links through a fetch proxy', noFit: 2, unsure: 1, total: 3, rows: [] }]
  await start($, w)
  const on1 = await band($)
  expect(await line(on1)).toBe('  thimblecoverage 15%labels 3 unsurechecks ◌open ›')
  await on1.unmount()
  w.t.settings = featuresOff('citationMarks', 'coverage', 'labels', 'checks')
  const off = await band($)
  // nothing left to show: no line
  expect(await line(off)).toBe('')
  await off.unmount()
})

test('`cards 2 new` and `documents 1 new` appear for new ones and clear when their section opens; `dismiss` clears every `new` and opens nothing', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  await start($, w)
  // two new cards and a new document since activation
  w.states.home = { ...w.states.home, cards: 14, docs: { ...w.states.home.docs, slides: { exists: true, title: 'The relay in two slides' } } } as never
  await changed(w, 'notebooks')
  const m = await band($)
  expect(await line(m)).toBe('  thimblecards 2 newdocuments 1 newopen ›dismiss')
  // the word `new` in green
  expect(JSON.stringify(await m.find({ type: 'Button', key: 'above-summary-cards' }))).toContain('"new"')
  // the documents' item opens the documents list, and its `new` clears
  await m.press({ key: 'above-summary-docs' })
  await w.clock.settle()
  expect(w.opened.at(-1)).toBe(PANEL)
  expect(await line(m)).toBe('  thimblecards 2 newopen ›dismiss')
  // the cards' item opens home on the first new card, and its `new` clears
  await m.press({ key: 'above-summary-cards' })
  await w.clock.settle()
  expect(await line(m)).toBe('')
  // a new label and a new view: dismiss marks them seen and opens nothing
  w.states.home = { ...w.states.home, labels: 2, views: 1 }
  await changed(w, 'concepts')
  expect(await line(m)).toBe('  thimblelabels 1 newviews 1 newopen ›dismiss')
  const opened = w.opened.length
  await m.press({ key: 'above-summary-dismiss' })
  await w.clock.settle()
  expect(await line(m)).toBe('')
  expect(w.opened.length).toBe(opened)
  await m.unmount()
})

test('`N failed` counts the chat citations not found and the problems of the cards\' links checks', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  w.cells.ff73e071 = { ...w.cells.ff73e071, verification: { links: { status: 'done', checked: true, resolved: [], broken: [{ value: '14592', ref: 'card:ff73e071#revisions/TOTAL', why: 'a script got 14591', source: '14591' }], typed: [{ value: '4579', ref: 'card:ff73e071#pages/TOTAL', why: 'the code types it in' }] } } }
  w.t.citeIndex = [{ id: 'c2', raw: BAD, display: '99', ref: 'README.md#L99', row: 'r1', at: 2 }]
  w.t.verdicts = { [cid(BAD)]: { status: 'missing' } }
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'card ff73e071' } as never)
  await w.clock.settle()
  const m = await band($)
  expect(await line(m)).toContain('citations 3 failed')
  await m.unmount()
})

test('refreshSummary reads the labels\' unsure counts again when the labels change: `labels N unsure`', { timeoutMs: 30_000 }, async ($, on) => {
  const w = panelWorld(on)
  await start($, w)
  const m = await band($)
  expect(await line(m)).not.toContain('unsure')
  w.unsure = [{ id: 'd9b51617', name: 'links through a fetch proxy', noFit: 4, unsure: 3, total: 7, rows: [] }]
  await changed(w, 'concepts')
  expect(await line(m)).toContain('labels 7 unsure')
  expect(w.calls.some(c => c[1] === 'state' && c[2] === 'label-unsure' && c.includes('--counts'))).toBe(true)
  await m.unmount()
})

for (const columns of [104, 80]) {
  test(`each item's press opens its section as the person's own open, placed inline at ${columns} columns`, { timeoutMs: 30_000 }, async ($, on) => {
    const w = panelWorld(on)
    w.t.coverageSummary = SUMMARY
    w.t.citeIndex = [{ id: 'c1', raw: CHAT, display: '4579', ref: 'README.md#L3', row: 'r1', at: 1 }]
    // a citation that failed, so the line has a citations item (one that checked out shows none)
    w.t.verdicts = { [cid(CHAT)]: { status: 'missing' } }
    const pl = placing(w, columns)
    await start($, w)
    w.states.home = { ...w.states.home, cards: 13, views: 1 }
    await changed(w, 'notebooks')
    const m = await band($, columns)
    // the items the width leaves whole (at 80 columns `citations 1 failed` can push `coverage` off the line)
    const drawn = []
    for (const key of ['coverage', 'citations', 'cards']) if (await m.find({ type: 'Button', key: `above-summary-${key}` })) drawn.push(key)
    expect(drawn).toContain('citations')
    for (const key of drawn) {
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

test('fitItems keeps whole items 3 apart and cuts the rest at the end, leaving room for `…`', () => {
  const it = (s: string) => ({ segs: [{ s }] })
  const items = [it('cards 2 new'), it('citations ✓18 ×1'), it('coverage 2%')]
  expect(fitItems(items, 100).shown.length).toBe(3)
  expect(fitItems(items, 11 + 3 + 16 + 3 + 11).cut).toBe(false)
  const cut = fitItems(items, 34)
  expect(cut.shown.length).toBe(2)
  expect(cut.cut).toBe(true)
  expect(fitItems(items, 12)).toEqual({ shown: [], cut: true })
  expect(percent(0, 10)).toBe('0%')
  // the Coverage view's forms (coverageview.tsx percent): a share below 1% keeps one decimal, cut (owner's notes, 10-16)
  expect(percent(1, 1000)).toBe('0.1%')
  expect(percent(25, 1000)).toBe('3%')
})

for (const columns of [104, 80, 60]) {
  test(`at ${columns} columns the summary line stays within the width, \`open ›\` and \`dismiss\` whole; a notice's acts and the SSH row's acts are never cut`, { timeoutMs: 30_000 }, async ($, on) => {
    const w = panelWorld(on)
    w.t.coverageSummary = SUMMARY
    w.t.citeIndex = [{ id: 'c1', raw: CHAT, display: '4579', ref: 'README.md#L3', row: 'r1', at: 1 }]
    w.t.verdicts = { [cid(CHAT)]: { status: 'ok' } }
    w.t.checksRunning = 1
    w.unsure = [{ id: 'd9b51617', name: 'links through a fetch proxy', noFit: 2, unsure: 1, total: 3, rows: [] }]
    w.states.home.notices = [{ id: 'n1', key: 'agent:view:x', kind: 'view', text: 'The build of the view Edit Bursts failed: its check found no rows in the file it reads.', agent: 'View build', chat: 'b1', at: '2026-10-14T11:05:00Z', acts: [{ label: 'Retry', act: 'view-retry', slug: 'x' }], open: 'agent' }]
    w.open = { ...w.open, remote: true, opened: false, tunnel: 'ssh -N -L 29321:127.0.0.1:29321 <your ssh host>', link_file: '/home/a/.thimble/links/s1.json' }
    await start($, w)
    w.states.home = { ...w.states.home, cards: 14, labels: 2, views: 1, docs: { ...w.states.home.docs, slides: { exists: true, title: 'S' } } } as never
    await changed(w, 'notebooks')
    await pressBrowser($, w)
    const m = await band($, columns)
    const label = columns < 80 ? 10 : 16
    const summary = await m.find({ type: 'Box', key: 'above-summary' })
    const text = words(summary)
    // the label column, then the line's own words, which stand 3 apart
    const parts = (summary as unknown as { children: unknown[] }).children
    const row = (parts[1] as { children: unknown[] }).children.filter(Boolean)
    const width = label + row.map(k => [...words(k)].length).reduce((a, b) => a + b, 0) + 3 * (row.length - 1)
    expect(width).toBeLessThanOrEqual(columns)
    expect(text.endsWith('open ›dismiss')).toBe(true)
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

test('at most one row stays once every row that can be dismissed is: the proposal, a notice and the SSH row each have `dismiss`', { timeoutMs: 30_000 }, async ($, on) => {
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
