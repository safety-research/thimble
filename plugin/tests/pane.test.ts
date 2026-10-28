// The side pane (core/pane.ts): its trail of the panes it showed, the top row that names esc, which goes back down it (`esc back to …`)
// or closes it (`esc close`), esc going back while the trail holds a pane and closing on the first one, passing over a pane it can no longer show, and
// closing when Claude Code does not place the pane it goes back to; and the docked frame that keeps the top row and the input bar at its bottom. All data is made up. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { keyedWords, pressedWords } from '../bar/bar'
import { barKey, registerBar } from '../bar/register'
import { noteViewport } from '../cards/draw'
import { closePane, drawPane, narrowNotice, openPane, paneNow, registerPanes, scrollPane } from '../core/pane'
import { treeRows } from '../core/trail.mjs'
import { setOptions } from '../settings/features.mjs'
import { resetThreads } from '../threads/thread'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function setup() {
  const hooks: Record<string, Any[]> = {}
  const on: Any = (event: string, a: Any, b?: Any) => { (hooks[event] ??= []).push(typeof a === 'function' ? a : b); return { catch: () => undefined } }
  registerPanes(on, {} as never)
  const state = new Map<string, { value: unknown; version: number }>()
  const opens: Any[] = []
  let open = false
  let now = 1000
  const $: Any = {
    plugin: { root: '/made-up/plugin', name: 'thimble' },
    state: {
      get: async (k: Any) => state.get(JSON.stringify(k)) ?? { value: undefined, version: 0 },
      set: async (k: Any, value: unknown) => { const v = (state.get(JSON.stringify(k))?.version ?? 0) + 1; state.set(JSON.stringify(k), { value, version: v }); return { isSet: true, version: v } },
    },
    clock: { now: async () => (now += 100), after: () => ({ cancel() {} }) },
    config: { list: async () => [] },
    ui: {
      open: async (a: Any) => { opens.push(a); open = true; return { isPlaced: true } },
      close: async () => { open = false },
      panes: async () => (open ? [{ id: 'thimble', title: 't', isShown: true, isFocused: true, isPlaced: true }] : []),
      invalidate: () => undefined,
    },
  }
  /** One event through the hooks, down to `last` (the engine's own answer). */
  const call = (event: string, e: Any, last: (e: Any) => Any = async (x: Any) => x) => {
    const chain = hooks[event] ?? []
    const at = (i: number): ((e: Any) => Promise<Any>) => async (x: Any) => (i < chain.length ? chain[i]($, x, at(i + 1)) : last(x))
    return at(0)(e)
  }
  return { $, call, opens, isOpen: () => open }
}

const els: Any = new Proxy({}, { get: (_t, type: string) => (props: Any = {}) => ({ type, props }) })
const nodes = (node: Any, out: Any[] = []): Any[] => {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach(n => nodes(n, out)); return out }
  out.push(node)
  nodes(node.props?.children, out)
  return out
}
const textOf = (node: Any): string => {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}
const DOCK = (rows = 30) => ({ requestId: 'thimble', props: { title: 't', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: rows }, view: {} } })
const draw = async (s: ReturnType<typeof setup>, rows = 30) => drawPane(s.$, DOCK(rows), await paneNow(s.$), els)

