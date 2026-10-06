// Fixture states: what `thimble state <surface>` prints for a small wiki corpus, in the shapes of the server's GET
// routes (hooks/data.ts), and a fake `thimble` command that answers them in a test (`process.run` beneath the plugin).
// The cells and the label are cut from a real workspace (collusion-wiki); the rest is made to fit them.
import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'

export const WS = '/home/a/.thimble/app/workspaces/wiki'
export const CWD = '/corpus/wiki'
export const CLI = '/tree/plugin/bin/thimble'

const html = `<div><table border="1" class="dataframe">
  <thead>
    <tr style="text-align: right;"><th></th><th>pages</th><th>revisions</th></tr>
    <tr><th>wiki</th><th></th><th></th></tr>
  </thead>
  <tbody>
    <tr><th>dse</th><td>3908</td><td>13403</td></tr>
    <tr><th>probier</th><td>601</td><td>1013</td></tr>
    <tr><th>TOTAL</th><td>4579</td><td>14591</td></tr>
  </tbody>
</table></div>`

const cell = (id: string, kind: string, title: string, rest: Record<string, unknown> = {}) => ({
  id,
  notebook: 'g1',
  kind,
  title,
  takeaway: '',
  labels: [],
  created_by: 'main',
  ts: '2026-10-06T10:00:00+00:00',
  ...rest,
})

export const CELLS: Record<string, Record<string, unknown>> = {
  ff73e071: cell('ff73e071', 'table', 'What does the export hold per wiki?', {
    takeaway: 'The export holds [[4579|card:ff73e071#pages/TOTAL]] pages and [[14592|card:ff73e071#revisions/TOTAL]] revisions.',
    code: "pages = pd.read_json('pages.jsonl', lines=True)\n# one row per wiki\ndf",
    status: 'ok',
    outputs: [{ 'text/plain': 'pages revisions', 'text/html': html }],
  }),
  a0frame0: cell('a0frame0', 'table', 'How many records does each file hold?', {
    status: 'ok',
    outputs: [{ 'application/vnd.thimble.frame+json': { columns: ['file', 'records'], types: { file: 'nominal', records: 'quantitative' }, index: null, label: 'file', rows: [['revisions.jsonl', 14591], ['events.jsonl', 19913], ['pages.jsonl', 4579]], total: 3, view: { columns: ['records'], formats: { records: ',d' }, more: 0 } }, 'text/plain': 'file records' }],
  }),
  b0bar000: cell('b0bar000', 'plot', 'Which wikis have the most revisions?', {
    status: 'ok',
    outputs: [{ 'application/vnd.vegalite.v6.json': { mark: { type: 'bar' }, encoding: { x: { field: 'wiki', type: 'nominal' }, y: { field: 'revisions', type: 'quantitative' } }, data: { name: 'd1' }, datasets: { d1: [{ wiki: 'dse', revisions: 13403 }, { wiki: 'probier', revisions: 1013 }, { wiki: 'fractal', revisions: 169 }] } }, 'text/plain': '<VegaLite 6 object>' }],
  }),
  c5466383: cell('c5466383', 'plot', 'How were saves spread over the days?', {
    status: 'ok',
    outputs: [{ 'application/vnd.vegalite.v6.json': { data: { name: 'd2' }, facet: { row: { field: 'event_type', type: 'nominal' } }, spec: { mark: { type: 'bar' }, encoding: { x: { field: 'day', type: 'temporal' }, y: { field: 'rows', type: 'quantitative' } } }, datasets: { d2: [{ day: '2026-05-24', event_type: 'save', rows: 16 }, { day: '2026-05-26', event_type: 'probe', rows: 20 }] } } }],
  }),
  d0diag00: cell('d0diag00', 'diagram', 'Who acted on what?', { payload: { dataset: { nodes: [{ id: 'agents', label: 'agent names' }, { id: 'dse', label: 'dse wiki' }], edges: [{ from: 'agents', to: 'dse', label: 'saves' }, { from: 'admin', to: 'dse', label: 'deletions' }] } } }),
  e0time00: cell('e0time00', 'timeline', 'What happened when?', { status: 'ok', outputs: [{ 'application/vnd.thimble.timeline+json': { events: [{ time: '2026-05-24', label: 'first saves' }, { time: '2026-06-18', label: 'peak afternoon' }] }, 'text/plain': 'timeline: 2 events' }] }),
  a20ecb55: cell('a20ecb55', 'example', 'What does the README say the corpus is?', { payload: { refs: ['README.md#L3', 'README.md#L5'] } }),
  n0note00: cell('n0note00', 'note', 'Working hypothesis', { payload: { text: 'The dse wiki was used as a relay and as a message board.' } }),
  c0cust00: cell('c0cust00', 'custom', 'How concentrated were the saves?', { payload: { html: '<div><div style="font-size:32px">45%</div><div>of all saves landed in one afternoon</div></div>' } }),
  k0code00: cell('k0code00', 'code', 'How many lines?', { status: 'ok', outputs: [{ _stream: 'stdout', 'text/plain': 'revisions.jsonl 14591\nevents.jsonl 19913\n' }] }),
  x0err000: cell('x0err000', 'code', 'Broken', { status: 'error', outputs: [{ 'application/vnd.thimble.error+json': { ename: 'KeyError', evalue: "'wiki'", traceback: [] } }] }),
  w0wait00: cell('w0wait00', 'table', 'Waiting for its run', { status: 'idle', outputs: [], run: { state: 'waiting', by: 'bash', script: 'card-runs/w0wait00.py' } }),
  l0label0: cell('l0label0', 'label', 'links through a fetch proxy', { labels: ['d9b51617'], payload: { concept: 'd9b51617' } }),
}

