// Fixture states: what `thimble state <surface>` prints for a small wiki corpus, in the shapes of the server's GET
// routes (hooks/data.ts), and a fake `thimble` command that answers them in a test (`process.run` beneath the plugin).
// The cells and the label are cut from a real workspace (collusion-wiki); the rest is made to fit them.
//
// thimble is on in the world's session from its start: the session's marker (`<home>/up/<sid>.active`, C1) is there,
// so session.start restores it as after a module reload. `world(on, { active: false })` starts with no marker, for
// the tests of activation; the fake also answers `thimble activate`, `guide`, `features`, `act coverage --stdin`,
// `state coverage` and `state answer-comments`, and the shim's `load_thimble` (`mcp.call`).
import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

export const WS = '/home/a/.thimble/app/workspaces/wiki'
export const CWD = '/corpus/wiki'
export const CLI = '/tree/plugin/bin/thimble'
export const HOME = '/home/a/.thimble'
export const SID = 's1'
/** The session's guide marker and the guide the fake prints (its lead line names the marker, SPEC-v2 3.4). */
export const MARKER = 'a1b2c3d4'
export const GUIDE = `thimble guidance ${MARKER}: thimble is on in this folder. The text below is thimble's guidance for this session.\n\nMake cards with add_card. Cite with [[value|ref]].`

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
  // `offer`: the view proposal waiting for an answer; `notices`: every agent's open notices, newest first (local.py
  // _offer, _notices); none in the fixtures until a test sets them
  home: { cards: 12, labels: 1, docs: { report: { exists: true, title: 'Agents used the dse wiki as a relay' } }, threads: 2, views: 0, files: 4, offer: null as Record<string, unknown> | null, notices: [] as Record<string, unknown>[] },
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
  // the report checks (`thimble state checks`, GET /checks), which name a comment's check
  checks: [
    { id: 'unverified', name: 'Unverifiable', colour: 2, shown: true, builtin: true, runs: {} },
    { id: 'verified', name: 'Verified', colour: 3, shown: false, builtin: true, runs: {} },
    { id: 'judgment', name: 'Judgment calls', colour: 4, shown: true, builtin: true, runs: {} },
  ] as Record<string, unknown>[],
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
  /** acts thimble refuses, by kind, with why */
  refuse?: Record<string, string>
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
  /** the file browser's reads: what `thimble state find` and `grep` answer by the words, `marks` by the file's path,
   *  `tables` by a database's path and `rows` by `<path>:<table>` (a function: the page from `--start`) */
  found: Record<string, unknown>
  grepped: Record<string, unknown>
  marks: Record<string, unknown>
  tables: Record<string, unknown>
  rows: Record<string, unknown>
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
  /** Claude Code's placement of panes (placing), when a test plays it; left out, every open is placed */
  place?: Placement
  // ---- 0.9.0
  /** this conversation's id ($.session.id()) */
  sid: string
  /** what `thimble activate` answers (C2), the calls it got, and a promise it waits for before it answers */
  activate: Record<string, unknown>
  activations: string[][]
  holdActivate: Promise<void> | null
  /** the guide: owed or not, how many times it was marked sent and unmarked */
  guide: string
  guideOwed: boolean
  marked: number
  unmarked: number
  /** the shim: each `$.mcp.call`, whether it writes listed.json, and the error it answers ('' for none) */
  mcp: { server: string; tool: string }[]
  listed: boolean
  mcpError: string
  /** thimble's feature settings (`thimble features`) and each `--set` */
  features: Record<string, boolean>
  sets: string[]
  /** what `act coverage --stdin` answers as the summary line, and each payload it got */
  coverageLine: string
  coverage: Record<string, unknown>[]
  /** `state answer-comments` */
  comments: Record<string, unknown>[]
  running: Record<string, unknown>[]
  /** file sizes and folders `fs.stat` answers (paths of `files` and `stamps` are files of size 1) */
  sizes: Map<string, number>
  dirs: Set<string>
  /** the /config rows `$.config.set` changed, each with the store's synced settings when it came */
  configSets: { key: string; value: unknown; synced?: unknown }[]
  /** the plugin's store */
  store: Map<string, unknown>
  /** what main's next tool call answers, by its input, over `toolText` */
  toolAnswer?: (e: Record<string, unknown>) => Record<string, unknown>
  /** $.session.root() and cwd() fail, or $.session.id() (a hook that throws) */
  rootFails?: boolean
  sidFails?: boolean
  /** a compaction's answer: skipped with this reason, else done */
  compactSkip?: string
  /** each line of the log, the debug log's too */
  logs: string[]
  /** each file written, each state value set (by key), each interval started, each sleep */
  writes: string[]
  stateSets: string[]
  /** the last value the plugin set under each state key (`key:id` for a family member) */
  state: Map<string, unknown>
  timers: number
  sleeps: number
}

