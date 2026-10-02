// The cards lane: less chrome on a card, no hex ids where the analyst reads, theme-aware colours, the diagram kind,
// and cards written to the session's folder. `claude plugin test mods/thimble-cc-mod`.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

import { cardLayout, layerGraph, lineWidth, menuShade, shortTimes, width, wrapLabel } from '../hooks/draw'
import type { CardData } from '../hooks/draw'
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
  await ui.pointer({ type: 'move', x: 10, y: 4, in: 'card-1-abc123' } as never)
  expect(await ui.find({ type: 'Text', text: /probier: 1013 revisions/, in: 'card-1-abc123' })).toBeDefined()
  for (const type of ['down', 'up', 'down', 'up']) await ui.pointer({ type, x: 10, y: 4, button: 'left', in: 'card-1-abc123' } as never)
  expect(await ui.find({ type: 'Text', text: /probier: 1013 revisions/, in: 'card-1-abc123' })).toBeDefined()
  // a card value cites the card itself: a click is a side thread about it (twice for a double-click, the one panel);
  // nothing reaches main's prompt
  expect(w.opened).toEqual(['thimble', 'thimble'])
  expect(w.filled).toEqual([])
  await ui.unmount()
})

test('a right-click on a bar names it in the menu by its label and value; the menu has no "cite"', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE('[[card:abc123]]'))) as unknown as M
  await ui.resize({ columns: 100, rows: 12, in: 'card-1-abc123' })
  await ui.pointer({ type: 'down', x: 10, y: 4, button: 'right', in: 'card-1-abc123' } as never)
  await ui.pointer({ type: 'up', x: 10, y: 4, button: 'right', in: 'card-1-abc123' } as never)
  await ui.unmount()
  expect(w.opened).toEqual(['thimble'])
  const menu = (await $.ui.mount({ plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 40, rows: 10 }, props: { bodyColumns: 34, bodyRows: 8 } } as never)) as unknown as M
  expect(await menu.find({ type: 'Text', text: /^probier: 1013/ })).toBeDefined()
  expect(await menu.find({ key: 'menu-verify' })).toBeDefined()
  expect(await menu.find({ key: 'menu-cite' })).toBeUndefined()
  await menu.unmount()
})

test('a card that cannot be drawn is named by its place in the reply, not its id', async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = await $.ui.mount(MESSAGE('[[card:abc123]]\n\nthen\n\n[[card:831a65]]'))
  const err = await ui.find({ type: 'Text', text: /Card 2 cannot be drawn: its card file was not written/ })
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
  await pane.unmount()
})

// ------------------------------------------------------------------------------------------------ colours

