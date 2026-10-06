// The cards lane: less chrome on a card, no hex ids where the analyst reads, theme-aware colours, the diagram kind,
// and cards written to the session's folder. `claude plugin test mods/thimble-cc-mod`.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

import { cardLayout, layerGraph, lineWidth, shortTimes, width, wrapCell, wrapLabel } from '../hooks/draw'
import type { Cell, CardData } from '../hooks/draw'
import { validateCard } from '../hooks/lib'
import { COLORS, SERIES } from '../hooks/paint'

const CWD = '/corpus/wiki'
const BAR: CardData = {
  id: 'abc123',
  kind: 'bar',
  question: 'Which wikis have the most revisions?',
  x: 'wiki',
  y: 'revisions',
  note: '',
  source: { script: '.thimble-cc-mod/scripts/by.py', index: 0 },
  rows: [
    { label: 'dse', value: 13403, group: '' },
    { label: 'probier', value: 1013, group: '' },
  ],
  total: 14416,
  params: [{ name: 'by', value: 'wiki', default: 'wiki', choices: ['wiki', 'label'] }],
}
const DIAGRAM: CardData = {
  id: 'd1a9e0',
  kind: 'diagram',
  question: 'Who hands work to whom?',
  x: '',
  y: '',
  note: '',
  source: { script: '.thimble-cc-mod/scripts/flow.py', index: 0 },
  nodes: [
    { id: 'p', label: 'Planner', ref: 'events.jsonl#L3' },
    { id: 'c', label: 'Coder' },
    { id: 'r', label: 'Reviewer' },
  ],
  edges: [
    { source: 'p', target: 'c', label: 'assigns' },
    { source: 'c', target: 'r', label: 'opens a pull request and explains each change in a long message' },
    { source: 'r', target: 'c', label: 'asks for changes' },
  ],
}

type World = { files: Map<string, string>; filled: string[]; opened: string[]; envSet: [string, string | undefined][]; clock?: ReturnType<typeof mock.clock> }

function world(on: On): World {
  const w: World = {
    files: new Map([
      [`${CWD}/.thimble-cc-mod/cards/abc123.json`, JSON.stringify(BAR)],
      [`${CWD}/.thimble-cc-mod/cards/d1a9e0.json`, JSON.stringify(DIAGRAM)],
    ]),
    filled: [],
    opened: [],
    envSet: [],
  }
  mock.env(on, {})
  w.clock = mock.clock(on, { now: 1_790_000_000_000 })
  on('env.set', ($, e) => {
    w.envSet.push([e.name, e.value])
    return { value: undefined } as never
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.messages', () => ({ value: [] }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('fs.read', ($, e) => {
    if (e.path.endsWith('/prompt/chat.md')) return { value: '# thimble-cc-mod\nguidance {{helper}}' }
    const text = w.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.stat', ($, e) => {
    if (!w.files.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }
  })
  on('fs.exists', ($, e) => ({ value: w.files.has(e.path) }))
  // a folder's files: those of the world directly in it
  on('fs.list', ($, e) => ({
    value: [...w.files.keys()].filter(k => k.startsWith(`${e.path}/`) && !k.slice(e.path.length + 1).includes('/')).map(k => ({ name: k.slice(e.path.length + 1), kind: 'file', size: 1, mtimeMs: 1, isLink: false })),
  }) as never)
  on('fs.write', ($, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    const req = JSON.parse(e.init?.stdin ?? '{"items":[]}') as { items: { id: string; ref: string }[] }
    const out = req.items.map(it => ({ id: it.id, ref: it.ref, kind: 'card', status: 'ok', why: 'resolves', window: [] }))
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.fill', ($, e) => {
    w.filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length } as never
  })
  on('prompt.read', () => ({ text: '', cursor: 0 }) as never)
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: ['(the engine row)'] })
  })
  return w
}

type M = Mounted<'terminal'>
const MESSAGE = (text: string) =>
  ({ plugin: 'thimble-cc-mod', component: 'AssistantMessage', requestId: 'm1', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never

/** Every string a drawn tree shows (a Button's label too), joined. */
function shown(tree: unknown): string {
  const out: string[] = []
  const walk = (n: unknown) => {
    if (typeof n === 'string') out.push(n)
    else if (Array.isArray(n)) n.forEach(walk)
    else if (n && typeof n === 'object') {
      const o = n as { label?: unknown; children?: unknown; props?: { label?: unknown; children?: unknown } }
      const label = o.label ?? o.props?.label
      if (typeof label === 'string') out.push(label)
      walk(o.children ?? o.props?.children)
    }
  }
  walk(tree)
  return out.join('')
}

// ------------------------------------------------------------------------------------------------ chrome

test('a card shows its question, its params and its chart: no action row, hint line, star or hex id', async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE('[[card:abc123]]\n\ndse has most.'))) as unknown as M
  const text = shown(await ui.drawn({ in: 'card-1-abc123' }))
  expect(text).toContain('Which wikis have the most revisions?')
  expect(text).toContain(' wiki ')
  expect(text).toContain('probier')
  for (const gone of ['abc123', 'card:', 'star', 'takeaway', 'rerun', 'hide', '? ask', 'click', 'hover', 'by.py']) expect(text).not.toContain(gone)
  await ui.unmount()
})

test('the value under the pointer shows at the right of the title; a click or double-click on it keeps it there, opens a thread about it and fills nothing', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE('[[card:abc123]]'))) as unknown as M
  await ui.resize({ columns: 100, rows: 12, in: 'card-1-abc123' })
  // the top border, the title, the blank row under it and the params row; then the bars, probier the second
  await ui.pointer({ type: 'move', x: 10, y: 5, in: 'card-1-abc123' } as never)
  expect(await ui.find({ type: 'Text', text: /probier {2}1,013 revisions/, in: 'card-1-abc123' })).toBeDefined()
  for (const type of ['down', 'up', 'down', 'up']) await ui.pointer({ type, x: 10, y: 5, button: 'left', in: 'card-1-abc123' } as never)
  expect(await ui.find({ type: 'Text', text: /probier {2}1,013 revisions/, in: 'card-1-abc123' })).toBeDefined()
  // a card value cites the card itself: a click is a side thread about it (twice for a double-click, the one panel);
  // nothing reaches main's prompt
  expect(w.opened).toEqual(['thimble', 'thimble'])
  expect(w.filled).toEqual([])
  await ui.unmount()
})

test('a right-click on a bar does what a click does: a side thread about the bar, named by its label and value; no menu', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE('[[card:abc123]]'))) as unknown as M
  await ui.resize({ columns: 100, rows: 12, in: 'card-1-abc123' })
  await ui.pointer({ type: 'down', x: 10, y: 5, button: 'right', in: 'card-1-abc123' } as never)
  await ui.pointer({ type: 'up', x: 10, y: 5, button: 'right', in: 'card-1-abc123' } as never)
  await ui.unmount()
  expect(w.opened).toEqual(['thimble'])
  expect(w.filled).toEqual([])
  const pane = (await $.ui.mount({ plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 100, rows: 30 }, props: { bodyColumns: 96, bodyRows: 28 } } as never)) as unknown as M
  expect(await pane.find({ type: 'Text', text: /probier: 1,013/ })).toBeDefined()
  expect(await pane.find({ key: 'menu-verify' })).toBeUndefined()
  expect(await pane.find({ key: 'menu-cite' })).toBeUndefined()
  await pane.unmount()
})