test('the pane keeps a trail: esc goes back down it, and on the first pane esc closes it; its top row names that key, a click that does the same', async () => {
  const s = setup()
  await openPane(s.$, 'threads', {}, 'Threads', { focus: true })
  // the first pane: no way back to show, esc closes it
  expect(nodes(await draw(s)).some(n => n.props?.key === 'pane-back')).toBe(false)
  expect(textOf(nodes(await draw(s)).find(n => n.props?.key === 'pane-top'))).toBe('esc close')
  await openPane(s.$, 'made-up', { n: 1 }, 'Made up', { focus: true })
  await openPane(s.$, 'other', {}, 'Other', { focus: true })
  const tree = nodes(await draw(s))
  const top = tree.find(n => n.props?.key === 'pane-top')
  // one key, where it acts: esc goes back, no close beside it
  expect(textOf(top)).toBe('esc back to made-up')
  // a click on it goes back one pane
  await tree.find(n => n.props?.key === 'pane-back').props.onPress()
  expect(await paneNow(s.$)).toMatchObject({ kind: 'made-up', args: { n: 1 } })
  await nodes(await draw(s)).find(n => n.props?.key === 'pane-back').props.onPress()
  expect(await paneNow(s.$)).toMatchObject({ kind: 'threads', args: {} })
  expect((await paneNow(s.$))?.trail).toBeUndefined()
  expect(s.opens.at(-1)).toMatchObject({ id: 'thimble', title: 'Threads', focus: true, closeOnEscape: true })

  // esc (Claude Code's close, by the person) goes back while the trail holds a pane
  await openPane(s.$, 'made-up', { n: 2 }, 'Made up', { focus: true })
  let closed = 0
  await s.call('ui.close', { id: 'thimble', origin: { kind: 'person' } }, async () => { closed += 1 })
  expect(closed).toBe(0)
  expect((await paneNow(s.$))?.kind).toBe('threads')
  await s.call('ui.close', { id: 'thimble', origin: { kind: 'person' } }, async () => { closed += 1 })
  expect(closed).toBe(1)
  // thimble's own close is never a step back
  await openPane(s.$, 'made-up', { n: 3 }, 'Made up', { focus: true })
  await s.call('ui.close', { id: 'thimble', origin: { kind: 'plugin' } }, async () => { closed += 1 })
  expect(closed).toBe(2)
  // a click on `esc close` on the first pane closes it
  await closePane(s.$)
  await openPane(s.$, 'threads', {}, 'Threads', { focus: true })
  await nodes(await draw(s)).find(n => n.props?.key === 'pane-close').props.onPress()
  expect(await paneNow(s.$)).toBeNull()
  expect(s.isOpen()).toBe(false)
})

test('esc or the close mark closing the pane, with no drawing of the bar after, leaves r to open coverage again', async () => {
  const s = setup()
  // the bar's drawing beside the pane notes which pane it was drawn beside
  const bar: Record<string, Any[]> = {}
  registerBar(((event: string, a: Any, b?: Any) => { (bar[event] ??= []).push(typeof a === 'function' ? a : b); return { catch: () => undefined } }) as never, {} as never)
  s.$.ui.resolve = () => els
  const drawBar = () => bar['ui.render']![0](s.$, { props: { hasSurvey: false, bodyColumns: 100, maxRows: 12 } }, async () => null)
  // the folder's coverage is counted, so the bar names r
  await s.$.state.set({ plugin: 'thimble', key: 'counts' }, { coverage: '43% (3/7 files)', labels: 0, gen: 1, error: null })
  await openPane(s.$, 'coverage', {}, 'Coverage', { focus: true })
  await drawBar()
  // esc: Claude Code closes the pane, and the bar does not draw again
  await s.call('ui.close', { id: 'thimble', origin: { kind: 'person' } }, async () => { await s.$.ui.close() })
  expect(s.isOpen()).toBe(false)
  const opens = s.opens.length
  await (await barKey(s.$, 'r'))!.later()
  expect(s.opens.length).toBe(opens + 1)
  expect(s.isOpen()).toBe(true)
})

test('going back to a pane Claude Code does not place closes the pane, so the next pane starts a trail of its own', async () => {
  const s = setup()
  // the open that goes back waits for Claude Code's close to end (a timer)
  s.$.clock.after = (_ms: number, fn: () => void) => { setTimeout(fn, 0); return { cancel() {} } }
  await openPane(s.$, 'threads', {}, 'Threads', { focus: true })
  await openPane(s.$, 'settings', {}, 'Settings', { focus: true })
  // the close mark closed the pane, and the open of the pane under it, the plugin's own, waits unseen in a narrow
  // terminal
  const placing = s.$.ui.open
  s.$.ui.open = async (a: Any) => { s.opens.push(a); return { isPlaced: false, reason: 'unasked below 144 columns (117 now)' } }
  await s.call('ui.close', { id: 'thimble', origin: { kind: 'person' } }, async () => undefined)
  await new Promise(r => setTimeout(r, 5))
  expect(await paneNow(s.$)).toBeNull()
  expect(s.isOpen()).toBe(false)
  s.$.ui.open = placing
  await openPane(s.$, 'made-up', {}, 'Made up', { focus: true })
  expect(textOf(nodes(await draw(s)).find(n => n.props?.key === 'pane-top'))).toBe('esc close')
})

