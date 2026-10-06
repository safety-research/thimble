// The gestures (hooks/gestures.tsx): one set on every target a Client draws. A click (or a double-click, or a
// right-click) opens the place a target cites, or on a card itself a side thread about the card; there is no menu;
// modifier clicks and the middle button make no gesture. A reply's paragraph with citations is a Client (hooks/para.tsx): a click there acts on
// its release, a drag selects and copies. Every view opens in one panel, `thimble`, which shows the view `panelView` names.
import type { JsonValue, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { blockLayout } from '../hooks/cite'
import { citationOf, classify, onPointer, placeOf, send, targetLabel } from '../hooks/gestures'
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

type World = { files: Map<string, string>; filled: string[]; opened: string[]; openArgs: { id: string; columns?: number }[]; opens: { id: string; title?: string; focus?: true; columns?: number }[]; closed: string[]; copied: string[]; toasts: string[]; runs: string[]; submitted: string[]; clock: ReturnType<typeof mock.clock>; placed: boolean; hold: ((path: string) => Promise<void>) | null }

function world(on: On, env: Record<string, string> = {}): World {
  mock.env(on, env)
  const clock = mock.clock(on, { now: 1_790_000_000_000 })
  const w: World = { files: new Map([[`${CWD}/.thimble-cc-mod/cards/abc123.json`, JSON.stringify(CARD)]]), filled: [], opened: [], openArgs: [], opens: [], closed: [], copied: [], toasts: [], runs: [], submitted: [], clock, placed: true, hold: null }
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
  on('fs.stat', async ($, e) => {
    await w.hold?.(e.path)
    if (!w.files.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }
  })
  on('fs.exists', ($, e) => ({ value: w.files.has(e.path) }))
  on('fs.list', ($, e) => ({ value: e.path.endsWith('/reports') ? [...w.files.keys()].filter(p => p.startsWith(`${e.path}/`)).map(p => ({ name: p.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })) : [] }))
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
    w.openArgs.push({ id: e.id, columns: e.columns })
    w.opens.push({ id: e.id, title: e.title, focus: e.focus, columns: e.columns })
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

test('a left or right press, once or twice, is the one action; modifiers and middle make none', () => {
  expect(classify(press('left'))).toBe('primary')
  expect(classify({ ...press('left'), type: 'double' })).toBe('primary')
  // a right-click does what a click does: there is no menu
  expect(classify(press('right'))).toBe('primary')
  expect(classify(press('right', { ctrl: true }))).toBe(null)
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

test('right-click acts as a click on its press, or on a release whose press went elsewhere; a later post keeps an earlier gesture', () => {
  const t: Target = { kind: 'sentence', text: 'A passage.' }
  const p = port()
  onPointer(t, { type: 'down', x: 0, y: 0, button: 'right' }, p)
  onPointer(t, { type: 'up', x: 0, y: 0, button: 'right' }, p)
  expect(p.gestures()).toEqual(['primary'])
  // the last post alone carries the press's gesture too, for when the engine delivers only the frame's last post
  expect(p.posts.at(-1)?.gestures?.map(g => g.gesture)).toEqual(['primary', null])
  send(p, { type: 'hover', id: 'x' })
  expect(p.posts.at(-1)?.gestures?.length).toBe(2)
  p.advance(200)
  send(p, { type: 'hover', id: '' })
  expect(p.posts.at(-1)?.gestures?.length).toBe(0)

  const q = port()
  onPointer(t, { type: 'up', x: 0, y: 0, button: 'right' }, q)
  expect(q.gestures()).toEqual(['primary'])
  q.advance(1000)
})

test('a right release that the reflowed transcript puts on another target leaves the action on the pressed one', () => {
  const record: Target = { kind: 'record', ref: 'pages.jsonl#L3', text: 'Main', cardId: 'ex1' }
  const card: Target = { kind: 'card', ref: 'card:ex1', text: 'Which pages?', cardId: 'ex1' }
  const p = port()
  onPointer(record, { type: 'down', x: 3, y: 4, button: 'right' }, p)
  onPointer(card, { type: 'up', x: 3, y: 4, button: 'right' }, p)
  const sent = p.posts.flatMap(x => x.gestures ?? []).filter((g, i, all) => all.findIndex(y => y.seq === g.seq) === i)
  expect(sent.filter(g => g.gesture === 'primary').map(g => g.target.kind)).toEqual(['record'])
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
  expect(await pane.find({ type: 'Text', text: /^about / })).toBeDefined()
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
  const lit = async () => JSON.stringify(await ui.drawn({ in: 'para-3' })).includes(COLORS.selected)
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
  expect(await pane.find({ type: 'Text', text: /^about / })).toBeDefined()
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

test('a right-click on a citation opens the citation panel, as a click does: there is no menu', async ($, on) => {
  const w = world(on)
  on('ui.panes', () => ({ value: [{ id: 'thimble', title: 'Citation', isShown: true, isFocused: true, isPlaced: true }] }) as never)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  const [, pages] = chipXs()
  await ui.pointer({ type: 'down', x: pages!, y: 0, button: 'right', in: 'para-3' } as never)
  await ui.pointer({ type: 'up', x: pages!, y: 0, button: 'right', in: 'para-3' } as never)
  expect(w.opened).toEqual(['thimble'])
  await ui.unmount()
  const pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(await pane.find({ type: 'Text', text: /pages:3/ })).toBeDefined()
  expect(await pane.find({ key: 'menu-open' })).toBeUndefined()
  expect(await pane.find({ key: 'ask' })).toBeDefined()
  await pane.unmount()
})

test('a gesture posted from a card is handled once: a click on a record opens it, a right-click on a mark asks about it', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  const ev = press('left')
  const record: Sent = { seq: 1, gesture: 'primary', target: { kind: 'record', ref: 'pages.jsonl#L3', text: 'Main', cardId: 'abc123' }, ev }
  await ui.post({ type: 'gesture', origin: 'o1', gestures: [record] } as never, { in: 'card-1-abc123' })
  await ui.post({ type: 'hover', id: '', origin: 'o1', gestures: [record] } as never, { in: 'card-1-abc123' })
  expect(w.opened).toEqual(['thimble'])
  const mark: Sent = { seq: 2, gesture: 'primary', target: { kind: 'mark', ref: 'card:abc123#revisions/dse', text: '13403', cardId: 'abc123', script: CARD.source.script }, ev: press('right') }
  await ui.post({ type: 'gesture', origin: 'o1', gestures: [record, mark] } as never, { in: 'card-1-abc123' })
  // a side thread about the mark replaces the Citation view in the one panel, which stays open
  expect(w.opened).toEqual(['thimble', 'thimble'])
  expect(w.closed).toEqual([])
  const pane = (await $.ui.mount(MENU as never)) as unknown as M
  expect(await pane.find({ key: 'menu-rerun' })).toBeUndefined()
  await pane.unmount()
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
  await click(10, 4) // probier's bar (the top border, the title, the blank row under it, dse's bar): "what was going on here?"
  expect(await ui.find({ type: 'Text', text: /probier {2}1,013/, in: 'card-1-abc123' })).toBeDefined()
  expect(w.opened).toEqual(['thimble'])
  let pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(await pane.find({ type: 'Text', text: /^about / })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /probier: 1,013/ })).toBeDefined()
  await pane.unmount()
  await ui.press({ key: 'card-title:abc123', in: 'card-1-abc123' })
  expect(w.opened).toEqual(['thimble', 'thimble'])
  await click(50, 0) // the frame
  expect(w.opened).toEqual(['thimble', 'thimble', 'thimble'])
  expect(w.filled).toEqual([])
  await ui.unmount()
  pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(await pane.find({ type: 'Text', text: /^about / })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Which wikis have the most revisions\?/ })).toBeDefined()
  // the threads panel's tree holds the three, the latest first; a press shows the bar's again
  await pane.unmount()
  await $.command.run({ command: 'thimble-threads', args: '' } as never)
  pane = (await $.ui.mount(PANEL as never)) as unknown as M
  const rows = (await pane.findAll({ type: 'Button' })).filter(b => /^thread-open:/.test(String((b as { key?: string }).key ?? (b as { props: { key?: string } }).props.key))).map(b => (b as { props: { label?: string } }).props.label ?? '')
  expect(rows).toHaveLength(3)
  expect(rows[2]).toMatch(/probier: 1,013/)
  await pane.unmount()
})

const band = (columns: number) => ({ plugin: 'thimble-cc-mod', component: 'AbovePrompt', requestId: 'above', surface: 'terminal', viewport: { columns, rows: 30 }, props: { hasSurvey: false, view: {} } }) as never

/** A left click on the pages:3 citation of the reply's paragraph with citations. */
async function clickPages($: Engine): Promise<void> {
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  const [, pages] = chipXs()
  await ui.pointer({ type: 'down', x: pages!, y: 0, button: 'left', in: 'para-3' } as never)
  await ui.pointer({ type: 'up', x: pages!, y: 0, button: 'left', in: 'para-3' } as never)
  await ui.unmount()
}

test('the panel a click opened that waits undrawn is offered above the prompt; its button opens it', async ($, on) => {
  const w = world(on)
  let panes = [{ id: 'thimble', title: 'Citation', isShown: false, isFocused: false, isPlaced: false }]
  on('ui.panes', () => ({ value: panes }) as never)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  let above = (await $.ui.mount(band(150))) as unknown as M
  expect(await above.find({ key: 'pending' })).toBeUndefined()
  await above.unmount()
  w.placed = false // the engine leaves an open no person asked for undrawn (another surface's width, a remote client)
  await clickPages($)
  expect(w.opened).toEqual(['thimble'])
  above = (await $.ui.mount(band(150))) as unknown as M
  expect(await above.find({ type: 'Text', text: 'Citation is ready' })).toBeDefined()
  expect(await above.find({ type: 'Button', key: 'pending', text: 'open panel' })).toBeDefined()
  expect(await above.find({ type: 'Button', key: 'pending-x', text: 'dismiss' })).toBeDefined()
  expect(await above.find({ type: 'Text', text: /columns wide/ })).toBeUndefined()
  w.placed = true
  await above.press({ key: 'pending' })
  expect(w.opened).toEqual(['thimble', 'thimble'])
  await above.unmount()
  panes = [{ ...panes[0]!, isShown: true, isPlaced: true }]
  above = (await $.ui.mount(band(150))) as unknown as M
  expect(await above.find({ key: 'pending' })).toBeUndefined()
  await above.unmount()
})

test('below 144 columns a click does not open the panel, even one the person opened before; the row above the prompt does', async ($, on) => {
  const w = world(on)
  let panes: { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }[] = []
  on('ui.panes', () => ({ value: panes }) as never)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  // the row above the prompt measures the terminal while no pane of the mod's is seated
  let above = (await $.ui.mount(band(120))) as unknown as M
  await above.unmount()
  // w.placed stays true: the engine would seat it (its floor is 110 for a pane the person opened before)
  await clickPages($)
  expect(w.opened).toEqual([])
  above = (await $.ui.mount(band(120))) as unknown as M
  expect(await above.find({ type: 'Button', key: 'pending', text: 'open panel' })).toBeDefined()
  await above.press({ key: 'pending' })
  // the person's press opens it, as wide as leaves main 70 columns
  expect(w.openArgs).toEqual([{ id: 'thimble', columns: 49 }])
  await above.unmount()
  panes = [{ id: 'thimble', title: 'Citation', isShown: true, isFocused: true, isPlaced: true }]
  above = (await $.ui.mount(band(120 - 50))) as unknown as M
  expect(await above.find({ key: 'pending' })).toBeUndefined()
  await above.unmount()
  // once the panel is open, a click changes what it shows, at the width measured before it opened
  await clickPages($)
  expect(w.openArgs).toEqual([{ id: 'thimble', columns: 49 }, { id: 'thimble', columns: 49 }])
  const pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(await pane.find({ type: 'Text', text: /pages:3/ })).toBeDefined()
  await pane.unmount()
})

test('the row above the prompt\'s "dismiss" drops a held panel; a wide terminal opens on the click, at 96 columns', async ($, on) => {
  const w = world(on)
  const panes: { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }[] = []
  on('ui.panes', () => ({ value: panes }) as never)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  let above = (await $.ui.mount(band(130))) as unknown as M
  await above.unmount()
  await clickPages($)
  above = (await $.ui.mount(band(130))) as unknown as M
  await above.press({ key: 'pending-x' })
  await above.unmount()
  above = (await $.ui.mount(band(130))) as unknown as M
  expect(await above.find({ key: 'pending' })).toBeUndefined()
  await above.unmount()
  expect(w.opened).toEqual([])
  above = (await $.ui.mount(band(200))) as unknown as M
  await above.unmount()
  await clickPages($)
  expect(w.openArgs).toEqual([{ id: 'thimble', columns: 96 }])
})

/** The panel as the terminal draws it: docked beside main (`main` columns), or inline above the prompt. */
const panel = (main: number, body: number, placement: 'dock' | 'inline' = 'dock') =>
  ({ plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: main, rows: 55 }, props: { bodyColumns: body, bodyRows: 50, placement } }) as never