test('a card that cannot be drawn is named by its place in the reply, not its id', async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = await $.ui.mount(MESSAGE('[[card:abc123]]\n\nthen\n\n[[card:831a65]]'))
  const err = await ui.find({ type: 'Text', text: /^× card 2 cannot be drawn: its card file was not written/ })
  expect(err).toBeDefined()
  expect(JSON.stringify(err)).not.toContain('831a65')
  await ui.unmount()
})

test('the helper is told the session folder, and a rerun passes it on', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  expect(w.envSet).toContainEqual(['THIMBLE_CC_MOD_ROOT', CWD])
})

test('/thimble-card takes a card by its place in the last reply', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'q', turnId: 't1' } as never)
  await $.turn.complete({ turnId: 't1', answer: '[[card:abc123]]\n\n[[card:d1a9e0]]', durationMs: 5, reason: 'answer' } as never)
  const r = await $.command.run({ command: 'thimble-card', args: '2' } as never)
  expect(JSON.stringify(r)).toContain('Who hands work to whom?')
  expect(w.opened).toContain('thimble')
  // the panel shows the card view
  const pane = (await $.ui.mount({ plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { bodyColumns: 96, bodyRows: 30 } } as never)) as unknown as M
  expect(await pane.find({ type: 'Client', key: 'pane-d1a9e0' })).toBeDefined()
  // in the pane the card is boxed as in the chat; the question is the panel's title, so the box opens with the readout
  // row, blank until a mark is under the pointer, and draws no title of its own
  await pane.resize({ columns: 96, rows: 30, in: 'pane-d1a9e0' })
  const box = (await pane.drawn({ in: 'pane-d1a9e0' })) as unknown as { type: string; props: Record<string, unknown>; children?: unknown[] }
  expect(box.props).toMatchObject({ borderStyle: 'round', borderColor: COLORS.rule, paddingX: 1 })
  const rows = ((box.children ?? box.props.children) as unknown[]).map(c => shown(c))
  expect(rows[0]!.trim()).toBe('')
  expect(rows.join('\n')).not.toContain('Who hands work to whom?')
  expect(await pane.find({ type: 'Button', key: 'card-title:d1a9e0', in: 'pane-d1a9e0' })).toBeUndefined()
  // a mark under the pointer: its readout against the box's right edge
  const lay = cardLayout(DIAGRAM, 92, -1)
  const y = lay.lines.findIndex(l => l.map(x => x.s).join('').includes('Planner'))
  const x = lay.lines[y]!.map(x => x.s).join('').indexOf('Planner')
  await pane.pointer({ type: 'move', x: x + 2, y: y + 2, in: 'pane-d1a9e0' } as never)
  expect(await pane.find({ type: 'Text', text: /^ +Planner {2}events\.jsonl line 3$/, in: 'pane-d1a9e0' })).toBeDefined()
  await pane.unmount()
})

// ------------------------------------------------------------------------------------------------ colours

const THEMES: Record<string, { bg: string[]; keys: Record<string, string> }> = {
  light: {
    bg: ['#ffffff', '#f6f6f6'],
    keys: { text: 'rgb(0,0,0)', inverseText: 'rgb(255,255,255)', inactive: 'rgb(102,102,102)', subtle: 'rgb(175,175,175)', remember: 'rgb(0,0,255)', permission: 'rgb(87,105,247)', suggestion: 'rgb(87,105,247)', success: 'rgb(44,122,57)', error: 'rgb(171,43,63)', warning: 'rgb(150,108,30)', userMessageBackground: 'rgb(240,240,240)', selectionBg: 'rgb(180,213,255)', composerSidebarBackground: 'rgb(245,245,245)' },
  },
  'light-daltonized': {
    bg: ['#ffffff', '#f6f6f6'],
    keys: { text: 'rgb(0,0,0)', inverseText: 'rgb(255,255,255)', inactive: 'rgb(102,102,102)', subtle: 'rgb(175,175,175)', remember: 'rgb(51,102,255)', permission: 'rgb(51,102,255)', suggestion: 'rgb(51,102,255)', success: 'rgb(0,102,153)', error: 'rgb(204,0,0)', warning: 'rgb(255,153,0)', userMessageBackground: 'rgb(220,220,220)', selectionBg: 'rgb(180,213,255)', composerSidebarBackground: 'rgb(235,235,235)' },
  },
  dark: {
    bg: ['#000000', '#1e1e1e', '#282c34'],
    keys: { text: 'rgb(255,255,255)', inverseText: 'rgb(0,0,0)', inactive: 'rgb(153,153,153)', subtle: 'rgb(80,80,80)', remember: 'rgb(177,185,249)', permission: 'rgb(177,185,249)', suggestion: 'rgb(177,185,249)', success: 'rgb(78,186,101)', error: 'rgb(255,107,128)', warning: 'rgb(255,193,7)', userMessageBackground: 'rgb(55,55,55)', selectionBg: 'rgb(38,79,120)', composerSidebarBackground: 'rgb(38,38,38)' },
  },
  'dark-daltonized': {
    bg: ['#000000', '#1e1e1e', '#282c34'],
    keys: { text: 'rgb(255,255,255)', inverseText: 'rgb(0,0,0)', inactive: 'rgb(153,153,153)', subtle: 'rgb(80,80,80)', remember: 'rgb(153,204,255)', permission: 'rgb(153,204,255)', suggestion: 'rgb(153,204,255)', success: 'rgb(51,153,255)', error: 'rgb(255,102,102)', warning: 'rgb(255,204,0)', userMessageBackground: 'rgb(55,55,55)', selectionBg: 'rgb(38,79,120)', composerSidebarBackground: 'rgb(38,38,38)' },
  },
}

function rgb(c: string): number[] {
  const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(c)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])]
  const h = c.replace('#', '')
  return [0, 2, 4].map(i => Number.parseInt(h.slice(i, i + 2), 16))
}