test('the way back passes over a side thread the conversation no longer holds: the top row and esc go to the pane under it, or close', async () => {
  resetThreads()
  const s = setup()
  // the conversation keeps the thread that was asked; one opened and never asked is gone after a reload
  const at = '2026-01-02T10:00:00.000Z'
  const scope = { about: 'p95', mark: { row: 'r1', kind: 'explain', id: 'g1' } }
  const kept = { id: 'mark-r1-explain-g1', key: 'mark-r1-explain-g1', agentId: null, scope, subject: 'p95', root: '/made-up/data', status: 'done', asks: [{ text: 'What is p95?', scope, sent: '', at }], turns: [{ role: 'person', text: 'What is p95?', at }], at }
  s.$.session = { id: async () => 's-pane' }
  s.$.env = { get: async (k: string) => ({ THIMBLE_HOME: '/made-up/.thimble' } as Any)[k] }
  s.$.fs = {
    list: async (dir: string) => (dir.endsWith('/threads') ? [{ name: `${kept.id}.json`, kind: 'file' }] : []),
    read: async (p: string) => { if (p.endsWith(`/threads/${kept.id}.json`)) return JSON.stringify(kept); throw new Error(`no file ${p}`) },
  }
  const top = async () => textOf(nodes(await draw(s)).find(n => n.props?.key === 'pane-top'))
  await openPane(s.$, 'thread', { key: kept.key }, 'p95', { focus: true })
  await openPane(s.$, 'thread', { key: 'mark-r2-explain-g2' }, 'cold cache', { focus: true })
  await openPane(s.$, 'made-up', { n: 1 }, 'Made up', { focus: true })
  expect(await top()).toBe('esc back to thread')
  await s.call('ui.close', { id: 'thimble', origin: { kind: 'person' } }, async () => undefined)
  expect(await paneNow(s.$)).toMatchObject({ kind: 'thread', args: { key: kept.key } })
  expect((await paneNow(s.$))?.trail).toBeUndefined()
  // with only the thread that is gone under it, esc closes the pane, and the top row says so
  await closePane(s.$)
  await openPane(s.$, 'thread', { key: 'mark-r2-explain-g2' }, 'cold cache', { focus: true })
  await openPane(s.$, 'made-up', { n: 2 }, 'Made up', { focus: true })
  expect(await top()).toBe('esc close')
  let closed = 0
  await s.call('ui.close', { id: 'thimble', origin: { kind: 'person' } }, async () => { closed += 1 })
  expect(closed).toBe(1)
})

test('docked, the frame takes the pane\'s rows and a row past it, never shown; inline the drawing alone', async () => {
  const s = setup()
  await openPane(s.$, 'threads', {}, 'Threads', { focus: true })
  const tree = await draw(s, 24)
  const frame = nodes(tree).find(n => n.props?.key === 'pane-frame')
  expect(frame.props.height).toBe(24)
  expect(nodes(tree).some(n => n.props?.key === 'pane-past')).toBe(true)
  // a scroll of a pane whose drawing fits moves nothing, and is the pane's own
  expect(await scrollPane(s.$, { by: 1, origin: { kind: 'person' } })).toBe(true)
  const inline = await drawPane(s.$, { requestId: 'thimble', props: { bodyColumns: 70, placement: 'inline', scroll: { offset: 0, bodyRows: 24 } } }, await paneNow(s.$), els)
  expect(nodes(inline).some(n => n.props?.key === 'pane-frame')).toBe(false)
  expect(await scrollPane(s.$, { by: 1, origin: { kind: 'person' } })).toBe(false)
})

