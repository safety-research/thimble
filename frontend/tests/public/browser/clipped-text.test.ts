// Single-line text that clips its own descenders, over the whole app in headless Chromium: the real App, its stylesheets
// and fonts, against a made-up workspace whose every API answer this file gives (two views, a view being built, files,
// labels, cards, a report, threads). On the start page; Files with the views bar, two files open, Color by and the
// Labels pane; Files beside the canvas, the bar in its pane head; the canvas and a card's details; the report; a view;
// the chat and its threads; and the popovers a click opens (Color by, a label's card, New label, New view, the folder
// switcher, Settings, the theme, Report a problem, + New, the composer's effort), every element that ends its text with
// an ellipsis on one line (text-overflow: ellipsis, no wrapping, overflow not visible) and holds text is at least as tall
// as its content: scrollHeight <= clientHeight. A line-height below the font's ascent plus descent makes the content
// taller than the box, and the overflow then cuts the bottom of g, j, p, q and y. Also: the views bar's hidden measuring
// copy (files.css .files-views-measure) draws each option's label at the width and line-height the bar draws it.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page, Route } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

const WS = 'demo'
const T = '2026-05-16T09:00:00.000+00:00'
let browser: Browser
let out = ''

beforeAll(async () => {
  const script = await bundle(
    'clipped-text',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import App from '${src('App.tsx')}'`,
      `createRoot(document.getElementById('root')!).render(<App />)`,
    ],
    {
      loader: { '.css': 'css', '.woff2': 'file', '.woff': 'file', '.json': 'json' },
      conditions: ['style'],
      assetNames: '[name]-[hash]',
      publicPath: '/',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.BASE_URL': '"/"' },
    },
  )
  out = path.dirname(script)
  browser = await launch()
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

// ---------- the made-up workspace
const chat = (id: string, kind: string, role: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, kind, role, title, created_at: T, parent: kind === 'main' ? null : 'main', anchor: null, anchor_text: null, model: null, effort: null, group: null, n_messages: 2, last_ts: T, running: false, ...extra,
})
const MAIN = chat('main', 'main', 'main', 'main', { attached: { session: 'session-1', cwd: '/home/analyst/demo', since: T }, ended: null, alert: null })
const THREADS = [
  chat('t1', 'thread', 'thread', 'Why do the gauges spike on Sunday?', { anchor: 'card:c1', anchor_text: 'Weekly gauge readings' }),
  chat('t2', 'thread', 'thread', 'Which agents replayed the query log?', { anchor: 'revisions.jsonl#L2', anchor_text: 'a replayed query' }),
  chat('a1', 'agent', 'orient', 'Orientation', { status: 'done', result: 'Done.', ts_end: T, model: 'claude-opus-5-5', effort: 'high', group: 'g1' }),
  chat('a2', 'agent', 'writer', 'Writing the report', { status: 'done', result: 'Wrote the report.', ts_end: T, doc: 'report' }),
]
const CHATS = [MAIN, ...THREADS]
const say = (text: string) => [
  { type: 'user', ts: T, text },
  { type: 'text', delta: `Looking at it: the spikes group by agent, typically during a replay. ${text}`, reply: true },
  { type: 'done', ts: T, session_id: 's' },
]
const SETTINGS = {
  run_cell_result_lines: 40,
  models: Object.fromEntries(['orient', 'critic', 'writer', 'checks', 'verify', 'labels', 'dev'].map((r) => [r, { model: 'claude-opus-5-5', effort: 'high', fast: false }])),
  permission_modes: {}, disabled_modes: [], config_error: '',
}
const FILES = ['README.md', 'events.jsonl', 'pages.jsonl', 'revisions.jsonl', 'logs/agent-gamma.log', 'logs/agent-yankee.log'].map((p) => ({ path: p, kind: 'text', size_bytes: 1200, title: p.split('/').pop() }))
/** One folder's own entries, as `GET /corpora/{c}/sources?path=&depth=1` answers. */
const folder = (at: string) => {
  const inside = FILES.filter((f) => (f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '') === at)
  const sub = at ? [] : [...new Set(FILES.filter((f) => f.path.includes('/')).map((f) => f.path.split('/')[0]))]
  return { path: at, files: inside, folders: sub.map((d) => ({ path: d, name: d, n_files: FILES.filter((f) => f.path.startsWith(`${d}/`)).length, n_folders: 0, is_run: false })), n_files: FILES.length }
}
const WIKIS = ['gypsum', 'quarry', 'jetty']
/** A JSON-lines record of a page's save. */
const save = (k: number) => ({ rev_id: `${WIKIS[k % 3]}~Page${k}@${k}`, wiki: WIKIS[k % 3], page: `Typography page ${k}`, label: k % 2 ? 'AgentGypsy' : 'AgentPygmy', time: `2026-06-22T08:${String(10 + k).padStart(2, '0')}:00Z`, body: `Saved by a replaying agent, query ${k}: jog the gauge, copy the yearly figures.` })
/** A file's first lines, as `GET /corpora/{c}/source` answers. */
const sourcePage = (p: string) => {
  if (p.endsWith('.jsonl')) {
    const records = Array.from({ length: 12 }, (_, k) => save(k + 1))
    return {
      path: p, kind: 'text', total_lines: records.length, start: 1, records: records.map((r, k) => ({ line: k + 1, record: r, blocks: [{ kind: 'text', text: r.body }], meta: {} })),
      transcript: { format: 'messages', score: 0.95, keys: { speaker: 'label', text: 'body', time: 'time' } },
    }
  }
  const lines = [`# ${p}`, '', 'A made-up file: typography, gypsum, jetty and quarry.']
  return { path: p, kind: 'text', total_lines: lines.length, start: 1, records: lines.map((text, k) => ({ line: k + 1, record: { text }, blocks: [{ kind: 'text', text }], meta: {} })) }
}
/** The keys of a JSON-lines file's records that Color by offers, as `GET /corpora/{c}/source/keys` answers. */
const sourceKeys = (p: string) => ({
  path: p, total: 12, bins: 12, partial: false, bytes: Array(12).fill(100),
  keys: [
    { key: 'wiki', values: WIKIS.map((value) => ({ value, n: 4 })), more: { values: 0, n: 0 }, none: 0, at: Array.from({ length: 12 }, (_, k) => k % 3) },
    { key: 'label', values: [{ value: 'AgentGypsy', n: 6 }, { value: 'AgentPygmy', n: 6 }], more: { values: 0, n: 0 }, none: 0, at: Array.from({ length: 12 }, (_, k) => (k + 1) % 2) },
  ],
})
const view = (slug: string, name: string) => ({
  slug, origin: 'workspace', name, description: `${name}: every save of a page, typography and all.`, claims: ['revisions.jsonl', 'pages.jsonl'], accepts: [], units: [], libs: [], built: T, version: 'v1', ok: true, forms: [], first_file: 'revisions.jsonl', files: ['revisions.jsonl', 'pages.jsonl'], n_files: 2, label_controls: false,
})
const VIEWS = [view('wiki-page-history', 'Wiki Page History'), view('query-replay', 'Query Replay Gallery')]
const PROPOSALS = [{ slug: 'agent-gossip', name: 'Agent Gossip Map', why: 'Who copies whom, by page.', claims: ['revisions.jsonl'], arrangement: 'a graph', proposed_by: 'terminal', status: 'building', ts: T, chat: null }]
const concept = (id: string, name: string, values: string[], counts: number[]) => ({
  id, name, description: `${name}, judged per save.`, unit: 'record', kind: 'prompt', spec: '', labels: values, created_by: 'terminal', ts: T, version: 1, marks: 'record', glob: 'revisions.jsonl', model: '',
  classes: values.map((v, k) => ({ name: v, color: k + 1, highlight: k < values.length - 1 })), shown: true, trial: false,
  counts: Object.fromEntries(values.map((v, k) => [v, counts[k]])), n_labeled: counts.reduce((a, b) => a + b, 0), n_reviewed: 0, n_marked: 0, rev: 1, changes: [],
  last_run: { ts: T, paths: ['revisions.jsonl'], total: 12, matched_total: 12, labeled: 12 }, run: null,
})
const CONCEPTS = [
  concept('k1', 'replay pattern', ['copies a yearly figure', 'jogs the gauge', 'other'], [5, 4, 3]),
  concept('k2', 'agent typology', ['gypsy', 'pygmy'], [6, 6]),
]
const PRESENCE = CONCEPTS.map((c) => ({ concept_id: c.id, paths: { 'revisions.jsonl': c.counts } }))
const FRAME = {
  'application/vnd.thimble.frame+json': {
    columns: ['agent', 'queries', 'replayed'], types: { agent: 'nominal', queries: 'quantitative', replayed: 'quantitative' }, index: 'agent',
    rows: [['AgentGypsy', 9087, 3], ['AgentPygmy', 12410, 5], ['AgentYankee', 7310, 2]], total: 3, label: 'agent',
    view: { columns: ['queries', 'replayed'], formats: { queries: ',d', replayed: ',d' }, more: 0 },
  },
  'text/plain': 'agent  queries  replayed',
}
const cell = (id: string, kind: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, notebook: 'g1', kind, title, slug: id, takeaway: `Mostly during a replay: typically [[3|card:${id}]] agents copy the yearly figure.`, takeaway_author: 'model', created_by: 'chat:a1', created_ts: T, ts: T, labels: [], locked: false, status: 'ok', exec_count: 1, outputs: [], ...extra,
})
const CANVAS = {
  groups: [
    { id: 'g1', title: 'Orientation: gauges, replays and typography', parent: null, kind: 'sequence', anchor: null, chat: null, role: 'exploration', n_cells: 3, ts: T },
    { id: 'g2', title: 'Your work: query gallery', parent: null, kind: 'sequence', anchor: null, chat: null, role: 'exploration', n_cells: 1, ts: T },
  ],
  cells: [
    cell('c1', 'table', 'Which agents replayed the query log, by agency?', { code: 'frame', outputs: [FRAME], labels: ['k1'] }),
    cell('c2', 'note', 'Gypsum, jetty and quarry: the typography of the wikis', { payload: { text: 'Every wiki keeps a page history; agents copy yearly figures between them.' }, text: 'Every wiki keeps a page history; agents copy yearly figures between them.', outputs: [] }),
    cell('c3', 'code', 'How many queries per agency, typically?', { code: 'print(3)', outputs: [{ 'text/plain': 'gypsy 3\npygmy 5', _stream: 'stdout' }] }),
    cell('c4', 'note', 'Querying the gallery: why do gauges spike?', { notebook: 'g2', payload: { text: 'Spikes typically follow a replay.' }, text: 'Spikes typically follow a replay.', outputs: [] }),
  ],
  hidden: [],
}
const sentence = (id: string, text: string, refs: string[] = []) => ({ id, text, refs, tags: [], tag_notes: {} })
const REPORT = {
  id: 'report', type: 'report', renderer: 'document', title: 'Agents copying yearly figures through a gypsum wiki', generation: 1, generated_at: T, model: 'session', comments: [],
  sections: [
    { id: 's1', heading: '', paragraphs: [{ id: 'p1', sentences: [sentence('x1', 'Agents typically copy the yearly figures [[card:c1]].', ['card:c1']), sentence('x2', 'The gauges spike during a replay.')] }], figures: [] },
    { id: 's2', heading: 'Why the gauges spike: replaying agents', paragraphs: [{ id: 'p2', sentences: [sentence('x3', 'Every spike follows a replay of the query log.')] }], figures: [{ id: 'f1', cell: 'c1', caption: 'Queries by agency, typically', after_paragraph: 'p2' }] },
  ],
}
const TYPES = {
  report: { exists: true, generation: 1, generated_at: T, renderer: 'document', title: REPORT.title, open_comments: 0, name: 'Report' },
  story: { exists: false, renderer: 'story', frame: false, name: 'Story' },
  slides: { exists: false, renderer: 'slides', frame: false, name: 'Slides' },
}
const CHECKS = [
  { id: 'unverified', name: 'Unverified', prompt: 'Comment on each claim that cannot be verified by the evidence.', colour: 5, shown: false, builtin: true, created_by: 'thimble', ts: '', version: 1, runs: {} },
  { id: 'judgment', name: 'Judgment calls', prompt: 'Comment on each judgment.', colour: 1, shown: false, builtin: true, created_by: 'thimble', ts: '', version: 1, runs: {} },
]
const ROWS = [
  { name: WS, kind: 'folder', folder: WS, path: '/home/analyst/demo' },
  { name: 'gypsum-wiki', kind: 'demo', folder: 'gypsum-wiki', path: '/home/analyst/.thimble/demo/gypsum-wiki', dataset: 'gypsum-wiki', title: 'gypsum.wiki', blurb: 'Logs of a small wiki that a swarm of agents used as a message board.', ready: true },
  { name: 'example-query-replay', kind: 'example', folder: 'example-query-replay', path: '/home/analyst/.thimble/examples/example-query-replay', view: { slug: 'query-replay', name: 'Query Replay Gallery' } },
]
const EXTENSIONS = {
  extensions: [
    { name: 'video', version: '0.6.0', description: 'A report type for a short narrated video.', builtin: true, active: true, why: '', note: '', on: true, locked: false, views: [], parts: ['Video report type'], consent: '', sandboxed: true, orients: false, offer: false },
    { name: 'typography-gallery', version: '0.6.0', description: 'A card type that lays out a gallery of glyphs.', builtin: true, active: false, why: 'not added', note: '', on: false, locked: false, addable: true, views: [], parts: ['Gallery card type'], consent: '', sandboxed: true, needs: [], orients: false, offer: false },
  ],
  conflicts: [],
  orientation_ran: true,
  local: { name: WS, views: VIEWS.map((v) => ({ slug: v.slug, name: v.name, description: v.description, file_viewer: false, on: true })) },
}
const GET: Record<string, unknown> = {
  '/api/health': { ok: true, leader: 1, boot: 'boot', ui: 'ui' },
  '/api/tour': { seen: true },
  '/api/workspaces': ROWS,
  '/api/corpora': [{ name: WS, path: '/home/analyst/demo', registered: true, manifest: null }],
  [`/api/ws/${WS}/instance`]: { stamp: 'stamp-1' },
  [`/api/ws/${WS}/undo`]: { undo: null, redo: null, undo_run: null, held: null },
  [`/api/ws/${WS}/chats`]: CHATS,
  [`/api/ws/${WS}/chats/main`]: { meta: { ...MAIN, orientation: null }, events: say('Why do the gauges spike?') },
  ...Object.fromEntries(THREADS.map((t) => [`/api/ws/${WS}/chats/${t.id}`, { meta: t, events: say(t.title) }])),
  [`/api/ws/${WS}/concepts`]: CONCEPTS,
  ...Object.fromEntries(CONCEPTS.map((c) => [`/api/ws/${WS}/concepts/${c.id}`, c])),
  [`/api/ws/${WS}/views`]: VIEWS,
  [`/api/ws/${WS}/views/proposals`]: PROPOSALS,
  [`/api/corpora/${WS}/sources`]: FILES,
  [`/api/ws/${WS}/labels/presence`]: PRESENCE,
  [`/api/ws/${WS}/canvas`]: CANVAS,
  [`/api/ws/${WS}/filters`]: {},
  [`/api/ws/${WS}/report-types/presets`]: [],
  [`/api/ws/${WS}/investigations/main/types`]: TYPES,
  [`/api/ws/${WS}/investigations/main/types/report`]: REPORT,
  [`/api/ws/${WS}/checks`]: CHECKS,
  [`/api/ws/${WS}/card-checks`]: { running: [], queued: [] },
  [`/api/ws/${WS}/orientation`]: { status: 'done', query: null, passes: ['final', 'views', 'report'], critique: false, effort: 'high', requested: T, started: T, ended: T, chats: { orient: 'a1' } },
  [`/api/ws/${WS}/cells/names`]: CANVAS.cells.map((c) => ({ id: c.id, notebook: c.notebook, title: c.title, slug: c.slug, exec_count: 1, ts: T, status: 'ok' })),
  [`/api/ws/${WS}/investigations/main/types/report/frame`]: { id: 'report', type: 'report', renderer: 'document', title: '', sections: [], frame: true, generation: 0 },
  [`/api/ws/${WS}/extensions`]: EXTENSIONS,
  ['/api/dev/status']: { running: false, tickets: '', current: null, queued: 0, restart_pending: null, last_apply: null },
  ...Object.fromEntries(VIEWS.flatMap((v) => [
    [`/api/ws/${WS}/views/${v.slug}/problems`, { count: 0, examples: [] }],
    [`/api/ws/${WS}/views/${v.slug}/shown`, { files: 2, not_shown: { count: 0, unexplained: 0, unclaimed: 0, files: [] }, missing: [], unplaced: { count: 2, examples: [{ ref: 'pages.jsonl#L1', why: 'a page with no saves, typically a stub' }] }, derived: [], errors: [] }],
  ])),
}
const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.html': 'text/html', '.svg': 'image/svg+xml' }
const INDEX = '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>'
const VIEW_PAGE = '<!doctype html><html><body><p>A view of the saves.</p></body></html>'


function answer(route: Route) {
  const req = route.request()
  const url = new URL(req.url())
  if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue()
  if (url.origin !== ORIGIN) return route.abort()
  const p = url.pathname
  const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  if (p.startsWith('/api/')) {
    const method = req.method()
    if (p === '/api/ui/key') return route.fulfill({ status: 204, body: '' })
    if (p === `/api/ws/${WS}/events`) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': open\n\n' })
    if (p === `/api/corpora/${WS}/sources` && url.searchParams.get('depth') === '1') return json(folder((url.searchParams.get('path') ?? '').replace(/^\.$/, '')))
    if (p === `/api/corpora/${WS}/source`) return json(sourcePage(url.searchParams.get('path') ?? 'README.md'))
    if (p === `/api/corpora/${WS}/source/keys`) return json(sourceKeys(url.searchParams.get('path') ?? ''))
    if (p === `/api/ws/${WS}/labels/ruler`) return json({ path: url.searchParams.get('path') ?? '', total: 12, bins: 400, labels: [] })
    if (p === `/api/ws/${WS}/labels`) return json([])
    if (p === `/api/ws/${WS}/labels/glob`) return json({ files: FILES.map((f) => f.path).filter((f) => f.endsWith('.jsonl')), total: 3 })
    if (p === `/api/corpora/${WS}/ref`) {
      // a record of a file, as a chip's preview resolves it
      const m = /^([^#]+)#L(\d+)/.exec(url.searchParams.get('ref') ?? '')
      if (m) {
        const r = sourcePage(m[1]).records[Number(m[2]) - 1] ?? sourcePage(m[1]).records[0]
        return json({ ref: url.searchParams.get('ref'), kind: 'record', path: m[1], line: r.line, record: r.record, blocks: r.blocks })
      }
    }
    if (method === 'GET' && p === `/api/ws/${WS}/settings`) return json(SETTINGS)
    if (method === 'GET' && /^\/api\/ws\/[^/]+\/views\/[^/]+\/frame$/.test(p)) return route.fulfill({ status: 200, contentType: 'text/html', body: VIEW_PAGE })
    if (method === 'GET' && p in GET) return json(GET[p])
    if (method === 'PUT' && p === `/api/ws/${WS}/render/theme`) return json({ paper: 'warm', accent: 'iris' })
    if (method === 'POST' && p === `/api/ws/${WS}/telemetry`) return json({ recorded: 1 }, 201)
    return json({ detail: 'not found' }, 404)
  }
  if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: INDEX })
  const file = path.join(out, p)
  if (existsSync(file)) return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
  return route.fulfill({ status: 404, body: '' })
}

