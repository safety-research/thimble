// The file browser (/thimble-files): which refs name a file and its record, the record selected where a file's view
// shows it, the tree's click opening a file, the way back to the tree, and the menu's "open in files".
// `claude plugin test mods/thimble-cc-mod`; helper/files.py, which writes these views, has tests/test_files.py.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

import { fileRef, recordState } from '../hooks/files'
import { menuItems } from '../hooks/gestures'
import { initialState, reduce, rowContext, viewLayout } from '../hooks/viewdraw'
import { validateData, validateSpec } from '../hooks/viewspec'
import type { ViewData, ViewSpec } from '../hooks/viewspec'

const text = (lines: { s: string }[][]) => lines.map(l => l.map(s => s.s).join('')).join('\n')

// the tree and a file's view as helper/files.py writes them, trimmed
const TREE: ViewSpec = {
  version: 1, name: 'Files', slug: 'files', description: 'Every file of the folder.', scope: ['**/*'],
  collections: [{
    name: 'files', one: 'one file of the folder', key: 'path', title: 'name', ref: 'ref', opens: 'path',
    fields: [{ name: 'path', type: 'text' }, { name: 'name', type: 'text' }, { name: 'folder', type: 'category' }, { name: 'kind', type: 'category' },
      { name: 'records', type: 'number' }, { name: 'size', type: 'number', unit: 'KB' }, { name: 'ref', type: 'ref' }],
    detail: { meta: ['folder', 'kind'], fields: ['path', 'records', 'size'] },
  }],
  stats: [{ label: 'files', collection: 'files', agg: 'count' }],
  tabs: [{ name: 'Files', collection: 'files', overview: { kind: 'bars', field: 'kind' }, zoom: 'a click on a bar keeps the files of that kind',
    filter: { fields: ['kind', 'folder'], search: ['path'] },
    body: [{ kind: 'table', group: 'folder', sort: { field: 'path' }, columns: [{ field: 'name' }, { field: 'kind' }, { field: 'records' }, { field: 'size' }] }] }],
  labels: false,
}
const TREE_ROWS: ViewData = {
  collections: { files: [
    { path: 'chat.jsonl', name: 'chat.jsonl', folder: 'corpus/', kind: 'transcript', records: 4, size: 0.4, ref: 'chat.jsonl#L1' },
    { path: 'runs/r1/log.txt', name: 'log.txt', folder: 'corpus/runs/r1/', kind: 'text', records: 12, size: 1.2, ref: 'runs/r1/log.txt#L1' },
  ] },
  files: 2,
}
const FILE: ViewSpec = {
  version: 1, name: 'chat.jsonl', slug: 'file-0123456789ab', description: 'chat.jsonl: transcript', scope: ['chat.jsonl'], up: 'files', source: 'chat.jsonl',
  collections: [
    { name: 'records', one: 'one record of the file', key: 'n', title: 'n', ref: 'ref',
      fields: [{ name: 'n', type: 'number', label: 'line' }, { name: 'speaker', type: 'category', label: 'role' }, { name: 'said', type: 'text', label: 'content' },
        { name: 'kind', type: 'category' }, { name: 'ref', type: 'ref' }],
      detail: { meta: ['speaker'], text: 'said' } },
    { name: 'lines', one: 'one line of the file', key: 'n', title: 'line', ref: 'ref',
      fields: [{ name: 'n', type: 'number', label: 'line' }, { name: 'line', type: 'text', label: 'text' }, { name: 'ref', type: 'ref' }], detail: { text: 'line' } },
  ],
  tabs: [
    { name: 'Transcript', collection: 'records', where: { field: 'speaker', not: null }, overview: { kind: 'bars', field: 'speaker' }, zoom: "a click on a bar keeps that speaker's turns",
      filter: { fields: ['speaker'], search: ['said'] }, body: [{ kind: 'transcript', speaker: 'speaker', text: 'said', sort: { field: 'n' } }] },
    { name: 'Table', collection: 'records', zoom: 'none', filter: { fields: [], search: ['said'] }, body: [{ kind: 'table', columns: [{ field: 'n' }, { field: 'speaker' }, { field: 'said' }] }] },
    { name: 'Raw', collection: 'lines', zoom: 'none', filter: { fields: [] }, body: [{ kind: 'table', columns: [{ field: 'n' }, { field: 'line' }] }] },
  ],
  labels: true,
}
const FILE_ROWS: ViewData = {
  collections: {
    records: [
      { n: 1, speaker: 'user', said: 'How many pages?', kind: 'message', ref: 'chat.jsonl#L1' },
      { n: 2, speaker: 'assistant', said: '▸ Bash wc -l pages.jsonl', kind: 'tool call', ref: 'chat.jsonl#L2' },
      { n: 3, ref: 'chat.jsonl#L3' },
      { n: 4, speaker: 'assistant', said: '4,579 pages.', kind: 'message', ref: 'chat.jsonl#L4' },
    ],
    lines: [1, 2, 3, 4].map(n => ({ n, line: `{"line": ${n}}`, ref: `chat.jsonl#L${n}` })),
  },
  files: 1,
}