const THEMES: Record<string, { bg: string[]; keys: Record<string, string> }> = {
  light: {
    bg: ['#ffffff', '#f6f6f6'],
    keys: { text: 'rgb(0,0,0)', inverseText: 'rgb(255,255,255)', inactive: 'rgb(102,102,102)', subtle: 'rgb(175,175,175)', remember: 'rgb(0,0,255)', permission: 'rgb(87,105,247)', success: 'rgb(44,122,57)', error: 'rgb(171,43,63)', warning: 'rgb(150,108,30)', userMessageBackground: 'rgb(240,240,240)', selectionBg: 'rgb(180,213,255)' },
  },
  'light-daltonized': {
    bg: ['#ffffff', '#f6f6f6'],
    keys: { text: 'rgb(0,0,0)', inverseText: 'rgb(255,255,255)', inactive: 'rgb(102,102,102)', subtle: 'rgb(175,175,175)', remember: 'rgb(51,102,255)', permission: 'rgb(51,102,255)', success: 'rgb(0,102,153)', error: 'rgb(204,0,0)', warning: 'rgb(255,153,0)', userMessageBackground: 'rgb(220,220,220)', selectionBg: 'rgb(180,213,255)' },
  },
  dark: {
    bg: ['#000000', '#1e1e1e', '#282c34'],
    keys: { text: 'rgb(255,255,255)', inverseText: 'rgb(0,0,0)', inactive: 'rgb(153,153,153)', subtle: 'rgb(80,80,80)', remember: 'rgb(177,185,249)', permission: 'rgb(177,185,249)', success: 'rgb(78,186,101)', error: 'rgb(255,107,128)', warning: 'rgb(255,193,7)', userMessageBackground: 'rgb(55,55,55)', selectionBg: 'rgb(38,79,120)' },
  },
  'dark-daltonized': {
    bg: ['#000000', '#1e1e1e', '#282c34'],
    keys: { text: 'rgb(255,255,255)', inverseText: 'rgb(0,0,0)', inactive: 'rgb(153,153,153)', subtle: 'rgb(80,80,80)', remember: 'rgb(153,204,255)', permission: 'rgb(153,204,255)', success: 'rgb(51,153,255)', error: 'rgb(255,102,102)', warning: 'rgb(255,204,0)', userMessageBackground: 'rgb(55,55,55)', selectionBg: 'rgb(38,79,120)' },
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
      for (const token of [COLORS.text, COLORS.dim, COLORS.link, COLORS.problem, COLORS.ok, COLORS.accent]) {
        expect(contrast(resolve(name, token), bg)).toBeGreaterThanOrEqual(least)
      }
      // inline code keeps Claude Code's own colour for it
      expect(contrast(resolve(name, COLORS.code), bg)).toBeGreaterThanOrEqual(4)
      for (const c of [...SERIES, COLORS.negative]) expect(contrast(c, bg)).toBeGreaterThanOrEqual(3)
    }
    // the hovered row's background, a cited value's and the open menu's target's keep the theme's text readable
    for (const bg of [COLORS.cursor, COLORS.highlight, COLORS.menu]) expect(contrast(resolve(name, COLORS.text), resolve(name, bg))).toBeGreaterThanOrEqual(4.5)
    // the open menu's target stands out from every background of the theme
    for (const bg of t.bg) expect(contrast(resolve(name, COLORS.menu), bg)).toBeGreaterThanOrEqual(1.3)
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
  expect(text.join('\n')).toMatch(/[╭─]+▼[─╮]+/) // an arrow on a target's top border
  expect(text.join('\n')).toContain('▲') // the edge back up from Reviewer to Coder
  expect(text.join('\n')).toContain('assigns')
  expect(text.some(t => /^1 {2}Coder → Reviewer: opens a pull request/.test(t))).toBe(true)
  expect(text.every(t => t.length <= 70)).toBe(true)
  // the box is its node: the Planner, whose ref is a record
  const x = text[box]!.indexOf('Planner')
  expect(lay.hit(x, box)).toBe(0)
  expect(lay.items[0]).toMatchObject({ kind: 'node', open: 'events.jsonl#L3', cite: '[[events.jsonl#L3]]', text: 'Planner' })
  expect(lay.items[1]).toMatchObject({ kind: 'node', open: 'card:d1a9e0#node/c' })
  // an edge's line is its edge, after the nodes
  const arrowRow = text.findIndex(t => t.includes('▼'))
  expect(lay.hit(text[arrowRow]!.indexOf('▼'), arrowRow)).toBeGreaterThanOrEqual(3)
  // the note line is its edge too
  const note = text.findIndex(t => t.startsWith('1  '))
  expect(lay.items[lay.hit(0, note)]).toMatchObject({ label: 'Coder → Reviewer' })
  // hovering a node draws it in the accent colour
  const hot = cardLayout(DIAGRAM, 70, 0)
  expect(hot.lines[box]!.some(s => s.s.includes('Planner') && s.fg === COLORS.accent)).toBe(true)
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
  const arrows = text.find(t => (t.match(/▼/g) ?? []).length === 5)
  expect(arrows).toBeDefined()
  expect(arrows).not.toMatch(/▼▼/)
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
  // border and title, then the drawing: Planner's label on its second row
  const lay = cardLayout(DIAGRAM, 76, -1)
  const row = lay.lines.findIndex(l => l.map(s => s.s).join('').includes('Planner'))
  const col = lay.lines[row]!.map(s => s.s).join('').indexOf('Planner')
  await ui.pointer({ type: 'down', x: col + 2, y: row + 2, button: 'left', in: 'card-1-d1a9e0' } as never)
  await ui.pointer({ type: 'up', x: col + 2, y: row + 2, button: 'left', in: 'card-1-d1a9e0' } as never)
  expect(w.opened).toEqual(['thimble']) // the Citation view, at once: a click waits for no second one
  await ui.unmount()
})

