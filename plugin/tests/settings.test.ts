// The settings pane: /thimble-settings opens it, its rows in the order of their keys on the bar, a thin line between
// groups; a press on a choice sets it through Claude Code ($.config.set) and the preview of the bar follows; ↑ and ↓
// move the pick over the rows, and tab along a row's choices; Minimal mode sets the modes of its preset, and off brings
// back what the rows held; a mode saved under its old name reads as its new one. All data is made up.
// `claude plugin test plugin`.
import { expect, mock } from 'claude-code/testing'

import { PRESET, setOptions } from '../settings/features.mjs'
import { test } from './kit'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function textOf(n: Any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join('')
  return textOf(n.props?.children) + textOf(n.children)
}

/** The pane docked, `cols` wide. */
const paneAt = (cols: number) => ({ plugin: 'thimble', component: 'Pane', surface: 'terminal', requestId: 'thimble', props: { title: 'thimble settings', isFocused: true, bodyColumns: cols, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } }) as never
const PANE = paneAt(80)

/** A drawing's nodes, in the order drawn. */
function nodesOf(n: Any, out: Any[] = []): Any[] {
  if (n == null || typeof n !== 'object') return out
  if (Array.isArray(n)) { for (const x of n) nodesOf(x, out); return out }
  out.push(n)
  nodesOf(n.props?.children, out)
  nodesOf(n.children, out)
  return out
}
/** The first node of a drawing with this key, or undefined. */
const keyed = (n: Any, key: string): Any => nodesOf(n).find(x => x.props?.key === key)
/** The rows and the lines between groups, by their keys, in the order drawn. */
const rowKeys = (n: Any): string[] => nodesOf(n).map(x => String(x.props?.key ?? '')).filter(k => /^(sw|rule)-/.test(k))
/** Whether a row's line stands after its choices, on the row's own line. */
const besideOf = (n: Any, k: string): boolean => !!keyed(keyed(keyed(n, `sw-${k}`), 'line'), `says-${k}`)
/** The rows tinted as picked. */
const tintedIn = (n: Any): string[] => nodesOf(n).filter(x => /^sw-/.test(String(x.props?.key ?? '')) && x.props.backgroundColor).map(x => String(x.props.key).slice(3))

