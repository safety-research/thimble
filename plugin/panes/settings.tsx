// settings.tsx: the settings pane (core/pane.ts kind `settings`): /thimble-settings, or a click on `thimble` in the
// bar, opens it. Its top row says `Settings` (core/pane.ts); under it the bar as the settings leave it (bar.tsx, drawn as
// a preview in a frame: nothing in it presses), then Minimal, then the settings under their headings (Answers,
// Comments, Panes), every row the same: the name in a column of its own, its choices (`on · off` for a switch; the one
// set green and bold, the others gray), and under them, gray, what the one set gives (its `says`). Minimal reads
// `MINIMAL MODE  on · off`, and under it what it does (its `says.on`, whichever is set); turning it on sets the rows
// it changes to its modes (settings/features.mjs PRESET), which they show, and off puts back theirs. The row picked is
// tinted across the pane, with no mark of its own (a `›` there read as a row that opens), and the pane keeps that row
// and its line in view at any height (core/pane.ts keepsInView), as the pick moves with ↑ and ↓. A setting that
// changes the work of another feature (`under`: Checker and its Effort, the checks of Citations) shows only while that
// feature is on, as nothing it sets runs otherwise; ↑ and ↓ pass over it then. One that names first-party model ids or
// their effort (`firstParty`: Checker, Effort) shows only where Claude Code reaches Claude through Anthropic's
// first-party API (settings/term.ts firstPartyApi). A choice shows as the setting names it (`labels`: Checker's models
// with their versions, `Haiku 5.5`), and Effort offers the levels Claude Code offers for the model Checker names
// (settings/features.mjs choicesIn).
//
// ↑ and ↓ pick a row (core/pane.ts arrowsOwn: Claude Code sends them as scrolls), and the focus ring lands on its
// choice set. ← and → (or tab) move the ring along the row's choices, and the ring landing on one sets it (settingsFocus,
// the ui.focus hook); onto another row it lands on that row's choice set, which changes nothing. A click on a choice
// sets it and picks its row, a click on a name picks its row; ↵ on a choice sets it. A change goes through Claude Code
// (settings/term.ts settingsAction), which keeps the value and loads the plugin again with it; the pane and the bar
// draw it at once.
import type { EngineInterface } from 'claude-code'

import { barRows } from '../bar/bar'
import { arrowsOwn, keepsInView, PANE_ID } from '../core/pane'
import { treeRows } from '../core/trail.mjs'
import { choicesIn, SWITCHES, switchesFrom } from '../settings/features.mjs'
import { firstPartyApi, heldValues, settingsAction } from '../settings/term'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Engine = EngineInterface
type Switch = { key: string; title: string; group?: string; under?: string; firstParty?: boolean; choices?: string[]; labels?: Record<string, string>; says?: Record<string, string> }

/** The row picked, kept across the plugin's loads (each change loads it again). */
const PICKED = { plugin: 'thimble', key: 'settingsRow' } as const
/** The tint of the row picked, as the coverage pane tints its row. */
const SEL_TINT = 'userMessageBackground'
/** Where the choices start: the row's indent and the name's column. */
const NAME = 11
const IN = 2 + NAME + 1
/** Minimal's name, wider than the column: its choices, and the line under them, start after it. */
const MINIMAL_TITLE = 'MINIMAL MODE '

const ROWS = SWITCHES as Switch[]
/** A feature's choices as the pane offers them with `values` (Effort: the levels of the model Checker names): its
 *  modes, or on and off; with no values, every mode it has. */
const choicesOf = (s: Switch, values?: Record<string, unknown>) => (s.choices ? (values ? choicesIn(s.key, values) as string[] : s.choices) : ['on', 'off'])
/** The choice set, as the setting holds it. */
const shownOf = (s: Switch, v: unknown) => (s.choices ? String(v) : v ? 'on' : 'off')
/** A choice in the words the pane draws: its label (`Haiku 5.5`), or its value. */
const labelOf = (s: Switch, c: string) => s.labels?.[c] ?? c
/** A choice's element key, and the feature and choice it names. */
const choiceKey = (s: Switch, c: string) => `mode-${s.key}-${c}`
function parseKey(key: string | undefined): { s: Switch; c: string | null } | null {
  if (!key) return null
  for (const s of ROWS) {
    if (key === `switch-${s.key}`) return { s, c: null }
    for (const c of choicesOf(s)) if (key === choiceKey(s, c)) return { s, c }
  }
  return null
}

/** The rows shown with these values: a setting `under` a feature that is off is not, nor one of first-party model ids
 *  off the first-party API (`firstParty`). */
const shownRows = (values: Record<string, unknown>, firstParty: boolean) =>
  ROWS.filter(s => (!s.under || switchesFrom(values)(s.under)) && (firstParty || !s.firstParty))

/** The row picked, of the rows shown: one picked that does not show now stands for the feature it is under. */
async function pickedNow($: Engine, rows?: Switch[]): Promise<string> {
  const shown = rows ?? shownRows(await heldValues($), await firstPartyApi($))
  const k = (await $.state.get(PICKED)).value as string | undefined
  if (shown.some(s => s.key === k)) return k!
  const under = ROWS.find(s => s.key === k)?.under
  return shown.some(s => s.key === under) ? under! : shown[0]!.key
}

/** Set a choice: on and off are a switch's true and false. */
async function choose($: Engine, s: Switch, c: string): Promise<void> {
  const said = await settingsAction($, { do: 'set', key: s.key, value: s.choices ? c : c === 'on' })
  if (typeof said === 'string' && said) $.ui.toast(said)
}