// ------------------------------------------------------------------------------------------------ round 4: menu shading, dense diagrams

test('the open menu\'s mark is shaded in the menu colour: a bar\'s row, a table\'s row, a diagram\'s box', () => {
  const lit = (lines: { s: string; bg?: string }[][]) => lines.map(l => l.filter(s => s.bg === COLORS.menu).map(s => s.s).join(''))
  const bars = menuShade(cardLayout(BAR, 60, 1), 1)
  expect(lit(bars)[0]).toBe('')
  expect(lit(bars)[1]).toContain('probier')
  const table: CardData = { ...BAR, kind: 'table', columns: ['wiki', 'revisions'], rows: [['dse', 13403], ['probier', 1013]] }
  const rows = menuShade(cardLayout(table, 60, 2), 2) // the second row's first cell
  expect(lit(rows)[3]).toContain('probier')
  expect(rows.flat().some(s => s.bg === COLORS.cursor)).toBe(false)
  const nodes = menuShade(cardLayout(DIAGRAM, 70, 0), 0)
  const box = nodes.findIndex(l => l.map(s => s.s).join('').includes('Planner'))
  expect(lit(nodes)[box]).toContain('Planner')
  expect(lit(nodes).filter(Boolean).length).toBe(3) // the box's three rows, nothing else
  expect(menuShade(cardLayout(BAR, 60, -1), -1).flat().some(s => s.bg === COLORS.menu)).toBe(false)
})

test('a right-click on a card shades its title while the menu is open', async ($, on) => {
  const w = world(on)
  let panes = [{ id: 'thimble', title: 'Actions', isShown: true, isFocused: true, isPlaced: true }]
  on('ui.panes', () => ({ value: panes }) as never)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE('[[card:d1a9e0]]'))) as unknown as M
  await ui.resize({ columns: 80, rows: 30, in: 'card-1-d1a9e0' })
  const lit = async () => JSON.stringify(await ui.drawn({ in: 'card-1-d1a9e0' })).includes(COLORS.menu)
  expect(await lit()).toBe(false)
  await ui.pointer({ type: 'down', x: 4, y: 1, button: 'right', in: 'card-1-d1a9e0' } as never)
  await ui.pointer({ type: 'up', x: 4, y: 1, button: 'right', in: 'card-1-d1a9e0' } as never)
  await w.clock!.advance(300)
  expect(await lit()).toBe(true)
  panes = [] // closed by its button
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
  expect(text(table, 116)[2]).toContain(first)
  const wrapped = cardLayout(table, 40, -1)
  expect(text(table, 40).slice(2, 4).join(' ')).toContain('audit log')
  expect([wrapped.hit(0, 2), wrapped.hit(0, 3), wrapped.hit(0, 4)]).toEqual([0, 0, 2])
  const note = 'Agent posts a note to the other agents about splitting the edit work before the deadline'
  const ex: CardData = { ...BAR, kind: 'example', examples: [{ ref: 'wiki/revisions.jsonl#L12345', quote: 'the quote', note }] }
  expect(text(ex, 116).join(' ')).toContain(note)
  expect(text(ex, 116).join(' ')).toContain('wiki/revisions.jsonl#L12345')
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
    expect(text).toMatch(/00 +23/)
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
  const room = 70 - 1 - 4 // the panel's body, less a column at its right and the reply's margin
  const card = (await pane.find({ type: 'Client', key: 't1-card-2-g4bars' })) as { props: { width: number; props: { cols: number } } } | undefined
  expect(card?.props.width).toBe(room)
  expect(card?.props.props.cols).toBe(room)
  // drawn at the width the panel gives it, as the engine lays the Client out
  await pane.resize({ columns: card!.props.width, rows: 20, in: 't1-card-2-g4bars' })
  const widths = lineWidths(await pane.drawn({ in: 't1-card-2-g4bars' }))
  expect(widths.length).toBeGreaterThan(4)
  expect(shown(await pane.drawn({ in: 't1-card-2-g4bars' }))).toContain('help agents posting notes')
  expect(Math.max(...widths)).toBeLessThanOrEqual(room - 4) // its border and padding
  await pane.unmount()
})
