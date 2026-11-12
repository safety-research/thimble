// settings.tsx: the settings pane (core/pane.ts kind `settings`): /thimble-settings, or a click on `thimble` in the
// bar, opens it. Its top row says `Settings` (core/pane.ts); under it the bar as the settings leave it (bar.tsx, drawn
// as a preview in a frame: nothing in it presses), then the settings in the order of their keys on the bar
// (settings/features.mjs SWITCHES), Minimal mode first, a thin line between one group and the next, and no headings.
// Every row is the same, from the pane's left edge: the name, then the key that acts for it on the bar, drawn as the
// bar draws it; in a column of their own its choices (`on · off` for a switch; the one set green and bold, the others
// gray); and, gray, one line on what the one set gives (its `says`). A group's rows lay out alike: in a group mostly of
// switches (on · off) each line stands after its row's choices, where each of the group's lines fits there; else each
// stands under its choices. Minimal mode's line is the same, whichever is set; turning it on sets the rows it changes
// to its modes (settings/features.mjs PRESET), which they show, and off puts back theirs, one row per load of the
// plugin, while Minimal mode shows the choice pressed (settings/term.ts shownValues). The row picked is tinted across
// the pane, with no mark of its own (a `›` there read as a row that opens), and the pane keeps that row and its line in
// view at any height (core/pane.ts keepsInView), as the pick moves with ↑ and ↓. A setting that changes the work of
// another feature (`under`: Verifier model and Verifier effort, the checks of Citations) stands two cells in under it,
// with no line of its own, and shows only while that feature is on, as nothing it sets runs otherwise; ↑ and ↓ pass
// over it then. One that names first-party model ids or their effort (`firstParty`: Verifier model, Verifier effort)
// shows only where Claude Code reaches Claude through Anthropic's first-party API (settings/term.ts firstPartyApi).
// Verifier effort offers the levels Claude Code offers for the model Verifier model names (settings/features.mjs
// choicesIn). Under the list, past a thin line and kept at the pane's bottom however far the rows scroll (core/pane.ts
// keepsAtFoot), the row picked says what it does and when you would change it: its name, then, gray, its `help`, the
// words /config starts its description with.
//
// ↑ and ↓ pick a row (core/pane.ts arrowsOwn: Claude Code sends them as scrolls), and the focus ring lands on its
// choice set. tab and shift+tab move the ring along the row's choices (Claude Code's keys for a pane's ring: a pane
// takes no ← or →), and the ring landing on one sets it (settingsFocus, the ui.focus hook); onto another row it lands
// on that row's choice set, which changes nothing. A click on a choice sets it and picks its row, a click on a name
// picks its row; ↵ on a choice sets it. A change goes through Claude Code (settings/term.ts settingsAction), which
// keeps the value and loads the plugin again with it; the pane and the bar draw it at once.
import type { EngineInterface } from 'claude-code'

import { barRows, keyLooks } from '../bar/bar'
import { arrowsOwn, keepsAtFoot, keepsInView, PANE_ID } from '../core/pane'
import { textWidth } from '../core/text.js'
import { treeRows } from '../core/trail.mjs'
import { choicesIn, SWITCHES, switchesFrom } from '../settings/features.mjs'
import { firstPartyApi, heldValues, settingsAction, shownValues } from '../settings/term'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Engine = EngineInterface
type Switch = { key: string; title: string; group?: string; letter?: string; under?: string; firstParty?: boolean; choices?: string[]; says?: Record<string, string>; help: string }

/** The row picked, kept across the plugin's loads (each change loads it again). */
const PICKED = { plugin: 'thimble', key: 'settingsRow' } as const
/** The tint of the row picked, as the coverage pane tints its row. */
const SEL_TINT = 'userMessageBackground'
/** What stands between choices, and between the choices and a line beside them. */
const DOT = ' · '
const GAP = '  '

const ROWS = SWITCHES as Switch[]
/** A row's name as drawn: two cells in for a setting under another, its key after it. */
const nameWidth = (s: Switch) => (s.under ? 2 : 0) + textWidth(s.title) + (s.letter ? 1 + textWidth(s.letter) : 0)
/** Where the choices start: after the widest name, of every row (so they stand where they stood when a row shows or
 *  hides), and two cells. The docked pane is 89 cells wide at most, which leaves 70 for a line under the choices. */