test('/thimble-settings opens the settings in the order of their keys on the bar, a thin line between groups and no headings, each key after its name as the bar draws it; a press on a choice sets it through Claude Code, and its items leave the preview', async ($, on) => {
  mock.env(on, { THIMBLE_HOME: '/made-up/.thimble', HOME: '/made-up/home', TMPDIR: '/made-up/tmp' })
  mock.clock(on, { now: 0 })
  const rows: Record<string, boolean | string> = { cards: 'auto', coverage: true, labels: true }
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
  for (const h of ['Settings', '↑↓ setting · tab choice']) expect(await pane.find({ type: 'Text', text: h })).toBeDefined()
  for (const h of ['ANSWERS', 'COMMENTS', 'PANES']) expect(await pane.find({ type: 'Text', text: h })).toBeUndefined()
  // Minimal mode first, then the rows in the order of their keys on the bar, a thin line over each group but the first
  const tree = await $.ui.render(PANE)
  expect(rowKeys(tree)).toEqual(['sw-minimal', 'rule-cards', 'sw-cards', 'rule-rewrites', 'sw-squeezeAnswers', 'sw-catchUp', 'rule-citations', 'sw-citations', 'sw-checkerModel', 'sw-checkerEffort', 'rule-comments', 'sw-explain', 'sw-details', 'rule-panes', 'sw-labels', 'sw-claimsMode', 'sw-coverage'])
  expect(textOf(keyed(tree, 'rule-cards'))).toMatch(/^─+$/)
  // every row from the pane's left edge, its key after its name, its choices in a column of their own; the settings
  // under Citations two cells in, with no key and no line of their own
  expect(textOf(keyed(tree, 'sw-minimal'))).toMatch(/^Minimal mode {2,}on · off/)
  expect(textOf(keyed(tree, 'sw-cards'))).toMatch(/^Cards v {2,}auto · on demand · off/)
  expect(textOf(keyed(tree, 'sw-details'))).toMatch(/^Heads-ups {2,}auto · off/)
  expect(textOf(keyed(tree, 'sw-checkerModel'))).toMatch(/^ {2}Verifier model {2,}same as Claude · /)
  expect(textOf(keyed(tree, 'sw-checkerEffort'))).toMatch(/^ {2}Verifier effort {2,}same as Claude · /)
  const column = (k: string) => textOf(keyed(tree, `sw-${k}`)).search(/(on · off|auto|same as Claude)/)
  expect(new Set(['minimal', 'cards', 'citations', 'checkerModel', 'details', 'coverage'].map(column)).size).toBe(1)
  expect(keyed(tree, 'says-checkerModel')).toBeUndefined()
  expect(keyed(tree, 'says-checkerEffort')).toBeUndefined()
  // each key as the bar's preview draws it: e in the explainers' color, the others in thimble's
  const lookOf = (k: string) => nodesOf(keyed(tree, 'preview')).find(x => x.type === 'Text' && textOf(x) === k)?.props
  const letterOf = (row: string) => keyed(tree, `switch-${row}`).children[1]
  for (const [row, k] of [['explain', 'e'], ['cards', 'v'], ['citations', 'c'], ['squeezeAnswers', 's'], ['coverage', 'r']]) {
    expect(textOf(letterOf(row))).toBe(` ${k}`)
    expect(letterOf(row).props).toMatchObject({ bold: true, color: lookOf(k)!.color })
  }
  expect(lookOf('e')!.color).not.toBe(lookOf('v')!.color)
  for (const row of ['minimal', 'details', 'checkerModel', 'checkerEffort']) expect(letterOf(row)).toBeUndefined()
  // one line on what the one set gives: in a pane this narrow, under the choices
  expect((await pane.find({ key: 'says-coverage' }))?.text).toContain('Which files Claude has read')
  expect(['minimal', 'cards', 'squeezeAnswers', 'catchUp', 'citations', 'explain', 'details', 'labels', 'claimsMode', 'coverage'].some(k => besideOf(tree, k))).toBe(false)
  // as wide as the pane in the mockup: in a group mostly of switches (on · off), each line after its row's choices,
  // as each of the group's lines fits there; in the others, under them
  const wide = await $.ui.render(paneAt(110))
  for (const k of ['minimal', 'squeezeAnswers', 'catchUp', 'labels', 'claimsMode', 'coverage']) expect([k, besideOf(wide, k)]).toEqual([k, true])
  for (const k of ['cards', 'citations', 'explain', 'details']) expect([k, besideOf(wide, k)]).toEqual([k, false])
  expect(textOf(keyed(wide, 'sw-claimsMode'))).toMatch(/^Claims w {2,}auto · on demand · off {2}No Claims pane\.$/)
  expect(await pane.find({ type: 'Text', text: /^ coverage$/ })).toBeDefined()
  // the preview's keys: s simplify right after v visualize, as on the bar
  expect(textOf(await $.ui.render(PANE))).toContain('v visualize · s simplify')

  await pane.press({ key: 'mode-coverage-off' })
  // the change alone: nothing else is saved (each save loads the plugin again)
  expect(set).toEqual([expect.objectContaining({ key: 'thimble@inline.coverage', value: false })])
  expect((await pane.find({ key: 'says-coverage' }))?.text).toContain('No Coverage pane')
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

test('Minimal mode is a preset: on, it sets Citations auto, Cards on demand, Explainers and Heads-ups auto, and Simplify, Catch-up, Claims, Labels and Coverage off, which the rows and the preview show; off puts back what they had', async ($, on) => {
  const rows: Record<string, boolean | string> = { minimal: false, citations: 'auto + verify', cards: 'auto', squeezeAnswers: true, catchUp: false, explain: 'on demand', details: 'off', claimsMode: 'auto', labels: true, coverage: true }
  const set = settingsWorld(on, rows)
  await $.command.run({ command: 'thimble-settings', args: '' } as never)
  const pane = await $.ui.mount(PANE)
  // first, its name and what it does in plain words
  expect((await pane.find({ key: 'sw-minimal' }))?.text).toMatch(/^Minimal mode\s+on · off/)
  expect((await pane.find({ key: 'says-minimal' }))?.text).toContain('Plain answers')
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
  expect((await pane.find({ key: 'sw-citations' }))?.text).toContain('auto + verify · auto · manual · off')
  expect((await pane.find({ key: 'says-citations' }))?.text).toContain('checks a citation when you open it')
  expect((await pane.find({ key: 'says-cards' }))?.text).toContain('only when you ask for one')
  expect((await pane.find({ key: 'says-explain' }))?.text).toContain('terms you may not know')
  expect((await pane.find({ key: 'says-squeezeAnswers' }))?.text).toContain('No simpler versions.')
  expect((await pane.find({ key: 'says-claimsMode' }))?.text).toContain('No Claims pane.')
  // the preview: v still acts, and c, e and a on selected words; the keys of what Minimal turned off are gone
  for (const w of [/^ visualize$/, /^ cite$/, /^ explain$/, /^ ask$/]) expect(await pane.find({ type: 'Text', text: w })).toBeDefined()
  for (const w of [/^ simplify$/, /^ catch up$/, /^ claims$/, /^ coverage$/, /^ labels$/]) expect(await pane.find({ type: 'Text', text: w })).toBeUndefined()
  await pane.press({ key: 'mode-minimal-off' })
  await settleAll($)
  expect(rows).toMatchObject({ minimal: false, citations: 'auto + verify', cards: 'auto', squeezeAnswers: true, catchUp: false, explain: 'on demand', details: 'off', claimsMode: 'auto', labels: true, coverage: true })
  for (const w of [/^ simplify$/, /^ claims$/, /^ coverage$/]) expect(await pane.find({ type: 'Text', text: w })).toBeDefined()
  await pane.unmount()
  setOptions({})
})

/** The settings an install updated from 0.10.12 holds: modes the person set, which are not the defaults. */
const UPDATED: Record<string, boolean | string> = { minimal: false, citations: 'manual', cards: 'on demand', squeezeAnswers: true, catchUp: true, explain: 'auto', details: 'auto', claimsMode: 'on demand', labels: false, coverage: true }

// settings.json still holds the fields that the manifest had until 0.10.12, here with values an older release saved
test('an install updated from 0.10.12 keeps the settings the person set: its session start saves nothing, and what the fields of the old manifest still hold changes nothing', { options: { ...UPDATED, marks: false, citationChecks: 'off', squeeze: false, counts: false, claims: false, defaultsAt: 'none' } }, async ($, on) => {
  const set = settingsWorld(on, { ...UPDATED })
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true })
  expect(set).toEqual([])
  await $.command.run({ command: 'thimble-settings', args: '' } as never)
  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ key: 'says-citations' }))?.text).toContain('Select words and press c')
  expect((await pane.find({ key: 'says-cards' }))?.text).toContain('only when you ask for one')
  expect((await pane.find({ key: 'says-squeezeAnswers' }))?.text).toContain('shorter, plainer version')
  expect((await pane.find({ key: 'says-claimsMode' }))?.text).toContain('when you press f in the pane')
  expect((await pane.find({ key: 'says-labels' }))?.text).toContain('No Labels pane')
  await pane.unmount()
  setOptions({})
})