test('the refs that name a file of the folder, and the record each cites', () => {
  expect(fileRef('revisions.jsonl#L12')).toEqual({ path: 'revisions.jsonl', line: 12 })
  expect(fileRef('[[3 pages|runs/r1/log.txt#L4-L9]]')).toEqual({ path: 'runs/r1/log.txt', line: 4 })
  expect(fileRef('./data/a.json#/items/2')).toEqual({ path: 'data/a.json', item: 3 })
  expect(fileRef('notes.md')).toEqual({ path: 'notes.md' })
  expect(fileRef('table.csv#row=3')).toEqual({ path: 'table.csv' })
  for (const r of ['card:abc#x/1', 'call:12#L3', 'forge.db#prs/7', '/etc/passwd#L1', '../up.txt#L1', 'view:timeline/INC-1']) expect([r, fileRef(r)]).toEqual([r, null])
})

test("the views the mod writes validate as its own: a tab may leave out its overview, and `opens` names a field", () => {
  expect(validateSpec(TREE)).toEqual([])
  expect(validateSpec(FILE, { builtin: true })).toEqual([])
  expect(validateSpec(FILE).some(p => p.startsWith('tabs[1].overview: required'))).toBe(true)
  expect(validateSpec({ ...TREE, collections: [{ ...TREE.collections[0]!, opens: 'nope' }] })).toContain('collections[0].opens: must name a declared field holding a path')
  expect(validateData(FILE, FILE_ROWS).problems).toEqual([])
})

test('a click on a file of the tree selects it and shows its first lines, a second click or Enter opens it; other views select as before', () => {
  const r = reduce(TREE, TREE_ROWS, initialState(), { op: 'select', c: 'files', k: 'runs/r1/log.txt' })
  expect(r.effect).toBeUndefined()
  // the tree keeps the file selected, so it shows where the analyst was when they come back
  expect(r.state.sel).toEqual({ c: 'files', k: 'runs/r1/log.txt' })
  expect(reduce(TREE, TREE_ROWS, r.state, { op: 'select', c: 'files', k: 'runs/r1/log.txt' }).effect).toEqual({ file: 'runs/r1/log.txt' })
  expect(reduce(TREE, TREE_ROWS, r.state, { op: 'key', key: 'return' }).effect).toEqual({ file: 'runs/r1/log.txt' })
  const f = reduce(FILE, FILE_ROWS, initialState(), { op: 'select', c: 'records', k: '1' })
  expect(f.effect).toBeUndefined()
  expect(f.state.sel).toEqual({ c: 'records', k: '1' })
})

test("a file's way back to the tree is a step of the panel's path, which ← or backspace takes too", () => {
  const lay = viewLayout(FILE, FILE_ROWS, initialState(), 90, 30)
  // the title row is the file's name alone (no `1 file ›`: the view reads no file but its own); the path row above the
  // view (register.tsx) holds `files ›`
  expect(text(lay.lines).split('\n')[0]!.trim()).toBe('chat.jsonl')
  expect(text(viewLayout(TREE, TREE_ROWS, initialState(), 90, 30).lines).split('\n')[0]!.trim()).toBe(TREE.name)
  expect(lay.hits.find(h => h.act.op === 'up')).toBeUndefined()
  expect(reduce(FILE, FILE_ROWS, initialState(), { op: 'up' }).effect).toEqual({ up: true })
  expect(reduce(FILE, FILE_ROWS, initialState(), { op: 'key', key: 'left' }).effect).toEqual({ up: true })
  // a row followed within the view goes back to that row first
  const followed = { ...initialState(), sel: { c: 'records', k: '4' }, back: [{ c: 'records', k: '1' }] }
  expect(reduce(FILE, FILE_ROWS, followed, { op: 'key', key: 'backspace' }).state.sel).toEqual({ c: 'records', k: '1' })
  // the tree has nowhere to go back to
  expect(reduce(TREE, TREE_ROWS, initialState(), { op: 'up' }).effect).toBeUndefined()
  expect(text(viewLayout(TREE, TREE_ROWS, initialState(), 90, 30).lines).includes('‹')).toBe(false)
})