test('a resize fits the docked panel again: 96 at 200, 49 at 120 so main keeps 70, 96 back at 200', async ($, on) => {
  const w = world(on)
  on('ui.panes', () => ({ value: [{ id: 'thimble', title: 'Citation', isShown: true, isFocused: false, isPlaced: true }] }) as never)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const above = (await $.ui.mount(band(200))) as unknown as M
  await above.unmount()
  await clickPages($)
  expect(w.openArgs).toEqual([{ id: 'thimble', columns: 96 }])
  // each change of width redraws the panel: main's columns, its body and the rule between them make the terminal
  const draw = async (main: number, body: number, placement: 'dock' | 'inline' = 'dock') => {
    const pane = (await $.ui.mount(panel(main, body, placement))) as unknown as M
    await pane.unmount()
    await w.clock.advance(1)
  }
  await draw(103, 96)
  expect(w.opens).toHaveLength(1)
  // narrowed to 120, the engine keeps the panel 95 wide and main 24: it opens again at 49, without the keys
  await draw(24, 95)
  expect(w.opens.slice(1)).toEqual([{ id: 'thimble', title: 'Citation', focus: undefined, columns: 49 }])
  await draw(70, 49)
  expect(w.opens).toHaveLength(2)
  // widened back to 200
  await draw(150, 49)
  expect(w.opens.at(-1)?.columns).toBe(96)
  await draw(103, 96)
  expect(w.opens).toHaveLength(3)
  // a width the person dragged the panel to stays
  await draw(139, 60)
  expect(w.opens).toHaveLength(3)
  // a click opens at the width the terminal has now, not the one measured before the panel opened
  await clickPages($)
  expect(w.openArgs.at(-1)).toEqual({ id: 'thimble', columns: 96 })
  // under 110 the engine seats it inline, at the terminal's width: nothing to fit, and the next open asks for 36
  await draw(100, 96, 'inline')
  expect(w.opens).toHaveLength(4)
  await clickPages($)
  expect(w.openArgs.at(-1)).toEqual({ id: 'thimble', columns: 36 })
})

