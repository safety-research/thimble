// The panel's way (hooks/nav.ts): the breadcrumb at its top, back, and the side threads as a tree. A citation or a
// thread opened from inside the panel keeps what the panel showed one step back; a follow-up asked from a citation goes
// on in the thread it was opened from; a thread asked from a thread hangs under it.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { backTarget, crumbSteps, fitCrumbs, moved, nextTrail, threadState, threadTitle, threadTree, unread, withBack } from '../hooks/nav'
import { isAnchor, newsOf, parseSignals, signalEnd, signalQuestion, signalRead, signalsJson, withSignal } from '../hooks/signal'
import type { ChatNavStep, ChatThread } from '../types'

const CWD = '/corpus/wiki'
const PANEL = { plugin: 'thimble-cc-mod', component: 'Pane', requestId: 'thimble', surface: 'terminal', viewport: { columns: 100, rows: 30 }, props: { bodyColumns: 96, bodyRows: 28 } } as const
const REPLY = 'dse has [[13403|card:abc123#revisions/dse]] revisions, see [[pages.jsonl#L3]].'
const MESSAGE = { plugin: 'thimble-cc-mod', component: 'AssistantMessage', requestId: 'm1', surface: 'terminal', viewport: { columns: 140, rows: 40 }, props: { text: REPLY, isFirstOfReply: true } } as const
type M = Mounted<'terminal'>
type El = { type: string; key?: string; props: Record<string, unknown>; children?: unknown[] }

const step = (view: string, more: Partial<ChatNavStep> = {}): ChatNavStep => ({ view, title: view, ...more })
const thread = (id: string, more: Partial<ChatThread> = {}): ChatThread => ({ id, label: `the passage "${id}"`, ref: '', context: '', agentId: '', engine: 'fork', turns: [], file: `.thimble-cc-mod/threads/${id}.md`, ...more })
const turn = (q: string, state = 'done', a = 'An answer.') => ({ q, a, state, tools: 2, partial: '' })

// ------------------------------------------------------------------------------------------------ pure

test('a step from inside the panel extends the trail; from main it starts over, a thread under the threads it was asked from', () => {
  const a = step('thread', { thread: 'ta' })
  const cite = step('cite', { open: 'c1' })
  // from main: the step alone, a thread with its chain
  expect(nextTrail([a], cite, false)).toEqual([cite])
  expect(nextTrail([cite], step('thread', { thread: 'tb' }), false, [a, step('thread', { thread: 'tb' })]).map(s => s.thread)).toEqual(['ta', 'tb'])
  // from inside: extended; a menu is replaced by what it opens; a step already on the trail is cut back to
  expect(nextTrail([a], cite, true)).toEqual([a, cite])
  expect(nextTrail([a, step('menu')], cite, true)).toEqual([a, cite])
  expect(nextTrail([a, cite], { ...a, title: 'again' }, true)).toEqual([{ ...a, title: 'again' }])
  // the threads tree always stands alone, and what it opens does not stand under it
  expect(nextTrail([a, cite], step('threads'), true)).toEqual([step('threads')])
  expect(nextTrail([step('threads')], cite, true)).toEqual([cite])
  // the home panel starts the trail over, however it opens, and what it opens stands after it
  expect(nextTrail([a, cite], step('home'), true)).toEqual([step('home')])
  expect(nextTrail([a], step('home'), false)).toEqual([step('home')])
  expect(nextTrail([step('home')], a, true)).toEqual([step('home'), a])
  expect(nextTrail([step('home'), a], cite, true)).toEqual([step('home'), a, cite])
  // the breadcrumb's first crumb is home: a trail from the home panel names it once
  expect(crumbSteps([step('home'), a])).toEqual({ steps: [a], skipped: 1 })
  expect(crumbSteps([a, cite])).toEqual({ steps: [a, cite], skipped: 0 })
})

test('back goes as a browser\'s does: the trail shown before, else the trail less its last step, else nowhere', () => {
  const a = step('thread', { thread: 'ta' })
  const cite = step('cite', { open: 'c1' })
  let nav = moved({ trail: [], back: [] }, [a])
  nav = moved(nav, [a, cite])
  expect(nav.back).toEqual([[a]])
  expect(backTarget(nav)).toEqual({ trail: [a], back: [] })
  // a trail with no history leads to its step before the last
  expect(backTarget({ trail: [a, cite], back: [] })).toEqual({ trail: [a], back: [] })
  expect(backTarget({ trail: [a], back: [] })).toBe(null)
  // the trail shown now is never where back leads; a menu is never kept, nor a trail twice in a row
  expect(backTarget({ trail: [a], back: [[a], [cite]] })).toEqual({ trail: [cite], back: [[a]] })
  expect(withBack([[a]], [a])).toEqual([[a]])
  expect(withBack([], [step('menu')])).toEqual([])
  expect(withBack([], [a, step('menu')])).toEqual([[a]])
})

