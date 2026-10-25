// The settings pane: /thimble-settings opens it with the keys, it shows the bar as the switches leave it, and a press on
// a switch turns it off through Claude Code ($.config.set). All data is made up. `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { choiceOf, citationsFrom, setOptions } from '../settings/features.mjs'
import { registerSettings } from '../settings/term'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const PANE = { plugin: 'thimble', component: 'Pane', surface: 'terminal', requestId: 'thimble', props: { title: 'thimble settings', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as never

test('/thimble-settings opens the switches; a press turns one off through Claude Code, and its items leave the preview', async ($, on) => {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp' })
  mock.clock(on, { now: 0 })
  const rows: Record<string, boolean> = { marks: true, cards: true, counts: true }
  const set: Any[] = []
  const opened: Any[] = []
  on('config.list', () => ({ value: Object.entries(rows).map(([k, v]) => ({ key: `thimble@inline.${k}`, value: v, isLocked: false })) }))
  on('config.set', (_$: unknown, e: Any) => { set.push(e); rows[String(e.key).split('.').pop()!] = e.value; return { value: e.value } })
  on('ui.open', (_$: unknown, e: Any) => { opened.push(e); return { value: { isPlaced: true } } })
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)

  await $.command.run({ command: 'thimble-settings', args: '' } as never)
  expect(opened[0]).toMatchObject({ id: 'thimble', focus: true, closeOnEscape: true })
  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ key: 'switch-counts' }))?.text).toContain('on')
  expect(await pane.find({ type: 'Text', text: /^ coverage$/ })).toBeDefined()

  await pane.press({ key: 'switch-counts' })
  expect(set).toEqual([expect.objectContaining({ key: 'thimble@inline.counts', value: false })])
  expect((await pane.find({ key: 'switch-counts' }))?.text).toContain('off')
  expect(await pane.find({ type: 'Text', text: /^ coverage$/ })).toBeUndefined()
  await pane.unmount()
})

test('Citations has four modes: auto cite by default, a press on one sets it, the line under the row says what it gives, and manual puts w on the bar', async ($, on) => {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp' })
  mock.clock(on, { now: 0 })
  const rows: Record<string, boolean | string> = { citations: 'auto cite', explain: true }
  const set: Any[] = []
  on('config.list', () => ({ value: Object.entries(rows).map(([k, v]) => ({ key: `thimble@inline.${k}`, value: v, isLocked: false })) }))
  on('config.set', (_$: unknown, e: Any) => { set.push(e); rows[String(e.key).split('.').pop()!] = e.value; return { value: e.value } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)

  await $.command.run({ command: 'thimble-settings', args: '' } as never)
  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ key: 'switch-citations' }))?.text).toContain('Citations')
  for (const mode of ['auto cite + check', 'auto cite', 'manual', 'off']) expect(await pane.find({ key: `mode-citations-${mode}` })).toBeDefined()
  expect((await pane.find({ key: 'says-citations' }))?.text).toContain('checks a citation when you open it')
  expect(await pane.find({ type: 'Text', text: /where from/ })).toBeUndefined()
  await pane.press({ key: 'mode-citations-manual' })
  expect(set).toEqual([expect.objectContaining({ key: 'thimble@inline.citations', value: 'manual' })])
  expect((await pane.find({ key: 'says-citations' }))?.text).toContain('press w')
  // the bar's preview: w beside e
  expect(await pane.find({ type: 'Text', text: /where from/ })).toBeDefined()
  await pane.press({ key: 'switch-citations' })
  expect(set[1]).toMatchObject({ key: 'thimble@inline.citations', value: 'off' })
  await pane.press({ key: 'switch-citations' })
  expect(set[2]).toMatchObject({ value: 'auto cite + check' })
  expect(rows.citations).toBe('auto cite + check')
  await pane.unmount()
})

test('a mode saved under the old fields moves to Citations at the first session, which sets the old ones back to their defaults; /config hides the old ones', async () => {
  const hooks: Record<string, { m: Any; fn: Any }[]> = {}
  const on: Any = (event: string, a: Any, b?: Any) => {
    ;(hooks[event] ??= []).push(typeof a === 'function' ? { m: null, fn: a } : { m: a, fn: b })
    const reg: Any = { catch: () => reg }
    return reg
  }
  const call = (event: string, e: Any, base: (e: Any) => Any = async x => x) => {
    const chain = hooks[event] ?? []
    const run = (i: number, ev: Any): Any => (i < chain.length ? chain[i]!.fn($, ev, (x: Any) => run(i + 1, x)) : base(ev))
    return run(0, e)
  }
  const rows: Record<string, boolean | string> = { citations: 'auto cite', cards: true }
  const set: Any[] = []
  const $: Any = {
    plugin: { name: 'thimble' },
    config: {
      // the old fields are hidden, so /config lists only Citations
      list: async () => Object.entries(rows).map(([k, v]) => ({ key: `thimble@inline.${k}`, value: v, isLocked: false })),
      set: async (e: Any) => { set.push(e); return {} },
    },
  }
  // checks after each reply, saved before Citations had its modes
  registerSettings(on, { citations: 'auto cite', marks: true, citationChecks: 'auto', cards: true } as never)
  expect(choiceOf('citations')).toBe('auto cite + check')
  await call('session.start', { isInteractive: true })
  expect(set.map(e => [e.key, e.value])).toEqual([['thimble@inline.citations', 'auto cite + check'], ['thimble@inline.citationChecks', 'on demand']])
  expect((await call('config.describe', { key: 'thimble@inline.marks', label: 'x', isHidden: false })).isHidden).toBe(true)
  expect((await call('config.describe', { key: 'thimble@inline.citationChecks', label: 'x', isHidden: false })).isHidden).toBe(true)
  expect((await call('config.describe', { key: 'thimble@inline.citations', label: 'x', isHidden: false })).isHidden).toBe(false)
  expect((await call('config.describe', { key: 'other.marks', label: 'x', isHidden: false })).isHidden).toBe(false)
  // citations off, saved then: off, and a session with only defaults saved changes nothing
  set.length = 0
  registerSettings(on, { citations: 'auto cite', marks: false, citationChecks: 'on demand' } as never)
  expect(choiceOf('citations')).toBe('off')
  registerSettings(on, { citations: 'auto cite', marks: true, citationChecks: 'on demand' } as never)
  expect(choiceOf('citations')).toBe('auto cite')
  expect(citationsFrom({ marks: true, citationChecks: 'off' })).toBe('auto cite')
  setOptions({})
})
