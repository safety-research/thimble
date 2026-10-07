// The file browser after the browser's Files, drawn as the rows of text a 120-column pane shows: a folder tree whose
// folders nest and fold, a folder of one folder joined to it; the find by name and by words (`f`), its field in the
// header taking typing, what it found in place of the tree, Enter opening a matching line chosen; the labels that are
// on marking the files they labeled in the tree and the records they labeled in a file, in their values' hues; a file in
// the mode that fits it (a CSV file's rows as a table, Markdown as text, one record as JSON, a database's tables and
// rows); the chosen file's preview in that mode. `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { csvCells, fileTree, fileType, firstChoice, globTest, grepOf, isDatabase, jsonOf, labelCovers, onLabels, recordMarks, tableScore, treeRows, unfoldTo } from '../hooks/files'
import { CWD, LABEL, WS, takesKeys, world } from './fixtures'
import type { World } from './fixtures'

type M = Mounted<'terminal'>
type N = { type?: string; props?: Record<string, unknown>; children?: unknown }

// a pane of 120 columns of type area (the pane's 126 less its padding and margin), tall enough for every list
const COLS = 120
const PANE = (rows = 60) => ({ plugin: 'thimble-term', component: 'Pane', requestId: 'thimble-term', surface: 'terminal', viewport: { columns: 200, rows: rows + 4 }, props: { title: 'thimble', isFocused: true, bodyColumns: COLS + 4, placement: 'dock', scroll: { bodyRows: rows }, view: {} } }) as never

const textOf = (n: unknown): string => {
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  if (n && typeof n === 'object') return textOf((n as N).children ?? (n as N).props?.children)
  return ''
}

/** A drawn panel as the rows of text the terminal shows, `w` cells wide: a column Box's rows stacked, a row Box's
 *  side by side with its growing spacer filling the row, padding and gaps kept, a hidden Box (no row tall) left out. */
function screen(n: unknown, w: number): string[] {
  if (n === null || n === undefined || n === false) return []
  if (typeof n === 'string' || typeof n === 'number') return [String(n)]
  if (Array.isArray(n)) return n.flatMap(k => screen(k, w))
  const o = n as N
  const p = o.props ?? {}
  const raw = o.children ?? p.children
  const kids = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]) as unknown[]
  switch (o.type) {
    case 'Text': {
      const t = textOf(o)
      if (p.wrap === 'wrap' && t.length > w) return t.match(new RegExp(`.{1,${w}}`, 'g')) ?? [t]
      return [t.length > w ? `${t.slice(0, w - 1)}…` : t]
    }
    case 'Button':
      return [String(p.label ?? '')]
    case 'Input':
      return []
    case 'Client':
      return (((p.props as { lines?: { s: string }[][] } | undefined)?.lines ?? []) as { s: string }[][]).map(l => l.map(s => s.s).join(''))
    case 'Code':
      return String(p.source ?? '').split('\n')
    default: {
      if (p.width === 0 || p.height === 0) return []
      const pad = Number(p.paddingLeft ?? p.paddingX ?? 0)
      const inner = w - pad - Number(p.paddingRight ?? p.paddingX ?? 0)
      let rows: string[]
      if (p.flexDirection === 'column') rows = kids.flatMap(k => screen(k, inner))
      else {
        const gap = ' '.repeat(Number(p.columnGap ?? 0))
        const grows = (k: unknown) => Boolean(k && typeof k === 'object' && (k as N).props?.flexGrow && !textOf(k))
        const parts = kids.map(k => (grows(k) ? null : screen(k, inner))).filter(r => r === null || r.length)
        const wide = (r: string[]) => Math.max(0, ...r.map(x => x.length))
        const used = parts.reduce((s, r) => s + (r ? wide(r) : 0), 0) + gap.length * Math.max(0, parts.length - 1)
        const h = Math.max(1, ...parts.map(r => r?.length ?? 0))
        rows = Array.from({ length: h }, (_, i) => parts.map(r => (r === null ? (i ? '' : ' '.repeat(Math.max(0, inner - used))) : (r[i] ?? '').padEnd(wide(r)))).join(gap).replace(/\s+$/, ''))
      }
      return rows.map(r => `${' '.repeat(pad)}${r}`)
    }
  }
}