test('the breadcrumb fits its room: long crumbs shortened first, then the middle folded into "…", the last kept', () => {
  const wide = (xs: (string | null)[]) => xs.reduce<number>((n, s, i) => n + (s === null ? (xs[i - 1] === null ? 0 : 4) : s.length + (i ? 3 : 0)), 0)
  const labels = ['home', 'thread "why did the agents revert each other at night?"', 'citation pages:3']
  expect(fitCrumbs(labels, 200)).toEqual(['home', 'thread "why did the agents revert…', 'citation pages:3'])
  const mid = fitCrumbs(labels, 45)
  expect(mid[0]).toBe('home')
  expect(mid[2]).toBe('citation pages:3')
  expect(mid[1]).toMatch(/^thread "why.*…$/)
  expect(wide(mid)).toBeLessThanOrEqual(45)
  // the longest is shortened first, whichever it is, so the crumbs end about as long as each other
  const even = fitCrumbs(['home', 'thread "how big is dse?"', 'citation pages:3', 'thread about the citation pages:3'], 72)
  expect(even[2]).toBe('citation pages:3')
  expect(Math.abs(even[1]!.length - even[3]!.length)).toBeLessThanOrEqual(1)
  expect(wide(even)).toBeLessThanOrEqual(72)
  // where 12 columns each would not fit, the crumbs after home fold, oldest first, into one "…"
  const four = ['home', 'Timeline of every source', 'thread "a question asked"', 'record "Tonight\'s release train"']
  const folded = fitCrumbs(four, 40)
  expect(folded[1]).toBe(null)
  expect(folded[2]).toMatch(/^thread "a/)
  expect(folded[3]).toMatch(/^record "/)
  expect(wide(folded)).toBeLessThanOrEqual(40)
  expect(fitCrumbs(four, 26).slice(1, 3)).toEqual([null, null])
})

test('the threads tree: each thread under the one it was asked from, newest first, guides drawn, a cycle broken', () => {
  const rows = threadTree([
    thread('t1', { at: 10 }),
    thread('t2', { at: 50, parent: 't1' }),
    thread('t3', { at: 30 }),
    thread('t4', { at: 20, parent: 't1' }),
    thread('t5', { parent: 'gone', at: 5 }),
  ])
  // t1 holds the newest activity (t2's), so it leads; its children newest first
  expect(rows.map(r => [r.t.id, r.depth, r.guide])).toEqual([
    ['t1', 0, '├─ '],
    ['t2', 1, '│  ├─ '],
    ['t4', 1, '│  └─ '],
    ['t3', 0, '├─ '],
    ['t5', 0, '└─ '],
  ])
  expect(rows[0]!.under).toBe('│  │  ')
  const cycle = threadTree([thread('a', { parent: 'b' }), thread('b', { parent: 'a' })])
  expect(cycle.map(r => r.t.id).sort()).toEqual(['a', 'b'])
})

test('a thread\'s state, unread answers and name', () => {
  expect(threadState(thread('t'))).toEqual({ words: 'nothing asked yet', tone: 'dim' })
  expect(threadState(thread('t', { turns: [turn('q', 'running')] })).words).toBe('answering · 2 tool calls')
  expect(threadState(thread('t', { turns: [turn('q', 'error', 'stopped: by the analyst')] })).words).toBe('stopped · 1 question')
  expect(threadState(thread('t', { turns: [turn('q'), turn('r')] }))).toEqual({ words: 'answered · 2 questions', tone: 'ok' })
  const two = thread('t', { turns: [turn('why [[3|pages.jsonl#L3]]?'), turn('r')] })
  expect(unread(two, 0)).toBe(2)
  expect(unread(two, 2)).toBe(0)
  // an earlier session's thread has no count kept: nothing unread
  expect(unread(two, undefined)).toBe(0)
  expect(threadTitle(two)).toBe('"why 3?"')
  expect(threadTitle(thread('t'))).toBe('about the passage "t"')
})

// ------------------------------------------------------------------------------------------------ in the panel

type World = { files: Map<string, string>; opened: string[]; toasts: string[]; clock: ReturnType<typeof mock.clock> }

function world(on: On): World {
  mock.env(on, {})
  const clock = mock.clock(on, { now: 1_790_000_000_000 })
  const w: World = { files: new Map(), opened: [], toasts: [], clock }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.messages', () => ({ value: [] }) as never)
  on('session.id', () => ({ value: 'session-1' }))
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
  on('fs.list', ($, e) => ({ value: [...w.files.keys()].filter(p => p.startsWith(`${e.path}/`) && !p.slice(e.path.length + 1).includes('/')).map(p => ({ name: p.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })) }))
  on('fs.write', ($, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    if (String(e.argv[1]).endsWith('/helper/resolve.py')) {
      const req = JSON.parse(e.init?.stdin ?? '{}') as { items: { id: string; ref: string }[] }
      const out = req.items.map(it => ({ id: it.id, ref: it.ref, kind: 'lines', file: 'pages.jsonl', start: 3, end: 3, status: 'ok', why: 'resolves', window: [{ n: 3, text: '{"name": "Main"}', hit: true }] }))
      return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.read', () => ({ value: { text: '' } }) as never)
  on('prompt.submit', ($, e) => ({ text: e.text }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.toast', ($, e) => {
    w.toasts.push(String((e as { text?: string }).text ?? JSON.stringify(e)))
    return { value: undefined } as never
  })
  on('ui.log', () => ({ value: undefined }) as never)
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: ['(the engine row)'] }))
  return w
}

/** The mod's last write of each of its plain state values, by key, and of each family's, by key/id. A value the test
 *  seeds (`seed`) is read back as the test or the mod last wrote it. */
function written(on: On): Map<string, unknown> & { seed: (key: string, value: unknown) => void } {
  const last = new Map<string, unknown>()
  const seeded = new Map<string, unknown>()
  on('state.set', ($, e, next) => {
    const x = e as { key: string; id?: string; value: unknown }
    const k = x.id === undefined ? x.key : `${x.key}/${x.id}`
    last.set(k, x.value)
    if (seeded.has(k)) seeded.set(k, x.value)
    return next(e)
  })
  on('state.get', ($, e, next) => {
    const x = e as { key: string; id?: string }
    const k = x.id === undefined ? x.key : `${x.key}/${x.id}`
    return seeded.has(k) ? ({ value: { value: seeded.get(k), version: 1 } } as never) : next(e)
  })
  return Object.assign(last, {
    seed: (key: string, value: unknown) => {
      seeded.set(key, value)
      last.set(key, value)
    },
  })
}

/** A thread saved by an earlier turn of this folder: one question answered with two citations. */
function saved(w: World, id: string, more: Partial<ChatThread> = {}): void {
  w.files.set(`${CWD}/.thimble-cc-mod/threads/${id}.json`, JSON.stringify(thread(id, { label: 'the last answer', turns: [turn('how big is dse?', 'done', REPLY)], ...more })))
}

const keyOf = (b: unknown): string => String((b as El).key ?? (b as El).props?.key ?? '')
const textOf = (x: unknown): string => (typeof x === 'string' ? x : ((x as El).children ?? []).map(textOf).join(''))

/** The panel's column inside its type area (the Box that insets it 1 cell from each edge). */
const column = (x: unknown): El => {
  const el = x as El
  return el.props?.paddingLeft === 1 && (el.children ?? []).length === 1 ? (el.children![0] as El) : el
}

/** The way's row as the terminal draws it: a plain Button as its label (no hotkey shows), a Text as its text. */
async function way(pane: M): Promise<string> {
  const root = column(await pane.drawn())
  const row = (root.children ?? []).find(c => keyOf(c) === 'way') as El | undefined
  return ((row?.children ?? []) as El[]).map(c => (c.type === 'Button' ? `${c.props.hotkey ? `${String(c.props.hotkey)}: ` : ''}${String(c.props.label)}` : textOf(c))).join('')
}

async function press(engine: Engine, key: string): Promise<void> {
  const pane = (await engine.ui.mount(PANEL as never)) as unknown as M
  await pane.press({ key })
  await pane.unmount()
}

/** Open a thread from the tree, as /thimble-threads lists it. */
async function openFromTree(engine: Engine, id: string): Promise<void> {
  await engine.command.run({ command: 'thimble-threads', args: '' } as never)
  await press(engine, `thread-open:${id}`)
}

/** A text row of main's reply, stored as the engine stores it: the latest row a thread's answer is told under. */
async function mainRow(engine: Engine, uuid: string, text = 'An answer of main.'): Promise<void> {
  // the kit stores no row (nothing beneath answers session.append): its rejection is expected
  await engine.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }, door: 'response', origin: { kind: 'model', model: 'm' }, uuid } as never).catch(() => undefined)
}

