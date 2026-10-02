// The gestures (hooks/gestures.tsx): one set on every target a Client draws. A click (or a double-click) opens the place
// a target cites, or on a card itself a side thread about the card; right-click opens the menu; modifier clicks and the
// middle button make no gesture. A reply's paragraph with citations is a Client (hooks/para.tsx): a click there acts on
// its release, a drag selects and copies. Every view opens in one panel, `thimble`, which shows the view `panelView` names.
import type { JsonValue, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

import { blockLayout } from '../hooks/cite'
import { citationOf, classify, menuItems, menuLines, onPointer, placeOf, send, targetLabel } from '../hooks/gestures'
import type { PointerEv, Sent, Target } from '../hooks/gestures'
import { parseReply, sectionsOf } from '../hooks/lib'
import { COLORS } from '../hooks/paint'
import { selectedText } from '../hooks/para'

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
const MENU = { plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 100, rows: 30 }, props: { bodyColumns: 34, bodyRows: 8 } }

type World = { files: Map<string, string>; filled: string[]; opened: string[]; closed: string[]; copied: string[]; toasts: string[]; runs: string[]; submitted: string[]; clock: ReturnType<typeof mock.clock>; placed: boolean }

function world(on: On, env: Record<string, string> = {}): World {
  mock.env(on, env)
  const clock = mock.clock(on, { now: 1_790_000_000_000 })
  const w: World = { files: new Map([[`${CWD}/.thimble-cc-mod/cards/abc123.json`, JSON.stringify(CARD)]]), filled: [], opened: [], closed: [], copied: [], toasts: [], runs: [], submitted: [], clock, placed: true }
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
    return { value: w.placed ? { isPlaced: true } : { isPlaced: false, reason: 'the terminal is too narrow' } } as never
  })
  on('ui.close', ($, e) => {
    w.closed.push(e.id)
    return { value: undefined } as never
  })
  on('ui.copy', ($, e) => {
    w.copied.push(e.text)
    return { value: { isCopied: true } } as never
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(JSON.stringify(e))
    return { value: undefined } as never
  })
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

test('a left press, once or twice, is the one action; right is the menu; modifiers and middle make none', () => {
  expect(classify(press('left'))).toBe('primary')
  expect(classify({ ...press('left'), type: 'double' })).toBe('primary')
  expect(classify(press('right'))).toBe('menu')
  // terminals keep these for their own selection: no gesture, whatever the target
  expect(classify(press('left', { shift: true }))).toBe(null)
  expect(classify(press('left', { ctrl: true }))).toBe(null)
  expect(classify(press('left', { alt: true }))).toBe(null)
  expect(classify(press('middle'))).toBe(null)
  expect(classify({ ...press('right'), type: 'release' })).toBe(null)
  expect(classify({ ...press('left'), type: 'release' })).toBe(null)
})

test('a target names its citation, the place a click opens and the actions of its menu', () => {
  const script = '.thimble-cc-mod/scripts/by.py'
  const mark: Target = { kind: 'mark', ref: 'card:abc123#revisions/dse', text: '13403', cardId: 'abc123', script }
  const record: Target = { kind: 'record', ref: 'pages.jsonl#L3', text: 'Main', cardId: 'ex1', script }
  const chip: Target = { kind: 'citation', ref: '[[13403|card:abc123#revisions/dse]]' }
  const sentence: Target = { kind: 'sentence', text: 'The wikis differ   a lot.' }
  const card: Target = { kind: 'card', cardId: 'abc123', text: 'Which wikis?', script }
  expect(citationOf(mark)?.raw).toBe('[[13403|card:abc123#revisions/dse]]')
  expect(citationOf(chip)?.raw).toBe('[[13403|card:abc123#revisions/dse]]')
  expect(citationOf(card)?.raw).toBe('[[card:abc123]]')
  expect(citationOf({ kind: 'node', ref: 'a.md', text: 'x|y' })?.raw).toBe('[[a.md]]')
  // a click opens a place outside the cards, and a citation's place wherever it is
  expect(placeOf(mark)).toBe(null)
  expect(placeOf(record)?.ref).toBe('pages.jsonl#L3')
  expect(placeOf(chip)?.ref).toBe('card:abc123#revisions/dse')
  expect(placeOf(sentence)).toBe(null)
  // plain words open nothing: only what is drawn as a link opens a panel
  expect(placeOf({ kind: 'row', text: 'dse | [[13403|pages.jsonl#L3]]' })).toBe(null)
  expect(placeOf(card)).toBe(null)
  // no menu has a "cite": nothing fills main's prompt
  expect(menuItems(mark).map(m => m.act)).toEqual(['thread', 'verify', 'script', 'rerun'])
  expect(menuItems(record).map(m => m.act)).toEqual(['open', 'thread', 'script', 'rerun'])
  expect(menuItems(chip).map(m => m.act)).toEqual(['open', 'thread', 'verify'])
  expect(menuItems(card).map(m => m.act)).toEqual(['thread', 'script', 'rerun'])
  // a card made without a script has nothing to open or rerun
  expect(menuItems({ ...record, script: undefined }).map(m => m.act)).toEqual(['open', 'thread'])
})

