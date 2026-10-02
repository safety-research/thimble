// The gestures (hooks/gestures.tsx): one set on every target. Click opens the place a target cites (a sentence's first
// citation's, a card's script), double-click puts its citation into the prompt, shift-, ctrl- or middle-click opens a
// side thread, right-click opens the menu.
import type { JsonValue, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

import { blockLayout } from '../hooks/cite'
import { DOUBLE_MS, citationOf, citeText, classify, menuItems, menuLines, onPointer, placeOf, send, targetLabel } from '../hooks/gestures'
import type { PointerEv, Sent, Target } from '../hooks/gestures'
import { parseReply } from '../hooks/lib'
import { COLORS } from '../hooks/paint'

const CWD = '/corpus/wiki'
const CARD = {
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
}
const REPLY = ['[[card:abc123]]', '', 'The wikis differ a lot in size.', '', 'dse has [[13403|card:abc123#revisions/dse]] revisions, see [[pages.jsonl#L3]].'].join('\n')
const MESSAGE = { plugin: 'thimble-cc-mod', component: 'AssistantMessage', requestId: 'm1', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text: REPLY, isFirstOfReply: true } }
const MENU = { plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble-menu', surface: 'terminal', viewport: { columns: 100, rows: 30 }, props: { bodyColumns: 34, bodyRows: 8 } }

type World = { files: Map<string, string>; filled: string[]; opened: string[]; runs: string[]; submitted: string[]; clock: ReturnType<typeof mock.clock> }

function world(on: On, env: Record<string, string> = {}): World {
  mock.env(on, env)
  const clock = mock.clock(on, { now: 1_790_000_000_000 })
  const w: World = { files: new Map([[`${CWD}/.thimble-cc-mod/cards/abc123.json`, JSON.stringify(CARD)]]), filled: [], opened: [], runs: [], submitted: [], clock }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.messages', () => ({ value: [] }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('fs.read', ($, e) => {
    if (e.path.endsWith('/prompt/chat.md')) return { value: '# thimble-cc-mod\nguidance' }
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
    w.runs.push(String(e.argv[1]))
    if (String(e.argv[1]).endsWith('/helper/resolve.py')) {
      const req = JSON.parse(e.init?.stdin ?? '{}') as { items: { id: string; ref: string }[] }
      const out = req.items.map(it => ({ id: it.id, ref: it.ref, kind: 'file', status: 'ok', why: 'resolves', window: [] }))
      return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.fill', ($, e) => {
    w.filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length } as never
  })
  on('prompt.read', () => ({ value: { text: '' } }) as never)
  on('prompt.submit', ($, e) => {
    w.submitted.push(e.text)
    return { text: e.text } as never
  })
  on('agent.spawn', () => ({ model: 'm', agentId: 'agent-1' }))
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: { isOpen: true } } as never
  })
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: ['(the engine row)'] }))
  return w
}

type M = Mounted<'terminal'>

const press = (button: PointerEv['button'], mods: Partial<PointerEv> = {}): PointerEv => ({ type: 'press', button, shift: false, ctrl: false, alt: false, ...mods })

/** A Client's port: what it posted, and a frame clock moved by hand. */
function port() {
  const posts: { gestures?: Sent[] }[] = []
  let timers: { at: number; every: number; fn: () => void; live: boolean }[] = []
  let now = 0
  return {
    posts,
    post: (d: JsonValue) => void posts.push(d as never),
    every: (ms: number, fn: () => void) => {
      const t = { at: now + ms, every: ms, fn, live: true }
      timers.push(t)
      return () => {
        t.live = false
      }
    },
    advance(ms: number) {
      now += ms
      for (let due = timers.find(t => t.live && t.at <= now); due; due = timers.find(t => t.live && t.at <= now)) {
        due.at += due.every
        due.fn()
      }
      timers = timers.filter(t => t.live)
    },
    gestures: () => posts.flatMap(p => p.gestures ?? []).filter((g, i, all) => all.findIndex(x => x.seq === g.seq) === i).map(g => g.gesture).filter(Boolean),
  }
}

// ------------------------------------------------------------------------------------------------ pure