test('docked, a drawing far taller than the pane (the settings) leaves the top row with its close, and the line that says how much more there is: only the body gives way', async () => {
  const s = setup()
  await openPane(s.$, 'settings', {}, 'Settings', { focus: true })
  const frame = nodes(await draw(s, 12)).find(n => n.props?.key === 'pane-frame')
  const parts: Any[] = frame.props.children
  const body = parts.find(n => n.props?.key === 'pane-body')
  expect(body.props.flexShrink).toBe(1)
  // Claude Code's Box and Text shrink unless told otherwise, which would take the frame's rows from every part (this
  // harness lays nothing out): every part but the body says it keeps its rows
  for (const n of parts) if (n !== body) expect([n.props.key, n.props.flexShrink]).toEqual([n.props.key, 0])
  const top = parts.find(n => n.props?.key === 'pane-top')
  expect(textOf(top)).toContain('esc close')
  expect(nodes(top).some(n => n.props?.key === 'pane-close')).toBe(true)
  expect(parts.some(n => n.props?.key === 'pane-more')).toBe(true)
})

test('in the settings, ↑ and ↓ (sent as scrolls) pick the row above or below, and the ring lands on its choice set', async () => {
  const s = setup()
  const focused: Any[] = []
  s.$.ui.focus = async (a: Any) => { focused.push(a.key); return {} }
  await openPane(s.$, 'settings', {}, 'Settings', { focus: true })
  await draw(s)
  // Minimal first, then Citations and Checker
  expect(await scrollPane(s.$, { by: 1, origin: { kind: 'person' } })).toBe(true)
  expect((await s.$.state.get({ plugin: 'thimble', key: 'settingsRow' })).value).toBe('citations')
  await draw(s)
  expect(await scrollPane(s.$, { by: 1, origin: { kind: 'person' } })).toBe(true)
  expect((await s.$.state.get({ plugin: 'thimble', key: 'settingsRow' })).value).toBe('checkerModel')
  await draw(s)
  expect(await scrollPane(s.$, { by: -1, origin: { kind: 'person' } })).toBe(true)
  expect((await s.$.state.get({ plugin: 'thimble', key: 'settingsRow' })).value).toBe('citations')
  expect(focused).toEqual(['mode-citations-auto cite + verify', 'mode-checkerModel-same as Claude', 'mode-citations-auto cite + verify'])
  // the ring moving along the row picked (← →, tab) sets the choice it lands on; onto another row it lands on that
  // row's choice set, picks that row and changes nothing
  const set: Any[] = []
  const rows: Record<string, unknown> = { citations: 'auto cite', claimsMode: 'on demand' }
  s.$.config = {
    list: async () => Object.entries(rows).map(([k, v]) => ({ key: `thimble@inline.${k}`, value: v, isLocked: false })),
    set: async (e: Any) => { set.push(e); rows[String(e.key).split('.').pop()!] = e.value; return {} },
  }
  s.$.ui.toast = () => undefined
  const went: Any[] = []
  const next = async (e: Any) => { went.push(e.element); return {} }
  await s.call('ui.focus', { component: 'Pane', requestId: 'thimble', element: 'mode-citations-manual', origin: { kind: 'person' } }, next)
  expect(set).toEqual([expect.objectContaining({ key: 'thimble@inline.citations', value: 'manual' })])
  await s.call('ui.focus', { component: 'Pane', requestId: 'thimble', element: 'mode-claimsMode-auto', origin: { kind: 'person' } }, next)
  expect(set.length).toBe(1)
  expect((await s.$.state.get({ plugin: 'thimble', key: 'settingsRow' })).value).toBe('claimsMode')
  expect(went).toEqual(['mode-citations-manual', 'mode-claimsMode-on demand'])
  // a click on a choice of another row sets it and picks that row, the ring on the choice now set: the tint and the
  // ring stand on the row that changed
  rows.labels = true
  await nodes(await draw(s)).find(n => n.props?.key === 'mode-labels-off').props.onPress()
  expect(set.at(-1)).toMatchObject({ key: 'thimble@inline.labels', value: false })
  expect((await s.$.state.get({ plugin: 'thimble', key: 'settingsRow' })).value).toBe('labels')
  expect(focused.at(-1)).toBe('mode-labels-off')
  setOptions({})
})