const ABOVE = { plugin: 'thimble-cc-mod', component: 'AbovePrompt', requestId: 'above', surface: 'terminal', viewport: { columns: 160, rows: 40 }, props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, view: {} } } as const
const messageAt = (requestId: string) => ({ ...MESSAGE, requestId, props: { text: 'An answer of main.', isFirstOfReply: true } })

/** The rows main's reply row `requestId` carries under it, as the terminal reads them: '' when none. */
async function signalLine(engine: Engine, requestId: string, component = 'AssistantMessage'): Promise<string> {
  const ui = (await engine.ui.mount((component === 'AssistantMessage' ? messageAt(requestId) : { ...messageAt(requestId), component, props: { word: 'Baked', durationMs: 3000 } }) as never)) as unknown as M
  const root = (await ui.drawn()) as unknown as El
  await ui.unmount()
  const find = (n: unknown): El | undefined => (keyOf(n) === `signals:${requestId}` ? (n as El) : ((n as El)?.children ?? []).map(find).find(Boolean))
  const box = find(root)
  const line = (r: El) => ((r.children ?? []) as El[]).map(c => (c.type === 'Button' ? String(c.props.label) : textOf(c))).join('')
  return box ? ((box.children ?? []) as El[]).map(line).join('\n') : ''
}

/** The row above the prompt that counts the threads with answers unread, as the terminal reads it: '' when none. */
async function newsLine(engine: Engine): Promise<string> {
  const ui = (await engine.ui.mount(ABOVE as never)) as unknown as M
  const root = (await ui.drawn()) as unknown as El
  await ui.unmount()
  const find = (n: unknown): El | undefined => (keyOf(n) === 'threads-row' ? (n as El) : ((n as El)?.children ?? []).map(find).find(Boolean))
  const row = find(root)
  // its words as read: a Button's label, a Text's text, a Box's children, one space between
  const words = (c: unknown): string[] => (typeof c === 'string' ? [c] : (c as El).type === 'Button' ? [String((c as El).props.label)] : ((c as El).children ?? []).flatMap(words))
  return row ? words(row).join(' ').replace(/\s+/g, ' ').trim() : ''
}

let seq = 0

/** A click on the pages:3 citation of the thread's first answer, as its paragraph's Client posts it. */
async function clickCitationInThread(engine: Engine): Promise<void> {
  const pane = (await engine.ui.mount(PANEL as never)) as unknown as M
  const para = (await pane.findAll({ type: 'Client' })).map(keyOf).find(k => /^t1-para-/.test(k))
  expect(para).toBeDefined()
  const target = { kind: 'citation', ref: '[[pages.jsonl#L3]]' }
  await pane.post({ type: 'gesture', origin: 'thread-para', gestures: [{ seq: ++seq, gesture: 'primary', target, ev: { type: 'press', button: 'left', shift: false, ctrl: false, alt: false } }] } as never, { in: para! })
  await pane.unmount()
}