function contrast(a: string, b: string): number {
  const lum = (c: string) => {
    const [r, g, bl] = rgb(c).map(v => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!
  }
  const [x, y] = [lum(a), lum(b)].sort((p, q) => p - q)
  return (y! + 0.05) / (x! + 0.05)
}

test('colours: theme keys for text and highlights, a series palette that reads on light and dark backgrounds', () => {
  const resolve = (theme: string, c: string) => (c.startsWith('#') ? c : THEMES[theme]!.keys[c]!)
  for (const [name, t] of Object.entries(THEMES)) {
    for (const bg of t.bg) {
      // text: 4.5:1 on the theme's own background (white or black), 4:1 on an off-white or grey one; marks (bars,
      // lines, points): 3:1 on any
      const least = bg === t.bg[0] ? 4.5 : 4
      for (const token of [COLORS.text, COLORS.dim, COLORS.problem]) {
        expect(contrast(resolve(name, token), bg)).toBeGreaterThanOrEqual(least)
      }
      for (const c of SERIES) expect(contrast(c, bg)).toBeGreaterThanOrEqual(3)
    }
    // the selection background (a selected row, a cited value, the open menu's target) keeps the theme's text readable
    expect(contrast(resolve(name, COLORS.text), resolve(name, COLORS.selected))).toBeGreaterThanOrEqual(4.5)
    // on the panel Claude Code draws a docked pane on (its light themes' 245 or 235 grey): marks keep 3:1, and the
    // theme's own text colours, which the mod does not choose, stay readable
    for (const bg of name.startsWith('light') ? ['#f5f5f5', '#ebebeb'] : ['#262626']) {
      for (const c of SERIES) expect(contrast(c, bg)).toBeGreaterThanOrEqual(3)
      for (const token of [COLORS.text, COLORS.dim, COLORS.problem]) expect(contrast(resolve(name, token), bg)).toBeGreaterThanOrEqual(3.5)
    }
    // the selected row and an active chip stand out from the panel, a blue on a grey
    expect(contrast(resolve(name, COLORS.selected), resolve(name, COLORS.panel))).toBeGreaterThanOrEqual(1.25)
    // the open menu's target stands out from every background of the theme
    for (const bg of t.bg) expect(contrast(resolve(name, COLORS.selected), bg)).toBeGreaterThanOrEqual(1.3)
  }
  // every token that is not a raw colour is a key of Claude Code's theme
  const tokens: string[] = Object.values(COLORS).flatMap(v => (typeof v === 'string' ? [v] : v))
  for (const t of tokens) if (!t.startsWith('#')) expect(Object.keys(THEMES.light!.keys)).toContain(t)
})

// ------------------------------------------------------------------------------------------------ diagrams

test('validateCard holds a diagram to its spec', () => {
  expect(validateCard(DIAGRAM, 'd1a9e0')).toBe(null)
  expect(validateCard({ ...DIAGRAM, nodes: [] })).toContain('needs nodes')
  expect(validateCard({ ...DIAGRAM, nodes: [{ id: 'p', label: 'P' }, { id: 'p', label: 'Q' }] })).toContain('id of its own')
  expect(validateCard({ ...DIAGRAM, edges: [{ source: 'p', target: 'zz' }] })).toContain('edge 1')
  expect(validateCard({ ...DIAGRAM, nodes: [{ id: 'p' }] })).toContain('node 1')
})

test('layers: a node sits one row past its furthest predecessor; a cycle is broken', () => {
  const l = layerGraph(['a', 'b', 'c', 'd'], [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }, { source: 'a', target: 'c' }, { source: 'c', target: 'a' }])
  expect([l.get('a'), l.get('b'), l.get('c')]).toEqual([0, 1, 2])
  expect(l.get('d')).toBe(0)
})

test('a diagram is drawn in boxes and box-drawing lines, a long label as a numbered note, nodes and edges hit', () => {
  const lay = cardLayout(DIAGRAM, 70, -1)
  const text = lay.lines.map(l => l.map(s => s.s).join(''))
  const box = text.findIndex(t => t.includes('│ Planner │'))
  expect(box).toBeGreaterThanOrEqual(0)
  expect(text.some(t => t.includes('│ Coder │'))).toBe(true)
  expect(text.join('\n')).toMatch(/[╭─]+↓[─╮]+/) // an arrow on a target's top border
  expect(text.join('\n')).toContain('↑') // the edge back up from Reviewer to Coder
  expect(text.join('\n')).toContain('assigns')
  expect(text.some(t => /^1 {2}Coder → Reviewer: opens a pull request/.test(t))).toBe(true)
  expect(text.every(t => t.length <= 70)).toBe(true)
  // the box is its node: the Planner, whose ref is a record
  const x = text[box]!.indexOf('Planner')
  expect(lay.hit(x, box)).toBe(0)
  expect(lay.items[0]).toMatchObject({ kind: 'node', open: 'events.jsonl#L3', cite: '[[events.jsonl#L3]]', text: 'Planner' })
  expect(lay.items[1]).toMatchObject({ kind: 'node', open: 'card:d1a9e0#node/c' })
  // an edge's line is its edge, after the nodes
  const arrowRow = text.findIndex(t => t.includes('↓'))
  expect(lay.hit(text[arrowRow]!.indexOf('↓'), arrowRow)).toBeGreaterThanOrEqual(3)
  // the note line is its edge too
  const note = text.findIndex(t => t.startsWith('1  '))
  expect(lay.items[lay.hit(0, note)]).toMatchObject({ label: 'Coder → Reviewer' })
  // hovering a node draws its words in inverse
  const hot = cardLayout(DIAGRAM, 70, 0)
  expect(hot.lines[box]!.filter(s => s.inv).map(s => s.s).join('')).toContain('Planner')
})

test('a row too wide for the card moves nodes to a row of their own', () => {
  const nodes = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, label: `Agent number ${i}` }))
  const lay = cardLayout({ ...DIAGRAM, nodes, edges: nodes.slice(1).map(n => ({ source: 'n0', target: n.id })) }, 50, -1)
  const text = lay.lines.map(l => l.map(s => s.s).join(''))
  expect(text.every(t => t.length <= 50)).toBe(true)
  expect(text.filter(t => t.includes('╭')).length).toBeGreaterThanOrEqual(3) // the root's row and two rows of children
  for (const n of nodes) expect(text.join('\n')).toContain(n.label.slice(0, 6))
})

const FAN_IN: CardData = {
  ...DIAGRAM,
  id: 'f4n1n0',
  question: 'Which wikis did the five largest labels write on?',
  nodes: ['AgentRelent', 'AgentMassPointer13', 'MapHelper', 'LinkHelper771', 'AgentTestLearnXYZ', 'wiki dse'].map(id => ({ id, label: id })),
  edges: [
    { source: 'AgentRelent', target: 'wiki dse', label: '317 revisions' },
    { source: 'AgentMassPointer13', target: 'wiki dse', label: '187 revisions' },
    { source: 'MapHelper', target: 'wiki dse', label: '184 revisions' },
    { source: 'LinkHelper771', target: 'wiki dse', label: '176 revisions' },
    { source: 'AgentTestLearnXYZ', target: 'wiki dse', label: '130 revisions' },
  ],
}

test('a long node label wraps to two lines before it is cut', () => {
  expect(wrapLabel('AgentMassPointer13', 12)).toEqual(['AgentMass', 'Pointer13'])
  expect(wrapLabel('3083 labels in one wiki', 12)).toEqual(['3083 labels', 'in one wiki'])
  expect(wrapLabel('wiki dse', 12)).toEqual(['wiki dse'])
  const lay = cardLayout(FAN_IN, 76, -1)
  const text = lay.lines.map(l => l.map(s => s.s).join('')).join('\n')
  for (const part of ['AgentMass', 'Pointer13', 'LearnXYZ']) expect(text).toContain(part)
  expect(text).not.toContain('…')
})

test('edges into one box keep ports of their own, and each label belongs to one edge', () => {
  const lay = cardLayout(FAN_IN, 76, -1)
  const text = lay.lines.map(l => l.map(s => s.s).join(''))
  const N = FAN_IN.nodes!.length
  // five arrows on wiki dse's top border, a blank column between each two
  const arrows = text.find(t => (t.match(/↓/g) ?? []).length === 5)
  expect(arrows).toBeDefined()
  expect(arrows).not.toMatch(/↓↓/)
  // a label written in the drawing is on its edge: the cells of its words hit that edge
  const notes = text.map((t, y) => [t, y] as const).filter(([t]) => /^\d+ {2}/.test(t))
  expect(notes.length).toBeGreaterThan(0)
  const drawing = text.slice(0, notes[0]![1])
  for (const [k, e] of FAN_IN.edges!.entries()) {
    const row = drawing.findIndex(t => t.includes(e.label!))
    if (row >= 0) expect(lay.hit(drawing[row]!.indexOf(e.label!), row)).toBe(N + k)
  }
  // a label with no place of its own is a note, and its number stands on its edge's line
  for (const [t, y] of notes) {
    const n = t.split(' ')[0]!
    const edge = lay.hit(0, y)
    const onEdge = drawing.some((r, yy) => [...r.matchAll(new RegExp(`(?<![0-9])${n}(?![0-9])`, 'g'))].some(m => lay.hit(m.index!, yy) === edge))
    expect(onEdge).toBe(true)
  }
})