export const LABEL = {
  id: 'd9b51617',
  name: 'links through a fetch proxy',
  description: 'A revision whose text links through a fetch proxy or reader service.',
  kind: 'regex',
  unit: 'record',
  glob: 'revisions.jsonl',
  labels: ['proxy-link', 'none'],
  trial: false,
  label_stats: { n_labeled: 14591, counts: { none: 9400, 'proxy-link': 5191 } },
  last_run: { total: 14591, labeled: 14591, status: 'done', paths: ['revisions.jsonl'] },
  rows: [
    { ref: 'revisions.jsonl#L10566', label: 'proxy-link', rationale: 'r.jina.ai link', analyst: null, text: 'SEC download https://r.jina.ai/https://www.sec.gov/files/county.json' },
    { ref: 'revisions.jsonl#L1510', label: 'none', rationale: '', analyst: 'none', text: 'Welcome to the wiki' },
  ],
}

export const RESOLVE: Record<string, unknown> = {
  'README.md#L3': { ref: 'README.md#L3', kind: 'record', path: 'README.md', line: 3, blocks: [{ text: 'An export of 4,579 wiki pages and their revisions.' }], excerpt: 'An export of 4,579 wiki pages and their revisions.', context: { before: [{ line: 2, blocks: [{ text: '' }] }], after: [{ line: 4, blocks: [{ text: 'Four wikis.' }] }] } },
  'README.md#L5': { ref: 'README.md#L5', kind: 'record', path: 'README.md', line: 5, blocks: [{ text: 'Each record is one saved revision.' }], excerpt: 'Each record is one saved revision.' },
  'README.md#L99': { error: 'line 99 out of range (README.md has 20 lines)', status: 404 },
  'card:ff73e071#pages/TOTAL': { ref: 'card:ff73e071#pages/TOTAL', kind: 'cell', cell_id: 'ff73e071', excerpt: 'pages × TOTAL = 4579', meta: { span: { col: 'pages', row: 'TOTAL', value: '4579' } } },
  'card:ff73e071#revisions/TOTAL': { ref: 'card:ff73e071#revisions/TOTAL', kind: 'cell', cell_id: 'ff73e071', excerpt: 'revisions × TOTAL = 14591', meta: { span: { col: 'revisions', row: 'TOTAL', value: '14591' } } },
}

export const THREADS = [
  { id: 'main', kind: 'main', title: 'main', created_at: '2026-10-06T09:00:00+00:00', n_messages: 12, running: false },
  { id: 't1', kind: 'thread', role: 'thread', title: 'why is events.jsonl bigger?', anchor: 'card:ff73e071', anchor_text: 'What does the export hold per wiki?', parent: 'main', created_at: '2026-10-06T10:01:00+00:00', last_ts: '2026-10-06T10:02:00+00:00', running: false, answers: 1, seen: 0 },
  { id: 't2', kind: 'thread', role: 'thread', title: 'which pages were deleted?', anchor: null, anchor_text: 'the deletions', parent: 'main', created_at: '2026-10-06T10:03:00+00:00', running: true, answers: 0, seen: 0 },
  { id: 'o1', kind: 'agent', role: 'orientation', title: 'orientation', parent: 'main', created_at: '2026-10-06T10:00:00+00:00', running: true },
]