type Panes = { root: unknown; focus: string }
const one = (surface: string): Panes => ({ root: { kind: 'pane', id: 'p1', surface }, focus: 'p1' })
const two = (a: string, b: string): Panes => ({ root: { kind: 'split', dir: 'row', ratio: 0.5, a: { kind: 'pane', id: 'p1', surface: a }, b: { kind: 'pane', id: 'p2', surface: b } }, focus: 'p1' })

/** The app at `query` (the workspace unless given), with `panes` laid out and the chat column open. */
async function open(panes: Panes | null, opts: { W?: number; H?: number; query?: string } = {}): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ viewport: { width: opts.W ?? 1440, height: opts.H ?? 900 } })
  await ctx.addInitScript(
    ({ ws, panes }) => {
      localStorage.setItem(`thimble:${ws}:instance`, JSON.stringify('stamp-1'))
      sessionStorage.setItem(`thimble:${ws}:instance`, JSON.stringify('stamp-1'))
      if (panes) localStorage.setItem(`thimble:${ws}:layout`, JSON.stringify({ chatWidth: 380, chatOpen: true, panes }))
    },
    { ws: WS, panes },
  )
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.warn('page error:', e.message))
  await page.route('**/*', answer)
  await page.goto(`${ORIGIN}/${opts.query ?? `?ws=${WS}`}`)
  await page.evaluate(() => document.fonts.ready)
  return { page, close: () => ctx.close() }
}