const NAME = Math.max(...ROWS.map(nameWidth)) + 2

/** A feature's choices as the pane offers them with `values` (Verifier effort: the levels of the model Verifier model
 *  names): its modes, or on and off; with no values, every mode it has. */
const choicesOf = (s: Switch, values?: Record<string, unknown>) => (s.choices ? (values ? choicesIn(s.key, values) as string[] : s.choices) : ['on', 'off'])
/** The choice set, as the pane names it. */
const shownOf = (s: Switch, v: unknown) => (s.choices ? String(v) : v ? 'on' : 'off')
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

/** Whether the lines of a group's rows stand after their choices: most of its rows that have a line are switches
 *  (on · off), and each row's line fits after its choices in `room` cells. Else each stands under its row's choices,
 *  so the rows of a group line up alike. */
function besideIn(group: Switch[], values: Record<string, unknown>, room: number): boolean {
  const said = group.filter(s => s.says)
  if (said.filter(s => !s.choices).length * 2 <= said.length) return false
  return said.every(s => textWidth(choicesOf(s, values).join(DOT)) + GAP.length + textWidth(s.says![shownOf(s, values[s.key])] ?? '') <= room)
}

/** The row picked, of the rows shown: one picked that does not show now stands for the feature it is under. */
async function pickedNow($: Engine, rows?: Switch[]): Promise<string> {
  const shown = rows ?? shownRows(await heldValues($), await firstPartyApi($))
  const k = (await $.state.get(PICKED)).value as string | undefined
  if (shown.some(s => s.key === k)) return k!
  const under = ROWS.find(s => s.key === k)?.under
  return shown.some(s => s.key === under) ? under! : shown[0]!.key
}

/** Set a choice: on and off are a switch's true and false. Whether it was taken (a refusal is a toast). */
async function choose($: Engine, s: Switch, c: string): Promise<boolean> {
  const said = await settingsAction($, { do: 'set', key: s.key, value: s.choices ? c : c === 'on' })
  if (typeof said === 'string' && said) $.ui.toast(said)
  return !(typeof said === 'string' && said)
}

/** A click on a choice: its row is picked and the ring lands on the choice chosen, as tab leaves it (Minimal mode's
 *  is set last, after the rows it sets: settings/term.ts), or on the one set when it was refused; a click does not
 *  move the ring by itself, which stayed on the row picked before and drew there as a second choice set. */
async function chooseHere($: Engine, s: Switch, c: string): Promise<void> {
  await pick($, s, (await choose($, s, c)) ? c : undefined)
}

/** Pick a row, and land the ring on `c`, else its choice set. */
async function pick($: Engine, s: Switch, c?: string): Promise<void> {
  await $.state.set(PICKED, s.key)
  const v = (await shownValues($))[s.key]
  await $.ui.focus({ requestId: PANE_ID, key: choiceKey(s, c ?? shownOf(s, v)) } as Any).catch(() => undefined)
  $.ui.invalidate('ui.render')
}

/** The ring moving in the pane (the ui.focus hook, core/pane.ts): onto a choice of the row picked, it sets that choice;
 *  onto another row, it picks that row and lands on its choice set. */