async function start($: Engine, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}

/** The panel as a 120-column pane shows it, its rows' right ends trimmed. */
async function rows($: Engine, w: World, tall = 60): Promise<string[]> {
  await w.clock.settle()
  const pane = (await $.ui.mount(PANE(tall))) as unknown as M
  const out = screen(await pane.drawn(), COLS + 6).map(r => r.replace(/\s+$/, ''))
  await pane.unmount()
  return out
}

/** A press of the panel's hidden key `key` (`hk-find`), or a key for its list through the relay. */
async function press($: Engine, w: World, key: string): Promise<void> {
  const pane = (await $.ui.mount(PANE())) as unknown as M
  await pane.press({ key })
  await w.clock.settle()
  await pane.unmount()
}

async function listKey($: Engine, w: World, list: string, key: string): Promise<void> {
  const pane = (await $.ui.mount(PANE())) as unknown as M
  await pane.key({ key, in: `m:${list}` } as never)
  await w.clock.settle()
  await pane.unmount()
}

/** Words typed into the relay's Input while it is the find's field: its whole text, as Claude Code's Input gives it. */
async function typeInto($: Engine, w: World, text: string): Promise<void> {
  const pane = (await $.ui.mount(PANE())) as unknown as M
  await pane.input({ key: 'keys-pick', text, kind: 'change' } as never)
  await w.clock.advance(400)
  await w.clock.settle()
  await pane.unmount()
}

async function browser($: Engine, w: World): Promise<void> {
  await $.command.run({ command: 'thimble:thimble', args: 'files' } as never)
  await w.clock.settle()
}

const NESTED = [
  { path: 'README.md', kind: 'markdown', size_bytes: 1800 },
  { path: 'runs/2026-06/agent-a.jsonl', kind: 'agent', size_bytes: 40_000 },
  { path: 'runs/2026-06/agent-b.jsonl', kind: 'agent', size_bytes: 52_000 },
  { path: 'runs/notes.txt', kind: 'text', size_bytes: 900 },
  { path: 'logs/only/deep/one.log', kind: 'text', size_bytes: 300 },
  { path: 'pages.csv', kind: 'text', size_bytes: 2_000 },
]

const CSV = {
  path: 'pages.csv',
  kind: 'text',
  total_lines: 4,
  start: 1,
  records: [
    { line: 1, record: { text: 'wiki,pages,title' } },
    { line: 2, record: { text: 'dse,3908,"Welcome, agents"' } },
    { line: 3, record: { text: 'probier,601,Sandbox' } },
    { line: 4, record: { text: 'fractal,70,Fractals' } },
  ],
}

