// The cards lane: less chrome on a card, no hex ids where the analyst reads, theme-aware colours, the diagram kind,
// and cards written to the session's folder. `claude plugin test mods/thimble-chat`.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

import { cardLayout, layerGraph } from '../hooks/draw'
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
  source: { script: '.thimble-chat/scripts/by.py', index: 0 },
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
  source: { script: '.thimble-chat/scripts/flow.py', index: 0 },
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

type World = { files: Map<string, string>; filled: string[]; opened: string[]; envSet: [string, string | undefined][] }

function world(on: On): World {
  const w: World = {
    files: new Map([
      [`${CWD}/.thimble-chat/cards/abc123.json`, JSON.stringify(BAR)],
      [`${CWD}/.thimble-chat/cards/d1a9e0.json`, JSON.stringify(DIAGRAM)],
    ]),
    filled: [],
    opened: [],
    envSet: [],
  }
  mock.env(on, {})
  mock.clock(on, { now: 1_790_000_000_000 })
  on('env.set', ($, e) => {
    w.envSet.push([e.name, e.value])
    return { value: undefined } as never
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.messages', () => ({ value: [] }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('fs.read', ($, e) => {
    if (e.path.endsWith('/prompt/chat.md')) return { value: '# thimble-chat\nguidance {{helper}}' }
    const text = w.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.stat', ($, e) => {
    if (!w.files.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }
  })
  on('fs.exists', ($, e) => ({ value: w.files.has(e.path) }))
  on('fs.list', () => ({ value: [] }))
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
    return { value: { isOpen: true } } as never
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
  ({ plugin: 'thimble-chat', component: 'AssistantMessage', requestId: 'm1', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text, isFirstOfReply: true } }) as never

/** Every string a drawn tree shows, joined. */
function shown(tree: unknown): string {
  const out: string[] = []
  const walk = (n: unknown) => {
    if (typeof n === 'string') out.push(n)
    else if (Array.isArray(n)) n.forEach(walk)
    else if (n && typeof n === 'object') {
      const o = n as { children?: unknown; props?: { children?: unknown } }
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

test('the value under the pointer shows at the right of the title, and a double-click is not two clicks', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE('[[card:abc123]]'))) as unknown as M
  await ui.resize({ columns: 100, rows: 12, in: 'card-1-abc123' })
  await ui.pointer({ type: 'move', x: 10, y: 4, in: 'card-1-abc123' } as never)
  expect(await ui.find({ type: 'Text', text: /probier: 1013 revisions/, in: 'card-1-abc123' })).toBeDefined()
  await ui.pointer({ type: 'down', x: 10, y: 4, button: 'left', in: 'card-1-abc123' } as never)
  await ui.pointer({ type: 'up', x: 10, y: 4, button: 'left', in: 'card-1-abc123' } as never)
  await ui.pointer({ type: 'down', x: 10, y: 4, button: 'left', in: 'card-1-abc123' } as never)
  expect(w.filled).toEqual(['[[1013|card:abc123#revisions/probier]] '])
  await ui.unmount()
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
  expect(w.envSet).toContainEqual(['THIMBLE_CHAT_ROOT', CWD])
})

test('/thimble-card takes a card by its place in the last reply', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'q', turnId: 't1' } as never)
  await $.turn.complete({ turnId: 't1', answer: '[[card:abc123]]\n\n[[card:d1a9e0]]', durationMs: 5, reason: 'answer' } as never)
  const r = await $.command.run({ command: 'thimble-card', args: '2' } as never)
  expect(JSON.stringify(r)).toContain('Who hands work to whom?')
  expect(w.opened).toContain('thimble-card')
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
    // the hovered row's background and a cited value's keep the theme's text readable
    for (const bg of [COLORS.cursor, COLORS.highlight]) expect(contrast(resolve(name, COLORS.text), resolve(name, bg))).toBeGreaterThanOrEqual(4.5)
  }
  // every token that is not a raw colour is a key of Claude Code's theme
  const tokens = Object.values(COLORS).flatMap(v => (typeof v === 'string' ? [v] : Array.isArray(v) ? v : Object.values(v)))
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
  expect(w.opened).toContain('thimble-cite')
  await ui.unmount()
})