export const THREAD_T1 = {
  meta: THREADS[1],
  events: [
    { type: 'user', text: 'why is events.jsonl so much bigger?' },
    { type: 'tool_use', id: 'u1', name: 'mcp__plugin_thimble_thimble__add_card', input: { question: 'q' } },
    { type: 'tool_result', id: 'u1', summary: 'card:abc' },
    { type: 'text', delta: 'It holds [[19913|card:a0frame0#records/events.jsonl]] rows, ' },
    { type: 'text', delta: 'one per event.' },
    { type: 'done', result: 'answered' },
  ],
}

export const AGENTS = { rows: [{ name: 'thimble:orientation', label: 'orientation: the whole corpus', state: 'working', kind: 'subagent', chat: 'o1', role: 'orientation' }], line: 'thimble · orientation working · 3 cards', text: '' }

export const DOC = {
  id: 'report',
  title: 'Agents used the dse wiki as a relay',
  type: 'report',
  renderer: 'document',
  sections: [
    { id: 's1', heading: 'The data', paragraphs: [{ id: 'p1', sentences: [{ id: 'x1', text: 'The corpus is an export of four wikis [[README.md#L3]].' }, { id: 'x2', text: 'It holds [[4579|card:ff73e071#pages/TOTAL]] pages.' }] }], figures: [{ id: 'f1', cell: 'cell:ff73e071', caption: 'The export per wiki.', after_paragraph: 'p1' }] },
    { id: 's2', heading: 'The main claim', paragraphs: [{ id: 'p2', sentences: [{ id: 'x3', text: 'One week of June holds most saves.' }] }], figures: [] },
  ],
}

export const STATES = {
  home: { cards: 12, labels: 1, docs: { report: { exists: true, title: 'Agents used the dse wiki as a relay' } }, threads: 2, views: 0, files: 4 },
  cards: { groups: [{ id: 'g1', title: 'Your work', role: 'analyst', ts: '2026-10-06T09:00:00+00:00' }], cells: Object.values(CELLS) },
  labels: [LABEL],
  docs: { report: { exists: true, title: DOC.title, renderer: 'document', name: 'Report' }, slides: { exists: false, renderer: 'slides', name: 'Slides' } },
  threads: THREADS,
  agents: AGENTS,
  files: [
    { path: 'README.md', kind: 'markdown', size_bytes: 1800 },
    { path: 'revisions.jsonl', kind: 'records', size_bytes: 52_000_000 },
    { path: 'data/events.jsonl', kind: 'records', size_bytes: 2_100_000 },
  ],
  file: { path: 'README.md', kind: 'markdown', total_lines: 20, start: 1, records: [{ line: 1, blocks: [{ text: '# Collusion wiki' }] }, { line: 2, blocks: [{ text: '' }] }, { line: 3, blocks: [{ text: 'An export of 4,579 wiki pages and their revisions.' }] }] },
  ui: [] as { n: number; kind: string; args: Record<string, unknown> }[],
}

export type World = {
  calls: string[][]
  acts: { kind: string; payload: Record<string, unknown> }[]
  opened: string[]
  closed: string[]
  toasts: string[]
  files: Map<string, string>
  stamps: Map<string, number>
  states: typeof STATES
  cells: typeof CELLS
  launch: string
  clock: ReturnType<typeof mock.clock>
  /** what the next tool call of main answers */
  toolText: string
}