test('each button and modifier makes one gesture, the same on every target', () => {
  expect(classify(press('left'))).toBe('primary')
  expect(classify(press('left'), true)).toBe('cite')
  expect(classify({ ...press('left'), type: 'double' })).toBe('cite')
  expect(classify(press('left', { shift: true }))).toBe('thread')
  expect(classify(press('left', { ctrl: true }))).toBe('thread')
  expect(classify(press('middle'))).toBe('thread')
  expect(classify(press('right'))).toBe('menu')
  expect(classify(press('right', { ctrl: true }))).toBe('thread')
  expect(classify({ ...press('right'), type: 'release' })).toBe(null)
})

test('a target names its citation, the place a click opens and the actions of its menu', () => {
  const script = '.thimble-cc-mod/scripts/by.py'
  const mark: Target = { kind: 'mark', ref: 'card:abc123#revisions/dse', text: '13403', cardId: 'abc123', script }
  const record: Target = { kind: 'record', ref: 'pages.jsonl#L3', text: 'Main', cardId: 'ex1', script }
  const chip: Target = { kind: 'citation', ref: '[[13403|card:abc123#revisions/dse]]' }
  const sentence: Target = { kind: 'sentence', text: 'The wikis differ   a lot.' }
  const card: Target = { kind: 'card', cardId: 'abc123', text: 'Which wikis?', script }
  expect(citeText(mark)).toBe('[[13403|card:abc123#revisions/dse]]')
  expect(citeText(chip)).toBe('[[13403|card:abc123#revisions/dse]]')
  expect(citeText(sentence)).toBe('"The wikis differ a lot."')
  expect(citeText(card)).toBe('[[card:abc123]]')
  expect(citationOf({ kind: 'node', ref: 'a.md', text: 'x|y' })?.raw).toBe('[[a.md]]')
  // a click opens a place outside the cards, and a citation's place wherever it is
  expect(placeOf(mark)).toBe(null)
  expect(placeOf(record)?.ref).toBe('pages.jsonl#L3')
  expect(placeOf(chip)?.ref).toBe('card:abc123#revisions/dse')
  expect(placeOf(sentence)).toBe(null)
  expect(placeOf({ kind: 'sentence', text: 'dse has [[13403|card:abc123#revisions/dse]] revisions, see [[pages.jsonl#L3]].' })?.ref).toBe('card:abc123#revisions/dse')
  expect(placeOf({ kind: 'row', text: 'dse | [[13403|pages.jsonl#L3]]' })?.ref).toBe('pages.jsonl#L3')
  expect(placeOf(card)).toBe(null)
  expect(menuItems(mark).map(m => m.act)).toEqual(['thread', 'verify', 'script', 'rerun', 'cite'])
  expect(menuItems(record).map(m => m.act)).toEqual(['open', 'thread', 'script', 'rerun', 'cite'])
  expect(menuItems(chip).map(m => m.act)).toEqual(['open', 'thread', 'verify', 'cite'])
  expect(menuItems(sentence).map(m => m.act)).toEqual(['thread', 'cite'])
  expect(menuItems(card).map(m => m.act)).toEqual(['thread', 'script', 'rerun', 'cite'])
  // a card made without a script has nothing to open or rerun
  expect(menuItems({ ...record, script: undefined }).map(m => m.act)).toEqual(['open', 'thread', 'cite'])
})

test('a click acts once no second click follows; a double-click cites and does not open', () => {
  const chip: Target = { kind: 'citation', ref: 'pages.jsonl#L3' }
  const p = port()
  onPointer(chip, { type: 'down', x: 1, y: 0, button: 'left' }, p)
  onPointer(chip, { type: 'up', x: 1, y: 0, button: 'left' }, p)
  expect(p.gestures()).toEqual([])
  p.advance(DOUBLE_MS)
  expect(p.gestures()).toEqual(['primary'])
  p.advance(1000)

  const q = port()
  for (const type of ['down', 'up', 'down', 'up'] as const) onPointer(chip, { type, x: 1, y: 0, button: 'left' }, q)
  q.advance(DOUBLE_MS * 2)
  expect(q.gestures()).toEqual(['cite'])
})