test('↑ and ↓ pick the rows in their order, the Verifier rows too while Citations is on, which ↓ passes over once it is off; the ring onto another choice of the row picked sets it, and onto another row picks that row', async ($, on) => {
  const rows: Record<string, boolean | string> = { minimal: false, citations: 'auto + verify', cards: 'auto', squeezeAnswers: true, catchUp: true, explain: 'auto', details: 'auto', claimsMode: 'off', labels: true, coverage: false }
  const set = settingsWorld(on, rows)
  // where the ring lands, as Claude Code moves it
  const rings: Any[] = []
  on('ui.focus', (_$: unknown, e: Any) => { rings.push(e); return { value: undefined } })
  await $.command.run({ command: 'thimble-settings', args: '' } as never)
  const pane = await $.ui.mount(PANE)
  const picked = async () => tintedIn(await $.ui.render(PANE))
  // ↑ and ↓ reach a pane as scrolls of one row by the person
  const arrow = (by: number) => $.ui.scroll({ plugin: 'thimble', component: 'Pane', surface: 'terminal', requestId: 'thimble', by, origin: { kind: 'person' } } as never)
  // tab and shift+tab move the ring onto an element of the pane
  const ring = (element: string) => $.ui.focus({ plugin: 'thimble', component: 'Pane', surface: 'terminal', requestId: 'thimble', element, origin: { kind: 'person' } } as never)
  const seen: string[][] = []
  for (let i = 0; i < 12; i++) { seen.push(await picked()); await arrow(1) }
  expect(seen).toEqual([['minimal'], ['cards'], ['squeezeAnswers'], ['catchUp'], ['citations'], ['checkerModel'], ['checkerEffort'], ['explain'], ['details'], ['labels'], ['claimsMode'], ['coverage']])
  // the last row keeps the pick; ↑ goes back up
  expect(await picked()).toEqual(['coverage'])
  await arrow(-1)
  expect(await picked()).toEqual(['claimsMode'])
  // a click on Citations off picks its row; its Verifier rows go, and ↓ from it lands on Explainers
  await pane.press({ key: 'mode-citations-off' })
  expect(rows.citations).toBe('off')
  expect(await picked()).toEqual(['citations'])
  expect(rowKeys(await $.ui.render(PANE))).not.toContain('sw-checkerModel')
  await arrow(1)
  expect(await picked()).toEqual(['explain'])
  // tab moves the ring: onto another choice of the row picked, it sets it; onto a choice of another row, it picks that
  // row and lands on the choice set there, which changes nothing
  await ring('mode-explain-on demand')
  expect(set.at(-1)).toMatchObject({ key: 'thimble@inline.explain', value: 'on demand' })
  const before = set.length
  await ring('mode-details-off')
  expect(rings.at(-1)).toMatchObject({ element: 'mode-details-auto' })
  expect(set.length).toBe(before)
  expect(await picked()).toEqual(['details'])
  await pane.unmount()
  setOptions({})
})

test("Citations saved as auto cite, its name until 1.0, reads as auto: the pane shows auto set with its line, and the session's start saves auto", async ($, on) => {
  const rows: Record<string, boolean | string> = { ...UPDATED, citations: 'auto cite' }
  const set = settingsWorld(on, rows)
  await $.command.run({ command: 'thimble-settings', args: '' } as never)
  const pane = await $.ui.mount(PANE)
  const tree = await $.ui.render(PANE)
  expect(keyed(tree, 'mode-citations-auto').children[0].props).toMatchObject({ bold: true, color: 'success' })
  expect((await pane.find({ key: 'says-citations' }))?.text).toContain('checks a citation when you open it')
  // the Verifier rows show, as Claude cites
  expect(rowKeys(tree)).toContain('sw-checkerModel')
  await pane.unmount()
  await $.session.start({ cwd: '/made-up/data', surface: 'terminal', isInteractive: true })
  expect(set).toEqual([expect.objectContaining({ key: 'thimble@inline.citations', value: 'auto' })])
  expect(rows.citations).toBe('auto')
  setOptions({})
})