test('a citation opened from a side thread keeps the thread one step back: the breadcrumb names both and back returns to it', async ($, on) => {
  const w = world(on)
  const state = written(on)
  saved(w, 'tuaaa1')
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await openFromTree($, 'tuaaa1')
  let pane = (await $.ui.mount(PANEL as never)) as unknown as M
  // from the tree: back to it, home, and the thread by its question
  expect(await way(pane)).toMatch(/^‹ back {2}home › thread "how big is dse\?"threads$/)
  await pane.unmount()
  await clickCitationInThread($)
  expect(state.get('panelView')).toBe('cite')
  pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(await way(pane)).toMatch(/^‹ back {2}home › thread "how big is dse\?" › citation pages:3/)
  expect(await pane.find({ type: 'Button', key: 'crumb-1' })).toBeDefined()
  await pane.press({ key: 'nav-back' })
  await pane.unmount()
  expect(state.get('panelView')).toBe('thread')
  expect(state.get('thread')).toBe('tuaaa1')
  // forward again and up by the thread's crumb
  await clickCitationInThread($)
  await press($, 'crumb-1')
  expect(state.get('panelView')).toBe('thread')
  // a click in main starts the breadcrumb over: home › the citation
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  const target = { kind: 'citation', ref: '[[pages.jsonl#L3]]' }
  const para = (await ui.findAll({ type: 'Client' })).map(keyOf).find(k => /^para-/.test(k))
  await ui.post({ type: 'gesture', origin: 'main-para', gestures: [{ seq: 1, gesture: 'primary', target, ev: { type: 'press', button: 'left', shift: false, ctrl: false, alt: false } }] } as never, { in: para! })
  await ui.unmount()
  pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(await way(pane)).toMatch(/^‹ back {2}home › citation pages:3/)
  await pane.unmount()
})