/** `thimble state` and `thimble act` answered from the fixtures; the workspace's files as `fs` sees them. */
export function world(on: On, opts: { mode?: string; ws?: string | null } = {}): World {
  const w: World = {
    calls: [],
    acts: [],
    opened: [],
    closed: [],
    toasts: [],
    files: new Map(),
    stamps: new Map([[`${WS}/notebooks`, 1]]),
    states: JSON.parse(JSON.stringify(STATES)),
    cells: JSON.parse(JSON.stringify(CELLS)),
    launch: JSON.stringify({ session: 's1', mode: opts.mode ?? 'terminal', fenced: true }),
    clock: undefined as never,
    toolText: 'card:ff73e071\n[out0: table]',
  }
  const ws = opts.ws === undefined ? WS : opts.ws
  mock.env(on, { ...(ws ? { THIMBLE_WS: ws } : {}), THIMBLE_HOME: '/home/a/.thimble', THIMBLE_TERM_CLI: CLI })
  w.clock = mock.clock(on, { now: 1_790_000_000_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: CWD }))
  on('session.cwd', () => ({ value: CWD }))
  on('fs.read', ($, e) => {
    if (e.path === `${WS}/trusted/launch.json`) return { value: w.launch }
    const t = w.files.get(e.path)
    if (t === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: t }
  })
  on('fs.stat', ($, e) => {
    const t = w.stamps.get(e.path)
    if (t === undefined) return { deny: `ENOENT: ${e.path}` } as never
    return { value: { kind: 'file', size: 1, mtimeMs: t, isLink: false } }
  })
  on('fs.list', () => ({ value: [] }) as never)
  const out = (v: unknown, code = 0) => ({ value: { exitCode: code, stdout: JSON.stringify(v), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    w.calls.push(argv)
    if (argv[0] !== CLI) return out({ error: `not thimble: ${argv[0]}` }, 1)
    const [, verb, what, flag, , ...rest] = argv
    if (flag !== '--cwd') return out({ error: 'no --cwd' }, 1)
    if (verb === 'act') {
      const payload = JSON.parse(rest[0] ?? '{}') as Record<string, unknown>
      w.acts.push({ kind: what!, payload })
      if (what === 'thread') return out({ ok: true, thread: 't9' })
      return out({ ok: true })
    }
    switch (what) {
      case 'home':
        return out(w.states.home)
      case 'cards':
        return out({ ...w.states.cards, cells: Object.values(w.cells) })
      case 'card':
        return w.cells[rest[0]!] ? out(w.cells[rest[0]!]) : out({ error: `no card ${rest[0]}` }, 1)
      case 'labels':
        return out(w.states.labels)
      case 'label':
        return rest[0] === LABEL.id ? out(w.states.labels[0]) : out({ error: 'no label' }, 1)
      case 'docs':
        return out(w.states.docs)
      case 'doc':
        return rest[0] === 'report' ? out(DOC) : out({ error: 'no doc' }, 1)
      case 'threads':
        return out(w.states.threads)
      case 'thread':
        return rest[0] === 't1' ? out(THREAD_T1) : out({ meta: { id: rest[0], kind: 'thread', title: 'new thread', running: true }, events: [{ type: 'user', text: 'a question' }] })
      case 'agents':
        return out(w.states.agents)
      case 'files':
        return rest[0] ? out(w.states.file) : out(w.states.files)
      case 'resolve': {
        const refs = JSON.parse(rest[0] ?? '[]') as string[]
        return out(Object.fromEntries(refs.map(r => [r, RESOLVE[r] ?? { error: `no such place: ${r}`, status: 404 }])))
      }
      case 'ui':
        return out(w.states.ui)
      default:
        return out({ error: `no surface ${what}` }, 1)
    }
  })
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', ($, e) => {
    w.closed.push(e.id)
    return { value: undefined } as never
  })
  on('ui.panes', () => ({ value: [] }) as never)
  on('ui.toast', ($, e) => {
    w.toasts.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined } as never
  })
  on('ui.log', () => ({ value: undefined }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('command.run', () => ({ text: '(the engine command)' }))
  on('tool.call', () => ({ result: w.toolText, text: w.toolText }) as never)
  on('ui.copy', () => ({ value: { isCopied: true } }) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: ['(the engine row)'] })
  })
  return w
}

/** Every string a drawn tree shows (a Button's label too), joined. */
export function shown(tree: unknown): string {
  const out: string[] = []
  const walk = (n: unknown) => {
    if (typeof n === 'string') out.push(n)
    else if (Array.isArray(n)) n.forEach(walk)
    else if (n && typeof n === 'object') {
      const o = n as { label?: unknown; text?: unknown; children?: unknown; props?: { label?: unknown; text?: unknown; children?: unknown } }
      const label = o.label ?? o.props?.label
      if (typeof label === 'string') out.push(label)
      const text = o.props?.text
      if (typeof text === 'string') out.push(text)
      walk(o.children ?? o.props?.children)
    }
  }
  walk(tree)
  return out.join('')
}