export async function settingsFocus($: Engine, e: { element?: string; origin?: { kind?: string } }, next: (e: Any) => Promise<Any>): Promise<Any> {
  const to = parseKey(e.element)
  if (!to || e.origin?.kind !== 'person') return next(e)
  const picked = await pickedNow($)
  const v = (await shownValues($))[to.s.key]
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
  const values = await shownValues($)
  const shown = shownRows(values, await firstPartyApi($))
  const picked = await pickedNow($, shown)
  const at = shown.findIndex(s => s.key === picked)
  arrowsOwn(dir => pick($, shown[Math.max(0, Math.min(shown.length - 1, at + dir))]!))
  const bar = await barRows($, els, width - 4, { on: switchesFrom(values), preview: true })
  const keyLook = await keyLooks($)
  const room = Math.max(1, width - NAME)
  const beside = new Map<string | undefined, boolean>()
  for (const s of shown) if (!beside.has(s.group)) beside.set(s.group, besideIn(shown.filter(x => x.group === s.group), values, room))
  const rows = shown.flatMap((s, i) => {
    const set = shownOf(s, values[s.key])
    const here = s.key === picked
    // a thin line over each group but the first, in place of a heading
    const rule = i && shown[i - 1]!.group !== s.group ? [Box({ key: `rule-${s.group}`, children: [Text({ dimColor: true, children: '─'.repeat(width) })] })] : []
    // each choice with the dot after it, so a row the choices wrap onto starts with a choice, never with a dot
    const options = choicesOf(s, values)
    const choices = options.map((c, k) => Box({ key: `opt-${c}`, flexDirection: 'row', flexShrink: 0, children: [
      Button({ key: choiceKey(s, c), plain: true, label: `${s.title}: ${c}`, onPress: () => chooseHere($, s, c), ...(here && c === set ? { autoFocus: true } : {}), children: [
        Text({ key: 'w', ...(c === set ? { bold: true, color: 'success' } : { dimColor: true }), children: c }),
      ] }),
      ...(k < options.length - 1 ? [Text({ key: 'sep', dimColor: true, children: DOT })] : []),
    ] }))
    const says = s.says?.[set]
    const after = !!says && beside.get(s.group) === true
    return [...rule, Box({ key: `sw-${s.key}`, flexDirection: 'column', width, ...(here ? { backgroundColor: SEL_TINT } : {}), children: [
      Box({ key: 'line', flexDirection: 'row', children: [
        ...(s.under ? [Text({ key: 'in', children: '  ' })] : []),
        Button({ key: `switch-${s.key}`, plain: true, label: `${s.title}: ${set}`, onPress: () => pick($, s), children: [
          Text({ key: 'title', bold: true, children: s.title }),
          ...(s.letter ? [Text({ key: 'letter', ...keyLook(s.letter), children: ` ${s.letter}` })] : []),
        ] }),
        Text({ key: 'pad', children: ' '.repeat(Math.max(1, NAME - nameWidth(s))) }),
        // the choices take the rest of the line, named, so the pane measures the rows they wrap onto as drawn; a line
        // beside them fits after them (besideIn)
        after
          ? Box({ key: 'choices', flexDirection: 'row', flexShrink: 0, children: [...choices, Box({ key: `says-${s.key}`, children: [Text({ dimColor: true, children: `${GAP}${says}` })] })] })
          : Box({ key: 'choices', flexDirection: 'row', flexWrap: 'wrap', flexShrink: 1, width: room, children: choices }),
      ] }),
      ...(says && !after ? [Box({ key: `says-${s.key}`, marginLeft: NAME, width: room, children: [Text({ dimColor: true, wrap: 'wrap', children: says })] })] : []),
    ] })]
  })
  const preview = Box({ key: 'preview', flexDirection: 'column', borderStyle: 'round', borderDimColor: true, paddingX: 1, width, children: bar })
  // a blank row between the preview and the rows, as between the rows and the key row under them
  const body = [Text({ key: 'gap', children: ' ' }), ...rows]
  // the row picked and the line under it stay in view in a pane of any height (core/pane.ts keepsInView)
  const mine = body.findIndex((r: Any) => r?.props?.key === `sw-${picked}`)
  keepsInView(mine < 0 ? null : { key: `${picked}:${shownOf(shown[at]!, values[picked])}`, top: treeRows([preview, ...body.slice(0, mine)], width), rows: treeRows(body[mine], width) })
  // what the row picked does, at the pane's bottom under a thin line: its name as its row has it, then its help
  const row = shown[at]
  keepsAtFoot(row ? [
    Box({ key: 'help-rule', children: [Text({ dimColor: true, children: '─'.repeat(width) })] }),
    Box({ key: `help-${row.key}`, width, children: [Text({ wrap: 'wrap', children: [
      Text({ key: 'n', bold: true, children: row.title }),
      Text({ key: 'w', dimColor: true, children: `${GAP}${row.help}` }),
    ] })] }),
  ] : null)
  return Box({ flexDirection: 'column', width, children: [
    preview,
    ...body,
    Box({ key: 'foot', marginTop: 1, children: [Text({ dimColor: true, children: '↑↓ setting · tab choice' })] }),
  ] })
}