test('a click acts at once, a double-click is the same action; a modifier or middle click posts no gesture', () => {
  const chip: Target = { kind: 'citation', ref: 'pages.jsonl#L3' }
  const p = port()
  onPointer(chip, { type: 'down', x: 1, y: 0, button: 'left' }, p)
  expect(p.gestures()).toEqual(['primary'])
  onPointer(chip, { type: 'up', x: 1, y: 0, button: 'left' }, p)
  expect(p.gestures()).toEqual(['primary'])
  p.advance(1000)

  const q = port()
  for (const type of ['down', 'up', 'down', 'up'] as const) onPointer(chip, { type, x: 1, y: 0, button: 'left' }, q)
  expect(q.gestures()).toEqual(['primary', 'primary'])
  q.advance(1000)

  const r = port()
  onPointer(chip, { type: 'down', x: 1, y: 0, button: 'left', shift: true }, r)
  onPointer(chip, { type: 'down', x: 1, y: 0, button: 'left', ctrl: true }, r)
  onPointer(chip, { type: 'down', x: 1, y: 0, button: 'left', alt: true }, r)
  onPointer(chip, { type: 'down', x: 1, y: 0, button: 'middle' }, r)
  expect(r.gestures()).toEqual([])
  r.advance(1000)
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

/** The cells of the paragraph with citations (para-3) where its citations are drawn: [13403, pages:3]. */
function chipXs(): number[] {
  const block = parseReply(REPLY).find(b => b.type === 'rich')
  if (block?.type !== 'rich') throw new Error('expected a paragraph with citations')
  const chips = [0, 1].map(() => ({ label: '13403', state: 'link' as const, mark: '', tip: '', spin: false }))
  return blockLayout(block, chips, 136, -1).spans.map(s => s.x0 + 1)
}

const PANEL = { ...MENU, props: { bodyColumns: 96, bodyRows: 28 } }

test('a plain paragraph is the engine\'s Markdown with an "ask ›" shown on hover; one with citations is a Client of para.tsx', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  expect(await ui.find({ type: 'Markdown', text: 'The wikis differ a lot in size.' })).toBeDefined()
  const para = (await ui.find({ key: 'para-3' })) as { type: string; props: { module: string; props: { raws: string[] } } }
  expect(para.type).toBe('Client')
  expect(para.props.module).toMatch(/para\.tsx$/)
  expect(para.props.props.raws).toEqual(['[[13403|card:abc123#revisions/dse]]', '[[pages.jsonl#L3]]'])
  // the paragraph's "ask ›" opens a side thread about it, as the person's own press
  expect(await ui.find({ key: 'ask-md:2-0' })).toBeDefined()
  await ui.press({ key: 'ask-md:2-0' })
  expect(w.opened).toEqual(['thimble'])
  expect(w.filled).toEqual([])
  await ui.unmount()
  const pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(await pane.find({ type: 'Text', text: /side thread about/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /The wikis differ a lot in size/ })).toBeDefined()
  await pane.unmount()
})

test('a reply with no citation is the engine\'s Markdown, a paragraph and its code block one "?" each, shown on hover; elsewhere the engine draws it alone', async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const text = 'Run it like this:\n\n```sh\npython3 count.py --wiki dse\n\npython3 count.py --wiki en\n```\n\nThat prints one line.'
  const ui = (await $.ui.mount({ ...MESSAGE, requestId: 'm2', props: { text, isFirstOfReply: true } } as never)) as unknown as M
  expect(await ui.find({ type: 'Client' })).toBeUndefined()
  expect(await ui.find({ type: 'Markdown', text: 'Run it like this:' })).toBeDefined()
  // a blank line inside a fence does not cut it
  expect(await ui.find({ type: 'Markdown', text: '```sh\npython3 count.py --wiki dse\n\npython3 count.py --wiki en\n```' })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: 'That prints one line.' })).toBeDefined()
  expect((await ui.findAll({ type: 'Button' })).map(b => (b as { props: { label?: string } }).props.label)).toEqual(['?', '?', '?'])
  // each in its block's own margin, in the row's flow (a press reaches it), hidden until the pointer is on the block;
  // the reply's ⏺ in the first block's margin
  const hidden = JSON.stringify(await ui.find({ key: 'md-1-0' }))
  expect(hidden).toContain('"display":"none"')
  expect(hidden).not.toContain('"position":"absolute"')
  expect(hidden).toContain('⏺')
  expect(JSON.stringify(await ui.find({ key: 'md-3-0' }))).not.toContain('⏺')
  await ui.unmount()
  const vs = (await $.ui.mount({ ...MESSAGE, requestId: 'm3', surface: 'vscode', props: { text, isFirstOfReply: true } } as never)) as unknown as M
  expect(await vs.find({ type: 'Button' })).toBeUndefined()
  await vs.unmount()
})

