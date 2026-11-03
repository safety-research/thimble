// The settings pane: /thimble-settings opens it with the keys, it shows the bar as the switches leave it, and a press on
// a switch turns it off through Claude Code ($.config.set). All data is made up. `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { DEFAULTS, PRESET, choiceOf, citationsFrom, featureOn, noteChange, setOptions, valueIn } from '../settings/features.mjs'
import { registerSettings, settingsAction, settleMinimal } from '../settings/term'
import { test } from './kit'

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
  // the change alone: no default moved, so nothing else is saved (each save loads the plugin again)
  expect(set).toEqual([expect.objectContaining({ key: 'thimble@inline.coverage', value: false })])
  expect((await pane.find({ key: 'says-coverage' }))?.text).toContain('No Coverage pane.')
  expect(await pane.find({ type: 'Text', text: /^ coverage$/ })).toBeUndefined()
  // Labels is a setting of its own: its item stays
  expect(await pane.find({ type: 'Text', text: /^ labels$/ })).toBeDefined()
  await pane.unmount()
})

test('Citations has four modes: a press on one sets it, the line under the row says what it gives, and the preview of the bar has c cite in every mode but off', async ($, on) => {
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
  expect((await pane.find({ key: 'says-citations' }))?.text).toContain('verified when you open it')
  // the bar's preview shows every item the switches leave on: c cite, as with words selected, beside w claims
  expect(await pane.find({ type: 'Text', text: /^ cite$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^ claims$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^c cite$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^w claims$/ })).toBeDefined()
  await pane.press({ key: 'mode-citations-manual' })
  expect(set).toEqual([expect.objectContaining({ key: 'thimble@inline.citations', value: 'manual' })])
  expect((await pane.find({ key: 'says-citations' }))?.text).toContain('Select words and press c to cite them.')
  expect(await pane.find({ type: 'Text', text: /^ cite$/ })).toBeDefined()
  // off: no c cite; the claims keep w
  await pane.press({ key: 'mode-citations-off' })
  expect(await pane.find({ type: 'Text', text: /^ cite$/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /^ claims$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^w claims$/ })).toBeDefined()
  // the row picked is the first, Minimal, tinted with no mark; a click on a name picks its row, changing nothing (↑ ↓:
  // tests/pane.test.ts)
  expect((await pane.find({ key: 'sw-minimal' }))?.text).not.toContain('›')
  await pane.press({ key: 'switch-claimsMode' })
  expect((await pane.find({ key: 'sw-claimsMode' }))?.text).not.toContain('›')
  expect(set.length).toBe(2)
  await pane.unmount()
})

/** What a press on Minimal starts, done: each change of it loads the plugin again, whose session start makes the next
 *  (settings/term.ts settleMinimal), as many times as it takes, or `loads` times. `$`: a test's engine, or one
 *  settleEngine made. */
async function settleAll($: Any, loads = 24): Promise<void> {
  for (let i = 0; i < loads; i++) await ($.session?.start ? $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true }) : settleMinimal($))
}