test('a line passing a row runs on straight into its port, with no one-column jog', () => {
  for (const cols of [76, 110]) {
    const text = cardLayout(FAN_IN, cols, -1).lines.map(l => l.map(s => s.s).join(''))
    expect(text.join('\n')).not.toMatch(/╰╮|╭╯|╯╭|╮╰/)
  }
})

test('a timeline shows short times and cites them as it shows them', () => {
  expect(shortTimes(['2026-06-18T21:26:00Z', '2026-07-02 16:46'])).toEqual(['18 Jun 21:26', '2 Jul 16:46'])
  expect(shortTimes(['2026-06-18', '2026-06-19T00:00:00Z'])).toEqual(['18 Jun', '19 Jun'])
  expect(shortTimes(['2025-12-31 23:59', '2026-01-01 00:01'])).toEqual(['31 Dec 2025 23:59', '1 Jan 2026 00:01'])
  expect(shortTimes(['2026-06-18T21:26:05Z', '2026-06-18T21:26:40Z'])).toEqual(['18 Jun 21:26:05', '18 Jun 21:26:40'])
  expect(shortTimes(['day 1', '2026-06-18'])).toEqual(['day 1', '2026-06-18'])
  const card: CardData = {
    ...BAR,
    kind: 'timeline',
    events: [
      { time: '2026-06-18T17:15:00Z', label: 'First revision', ref: '' },
      { time: '2026-06-18T21:26:00Z', label: 'Last revert', ref: 'revisions.jsonl#L9', shown: '18 Jun 21:26' },
    ],
  }
  const lay = cardLayout(card, 70, -1)
  const text = lay.lines.map(l => l.map(s => s.s).join('')).join('\n')
  expect(text).toContain('18 Jun 17:15')
  expect(text).not.toMatch(/T\d\d:|:00Z/)
  expect(lay.items[0]).toMatchObject({ label: '18 Jun 17:15', cite: '[[18 Jun 17:15|card:abc123#time/1]]', text: '18 Jun 17:15' })
})

test('a diagram in a reply is a Client card; a press on a node with a record opens it', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE('[[card:d1a9e0]]'))) as unknown as M
  await ui.resize({ columns: 80, rows: 30, in: 'card-1-d1a9e0' })
  const tree = await ui.drawn({ in: 'card-1-d1a9e0' })
  expect(shown(tree)).toContain('Planner')
  // the border, the title and the blank row under it, then the drawing, inside the border and its padding (2 cells a
  // side): Planner's label on its second row
  const lay = cardLayout(DIAGRAM, 76, -1)
  const row = lay.lines.findIndex(l => l.map(s => s.s).join('').includes('Planner'))
  const col = lay.lines[row]!.map(s => s.s).join('').indexOf('Planner')
  await ui.pointer({ type: 'down', x: col + 2, y: row + 3, button: 'left', in: 'card-1-d1a9e0' } as never)
  await ui.pointer({ type: 'up', x: col + 2, y: row + 3, button: 'left', in: 'card-1-d1a9e0' } as never)
  expect(w.opened).toEqual(['thimble']) // the Citation view, at once: a click waits for no second one
  await ui.unmount()
})

// ------------------------------------------------------------------------------------------------ round 8: the frame, no menu shading, dense diagrams

test('every card has a full round border in the rule grey with a cell of padding; its title, a blank row, then its body', async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE('[[card:abc123]]'))) as unknown as M
  await ui.resize({ columns: 100, rows: 12, in: 'card-1-abc123' })
  const box = (await ui.drawn({ in: 'card-1-abc123' })) as unknown as { type: string; props: Record<string, unknown>; children?: unknown[] }
  expect(box.type).toBe('Box')
  expect(box.props).toMatchObject({ borderStyle: 'round', borderColor: COLORS.rule, paddingX: 1, width: 100 })
  const rows = ((box.children ?? box.props.children) as unknown[]).map(c => shown(c))
  expect(rows[0]).toContain('Which wikis have the most revisions?')
  expect(rows[1]!.trim()).toBe('')
  expect(rows[2]).toMatch(/^by {2}wiki {2}label$/)
  // the lines inside take the room the border and its padding leave
  for (const l of cardLayout(BAR, 96, -1).lines) expect(lineWidth(l)).toBeLessThanOrEqual(96)
  await ui.unmount()
})

test('a right-click on a card shades nothing on it: a right-click does what a click does', async ($, on) => {
  const w = world(on)
  on('ui.panes', () => ({ value: [{ id: 'thimble', title: 'Actions', isShown: true, isFocused: true, isPlaced: true }] }) as never)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE('[[card:d1a9e0]]'))) as unknown as M
  await ui.resize({ columns: 80, rows: 30, in: 'card-1-d1a9e0' })
  const lit = async () => JSON.stringify(await ui.drawn({ in: 'card-1-d1a9e0' })).includes(COLORS.selected)
  await ui.pointer({ type: 'down', x: 4, y: 1, button: 'right', in: 'card-1-d1a9e0' } as never)
  await ui.pointer({ type: 'up', x: 4, y: 1, button: 'right', in: 'card-1-d1a9e0' } as never)
  await w.clock!.advance(300)
  expect(await lit()).toBe(false)
  await ui.unmount()
})

const graph = (id: string, edges: [string, string, string?][]): CardData => {
  const ids = [...new Set(edges.flatMap(e => [e[0], e[1]]))]
  return { ...DIAGRAM, id, nodes: ids.map(n => ({ id: n, label: n })), edges: edges.map(([source, target, label]) => ({ source, target, ...(label ? { label } : {}) })) }
}
const COLLUSION = graph('c0ll', [
  ['Orchestrator', 'AgentRelent'], ['Orchestrator', 'AgentMassPointer13'], ['Orchestrator', 'MapHelper'], ['Orchestrator', 'LinkHelper771'], ['Orchestrator', 'AgentTestLearnXYZ'],
  ['AgentRelent', 'wiki dse', '317'], ['AgentRelent', 'wiki meta', '12'], ['AgentMassPointer13', 'wiki dse', '187'], ['AgentMassPointer13', 'wiki probier', '40'],
  ['MapHelper', 'wiki dse', '184'], ['MapHelper', 'wiki meta', '9'], ['LinkHelper771', 'wiki probier', '176'], ['AgentTestLearnXYZ', 'wiki dse', '130'], ['AgentTestLearnXYZ', 'wiki meta'],
  ['wiki dse', 'Reviewer bot'], ['wiki probier', 'Reviewer bot'], ['wiki meta', 'Reviewer bot'], ['Reviewer bot', 'Orchestrator', 'reverts'],
])
const DENSE = graph('d3nse', [
  ['Wiki F', 'Agent I'], ['Bot D', 'Agent I'], ['Agent A', 'Bot D'], ['Wiki B', 'Bot H'], ['Tool G', 'Bot H'], ['Wiki B', 'Bot D', '91'], ['Tool C', 'Wiki F'], ['Bot D', 'Agent E'],
  ['Bot H', 'Wiki J'], ['Wiki B', 'Wiki J'], ['Wiki B', 'Tool C', '118'], ['Wiki B', 'Tool G'], ['Agent A', 'Agent E'], ['Tool C', 'Agent E'], ['Wiki B', 'Tool C'], ['Wiki B', 'Wiki F'],
  ['Agent A', 'Bot H'], ['Agent E', 'Agent I'],
])
const drawn = (card: CardData, cols: number) => cardLayout(card, cols, -1).lines.map(l => l.map(s => s.s).join(''))
/** Cells where a vertical line crosses a horizontal run. */
const crossings = (text: string[]) => text.reduce((n, t) => n + (t.match(/(?<=─)│(?=─)|┼/g) ?? []).length, 0)