/** A click on a choice: its row is picked and the ring lands on the choice now set, as ← → leave it; a click does not
 *  move the ring by itself, which stayed on the row picked before and drew there as a second choice set. */
async function chooseHere($: Engine, s: Switch, c: string): Promise<void> {
  await choose($, s, c)
  await pick($, s)
}

/** Pick a row, and land the ring on its choice set. */
async function pick($: Engine, s: Switch): Promise<void> {
  await $.state.set(PICKED, s.key)
  const v = (await heldValues($))[s.key]
  await $.ui.focus({ requestId: PANE_ID, key: choiceKey(s, shownOf(s, v)) } as Any).catch(() => undefined)
  $.ui.invalidate('ui.render')
}

/** The ring moving in the pane (the ui.focus hook, core/pane.ts): onto a choice of the row picked, it sets that choice;
 *  onto another row, it picks that row and lands on its choice set. */
export async function settingsFocus($: Engine, e: { element?: string; origin?: { kind?: string } }, next: (e: Any) => Promise<Any>): Promise<Any> {
  const to = parseKey(e.element)
  if (!to || e.origin?.kind !== 'person') return next(e)
  const picked = await pickedNow($)
  const v = (await heldValues($))[to.s.key]
  if (to.s.key === picked && to.c) {
    if (to.c !== shownOf(to.s, v)) await choose($, to.s, to.c)
    return next(e)
  }
  await $.state.set(PICKED, to.s.key)
  $.ui.invalidate('ui.render')
  return next({ ...e, element: choiceKey(to.s, shownOf(to.s, v)) })
}

export async function drawSettings($: Engine, e: Any, _args: unknown, els: Any): Promise<unknown> {
  const { Box, Button, Text } = els
  const width = Math.max(30, Number(e.props?.bodyColumns) || 60)
  const values = await heldValues($)
  const shown = shownRows(values, await firstPartyApi($))
  const picked = await pickedNow($, shown)
  const at = shown.findIndex(s => s.key === picked)
  arrowsOwn(dir => pick($, shown[Math.max(0, Math.min(shown.length - 1, at + dir))]!))
  const bar = await barRows($, els, width - 4, { on: switchesFrom(values), preview: true })
  const rows = shown.flatMap((s, i) => {
    const set = shownOf(s, values[s.key])
    const here = s.key === picked
    const head = s.group && shown[i - 1]?.group !== s.group
      ? [Box({ key: `group-${s.group}`, marginTop: 1, children: [Text({ bold: true, dimColor: true, children: s.group.toUpperCase() })] })]
      : []
    const choices = choicesOf(s, values).flatMap((c, k) => [
      ...(k ? [Text({ key: `sep-${c}`, dimColor: true, children: ' · ' })] : []),
      Button({ key: choiceKey(s, c), plain: true, label: `${s.title}: ${labelOf(s, c)}`, onPress: () => chooseHere($, s, c), ...(here && c === set ? { autoFocus: true } : {}), children: [
        Text({ key: 'w', ...(c === set ? { bold: true, color: 'success' } : { dimColor: true }), children: labelOf(s, c) }),
      ] }),
    ])
    // Minimal stands over the rows as a heading would, what it does under it
    const minimal = s.key === 'minimal'
    const says = minimal ? s.says?.on : s.says?.[set]
    const at = minimal ? 2 + MINIMAL_TITLE.length + 1 : IN
    return [...head, Box({ key: `sw-${s.key}`, flexDirection: 'column', width, ...(here ? { backgroundColor: SEL_TINT } : {}), children: [
      Box({ key: 'line', flexDirection: 'row', children: [
        Text({ key: 'mark', children: '  ' }),
        Button({ key: `switch-${s.key}`, plain: true, label: `${s.title}: ${labelOf(s, set)}`, onPress: () => pick($, s), children: [
          Text({ key: 'title', bold: true, children: minimal ? MINIMAL_TITLE : s.title.padEnd(NAME) }),
        ] }),
        Text({ key: 'gap', children: ' ' }),
        // the choices take the rest of the line, named, so the pane measures the rows they wrap onto as drawn
        Box({ key: 'choices', flexDirection: 'row', flexWrap: 'wrap', flexShrink: 1, width: Math.max(1, width - at), children: [
          ...choices,
        ] }),
      ] }),
      ...(says ? [Box({ key: `says-${s.key}`, marginLeft: at, width: width - at, children: [Text({ dimColor: true, wrap: 'wrap', children: says })] })] : []),
    ] })]
  })
  const preview = Box({ key: 'preview', flexDirection: 'column', borderStyle: 'round', borderDimColor: true, paddingX: 1, width, children: bar })
  // the row picked and the line under it stay in view in a pane of any height (core/pane.ts keepsInView)
  const mine = rows.findIndex((r: Any) => r?.props?.key === `sw-${picked}`)
  keepsInView(mine < 0 ? null : { key: `${picked}:${shownOf(shown[at]!, values[picked])}`, top: treeRows([preview, ...rows.slice(0, mine)], width), rows: treeRows(rows[mine], width) })
  return Box({ flexDirection: 'column', width, children: [
    preview,
    ...rows,
    Box({ key: 'foot', marginTop: 1, children: [Text({ dimColor: true, children: '↑↓ setting · ←→ choice' })] }),
  ] })
}
