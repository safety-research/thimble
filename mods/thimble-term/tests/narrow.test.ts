// The live check term-fix9's quirks of layout and state: the path row and a file's facts in a pane 40 columns wide
// (quirk 3), key hints that wrap and are never cut (5), card rows that share their first words cut in their middle (8),
// one state for a label whose run goes on or stopped part way (4), a document's cards named on its first drawing (9),
// Claude Code's synthetic reply not drawn (13), and the low ones (14): the code view's step, `new` and the columns
// beside it, the Labels heading's `new`, a label card's shares. `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { shares } from '../hooks/draw'
import { width } from '../hooks/lib'
import { CWD, DOC, LABEL, WS, shown, takesKeys, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type E = Engine

const PANEL = 'thimble-term'
const paneOf = (body: number, rows = 40) => ({ plugin: PANEL, component: 'Pane', requestId: PANEL, surface: 'terminal', viewport: { columns: 110 - body, rows: rows + 4 }, props: { title: 'thimble', isFocused: true, bodyColumns: body, placement: 'dock', scroll: { bodyRows: rows }, view: {} } }) as never
const MESSAGE = (requestId: string, text: string) =>
  ({ plugin: PANEL, component: 'AssistantMessage', requestId, surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never
const LONG = { path: 'log.txt', kind: 'text', total_lines: 900, start: 1, records: Array.from({ length: 200 }, (_, i) => ({ line: i + 1, record: { text: `line ${i + 1} of the log` } })) }

async function start($: E, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

async function look($: E, body: number, rows = 40): Promise<M> {
  return (await $.ui.mount(paneOf(body, rows))) as unknown as M
}

/** The words a drawn tree shows, without the hidden keys' labels (their Boxes no row tall). */
function words(tree: unknown): string {
  const walk = (n: unknown): string => {
    if (typeof n === 'string') return n
    if (Array.isArray(n)) return n.map(walk).join('')
    if (!n || typeof n !== 'object') return ''
    const o = n as { type?: string; props?: { key?: unknown; label?: unknown; children?: unknown; height?: unknown }; children?: unknown }
    if (o.props?.height === 0) return ''
    const label = typeof o.props?.label === 'string' ? o.props.label : ''
    return label + walk(o.children ?? o.props?.children)
  }
  return walk(tree)
}

test('the path row fits a pane 40 columns wide: `show all threads` shortens to `threads`, then gives way to the steps; a file\'s facts and `earlier  later` never run together', async ($, on) => {
  // live check term-fix9, quirk 3: `‹ back  home › fileshow all threads` wrapped onto a second row and `lines 1…later`
  // ran together
  const w = world(on)
  w.states.files = [{ path: 'logs/labels.jsonl', kind: 'records', size_bytes: 600 }]
  w.pages['logs/labels.jsonl'] = { ...LONG, path: 'logs/labels.jsonl', kind: 'records' }
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'files logs/labels.jsonl:30' } as never)
  await w.clock.settle()
  for (const body of [37, 60, 96]) {
    const pane = await look($, body)
    const way = words(await pane.find({ type: 'Box', key: 'way' }))
    const cols = body - 4
    expect(width(way)).toBeLessThanOrEqual(cols)
    expect(way).toContain('home')
    expect(way).toContain('labels.jsonl')
    if (body === 37) expect(way).not.toContain('show all threads')
    if (body === 96) expect(way).toMatch(/show all threads {2}1 new$/)
    // the facts and the pages: on one row at least 2 cells apart when they fit, else on two rows
    const sub = await pane.find({ type: 'Box', key: 'file-sub' })
    if (body === 37) {
      expect(words(await pane.find({ type: 'Box', key: 'file-sub-pages' }))).toBe('later')
      expect(words(sub)).not.toContain('later')
    } else {
      expect(words(sub)).toMatch(/of 900later$/)
      expect(JSON.stringify(sub)).toContain('"flexGrow":1,"minWidth":2')
    }
    await pane.unmount()
  }
  // no letter shows the threads (live check term-fix10, new quirk 4: `t` did, unnamed, and `table` typed while the
  // panel held the keys opened them); in a pane too narrow for `show all threads`, `threads` stays one click away
  for (const body of [37, 52]) {
    const pane = await look($, body)
    await takesKeys($)
    expect(await pane.find({ type: 'Button', key: 'hk-threads' })).toBeUndefined()
    const way = words(await pane.find({ type: 'Box', key: 'way' }))
    expect(width(way)).toBeLessThanOrEqual(body - 4)
    if (body === 52) expect(way).toMatch(/threads {2}1 new$/)
    const btn = await pane.find({ type: 'Button', key: 'threads' })
    if (!btn) {
      await pane.unmount()
      continue
    }
    expect(way).not.toContain('show all threads')
    await pane.press({ key: 'threads' })
    await w.clock.settle()
    await pane.unmount()
    const threads = await look($, body)
    expect(words(await threads.drawn())).toContain('Threads')
    await threads.unmount()
    await $.command.run({ command: 'thimble:thimble', args: 'files logs/labels.jsonl:30' } as never)
    await w.clock.settle()
  }
})

test('key hints too long for their row go on to a second row, never cut; a list cut to the pane leaves them their rows', async ($, on) => {
  // live check term-fix9, quirk 5: `b to go back…` at 210 columns, `Space to fold…` at 120
  const w = world(on)
  w.states.files = [{ path: 'log.txt', kind: 'text', size_bytes: 600 }]
  w.pages['log.txt'] = LONG
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'files log.txt:150' } as never)
  await w.clock.settle()
  await takesKeys($)
  let pane = await look($, 60, 30)
  const hints = await pane.find({ key: 'h-hints' })
  const rows = ((hints as { children?: unknown[] }).children ?? []).map(r => words(r))
  expect(rows.length).toBe(2)
  for (const r of rows) {
    expect(width(r)).toBeLessThanOrEqual(56)
    expect(r).not.toContain('…')
  }
  for (const h of ['↑↓ to choose', 'Enter to open', 'Backspace for the files', 'x to close']) expect(rows.join(' · ')).toContain(h)
  // the cut lines leave the hint rows in the pane: the path row, the header (title, facts, rule), the chosen record, the
  // lines, two hint rows
  const body = ((await pane.drawn({ in: 'm:file-body' })) as { children?: unknown[] }).children ?? []
  expect(body.length).toBeLessThanOrEqual(30 - 1 - 3 - 1 - 2)
  expect(body.map(r => shown(r)).join('\n')).toContain('line 150 of the log')
  await pane.unmount()
  // home's hints at 50 columns
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  await takesKeys($)
  pane = await look($, 50, 20)
  const lines = (((await pane.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []).map(r => shown(r).trim())
  expect(lines.at(-2)).toBe('↑↓ to choose · Enter to open · Space to fold')
  expect(lines.at(-1)).toMatch(/^x to close$|b to go back · x to close$/)
  expect(lines.length).toBeLessThanOrEqual(20 - 1)
  await pane.unmount()
})

test('card rows of a group whose questions share their first words are cut in their middle, so each row\'s end shows', async ($, on) => {
  // live check term-fix9, quirk 8: in a narrow pane every row read `How many deletes does…`
  const w = world(on)
  const day = (d: number) => `How many deletes does events.jsonl record in each hour (UTC) of ${d} June?`
  for (const d of [27, 28, 29]) (w.cells as Record<string, Record<string, unknown>>)[`h${d}000000`] = { ...w.cells.k0code00, id: `h${d}000000`, notebook: 'g9', title: day(d), ts: `2026-10-06T11:${d}:00+00:00` }
  w.states.cards = { ...w.states.cards, groups: [...w.states.cards.groups, { id: 'g9', title: 'Deletes by hour', role: 'analyst', ts: '2026-10-06T11:00:00+00:00' }] }
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  const pane = await look($, 56)
  const lines = (((await pane.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []).map(r => shown(r))
  for (const d of [27, 28, 29]) {
    const row = lines.find(l => l.includes(`${d} June?`))
    expect(row).toBeDefined()
    expect(row).toMatch(/^ {4}How many deletes\S*… .*of \d\d June\? +code( {2}new)?$/)
  }
  // a group whose questions share no first words is cut at its end, as before
  expect(lines.find(l => l.includes('Your work'))).toMatch(/▸ Your work/)
  await pane.unmount()
  // in a pane 39 columns wide every row of home fits it, its right part whole, and the rows still end apart (live check
  // term-fix10: home laid out 40 columns cut each row's right part)
  const narrow = await look($, 39)
  const rows = (((await narrow.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []).map(r => shown(r).replace(/\s+$/, ''))
  for (const r of rows) expect(width(r)).toBeLessThanOrEqual(39 - 4 + 2)
  for (const d of [27, 28, 29]) expect(rows.find(l => l.includes(`${d} June?`))).toMatch(/How many… (of )?\d\d June\? +code/)
  await narrow.unmount()
})

test("a label whose first run goes on in main's process, or stopped part way, says so alike on home, the list, its panel and its card", async ($, on) => {
  // live check term-fix9, quirk 4: while the run went the list and the panel said `not run yet` and home `◌ labeling`;
  // after a quit mid-run every place said `not run yet` beside counts of 3,150
  const w = world(on)
  const midway = { ...LABEL, last_run: null, applications: [], trial: false, label_stats: { n_labeled: 3000, counts: { none: 2000, 'proxy-link': 1000 } }, scope_total: 4579 }
  w.states.labels = [midway] as never
  ;(w.states.agents.rows as unknown[]).push({ name: 'thimble:labels', label: `label ${LABEL.name}`, state: 'running', kind: 'subagent', chat: 'lb1', role: 'labels' })
  await start($, w)
  const pieces = async () => {
    const out: Record<string, string> = {}
    await $.command.run({ command: 'thimble:thimble', args: '' } as never)
    await w.clock.settle()
    let pane = await look($, 96)
    out.home = (((await pane.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []).map(r => shown(r)).filter(l => l.includes('labeling') || l.includes('stopped') || l.includes(LABEL.name)).join('\n')
    await pane.pointer({ type: 'down', x: 2, y: (((await pane.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []).findIndex(r => shown(r).includes('Labels (')), button: 'left', in: 'm:home' } as never)
    await w.clock.settle()
    await pane.unmount()
    pane = await look($, 96)
    out.list = shown(await pane.drawn({ in: 'm:labels-list' }))
    await pane.unmount()
    await takesKeys($)
    pane = await look($, 96)
    await pane.press({ key: 'hk-close' }).catch(() => undefined)
    await pane.unmount()
    await $.command.run({ command: 'thimble:thimble', args: 'card l0label0' } as never)
    await w.clock.settle()
    pane = await look($, 96)
    out.card = JSON.stringify(await pane.drawn())
    await pane.unmount()
    return out
  }
  let got = await pieces()
  expect(got.home).toContain('◌ labeling 3,000 of 4,579')
  expect(got.list).toContain('labeling 3,000 of 4,579')
  expect(got.list).toContain('◌')
  expect(got.list).not.toContain('not run yet')
  expect(got.card).toContain('◌ labeling 3,000 of 4,579')
  // the label's panel: the run main's chat follows, a stop for it, no `run on` buttons
  w.labelRun = null
  let pane = await look($, 96)
  await pane.unmount()
  // its panel, opened from the list
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  pane = await look($, 96)
  const homeRows = (((await pane.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []).map(r => shown(r))
  await pane.pointer({ type: 'down', x: 6, y: homeRows.findIndex(r => r.includes(LABEL.name) && !r.includes('label ')), button: 'left', in: 'm:home' } as never)
  await w.clock.settle()
  await pane.unmount()
  pane = await look($, 96)
  let text = shown(await pane.drawn())
  expect(text).toContain('name:')
  expect(text).toContain('◌ labeling 3,000 of 4,579')
  expect(text).not.toContain('not run yet')
  expect(text).toContain('s to stop')
  expect(await pane.find({ type: 'Button', key: 'lb-sample' })).toBeUndefined()
  await pane.press({ key: 'hk-stop' })
  await w.clock.settle()
  expect(w.acts).toContainEqual({ kind: 'stop', payload: { agent: 'lb1', name: 'thimble:labels' } })
  await pane.unmount()
  // the quit stopped it part way: no chat follows it, 3,150 records labeled
  ;(w.states.agents.rows as unknown[]).pop()
  w.states.labels = [{ ...midway, label_stats: { n_labeled: 3150, counts: { none: 2100, 'proxy-link': 1050 } } }] as never
  w.stamps.set(`${WS}/labels`, 5)
  w.stamps.set(`${WS}/trusted/subagents.json`, 5)
  await w.clock.advance(1100)
  got = await pieces()
  expect(got.home).toContain('stopped at 3,150 of 4,579')
  expect(got.list).toContain('stopped at 3,150 of 4,579')
  expect(got.card).toContain('stopped at 3,150 of 4,579')
  expect(got.card).not.toContain('not run yet')
  for (const k of ['home', 'list', 'card']) expect(got[k]).not.toContain('◌ labeling')
})

test("a document's cards are read before it is drawn: a sentence's chip of a card names it by its question in its tip on the first drawing", async ($, on) => {
  // live check term-fix9, quirk 9: `(a card)` until the panel drew again
  const w = world(on)
  w.docs.report = { ...DOC, sections: [{ id: 's1', heading: 'The data', paragraphs: [{ id: 'p1', sentences: [{ id: 'x1', text: 'The files hold more records [[card:a0frame0]].' }] }], figures: [] }] }
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'documents' } as never)
  await w.clock.settle()
  await takesKeys($)
  let pane = await look($, 96)
  await pane.press({ key: 'doc-open-0' })
  await w.clock.settle()
  await pane.unmount()
  // the first drawing after the document was read
  pane = await look($, 96)
  const text = shown(await pane.drawn())
  if (text.includes('◌ reading the document')) {
    await pane.unmount()
    await w.clock.settle()
    pane = await look($, 96)
  }
  const drawn = JSON.stringify(await pane.drawn())
  expect(drawn).toContain('"label":"[ card ]"')
  expect(drawn).toContain('"tip":"card \\"How many records does each file hold?\\" · ')
  expect(drawn).not.toMatch(/a card|the card ·/)
  await pane.unmount()
})

test("Claude Code's synthetic `No response requested.` is not drawn as main's reply", async ($, on) => {
  // live check term-fix9, quirk 13: after --continue it drew as `⏺ No response requested.`
  const w = world(on)
  await start($, w)
  const ui = (await $.ui.mount(MESSAGE('r9', 'No response requested.'))) as unknown as M
  expect(shown(await ui.drawn())).not.toContain('No response requested')
  await ui.unmount()
  const other = (await $.ui.mount(MESSAGE('r8', 'No response requested. The card is ready.'))) as unknown as M
  expect(shown(await other.drawn())).toContain('The card is ready.')
  await other.unmount()
})

test("the code view's step keeps ` · code` whole with one `…`; rows beside a `new` keep their columns; the Labels heading counts its new labels", async ($, on) => {
  // live check term-fix9, low quirks
  const w = world(on)
  ;(w.cells as Record<string, Record<string, unknown>>).ff73e071!.title = 'How many deletes does events.jsonl record on each day from 18 June to 26 June?'
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'card ff73e071' } as never)
  await w.clock.settle()
  let pane = await look($, 96)
  await pane.press({ key: 'hk-code' })
  await w.clock.settle()
  await pane.unmount()
  pane = await look($, 70)
  const way = words(await pane.find({ type: 'Box', key: 'way' }))
  expect(way).toMatch(/card "How many[^"…]*…" · code/)
  expect(way.match(/…/g)?.length).toBe(1)
  await pane.unmount()
  // a card and a label made since home was last seen: `new` at R, the other rows' kinds in the same column
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  const made = new Date(1_790_000_000_000 + 120_000).toISOString()
  ;(w.cells as Record<string, Record<string, unknown>>).n1new000 = { ...w.cells.a0frame0, id: 'n1new000', title: 'When were pages deleted?', created_ts: made, ts: made }
  w.states.labels = [...w.states.labels, { ...LABEL, id: 'lab00new', name: 'says probe', ts: made }] as never
  w.stamps.set(`${WS}/notebooks`, 3)
  w.stamps.set(`${WS}/labels`, 3)
  await w.clock.advance(121_000)
  await $.command.run({ command: 'thimble:thimble', args: 'threads' } as never)
  await w.clock.settle()
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  pane = await look($, 96)
  const lines = (((await pane.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []).map(r => shown(r).replace(/\s+$/, ''))
  const fresh = lines.find(l => l.includes('When were pages deleted?'))!
  const old = lines.find(l => l.includes('How many records does each file hold?'))!
  expect(fresh).toMatch(/table {2}new$/)
  expect(old.indexOf('table')).toBe(fresh.indexOf('table'))
  expect(lines.find(l => l.includes('Labels ('))).toMatch(/Labels \(2\) {2}1 new/)
  expect(lines.find(l => l.includes('says probe'))).toMatch(/new$/)
  await pane.unmount()
})

test("a label's shares add up to 100%, on its card and in its panel's counts", async ($, on) => {
  // live check term-fix9, low quirk: 38% + 63%
  const w = world(on)
  w.states.labels = [{ ...LABEL, label_stats: { n_labeled: 8, counts: { 'proxy-link': 3, none: 5 } } }] as never
  await start($, w)
  expect(shares([3, 5], 8)).toEqual(['38%', '62%'])
  expect(shares([1, 1, 1], 3)).toEqual(['34%', '33%', '33%'])
  expect(shares([1, 999], 1000)).toEqual(['0.1%', '>99%'])
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  let pane = await look($, 96)
  const rows = (((await pane.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []).map(r => shown(r))
  await pane.pointer({ type: 'down', x: 6, y: rows.findIndex(r => r.includes(LABEL.name) && r.includes('█')), button: 'left', in: 'm:home' } as never)
  await w.clock.settle()
  await pane.unmount()
  pane = await look($, 96)
  await pane.press({ key: 'hk-counts' })
  await w.clock.settle()
  await pane.unmount()
  pane = await look($, 96)
  const drawn = JSON.stringify(await pane.drawn())
  expect(drawn).toContain('  38%')
  expect(drawn).toContain('  62%')
  expect(drawn).not.toContain('63%')
  await pane.unmount()
})

test("in a narrow pane names stay readable: home's label bar shrinks, then goes; the type column goes before a file's name is cut", async ($, on) => {
  // live check term-fix10, new quirk 6: `● age…  ████████████████████  1,900` on home, and `agent-c…`, `pages.j…` beside
  // the file browser's 10-cell type column
  const w = world(on)
  w.states.labels = [{ ...LABEL, name: 'agent-chat purpose' } as never]
  w.states.files = [
    { path: 'agent-chat.jsonl', kind: 'transcript', size_bytes: 1_200_000 },
    { path: 'pages.jsonl', kind: 'records', size_bytes: 52_000_000 },
  ] as never
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: '' } as never)
  await w.clock.settle()
  const homeRows = async (body: number) => {
    const pane = await look($, body, 90)
    const rows = (((await pane.drawn({ in: 'm:home' })) as { children?: unknown[] }).children ?? []).map(r => shown(r).replace(/\s+$/, ''))
    await pane.unmount()
    return rows
  }
  const bar = (r: string) => (r.match(/█+/)?.[0] ?? '').length
  // wide: the whole bar; narrower: a shorter one beside the whole name; narrowest: no bar, the name whole
  const wide = (await homeRows(96)).find(r => r.includes('agent-chat purpose'))!
  expect(bar(wide)).toBe(20)
  const mid = (await homeRows(52)).find(r => r.includes('agent-chat purpose'))
  expect(mid).toBeDefined()
  expect(bar(mid!)).toBeGreaterThanOrEqual(6)
  expect(bar(mid!)).toBeLessThan(20)
  for (const body of [39, 44]) {
    const rows = await homeRows(body)
    const label = rows.find(r => r.includes('agent-chat purpose'))
    // the name whole: at 39 with no bar, at 44 beside a short one
    expect(label).toMatch(body === 39 ? /● agent-chat purpose +14,591$/ : /● agent-chat purpose +█{6,19} {2}14,591$/)
    // home's files: the type column goes before a name is cut
    expect(rows.find(r => r.includes('agent-chat.jsonl'))).toMatch(/^ {6}agent-chat\.jsonl +1\.2 MB$/)
    expect(rows.find(r => r.startsWith('  Files'))).not.toContain('type')
    for (const r of rows) expect(width(r)).toBeLessThanOrEqual(body - 4 + 2)
  }
  expect((await homeRows(96)).find(r => r.startsWith('  Files'))).toMatch(/type {2,}size$/)
  // the file browser: the same
  await $.command.run({ command: 'thimble:thimble', args: 'files' } as never)
  await w.clock.settle()
  for (const body of [37, 96]) {
    const pane = await look($, body)
    const tree = (((await pane.drawn({ in: 'm:files-tree' })) as { children?: unknown[] }).children ?? []).map(r => shown(r).replace(/\s+$/, ''))
    await pane.unmount()
    const chat = tree.find(r => r.includes('agent-chat'))!
    expect(chat).toContain('agent-chat.jsonl')
    expect(tree.find(r => r.includes('pages'))).toContain('pages.jsonl')
    if (body === 37) {
      expect(tree[0]).not.toContain('type')
      expect(chat).not.toContain('transcript')
    } else {
      expect(tree[0]).toMatch(/type +size$/)
      expect(chat).toMatch(/transcript +1\.2 MB$/)
    }
  }
})