test('right-click opens the menu on its press, or on a release whose press went elsewhere; a later post keeps an earlier gesture', () => {
  const t: Target = { kind: 'sentence', text: 'A passage.' }
  const p = port()
  onPointer(t, { type: 'down', x: 0, y: 0, button: 'right' }, p)
  onPointer(t, { type: 'up', x: 0, y: 0, button: 'right' }, p)
  expect(p.gestures()).toEqual(['menu'])
  // the last post alone carries the press's gesture too, for when the engine delivers only the frame's last post
  expect(p.posts.at(-1)?.gestures?.map(g => g.gesture)).toEqual(['menu', null])
  send(p, { type: 'hover', id: 'x' })
  expect(p.posts.at(-1)?.gestures?.length).toBe(2)
  p.advance(200)
  send(p, { type: 'hover', id: '' })
  expect(p.posts.at(-1)?.gestures?.length).toBe(0)

  const q = port()
  onPointer(t, { type: 'up', x: 0, y: 0, button: 'right' }, q)
  expect(q.gestures()).toEqual(['menu'])
  q.advance(1000)
})

test('a right release that the reflowed transcript puts on another target leaves the menu on the pressed one', () => {
  const record: Target = { kind: 'record', ref: 'pages.jsonl#L3', text: 'Main', cardId: 'ex1' }
  const card: Target = { kind: 'card', ref: 'card:ex1', text: 'Which pages?', cardId: 'ex1' }
  const p = port()
  onPointer(record, { type: 'down', x: 3, y: 4, button: 'right' }, p)
  onPointer(card, { type: 'up', x: 3, y: 4, button: 'right' }, p)
  const sent = p.posts.flatMap(x => x.gestures ?? []).filter((g, i, all) => all.findIndex(y => y.seq === g.seq) === i)
  expect(sent.filter(g => g.gesture === 'menu').map(g => g.target.kind)).toEqual(['record'])
  p.advance(1000)
})

// ------------------------------------------------------------------------------------------------ in a reply

test('a plain paragraph of a reply is a Client: right-click opens the menu, whose cite puts the passage in the prompt', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  expect(await ui.find({ key: 'md-2' })).toBeDefined()
  await ui.pointer({ type: 'down', x: 3, y: 0, button: 'right', in: 'md-2' } as never)
  await ui.pointer({ type: 'up', x: 3, y: 0, button: 'right', in: 'md-2' } as never)
  expect(w.opened).toEqual(['thimble-menu'])
  const menu = (await $.ui.mount(MENU as never)) as unknown as M
  expect(await menu.find({ key: 'menu-thread' })).toBeDefined()
  expect(await menu.find({ key: 'menu-verify' })).toBeUndefined()
  await menu.press({ key: 'menu-cite' })
  expect(w.filled).toEqual(['"The wikis differ a lot in size." '])
  await menu.unmount()
  await ui.unmount()
})

test('double-click pastes the citation, shift-click opens a side thread, a plain click on a passage does nothing', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  for (const type of ['down', 'up', 'down', 'up'] as const) await ui.pointer({ type, x: 3, y: 0, button: 'left', in: 'md-2' } as never)
  expect(w.filled).toEqual(['"The wikis differ a lot in size." '])
  await ui.advance(DOUBLE_MS * 2)
  await ui.pointer({ type: 'down', x: 3, y: 0, button: 'left', in: 'md-2' } as never)
  await ui.advance(DOUBLE_MS * 2)
  expect(w.opened).toEqual([])
  await ui.pointer({ type: 'down', x: 3, y: 0, button: 'left', shift: true, in: 'md-2' } as never)
  expect(w.opened).toEqual(['thimble-thread'])
  expect(w.submitted).toEqual([])
  await ui.unmount()
})

test('a gesture posted from a chip or a mark is handled once: click opens, menu acts on the card', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  const ev = press('left')
  const chip: Sent = { seq: 1, gesture: 'primary', target: { kind: 'citation', ref: 'pages.jsonl#L3' }, ev }
  await ui.post({ type: 'gesture', origin: 'o1', gestures: [chip] } as never, { in: 'para-3' })
  await ui.post({ type: 'hover', id: '', origin: 'o1', gestures: [chip] } as never, { in: 'para-3' })
  expect(w.opened).toEqual(['thimble-cite'])
  const mark: Sent = { seq: 2, gesture: 'menu', target: { kind: 'mark', ref: 'card:abc123#revisions/dse', text: '13403', cardId: 'abc123', script: CARD.source.script }, ev: press('right') }
  await ui.post({ type: 'gesture', origin: 'o1', gestures: [chip, mark] } as never, { in: 'card-1-abc123' })
  expect(w.opened).toEqual(['thimble-cite', 'thimble-menu'])
  const menu = (await $.ui.mount(MENU as never)) as unknown as M
  await menu.press({ key: 'menu-rerun' })
  expect(w.runs).toContain('.thimble-cc-mod/scripts/by.py')
  await menu.unmount()
  await ui.unmount()
})

