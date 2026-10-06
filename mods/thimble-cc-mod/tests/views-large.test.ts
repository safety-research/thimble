// A view of tens of thousands of rows in the panel: drawn again in milliseconds once its rows are read, read once
// however many drawings ask for it (its old rows let go first), and every key typed while it draws kept.
// `claude plugin test mods/thimble-cc-mod`.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

import { inTurn, initialState, reduce, viewLayout } from '../hooks/viewdraw'
import type { ViewData, ViewSpec } from '../hooks/viewspec'
import { largeView } from './view-large'

const text = (lines: { s: string }[][]) => lines.map(l => l.map(s => s.s).join('')).join('\n')
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

test('a scroll, a selection or a key on a view of 40,000 rows draws again in milliseconds, as a fresh layout draws it', () => {
  const { spec, data } = largeView()
  for (const tab of [0, 1]) {
    const st = { ...initialState(), tab }
    viewLayout(spec, data, st, 92, 44)
    const t = performance.now()
    const lay = viewLayout(spec, data, { ...st, scroll: 3 }, 92, 44)
    expect(performance.now() - t).toBeLessThan(60)
    // what is kept from one drawing to the next changes nothing in what is drawn
    expect(text(lay.lines)).toBe(text(viewLayout(spec, clone(data), { ...st, scroll: 3 }, 92, 44).lines))
    let typed = { ...st, typing: true }
    for (const k of 'Relay') typed = reduce(spec, data, typed, { op: 'key', key: k }).state
    expect(text(viewLayout(spec, data, typed, 92, 44).lines)).toBe(text(viewLayout(spec, clone(data), typed, 92, 44).lines))
  }
})

test('a change selected on lanes of thousands draws at once: the lane that holds it is found by its own lanes', () => {
  // a layout that searched every lane's marks for the selected row took 18 s on the wiki's 10,221 lanes and 32,462
  // changes, and the engine unloads a mod whose hook runs 5 s without a break
  const { spec, data } = largeView()
  viewLayout(spec, data, initialState(), 92, 44)
  // a change on the last lane: the old search scanned every mark for each lane above it (5.8 s here)
  const last = data.collections.lanes!.at(-1)!.key
  const k = String(data.collections.changes!.find(r => r.lane === last)!.key)
  const t = performance.now()
  const lay = viewLayout(spec, data, { ...initialState(), sel: { c: 'changes', k } }, 92, 44)
  expect(performance.now() - t).toBeLessThan(300)
  // the window moved to the lane of the selected change, its mark drawn selected
  expect(lay.hits.some(h => h.act.op === 'select' && h.act.k === k)).toBe(true)
})

test('acts that arrive together change the state one at a time: five keys typed while the view draws make "Relay"', async () => {
  // the state as $.state keeps it, read and written with a wait between, as each act's hook reads and writes it
  let stored = { ...initialState(), typing: true }
  const { spec, data } = largeView(200, 20)
  // a few turns of the event loop, as an engine call takes
  const pause = async () => {
    for (let i = 0; i < 3; i++) await Promise.resolve()
  }
  const act = async (key: string) => {
    const st = (await pause(), stored)
    await pause()
    stored = reduce(spec, data, st, { op: 'key', key }).state
  }
  await Promise.all([...'Relay'].map(k => act(k)))
  expect(stored.q).not.toBe('Relay')
  stored = { ...initialState(), typing: true }
  await Promise.all([...'Relay'].map(k => inTurn('view:large', () => act(k))))
  expect(stored.q).toBe('Relay')
})

// ------------------------------------------------------------------------------------------------ the panel

const CWD = '/corpus/wiki'
const SLUG = 'agent-wiki-pages'
const DIR = `${CWD}/.thimble-cc-mod/views/${SLUG}`
const PANE = { plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 200, rows: 55 }, props: { bodyColumns: 96, scroll: { bodyRows: 46 } } } as const
type M = Mounted<'terminal'>
type El = { type: string; props: Record<string, unknown>; children?: unknown[] }
const textOf = (x: unknown): string => (typeof x === 'string' ? x : ((x as El).children ?? []).map(textOf).join(''))
async function screen(ui: M): Promise<string[]> {
  const root = (await ui.drawn({ in: `m:view:${SLUG}` })) as unknown as El
  return ((root.children ?? []) as El[]).map(c => textOf(c).slice(2).trimEnd())
}

/** The view written as the pipeline writes a large one: rows.json naming its parts, each a slice of the rows. */
function files(v: { spec: ViewSpec; data: ViewData }, parts: number): Map<string, string> {
  const out = new Map<string, string>([[`${DIR}/view.json`, JSON.stringify(v.spec)]])
  const names = Array.from({ length: parts }, (_, i) => `rows-${i + 1}.json`)
  out.set(`${DIR}/rows.json`, JSON.stringify({ collections: {}, files: 1, parts: names }))
  names.forEach((name, i) => {
    const slice = Object.fromEntries(Object.entries(v.data.collections).map(([k, rows]) => [k, rows.filter((_, j) => j % parts === i)]))
    out.set(`${DIR}/${name}`, JSON.stringify({ collections: slice }))
  })
  return out
}