// in the page: every element drawn with text that ends in an ellipsis on one line and clips its overflow, and is shorter
// than its content; each as a selector (its parent's and its own tag and first classes), its text and the two heights
const CLIPPED = () => {
  const name = (el: Element) => el.tagName.toLowerCase() + [...el.classList].slice(0, 3).map((c) => `.${c}`).join('')
  const bad: { el: string; text: string; scroll: number; client: number; lineHeight: string; fontSize: string }[] = []
  for (const el of document.querySelectorAll<HTMLElement>('body *')) {
    const cs = getComputedStyle(el)
    if (cs.textOverflow !== 'ellipsis' || cs.textWrapMode !== 'nowrap' || cs.overflowY === 'visible') continue
    if (!el.textContent?.trim() || !el.getClientRects().length || el.clientHeight === 0) continue
    if (el.scrollHeight > el.clientHeight)
      bad.push({ el: `${el.parentElement ? `${name(el.parentElement)} > ` : ''}${name(el)}`, text: el.textContent.trim().slice(0, 32), scroll: el.scrollHeight, client: el.clientHeight, lineHeight: cs.lineHeight, fontSize: cs.fontSize })
  }
  return bad
}
/** How many single-line ellipsis elements with text the page draws, so a check that found nothing to measure fails. */
const COUNT = () =>
  [...document.querySelectorAll<HTMLElement>('body *')].filter((el) => {
    const cs = getComputedStyle(el)
    return cs.textOverflow === 'ellipsis' && cs.textWrapMode === 'nowrap' && cs.overflowY !== 'visible' && !!el.textContent?.trim() && el.getClientRects().length > 0 && el.clientHeight > 0
  }).length