test('a click on a citation in a paragraph opens the Citation view on its release, not on its press', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  const [, pages] = chipXs()
  await ui.pointer({ type: 'down', x: pages!, y: 0, button: 'left', in: 'para-3' } as never)
  expect(w.opened).toEqual([]) // the press only starts a click or a drag
  await ui.pointer({ type: 'up', x: pages!, y: 0, button: 'left', in: 'para-3' } as never)
  expect(w.opened).toEqual(['thimble'])
  await ui.unmount()
  const pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(await pane.find({ type: 'Text', text: /pages:3/ })).toBeDefined()
  await pane.unmount()
  expect(w.filled).toEqual([])
  expect(w.submitted).toEqual([])
})

test('a left drag in a paragraph lights the cells it covers and copies their text on release; nothing opens', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  const lit = async () => JSON.stringify(await ui.drawn({ in: 'para-3' })).includes(COLORS.highlight)
  expect(await lit()).toBe(false)
  await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'para-3' } as never)
  await ui.pointer({ type: 'move', x: 6, y: 0, button: 'left', in: 'para-3' } as never)
  expect(await lit()).toBe(true)
  await ui.pointer({ type: 'up', x: 6, y: 0, button: 'left', in: 'para-3' } as never)
  expect(w.copied).toEqual(['dse has'])
  expect(w.toasts.some(t => t.includes('copied 7 characters'))).toBe(true)
  expect(w.opened).toEqual([])
  // the next press clears the selection
  await ui.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: 'para-3' } as never)
  expect(await lit()).toBe(false)
  await ui.unmount()
})

test('a selection offers "ask about this", whose press opens a side thread about the selected words', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  expect(await ui.find({ key: 'sel-ask', in: 'para-3' })).toBeUndefined()
  await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'para-3' } as never)
  await ui.pointer({ type: 'move', x: 6, y: 0, button: 'left', in: 'para-3' } as never)
  // not while the drag goes on
  expect(await ui.find({ key: 'sel-ask', in: 'para-3' })).toBeUndefined()
  await ui.pointer({ type: 'up', x: 6, y: 0, button: 'left', in: 'para-3' } as never)
  expect(await ui.find({ key: 'sel-ask', in: 'para-3' })).toBeDefined()
  expect(w.opened).toEqual([])
  await ui.press({ key: 'sel-ask', in: 'para-3' })
  expect(w.opened).toEqual(['thimble'])
  expect(w.filled).toEqual([])
  await ui.unmount()
  const pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(await pane.find({ type: 'Text', text: /side thread about/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /dse has/ })).toBeDefined()
  await pane.unmount()
})