test('a dense diagram crosses as few lines as its graph needs', () => {
  // agents to wikis need three crossings at best (wiki probier first, then dse, then meta)
  for (const cols of [56, 72, 116]) expect(crossings(drawn(COLLUSION, cols))).toBeLessThanOrEqual(3)
  // two sources each to the same two targets: one crossing, not one per line its run passes
  const k22 = graph('k22', [['Final', 'Link'], ['Link', 'welcome page'], ['Pointer', 'welcome page'], ['Pointer', 'Agent13SecSmallEssential'], ['Link', 'Agent13SecSmallEssential']])
  expect(crossings(drawn(k22, 72))).toBe(1)
  expect(crossings(drawn(DENSE, 72))).toBeLessThanOrEqual(5)
})

test('a dense diagram in a narrow card fits the card: rows wrap and gaps narrow, nothing is cut at the edge', () => {
  for (const cols of [26, 36, 46, 56]) {
    for (const card of [COLLUSION, DENSE]) {
      const text = drawn(card, cols)
      expect(Math.max(...text.map(t => [...t].length))).toBeLessThanOrEqual(cols)
      for (const n of card.nodes!) expect(text.join('\n')).toContain(n.label.slice(0, 3))
    }
  }
  // a note too long for the card wraps under its edge's ends
  const long = graph('l0ng', [['one run: 48 workers on a pandas backlog', 'forge.db: 176 PRs, reviews and merges', 'issues only in PRs + issues runs, never in the others']])
  const text = drawn(long, 46)
  expect(Math.max(...text.map(t => [...t].length))).toBeLessThanOrEqual(46)
  const note = text.findIndex(t => t.startsWith('1  '))
  expect(note).toBeGreaterThan(0)
  expect(text.slice(note).join(' ')).toContain('never in')
})

test('a pointer move repaints a diagram without laying it out again', () => {
  const big = graph('b1g', Array.from({ length: 40 }, (_, k): [string, string] => [`Node ${(k * 7) % 20}`, `Node ${20 + ((k * 11) % 8)}`]))
  cardLayout(big, 76, -1)
  const t = Date.now()
  for (let i = 0; i < 20; i++) cardLayout(big, 76, i)
  expect(Date.now() - t).toBeLessThan(200)
})

// ------------------------------------------------------------------------------------------------ round 1: label room

test('labels take the room the card has, and wrap to two lines before they are cut', () => {
  const text = (c: CardData, cols: number) => cardLayout(c, cols, -1).lines.map(l => l.map(s => s.s).join(''))
  const long = 'notes to other agents on time-sensitive tasks'
  const bars: CardData = { ...BAR, rows: [{ label: long, value: 412, group: '' }, { label: 'edits', value: 30, group: '' }] }
  expect(text(bars, 116)[0]).toContain(long)
  expect(text(bars, 116)[0]).toMatch(/█{30}/) // the bars keep their room
  // too long for its column: two lines, both its row's
  const narrow = cardLayout(bars, 50, -1)
  expect(text(bars, 50).slice(0, 2).join(' ')).toContain('time-sensitive')
  expect([narrow.hit(0, 0), narrow.hit(0, 1), narrow.hit(0, 2)]).toEqual([0, 0, 1])
  const first = 'save event revision_ref found in revisions and the audit log'
  const table: CardData = { ...BAR, kind: 'table', columns: ['pattern', 'count'], rows: [[first, 312], ['short', 9]] }
  // under the column names and the rule under them
  expect(text(table, 116)[2]).toContain(first)
  const wrapped = cardLayout(table, 40, -1)
  expect(text(table, 40).slice(2, 4).join(' ')).toContain('audit log')
  expect([wrapped.hit(0, 1), wrapped.hit(0, 2), wrapped.hit(0, 3), wrapped.hit(0, 4)]).toEqual([-1, 0, 0, 2])
  const note = 'Agent posts a note to the other agents about splitting the edit work before the deadline'
  const ex: CardData = { ...BAR, kind: 'example', examples: [{ ref: 'wiki/revisions.jsonl#L12345', quote: 'the quote', note }] }
  expect(text(ex, 116).join(' ')).toContain(note)
  // its place in words: the file and its line
  expect(text(ex, 116).join(' ')).toContain('wiki/revisions.jsonl line 12345')
  const dg = graph('n0te', [['AgentRelent posting coordination notes', 'wiki dse', 'writes three hundred and seventeen revisions over two days, most of them reverting other agents']])
  expect(text(dg, 116).join(' ')).toContain('AgentRelent posting coordination notes → wiki dse: writes')
  expect(text(dg, 116).join(' ')).not.toContain('…')
})

// ------------------------------------------------------------------------------------------------ the panel's width

const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'))
const LINE: CardData = {
  id: 'f18jun',
  kind: 'line',
  question: 'On 18 June, which hours and pages did the edits go to?',
  x: 'hour',
  y: 'edits',
  note: '',
  source: { script: '.thimble-cc-mod/scripts/hours.py', index: 0 },
  series: ['pages edited', 'pages created', 'pages moved', 'pages deleted', 'pages restored from an earlier revision'].map((name, k) => ({
    name,
    points: HOURS.map((h, i) => [h, ((i * 37 + k * 11) % 23) * (k + 1)] as [string, number]),
  })),
}

/** The width of each line a drawn tree shows: each Text a card or a view paints as one line (truncate-end). */
function lineWidths(tree: unknown): number[] {
  const out: number[] = []
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk)
    if (!n || typeof n !== 'object') return
    const o = n as { type?: string; props?: { wrap?: string; children?: unknown }; children?: unknown }
    if (o.type === 'Text' && o.props?.wrap === 'truncate-end') return void out.push(width(shown(o)))
    walk(o.children ?? o.props?.children)
  }
  walk(tree)
  return out
}

const GROUPS: CardData = {
  ...BAR,
  id: 'g4bars',
  question: 'Which wikis did each kind of agent edit on 18 June, by hour of the evening?',
  rows: ['dse', 'probier', 'sandbox', 'help'].map((g, i) => ({ label: `${g} wiki at ${17 + i}:00`, value: 40 + i * 517, group: `${g} agents posting notes` })),
}

test('at a panel\'s width every card fits: no line is wider than the room, and a long legend wraps', () => {
  for (const cols of [56, 61, 66]) {
    for (const card of [LINE, BAR, GROUPS, DIAGRAM]) {
      const lines = cardLayout(card, cols, -1).lines
      expect(Math.max(...lines.map(lineWidth))).toBeLessThanOrEqual(cols)
    }
    const text = cardLayout(LINE, cols, -1).lines.map(l => l.map(s => s.s).join('')).join('\n')
    for (const name of ['pages edited', 'pages deleted', 'pages restored']) expect(text).toContain(name)
    // the x labels at the ends and the middle
    expect(text).toMatch(/00 +12 +23/)
  }
})

