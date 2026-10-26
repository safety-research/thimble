// The settings pane: /thimble-settings opens it with the keys, it shows the bar as the switches leave it, and a press on
// a switch turns it off through Claude Code ($.config.set). All data is made up. `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'

import { DEFAULTS, choiceOf, citationsFrom, featureOn, noteChange, setOptions } from '../settings/features.mjs'
import { registerSettings } from '../settings/term'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const PANE = { plugin: 'thimble', component: 'Pane', surface: 'terminal', requestId: 'thimble', props: { title: 'thimble settings', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as never

test('/thimble-settings opens the settings under their headings; a press on a choice sets it through Claude Code, and its items leave the preview', async ($, on) => {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp' })
  mock.clock(on, { now: 0 })
  const rows: Record<string, boolean> = { marks: true, cards: true, coverage: true, labels: true }
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
  expect((await pane.find({ key: 'switch-coverage' }))?.text).toContain('Coverage')
  for (const h of ['Settings', 'ANSWERS', 'COMMENTS', 'PANES', '↑↓ setting · ←→ choice']) expect(await pane.find({ type: 'Text', text: h })).toBeDefined()
  // every row the same: its choices, and what the one set gives under them
  expect((await pane.find({ key: 'sw-coverage' }))?.text).toMatch(/Coverage\s+on · off/)
  expect((await pane.find({ key: 'says-coverage' }))?.text).toContain('which files Claude has read')
  expect(await pane.find({ type: 'Text', text: /^ coverage$/ })).toBeDefined()

  await pane.press({ key: 'mode-coverage-off' })
  // the first change saves 0.10.4's moved default first (defaultsAt), then the change
  expect(set).toEqual([expect.objectContaining({ key: 'thimble@inline.defaultsAt', value: DEFAULTS.at }), expect.objectContaining({ key: 'thimble@inline.coverage', value: false })])
  expect((await pane.find({ key: 'says-coverage' }))?.text).toContain('No Coverage pane.')
  expect(await pane.find({ type: 'Text', text: /^ coverage$/ })).toBeUndefined()
  // Labels is a setting of its own: its item stays
  expect(await pane.find({ type: 'Text', text: /^ labels$/ })).toBeDefined()
  await pane.unmount()
})

test('Citations has four modes: a press on one sets it, the line under the row says what it gives, and manual puts c cite on the bar', async ($, on) => {
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
  for (const mode of ['auto cite + verify', 'auto cite', 'manual', 'off']) expect(await pane.find({ key: `mode-citations-${mode}` })).toBeDefined()
  expect((await pane.find({ key: 'says-citations' }))?.text).toContain('checked when you open it')
  expect(await pane.find({ type: 'Text', text: /^ cite$/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /^ evidence$/ })).toBeDefined()
  await pane.press({ key: 'mode-citations-manual' })
  expect(set.filter(e => !String(e.key).endsWith('.defaultsAt'))).toEqual([expect.objectContaining({ key: 'thimble@inline.citations', value: 'manual' })])
  expect((await pane.find({ key: 'says-citations' }))?.text).toContain('select words and press c')
  // the bar's preview: c cite beside e explain, and the claims' item without its key, so c is named once
  expect(await pane.find({ type: 'Text', text: /^ cite$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^ evidence$/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /^evidence$/ })).toBeDefined()
  // the row picked is the first, Minimal, marked; a click on a name picks its row, changing nothing (↑ ↓:
  // tests/pane.test.ts)
  expect((await pane.find({ key: 'sw-minimal' }))?.text).toMatch(/^› MINIMAL MODE/)
  await pane.press({ key: 'switch-claimsMode' })
  expect((await pane.find({ key: 'sw-claimsMode' }))?.text).toMatch(/^› Evidence/)
  expect(set.filter(e => !String(e.key).endsWith('.defaultsAt')).length).toBe(1)
  await pane.unmount()
})

test('Minimal holds what acts after each reply on demand: the rows it changes say so, the preview names h, and each row keeps its own setting', async ($, on) => {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp' })
  mock.clock(on, { now: 0 })
  const rows: Record<string, boolean | string> = { minimal: false, citations: 'auto cite + verify', explain: true, details: true, claimsMode: 'auto', defaultsAt: DEFAULTS.at }
  const set: Any[] = []
  on('config.list', () => ({ value: Object.entries(rows).map(([k, v]) => ({ key: `thimble@inline.${k}`, value: v, isLocked: false })) }))
  on('config.set', (_$: unknown, e: Any) => { set.push(e); rows[String(e.key).split('.').pop()!] = e.value; return { value: e.value } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)
  setOptions(rows)

  await $.command.run({ command: 'thimble-settings', args: '' } as never)
  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ key: 'sw-minimal' }))?.text).toMatch(/^› MINIMAL MODE\s+on · off/)
  expect(await pane.find({ key: 'says-minimal' })).toBeUndefined()
  expect((await pane.find({ key: 'says-citations' }))?.text).not.toContain('Minimal')
  expect(await pane.find({ type: 'Text', text: /^ heads-ups$/ })).toBeUndefined()
  await pane.press({ key: 'mode-minimal-on' })
  expect(set.filter(e => !String(e.key).endsWith('.defaultsAt'))).toEqual([expect.objectContaining({ key: 'thimble@inline.minimal', value: true })])
  expect((await pane.find({ key: 'sw-citations' }))?.text).toContain('→ manual')
  expect((await pane.find({ key: 'says-citations' }))?.text).not.toContain('Minimal')
  expect((await pane.find({ key: 'sw-claimsMode' }))?.text).toContain('→ on demand')
  expect((await pane.find({ key: 'sw-explain' }))?.text).toContain('→ on demand')
  expect((await pane.find({ key: 'sw-details' }))?.text).toContain('→ on demand')
  expect((await pane.find({ key: 'sw-cards' }))?.text).not.toContain('→')
  // the setting it holds stays as set: auto cite + verify, green
  expect(await pane.find({ key: 'mode-citations-auto cite + verify' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^ heads-ups$/ })).toBeDefined()
  await pane.press({ key: 'mode-minimal-off' })
  expect((await pane.find({ key: 'says-citations' }))?.text).not.toContain('Minimal')
  expect(await pane.find({ type: 'Text', text: /^ heads-ups$/ })).toBeUndefined()
  await pane.unmount()
  setOptions({})
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
  expect(choiceOf('citations')).toBe('auto cite + verify')
  await call('session.start', { isInteractive: true })
  expect(set.map(e => [e.key, e.value])).toEqual([['thimble@inline.citations', 'auto cite + verify'], ['thimble@inline.citationChecks', 'on demand'], ['thimble@inline.defaultsAt', DEFAULTS.at]])
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
  // Squeeze and catch-up off, and Labels and coverage off, each saved as one setting before they split: both settings
  // that replaced each are off, moved once; the old fields go back to their defaults, and a setting changed after stands
  set.length = 0
  Object.assign(rows, { squeezeAnswers: true, catchUp: true, labels: true, coverage: true })
  for (const k of Object.keys(hooks)) delete hooks[k]
  registerSettings(on, { squeeze: false, counts: false, squeezeCards: false } as never)
  expect(featureOn('catchUp')).toBe(false)
  expect(featureOn('coverage')).toBe(false)
  await call('session.start', { isInteractive: true })
  expect(set.map(e => [String(e.key).split('.').pop(), e.value])).toEqual([['squeezeAnswers', false], ['catchUp', false], ['labels', false], ['coverage', false], ['squeeze', true], ['counts', true], ['squeezeCards', true], ['defaultsAt', DEFAULTS.at]])
  expect(featureOn('catchUp')).toBe(false)
  noteChange('catchUp', true)
  expect(featureOn('catchUp')).toBe(true)
  expect(featureOn('squeezeAnswers')).toBe(false)
  expect((await call('config.describe', { key: 'thimble@inline.squeezeCards', label: 'x', isHidden: false })).isHidden).toBe(true)
  // Claims off and a Citations mode under its old name: Claims is off, and the mode is saved under its new name
  set.length = 0
  Object.assign(rows, { citations: 'auto cite + check', claimsMode: 'on demand' })
  for (const k of Object.keys(hooks)) delete hooks[k]
  registerSettings(on, { citations: 'auto cite + check', claims: false, claimsMode: 'on demand' } as never)
  expect(featureOn('claims')).toBe(false)
  await call('session.start', { isInteractive: true })
  expect(set.map(e => [String(e.key).split('.').pop(), e.value])).toEqual([['citations', 'auto cite + verify'], ['claimsMode', 'off'], ['claims', true], ['defaultsAt', DEFAULTS.at]])
  expect(choiceOf('citations')).toBe('auto cite + verify')
  // 0.10.4's default: auto cite, which the installer saved as the default before, is manual once, and defaultsAt, hidden
  // from /config, says so; auto cite saved after that stays
  set.length = 0
  Object.assign(rows, { citations: 'auto cite' })
  for (const k of Object.keys(hooks)) delete hooks[k]
  registerSettings(on, { citations: 'auto cite', defaultsAt: '' } as never)
  await call('session.start', { isInteractive: true })
  expect(set.map(e => [String(e.key).split('.').pop(), e.value])).toEqual([['citations', 'manual'], ['defaultsAt', DEFAULTS.at]])
  expect(choiceOf('citations')).toBe('manual')
  expect((await call('config.describe', { key: 'thimble@inline.defaultsAt', label: 'x', isHidden: false })).isHidden).toBe(true)
  set.length = 0
  for (const k of Object.keys(hooks)) delete hooks[k]
  registerSettings(on, { citations: 'auto cite', defaultsAt: DEFAULTS.at } as never)
  await call('session.start', { isInteractive: true })
  expect(set).toEqual([])
  expect(choiceOf('citations')).toBe('auto cite')
  setOptions({})
})