test('the selected text joins wrapped lines by a space and a table\'s rows by a newline', () => {
  const lines = [[{ s: 'dse has ' }, { s: '13403' }], [{ s: 'revisions, see' }]]
  expect(selectedText(lines, { y0: 0, x0: 4, y1: 1, x1: 8 }, false)).toBe('has 13403 revisions')
  // either direction
  expect(selectedText(lines, { y0: 1, x0: 8, y1: 0, x1: 4 }, false)).toBe('has 13403 revisions')
  const table = [[{ s: 'wiki  revisions' }], [{ s: 'dse   13403' }]]
  expect(selectedText(table, { y0: 0, x0: 0, y1: 1, x1: 10 }, true)).toBe('wiki  revisions\ndse   13403')
})

test('a hovered citation loses its tip when the pointer moves off it, presses, or the paragraph reflows', async ($, on) => {
  world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  const [x] = chipXs()
  const tip = async () => JSON.stringify(await ui.drawn({ in: 'para-3' })).includes('"position":"absolute"')
  const move = (px: number, py: number) => ui.pointer({ type: 'move', x: px, y: py, in: 'para-3' } as never)
  await move(x!, 0)
  expect(await tip()).toBe(true)
  await move(x!, 6) // below the paragraph's one line: a move the engine reports while the region holds the pointer
  expect(await tip()).toBe(false)
  await move(x!, 0)
  expect(await tip()).toBe(true)
  await ui.pointer({ type: 'down', x: x!, y: 0, button: 'right', in: 'para-3' } as never)
  await ui.pointer({ type: 'up', x: x!, y: 0, button: 'right', in: 'para-3' } as never)
  expect(await tip()).toBe(false)
  await move(x!, 0)
  expect(await tip()).toBe(true)
  await ui.resize({ columns: 90, rows: 2, in: 'para-3' })
  expect(await tip()).toBe(false)
  await ui.unmount()
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
  expect(lit({ kind: 'sentence', text: 'The others are small.' })).toBe('The others are small.')
})

test('a right-click on a citation opens the menu view in the panel and lights the citation until the panel shows another view', async ($, on) => {
  const w = world(on)
  on('ui.panes', () => ({ value: [{ id: 'thimble', title: 'Actions', isShown: true, isFocused: true, isPlaced: true }] }) as never)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  const [, pages] = chipXs()
  const lit = async () => JSON.stringify(await ui.drawn({ in: 'para-3' })).includes(COLORS.menu)
  expect(await lit()).toBe(false)
  await ui.pointer({ type: 'down', x: pages!, y: 0, button: 'right', in: 'para-3' } as never)
  await ui.pointer({ type: 'up', x: pages!, y: 0, button: 'right', in: 'para-3' } as never)
  expect(w.opened).toEqual(['thimble'])
  await w.clock.advance(300)
  expect(await lit()).toBe(true)
  // its "open" replaces the menu with the Citation view in the same panel; nothing closes
  const menu = (await $.ui.mount(MENU as never)) as unknown as M
  expect(await menu.find({ type: 'Text', text: /pages:3/ })).toBeDefined()
  await menu.press({ key: 'menu-open' })
  await menu.unmount()
  expect(w.opened).toEqual(['thimble', 'thimble'])
  expect(w.closed).toEqual([])
  await w.clock.advance(300)
  expect(await lit()).toBe(false)
  await ui.unmount()
  const pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(await pane.find({ key: 'menu-open' })).toBeUndefined()
  expect(await pane.find({ key: 'ask' })).toBeDefined()
  await pane.unmount()
})