test('in the settings, the Checker row shows while a checker can run: in every mode of Citations but off, where ↑ and ↓ pass over it', async () => {
  const s = setup()
  const held: Record<string, unknown> = { citations: 'off' }
  s.$.config = { list: async () => Object.entries(held).map(([k, v]) => ({ key: `thimble@inline.${k}`, value: v, isLocked: false })), set: async () => ({}) }
  s.$.ui.focus = async () => ({})
  await openPane(s.$, 'settings', {}, 'Settings', { focus: true })
  const rows = async () => nodes(await draw(s)).map(n => n.props?.key).filter((k: Any) => typeof k === 'string' && k.startsWith('sw-'))
  // Citations off: no citation is checked, so no Checker row; a step down from Citations lands on Cards
  expect((await rows()).slice(0, 3)).toEqual(['sw-minimal', 'sw-citations', 'sw-cards'])
  await s.$.state.set({ plugin: 'thimble', key: 'settingsRow' }, 'citations')
  await draw(s)
  expect(await scrollPane(s.$, { by: 1, origin: { kind: 'person' } })).toBe(true)
  expect((await s.$.state.get({ plugin: 'thimble', key: 'settingsRow' })).value).toBe('cards')
  // the Checker row picked before Citations went off: the tint stands on Citations, the row it belongs to
  await s.$.state.set({ plugin: 'thimble', key: 'settingsRow' }, 'checkerModel')
  const tinted = nodes(await draw(s)).filter(n => String(n.props?.key).startsWith('sw-') && n.props?.backgroundColor)
  expect(tinted.map(n => n.props.key)).toEqual(['sw-citations'])
  // every other mode checks citations (manual: the words c cites), so the row shows, after Citations
  for (const mode of ['auto cite + verify', 'auto cite', 'manual']) {
    held.citations = mode
    expect((await rows()).slice(0, 3)).toEqual(['sw-minimal', 'sw-citations', 'sw-checkerModel'])
  }
  setOptions({})
})

test('a pane a key could not open in a narrow window: the notice offers the click that opens it here; the panes that lay out by their rows ask for them', async () => {
  const s = setup()
  s.$.ui.open = async (a: Any) => { s.opens.push(a); return { isPlaced: false, reason: 'unasked below 144 columns (118 now): placed when the person opens it, or when the terminal is widened to 144 columns' } }
  expect(await openPane(s.$, 'coverage', {}, 'Coverage', { focus: true })).toBe(false)
  const said = narrowNotice('r', 'r coverage')
  expect(pressedWords(said, new Map([['r coverage 43% (3/7 files)', () => 'opened']])).find(p => p.press)?.s).toBe('“r coverage”')
  // a pane drawn inline gets the rows it asks for: the settings, coverage and a citation's evidence ask for theirs
  s.$.ui.open = async (a: Any) => { s.opens.push(a); return { isPlaced: true } }
  for (const kind of ['settings', 'coverage', 'evidence']) {
    await closePane(s.$)
    await openPane(s.$, kind, {}, kind, { focus: true })
    expect(s.opens.at(-1).rows).toBeGreaterThan(20)
  }
})

test("in Claude Code's default layout, which sends no click and docks no pane, the notice names /tui fullscreen, with no click; where nothing places panes, it does not say to widen the window", async () => {
  const s = setup()
  const named = new Map([['r coverage 43% (3/7 files)', () => 'opened']])
  try {
    noteViewport({ isFullscreen: false })
    s.$.ui.open = async (a: Any) => { s.opens.push(a); return { isPlaced: false, reason: 'unasked below 144 columns (80 now): placed when the person opens it, or when the terminal is widened to 144 columns' } }
    expect(await openPane(s.$, 'coverage', {}, 'Coverage', { focus: true })).toBe(false)
    const said = narrowNotice('r', 'r coverage')
    expect(said).toContain('/tui fullscreen')
    expect(said).not.toMatch(/click/i)
    expect(pressedWords(said, named).some(p => p.press)).toBe(false)
    // no surface here places panes: neither a wider window nor the fullscreen layout opens it
    s.$.ui.open = async (a: Any) => { s.opens.push(a); return { isPlaced: false, reason: 'no attached surface places panes' } }
    await openPane(s.$, 'coverage', {}, 'Coverage', { focus: true })
    for (const isFullscreen of [false, true]) {
      noteViewport({ isFullscreen })
      expect(narrowNotice('r', 'r coverage')).not.toMatch(/widen|wider|columns|fullscreen|click/i)
    }
  } finally {
    // the tests after it draw in the fullscreen layout
    noteViewport({ isFullscreen: true })
  }
})