/** The clipped elements on the page as it stands, each once, with where it was seen. */
async function clipped(page: Page, where: string, seen: Map<string, string>) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  for (const b of await page.evaluate(CLIPPED)) if (!seen.has(b.el)) seen.set(b.el, `${where}: "${b.text}" scrollHeight ${b.scroll} > clientHeight ${b.client} (line-height ${b.lineHeight}, font-size ${b.fontSize})`)
  return page.evaluate(COUNT)
}
const report = (seen: Map<string, string>) => [...seen].map(([el, why]) => `${el} | ${why}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Click `selector` (the first match), wait for `wait` when given, measure, then press Escape. */
async function opened(page: Page, selector: string, where: string, seen: Map<string, string>, wait = '') {
  await page.locator(selector).first().click()
  if (wait) await page.waitForSelector(wait)
  await sleep(300)
  await clipped(page, where, seen)
  await page.keyboard.press('Escape')
  await sleep(150)
}

test('the start page clips no descender', async () => {
  const seen = new Map<string, string>()
  const { page, close } = await open(null, { query: '', W: 1280, H: 800 })
  await page.waitForSelector('a.ws-row')
  const n = await clipped(page, 'the start page', seen)
  await close()
  assert.ok(n >= 2, `the start page draws single-line text to measure (${n})`)
  assert.deepEqual(report(seen), [])
})

test('Files (the views bar, two files open, Color by, the Labels pane) and the top bar and its popovers clip no descender', async () => {
  const seen = new Map<string, string>()
  const { page, close } = await open(one('files'))
  await page.waitForSelector('.files-views .seg-opt')
  const row = (name: string) => page.locator('.files-row').filter({ hasText: name }).first()
  await row('README.md').click()
  await row('revisions.jsonl').click()
  await page.waitForSelector('.colorby-trigger')
  await sleep(500)
  const n = await clipped(page, 'Files', seen)
  assert.ok(n >= 8, `Files draws single-line text to measure (${n})`)
  await opened(page, '.colorby-trigger', 'Files: Color by', seen, '.colorby-menu')
  await opened(page, '.files-label-edit', "Files: a label's card", seen)
  await opened(page, 'button[aria-label="New label"]', 'Files: New label', seen)
  await opened(page, '.files-views-new', 'Files: New view', seen)
  await opened(page, '.shell-corpus-name', 'the folder switcher', seen, '.ws-row')
  await opened(page, 'button[aria-label="Settings"]', 'Settings', seen)
  await opened(page, 'button[aria-label="Theme"]', 'Theme', seen)
  await opened(page, 'button[aria-label="Report a problem"]', 'Report a problem', seen)
  await close()
  assert.deepEqual(report(seen), [])
})

test('Files beside the canvas (the views bar in its pane head) clips no descender, and the bar measures each label at the width and line it draws it', async () => {
  const seen = new Map<string, string>()
  const { page, close } = await open(two('files', 'canvas'))
  await page.waitForSelector('.files-views.is-compact .seg-opt')
  await sleep(500)
  const n = await clipped(page, 'Files beside the canvas', seen)
  assert.ok(n >= 4, `the panes draw single-line text to measure (${n})`)
  // the hidden copy the bar measures what fits in (files.css .files-views-measure): each option's label as wide as the
  // bar draws it, on the same line
  const labels = await page.evaluate(() => {
    const of = (sel: string): Record<string, { w: number; line: string }> =>
      Object.fromEntries([...document.querySelectorAll<HTMLElement>(sel)].map((l) => [l.textContent?.trim() ?? '', { w: l.getBoundingClientRect().width, line: getComputedStyle(l).lineHeight }]))
    return { drawn: of('.files-views.is-compact .seg-opt .seg-label'), measured: of('.files-views-measure .seg-opt-m .seg-label') }
  })
  await close()
  assert.ok(Object.keys(labels.drawn).length >= 2, `the bar draws its options ${JSON.stringify(labels)}`)
  for (const [name, l] of Object.entries(labels.drawn)) {
    const m = labels.measured[name]
    assert.ok(m && Math.abs(l.w - m.w) <= 0.5 && l.line === m.line, `the measuring copy draws "${name}" as the bar does ${JSON.stringify(labels)}`)
  }
  assert.deepEqual(report(seen), [])
})

test("the canvas, its cards and a card's details clip no descender", async () => {
  const seen = new Map<string, string>()
  const { page, close } = await open(one('canvas'))
  await page.waitForSelector('.canvas-card')
  await sleep(800)
  const n = await clipped(page, 'the canvas', seen)
  assert.ok(n >= 3, `the canvas draws single-line text to measure (${n})`)
  await page.locator('.canvas-card').first().hover()
  await page.locator('.canvas-card button[aria-label="Details"]').first().click()
  await sleep(600)
  await clipped(page, "the canvas: a card's details", seen)
  await close()
  assert.deepEqual(report(seen), [])
})

test('the report, its sidebar and + New clip no descender', async () => {
  const seen = new Map<string, string>()
  const { page, close } = await open(one('report'))
  await page.waitForSelector('.wu-page-col')
  await sleep(800)
  const n = await clipped(page, 'the report', seen)
  assert.ok(n >= 3, `the report draws single-line text to measure (${n})`)
  await opened(page, '.wu-new', 'the report: + New', seen, '.menu-item')
  await close()
  assert.deepEqual(report(seen), [])
})

test('a view open on its own clips no descender', async () => {
  const seen = new Map<string, string>()
  const { page, close } = await open(one('view:wiki-page-history'))
  await page.waitForSelector('.view-pane-name')
  await sleep(800)
  const n = await clipped(page, 'a view', seen)
  await close()
  assert.ok(n >= 2, `the view's pane draws single-line text to measure (${n})`)
  assert.deepEqual(report(seen), [])
})

test('the chat, its threads and its composer clip no descender', async () => {
  const seen = new Map<string, string>()
  const { page, close } = await open(one('canvas'))
  await page.waitForSelector('.tt-summary')
  await sleep(500)
  const n = await clipped(page, 'the chat', seen)
  assert.ok(n >= 2, `the chat draws single-line text to measure (${n})`)
  await page.click('.tt-summary')
  await page.waitForSelector('.tt-list .tt-name')
  await sleep(300)
  await clipped(page, 'the chat: its threads', seen)
  for (const name of ['Which agents replayed', 'orient', 'write-report']) {
    await page.locator('.tt-list .tt-row').filter({ hasText: name }).first().click()
    await sleep(600)
    await clipped(page, `the chat: the thread ${name}`, seen)
  }
  await opened(page, '.chat-composer .composer-foot button', "the chat: the composer's effort", seen)
  await close()
  assert.deepEqual(report(seen), [])
})