test('a click on a card opens its script, on a sentence its first citation', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  const click = async (x: number, y: number, inside: string) => {
    await ui.pointer({ type: 'down', x, y, button: 'left', in: inside } as never)
    await ui.pointer({ type: 'up', x, y, button: 'left', in: inside } as never)
    await ui.advance(DOUBLE_MS * 2)
  }
  await click(4, 1, 'card-1-abc123') // the title
  expect(w.opened).toEqual(['thimble-card'])
  await click(1, 0, 'para-3') // "dse", before the first citation
  expect(w.opened).toEqual(['thimble-card', 'thimble-cite'])
  await ui.unmount()
})

test('the menu keeps the pressed target when the release arrives as a menu on another', async ($, on) => {
  world(on)
  on('ui.panes', () => ({ value: [{ id: 'thimble-menu', title: 'Actions', isShown: true, isFocused: true, isPlaced: true }] }) as never)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  const record: Sent = { seq: 1, gesture: 'menu', target: { kind: 'record', ref: 'pages.jsonl#L3', text: 'Main', cardId: 'abc123' }, ev: press('right') }
  const card: Sent = { seq: 2, gesture: 'menu', target: { kind: 'card', ref: 'card:abc123', text: 'Which wikis?', cardId: 'abc123' }, ev: { ...press('right'), type: 'release' } }
  await ui.post({ type: 'gesture', origin: 'o2', gestures: [record, card] } as never, { in: 'card-1-abc123' })
  // the record's menu opens its place; the card's has no such row
  const menu = (await $.ui.mount(MENU as never)) as unknown as M
  expect(await menu.find({ key: 'menu-open' })).toBeDefined()
  await menu.unmount()
  await ui.unmount()
})

test('a hovered citation loses its tip when the pointer moves off it, presses, or the paragraph reflows', async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  const block = parseReply(REPLY).find(b => b.type === 'rich')
  if (block?.type !== 'rich') throw new Error('expected a paragraph with citations')
  const chips = [0, 1].map(() => ({ label: '13403', state: 'link' as const, mark: '', tip: '', spin: false }))
  const x = blockLayout(block, chips, 136, -1).spans[0]!.x0 + 1
  const tip = async () => JSON.stringify(await ui.drawn({ in: 'para-3' })).includes('"position":"absolute"')
  const move = (px: number, py: number) => ui.pointer({ type: 'move', x: px, y: py, in: 'para-3' } as never)
  await move(x, 0)
  expect(await tip()).toBe(true)
  await move(x, 6) // below the paragraph's one line: a move the engine reports while the region holds the pointer
  expect(await tip()).toBe(false)
  await move(x, 0)
  expect(await tip()).toBe(true)
  await ui.pointer({ type: 'down', x, y: 0, button: 'right', in: 'para-3' } as never)
  await ui.pointer({ type: 'up', x, y: 0, button: 'right', in: 'para-3' } as never)
  expect(await tip()).toBe(false)
  await move(x, 0)
  expect(await tip()).toBe(true)
  await ui.resize({ columns: 90, rows: 2, in: 'para-3' })
  expect(await tip()).toBe(false)
  await ui.unmount()
})

test('/thimble-cc-mod debug on turns the mouse log on without the variable', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const r = (await $.command.run({ command: 'thimble-cc-mod', args: 'debug on' } as never)) as { text?: string }
  expect(r.text).toContain('the mouse log is on')
  expect(w.files.get(`${CWD}/.thimble-cc-mod/debug`)).toBe('on\n')
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  await ui.pointer({ type: 'down', x: 3, y: 0, button: 'right', in: 'md-2' } as never)
  expect(w.files.get(`${CWD}/.thimble-cc-mod/mouse.log`)).toContain('"gesture":"menu"')
  await ui.unmount()
  await $.command.run({ command: 'thimble-cc-mod', args: 'debug off' } as never)
  expect(w.files.get(`${CWD}/.thimble-cc-mod/debug`)).toBe('off\n')
})