test('a right-click held below 144 columns keeps its target until the row above the prompt opens its panel', async ($, on) => {
  const w = world(on)
  let panes: { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }[] = []
  on('ui.panes', () => ({ value: panes }) as never)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  let above = (await $.ui.mount(band(120))) as unknown as M
  await above.unmount()
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  const [dse] = chipXs()
  await ui.pointer({ type: 'down', x: dse!, y: 0, button: 'right', in: 'para-3' } as never)
  await ui.pointer({ type: 'up', x: dse!, y: 0, button: 'right', in: 'para-3' } as never)
  await ui.unmount()
  expect(w.opened).toEqual([])
  above = (await $.ui.mount(band(120))) as unknown as M
  expect(await above.find({ type: 'Text', text: 'Citation is ready' })).toBeDefined()
  await above.press({ key: 'pending' })
  await above.unmount()
  panes = [{ id: 'thimble', title: 'Citation', isShown: true, isFocused: true, isPlaced: true }]
  const pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(await pane.find({ key: 'verify' })).toBeDefined()
  await pane.unmount()
})

test('"verify" in the citation panel shows the verification where its result appears, at the bottom', async ($, on) => {
  const w = world(on)
  on('ui.panes', () => ({ value: [{ id: 'thimble', title: 'Citation', isShown: true, isFocused: true, isPlaced: true }] }) as never)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  const [dse] = chipXs()
  await ui.pointer({ type: 'down', x: dse!, y: 0, button: 'right', in: 'para-3' } as never)
  await ui.pointer({ type: 'up', x: dse!, y: 0, button: 'right', in: 'para-3' } as never)
  await ui.unmount()
  let pane = (await $.ui.mount(PANEL as never)) as unknown as M
  await pane.press({ key: 'verify' })
  await pane.unmount()
  expect(w.opened).toEqual(['thimble'])
  expect(w.closed).toEqual([])
  pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(await pane.find({ type: 'Text', text: /^citation/ })).toBeDefined()
  // the verification's state stands where its result appears (this world's kit starts no subagent)
  expect(await pane.find({ type: 'Button', key: 'verify' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /^× failed: could not start a subagent/ })).toBeDefined()
  await pane.unmount()
})