/** How Claude Code places a pane (UiOpenResult): an open it was asked for (`asking`: a Button's handler still runs, or
 *  the hook of a command the person typed) at any width; any other from 144 columns, 110 for an id once asked and not
 *  closed by hand since; below that the pane waits undrawn (`waiting`) until the terminal is widened to that width
 *  (`widen`). `log`: each open, asked or not, and whether it was placed. */
export type Placement = { columns: number; asking: boolean; asked: Set<string>; waiting: Set<string>; log: { id: string; asked: boolean; placed: boolean }[]; widen: (columns: number) => void }

/** Claude Code's placement played in world `w` at `columns` wide: from now on its opens answer as Claude Code's do. */
export function placing(w: World, columns: number): Placement {
  const pl: Placement = {
    columns,
    asking: false,
    asked: new Set(),
    waiting: new Set(),
    log: [],
    widen: n => {
      pl.columns = n
      for (const id of [...pl.waiting]) if (n >= (pl.asked.has(id) ? 110 : 144)) pl.waiting.delete(id)
    },
  }
  w.place = pl
  return pl
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
    hints: ['↑↓ to choose', 'Enter to open', '? for all keys'],
    hintKeys: [['up', 'down'], ['return'], ['?']],
    keys: ['up', 'down', 'return', 'c', '?', 'backspace'],
    typing: false,
    sub: [],
    ...over,
  }
}