test('"ask about it" in a citation opened from a thread starts a thread under it; the tree draws it as its child', async ($, on) => {
  const w = world(on)
  const state = written(on)
  saved(w, 'tuaaa1', { at: 1 })
  saved(w, 'tuaaa2', { at: 2, label: 'the bar "probier: 1013"', turns: [] })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await openFromTree($, 'tuaaa1')
  await clickCitationInThread($)
  await press($, 'ask')
  const child = String(state.get('thread'))
  expect(child).not.toBe('tuaaa1')
  expect((state.get(`threads/${child}`) as ChatThread).parent).toBe('tuaaa1')
  let pane = (await $.ui.mount(PANEL as never)) as unknown as M
  // home › the first thread › its citation › the new thread, which asks nothing yet
  expect(await way(pane)).toMatch(/home › thread "how big is d.*› citation pages:3 › thread about the cit/)
  await pane.unmount()
  await $.command.run({ command: 'thimble-threads', args: '' } as never)
  pane = (await $.ui.mount(PANEL as never)) as unknown as M
  const rows = (await pane.findAll({ type: 'Button' })).map(keyOf).filter(k => /^thread-open:/.test(k))
  expect(rows).toEqual(['thread-open:tuaaa1', `thread-open:${child}`, 'thread-open:tuaaa2'])
  const text = textOf(await pane.drawn())
  expect(text).toContain('main')
  // a thread asked from a thread hangs under it after └, its state glyph after it
  expect(text).toMatch(/└ ○ /)
  expect(text).toContain('nothing asked yet')
  // picked from the tree, the child stands under its parent in the breadcrumb
  await pane.press({ key: `thread-open:${child}` })
  await pane.unmount()
  pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(await way(pane)).toMatch(/home › thread "how big is dse\?" › thread about the citation pages:3/)
  // the parent lists the threads asked from it
  await pane.press({ key: 'crumb-1' })
  await pane.unmount()
  pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(await pane.find({ type: 'Text', text: /^asked from this thread {2}1$/ })).toBeDefined()
  await pane.press({ key: 'child-0' })
  await pane.unmount()
  expect(state.get('thread')).toBe(child)
})

test('a follow-up asked from a citation goes on in the thread it was opened from, and the panel shows that thread', async ($, on) => {
  const w = world(on)
  const state = written(on)
  saved(w, 'tuaaa1')
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await openFromTree($, 'tuaaa1')
  await clickCitationInThread($)
  let pane = (await $.ui.mount(PANEL as never)) as unknown as M
  const field = (await pane.findAll({ type: 'Input' })).map(keyOf).find(k => /^follow-/.test(k))
  expect(field).toBeDefined()
  // the drawing carries no thread id where an id could be read
  expect(JSON.stringify(await pane.drawn())).not.toContain('tuaaa1')
  await pane.input({ key: field!, text: 'which page is it?' })
  await pane.unmount()
  expect(state.get('panelView')).toBe('thread')
  expect(state.get('thread')).toBe('tuaaa1')
  const t = state.get('threads/tuaaa1') as ChatThread
  expect(t.turns).toHaveLength(2)
  expect(t.turns[1]!.q).toBe('which page is it? (about [[pages.jsonl#L3]])')
  // no new thread: the follow-up stayed in this one
  expect([...state.keys()].filter(k => /^threads\//.test(k))).toEqual(['threads/tuaaa1'])
  pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(await pane.find({ type: 'Text', text: /^"which page is it\? \(about pages:3\)"$/ })).toBeDefined()
  await pane.unmount()
})

test('a thread answers on while the panel shows its citation: its crumb shows it answering, then its unread answer; showing it reads it', async ($, on) => {
  const w = world(on)
  const state = written(on)
  saved(w, 'tuaaa1')
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await mainRow($, 'm1')
  await openFromTree($, 'tuaaa1')
  // a follow-up running, as askThread leaves it once its subagent started (the kit starts none)
  const running = thread('tuaaa1', { label: 'the last answer', agentId: 'agent-7', turns: [turn('how big is dse?', 'done', REPLY), turn('and probier?', 'running')] })
  state.seed('threads/tuaaa1', running)
  state.seed('threadSeen/tuaaa1', 1)
  state.seed('agents/agent-7', { kind: 'thread', label: 'side thread · and probier?', thread: 'tuaaa1' })
  await clickCitationInThread($)
  let pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(await way(pane)).toMatch(/◌ thread "how big is dse\?" › citation pages:3.*threads {2}1 answering$/)
  await pane.unmount()
  // its answer lands while the panel shows the citation: unread, and main's chat gets a row under its latest row
  await $.turn.complete({ turnId: 's7', agentId: 'agent-7', answer: 'probier has [[1013|card:abc123#revisions/probier]].', durationMs: 5, reason: 'answer' } as never)
  expect((state.get('threads/tuaaa1') as ChatThread).turns[1]!.state).toBe('done')
  expect(state.get('threadRows/m1')).toEqual([{ thread: 'tuaaa1', turn: 2 }])
  expect(await signalLine($, 'm1')).toBe('↳ thread · "and probier?" · answered · new')
  expect(w.toasts).toEqual([])
  pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(await way(pane)).toMatch(/thread "how big is dse\?" new › citation pages:3.*threads {2}1 new$/)
  // the tree marks it too
  await pane.press({ key: 'threads' })
  await pane.unmount()
  pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(textOf(await pane.drawn())).toContain('2 questions · about the last answer')
  expect(textOf(await pane.drawn())).toMatch(/Side threads {2}\d+ · 1 new/)
  await pane.press({ key: 'nav-back' })
  await pane.unmount()
  // back on the citation, then on the thread: read
  await press($, 'nav-back')
  expect(state.get('panelView')).toBe('thread')
  expect(state.get('threadSeen/tuaaa1')).toBe(2)
  pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(await way(pane)).not.toContain('new')
  await pane.unmount()
  // the row stays, read
  expect(await signalLine($, 'm1')).toBe('↳ thread · "and probier?" · answered')
})

test('"stop" ends a thread that answers; closing the panel does not', async ($, on) => {
  const w = world(on)
  const state = written(on)
  saved(w, 'tuaaa1')
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await openFromTree($, 'tuaaa1')
  state.seed('threads/tuaaa1', thread('tuaaa1', { turns: [turn('and probier?', 'running')] }))
  await press($, 'close')
  expect((state.get('threads/tuaaa1') as ChatThread | undefined)?.turns[0]!.state ?? 'running').toBe('running')
  await openFromTree($, 'tuaaa1')
  await press($, 'stop')
  const t = state.get('threads/tuaaa1') as ChatThread
  expect(t.turns[0]!.state).toBe('error')
  expect(t.turns[0]!.a).toBe('stopped: stopped by the analyst')
})

// ------------------------------------------------------------------------------------------------ an answer not seen come

test('which rows a thread\'s answer is told under, what its row says, and what signals.json keeps', () => {
  const row = (door: string, type: string, content: unknown, more: Record<string, unknown> = {}) => ({ door, origin: { kind: 'model' }, message: { type, content, ...more } })
  expect(isAnchor(row('response', 'assistant', [{ type: 'text', text: 'An answer.' }]))).toBe(true)
  expect(isAnchor(row('response', 'assistant', [{ type: 'tool_use', id: 'x' }]))).toBe(false)
  expect(isAnchor(row('response', 'assistant', [{ type: 'text', text: '  ' }]))).toBe(false)
  expect(isAnchor({ ...row('prompt', 'user', [{ type: 'text', text: 'why?' }]), origin: { kind: 'composer' } })).toBe(true)
  // a prompt the mod sends (the coverage's) is not drawn as the analyst's
  expect(isAnchor({ ...row('prompt', 'user', [{ type: 'text', text: 'missed' }]), origin: { kind: 'plugin' } })).toBe(false)
  expect(isAnchor(row('notice', 'system', [], { name: 'turn_duration' }))).toBe(true)
  expect(isAnchor(row('notice', 'system', [{ type: 'text', text: 'reloaded' }], { name: 'informational' }))).toBe(false)
  expect(isAnchor(row('command', 'system', [{ type: 'text', text: '<local-command-stdout>ok</local-command-stdout>' }], { name: 'local_command' }))).toBe(true)
  expect(isAnchor(row('command', 'system', [{ type: 'text', text: '<command-name>/x</command-name>' }], { name: 'local_command' }))).toBe(false)
  expect(isAnchor(row('attachment', 'attachment', [{ type: 'text', text: 'x' }]))).toBe(false)

  const t = thread('t', { turns: [turn('why [[3|pages.jsonl#L3]] at night, when every agent of the wiki slept?'), turn('and then?', 'error', 'the subagent ended: max_turns'), turn('stop', 'error', 'stopped: by the analyst'), turn('more', 'running')] })
  expect(signalEnd(t, 1)).toBe('answered')
  expect(signalEnd(t, 2)).toBe('failed')
  expect(signalEnd(t, 3)).toBe(null)
  expect(signalEnd(t, 4)).toBe(null)
  expect(signalQuestion(t, 1, 30)).toBe('"why 3 at night, when every…"')
  expect(signalRead(t, 1, 0)).toBe(false)
  expect(signalRead(t, 1, 1)).toBe(true)
  expect(signalRead(t, 1, undefined)).toBe(false)
  expect(withSignal([{ thread: 't', turn: 1 }], { thread: 't', turn: 1 })).toEqual([{ thread: 't', turn: 1 }])

  const f = parseSignals(signalsJson({ session: 's', last: 'm9', seen: { t: 1 }, rows: { m1: [{ thread: 't', turn: 1 }] } }))
  expect(f).toEqual({ session: 's', last: 'm9', seen: { t: 1 }, rows: { m1: [{ thread: 't', turn: 1 }] } })
  expect(parseSignals('not json')).toEqual({ session: '', last: '', seen: {}, rows: {} })
  expect(parseSignals(JSON.stringify({ seen: { a: -1, b: 'x', c: 2 }, rows: { r: [{ thread: 1 }] } }))).toEqual({ session: '', last: '', seen: { c: 2 }, rows: {} })
  const many = Object.fromEntries(Array.from({ length: 205 }, (_, i) => [`r${i}`, [{ thread: 't', turn: 1 }]]))
  expect(Object.keys(parseSignals(signalsJson({ session: '', last: '', seen: {}, rows: many })).rows)).toHaveLength(200)

  const seen: Record<string, number> = { a: 1, b: 0 }
  expect(newsOf([thread('a', { turns: [turn('q')] }), thread('b', { turns: [turn('q')] }), thread('c', { turns: [turn('q')] })], id => seen[id])).toEqual({ n: 1, one: 'b' })
})

test('a thread the analyst is looking at when it answers gets no row; its answer is read', async ($, on) => {
  const w = world(on)
  const state = written(on)
  saved(w, 'tuaaa1')
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await mainRow($, 'm1')
  await openFromTree($, 'tuaaa1')
  state.seed('threads/tuaaa1', thread('tuaaa1', { label: 'the last answer', agentId: 'agent-7', turns: [turn('how big is dse?', 'done', REPLY), turn('and probier?', 'running')] }))
  state.seed('agents/agent-7', { kind: 'thread', label: 'side thread · and probier?', thread: 'tuaaa1' })
  await $.turn.complete({ turnId: 's7', agentId: 'agent-7', answer: 'probier has 1013 revisions.', durationMs: 5, reason: 'answer' } as never)
  expect(state.get('threadSeen/tuaaa1')).toBe(2)
  expect(state.get('threadRows/m1')).toBeUndefined()
  expect(await signalLine($, 'm1')).toBe('')
  expect(await newsLine($)).toBe('')
})

test('an answer not seen come: one row in main\'s chat at that moment, a count above the prompt; a press on the row opens the thread and clears both marks; main reads only its note', async ($, on) => {
  const w = world(on)
  const state = written(on)
  const tid = 'tuaaa3'
  saved(w, tid, { turns: [] })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  // a thread asked about the last answer, then a citation of main opened before it answers
  await openFromTree($, tid)
  state.seed(`threads/${tid}`, thread(tid, { label: 'the last answer', agentId: 'agent-9', turns: [turn('which agent reverted most?', 'running')] }))
  state.seed(`threadSeen/${tid}`, 0)
  state.seed('agents/agent-9', { kind: 'thread', label: 'side thread · which agent reverted most?', thread: tid })
  await mainRow($, 'm1')
  await mainRow($, 'm2', 'The second block of main.')
  const ui = (await $.ui.mount(MESSAGE as never)) as unknown as M
  const para = (await ui.findAll({ type: 'Client' })).map(keyOf).find(k => /^para-/.test(k))
  await ui.post({ type: 'gesture', origin: 'main-para', gestures: [{ seq: 1, gesture: 'primary', target: { kind: 'citation', ref: '[[pages.jsonl#L3]]' }, ev: { type: 'press', button: 'left', shift: false, ctrl: false, alt: false } }] } as never, { in: para! })
  await ui.unmount()
  expect(state.get('panelView')).toBe('cite')
  expect(await newsLine($)).toBe('')
  await $.turn.complete({ turnId: 's9', agentId: 'agent-9', answer: 'Mercury reverted most: [[41|pages.jsonl#L3]].', durationMs: 5, reason: 'answer' } as never)
  // under main's latest row only
  expect(await signalLine($, 'm1')).toBe('')
  expect(await signalLine($, 'm2')).toBe('↳ thread · "which agent reverted most?" · answered · new')
  expect(await newsLine($)).toBe('threads 1 new')
  // main gets the one note it got before, and nothing else
  const notes = JSON.parse(w.files.get(`${CWD}/.thimble-cc-mod/notes.json`) ?? '{}') as { notes?: string[] }
  expect(notes.notes).toHaveLength(1)
  expect(notes.notes![0]).toMatch(/^thimble-cc-mod: side thread answered/)
  // kept for a resume: the answers seen and the row by the row it stands under
  const kept = parseSignals(w.files.get(`${CWD}/.thimble-cc-mod/signals.json`) ?? '')
  expect(kept.rows.m2).toEqual([{ thread: tid, turn: 1 }])
  // a press on the row: the thread in the panel, read
  const msg = (await $.ui.mount(messageAt('m2') as never)) as unknown as M
  await msg.press({ key: 'signal:m2:0' })
  await msg.unmount()
  expect(state.get('panelView')).toBe('thread')
  expect(state.get('thread')).toBe(tid)
  expect(state.get(`threadSeen/${tid}`)).toBe(1)
  expect(await signalLine($, 'm2')).toBe('↳ thread · "which agent reverted most?" · answered')
  expect(await newsLine($)).toBe('')
  expect(parseSignals(w.files.get(`${CWD}/.thimble-cc-mod/signals.json`) ?? '').seen[tid]).toBe(1)
  // the drawing carries no thread id
  const again = (await $.ui.mount(messageAt('m2') as never)) as unknown as M
  expect(JSON.stringify(await again.drawn())).not.toContain(tid)
  await again.unmount()
})

test('a resumed session keeps the unread marks and the rows: the tree, the count above the prompt and the row under the turn\'s duration', async ($, on) => {
  const w = world(on)
  const state = written(on)
  saved(w, 'tuaaa1', { turns: [turn('how big is dse?', 'done', REPLY), turn('and probier?', 'done', 'probier has 1013.')] })
  saved(w, 'tuaaa2', { at: 2 })
  w.files.set(`${CWD}/.thimble-cc-mod/signals.json`, signalsJson({ session: 'session-1', last: 'd1', seen: { tuaaa1: 1, tuaaa2: 1 }, rows: { d1: [{ thread: 'tuaaa1', turn: 2 }] } }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  expect(state.get('threadSeen/tuaaa1')).toBe(1)
  expect(await newsLine($)).toBe('threads 1 new')
  expect(await signalLine($, 'd1', 'TurnDuration')).toBe('↳ thread · "and probier?" · answered · new')
  await $.command.run({ command: 'thimble-threads', args: '' } as never)
  const pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(textOf(await pane.drawn())).toContain('2 questions · earlier session')
  expect(textOf(await pane.drawn())).toMatch(/Side threads {2}2 · 1 new/)
  // the count above the prompt opens the one thread with news
  await pane.unmount()
  const above = (await $.ui.mount(ABOVE as never)) as unknown as M
  await above.press({ key: 'threads-news' })
  await above.unmount()
  expect(state.get('thread')).toBe('tuaaa1')
  expect(state.get('threadSeen/tuaaa1')).toBe(2)
  expect(await newsLine($)).toBe('')
})

test('an answer that comes before main\'s chat holds a row waits for the next one', async ($, on) => {
  const w = world(on)
  const state = written(on)
  saved(w, 'tuaaa1')
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  state.seed('threads/tuaaa1', thread('tuaaa1', { label: 'the last answer', agentId: 'agent-7', turns: [turn('how big is dse?', 'running')] }))
  state.seed('agents/agent-7', { kind: 'thread', label: 'side thread · how big is dse?', thread: 'tuaaa1' })
  state.seed('threadSeen/tuaaa1', 0)
  await $.turn.complete({ turnId: 's7', agentId: 'agent-7', answer: 'dse has 13403 revisions.', durationMs: 5, reason: 'answer' } as never)
  expect(state.get('threadRows/waiting')).toEqual([{ thread: 'tuaaa1', turn: 1 }])
  await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: '<local-command-stdout>files</local-command-stdout>' }], name: 'local_command' }, door: 'command', origin: { kind: 'engine' }, uuid: 'c1' } as never).catch(() => undefined)
  expect(state.get('threadRows/c1')).toEqual([{ thread: 'tuaaa1', turn: 1 }])
  expect(await signalLine($, 'c1', 'CommandOutput')).toBe('↳ thread · "how big is dse?" · answered · new')
})