test('a gesture posted from a card is handled once: a click on a record opens it, the menu acts on the card', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  const ev = press('left')
  const record: Sent = { seq: 1, gesture: 'primary', target: { kind: 'record', ref: 'pages.jsonl#L3', text: 'Main', cardId: 'abc123' }, ev }
  await ui.post({ type: 'gesture', origin: 'o1', gestures: [record] } as never, { in: 'card-1-abc123' })
  await ui.post({ type: 'hover', id: '', origin: 'o1', gestures: [record] } as never, { in: 'card-1-abc123' })
  expect(w.opened).toEqual(['thimble'])
  const mark: Sent = { seq: 2, gesture: 'menu', target: { kind: 'mark', ref: 'card:abc123#revisions/dse', text: '13403', cardId: 'abc123', script: CARD.source.script }, ev: press('right') }
  await ui.post({ type: 'gesture', origin: 'o1', gestures: [record, mark] } as never, { in: 'card-1-abc123' })
  // the menu replaces the Citation view in the one panel, which stays open
  expect(w.opened).toEqual(['thimble', 'thimble'])
  expect(w.closed).toEqual([])
  const menu = (await $.ui.mount(MENU as never)) as unknown as M
  expect(await menu.find({ key: 'menu-cite' })).toBeUndefined()
  // a choice that only runs closes the panel
  await menu.press({ key: 'menu-rerun' })
  expect(w.closed).toEqual(['thimble'])
  expect(w.runs).toContain('.thimble-cc-mod/scripts/by.py')
  await menu.unmount()
  await ui.unmount()
})

test('a press on a card\'s title opens a side thread about it in the panel; so does a click on its frame; a click on a bar opens one about the bar', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  await ui.resize({ columns: 100, rows: 12, in: 'card-1-abc123' })
  const title = (await ui.find({ type: 'Button', key: 'card-title:abc123', in: 'card-1-abc123' })) as { props: { label: string; plain?: boolean } } | undefined
  expect(title?.props.label).toBe(CARD.question)
  expect(title?.props.plain).toBe(true)
  const click = async (x: number, y: number, mods: { button?: PointerEv['button']; shift?: boolean; ctrl?: boolean; alt?: boolean } = {}) => {
    await ui.pointer({ type: 'down', x, y, button: 'left', ...mods, in: 'card-1-abc123' } as never)
    await ui.pointer({ type: 'up', x, y, button: 'left', ...mods, in: 'card-1-abc123' } as never)
  }
  // the card leaves a left click on its title row to the Button
  await click(4, 1)
  expect(w.opened).toEqual([])
  for (const mods of [{ shift: true }, { ctrl: true }, { alt: true }, { button: 'middle' as const }]) await click(50, 0, mods)
  expect(w.opened).toEqual([])
  await click(10, 3) // probier's bar (border, title, then the bars): "what was going on here?"
  expect(await ui.find({ type: 'Text', text: /probier: 1013/, in: 'card-1-abc123' })).toBeDefined()
  expect(w.opened).toEqual(['thimble'])
  let pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(await pane.find({ type: 'Text', text: /side thread about/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /probier: 1013/ })).toBeDefined()
  await pane.unmount()
  await ui.press({ key: 'card-title:abc123', in: 'card-1-abc123' })
  expect(w.opened).toEqual(['thimble', 'thimble'])
  await click(50, 0) // the frame
  expect(w.opened).toEqual(['thimble', 'thimble', 'thimble'])
  expect(w.filled).toEqual([])
  await ui.unmount()
  pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(await pane.find({ type: 'Text', text: /side thread about/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Which wikis have the most revisions\?/ })).toBeDefined()
  // the threads list holds the three, the latest first; a press shows the bar's again
  await pane.press({ key: 'threads' })
  await pane.unmount()
  pane = (await $.ui.mount(PANEL as never)) as unknown as M
  const rows = (await pane.findAll({ type: 'Button' })).map(b => (b as { key?: string; props: { label?: string } }).props.label ?? '').filter(l => l !== 'close')
  expect(rows).toHaveLength(3)
  expect(rows[2]).toMatch(/probier: 1013/)
  await pane.unmount()
})

