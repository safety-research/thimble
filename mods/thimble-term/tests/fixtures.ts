// Fixture states: what `thimble state <surface>` prints for a small wiki corpus, in the shapes of the server's GET
// routes (hooks/data.ts), and a fake `thimble` command that answers them in a test (`process.run` beneath the plugin).
// The cells and the label are cut from a real workspace (collusion-wiki); the rest is made to fit them.
import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

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
  spec: 'r\\.jina\\.ai|proxy\\.',
  kind: 'regex',
  unit: 'record',
  glob: 'revisions.jsonl',
  labels: ['proxy-link', 'none'],
  trial: false,
  label_stats: { n_labeled: 14591, counts: { none: 9400, 'proxy-link': 5191 } },
  last_run: { total: 14591, matched_total: 14591, labeled: 14591, status: 'done', paths: ['revisions.jsonl'], limit: null },
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
  'card:ff73e071#pages/dse': { ref: 'card:ff73e071#pages/dse', kind: 'cell', cell_id: 'ff73e071', excerpt: 'pages × dse = 3908', meta: { span: { col: 'pages', row: 'dse', value: '3908' } } },
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

// a deck as the writer stores it: slides of sentences (each a bullet) and a figure each, the second slide's single `figure`
export const SLIDES = {
  id: 'slides',
  title: 'The relay in two slides',
  type: 'slides',
  renderer: 'slides',
  slides: [
    { id: 'sl1', heading: 'The export is large', sentences: [{ id: 'y1', text: 'It holds [[4579|card:ff73e071#pages/TOTAL]] pages.', bullet: '-' }, { id: 'y2', text: 'Most are agents\' notes.', bullet: '-' }], figures: [{ id: 'f9', cell: 'card:ff73e071', caption: 'The export per wiki.' }], notes: 'speaker notes' },
    { id: 'sl2', heading: 'What it leaves open', sentences: [{ id: 'y3', text: 'One week only.', bullet: '-' }], figure: { cell: 'card:d0diag00', caption: 'Who acted on what.' } },
  ],
}

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
  /** each tool call as it reached the engine, after thimble-term's tool.call hook */
  toolCalls: Record<string, unknown>[]
  /** a thread's chat by its id, over the fixtures' */
  chats: Record<string, unknown>
  /** a ref's resolution, over the fixtures' */
  resolve: Record<string, unknown>
  /** the prompts submitted to main */
  submitted: string[]
  /** the prompt box's draft */
  draft: string
  /** the panel's elements given the keyboard, by key */
  focused: string[]
  /** each pane opened: its id, title and columns */
  panes: { id: string; title: string; columns?: number }[]
  /** a promise a spawned act waits for before it answers (a label's run that goes on), and what label-run answers */
  hold: Promise<void> | null
  labelRun: Record<string, unknown> | null
  /** a document by its slug, over the fixtures' */
  docs: Record<string, unknown>
  /** the slash commands run, as `/name args` */
  commands: string[]
  /** a file's page by its path, over the fixtures' (null: it cannot be read; a function: the page from the line
   *  `--start` names, as thimble pages a file) */
  pages: Record<string, unknown>
  /** when the conversation began, as Claude Code's session figures say it (a resumed one began before its process) */
  startedAt?: number
  /** what `thimble state opens` says each file opens as (`transcript`), by path */
  opens: Record<string, string>
  /** a whole-file JSON transcript's page of turns by its path (`thimble state turns`), over none */
  turns: Record<string, unknown>
  /** whether the panel holds the keyboard, as the engine's record of its panes says it (`ui.panes`); left out, unsaid;
   *  `grantOnReopen`: an open with `focus` while it is false gives the panel the keys, as Claude Code does once the prompt
   *  holds them over an empty composer */
  paneFocused?: boolean
  grantOnReopen?: boolean
  /** each open's `focus` */
  focusAsked: boolean[]
  /** the text typed into the prompt box by `$.prompt.fill` (a key the panel does not bind) */
  filled: string[]
  /** thimble's view host (`thimble view host`, hooks/viewhost.ts) as the test plays it: each request it got, and the
   *  frame and acts it answers an event with */
  viewHost: { requests: { path: string; body: Record<string, unknown> }[]; frame: (n: number, ev?: Record<string, unknown>) => Record<string, unknown>; acts: (ev: Record<string, unknown>) => Record<string, unknown>[]; started: number }
}