// ------------------------------------------------------------------------------------------------ the home panel

type HomeProps = { lines: { s: string }[][]; hits: number[]; stamp: string }
let homeSeq = 0

/** The home panel's lines as plain text, as its Client draws them. */
async function homeText(pane: M): Promise<string[]> {
  const c = (await pane.find({ type: 'Client', key: 'home' })) as unknown as { props: { props: HomeProps } } | undefined
  return (c?.props.props.lines ?? []).map(l => l.map(x => x.s).join('').replace(/\s+$/, ''))
}

/** A click on the first line of the home panel that `re` finds, as its Client posts it. */
async function homeClick(pane: M, re: RegExp): Promise<void> {
  const c = (await pane.find({ type: 'Client', key: 'home' })) as unknown as { props: { props: HomeProps } }
  const { lines, hits, stamp } = c.props.props
  const y = lines.findIndex(l => re.test(l.map(x => x.s).join('')))
  expect(y).toBeGreaterThanOrEqual(0)
  let i = -1
  for (let k = 0; k * 5 < hits.length; k++) {
    if (hits[k * 5] === y) {
      i = k
      break
    }
  }
  expect(i).toBeGreaterThanOrEqual(0)
  await pane.post({ type: 'home', horigin: 'test-home', hacts: [{ seq: ++homeSeq, i, s: stamp }] } as never, { in: 'home' })
}