/** `thimble state` and `thimble act` answered from the fixtures; the workspace's files as `fs` sees them. */
export function world(on: On, opts: { mode?: string; ws?: string | null; active?: boolean; store?: Record<string, unknown> } = {}): World {
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
    found: {},
    grepped: {},
    marks: {},
    tables: {},
    rows: {},
    focusAsked: [],
    filled: [],
    viewHost: { requests: [], frame: n => viewFrame(n), acts: () => [], started: 0 },
    sid: SID,
    activate: { ok: true, session: SID, ws: 'wiki', path: WS, role: 'main', took_over: null, first_in_folder: true },
    activations: [],
    holdActivate: null,
    guide: GUIDE,
    guideOwed: true,
    marked: 0,
    unmarked: 0,
    mcp: [],
    listed: true,
    mcpError: '',
    features: { autoActivate: true, viewProposals: true, labels: true, checks: true, citationMarks: true, coverage: true, cardCheck: true },
    sets: [],
    coverageLine: 'saw 1 of 3 files',
    coverage: [],
    comments: [],
    running: [],
    sizes: new Map(),
    dirs: new Set(),
    configSets: [],
    store: new Map(),
    writes: [],
    logs: [],
    stateSets: [],
    state: new Map(),
    timers: 0,
    sleeps: 0,
  }
  // thimble on in this session from its start (the marker a module reload restores from), unless a test starts it off
  const active = opts.active ?? (opts.ws !== null && (opts.mode ?? 'terminal') === 'terminal')
  const markerOf = (sid: string) => `${HOME}/up/${sid}.active`
  const writeMarker = (sid: string, via: string) => w.files.set(markerOf(sid), JSON.stringify({ cwd: CWD, ws: 'wiki', path: WS, via, role: 'main', mod: true, at: 1_790_000_000 }))
  if (active) {
    writeMarker(SID, 'command')
    w.guideOwed = false
  }
  // the plugin's store ($.store), in memory, which a test reads (w.store)
  for (const [k, v] of Object.entries(opts.store ?? {})) w.store.set(k, JSON.parse(JSON.stringify(v)))
  on('store.get', ($, e) => ({ value: w.store.has(e.key) ? JSON.parse(JSON.stringify(w.store.get(e.key))) : undefined }) as never)
  on('store.set', ($, e) => {
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined } as never
  })
  on('store.delete', ($, e) => {
    w.store.delete(e.key)
    return { value: undefined } as never
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }) as never)
  on('session.id', () => {
    if (w.sidFails) throw new Error('no session id')
    return { value: w.sid } as never
  })
  on('mcp.call', async ($, e) => {
    w.mcp.push({ server: String(e.server), tool: String(e.tool) })
    if (w.mcpError) return { value: { content: [{ type: 'text', text: w.mcpError }], isError: true } } as never
    if (w.listed) w.files.set(`${HOME}/up/${w.sid}/listed.json`, JSON.stringify({ digest: 'd', count: 36, names: [], at: w.clock.now() / 1000 + 1 }))
    return { value: { content: [{ type: 'text', text: w.guide }] } } as never
  })
  on('config.set', ($, e) => {
    w.configSets.push({ key: e.key, value: e.value, synced: w.store.get('settings.synced') })
    return { value: e.value } as never
  })
  const ws = opts.ws === undefined ? WS : opts.ws
  // THIMBLE_NO_MODULE: thimble.ts, in the same hooks module, starts no bridge in these tests
  mock.env(on, { ...(ws ? { THIMBLE_WS: ws } : {}), THIMBLE_HOME: '/home/a/.thimble', THIMBLE_TERM_CLI: CLI, THIMBLE_NO_MODULE: '1' })
  w.clock = mock.clock(on, { now: 1_790_000_000_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => {
    if (w.rootFails) throw new Error('no root')
    return { value: CWD }
  })
  on('session.cwd', () => {
    if (w.rootFails) throw new Error('no cwd')
    return { value: CWD }
  })
  on('fs.read', ($, e) => {
    if (e.path === `${WS}/trusted/launch.json`) return { value: w.launch }
    const t = w.files.get(e.path)
    if (t === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: t }
  })
  // a file the renderer writes (the workspace's terminal/chat.json) is kept, and read back
  on('fs.write', ($, e) => {
    w.writes.push(e.path)
    w.files.set(e.path, e.text)
    return { value: undefined } as never
  })
  // what the plugin set in its state, and the timers it started (the kit answers both beneath this)
  on('state.set', ($, e, next) => {
    const key = String((e as { key?: unknown }).key ?? '')
    const id = (e as { id?: unknown }).id
    w.stateSets.push(key)
    w.state.set(typeof id === 'string' ? `${key}:${id}` : key, (e as { value?: unknown }).value)
    return next(e)
  })
  on('clock.every', { ms: /^/ }, ($, e, next) => {
    w.timers++
    return next(e)
  })
  on('clock.sleep', { ms: /^/ }, ($, e, next) => {
    w.sleeps++
    return next(e)
  })
  // the session's figures: it began when the test's clock starts, unless a test says it began earlier (a resume)
  on('session.usage', () => ({ value: { startedAt: w.startedAt ?? 1_790_000_000_000, context: {}, rateLimits: [] } }) as never)
  on('fs.stat', ($, e) => {
    const path = e.path.replace(/\/+$/, '') || '/'
    if (w.dirs.has(path) || path === CWD) return { value: { kind: 'dir', size: 0, mtimeMs: 1, isLink: false, ...(e.resolve ? { realPath: path } : {}) } } as never
    const size = w.sizes.get(path)
    const t = w.stamps.get(path)
    if (t === undefined && size === undefined && !w.files.has(path)) return { deny: `ENOENT: ${path}` } as never
    return { value: { kind: 'file', size: size ?? 1, mtimeMs: t ?? 1, isLink: false, ...(e.resolve ? { realPath: path } : {}) } } as never
  })
  // a folder's listing: one entry per stamp under it, its time the stamp (`ui.jsonl` sits in the workspace itself)
  on('fs.list', ($, e) => {
    const out = [...w.stamps.entries()].filter(([p]) => p === e.path || p.startsWith(`${e.path}/`)).map(([p, t]) => ({ name: p === e.path ? '.' : p.slice(e.path.length + 1), kind: 'file', size: 1, mtimeMs: t, isLink: false }))
    return { value: out } as never
  })
  const out = (v: unknown, code = 0) => ({ value: { exitCode: code, stdout: JSON.stringify(v), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  const said = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', async ($, e) => {
    const argv = [...e.argv]
    w.calls.push(argv)
    if (argv[0] !== CLI) return out({ error: `not thimble: ${argv[0]}` }, 1)
    const opt = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] ?? '' : '')
    if (argv[1] === 'activate') {
      w.activations.push(argv)
      if (w.holdActivate) await w.holdActivate
      const sid = opt('--session')
      if (w.activate.ok === true) writeMarker(sid, opt('--via'))
      return out({ ...w.activate, session: sid })
    }
    if (argv[1] === 'guide') {
      if (argv.includes('--unmark')) {
        w.unmarked++
        w.guideOwed = true
        return said('')
      }
      if (argv.includes('--if-owed') && !w.guideOwed) return said('')
      if (argv.includes('--mark')) {
        w.marked++
        w.guideOwed = false
      }
      return said(w.guide)
    }
    if (argv[1] === 'features') {
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] !== '--set') continue
        const [k, v] = (argv[i + 1] ?? '').split('=')
        w.sets.push(argv[i + 1] ?? '')
        if (k) w.features[k] = v === 'on'
      }
      return out({ settings: w.features, at: 1 })
    }
    if (argv[1] === 'act' && argv.includes('--stdin')) {
      const payload = JSON.parse(String((e as { init?: { stdin?: unknown } }).init?.stdin ?? '{}')) as Record<string, unknown>
      w.acts.push({ kind: argv[2]!, payload })
      if (argv[2] === 'coverage') {
        w.coverage.push(payload)
        return out({ ok: true, summary: { files: { seen: 1, searched: 0, never: 2, total: 3 }, records: { seen: 0, total: 0, counted: false }, line: w.coverageLine } })
      }
      return out({ ok: true })
    }
    const [, verb, what, flag, , ...rest] = argv
    if (flag !== '--cwd') return out({ error: 'no --cwd' }, 1)
    if (verb === 'act') {
      const payload = JSON.parse(rest[0] ?? '{}') as Record<string, unknown>
      w.acts.push({ kind: what!, payload })
      if (w.refuse?.[what!]) return out({ error: w.refuse[what!] }, 1)
      if (what === 'thread') return out({ ok: true, thread: 't9' })
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
      case 'find':
        return out(w.found[rest[0]!] ?? { q: rest[0], files: [], total: 0 })
      case 'grep':
        return out(w.grepped[rest[0]!] ?? { q: rest[0], files: [], done: { done: true, files: 0, hits: 0, scanned: 3, of: 3, complete: true } })
      case 'findin': {
        // the lines of a file's page that hold the words, in any case, past `--after`
        const page = w.pages[rest[0]!]
        const after = rest.includes('--after') ? Number(rest[rest.indexOf('--after') + 1]) : 0
        const recs = ((typeof page === 'function' ? (page as (s: number) => { records: { line: number; record: { text?: string } }[] })(1) : (page as { records?: { line: number; record: { text?: string } }[] } | undefined)) ?? { records: [] }).records ?? []
        const lines = recs.filter(r => r.line > after && JSON.stringify(r.record).toLowerCase().includes(rest[1]!.toLowerCase())).map(r => r.line)
        return out({ path: rest[0], q: rest[1], lines, counts: lines.map(() => 1), total: lines.length, matches: lines.length, complete: true, scanned: recs.length, total_lines: recs.length })
      }
      case 'marks':
        return out(w.marks[rest[0]!] ?? [])
      case 'tables':
        return w.tables[rest[0]!] !== undefined ? out(w.tables[rest[0]!]) : out({ error: `not a database file (*.db, *.sqlite, *.sqlite3): '${rest[0]}'` }, 1)
      case 'rows': {
        const table = rest[rest.indexOf('--table') + 1]
        const page = w.rows[`${rest[0]}:${table}`]
        const from = rest.includes('--start') ? Number(rest[rest.indexOf('--start') + 1]) : 1
        return page === undefined ? out({ error: `no such table: '${table}'` }, 1) : out(typeof page === 'function' ? (page as (start: number) => unknown)(from) : page)
      }
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
      case 'checks':
        return out(w.states.checks)
      case 'coverage':
        // no coverage summary yet (home and the summary line leave Coverage out); fixtures-panel.ts answers with rows
        return out({ summary: null, folder: '', rows: [], counting: false })
      case 'answer-comments':
        return out({ comments: w.comments, running: w.running })
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
  const isOpen = (id: string) => w.opened.filter(x => x === id).length > w.closed.filter(x => x === id).length
  on('ui.open', ($, e) => {
    w.focusAsked.push(Boolean((e as { focus?: unknown }).focus))
    if (w.paneFocused === false && w.grantOnReopen && w.opened.includes(e.id) && (e as { focus?: unknown }).focus) w.paneFocused = true
    const pl = w.place
    // a pane drawn already is retitled, and stays drawn
    const drawn = isOpen(e.id) && !pl?.waiting.has(e.id)
    w.opened.push(e.id)
    w.panes.push({ id: e.id, title: String((e as { title?: unknown }).title ?? ''), ...(typeof (e as { columns?: unknown }).columns === 'number' ? { columns: (e as { columns: number }).columns } : {}) })
    if (!pl || drawn) return { value: { isPlaced: true } } as never
    const floor = pl.asked.has(e.id) ? 110 : 144
    if (pl.asking) pl.asked.add(e.id)
    const placed = pl.asking || pl.columns >= floor
    pl.log.push({ id: e.id, asked: pl.asking, placed })
    if (placed) {
      pl.waiting.delete(e.id)
      return { value: { isPlaced: true } } as never
    }
    pl.waiting.add(e.id)
    return { value: { isPlaced: false, reason: `unasked below ${floor} columns (${pl.columns} now${floor === 110 ? ', an id the person opened before' : ''}): placed when the person opens it, or when the terminal is widened to ${floor} columns` } } as never
  })
  on('ui.close', ($, e) => {
    w.closed.push(e.id)
    w.place?.waiting.delete(e.id)
    // closed by hand, the pane is no longer one the person opened before
    if (e.origin.kind === 'person') w.place?.asked.delete(e.id)
    return { value: undefined } as never
  })
  // the panes open: each opened and not closed since, placed unless it waits undrawn
  on('ui.panes', () => ({ value: [...new Set(w.opened)].filter(isOpen).map(id => ({ id, isPlaced: !w.place?.waiting.has(id), ...(w.paneFocused === undefined ? {} : { isFocused: w.paneFocused }) })) }) as never)
  // a press is the person's own while its Button's handler runs: an open made then is one Claude Code was asked for
  on('ui.press', async ($, e, next) => {
    const pl = w.place
    if (!pl) return next(e)
    pl.asking = true
    try {
      return await next(e)
    } finally {
      pl.asking = false
    }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined } as never
  })
  on('ui.log', ($, e) => {
    w.logs.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined } as never
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }) as never)
  on('session.compact', ($, e) => (w.compactSkip ? { skip: w.compactSkip } : { messages: e.messages }) as never)
  on('command.run', ($, e) => {
    w.commands.push(`/${e.command} ${e.args}`.trim())
    return { text: '(the engine command)' }
  })
  on('tool.call', ($, e) => {
    w.toolCalls.push({ ...(e as unknown as Record<string, unknown>) })
    if (w.toolAnswer) return w.toolAnswer(e as unknown as Record<string, unknown>) as never
    return { result: w.toolText, text: w.toolText } as never
  })
  on('ui.copy', () => ({ value: { isCopied: true } }) as never)
  on('prompt.submit', ($, e) => {
    w.submitted.push(String((e as { text?: unknown }).text ?? ''))
    // the engine answers with the context that arrived beside the prompt (e.context)
    const context = (e as { context?: unknown }).context
    return { text: String((e as { text?: unknown }).text ?? ''), ...(Array.isArray(context) && context.length ? { context } : {}) } as never
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

/** Every string a drawn tree shows (a Button's label too), joined. A Button drawn from its children shows them: its
 *  label then only names it (the engine fills it from them), so it is not counted twice. */
export function shown(tree: unknown): string {
  const out: string[] = []
  const walk = (n: unknown) => {
    if (typeof n === 'string') out.push(n)
    else if (Array.isArray(n)) n.forEach(walk)
    else if (n && typeof n === 'object') {
      const o = n as { label?: unknown; text?: unknown; children?: unknown; props?: { label?: unknown; text?: unknown; children?: unknown } }
      const label = o.label ?? o.props?.label
      const kids = o.children ?? o.props?.children
      if (typeof label === 'string' && !(Array.isArray(kids) ? kids.length : kids)) out.push(label)
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
  await $.ui.focus({ requestId: 'thimble', component: 'Pane', element: 'keys-pick', origin: { kind: 'plugin', name: 'thimble' } } as never)
}

// ------------------------------------------------------------------------------------------------ 0.9.0 helpers

/** A session start as Claude Code raises it: a person at the terminal unless a test says otherwise. */
export async function startSession($: Engine, w: World, opts: { surface?: string | null; isInteractive?: boolean } = {}): Promise<void> {
  await $.session.start({ cwd: CWD, surface: opts.surface === undefined ? 'terminal' : opts.surface, isInteractive: opts.isInteractive ?? true } as never)
  await w.clock.settle()
}

/** Claude Code's Read answering each call with the whole file (`lines` lines), or as `as` says (a part, a PDF, …). */
export function reads(w: World, as: (path: string) => Record<string, unknown> = path => ({ type: 'text', file: { filePath: path, content: 'x', numLines: 3, startLine: 1, totalLines: 3 } })): void {
  w.toolAnswer = e => {
    if (e.tool === 'Read') {
      const result = as(String(e.file_path ?? ''))
      return { result, text: 'the file' }
    }
    if (e.tool === 'Bash') return { result: { stdout: w.toolText, stderr: '', interrupted: false }, text: w.toolText }
    return { result: w.toolText, text: w.toolText }
  }
}

/** Files of the session folder, by their paths relative to it, with their sizes (1 KB unless given). */
/** The steps of activation the debug log said (activate.ts trail), in order. */
export function trailOf(w: World): string[] {
  return w.logs.filter(l => l.startsWith('thimble: activation ')).map(l => l.slice('thimble: activation '.length))
}

export function corpus(w: World, files: Record<string, number> | string[]): void {
  const entries = Array.isArray(files) ? files.map(f => [f, 1024] as const) : Object.entries(files)
  for (const [f, size] of entries) w.sizes.set(`${CWD}/${f}`, size)
}

let callN = 0
/** A tool call of main's (or of the subagent `agentId`). */
export async function call($: Engine, tool: string, input: Record<string, unknown>, agentId?: string): Promise<Record<string, unknown>> {
  callN++
  return (await $.tool.call({ tool, tool_use_id: `u${callN}`, ...input, ...(agentId ? { agentId } : {}) } as never)) as unknown as Record<string, unknown>
}

/** A turn of main's around `body`: its prompt, `body`'s calls, a text row (`row`, `text`), its end. */
export async function aTurn($: Engine, w: World, row: string, text: string, body: () => Promise<void> = async () => undefined): Promise<void> {
  await $.turn.start({ text: 'What is in this folder?', turnId: `t-${row}` } as never)
  await body()
  await $.session.append({ door: 'response', origin: { kind: 'model', model: 'm' }, uuid: row, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] } } as never).catch(() => undefined)
  await $.turn.complete({ turnId: `t-${row}`, answer: text, durationMs: 5, reason: 'answer', isAborted: false } as never)
  await w.clock.settle()
}