test('a card in a side thread\'s answer takes the panel\'s width less the reply\'s margin, so nothing is cut', async ($, on) => {
  const w = world(on)
  w.files.set(`${CWD}/.thimble-cc-mod/cards/g4bars.json`, JSON.stringify(GROUPS))
  // a thread saved by an earlier session, whose answer holds the card; the threads list reopens it
  const turn = { q: 'which hours did the edits go to?', a: 'By hour:\n\n[[card:g4bars]]', state: 'done', tools: 2, partial: '' }
  const saved = { id: 'tsaved', label: 'the last answer', ref: '', context: '', engine: 'fork', turns: [turn], file: '.thimble-cc-mod/threads/tsaved.md' }
  w.files.set(`${CWD}/.thimble-cc-mod/threads/tsaved.json`, JSON.stringify(saved))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const PANE = { plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 200, rows: 55 }, props: { bodyColumns: 70, bodyRows: 50 } } as never
  await $.command.run({ command: 'thimble-threads', args: '' } as never)
  let pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.press({ key: 'thread-open:tsaved' })
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  const room = 70 - 2 - 2 // the panel's body, less its type area's margins and the answer's margin (its A2)
  const card = (await pane.find({ type: 'Client', key: 't1-card-2-g4bars' })) as { props: { width: number; props: { cols: number } } } | undefined
  expect(card?.props.width).toBe(room)
  expect(card?.props.props.cols).toBe(room)
  // drawn at the width the panel gives it, as the engine lays the Client out
  await pane.resize({ columns: card!.props.width, rows: 20, in: 't1-card-2-g4bars' })
  const widths = lineWidths(await pane.drawn({ in: 't1-card-2-g4bars' }))
  expect(widths.length).toBeGreaterThan(4)
  expect(shown(await pane.drawn({ in: 't1-card-2-g4bars' }))).toContain('help agents posting notes')
  expect(Math.max(...widths)).toBeLessThanOrEqual(room) // no border or padding: rules above and below
  await pane.unmount()
})

// ------------------------------------------------------------------------------------------------ round 2: tables at a narrow panel

// names longer than a third of a narrow card, times as text, headers longer than their numbers
const NAMES = ['AgentRelent', 'ResearchReaderMN', 'GuestResearch378611', 'OpenAIResearchSec2027', 'BridgeFresh12', 'ResearchHelperArchiveCofcY', 'ZZUniqueAgentJun18Citations', 'OpenAIBot']
const WHO: CardData = {
  ...BAR,
  id: 'wh0ed1',
  kind: 'table',
  params: [],
  question: 'Who edited the welcome page in the ten minutes around this revision?',
  columns: ['label', 'revisions', 'first (UTC)', 'last (UTC)', 'IP /16 values'],
  rows: NAMES.map((n, i) => [n, 94 - i * 11, `20:0${i}:27`, `20:1${i}:06`, 55 - i * 6]),
}
const FOLLOW: CardData = {
  ...BAR,
  id: 'f0110w',
  kind: 'table',
  params: [],
  question: 'When a different label edits the same page within the window, what does it do to the version before?',
  columns: ['pages', 'quick follow-ups', 'pages involved', 'built on previous', 'replaced previous', 'other'],
  rows: [
    ['3 shared default pages', 2808, 3, 339, 2235, 234],
    ['all other pages', 3583, 698, 2541, 786, 256],
    ['all pages', 6391, 701, 2880, 3021, 490],
  ],
}
const plain = (c: CardData, cols: number, hover = -1) => cardLayout(c, cols, hover).lines.map(l => l.map(s => s.s).join(''))

test('in a narrow card a table keeps every column whole: blocks one under another, each led by the names, no word broken', () => {
  for (const card of [WHO, FOLLOW]) {
    for (const cols of [36, 42, 46]) {
      const lines = plain(card, cols)
      const all = lines.join('\n')
      expect(Math.max(...cardLayout(card, cols, -1).lines.map(lineWidth))).toBeLessThanOrEqual(cols)
      expect(all).not.toContain('…') // no column cut, no cell cut
      // a header breaks only at a space or after a hyphen
      for (const h of card.columns!) for (const piece of h.split(/ |(?<=-)/)) expect(lines.some(l => l.includes(piece))).toBe(true)
      for (const r of card.rows as Cell[][]) for (const v of r.slice(1)) expect(all).toMatch(new RegExp(`(^|\\s)${v}(\\s|$)`, 'm'))
      // the first column's header leads each block
      expect(lines.filter(l => l.startsWith(`${card.columns![0]} `)).length).toBeGreaterThanOrEqual(2)
    }
  }
  // every name whole while one fits beside the widest other column: at 42 columns its columns take more blocks
  const who = plain(WHO, 42)
  for (const name of NAMES) expect(who.some(l => l.startsWith(`${name} `))).toBe(true)
  expect(who.filter(l => /^AgentRelent\s/.test(l)).length).toBe(who.filter(l => l.startsWith('label ')).length)
  expect(who.some(l => l.includes('20:00:27'))).toBe(true) // a time is never broken at its colons
  // a name wider than the room the other columns leave breaks before a capital, both halves its row's
  const narrow = plain(WHO, 36)
  const at = narrow.findIndex(l => l.startsWith('ZZUniqueAgent '))
  expect(narrow[at + 1]!.trim()).toBe('Jun18Citations')
  expect(narrow.filter(l => /^ResearchHelperArchiveCofcY\s/.test(l)).length).toBeGreaterThan(0) // the next longest is whole
  const lay = cardLayout(WHO, 36, -1)
  expect([lay.hit(0, at), lay.hit(0, at + 1)]).toEqual([6 * 5, 6 * 5])
  // where there is room it is one table, its headers on one line
  const wide = plain(WHO, 96)
  expect(wide[0]).toMatch(/^label +revisions +first \(UTC\) +last \(UTC\) +IP \/16 values$/)
  expect(wide.filter(l => l.startsWith('label ')).length).toBe(1)
  expect(wide.some(l => l.includes('ZZUniqueAgentJun18Citations'))).toBe(true)
})

test('a table\'s cells break between words, after a hyphen, and inside a name only where it alone is too wide', () => {
  expect(wrapCell('quick follow-ups', 7, 3)).toEqual(['quick', 'follow-', 'ups'])
  expect(wrapCell('ZZUniqueAgentJun18Citations', 16, 2)).toEqual(['ZZUniqueAgent', 'Jun18Citations'])
  expect(wrapCell('2026-06-16 20:49', 12, 2)).toEqual(['2026-06-16', '20:49'])
  expect(wrapCell('revisions.jsonl#L1234', 12, 2)).toEqual(['revisions.', 'jsonl#L1234'])
  expect(wrapCell('3 shared default pages', 15, 2)).toEqual(['3 shared', 'default pages'])
  expect(wrapCell('revisions', 6, 2)).toEqual(['revis…']) // a word wider than its column is cut, not split
  // a pair of names breaks at a space, never inside a name that fits; before its "+", so the next line reads as the
  // same row, and after it only where "+ name" does not fit
  expect(wrapCell('OpenAIResearchSec2028 + OurMassFinal', 27, 2)).toEqual(['OpenAIResearchSec2028', '+ OurMassFinal'])
  expect(wrapCell('MapHelper + OpenAIResearchSec2028', 27, 2)).toEqual(['MapHelper', '+ OpenAIResearchSec2028'])
  expect(wrapCell('AgentSECCountyLinker99172 + OAIHelperSec', 27, 2)).toEqual(['AgentSECCountyLinker99172', '+ OAIHelperSec'])
  expect(wrapCell('AgentOpenResearch + LanguageWatcherNov12', 21, 2)).toEqual(['AgentOpenResearch +', 'LanguageWatcherNov12'])
})