test('the breadcrumb starts at home: /thimble-home opens it, what it opens stands after it, and back and the first crumb return to it', async ($, on) => {
  const w = world(on)
  const state = written(on)
  saved(w, 'tuaaa1')
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  const said = (await $.command.run({ command: 'thimble-home', args: '' } as never)) as { text?: string }
  expect(said.text).toBe('home · stacked')
  expect(state.get('panelView')).toBe('home')
  let pane = (await $.ui.mount(PANEL as never)) as unknown as M
  // the home panel shown: its crumb alone, regular, no button
  expect(await way(pane)).toBe('homethreads')
  expect(await pane.find({ type: 'Button', key: 'crumb-home' })).toBeUndefined()
  expect((await homeText(pane))[0]).toMatch(/^Home {2}0 views · 0 reports · 1 thread · 0 cards · 0 labels · 0 files +stacked {2}index$/)
  // a thread opened from it stands after home; back returns home
  await homeClick(pane, /"how big is dse\?"/)
  await pane.unmount()
  expect(state.get('panelView')).toBe('thread')
  expect(state.get('thread')).toBe('tuaaa1')
  pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect(await way(pane)).toMatch(/^‹ back {2}home › thread "how big is dse\?"threads$/)
  await pane.press({ key: 'nav-back' })
  await pane.unmount()
  expect(state.get('panelView')).toBe('home')
  // a thread opened from the tree: its first crumb opens home
  await openFromTree($, 'tuaaa1')
  await press($, 'crumb-home')
  expect(state.get('panelView')).toBe('home')
  expect((state.get('nav') as { trail: ChatNavStep[] }).trail.map(s => s.view)).toEqual(['home'])
  // an unknown layout is refused, a known one taken
  expect(((await $.command.run({ command: 'thimble-home', args: 'grid' } as never)) as { text?: string }).text).toBe('no layout "grid": stacked or index')
  expect(((await $.command.run({ command: 'thimble-home', args: 'index' } as never)) as { text?: string }).text).toBe('home · index')
})