test('the tree: folders nest 2 cells a level, folders before files, a folder of one folder joined to it; Enter unfolds a folder, Space folds it', async ($, on) => {
  const w = world(on)
  w.states.files = NESTED
  w.pages['pages.csv'] = CSV
  await start($, w)
  await browser($, w)
  let r = await rows($, w)
  const at = (s: string) => r.find(x => x.includes(s)) ?? ''
  expect(at('wiki/')).toMatch(/^ {3}▾ wiki\/ {2}2 +4 KB$/)
  // the corpus's own files, then each folder folded; `logs/` holds one folder of one folder: one row
  expect(at('logs/only/deep/')).toMatch(/^ {3}▸ logs\/only\/deep\/ {2}1 +300 B$/)
  expect(at('runs/')).toMatch(/^ {3}▸ runs\/ {2}3 +93 KB$/)
  expect(r.indexOf(at('logs/only/deep/'))).toBeLessThan(r.indexOf(at('runs/')))
  // ↓ to runs/, Enter unfolds it: its folder first (folded), then its file, each 2 cells further in
  for (let i = 0; i < 4; i++) await listKey($, w, 'files-tree', 'down')
  r = await rows($, w)
  expect(at('runs/')).toMatch(/^ ❯ ▸ runs\//)
  await listKey($, w, 'files-tree', 'return')
  r = await rows($, w)
  const runs = r.indexOf(at('runs/'))
  expect(r[runs + 1]).toMatch(/^ {5}▸ 2026-06\/ {2}2 +92 KB$/)
  expect(r[runs + 2]).toMatch(/^ {7}notes\.txt +txt +900 B$/)
  await listKey($, w, 'files-tree', 'down')
  await listKey($, w, 'files-tree', 'return')
  r = await rows($, w)
  expect(r[runs + 2]).toMatch(/^ {9}agent-a\.jsonl +agent +40 KB$/)
  // Space on a file folds its folder, the choice on the folder's row
  await listKey($, w, 'files-tree', 'down')
  await listKey($, w, 'files-tree', 'space')
  r = await rows($, w)
  expect(at('2026-06/')).toMatch(/^ ❯ {3}▸ 2026-06\//)
  expect(r.join('\n')).not.toContain('agent-a.jsonl')
})

test("the find: `f` gives its field the typing, the words in the header with the cursor after them; what it found in place of the tree, the files named, then the text's matching lines with the match lit; Enter opens a line chosen", async ($, on) => {
  const w = world(on)
  w.states.files = NESTED
  w.found.relay = { q: 'relay', files: [{ path: 'runs/notes.txt', kind: 'text', size_bytes: 900 }], total: 1 }
  w.grepped.relay = {
    q: 'relay',
    files: [
      { path: 'runs/2026-06/agent-a.jsonl', total: 7, complete: true, matches: [{ line: 12, text: 'the wiki served as a relay between runs', hit: [20, 25] }, { line: 40, text: '…a relay page', hit: [3, 8] }] },
      { path: 'README.md', total: 1, complete: true, matches: [{ line: 3, text: 'An export used as a relay.', hit: [19, 24] }] },
    ],
    done: { done: true, files: 2, hits: 8, scanned: 6, of: 6, complete: true },
  }
  w.pages['runs/2026-06/agent-a.jsonl'] = (from: number) => ({ path: 'runs/2026-06/agent-a.jsonl', kind: 'agent', total_lines: 60, start: from, records: Array.from({ length: 50 }, (_, i) => ({ line: from + i, record: { text: `line ${from + i}` } })) })
  await start($, w)
  await browser($, w)
  await press($, w, 'hk-find')
  let r = await rows($, w)
  // the field, empty, its cursor; the hint row says what the keys do while it takes typing
  expect(r.find(x => x.startsWith('   find'))).toBeDefined()
  expect(r.at(-1)).toBe('   ↑↓ to choose · Enter to open · Esc to leave the field')
  await typeInto($, w, 'relay')
  r = await rows($, w)
  expect(w.calls.some(c => c[2] === 'find' && c[5] === 'relay')).toBe(true)
  expect(w.calls.some(c => c[2] === 'grep' && c[5] === 'relay')).toBe(true)
  const at = (s: string) => r.findIndex(x => x.includes(s))
  expect(r[at('find  relay')]).toBe('   find  relay')
  expect(r[at('Named')]).toBe('   Named (1)')
  expect(r[at('Named') + 1]).toMatch(/^ ❯ {3}runs\/notes\.txt +txt +900 B$/)
  expect(r[at('Named') + 2]).toBe('')
  expect(r[at('In the text')]).toMatch(/^ {3}In the text \(2\) +8 matches$/)
  expect(r[at('In the text') + 1]).toMatch(/^ {5}runs\/2026-06\/agent-a\.jsonl +7 matches$/)
  expect(r[at('In the text') + 2]).toBe('       12  the wiki served as a relay between runs')
  // the match on the selection background
  const pane = (await $.ui.mount(PANE())) as unknown as M
  expect(JSON.stringify(await pane.drawn({ in: 'm:files-tree' }))).toContain('{"type":"Text","props":{"backgroundColor":"selectionBg"},"children":["relay"]}')
  await pane.unmount()
  // Esc gives the keys to the prompt: the field types no more, its words stay; with the keys back, Backspace would
  // clear them and `f` types into the field again
  w.paneFocused = false
  r = await rows($, w)
  expect(r.at(-1)).toBe('   click the panel for its keys')
  w.paneFocused = true
  await takesKeys($)
  r = await rows($, w)
  expect(r).toContain('   find  relay')
  expect(r.at(-1)).toBe('   ↑↓ to choose · Enter to open · f to find · Backspace to clear the find · x to close')
  let drawn = (await $.ui.mount(PANE())) as unknown as M
  expect(JSON.stringify(await drawn.find({ key: 'files-find' } as never))).not.toContain('"inverse":true')
  await drawn.unmount()
  await press($, w, 'hk-find')
  drawn = (await $.ui.mount(PANE())) as unknown as M
  expect(JSON.stringify(await drawn.find({ key: 'files-find' } as never))).toContain('"inverse":true')
  await drawn.unmount()
  // ↓ ↓ onto the first matching line, Enter opens its file at that line, chosen
  await listKey($, w, 'files-tree', 'down')
  await listKey($, w, 'files-tree', 'down')
  r = await rows($, w)
  expect(r.find(x => x.startsWith(' ❯'))).toContain('12  the wiki served')
  expect(r.join('\n')).toContain('runs/2026-06/agent-a.jsonl')
  await listKey($, w, 'files-tree', 'return')
  r = await rows($, w)
  expect(r.join('\n')).toContain('↗ runs/2026-06/agent-a.jsonl line 12  ?')
  // Backspace back to the files clears the find: the tree, the file chosen, its folders open; words that end in
  // `:<n>` open a file named by them at line n
  w.found['notes'] = { q: 'notes', files: [{ path: 'runs/notes.txt', kind: 'text', size_bytes: 900 }], total: 1 }
  w.pages['runs/notes.txt'] = { path: 'runs/notes.txt', kind: 'text', total_lines: 9, start: 1, records: Array.from({ length: 9 }, (_, i) => ({ line: i + 1, record: { text: `note ${i + 1}` } })) }
  await listKey($, w, 'file-body', 'backspace')
  r = await rows($, w)
  expect(r.join('\n')).not.toContain('Named')
  expect(r.find(x => x.startsWith(' ❯'))).toMatch(/agent-a\.jsonl/)
  await press($, w, 'hk-find')
  await typeInto($, w, 'notes:7')
  expect(w.calls.some(c => c[2] === 'find' && c[5] === 'notes')).toBe(true)
  const ready = (await $.ui.mount(PANE())) as unknown as M
  await ready.input({ key: 'keys-pick', kind: 'submit', text: 'notes:7' } as never)
  await w.clock.settle()
  await ready.unmount()
  r = await rows($, w)
  expect(r.join('\n')).toContain('↗ runs/notes.txt line 7  ?')
})

test('the labels that are on: a `●` in the label\'s hue after each file it labeled; in the file, its row of values and a `●` in its value\'s hue before each record it labeled', async ($, on) => {
  const w = world(on)
  w.states.files = [{ path: 'revisions.jsonl', kind: 'records', size_bytes: 52_000_000 }, { path: 'README.md', kind: 'markdown', size_bytes: 1800 }]
  w.states.labels = [{ ...LABEL, shown: true }] as never
  w.pages['revisions.jsonl'] = { path: 'revisions.jsonl', kind: 'records', total_lines: 3, start: 1, records: [{ line: 1, record: { wiki: 'dse', body: 'see https://r.jina.ai/x' } }, { line: 2, record: { wiki: 'dse', body: 'Welcome' } }, { line: 3, record: { wiki: 'probier', body: 'proxy.example' } }] }
  w.marks['revisions.jsonl'] = [{ concept_id: LABEL.id, name: LABEL.name, labels: LABEL.labels, unit: 'record', rows: [{ ref: 'revisions.jsonl#L1', label: 'proxy-link', analyst: null }, { ref: 'revisions.jsonl#L2', label: 'proxy-link', analyst: 'none' }, { ref: 'revisions.jsonl#L3', label: 'proxy-link', analyst: null }] }]
  await start($, w)
  await browser($, w)
  let r = await rows($, w)
  expect(r.find(x => x.includes('Files'))).toBeDefined()
  expect(r.find(x => x.includes('2 files · 1 label on'))).toBeDefined()
  expect(r.find(x => x.includes('revisions.jsonl'))).toMatch(/revisions\.jsonl {2}● +records +52\.0 MB$/)
  expect(r.find(x => x.includes('README.md'))).not.toContain('●')
  let pane = (await $.ui.mount(PANE())) as unknown as M
  expect(JSON.stringify(await pane.drawn({ in: 'm:files-tree' }))).toContain('{"type":"Text","props":{"color":"#1d7fc0"},"children":["●"]}')
  await pane.unmount()
  await $.command.run({ command: 'thimble:thimble', args: 'files revisions.jsonl' } as never)
  await w.clock.settle()
  r = await rows($, w)
  expect(w.calls.some(c => c[2] === 'marks' && c[5] === 'revisions.jsonl' && c[7] === '1-3')).toBe(true)
  expect(r.find(x => x.includes('label  '))).toBe(`   label  ${LABEL.name} ↗  ● proxy-link  ● none`)
  // the table's rows, each after its value's `●` (the analyst's `none` for line 2), a gutter, then its cells
  const body = r.filter(x => /^ {3}[● ] {2}(dse|probier)/.test(x))
  expect(body.length).toBe(3)
  pane = (await $.ui.mount(PANE())) as unknown as M
  const drawn = JSON.stringify(await pane.drawn({ in: 'm:file-body' }))
  expect(drawn).toContain('{"type":"Text","props":{"color":"#1d7fc0"},"children":["●"]}')
  expect(drawn).toContain('{"type":"Text","props":{"color":"inactive"},"children":["●"]}')
  // a click on the label's name opens its panel
  await pane.pointer({ type: 'down', x: 9, y: 0, button: 'left', in: 'file-label-0' } as never)
  await w.clock.settle()
  await pane.unmount()
  r = await rows($, w)
  expect(r[0]).toContain(`labels › ${LABEL.name}`)
})

test('a file in the mode that fits it: a CSV file as a table under its first line\'s names, Markdown as text, one record as JSON; the preview in that mode', async ($, on) => {
  const w = world(on)
  w.states.files = NESTED
  w.pages['pages.csv'] = CSV
  await start($, w)
  await browser($, w)
  // pages.csv chosen as the browser opens: its preview a table under its first line's names; README.md's its text,
  // its heading without its marks
  let r = await rows($, w)
  expect(r.find(x => x.includes('opens as'))).toMatch(/^ {3}pages\.csv +opens as table$/)
  const top = r.findIndex(x => x.includes('opens as'))
  expect(r.slice(top + 1, top + 3)).toEqual(['   wiki       pages  title', '   dse        3,908  Welcome, agents'])
  await listKey($, w, 'files-tree', 'down')
  r = await rows($, w)
  expect(r.find(x => x.includes('opens as'))).toMatch(/^ {3}README\.md +opens as text$/)
  expect(r).toContain('   1  Collusion wiki')
  await $.command.run({ command: 'thimble:thimble', args: 'files pages.csv' } as never)
  await w.clock.settle()
  r = await rows($, w)
  expect(r).toContain('   csv · 3 rows · lines 1-4 of 4')
  expect(r.find(x => x.includes(' Table '))).toBe('   Table  Raw')
  const head = r.findIndex(x => /wiki +pages +title/.test(x))
  expect(r[head]).toBe('   wiki       pages  title')
  expect(r[head + 1]).toBe('   dse        3,908  Welcome, agents')
  // Markdown opens as text, and one record as JSON
  w.pages['runs/notes.txt'] = { path: 'runs/notes.txt', kind: 'text', total_lines: 1, start: 1, records: [{ line: 1, record: { text: `${'a long note that goes on '.repeat(8)}end` } }] }
  await $.command.run({ command: 'thimble:thimble', args: 'files runs/notes.txt' } as never)
  await w.clock.settle()
  r = await rows($, w)
  expect(r.find(x => x.includes(' Text '))).toBe('   Text  Raw')
  const note = r.findIndex(x => x.startsWith('   1  a long note'))
  expect(r[note + 1]).toMatch(/^ {6}that goes on|^ {6}a long note|^ {6}\S/)
  expect(r.join('\n')).toContain('end')
  w.pages['runs/2026-06/agent-a.jsonl'] = { path: 'runs/2026-06/agent-a.jsonl', kind: 'agent', total_lines: 2, start: 1, records: [{ line: 1, record: { type: 'user', message: { content: 'hi' } } }, { line: 2, record: { type: 'assistant', message: { content: 'hello' } } }] }
  await $.command.run({ command: 'thimble:thimble', args: 'files runs/2026-06/agent-a.jsonl' } as never)
  await w.clock.settle()
  const pane = (await $.ui.mount(PANE())) as unknown as M
  await pane.press({ key: 'tab-json' })
  await w.clock.settle()
  await pane.unmount()
  r = await rows($, w)
  expect(r.join('\n')).toContain('↗ runs/2026-06/agent-a.jsonl line 1  ?')
  expect(r).toContain('   {')
  expect(r).toContain('     "type": "user",')
  await listKey($, w, 'file-body', 'down').catch(() => undefined)
})

test("a database: its tables, each with its rows; Enter opens one as a table of its rows, paged; Backspace back to its tables, then to the files", async ($, on) => {
  const w = world(on)
  w.states.files = [{ path: 'forge.db', kind: 'forge', size_bytes: 90_000 }]
  w.tables['forge.db'] = [{ name: 'agents', row_count: 3 }, { name: 'prs', row_count: 140 }]
  w.rows['forge.db:agents'] = { table: 'agents', columns: ['id', 'role', 'status'], rows: [['agent-01', 'worker', 'Waiting'], ['agent-02', 'worker', 'Reviewing'], ['agent-03', 'worker', 'Testing']], pk: 'id', total: 3 }
  await start($, w)
  await browser($, w)
  let r = await rows($, w)
  expect(r.find(x => x.includes('opens as tables'))).toMatch(/^ {3}forge\.db +opens as tables$/)
  expect(r.find(x => x.startsWith('   agents'))).toMatch(/agents +3 rows$/)
  expect(r.find(x => x.includes('forge.db') && x.includes('database'))).toBeDefined()
  await listKey($, w, 'files-tree', 'return')
  r = await rows($, w)
  expect(r).toContain('   database · 2 tables')
  expect(r.find(x => x.includes('agents'))).toMatch(/^ ❯ agents +3 rows$/)
  await listKey($, w, 'file-body', 'return')
  r = await rows($, w)
  expect(w.calls.some(c => c[2] === 'rows' && c[5] === 'forge.db' && c[7] === 'agents')).toBe(true)
  expect(r).toContain('   database · table agents · rows 1-3 of 3')
  expect(r.find(x => /id +role +status/.test(x))).toBeDefined()
  expect(r.find(x => x.includes('agent-02'))).toMatch(/agent-02 +worker +Reviewing/)
  await listKey($, w, 'file-body', 'down')
  r = await rows($, w)
  expect(r.join('\n')).toContain('↗ forge.db · agents · agent-01  ?')
  await listKey($, w, 'file-body', 'backspace')
  r = await rows($, w)
  expect(r).toContain('   database · 2 tables')
  await listKey($, w, 'file-body', 'backspace')
  r = await rows($, w)
  expect(r.find(x => x.startsWith(' ❯'))).toContain('forge.db')
  void WS
})

test("a file's find (`f`): its field under the tabs, the lines of the whole file that hold the words, the first at or after the chosen line chosen; ↑↓ step through them while it types, the words lit in each line", async ($, on) => {
  const w = world(on)
  w.states.files = [{ path: 'log.txt', kind: 'text', size_bytes: 600 }]
  w.pages['log.txt'] = { path: 'log.txt', kind: 'text', total_lines: 40, start: 1, records: Array.from({ length: 40 }, (_, i) => ({ line: i + 1, record: { text: i % 10 === 4 ? `line ${i + 1}: the relay saved` : `line ${i + 1} of the log` } })) }
  await start($, w)
  await $.command.run({ command: 'thimble:thimble', args: 'files log.txt' } as never)
  await w.clock.settle()
  await takesKeys($)
  let r = await rows($, w, 30)
  expect(r.at(-1)).toBe('   ↑↓ to choose · Enter to open · 1 2 for the tabs · f to find · Backspace for the files · x to close')
  await press($, w, 'hk-find')
  r = await rows($, w, 30)
  expect(r.at(-1)).toBe('   ↑↓ for the lines it found · Enter to stay there · Esc to leave the field')
  await typeInto($, w, 'relay')
  r = await rows($, w, 30)
  expect(w.calls.some(c => c[2] === 'findin' && c[5] === 'log.txt' && c[6] === 'relay')).toBe(true)
  // the field under the tabs, how many lines hold the words against R; the first of them chosen
  const field = r.find(x => x.startsWith('   find  relay'))!
  expect(field).toMatch(/^ {3}find {2}relay +1 of 4 lines$/)
  expect(r.indexOf(field)).toBe(r.findIndex(x => x.includes(' Text ')) + 1)
  expect(r.join('\n')).toContain('↗ log.txt line 5  ?')
  // ↓ while it types: the next line that holds them
  await listKey($, w, 'file-body', 'down')
  r = await rows($, w, 30)
  expect(r.find(x => x.startsWith('   find'))).toMatch(/2 of 4 lines$/)
  expect(r.join('\n')).toContain('↗ log.txt line 15  ?')
  // the words lit in the lines that hold them, which are not chosen
  const pane = (await $.ui.mount(PANE(30))) as unknown as M
  expect(JSON.stringify(await pane.drawn({ in: 'm:file-body' }))).toContain('{"type":"Text","props":{"backgroundColor":"selectionBg"},"children":["relay"]}')
  await pane.unmount()
})

// ------------------------------------------------------------------------------------------------ the pure parts

test('the tree as files.ts lays it out: folders first, natural order, a folder of one folder joined; counts and sizes of all under it', () => {
  const f = (path: string, size = 1) => ({ path, kind: '', size })
  const top = fileTree([f('b.txt'), f('a/x/1.txt'), f('a/x/2.txt'), f('a/y.txt'), f('run-10/z'), f('run-2/z'), f('one/two/three/four.txt', 5)], 'corpus/')
  expect(top.map(t => t.name)).toEqual(['corpus/', 'a/', 'one/two/three/', 'run-2/', 'run-10/'])
  const a = top[1]!
  expect([a.count, a.folders.map(x => x.name), a.files.map(x => x.path)]).toEqual([3, ['x/'], ['a/y.txt']])
  expect(top[2]!.size).toBe(5)
  // the first folder open; another once unfolded; a nested folder folded until unfolded
  let rows = treeRows(top, { folded: [], unfolded: [] }).map(r => r.key)
  expect(rows).toEqual(['dir:', 'b.txt', 'dir:a/', 'dir:one/two/three/', 'dir:run-2/', 'dir:run-10/'])
  rows = treeRows(top, unfoldTo({ folded: [], unfolded: [] }, 'a/x/2.txt')).map(r => r.key)
  expect(rows.slice(2, 7)).toEqual(['dir:a/', 'dir:a/x/', 'a/x/1.txt', 'a/x/2.txt', 'a/y.txt'])
  expect(firstChoice([f('a/x/1.txt'), f('b.txt')], { folded: [], unfolded: [] })).toBe('b.txt')
  expect(firstChoice([f('a/x/1.txt')], { folded: [], unfolded: [] })).toBe('a/x/1.txt')
  expect(firstChoice([f('a/x/1.txt')], { folded: ['dir:a/x/'], unfolded: [] })).toBe('dir:a/x/')
})

test("a file's modes as files.ts reads them: CSV cells, the browser's table score, JSON in a line, a label's scope, the values the labels that are on gave records, what a find found", () => {
  expect(csvCells('dse,3908,"Welcome, ""agents"""', ',')).toEqual(['dse', '3908', 'Welcome, "agents"'])
  expect(csvCells('a\tb\r', '\t')).toEqual(['a', 'b'])
  expect(tableScore([{ a: 1, b: 2 }, { a: 3, b: 4 }])).toBe(0.85)
  expect(tableScore([{ a: { x: 1 } }, { a: { y: 2 } }])).toBe(0.05)
  expect(tableScore(['line'])).toBe(0)
  expect(jsonOf('{"a": 1}')).toEqual({ a: 1 })
  expect(jsonOf('plain words')).toBeUndefined()
  expect(globTest('runs/**/*.jsonl, *.md')('runs/a/b.jsonl')).toBe(true)
  expect(globTest('runs/*.jsonl')('runs/a/b.jsonl')).toBe(false)
  const on = onLabels([{ id: 'k', name: 'note', labels: ['yes', 'no'], shown: true, unit: 'record', last_run: { paths: ['a.jsonl'] } }, { id: 'off', labels: ['x'], unit: 'record' }, { id: 'cards', shown: true, unit: 'cell' }])
  expect(on.map(l => l.id)).toEqual(['k'])
  expect(labelCovers(on[0]!, 'a.jsonl')).toBe(true)
  expect(labelCovers(on[0]!, 'b.jsonl')).toBe(false)
  const m = recordMarks([{ concept_id: 'k', rows: [{ ref: 'a.jsonl#L3', label: 'yes', analyst: 'no' }, { ref: 'a.jsonl#L4.b0:c1-5', label: 'yes' }, { ref: 'a.jsonl', label: 'yes' }] }, { concept_id: 'off', rows: [{ ref: 'a.jsonl#L3', label: 'x' }] }], on, 'a.jsonl')
  expect([...m.lines.entries()].map(([n, v]) => [n, [...v.entries()]])).toEqual([[3, [['k', 'no']]], [4, [['k', 'yes']]]])
  expect([...m.file.entries()]).toEqual([['k', 'yes']])
  const g = grepOf({ files: [{ path: 'a.jsonl', total: 3, complete: false, matches: [{ line: 2, text: 'a relay', hit: [2, 7] }] }], done: { scanned: 4, of: 9, complete: false } })
  expect(g).toEqual({ files: [{ path: 'a.jsonl', total: 3, complete: false, matches: [{ line: 2, text: 'a relay', hit: [2, 7] }] }], scanned: 4, of: 9, complete: false })
  expect([fileType('forge.db', 'forge'), fileType('a.csv', 'text'), fileType('chat.jsonl', 'text', 'transcript'), isDatabase('x.sqlite3')]).toEqual(['database', 'csv', 'transcript', true])
})