test('the transcript shows the turns, a tool call folded to one line; Raw shows every line by its number', () => {
  const t = text(viewLayout(FILE, FILE_ROWS, initialState(), 90, 30).lines)
  expect(t).toContain('Bash wc -l pages.jsonl')
  expect(t).toContain('3 records')
  const raw = text(viewLayout(FILE, FILE_ROWS, { ...initialState(), tab: 2 }, 90, 30).lines)
  for (const n of [1, 2, 3, 4]) expect(raw).toContain(`{"line": ${n}}`)
})

test("a cited line is selected in the first tab that shows it; a record the Transcript leaves out, in the next", () => {
  expect(recordState(FILE, FILE_ROWS, 4)).toMatchObject({ tab: 0, sel: { c: 'records', k: '4' }, q: '', facets: {} })
  // line 3 has no speaker: the Transcript keeps it out, the Table shows it
  expect(recordState(FILE, FILE_ROWS, 3)).toMatchObject({ tab: 1, sel: { c: 'records', k: '3' } })
  expect(recordState(FILE, FILE_ROWS, 99)).toBeNull()
  // the selected record is drawn in the window with its detail
  const st = { ...initialState(), ...recordState(FILE, FILE_ROWS, 4)! }
  expect(text(viewLayout(FILE, FILE_ROWS, st, 90, 30).lines)).toContain('↗ chat.jsonl line 4')
})

test("a side thread about a record is told the file and its line, not a view's folder", () => {
  const about = rowContext(FILE, FILE_ROWS, '@file-0123456789ab', { c: 'records', k: '2' })!
  expect(about.ref).toBe('[[chat.jsonl#L2]]')
  expect(about.label).toBe('chat.jsonl line 2')
  expect(about.context).toContain('in the file chat.jsonl')
  expect(about.context).toContain('The file browser (/thimble-files) shows chat.jsonl')
  expect(about.context.includes('.thimble-cc-mod/views/')).toBe(false)
})

test('the menu of a record or a citation of a file offers it in the file browser; a card or a call does not', () => {
  const acts = (t: Parameters<typeof menuItems>[0]) => menuItems(t).map(m => m.act)
  expect(acts({ kind: 'citation', ref: '[[12|revisions.jsonl#L4]]' })).toContain('files')
  expect(acts({ kind: 'record', ref: 'chat.jsonl#L2', text: 'Bash' })).toContain('files')
  expect(acts({ kind: 'citation', ref: '[[3|call:abc#L2]]' })).not.toContain('files')
  expect(acts({ kind: 'card', cardId: 'c1' })).not.toContain('files')
})

// ------------------------------------------------------------------------------------------------ the panel

const CWD = '/corpus/ops'
const PANE = { plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 200, rows: 55 }, props: { bodyColumns: 96, scroll: { bodyRows: 46 } } } as const
type M = Mounted<'terminal'>
type El = { type: string; props: Record<string, unknown>; children?: unknown[] }
const textOf = (x: unknown): string => (typeof x === 'string' ? x : ((x as El).children ?? []).map(textOf).join(''))
/** A view's lines as its Client draws them, without the 2-cell margin where `❯` marks the selected row. */
const M2 = 2
async function screen(ui: M, key: string): Promise<string[]> {
  const root = (await ui.drawn({ in: key })) as unknown as El
  return ((root.children ?? []) as El[]).map(c => textOf(c).slice(M2).trimEnd())
}

/** A folder whose file browser helper/files.py has written: the tree and chat.jsonl's view. */
function world(on: On): { runs: string[][] } {
  const w = { runs: [] as string[][] }
  const files = new Map([
    [`${CWD}/.thimble-cc-mod/files/files/view.json`, JSON.stringify(TREE)],
    [`${CWD}/.thimble-cc-mod/files/files/rows.json`, JSON.stringify(TREE_ROWS)],
    [`${CWD}/.thimble-cc-mod/files/file-0123456789ab/view.json`, JSON.stringify(FILE)],
    [`${CWD}/.thimble-cc-mod/files/file-0123456789ab/rows.json`, JSON.stringify(FILE_ROWS)],
  ])
  mock.env(on, {})
  on('env.set', () => ({ value: undefined }) as never)
  mock.clock(on, { now: 1_790_000_000_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.messages', () => ({ value: [] }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('fs.read', ($, e) => {
    if (e.path.endsWith('/prompt/chat.md')) return { value: '# thimble-cc-mod\n' }
    const t = files.get(e.path)
    if (t === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: t }
  })
  on('fs.stat', ($, e) => {
    if (!files.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }
  })
  on('fs.list', () => ({ value: [] }) as never)
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    const argv = (e as { argv: string[] }).argv
    w.runs.push(argv)
    const slug = argv.includes('open') ? 'file-0123456789ab' : 'files'
    const stdout = argv.some(a => a.endsWith('/helper/files.py')) ? JSON.stringify({ ok: true, slug, name: slug }) : '[]'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.focus', () => ({}) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('ui.panes', () => ({ value: [] }) as never)
  on('prompt.read', () => ({ value: { text: '' } }) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: ['(the engine row)'] })
  })
  return w
}