test('with several threads holding new answers, the row above the prompt opens home, its threads unfolded, those with new answers first', async ($, on) => {
  const w = world(on)
  const state = written(on)
  saved(w, 'tuaaa1', { at: 1 })
  saved(w, 'tuaaa2', { at: 3, turns: [turn('and probier?', 'done', 'probier has 1013.')] })
  saved(w, 'tuaaa3', { at: 2, turns: [turn('who reverted most?', 'done', 'Mercury.')] })
  w.files.set(`${CWD}/.thimble-cc-mod/signals.json`, signalsJson({ session: 'session-1', last: '', seen: { tuaaa1: 0, tuaaa2: 0, tuaaa3: 1 }, rows: {} }))
  state.seed('homeUi', { layout: 'stacked', folded: ['threads'], more: [], pick: '' })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  expect(await newsLine($)).toBe('threads 2 new')
  const above = (await $.ui.mount(ABOVE as never)) as unknown as M
  await above.press({ key: 'threads-news' })
  await above.unmount()
  expect(state.get('panelView')).toBe('home')
  expect((state.get('homeUi') as { folded: string[] }).folded).toEqual([])
  const pane = (await $.ui.mount(PANEL as never)) as unknown as M
  const lines = await homeText(pane)
  await pane.unmount()
  const at = lines.findIndex(l => l.startsWith('Side threads  3'))
  expect(at).toBeGreaterThan(0)
  // the heading counts what is new, in bold
  expect(lines[at]).toMatch(/^Side threads {2}3 {2}2 new$/)
  // the two with new answers first, the newer of them first, their names bold; then the one read
  const c = (await (async () => {
    const p = (await $.ui.mount(PANEL as never)) as unknown as M
    const found = (await p.find({ type: 'Client', key: 'home' })) as unknown as { props: { props: HomeProps } }
    await p.unmount()
    return found
  })())
  const items = c.props.props.lines.slice(at + 1).filter(l => /^● /.test(l.map(x => x.s).join('')))
  const rows = items.slice(0, 3).map(l => l.map(x => x.s).join(''))
  expect(rows[0]).toMatch(/^● "and probier\?"/)
  expect(rows[1]).toMatch(/^● "how big is dse\?"/)
  expect(rows[2]).toMatch(/^● "who reverted most\?"/)
  const bold = (l: { s: string; b?: boolean }[]) => l.some(x => x.b)
  expect(items.slice(0, 2).every(bold)).toBe(true)
  expect(bold(items[2]!)).toBe(false)
  expect(rows[2]).not.toMatch(/new$/)
})

test('the home panel stays live: a thread written on disk while it shows draws it again, and the watch ends when the panel moves on', async ($, on) => {
  const w = world(on)
  const state = written(on)
  let shown = true
  on('ui.panes', () => ({ value: shown ? [{ id: 'thimble', title: 'Home', isShown: true, isFocused: true, isPlaced: true }] : [] }) as never)
  saved(w, 'tuaaa1')
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'thimble-home', args: '' } as never)
  await w.clock.advance(1600)
  // nothing changed on disk: not drawn again
  expect(state.get('homeTick')).toBeUndefined()
  saved(w, 'tuaaa2', { at: 5, turns: [turn('and probier?', 'done', 'probier has 1013.')] })
  await w.clock.advance(1600)
  expect(state.get('homeTick')).toBe(1)
  const pane = (await $.ui.mount(PANEL as never)) as unknown as M
  expect((await homeText(pane)).some(l => l.startsWith('Side threads  2'))).toBe(true)
  await pane.unmount()
  await w.clock.advance(1600)
  expect(state.get('homeTick')).toBe(1)
  // the panel closed: the watch ends, and a file written then draws nothing
  shown = false
  await w.clock.advance(1600)
  saved(w, 'tuaaa3', { at: 6 })
  shown = true
  await w.clock.advance(3200)
  expect(state.get('homeTick')).toBe(1)
})