test('THIMBLE_CC_MOD_DEBUG=1 logs each press and release with its button, modifiers, gesture and target', async ($, on) => {
  const w = world(on, { THIMBLE_CC_MOD_DEBUG: '1' })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  await ui.pointer({ type: 'down', x: 3, y: 0, button: 'left', ctrl: true, in: 'md-2' } as never)
  await ui.pointer({ type: 'up', x: 3, y: 0, button: 'left', in: 'md-2' } as never)
  const log = (w.files.get(`${CWD}/.thimble-cc-mod/mouse.log`) ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, string>)
  expect(log.map(l => [l.event, l.button, l.mods, l.gesture])).toEqual([
    ['press', 'left', 'ctrl', 'thread'],
    ['release', 'left', 'none', 'none'],
  ])
  expect(log[0]?.target).toBe('sentence: "The wikis differ a lot in size."')
  await ui.unmount()
})

test('the menu names its target in the room it has, its quote closed', () => {
  const card: Target = { kind: 'card', ref: 'card:abc123', text: 'Which labels wrote the most revisions on the busiest wiki?', cardId: 'abc123' }
  expect(targetLabel(card, 32)).toBe('card "Which labels wrote the…"')
  const sentence: Target = { kind: 'sentence', text: 'All five of the largest labels wrote only on dse.' }
  expect(targetLabel(sentence, 32)).toBe('"All five of the largest…"')
  expect(targetLabel({ kind: 'sentence', text: 'Short.' }, 32)).toBe('"Short."')
  expect(targetLabel(card, 32).length).toBeLessThanOrEqual(32)
  // a citation shows by its label, never by a ref that names a card's id
  expect(targetLabel({ kind: 'sentence', text: 'dse has [[13403|card:abc123#revisions/dse]] revisions.' })).toBe('"dse has 13403 revisions."')
  expect(targetLabel({ kind: 'citation', ref: '[[card:abc123#revisions/dse]]' })).toBe('card dse')
})

test('the open menu\'s sentence or citation is shaded in its paragraph', () => {
  const block = parseReply('dse has [[13403|card:abc123#revisions/dse]] revisions. The others are small.')[0]
  if (block?.type !== 'rich') throw new Error('expected a paragraph with a citation')
  const chips = [{ label: '13403', state: 'link' as const, mark: '', tip: '', spin: false }]
  const lay = blockLayout(block, chips, 80, -1)
  const raws = ['[[13403|card:abc123#revisions/dse]]']
  const lit = (menu: unknown) => menuLines(lay, raws, menu)[0]!.filter(s => s.bg === COLORS.menu).map(s => s.s).join('')
  expect(lit(null)).toBe('')
  expect(lit({ kind: 'citation', ref: raws[0], text: '13403' })).toBe('13403')
  const second = lit({ kind: 'sentence', text: 'The others are small.' })
  expect(second).toBe('The others are small.')
})

test('a right-click lights its target in the reply while the menu is open', async ($, on) => {
  const w = world(on)
  let panes = [{ id: 'thimble-menu', title: 'Actions', isShown: true, isFocused: true, isPlaced: true }]
  on('ui.panes', () => ({ value: panes }) as never)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  const lit = async () => JSON.stringify(await ui.drawn({ in: 'md-2' })).includes(COLORS.menu)
  expect(await lit()).toBe(false)
  await ui.pointer({ type: 'down', x: 3, y: 0, button: 'right', in: 'md-2' } as never)
  await ui.pointer({ type: 'up', x: 3, y: 0, button: 'right', in: 'md-2' } as never)
  expect(w.opened).toEqual(['thimble-menu'])
  await w.clock.advance(300)
  expect(await lit()).toBe(true)
  panes = [] // closed by a choice or Esc
  await w.clock.advance(300)
  expect(await lit()).toBe(false)
  await ui.unmount()
})