test('/thimble-cc-mod debug on turns the mouse log on without the variable', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const r = (await $.command.run({ command: 'thimble-cc-mod', args: 'debug on' } as never)) as { text?: string }
  expect(r.text).toContain('the mouse log is on')
  expect(w.files.get(`${CWD}/.thimble-cc-mod/debug`)).toBe('on\n')
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  await ui.pointer({ type: 'down', x: 4, y: 1, button: 'right', in: 'card-1-abc123' } as never)
  expect(w.files.get(`${CWD}/.thimble-cc-mod/mouse.log`)).toContain('"button":"right"')
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

test('a target is named in the room it has, its quote closed; a mark by its label', () => {
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

// ------------------------------------------------------------------------------------------------ side threads in the panel

const REPORT_MD = ['# dse holds the edits', '', 'Intro [[13403|card:abc123#revisions/dse]].', '', '<details><summary>How it was counted</summary>', '', 'By a script.', '', '</details>'].join('\n')
const REPORT_JSON = JSON.stringify({ slug: 'doc', form: 'document', title: 'dse holds the edits', request: '', file: '.thimble-cc-mod/reports/doc.md', state: 'ready', tools: 0, partial: '', problems: [], created: 1 })

function withReport(w: World): void {
  w.files.set(`${CWD}/.thimble-cc-mod/reports/doc.md`, REPORT_MD)
  w.files.set(`${CWD}/.thimble-cc-mod/reports/doc.json`, REPORT_JSON)
}

async function showReport($: Engine): Promise<void> {
  await $.command.run({ command: 'thimble-reports', args: '' } as never)
  const list = (await $.ui.mount(PANEL as never)) as unknown as M
  await list.press({ key: 'report-open:doc' })
  await list.unmount()
}

/** The mod's last write of each of its plain state values (not a family's), by key. */
function written(on: On): Map<string, unknown> {
  const last = new Map<string, unknown>()
  on('state.set', ($, e, next) => {
    const x = e as { key: string; id?: string; value: unknown }
    if (x.id === undefined) last.set(x.key, x.value)
    return next(e)
  })
  return last
}

/** A side thread opened as /thimble-ask opens one: its id, and the key of its question field. */
async function newThread($: Engine, state: Map<string, unknown>): Promise<{ id: string; key: string }> {
  await $.command.run({ command: 'thimble-ask', args: '' } as never)
  const pane = (await $.ui.mount(PANEL as never)) as unknown as M
  const key = (await pane.find({ type: 'Input' }))?.key ?? ''
  await pane.unmount()
  return { id: String(state.get('thread') ?? ''), key }
}

test('each side thread has its own question field, so a draft left in one is not sent with the next thread\'s question', async ($, on) => {
  const w = world(on)
  const state = written(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const first = await newThread($, state)
  expect(first.key).toMatch(/^ask-\w+$/)
  let pane = (await $.ui.mount(PANEL as never)) as unknown as M
  await pane.input({ key: first.key, text: 'and summarise the pattern.', kind: 'change' })
  await pane.unmount()
  const second = await newThread($, state)
  expect(second.id).not.toBe(first.id)
  expect(second.key).toMatch(/^ask-\w+$/)
  expect(second.key).not.toBe(first.key)
  // the drawing carries no thread id where an id could be read
  pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(JSON.stringify(await pane.drawn())).not.toContain(second.id)
  await pane.input({ key: second.key, text: 'How many distinct ip16 prefixes wrote on dse?' })
  await pane.unmount()
  const saved = w.files.get(`${CWD}/.thimble-cc-mod/threads/${second.id}.md`) ?? ''
  expect(saved).toContain('How many distinct ip16 prefixes wrote on dse?')
  expect(saved).not.toContain('summarise')
  // the first thread, reopened from the list, has its own field again, the one its draft was typed in
  await $.command.run({ command: 'thimble-threads', args: '' } as never)
  const list = (await $.ui.mount(PANEL as never)) as unknown as M
  await list.press({ key: `thread-open:${first.id}` })
  await list.unmount()
  pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect((await pane.find({ type: 'Input' }))?.key).toBe(first.key)
  await pane.unmount()
})

test('back from a side thread leads to the report the panel showed before it, and after the panel closed, to what it showed last', async ($, on) => {
  const w = world(on)
  const state = written(on)
  withReport(w)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const back = async () => {
    const pane = (await $.ui.mount(PANEL as never)) as unknown as M
    await pane.press({ key: 'nav-back' })
    await pane.unmount()
    return state.get('panelView')
  }
  await showReport($)
  const first = await newThread($, state)
  expect(await back()).toBe('report')
  // closed by the report's own key (x): the way stays
  let pane = (await $.ui.mount(PANEL as never)) as unknown as M
  await pane.press({ key: 'close' })
  await pane.unmount()
  expect(w.closed).toEqual(['thimble'])
  const second = await newThread($, state)
  expect(second.id).not.toBe(first.id)
  expect(await back()).toBe('report')
  // back goes as a browser's does: the report's own way back is the reports list it was opened from
  expect(await back()).toBe('reports')
  pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(await pane.find({ key: 'nav-back' })).toBeUndefined()
  // the first thread stays in the threads tree
  await pane.press({ key: 'threads' })
  await pane.unmount()
  pane = (await $.ui.mount(PANEL as never)) as unknown as M
  await pane.press({ key: `thread-open:${first.id}` })
  await pane.unmount()
  expect(state.get('thread')).toBe(first.id)
})

test('a side thread waits for the report drawing it replaces, two seconds at most; one that settles after it draws the panel once more, so the thread\'s field and buttons work', async ($, on) => {
  const w = world(on)
  const state = written(on)
  const redraws = () => Number(state.get('panelRedraw') ?? 0)
  // real time, in which the engine starts what an act asked for (the test's clock moves only when advanced)
  const tick = () => new Promise<void>(r => (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => unknown }).setTimeout(r, 100))
  withReport(w)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await showReport($)
  const pane = (await $.ui.mount(PANEL as never)) as unknown as M
  // drawings that settle in turn ask for no other
  await pane.press({ key: 'toggle:toggle-1' })
  await w.clock.advance(100)
  expect(redraws()).toBe(0)
  // the report's next drawing waits on its file while the side thread replaces it
  const holdReport = () => {
    let release = () => {}
    let reached = () => {}
    const held = new Promise<void>(r => {
      release = r
    })
    const waiting = new Promise<void>(r => {
      reached = r
    })
    w.hold = path => {
      if (!path.endsWith('/reports/doc.md')) return Promise.resolve()
      reached()
      return held
    }
    return {
      waiting,
      release: () => {
        w.hold = null
        release()
      },
    }
  }
  const replace = async (limit: boolean) => {
    const report = holdReport()
    const toggled = pane.press({ key: 'toggle:toggle-1' })
    await report.waiting
    const asked = $.command.run({ command: 'thimble-ask', args: '' } as never)
    await tick()
    // the command shows the thread a moment after it runs
    const shown = w.clock.advance(10)
    await tick()
    const limited = limit ? w.clock.advance(2000) : Promise.resolve()
    await tick()
    report.release()
    await Promise.all([toggled, asked, shown, limited])
    await w.clock.advance(100)
    expect(JSON.stringify(await pane.drawn())).toContain('about the last answer')
    expect((await pane.find({ type: 'Input' }))?.key).toMatch(/^ask-\w+$/)
  }
  // the thread's drawing waits for the report's to settle, so it settles last and needs no other
  await replace(false)
  expect(redraws()).toBe(0)
  // a report drawing still waiting after two seconds: the thread draws without it, and the panel once more after it
  await pane.press({ key: 'nav-back' })
  await replace(true)
  expect(redraws()).toBe(1)
  await pane.unmount()
})
