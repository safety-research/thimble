// The settings pane: /thimble-settings opens it, a press on a choice sets it through Claude Code ($.config.set) and the
// preview of the bar follows; Minimal sets the modes of its preset, and off brings back what the rows held. All data is
// made up. `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { DEFAULTS, PRESET, setOptions } from '../settings/features.mjs'
import { test } from './kit'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const PANE = { plugin: 'thimble', component: 'Pane', surface: 'terminal', requestId: 'thimble', props: { title: 'thimble settings', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as never

test('/thimble-settings opens the settings under their headings; a press on a choice sets it through Claude Code, and its items leave the preview', async ($, on) => {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp' })
  mock.clock(on, { now: 0 })
  const rows: Record<string, boolean | string> = { marks: true, cards: 'auto', coverage: true, labels: true }
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
  for (const h of ['Settings', 'ANSWERS', 'COMMENTS', 'PANES', '↑↓ setting · tab choice']) expect(await pane.find({ type: 'Text', text: h })).toBeDefined()
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

/** What a press on Minimal starts, done: each change of it loads the plugin again, whose session start makes the next
 *  (settings/term.ts settleMinimal), as many times as it takes. */
async function settleAll($: Any): Promise<void> {
  for (let i = 0; i < 24; i++) await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true })
}

/** A settings pane over made-up rows that Claude Code keeps: config.set changes them, and the plugin's options follow. */
function settingsWorld(on: Any, rows: Record<string, boolean | string>): Any[] {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp' })
  mock.clock(on, { now: 0 })
  mock.store(on)
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

test('Minimal is a preset: on, it sets Citations auto cite, Cards on demand, Explainers and Heads-ups auto, and Simplify, Catch-up, Claims, Labels and Coverage off, which the rows and the preview show; off puts back what they had', async ($, on) => {
  const rows: Record<string, boolean | string> = { minimal: false, citations: 'auto cite + verify', cards: 'auto', squeezeAnswers: true, catchUp: false, explain: 'on demand', details: 'off', claimsMode: 'auto', labels: true, coverage: true, defaultsAt: DEFAULTS.at }
  const set = settingsWorld(on, rows)
  await $.command.run({ command: 'thimble-settings', args: '' } as never)
  const pane = await $.ui.mount(PANE)
  // first, its name and what it does in plain words
  expect((await pane.find({ key: 'sw-minimal' }))?.text).toMatch(/^\s*MINIMAL MODE\s+on · off/)
  expect((await pane.find({ key: 'says-minimal' }))?.text).toContain('In fullscreen, citations, explainers and heads-ups show only while the pointer is over their paragraph. Visualizations are shown only when requested. Simplify, Catch-up, Claims, Labels and Coverage are off.')
  for (const w of [/^ simplify$/, /^ claims$/, /^ coverage$/]) expect(await pane.find({ type: 'Text', text: w })).toBeDefined()
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
  expect((await pane.find({ key: 'says-squeezeAnswers' }))?.text).toContain('No simpler versions.')
  expect((await pane.find({ key: 'says-claimsMode' }))?.text).toContain('No Claims pane.')
  // the preview: v still acts, and c, e and a on selected words; the keys of what Minimal turned off are gone
  for (const w of [/^ visualize$/, /^ cite$/, /^ explain$/, /^ ask$/]) expect(await pane.find({ type: 'Text', text: w })).toBeDefined()
  for (const w of [/^ simplify$/, /^ catch up$/, /^ claims$/, /^ coverage$/, /^ labels$/]) expect(await pane.find({ type: 'Text', text: w })).toBeUndefined()
  await pane.press({ key: 'mode-minimal-off' })
  await settleAll($)
  expect(rows).toMatchObject({ minimal: false, citations: 'auto cite + verify', cards: 'auto', squeezeAnswers: true, catchUp: false, explain: 'on demand', details: 'off', claimsMode: 'auto', labels: true, coverage: true })
  for (const w of [/^ simplify$/, /^ claims$/, /^ coverage$/]) expect(await pane.find({ type: 'Text', text: w })).toBeDefined()
  await pane.unmount()
  setOptions({})
})