test('the panel a click opened that waits undrawn is offered above the prompt; its button opens it', async ($, on) => {
  const w = world(on)
  let panes = [{ id: 'thimble', title: 'Citation', isShown: false, isFocused: false, isPlaced: false }]
  on('ui.panes', () => ({ value: panes }) as never)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const band = { plugin: 'thimble-cc-mod', component: 'AbovePrompt', requestId: 'above', surface: 'terminal', viewport: { columns: 100, rows: 30 }, props: { hasSurvey: false, view: {} } } as never
  let above = (await $.ui.mount(band)) as unknown as M
  expect(await above.find({ key: 'pending' })).toBeUndefined()
  await above.unmount()
  w.placed = false // the engine leaves an open no person asked for undrawn on a narrow terminal
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  const [, pages] = chipXs()
  await ui.pointer({ type: 'down', x: pages!, y: 0, button: 'left', in: 'para-3' } as never)
  await ui.pointer({ type: 'up', x: pages!, y: 0, button: 'left', in: 'para-3' } as never)
  await ui.unmount()
  expect(w.opened).toEqual(['thimble'])
  above = (await $.ui.mount(band)) as unknown as M
  expect(await above.find({ type: 'Text', text: '▸ Citation is ready' })).toBeDefined()
  expect(await above.find({ type: 'Button', key: 'pending', text: 'open panel' })).toBeDefined()
  expect(await above.find({ type: 'Button', key: 'pending-x', text: 'dismiss' })).toBeDefined()
  expect(await above.find({ type: 'Text', text: /opens by itself in windows 144\+ columns wide/ })).toBeDefined()
  w.placed = true
  await above.press({ key: 'pending' })
  expect(w.opened).toEqual(['thimble', 'thimble'])
  await above.unmount()
  panes = [{ ...panes[0]!, isShown: true, isPlaced: true }]
  above = (await $.ui.mount(band)) as unknown as M
  expect(await above.find({ key: 'pending' })).toBeUndefined()
  await above.unmount()
})