test('a cell in a later block is its own column\'s; hovering it inverts that cell alone', () => {
  const lines = plain(WHO, 46)
  const second = lines.findIndex((l, y) => l.startsWith('label ') && lines.slice(0, y).some(p => p.startsWith('label ')))
  const y = second + 2 // under the second block's column names and the rule under them
  expect(lines[y]).toMatch(/^AgentRelent\s/)
  const lay = cardLayout(WHO, 46, -1)
  const i = lay.hit(lines[y]!.indexOf('20:10:06'), y)
  expect(lay.items[i]!.label).toBe('AgentRelent · last (UTC)')
  expect(lay.hit(0, y)).toBe(0) // the name there is the row's, as in the first block
  // rows have no hover state: the cell under the pointer alone, in inverse
  const lit = cardLayout(WHO, 46, i).lines.map(l => l.some(s => s.inv))
  expect(lit.filter(Boolean).length).toBe(1)
})

// ------------------------------------------------------------------------------------------------ round 3: whole names

// the audit's tables at 120 columns: label names as this corpus writes them, pairs of them, small counts under long
// headers, a blank cell in a column of numbers
const PAIRS: CardData = {
  ...BAR,
  id: 'pa1rs0',
  kind: 'table',
  params: [],
  question: 'Which label pairs write to the most of the same pages?',
  columns: ['pair', 'shared pages', 'median minutes apart'],
  rows: [
    ['OpenAIResearchSec2028 + OurMassFinal', 9, 20.6], ['MapHelper + ResearchHelper', 9, 63.1], ['MapHelper + OpenAIResearchSec2028', 8, 20],
    ['MassUpdater + OurMassFinal', 8, 25], ['AgentSECCountyLinker99172 + OAIHelperSec', 8, 30.4], ['AgentSECCountyLinker99172 + MapHelper', 8, 51.2],
    ['AgentTester + MapHelper', 8, 202.9], ['LanguageWatcherNov12 + OpenAIResearchFeb17', 7, 4.7], ['AgentOpenResearch + LanguageWatcherNov12', 7, 4.8],
    ['AgentOpenResearch + OpenAIHelperJun01X', 7, 5.7], ['OpenAIResearchSec2028 + ResearchHelper', 7, 27.6],
    ['AgentSECCountyLinker99172 + OpenAIResearchSec2028', 7, 27.6], ['OpenAIMay31Maids + OpenAIWatcherOct30', 7, 62.6],
  ],
}
const LABELS: CardData = {
  ...BAR,
  id: 'labe1s',
  kind: 'table',
  params: [],
  question: 'For every label on DataUSALanguageSequenceFeb17, its revisions and IP blocks',
  columns: ['label', 'revisions', 'IP block count', 'IP blocks'],
  rows: [
    ['OpenAIResearchFeb17', 3, 3, '20.245, 52.225, 52.238'], ['AgentOpenResearch', 3, 3, '20.62, 40.78, 65.52'], ['OpenAIHelperJun01X', 3, 2, '172.173, 20.69'],
    ['LanguageHelperJul17', 3, 2, '20.12, 52.225'], ['LanguageWatcherNov12', 3, 3, '20.29, 20.9, 23.100'], ['AgentJune21Prep', 2, 2, '20.165, 52.242'],
    ['OpenAIHelperOct20X', 2, 2, '157.55, 20.114'], ['OpenAIResearchSep23Lang', 2, 2, '172.184, 20.225'], ['Sep26ClothingAgent', 1, 1, '52.251'],
    ['OpenAIResearchSep17X', 1, 1, '23.1'],
  ],
}
const FOUR: CardData = {
  ...BAR,
  id: 'f0ur00',
  kind: 'table',
  params: [],
  question: 'How much do the four labels share?',
  columns: ['label', 'revisions', 'pages', 'IP blocks'],
  rows: [['AgentOpenResearch', 28, 21, 21], ['LanguageWatcherNov12', 41, 28, 29], ['OpenAIHelperJun01X', 20, 15, 15], ['OpenAIResearchFeb17', 22, 18, 17], ['two or more of the four', '', 13, '']],
}

test('at the widths a 120-column terminal gives a card, a table breaks no name inside a word, and cuts nothing', () => {
  for (const card of [PAIRS, LABELS, FOUR]) {
    const words = [...card.columns!, ...(card.rows as Cell[][]).flat().map(String)].flatMap(s => s.split(/\s+/)).filter(Boolean)
    for (let cols = 38; cols <= 60; cols++) {
      const lines = plain(card, cols)
      const shown = new Set(lines.join(' ').split(/\s+/))
      expect(words.filter(w => !shown.has(w))).toEqual([])
      expect(lines.join('\n')).not.toContain('…')
      expect(Math.max(...cardLayout(card, cols, -1).lines.map(lineWidth))).toBeLessThanOrEqual(cols)
    }
  }
  // a pair too long for its column goes on with "+ name" on the next line
  const pairs = plain(PAIRS, 44)
  const at = pairs.findIndex(l => /^OpenAIResearchSec2028 +9 +20\.6$/.test(l))
  expect(pairs[at + 1]!.trim()).toBe('+ OurMassFinal')
  expect(pairs.filter(l => l.startsWith('pair ')).length).toBe(1)
  // the side thread's card: every label whole beside its counts, the IP blocks in a block of their own
  const labels = plain(LABELS, 40)
  expect(labels.some(l => /^OpenAIResearchSep23Lang +2 +2$/.test(l))).toBe(true)
  expect(labels.filter(l => l.startsWith('label ')).length).toBe(2)
  // small counts under long headers sit a column apart rather than break a name or take a block; a blank cell leaves
  // its column right-aligned
  const four = plain(FOUR, 44)
  expect(four.filter(l => l.startsWith('label ')).length).toBe(1)
  expect(four.some(l => /^LanguageWatcherNov12 +41 +28 +29$/.test(l))).toBe(true)
  expect(four.some(l => /^OpenAIResearchFeb17 +22 +18 +17$/.test(l))).toBe(true)
})

test('a table card in a side thread at a 120-column terminal fits the panel: every column shown, nothing cut', async ($, on) => {
  const w = world(on)
  w.files.set(`${CWD}/.thimble-cc-mod/cards/wh0ed1.json`, JSON.stringify(WHO))
  const turn = { q: 'who else edited this page in the ten minutes around this revision?', a: 'These labels:\n\n[[card:wh0ed1]]', state: 'done', tools: 2, partial: '' }
  const saved = { id: 'twho', label: 'the welcome page', ref: '', context: '', engine: 'fork', turns: [turn], file: '.thimble-cc-mod/threads/twho.md' }
  w.files.set(`${CWD}/.thimble-cc-mod/threads/twho.json`, JSON.stringify(saved))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const PANE = { plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 120, rows: 50 }, props: { bodyColumns: 48, bodyRows: 46 } } as never
  await $.command.run({ command: 'thimble-threads', args: '' } as never)
  let pane = (await $.ui.mount(PANE)) as unknown as M
  await pane.press({ key: 'thread-open:twho' })
  await pane.unmount()
  pane = (await $.ui.mount(PANE)) as unknown as M
  const card = (await pane.find({ type: 'Client', key: 't1-card-2-wh0ed1' })) as { props: { width: number } } | undefined
  expect(card).toBeDefined()
  await pane.resize({ columns: card!.props.width, rows: 40, in: 't1-card-2-wh0ed1' })
  const drawn = await pane.drawn({ in: 't1-card-2-wh0ed1' })
  expect(Math.max(...lineWidths(drawn))).toBeLessThanOrEqual(card!.props.width)
  const text = shown(drawn)
  for (const h of ['revisions', 'first', 'last', '(UTC)', 'IP /16', 'values', 'AgentRelent', 'ResearchReaderMN', 'Jun18Citations', '20:17:06']) expect(text).toContain(h)
  expect(text.replace(/Who edited.*?…/, '')).not.toContain('…') // only the title, one line, may be cut
  await pane.unmount()
})