/** A settings pane over made-up rows that Claude Code keeps: config.set changes them, and the plugin's options follow. */
function settingsWorld(on: Any, rows: Record<string, boolean | string>, store: Record<string, unknown> = {}): Any[] {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp' })
  mock.clock(on, { now: 0 })
  mock.store(on, store)
  const set: Any[] = []
  on('config.list', () => ({ value: Object.entries(rows).map(([k, v]) => ({ key: `thimble@inline.${k}`, value: v, isLocked: false })) }))
  on('config.set', (_$: unknown, e: Any) => { set.push(e); rows[String(e.key).split('.').pop()!] = e.value; return { value: e.value } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('session.cwd', () => ({ value: '/made-up/data' }))
  on('session.root', () => ({ value: '/made-up/data' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['the engine'] }) as never)
  // what the other modules' session start reads, as the plugin loads again after each change
  on('session.id', () => ({ value: 's-settings' }))
  on('session.messages', () => ({ value: [] }))
  on('fs.read', () => ({ value: '' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('fs.stat', () => ({ value: { kind: 'missing', size: 0 } }))
  on('env.set', () => ({ value: {} }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as never)
  setOptions(rows)
  return set
}


test('Minimal is a preset: on, it sets Citations auto cite, Cards on demand, Explainers and Heads-ups auto, and Rewrite, Catch-up, Claims, Labels and Coverage off, which the rows and the preview show; off puts back what they had', async ($, on) => {
  const rows: Record<string, boolean | string> = { minimal: false, citations: 'auto cite + verify', cards: 'auto', squeezeAnswers: true, catchUp: false, explain: 'on demand', details: 'off', claimsMode: 'auto', labels: true, coverage: true, defaultsAt: DEFAULTS.at }
  const set = settingsWorld(on, rows)
  await $.command.run({ command: 'thimble-settings', args: '' } as never)
  const pane = await $.ui.mount(PANE)
  // first, its name and what it does in plain words
  expect((await pane.find({ key: 'sw-minimal' }))?.text).toMatch(/^\s*MINIMAL MODE\s+on · off/)
  expect((await pane.find({ key: 'says-minimal' }))?.text).toContain('Citations, explainers and heads-ups show only while the pointer is over their paragraph. Visualizations are shown only when requested. Rewrite, Catch-up, Claims, Labels and Coverage are off.')
  for (const w of [/^ rewrite$/, /^ claims$/, /^ coverage$/]) expect(await pane.find({ type: 'Text', text: w })).toBeDefined()
  await pane.press({ key: 'mode-minimal-on' })
  // one change per hook, as each loads the plugin again; the new load's session start makes the next
  expect(set.length).toBe(1)
  await settleAll($)
  expect(rows).toMatchObject({ minimal: true, ...PRESET })
  // a row that held Minimal's mode already is not saved again (each save loads the plugin again)
  expect(set.some(e => String(e.key).endsWith('.catchUp'))).toBe(false)
  // the rows show the modes set, with no note of Minimal's
  expect((await pane.find({ key: 'sw-citations' }))?.text).not.toContain('→')
  expect((await pane.find({ key: 'says-citations' }))?.text).toContain('verified when you open it')
  expect((await pane.find({ key: 'says-cards' }))?.text).toContain('only when you ask for one')
  expect((await pane.find({ key: 'says-explain' }))?.text).toContain('after each answer')
  expect((await pane.find({ key: 'says-squeezeAnswers' }))?.text).toContain('No rewrites.')
  expect((await pane.find({ key: 'says-claimsMode' }))?.text).toContain('No Claims pane.')
  // the preview: v still acts, and c, e, h and a on selected words; the keys of what Minimal turned off are gone
  for (const w of [/^ visualize$/, /^ cite$/, /^ explain$/, /^ heads-up$/, /^ ask$/]) expect(await pane.find({ type: 'Text', text: w })).toBeDefined()
  for (const w of [/^ rewrite$/, /^ catch up$/, /^ claims$/, /^ coverage$/, /^ labels$/]) expect(await pane.find({ type: 'Text', text: w })).toBeUndefined()
  await pane.press({ key: 'mode-minimal-off' })
  await settleAll($)
  expect(rows).toMatchObject({ minimal: false, citations: 'auto cite + verify', cards: 'auto', squeezeAnswers: true, catchUp: false, explain: 'on demand', details: 'off', claimsMode: 'auto', labels: true, coverage: true })
  for (const w of [/^ rewrite$/, /^ claims$/, /^ coverage$/]) expect(await pane.find({ type: 'Text', text: w })).toBeDefined()
  await pane.unmount()
  setOptions({})
})

test("a row of Minimal's changed away from its mode turns Minimal off and keeps the new mode; the rest stay as Minimal set them", async ($, on) => {
  const rows: Record<string, boolean | string> = { minimal: false, citations: 'auto cite + verify', cards: 'auto', squeezeAnswers: true, catchUp: true, explain: 'auto', details: 'auto', claimsMode: 'auto', labels: true, coverage: true, defaultsAt: DEFAULTS.at }
  settingsWorld(on, rows)
  await $.command.run({ command: 'thimble-settings', args: '' } as never)
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'mode-minimal-on' })
  await settleAll($)
  expect(rows.minimal).toBe(true)
  await pane.press({ key: 'mode-explain-off' })
  expect(rows).toMatchObject({ minimal: false, explain: 'off', citations: 'auto cite', cards: 'on demand', squeezeAnswers: false, catchUp: false, details: 'auto', claimsMode: 'off', labels: false, coverage: false })
  // a switch turned on again turns it off too
  await pane.press({ key: 'mode-minimal-on' })
  await settleAll($)
  expect(rows).toMatchObject({ minimal: true, explain: 'auto' })
  await pane.press({ key: 'mode-coverage-on' })
  expect(rows).toMatchObject({ minimal: false, coverage: true, explain: 'auto', labels: false, squeezeAnswers: false, claimsMode: 'off' })
  // on and off again: each row comes back to what it held when Minimal went on
  await pane.press({ key: 'mode-minimal-on' })
  await settleAll($)
  expect(rows.coverage).toBe(false)
  await pane.press({ key: 'mode-minimal-off' })
  await settleAll($)
  expect(rows).toMatchObject({ minimal: false, coverage: true, explain: 'auto', citations: 'auto cite', cards: 'on demand', squeezeAnswers: false, catchUp: false, claimsMode: 'off', labels: false })
  // a row changed while Minimal's modes are still being set (one change per load of the plugin) stops them: Minimal
  // stays off, and the rows hold what they held then
  Object.assign(rows, { citations: 'auto cite + verify', cards: 'auto', squeezeAnswers: true })
  setOptions(rows)
  await pane.press({ key: 'mode-minimal-on' })
  expect(rows).toMatchObject({ minimal: false, citations: 'auto cite', cards: 'auto' })
  await pane.press({ key: 'mode-cards-off' })
  await settleAll($)
  expect(rows).toMatchObject({ minimal: false, citations: 'auto cite', cards: 'off', squeezeAnswers: true, coverage: true })
  await pane.unmount()
  setOptions({})
})

/** The rows of Minimal and the features it sets, as a person had them before turning it on. */
const OWN = { minimal: false, citations: 'auto cite + verify', cards: 'auto', squeezeAnswers: true, catchUp: true, explain: 'auto', details: 'auto', claimsMode: 'auto', labels: true, coverage: true }

/** The choice the pane draws as set on a row (bold and green), as drawn now. */
async function setOn($: Any, key: string): Promise<string | undefined> {
  const walk = (n: Any, out: Any[] = []): Any[] => {
    if (!n || typeof n !== 'object') return out
    if (Array.isArray(n)) { n.forEach(x => walk(x, out)); return out }
    out.push(n)
    walk(n.props?.children, out)
    walk(n.children, out)
    return out
  }
  const set = walk(await $.ui.render(PANE)).find(x => x.type === 'Button' && String(x.props?.key).startsWith(`mode-${key}-`) && walk(x).some(t => t.type === 'Text' && t.props?.bold && t.props?.color === 'success'))
  return set ? String(set.props.key).slice(`mode-${key}-`.length) : undefined
}

test("Minimal pressed off while its modes are still being set, one change per load of the plugin, by a click or by the ring: it turns off, and every row comes back to what it held; while the change runs, its row shows the choice pressed", async ($, on) => {
  const rows: Record<string, boolean | string> = { ...OWN, defaultsAt: DEFAULTS.at }
  settingsWorld(on, rows)
  on('ui.focus', () => ({}) as never)
  await $.command.run({ command: 'thimble-settings', args: '' } as never)
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'mode-minimal-on' })
  await settleAll($, 2)
  // Minimal itself is set last: Claude Code still holds it off, and the row shows on, as pressed
  expect(rows.minimal).toBe(false)
  expect(await setOn($, 'minimal')).toBe('on')
  await pane.press({ key: 'mode-minimal-off' })
  expect(await setOn($, 'minimal')).toBe('off')
  await settleAll($)
  expect(rows).toEqual({ ...OWN, defaultsAt: DEFAULTS.at })
  // the ring moved onto off three loads into the change (panes/settings.tsx settingsFocus, the pane's ui.focus hook)
  await pane.press({ key: 'mode-minimal-on' })
  await settleAll($, 3)
  await $.ui.focus({ component: 'Pane', requestId: 'thimble', element: 'mode-minimal-off', origin: { kind: 'person' } } as never)
  expect(await setOn($, 'minimal')).toBe('off')
  await settleAll($)
  expect(rows).toEqual({ ...OWN, defaultsAt: DEFAULTS.at })
  await pane.unmount()
  setOptions({})
})

/** The first session's settling, with what it reaches of the engine: rows Claude Code keeps, and the plugin's store. */
function settleEngine(rows: Record<string, boolean | string>, store: Map<string, unknown>): Any {
  return {
    plugin: { name: 'thimble' },
    store: { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => void store.set(k, v) },
    config: {
      list: async () => Object.entries(rows).map(([k, v]) => ({ key: `thimble@inline.${k}`, value: v, isLocked: false })),
      set: async (e: Any) => { rows[String(e.key).split('.').pop()!] = e.value; return {} },
    },
    ui: { invalidate: () => undefined },
  }
}

/** registerSettings's session start, with what it reaches of the engine: each call is a load of the plugin's, the
 *  first session's or the one a change made. */
function sessions(): { on: Any; start: (engine: Any) => Promise<void>; reset: () => void } {
  const hooks: Record<string, Any[]> = {}
  const on: Any = (event: string, a: Any, b?: Any) => {
    ;(hooks[event] ??= []).push(typeof a === 'function' ? a : b)
    const reg: Any = { catch: () => reg }
    return reg
  }
  const start = async (engine: Any) => {
    const chain = hooks['session.start'] ?? []
    const run = (i: number, ev: Any): Any => (i < chain.length ? chain[i](engine, ev, (x: Any) => run(i + 1, x)) : ev)
    await run(0, { isInteractive: true })
  }
  return { on, start, reset: () => { for (const k of Object.keys(hooks)) delete hooks[k] } }
}

test('Explainers, Heads-ups and Cards saved as the switches they were read as auto (on) and off (off), and the first session saves their modes; Minimal saved on before it was a preset sets its modes once', async () => {
  const rows: Record<string, boolean | string> = { minimal: true, citations: 'auto cite + verify', cards: true, squeezeAnswers: true, catchUp: true, explain: true, details: false, claimsMode: 'auto', labels: true, coverage: false, defaultsAt: DEFAULTS.at }
  expect(valueIn(rows, 'explain')).toBe('auto')
  expect(valueIn(rows, 'details')).toBe('off')
  expect(valueIn(rows, 'cards')).toBe('auto')
  const engine = settleEngine(rows, new Map())
  const s = sessions()
  registerSettings(s.on, { ...rows } as never)
  // the first session's start makes the first change; each change loads the plugin again, whose start makes the next
  for (let i = 0; i < 24; i++) await s.start(engine)
  expect(rows).toMatchObject({ minimal: true, ...PRESET })
  // turned off, what the rows held before comes back, in their new modes
  await settingsAction(engine, { do: 'set', key: 'minimal', value: false })
  for (let i = 0; i < 24; i++) await s.start(engine)
  expect(rows).toMatchObject({ minimal: false, citations: 'auto cite + verify', cards: 'auto', squeezeAnswers: true, catchUp: true, explain: 'auto', details: 'off', claimsMode: 'auto', labels: true, coverage: false })
  // settled once: a session after it changes nothing
  await s.start(engine)
  expect(rows.minimal).toBe(false)
  setOptions({})
})

test("Minimal saved on by 0.10.4 to 0.10.7: the first session after the update sets its modes now, and off puts back the modes it kept then and what the other rows held; a row changed elsewhere since turns it off", async () => {
  // as 0.10.7 left them: Minimal on, its four rows at its modes then, Cards still the switch it was, and the modes
  // Minimal kept of its rows in the store
  const rows: Record<string, boolean | string> = { minimal: true, citations: 'manual', cards: true, squeezeAnswers: true, catchUp: true, explain: 'on demand', details: 'on demand', claimsMode: 'on demand', labels: true, coverage: true, defaultsAt: DEFAULTS.at }
  const store = new Map<string, unknown>([['beforeMinimal', { citations: 'auto cite + verify', explain: 'auto', details: 'off', claimsMode: 'auto' }]])
  const engine = settleEngine(rows, store)
  const s = sessions()
  registerSettings(s.on, { ...rows } as never)
  for (let i = 0; i < 24; i++) await s.start(engine)
  expect(rows).toMatchObject({ minimal: true, ...PRESET })
  expect(choiceOf('citations')).toBe('auto cite')
  expect(choiceOf('cards')).toBe('on demand')
  for (const k of ['claims', 'labels', 'coverage', 'squeezeAnswers', 'catchUp']) expect(featureOn(k)).toBe(false)
  await settingsAction(engine, { do: 'set', key: 'minimal', value: false })
  for (let i = 0; i < 24; i++) await s.start(engine)
  expect(rows).toMatchObject({ minimal: false, citations: 'auto cite + verify', cards: 'auto', squeezeAnswers: true, catchUp: true, explain: 'auto', details: 'off', claimsMode: 'auto', labels: true, coverage: true })
  // Minimal on, its modes kept, and a row changed elsewhere (/config) since: off, as before
  Object.assign(rows, { minimal: true, citations: 'manual', cards: 'auto', explain: 'auto', details: 'on demand', claimsMode: 'on demand' })
  store.set('beforeMinimal', { citations: 'auto cite', explain: 'auto', details: 'auto', claimsMode: 'auto' })
  s.reset()
  registerSettings(s.on, { ...rows } as never)
  await s.start(engine)
  expect(rows).toMatchObject({ minimal: false, citations: 'manual', explain: 'auto', details: 'on demand', claimsMode: 'on demand', labels: true, coverage: true })
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
  const rows: Record<string, boolean | string> = { citations: 'auto cite', cards: 'auto' }
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
  registerSettings(on, { citations: 'auto cite', marks: true, citationChecks: 'auto', cards: 'auto' } as never)
  expect(choiceOf('citations')).toBe('auto cite + verify')
  await call('session.start', { isInteractive: true })
  expect(set.map(e => [e.key, e.value])).toEqual([['thimble@inline.citations', 'auto cite + verify'], ['thimble@inline.citationChecks', 'on demand']])
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
  expect(set.map(e => [String(e.key).split('.').pop(), e.value])).toEqual([['squeezeAnswers', false], ['catchUp', false], ['labels', false], ['coverage', false], ['squeeze', true], ['counts', true], ['squeezeCards', true]])
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
  expect(set.map(e => [String(e.key).split('.').pop(), e.value])).toEqual([['citations', 'auto cite + verify'], ['claimsMode', 'off'], ['claims', true]])
  expect(choiceOf('citations')).toBe('auto cite + verify')
  // no default moves: auto cite, which the installer saved as 0.10.3's default, stays, and the first session saves
  // nothing, so Claude Code does not load the plugin again for it; defaultsAt is hidden from /config
  set.length = 0
  Object.assign(rows, { citations: 'auto cite' })
  for (const k of Object.keys(hooks)) delete hooks[k]
  registerSettings(on, { citations: 'auto cite', defaultsAt: 'none' } as never)
  await call('session.start', { isInteractive: true })
  expect(set).toEqual([])
  expect(choiceOf('citations')).toBe('auto cite')
  expect((await call('config.describe', { key: 'thimble@inline.defaultsAt', label: 'x', isHidden: false })).isHidden).toBe(true)
  set.length = 0
  for (const k of Object.keys(hooks)) delete hooks[k]
  registerSettings(on, { citations: 'auto cite', defaultsAt: DEFAULTS.at } as never)
  await call('session.start', { isInteractive: true })
  expect(set).toEqual([])
  expect(choiceOf('citations')).toBe('auto cite')
  setOptions({})
})

test("/config hides Checker and its Effort on Bedrock, Vertex or Foundry (a variable set to a true value), whose model ids are not the first-party API's; elsewhere they show", async () => {
  const hooks: Record<string, Any[]> = {}
  const on: Any = (event: string, a: Any, b?: Any) => {
    ;(hooks[event] ??= []).push(typeof a === 'function' ? a : b)
    const reg: Any = { catch: () => reg }
    return reg
  }
  let env: Record<string, string> = {}
  const $: Any = { plugin: { name: 'thimble' }, env: { get: async (name: string) => env[name] } }
  const hidden = async (key: string) => {
    const chain = hooks['config.describe'] ?? []
    const run = (i: number, ev: Any): Any => (i < chain.length ? chain[i]($, ev, (x: Any) => run(i + 1, x)) : ev)
    return (await run(0, { key, label: 'x', isHidden: false })).isHidden
  }
  registerSettings(on, { checkerModel: 'Haiku 5.5' } as never)
  const cases: [Record<string, string>, boolean][] = [
    [{ CLAUDE_CODE_USE_BEDROCK: '1' }, true], [{ CLAUDE_CODE_USE_VERTEX: 'yes' }, true], [{ CLAUDE_CODE_USE_FOUNDRY: 'TRUE' }, true],
    [{ CLAUDE_CODE_USE_BEDROCK: '0' }, false], [{}, false],
  ]
  for (const [vars, hides] of cases) {
    env = vars
    expect(await hidden('thimble@inline.checkerModel')).toBe(hides)
    expect(await hidden('thimble@inline.checkerEffort')).toBe(hides)
    expect(await hidden('thimble@inline.citations')).toBe(false)
  }
  setOptions({})
})

test('a default that moves is saved once, where the old default stands, with defaultsAt; a value set afterwards stays', async () => {
  const hooks: Record<string, { fn: Any }[]> = {}
  const on: Any = (event: string, a: Any, b?: Any) => {
    ;(hooks[event] ??= []).push({ fn: typeof a === 'function' ? a : b })
    const reg: Any = { catch: () => reg }
    return reg
  }
  const call = (event: string, e: Any) => {
    const chain = hooks[event] ?? []
    const run = (i: number, ev: Any): Any => (i < chain.length ? chain[i]!.fn($, ev, (x: Any) => run(i + 1, x)) : ev)
    return run(0, e)
  }
  const rows: Record<string, boolean | string> = { citations: 'auto cite', cards: 'auto', defaultsAt: 'none' }
  const set: Any[] = []
  const $: Any = {
    plugin: { name: 'thimble' },
    config: {
      list: async () => Object.entries(rows).map(([k, v]) => ({ key: `thimble@inline.${k}`, value: v, isLocked: false })),
      set: async (e: Any) => { set.push(e); rows[String(e.key).split('.').pop()!] = e.value; return {} },
    },
  }
  const was = { at: DEFAULTS.at, moved: DEFAULTS.moved }
  // a later release that moves Citations' default from auto cite
  Object.assign(DEFAULTS, { at: '0.10.9', moved: { citations: { from: 'auto cite', to: 'auto cite + verify' } } })
  try {
    registerSettings(on, { ...rows } as never)
    await call('session.start', { isInteractive: true })
    expect(set.map(e => [String(e.key).split('.').pop(), e.value])).toEqual([['citations', 'auto cite + verify'], ['defaultsAt', '0.10.9']])
    expect(choiceOf('citations')).toBe('auto cite + verify')
    // the person sets the old default again: it stays, at this session's start and the next
    for (const k of Object.keys(hooks)) delete hooks[k]
    rows.citations = 'auto cite'
    set.length = 0
    registerSettings(on, { ...rows } as never)
    await call('session.start', { isInteractive: true })
    expect(set).toEqual([])
    expect(choiceOf('citations')).toBe('auto cite')
  } finally {
    Object.assign(DEFAULTS, was)
    setOptions({})
  }
})
