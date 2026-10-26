// The side pane (core/pane.ts): its trail of the panes it showed, the top row that names esc, which goes back down it (`esc back to …`)
// or closes it (`esc close`), esc going back while the trail holds a pane and closing on the first one, and the docked frame that keeps the input bar at its bottom. All data is made up. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { keyedWords } from '../bar/bar'
import { closePane, drawPane, openPane, paneNow, registerPanes, scrollPane } from '../core/pane'
import { setOptions } from '../settings/features.mjs'

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

test('in the settings, ↑ and ↓ (sent as scrolls) pick the row above or below, and the ring lands on its choice set', async () => {
  const s = setup()
  const focused: Any[] = []
  s.$.ui.focus = async (a: Any) => { focused.push(a.key); return {} }
  await openPane(s.$, 'settings', {}, 'Settings', { focus: true })
  await draw(s)
  expect(await scrollPane(s.$, { by: 1, origin: { kind: 'person' } })).toBe(true)
  expect((await s.$.state.get({ plugin: 'thimble', key: 'settingsRow' })).value).toBe('cards')
  await draw(s)
  expect(await scrollPane(s.$, { by: -1, origin: { kind: 'person' } })).toBe(true)
  expect((await s.$.state.get({ plugin: 'thimble', key: 'settingsRow' })).value).toBe('citations')
  expect(focused).toEqual(['mode-cards-on', 'mode-citations-auto cite'])
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
  setOptions({})
})

test('a key a failure line names is a part of its own, so a click presses it; esc and a key with a modifier are not', async () => {
  expect(keyedWords('× The repair did not start: no answer. Press x to try again.')).toEqual([
    { s: '× The repair did not start: no answer. Press ' }, { s: 'x', key: 'x' }, { s: ' to try again.' },
  ])
  expect(keyedWords('Press 0 or pick the level again.').map(p => p.key ?? '')).toEqual(['', '0', ''])
  expect(keyedWords('This pane could not be drawn. Press esc, then open it again.').some(p => p.key)).toBe(false)
  expect(keyedWords('Press ctrl + x to hide it.').some(p => p.key)).toBe(false)
})