// ------------------------------------------------------------------------------------------------ round 8: marks, rows and records

const segsOf = (lines: { s: string }[][]) => lines.map(l => l.map(s => s.s).join(''))

test('a chart with no colour field is one series in the first hue; the bar under the pointer turns the text colour, its label inverse', () => {
  const lay = cardLayout(BAR, 60, -1)
  expect(lay.lines.slice(0, 2).map(l => l.find(s => s.s.includes('█'))!.fg)).toEqual([SERIES[0], SERIES[0]])
  const lit = cardLayout(BAR, 60, 1).lines[1]!
  expect(lit.find(s => s.s.includes('█'))!.fg).toBe(COLORS.text)
  expect(lit[0]).toMatchObject({ s: 'probier', inv: true })
  // a line of one series: the first hue too
  const one: CardData = { ...BAR, kind: 'line', series: [{ name: 'revisions', points: [['2026-06-17', 3], ['2026-06-18', 9], ['2026-06-19', 4]] }] }
  const marks = cardLayout(one, 60, -1).lines.flat().filter(s => /[⠁-⣿]/.test(s.s))
  expect(marks.length).toBeGreaterThan(0)
  expect(new Set(marks.map(s => s.fg))).toEqual(new Set([SERIES[0]]))
})

test('a table card\'s header: the column names bold, a rule under each as wide as its column, the rows right under it', () => {
  const table: CardData = { ...BAR, kind: 'table', columns: ['label', 'revisions', 'pages', 'wikis'], rows: [['AgentRelent', 317, 4, 'dse'], ['AgentMassPointer13', 187, 3, 'dse']] }
  const lay = cardLayout(table, 80, -1)
  const text = segsOf(lay.lines)
  expect(text[0]).toMatch(/^label +revisions {2}pages {2}wikis/)
  expect(lay.lines[0]!.filter(s => s.s.trim()).every(s => s.b)).toBe(true)
  expect(text[1]).toMatch(/^─+ {2}─{9} {2}─{5} {2}─+$/)
  expect(lay.lines[1]!.filter(s => s.s.trim()).every(s => s.fg === COLORS.rule)).toBe(true)
  // each rule as wide as its column: the names start where their rules start
  const starts = (t: string, re: RegExp) => [...t.matchAll(re)].map(m => m.index)
  expect(starts(text[1]!, /─+/g)).toEqual([0, text[0]!.indexOf('revisions'), text[0]!.indexOf('pages') , text[0]!.indexOf('wikis')])
  expect(text[2]).toMatch(/^AgentRelent +317 +4 {2}dse/)
  expect([lay.hit(0, 0), lay.hit(0, 1), lay.hit(0, 2)]).toEqual([-1, -1, 0])
})

test('a timeline: each event\'s time starts at the card\'s edge, under the axis\'s start time; then its ● in the first hue, its words and a blue ↗', () => {
  const card: CardData = {
    ...BAR,
    kind: 'timeline',
    events: [
      { time: '2026-06-18T00:06:00Z', label: 'First revision of the day', ref: 'revisions.jsonl#L3' },
      { time: '2026-06-18T17:15:00Z', label: 'The welcome page is replaced', ref: '' },
      { time: '2026-06-18T23:57:00Z', label: 'Last revision of the day', ref: 'revisions.jsonl#L9' },
    ],
  }
  const lay = cardLayout(card, 70, -1)
  const text = segsOf(lay.lines)
  expect(text[0]).toMatch(/^●─+●─+●$/)
  expect(lay.lines[0]!.filter(s => s.s === '●').map(s => s.fg)).toEqual([SERIES[0], SERIES[0], SERIES[0]])
  expect(text[1]).toMatch(/^18 Jun 00:06 +18 Jun 23:57$/)
  expect(text[2]).toBe('18 Jun 00:06  ● First revision of the day ↗')
  expect(text[3]).toBe('18 Jun 17:15  ● The welcome page is replaced')
  expect(lay.lines[2]!.find(s => s.s === '●')!.fg).toBe(SERIES[0])
  expect(lay.lines[2]!.find(s => s.s === '↗')!.fg).toBe(COLORS.link)
  expect(lay.lines[2]![0]).toMatchObject({ s: '18 Jun 00:06', fg: COLORS.dim })
  // the time under the pointer in inverse
  expect(cardLayout(card, 70, 1).lines[3]![0]).toMatchObject({ s: '18 Jun 17:15', inv: true })
})

test('example records: ● and thimble\'s note, under it the record\'s words in quotation marks and italic, the place right after them; a blank row between', () => {
  const card: CardData = {
    ...BAR,
    kind: 'example',
    examples: [
      { ref: 'revisions.jsonl#L635', quote: 'If any ahead cohort sees R3 or later, PLEASE append state immediately.', note: '00:56. An agent asks agents in other runs to post the next answer.' },
      { ref: 'revisions.jsonl#L10879', quote: 'County year twenty links direct filtered '.repeat(8), note: '17:15. The welcome page is replaced by links.' },
    ],
  }
  const lay = cardLayout(card, 110, -1)
  const text = segsOf(lay.lines)
  expect(text[0]).toBe('● 00:56. An agent asks agents in other runs to post the next answer.')
  expect(lay.lines[0]![0]!.fg).toBe(SERIES[0])
  expect(text[1]).toBe('  "If any ahead cohort sees R3 or later, PLEASE append state immediately."  ↗ revisions.jsonl line 635')
  expect(lay.lines[1]!.find(s => s.s.startsWith('"If'))).toMatchObject({ i: true })
  expect(lay.lines[1]!.find(s => s.s === '↗')!.fg).toBe(COLORS.link)
  expect(lay.lines[1]!.find(s => s.s === 'revisions.jsonl line 635')).toMatchObject({ fg: COLORS.link, u: true })
  expect(text[2]).toBe('')
  // a long quote: three rows at most, its end cut with …", the place on the row under it when it does not fit beside
  const second = text.slice(3)
  expect(second[0]).toBe('● 17:15. The welcome page is replaced by links.')
  expect(second.slice(1, 4).every(t => t.startsWith('  ') && !t.includes('↗'))).toBe(true)
  expect(second[1]!.trimStart().startsWith('"County')).toBe(true)
  expect(second[3]!.endsWith('…"')).toBe(true)
  expect(second[4]).toBe('  ↗ revisions.jsonl line 10879')
  expect(Math.max(...lay.lines.map(lineWidth))).toBeLessThanOrEqual(110)
  // where the place does not fit beside the quote's last row, it takes the row under it
  expect(segsOf(cardLayout(card, 100, -1).lines)[2]).toBe('  ↗ revisions.jsonl line 635')
  // the records hit as theirs, the blank row as none; the place under the pointer in inverse
  expect([lay.hit(0, 0), lay.hit(0, 1), lay.hit(0, 2), lay.hit(0, 3)]).toEqual([0, 0, -1, 1])
  expect(cardLayout(card, 110, 0).lines[1]!.find(s => s.s === 'revisions.jsonl line 635')).toMatchObject({ inv: true })
})