test('the menu keeps the pressed target when the release arrives as a menu on another', async ($, on) => {
  world(on)
  on('ui.panes', () => ({ value: [{ id: 'thimble', title: 'Actions', isShown: true, isFocused: true, isPlaced: true }] }) as never)
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

test('/thimble-cc-mod debug on turns the mouse log on without the variable', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const r = (await $.command.run({ command: 'thimble-cc-mod', args: 'debug on' } as never)) as { text?: string }
  expect(r.text).toContain('the mouse log is on')
  expect(w.files.get(`${CWD}/.thimble-cc-mod/debug`)).toBe('on\n')
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  await ui.pointer({ type: 'down', x: 4, y: 1, button: 'right', in: 'card-1-abc123' } as never)
  expect(w.files.get(`${CWD}/.thimble-cc-mod/mouse.log`)).toContain('"gesture":"menu"')
  await ui.unmount()
  await $.command.run({ command: 'thimble-cc-mod', args: 'debug off' } as never)
  expect(w.files.get(`${CWD}/.thimble-cc-mod/debug`)).toBe('off\n')
})

test('THIMBLE_CC_MOD_DEBUG=1 logs each press and release with its button, modifiers, gesture and target, and what it did', async ($, on) => {
  const w = world(on, { THIMBLE_CC_MOD_DEBUG: '1' })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  await ui.pointer({ type: 'down', x: 50, y: 0, button: 'left', ctrl: true, in: 'card-1-abc123' } as never)
  await ui.pointer({ type: 'up', x: 50, y: 0, button: 'left', in: 'card-1-abc123' } as never)
  const log = (w.files.get(`${CWD}/.thimble-cc-mod/mouse.log`) ?? '').trim().split('\n').map(l => JSON.parse(l) as Record<string, string>)
  expect(log.map(l => [l.event, l.button, l.mods, l.gesture])).toEqual([
    ['press', 'left', 'ctrl', 'none'],
    ['release', 'left', 'none', 'none'],
  ])
  expect(log[0]?.target).toBe('card: card "Which wikis have the most revisions?"')
  // a plain click: the action it ran and the view of the panel it opened follow its press
  await ui.pointer({ type: 'down', x: 50, y: 0, button: 'left', in: 'card-1-abc123' } as never)
  await ui.pointer({ type: 'up', x: 50, y: 0, button: 'left', in: 'card-1-abc123' } as never)
  const more = (w.files.get(`${CWD}/.thimble-cc-mod/mouse.log`) ?? '').trim().split('\n').slice(2).map(l => JSON.parse(l) as Record<string, string>)
  expect(more.map(l => [l.event, l.gesture ?? l.act ?? l.view])).toEqual([
    ['press', 'primary'],
    ['act', 'thread'],
    ['pane', 'thread'],
    ['release', 'none'],
  ])
  expect(more[2]?.result).toBe('placed')
  await ui.unmount()
})

test('the menu names its target in the room it has, its quote closed; a mark by its label', () => {
  const card: Target = { kind: 'card', ref: 'card:abc123', text: 'Which labels wrote the most revisions on the busiest wiki?', cardId: 'abc123' }
  expect(targetLabel(card, 32)).toBe('card "Which labels wrote the…"')
  const sentence: Target = { kind: 'sentence', text: 'All five of the largest labels wrote only on dse.' }
  expect(targetLabel(sentence, 32)).toBe('"All five of the largest…"')
  expect(targetLabel({ kind: 'sentence', text: 'Short.' }, 32)).toBe('"Short."')
  expect(targetLabel(card, 32).length).toBeLessThanOrEqual(32)
  // a citation shows by its label, never by a ref that names a card's id
  expect(targetLabel({ kind: 'sentence', text: 'dse has [[13403|card:abc123#revisions/dse]] revisions.' })).toBe('"dse has 13403 revisions."')
  expect(targetLabel({ kind: 'citation', ref: '[[card:abc123#revisions/dse]]' })).toBe('card dse')
  // a card's mark by what it is called (its label and value), before its bare value
  const mark: Target = { kind: 'mark', ref: 'card:abc123#revisions/dse', text: '13403', cardId: 'abc123', label: 'dse: 13403' }
  expect(targetLabel(mark)).toBe('dse: 13403')
  expect(targetLabel({ ...mark, label: undefined })).toBe('13403')
})

test('a section is its heading and everything up to the next heading of its level or higher; a heading in a fence is none', () => {
  const text = '## Who edits\n\nAgents do.\n\n### Mostly bots\n\nYes.\n\n```md\n## not a heading\n```\n\n## When\n\nAt night.'
  const s = sectionsOf(text)
  expect([...s.keys()]).toEqual(['## Who edits', '### Mostly bots', '## When'])
  expect(s.get('## Who edits')).toBe('## Who edits\n\nAgents do.\n\n### Mostly bots\n\nYes.\n\n```md\n## not a heading\n```')
  expect(s.get('### Mostly bots')).toMatch(/^### Mostly bots[\s\S]*```$/)
  expect(s.get('## When')).toBe('## When\n\nAt night.')
})

test('"ask ›" beside a heading opens a side thread about its whole section, out of main\'s chat', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const text = '## Who edits the wiki\n\nMostly agents, at night.\n\nSome humans too.\n\n## When\n\nAfter midnight.'
  const ui = (await $.ui.mount({ ...MESSAGE, requestId: 'm4', props: { text, isFirstOfReply: true } } as never)) as unknown as M
  await ui.press({ key: 'ask-md:1-0' }) // the heading's
  expect(w.opened).toEqual(['thimble'])
  expect(w.filled).toEqual([])
  await ui.unmount()
  const pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(await pane.find({ type: 'Text', text: /the section "Who edits the wiki"/ })).toBeDefined()
  await pane.unmount()
})

test('a paragraph with citations and a card take the "?" too: the card\'s asks about the card, the paragraph\'s about its words', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  const keys = (await ui.findAll({ type: 'Button', label: '?' })).map(b => (b as { key?: string; props: { key?: string } }).props.key ?? (b as { key?: string }).key)
  expect(keys.some(k => /^ask-para:/.test(k ?? ''))).toBe(true)
  expect(keys.some(k => /^ask-card:/.test(k ?? ''))).toBe(true)
  await ui.press({ key: keys.find(k => /^ask-card:/.test(k ?? ''))! })
  expect(w.opened).toEqual(['thimble'])
  await ui.unmount()
  let pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(await pane.find({ type: 'Text', text: /Which wikis have the most revisions\?/ })).toBeDefined()
  await pane.unmount()
  const again = (await $.ui.mount(MESSAGE as never)) as unknown as M
  await again.press({ key: keys.find(k => /^ask-para:/.test(k ?? ''))! })
  await again.unmount()
  pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(await pane.find({ type: 'Text', text: /dse has/ })).toBeDefined()
  await pane.unmount()
})