/** A terminal view's frame as a program draws it (backend/app/term_kit/kit.mjs): a top row with a control, a list of
 *  three rows with the `n`-th chosen, its keys and hints. */
export function viewFrame(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const rows = ['first row', 'second row', 'third row']
  const chosen = Math.max(0, Math.min(2, n))
  return {
    seq: n + 1,
    ack: n,
    lines: [
      [{ s: '  ' }, { s: 'Color by', d: true }, { s: '  ' }, { s: 'Kind' }],
      ...rows.map((r, i) => (i === chosen ? [{ s: '❯ ', fg: 'suggestion' }, { s: '●', fg: '#1d7fc0' }, { s: ` ${r}`, fg: 'suggestion' }] : [{ s: '  ' }, { s: '●', fg: '#1d7fc0' }, { s: ` ${r}` }])),
      [{ s: '  ' }, { s: '▁▃█▃▁', fg: '#1d7fc0' }],
    ],
    hits: [{ y: 0, x0: 12, x1: 16, tip: 'choose what colors the view' }, ...rows.map((_, i) => ({ y: i + 1, x0: 2, x1: 40, row: true })), { y: 4, x0: 2, x1: 7, drag: true, tip: 'drag to frame a range' }],
    hints: ['↑↓ to choose', 'Enter to open', 'c to color by', '[ ] to pan'],
    keys: ['up', 'down', 'return', 'c', '[', ']'],
    typing: false,
    sub: [],
    ...over,
  }
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
    toolCalls: [],
    chats: {},
    resolve: {},
    submitted: [],
    draft: '',
    focused: [],
    panes: [],
    hold: null,
    labelRun: null,
    docs: {},
    commands: [],
    pages: {},
    opens: {},
    turns: {},
    focusAsked: [],
    filled: [],
    viewHost: { requests: [], frame: n => viewFrame(n), acts: () => [], started: 0 },
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
  // a file the renderer writes (the workspace's terminal/chat.json) is kept, and read back
  on('fs.write', ($, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined } as never
  })
  // the session's figures: it began when the test's clock starts, unless a test says it began earlier (a resume)
  on('session.usage', () => ({ value: { startedAt: w.startedAt ?? 1_790_000_000_000, context: {}, rateLimits: [] } }) as never)
  on('fs.stat', ($, e) => {
    const t = w.stamps.get(e.path)
    if (t === undefined) return { deny: `ENOENT: ${e.path}` } as never
    return { value: { kind: 'file', size: 1, mtimeMs: t, isLink: false } }
  })
  // a folder's listing: one entry per stamp under it, its time the stamp (`ui.jsonl` sits in the workspace itself)
  on('fs.list', ($, e) => {
    const out = [...w.stamps.entries()].filter(([p]) => p === e.path || p.startsWith(`${e.path}/`)).map(([p, t]) => ({ name: p === e.path ? '.' : p.slice(e.path.length + 1), kind: 'file', size: 1, mtimeMs: t, isLink: false }))
    return { value: out } as never
  })
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
      // a thread's answer handed back to main: its meta says so from then on, as thimble's does (threads.hand_back_state)
      if (what === 'hand-back') {
        const chat = w.chats[String(payload.thread)] as { meta: Record<string, unknown> } | undefined
        if (chat) chat.meta = { ...chat.meta, hand_back: 'handed' }
        return out({ ok: true, thread: payload.thread, hand_back: 'handed' })
      }
      // a label deleted leaves the labels and home; one that is not there is refused, as thimble refuses it
      if (what === 'label-delete') {
        const ls = w.states.labels as { id: string; name?: string }[]
        const l = ls.find(x => x.id === payload.label)
        if (!l) return out({ error: `no label '${String(payload.label)}'` }, 1)
        w.states.labels = ls.filter(x => x !== l) as typeof w.states.labels
        w.states.home = { ...w.states.home, labels: w.states.home.labels - 1 }
        return out({ ok: true, label: l.id, name: l.name, deleted: true })
      }
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
      case 'label': {
        const l = (w.states.labels as { id: string }[]).find(x => x.id === rest[0])
        return l ? out(l) : out({ error: 'no label' }, 1)
      }
      case 'docs':
        return out(w.states.docs)
      case 'doc':
        if (w.docs[rest[0]!]) return out(w.docs[rest[0]!])
        return rest[0] === 'report' ? out(DOC) : rest[0] === 'slides' ? out(SLIDES) : out({ error: 'no doc' }, 1)
      case 'threads':
        return out(w.states.threads)
      case 'thread':
        if (w.chats[rest[0]!]) return out(w.chats[rest[0]!])
        return rest[0] === 't1' ? out(THREAD_T1) : out({ meta: { id: rest[0], kind: 'thread', title: 'new thread', running: true }, events: [{ type: 'user', text: 'a question' }] })
      case 'agents':
        return out(w.states.agents)
      case 'files':
        if (rest[0] && typeof w.pages[rest[0]] === 'function') return out((w.pages[rest[0]] as (start: number) => unknown)(rest[1] === '--start' ? Number(rest[2]) : 1))
        if (rest[0] && w.pages[rest[0]] !== undefined) return w.pages[rest[0]] === null ? out({ error: `could not read ${rest[0]}` }, 1) : out(w.pages[rest[0]])
        return rest[0] ? out(w.states.file) : out(w.states.files)
      case 'turns':
        return out(w.turns[rest[0]!] ?? { path: rest[0], total: 0, start: 0, turns: [], n_groups: 0, groups: {}, none: `${rest[0]} holds no messages to show as a transcript` })
      case 'opens': {
        const paths = JSON.parse(rest[0] ?? '[]') as string[]
        return out(Object.fromEntries(paths.filter(p => w.opens[p]).map(p => [p, w.opens[p]])))
      }
      case 'resolve': {
        const refs = JSON.parse(rest[0] ?? '[]') as string[]
        return out(Object.fromEntries(refs.map(r => [r, w.resolve[r] ?? RESOLVE[r] ?? { error: `no such place: ${r}`, status: 404 }])))
      }
      case 'ui':
        return out(w.states.ui)
      default:
        return out({ error: `no surface ${what}` }, 1)
    }
  })
  // an act that runs until a label's run ends (actLong): started beside the session, its answer read once it exits
  // (the test's own hook is the bottom: it yields the chunks and returns `{ value }` with how the child ended)
  on('process.spawn', async function* ($, e, next) {
    void next
    const argv = [...e.argv]
    w.calls.push(argv)
    // thimble's view host: ready on its socket, then running for the session
    if (argv[1] === 'view' && argv[2] === 'host') {
      w.viewHost.started++
      yield { stream: 'stdout' as const, text: `${JSON.stringify({ t: 'ready', socket: '/tmp/thimble-tv-test/s', token: 'tok' })}\n` }
      await new Promise(() => {})
    }
    const [, , what, , , payload] = argv
    w.acts.push({ kind: what!, payload: JSON.parse(payload ?? '{}') as Record<string, unknown> })
    if (w.hold) await w.hold
    const answer = what === 'label-run' ? (w.labelRun ?? { ok: true, label: LABEL.id, summary: { status: 'done', labeled: 30, failed: 0, counts: { 'proxy-link': 12, none: 18 } } }) : { ok: true }
    yield { stream: 'stdout' as const, text: JSON.stringify(answer) }
    return { value: { code: 0, signal: null } } as never
  })
  // the view host's routes (hooks/viewhost.ts): a view opens on its first frame, an event answers with its next one
  let viewN = 0
  on('http.fetch', ($, e) => {
    const path = new URL(e.url).pathname
    const body = JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>
    w.viewHost.requests.push({ path, body })
    const ok = (v: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(v) } }) as never
    if (e.init?.socketPath !== '/tmp/thimble-tv-test/s' || e.init?.headers?.['x-thimble-token'] !== 'tok') return { value: { status: 403, ok: false, headers: {}, text: '{"error": "no token"}' } } as never
    if (path === '/open') {
      viewN = 0
      return ok({ id: 'v1', frame: w.viewHost.frame(0) })
    }
    if (path === '/event') {
      const ev = body.event as Record<string, unknown>
      if (ev.t === 'key' && ev.key === 'down') viewN++
      if (ev.t === 'key' && ev.key === 'up') viewN--
      return ok({ frame: w.viewHost.frame(viewN, ev), acts: w.viewHost.acts(ev) })
    }
    return ok({ ok: true })
  })
  on('ui.open', ($, e) => {
    w.focusAsked.push(Boolean((e as { focus?: unknown }).focus))
    if (w.paneFocused === false && w.grantOnReopen && w.opened.includes(e.id) && (e as { focus?: unknown }).focus) w.paneFocused = true
    w.opened.push(e.id)
    w.panes.push({ id: e.id, title: String((e as { title?: unknown }).title ?? ''), ...(typeof (e as { columns?: unknown }).columns === 'number' ? { columns: (e as { columns: number }).columns } : {}) })
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', ($, e) => {
    w.closed.push(e.id)
    return { value: undefined } as never
  })
  // the panes open: each opened and not closed since, placed
  on('ui.panes', () => ({ value: [...new Set(w.opened)].filter(id => w.opened.filter(x => x === id).length > w.closed.filter(x => x === id).length).map(id => ({ id, isPlaced: true, ...(w.paneFocused === undefined ? {} : { isFocused: w.paneFocused }) })) }) as never)
  on('ui.toast', ($, e) => {
    w.toasts.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined } as never
  })
  on('ui.log', () => ({ value: undefined }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('command.run', ($, e) => {
    w.commands.push(`/${e.command} ${e.args}`.trim())
    return { text: '(the engine command)' }
  })
  on('tool.call', ($, e) => {
    w.toolCalls.push({ ...(e as unknown as Record<string, unknown>) })
    return { result: w.toolText, text: w.toolText } as never
  })
  on('ui.copy', () => ({ value: { isCopied: true } }) as never)
  on('prompt.submit', ($, e) => {
    w.submitted.push(String((e as { text?: unknown }).text ?? ''))
    return { text: String((e as { text?: unknown }).text ?? '') } as never
  })
  on('ui.focus', ($, e) => {
    w.focused.push(String((e as { key?: unknown }).key ?? ''))
    return { value: {} } as never
  })
  on('prompt.read', () => ({ value: { text: w.draft, cursor: w.draft.length } }) as never)
  on('prompt.fill', ($, e) => {
    const text = String((e as { text?: unknown }).text ?? '')
    w.filled.push(text)
    w.draft += text
    return { isFilled: true, text: w.draft, cursor: w.draft.length } as never
  })
  on('prompt.edit', ($, e) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    // a command's output row as the engine draws it: its text
    if (e.component === 'CommandOutput') return Text({ children: [String((e.props as { text?: unknown }).text ?? '')] })
    // a tool's row as the engine draws it from its input, and a task's notice by its words
    if (e.component === 'ToolUse') return Text({ children: [`${String((e.props as { tool?: unknown }).tool)}(${JSON.stringify((e.props as { input?: unknown }).input)})`] })
    if (e.component === 'UserMessage' && (e.props as { origin?: { kind?: string } }).origin?.kind === 'task-notification') return Text({ children: [String((e.props as { text?: unknown }).text ?? '')] })
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

/** The panel taking the keys as Claude Code gives them to a pane opened with `focus`: the relay's `autoFocus` Button
 *  (panel.tsx RELAY) takes the focus ring, which raises `ui.focus` with origin the plugin. */
export async function takesKeys($: Engine): Promise<void> {
  await $.ui.focus({ requestId: 'thimble-term', component: 'Pane', element: 'keys-pick', origin: { kind: 'plugin', name: 'thimble-term' } } as never)
}