function world(on: On, fs: Map<string, string>): { reads: Map<string, number>; mtime: { v: number } } {
  const w = { reads: new Map<string, number>(), mtime: { v: 1 } }
  mock.env(on, {})
  on('env.set', () => ({ value: undefined }) as never)
  mock.clock(on, { now: 1_790_000_000_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.messages', () => ({ value: [] }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('fs.read', async ($, e) => {
    if (e.path.endsWith('/prompt/chat.md')) return { value: '# thimble-cc-mod\n' }
    const t = fs.get(e.path)
    if (t === undefined) throw new Error(`ENOENT: ${e.path}`)
    w.reads.set(e.path, (w.reads.get(e.path) ?? 0) + 1)
    // a read takes a moment, as a file of megabytes does
    for (let i = 0; i < 20; i++) await Promise.resolve()
    return { value: t }
  })
  on('fs.stat', async ($, e) => {
    if (!fs.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    await Promise.resolve()
    return { value: { kind: 'file', size: 1, mtimeMs: w.mtime.v, isLink: false } }
  })
  on('fs.list', ($, e) => ({ value: e.path.endsWith('/views') ? [{ name: SLUG, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] : [] }) as never)
  on('fs.exists', ($, e) => ({ value: fs.has(e.path) }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.focus', () => ({}) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('ui.panes', () => ({ value: [] }) as never)
  on('prompt.read', () => ({ value: { text: '' } }) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: ['(the engine row)'] })
  })
  return w
}

test('drawings that ask for a view while it is read share one read; a changed view is read once more', async ($, on) => {
  const w = world(on, files(largeView(6000, 600), 4))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'thimble-view', args: SLUG } as never)
  // the panel drawn on two surfaces at once, each drawing asking for the view while the other reads it
  const both = () => Promise.all([PANE, { ...PANE, surface: 'desktop' }].map(p => $.ui.mount(p as never))) as unknown as Promise<M[]>
  const panes = await both()
  const drawn = await Promise.all(panes.map(p => screen(p)))
  for (const lines of drawn) expect(lines[1]).toMatch(/^600 lanes/)
  expect(w.reads.get(`${DIR}/rows-1.json`)).toBe(1)
  for (const p of panes) await p.unmount()
  // the builder wrote new rows: the next drawings read them, once
  w.mtime.v = 2
  const again = await both()
  await Promise.all(again.map(p => screen(p)))
  expect(w.reads.get(`${DIR}/rows-1.json`)).toBe(2)
  expect(w.reads.get(`${DIR}/rows-4.json`)).toBe(2)
  for (const p of again) await p.unmount()
})

test('a burst of keys, or a paste, reaches the search as one key of several characters and is typed whole', () => {
  const { spec, data } = largeView(200, 20)
  let st = reduce(spec, data, initialState(), { op: 'search' }).state
  st = reduce(spec, data, st, { op: 'key', key: 'Rel' }).state
  st = reduce(spec, data, st, { op: 'key', key: 'space' }).state
  st = reduce(spec, data, st, { op: 'key', key: 'ay' }).state
  expect(st.q).toBe('Rel ay')
  // a special key keeps its meaning
  expect(reduce(spec, data, st, { op: 'key', key: 'backspace' }).state.q).toBe('Rel a')
  expect(reduce(spec, data, st, { op: 'key', key: 'return' }).state.typing).toBe(false)
})

test('keys typed into the search while the view draws are each kept, in order', async ($, on) => {
  world(on, files(largeView(6000, 600), 2))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'thimble-view', args: SLUG } as never)
  const pane = (await $.ui.mount(PANE as never)) as unknown as M
  await screen(pane)
  const IN = { in: `m:view:${SLUG}` }
  // what the Client posts: every act not yet seen, the newest last; five keys land before the first is applied
  const acts: { seq: number; act: unknown }[] = [{ seq: 1, act: { op: 'search' } }]
  await pane.post({ type: 'view', view: SLUG, vorigin: 'typing', acts } as never, IN)
  const posts = [...'Relay'].map((key, i) => {
    acts.push({ seq: i + 2, act: { op: 'key', key } })
    return pane.post({ type: 'view', view: SLUG, vorigin: 'typing', acts: [...acts] } as never, IN)
  })
  await Promise.all(posts)
  await pane.unmount()
  const again = (await $.ui.mount(PANE as never)) as unknown as M
  const lines = await screen(again)
  // the query as it is typed, the cursor after it in inverse
  expect(lines.find(l => l.startsWith('│ ⌕ Relay'))).toMatch(/^│ ⌕ Relay +│$/)
  await again.unmount()
})