test('a key a failure line names is a part of its own, so a click presses it; esc and a key with a modifier are not', async () => {
  expect(keyedWords('× The repair did not start: no answer. Press x to try again.')).toEqual([
    { s: '× The repair did not start: no answer. Press ' }, { s: 'x', key: 'x' }, { s: ' to try again.' },
  ])
  expect(keyedWords('Press 0 or pick the level again.').map(p => p.key ?? '')).toEqual(['', '0', ''])
  expect(keyedWords('This pane could not be drawn. Press esc, then open it again.').some(p => p.key)).toBe(false)
  expect(keyedWords('Press ctrl + x to hide it.').some(p => p.key)).toBe(false)
})

test('an item of the bar a failure line quotes is a part of its own with that item\'s press; a quote no item has stays words', async () => {
  const coverage = () => 'coverage', labels = () => 'labels'
  const named = new Map<string, () => unknown>([['r coverage 75% (3/4 files)', coverage], ['l 3 labels', labels]])
  const parts = pressedWords('× r needs a wider terminal: widen the window to show the side pane, or click “r coverage”.', named)
  expect(parts.map(p => p.s)).toEqual(['× r needs a wider terminal: widen the window to show the side pane, or click ', '“r coverage”', '.'])
  expect(parts[1]!.press).toBe(coverage)
  expect(pressedWords('l needs a wider terminal: widen the window to show the side pane, or click “l 3 labels”.', named)[1]!.press).toBe(labels)
  expect(pressedWords('t needs a wider terminal: widen the window to show the side pane, or click “t 2 threads”.', named).some(p => p.press)).toBe(false)
  // a key the line names is still a press of its own
  expect(pressedWords('“r coverage” failed. Press x to try again.', named).map(p => p.key ?? (p.press ? 'item' : ''))).toEqual(['item', '', 'x', ''])
})

test('in the settings, the row picked and the line under it, with what its mode costs, stay in view at any height: ↓ to a row below the window brings it in', async () => {
  const s = setup()
  s.$.ui.focus = async () => ({})
  await openPane(s.$, 'settings', {}, 'Settings', { focus: true })
  const H = 16
  await draw(s, H)
  // ↓ down to Evidence, far below the first window
  while ((await s.$.state.get({ plugin: 'thimble', key: 'settingsRow' })).value !== 'claimsMode') {
    await scrollPane(s.$, { by: 1, origin: { kind: 'person' } })
    await draw(s, H)
  }
  const tree = await draw(s, H)
  const inner = nodes(tree).find(n => n.props?.key === 'pane-body-in')
  const by = -(inner.props.top ?? 0)
  const rows: Any[] = inner.props.children[0].props.children
  const k = rows.findIndex(n => n.props?.key === 'sw-claimsMode')
  const top = treeRows(rows.slice(0, k), 70)
  // the window: the pane's rows less its top row and the line that says how much more there is
  expect(top).toBeGreaterThanOrEqual(by)
  expect(top + treeRows(rows[k], 70)).toBeLessThanOrEqual(by + H - 2)
  // the line under it says what its mode gives and what it costs
  const says = textOf(nodes(rows[k]).find(n => n.props?.key === 'says-claimsMode'))
  expect(says).toContain('Claims are found after each answer.')
  expect(says).toContain('The largest part of the call after each answer.')
  // a row not picked says what its mode gives alone
  expect(textOf(nodes(tree).find(n => n.props?.key === 'says-coverage'))).not.toContain('No model call')
  setOptions({})
})