test('/thimble-files opens the tree; a click on a file opens it, "?" beside a record asks about it, the path\'s "files" goes back', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const r = await $.command.run({ command: 'thimble-files', args: '' } as never)
  expect((r as { text?: string }).text).toBe('opened the files')
  expect(w.runs.at(-1)).toContain('tree')
  let pane = (await $.ui.mount(PANE as never)) as unknown as M
  let lines = await screen(pane, 'm:view:@files')
  expect(lines[0]).toMatch(/^Files/)
  expect(lines[1]).toMatch(/^2 files/)
  const row = lines.findIndex(l => l.includes('chat.jsonl'))
  // a first click selects the file, a second opens it
  await pane.pointer({ type: 'down', x: 4, y: row, button: 'left', in: 'm:view:@files' })
  await pane.unmount()
  pane = (await $.ui.mount(PANE as never)) as unknown as M
  lines = await screen(pane, 'm:view:@files')
  await pane.pointer({ type: 'down', x: 4, y: lines.findIndex(l => l.includes('chat.jsonl')), button: 'left', in: 'm:view:@files' })
  await pane.unmount()
  // the helper wrote the file's view, which the panel now shows
  expect(['open', 'chat.jsonl'].every(a => w.runs.at(-1)!.includes(a))).toBe(true)
  pane = (await $.ui.mount(PANE as never)) as unknown as M
  const IN = { in: 'm:view:@file-0123456789ab' }
  lines = await screen(pane, IN.in)
  expect(lines[0]).toMatch(/^chat\.jsonl/)
  // "?" in the margin of a turn: a side thread about that record
  // a turn's row: the speaker's ● at A0, its name at A2, its time against the right edge
  const turn = lines.findIndex(l => /^● user\b/.test(l))
  expect(turn).toBeGreaterThan(0)
  await pane.pointer({ type: 'down', x: 93, y: turn, button: 'left', ...IN })
  await pane.unmount()
  // the panel shows the side thread about that record, named by its place
  pane = (await $.ui.mount(PANE as never)) as unknown as M
  expect(textOf(await pane.drawn())).toContain('chat.jsonl line 1')
  await pane.unmount()
  // back in the file, then to the tree
  await $.command.run({ command: 'thimble-files', args: 'chat.jsonl:4' } as never)
  pane = (await $.ui.mount(PANE as never)) as unknown as M
  lines = await screen(pane, IN.in)
  expect(lines.some(l => l.includes('↗ chat.jsonl line 4'))).toBe(true)
  // opened by the command, the file's path is home › files › chat.jsonl: its "files" step leads to the tree
  await pane.press({ key: 'crumb-up' })
  await pane.unmount()
  pane = (await $.ui.mount(PANE as never)) as unknown as M
  expect((await screen(pane, 'm:view:@files'))[0]).toMatch(/^Files/)
  await pane.unmount()
})

test("a window of a longer file says which lines it holds, and pages to the windows before and after it", () => {
  const spec: ViewSpec = { ...FILE, window: { from: 4001, to: 8000, total: 14591, unit: 'lines' } }
  expect(validateSpec(spec, { builtin: true })).toEqual([])
  const lay = viewLayout(spec, FILE_ROWS, initialState(), 90, 30)
  expect(text(lay.lines).split('\n')[1]).toMatch(/lines 4001-8000 of 14,591 +earlier {2}later$/)
  const pages = lay.hits.filter(h => h.act.op === 'page').map(h => (h.act as { d: number }).d)
  expect(pages).toEqual([-1, 1])
  expect(reduce(spec, FILE_ROWS, initialState(), { op: 'page', d: 1 }).effect).toEqual({ file: 'chat.jsonl', from: 8001 })
  expect(reduce(spec, FILE_ROWS, initialState(), { op: 'page', d: -1 }).effect).toEqual({ file: 'chat.jsonl', from: 1 })
  // the first window has nothing before it; a file of one window shows no line
  const first = { ...FILE, window: { from: 1, to: 4000, total: 6000, unit: 'lines' } }
  expect(text(viewLayout(first, FILE_ROWS, initialState(), 90, 30).lines)).not.toContain('earlier')
  expect(reduce(first, FILE_ROWS, initialState(), { op: 'page', d: -1 }).effect).toBeUndefined()
  expect(text(viewLayout(FILE, FILE_ROWS, initialState(), 90, 30).lines)).not.toContain(' of ')
})
