// The side pane (core/pane.ts): its trail of the panes it showed, the top row that goes back down it (`‹ back`, a
// crumb), esc going back while the trail holds a pane and closing on the first one, what main does at the row's right,
// and the docked frame that keeps the input bar at its bottom. All data is made up. `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { keyedWords } from '../bar/bar'
import { drawPane, openPane, paneNow, registerPanes, scrollPane } from '../core/pane'
import { askOf } from '../labels/use.mjs'

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

test('the pane keeps a trail: ‹ back and a crumb go back down it, esc goes back, and on the first pane esc closes it', async () => {
  const s = setup()
  await openPane(s.$, 'threads', {}, 'Threads', { focus: true })
  // the first pane: no way back to show
  expect(nodes(await draw(s)).some(n => n.props?.key === 'pane-back')).toBe(false)
  await openPane(s.$, 'made-up', { n: 1 }, 'Made up', { focus: true })
  await openPane(s.$, 'other', {}, 'Other', { focus: true })
  const tree = nodes(await draw(s))
  const top = tree.find(n => n.props?.key === 'pane-top')
  expect(textOf(top)).toContain('‹ back')
  expect(textOf(top)).toContain('threads › made-up › other')
  // a crumb goes back to its pane, the ones over it gone
  await tree.find(n => n.props?.key === 'crumb-0').props.onPress()
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
})

test("the top row says what main does: working, waiting for the person's yes, replied while the pane was open", async () => {
  const s = setup()
  await openPane(s.$, 'threads', {}, 'Threads', { focus: true })
  const said = async () => textOf(nodes(await draw(s)).find(n => n.props?.key === 'main-state'))
  expect(await said()).toBe('')
  await s.call('turn.start', { turnId: 't1', text: 'how many?' })
  expect(await said()).toBe('Claude is working…')
  await s.call('classic.PermissionRequest', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} }, async () => ({}))
  expect(await said()).toBe('Claude is waiting on you')
  await s.call('tool.call', { tool: 'Bash', tool_use_id: 'b1' }, async () => ({ result: {} }))
  expect(await said()).toBe('Claude is working…')
  // a fork's turn says nothing of main
  await s.call('turn.complete', { turnId: 'f1', agentId: 'a-fork' })
  expect(await said()).toBe('Claude is working…')
  await s.call('turn.complete', { turnId: 't1' })
  expect(await said()).toBe('Claude replied')
})

test("while a label run's ask waits at the pane's top, the top row says Claude waits on the person, in the ask's words", async () => {
  const s = setup()
  await openPane(s.$, 'threads', {}, 'Threads', { focus: true })
  await s.call('turn.start', { turnId: 't1', text: 'label them' })
  const said = async () => textOf(nodes(await draw(s)).find(n => n.props?.key === 'main-state'))
  expect(await said()).toBe('Claude is working…')
  await s.$.state.set({ plugin: 'thimble', key: 'labelAsk' }, askOf({ kind: 'label_ask', name: 'spam', root: '/made-up/data', ask: 'a1', units: 420, calls: 9, sample: 300, text: 'Read 420 records of chat.jsonl with Claude' }))
  const tree = nodes(await draw(s))
  expect(textOf(tree.find(n => n.props?.key === 'pane-ask'))).toContain('Claude is waiting on you')
  expect(await said()).toBe('Claude is waiting on you')
  await s.$.state.set({ plugin: 'thimble', key: 'labelAsk' }, null)
  expect(await said()).toBe('Claude is working…')
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

test('a key a failure line names is a part of its own, so a click presses it; esc and a key with a modifier are not', async () => {
  expect(keyedWords('× The repair did not start: no answer. Press x to try again.')).toEqual([
    { s: '× The repair did not start: no answer. Press ' }, { s: 'x', key: 'x' }, { s: ' to try again.' },
  ])
  expect(keyedWords('Press 0 or pick the level again.').map(p => p.key ?? '')).toEqual(['', '0', ''])
  expect(keyedWords('This pane could not be drawn. Press esc, then open it again.').some(p => p.key)).toBe(false)
  expect(keyedWords('Press ctrl + x to hide it.').some(p => p.key)).toBe(false)
})
