// settings.tsx: the settings pane (core/pane.ts kind `settings`): /thimble-settings, or a click on `thimble` in the
// bar, opens it. Its top row says `Settings` (core/pane.ts); under it the bar as the settings leave it (bar.tsx, drawn as
// a preview in a frame: nothing in it presses), then Minimal, then the settings under their headings (Answers,
// Comments, Panes), every row the same: `›` on the row picked, the name in a column of its own, its choices (`on · off`
// for a switch; the one set green and bold, the others gray), and under them, gray, what the one set gives (its
// `says`). While Minimal is on, a row it changes says so after its choices (`→ on demand`), and under them what it does
// until Minimal is off; its own setting stays, and comes back then. The row picked is tinted across the pane.
//
// ↑ and ↓ pick a row (core/pane.ts arrowsOwn: Claude Code sends them as scrolls), and the focus ring lands on its
// choice set. ← and → (or tab) move the ring along the row's choices, and the ring landing on one sets it (settingsFocus,
// the ui.focus hook); onto another row it lands on that row's choice set, which changes nothing. A click on a choice
// sets it, a click on a name picks its row; ↵ on a choice sets it. A change goes through Claude Code (settings/term.ts
// settingsAction), which keeps the value and loads the plugin again with it; the pane and the bar draw it at once.
import type { EngineInterface } from 'claude-code'

import { barRows } from '../bar/bar'
import { arrowsOwn, PANE_ID } from '../core/pane'
import { SWITCHES, heldByMinimal, switchesFrom } from '../settings/features.mjs'
import { heldValues, settingsAction } from '../settings/term'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Engine = EngineInterface
type Switch = { key: string; title: string; group?: string; choices?: string[]; says?: Record<string, string> }

/** The row picked, kept across the plugin's loads (each change loads it again). */
const PICKED = { plugin: 'thimble', key: 'settingsRow' } as const
/** The tint of the row picked, as the coverage pane tints its row. */
const SEL_TINT = 'userMessageBackground'
/** Where the choices start: `› ` and the name's column. */
const NAME = 11
const IN = 2 + NAME + 1

const ROWS = SWITCHES as Switch[]
/** A feature's choices as the pane shows them: its modes, or on and off. */
const choicesOf = (s: Switch) => s.choices ?? ['on', 'off']
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

async function pickedNow($: Engine): Promise<string> {
  const k = (await $.state.get(PICKED)).value as string | undefined
  return ROWS.some(s => s.key === k) ? k! : ROWS[0]!.key
}

/** Set a choice: on and off are a switch's true and false. */
async function choose($: Engine, s: Switch, c: string): Promise<void> {
  const said = await settingsAction($, { do: 'set', key: s.key, value: s.choices ? c : c === 'on' })
  if (typeof said === 'string' && said) $.ui.toast(said)
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
  const picked = await pickedNow($)
  const at = ROWS.findIndex(s => s.key === picked)
  arrowsOwn(dir => pick($, ROWS[Math.max(0, Math.min(ROWS.length - 1, at + dir))]!))
  const bar = await barRows($, els, width - 4, { on: switchesFrom(values), preview: true })
  const held = heldByMinimal(values) as Record<string, string>
  const rows = ROWS.flatMap((s, i) => {
    const set = shownOf(s, values[s.key])
    const here = s.key === picked
    const head = s.group && ROWS[i - 1]?.group !== s.group
      ? [Box({ key: `group-${s.group}`, marginTop: 1, children: [Text({ bold: true, dimColor: true, children: s.group.toUpperCase() })] })]
      : []
    const choices = choicesOf(s).flatMap((c, k) => [
      ...(k ? [Text({ key: `sep-${c}`, dimColor: true, children: ' · ' })] : []),
      Button({ key: choiceKey(s, c), plain: true, label: `${s.title}: ${c}`, onPress: () => choose($, s, c), ...(here && c === set ? { autoFocus: true } : {}), children: [
        Text({ key: 'w', ...(c === set ? { bold: true, color: 'success' } : { dimColor: true }), children: c }),
      ] }),
    ])
    const by = held[s.key]
    const says = by ? `Minimal: ${by} until Minimal is off.` : s.says?.[set]
    return [...head, Box({ key: `sw-${s.key}`, flexDirection: 'column', width, ...(here ? { backgroundColor: SEL_TINT } : {}), children: [
      Box({ key: 'line', flexDirection: 'row', children: [
        Text({ key: 'mark', children: here ? '› ' : '  ' }),
        Button({ key: `switch-${s.key}`, plain: true, label: `${s.title}: ${set}`, onPress: () => pick($, s), children: [
          Text({ key: 'title', bold: true, children: s.title.padEnd(NAME) }),
        ] }),
        Text({ key: 'gap', children: ' ' }),
        Box({ key: 'choices', flexDirection: 'row', flexWrap: 'wrap', flexShrink: 1, children: [
          ...choices,
          ...(by ? [Text({ key: 'held', dimColor: true, children: `  → ${by}` })] : []),
        ] }),
      ] }),
      ...(says ? [Box({ key: `says-${s.key}`, marginLeft: IN, width: width - IN, children: [Text({ dimColor: true, wrap: 'wrap', children: says })] })] : []),
    ] })]
  })
  return Box({ flexDirection: 'column', width, children: [
    Box({ key: 'preview', flexDirection: 'column', borderStyle: 'round', borderDimColor: true, paddingX: 1, width, children: bar }),
    ...rows,
    Box({ key: 'foot', marginTop: 1, children: [Text({ dimColor: true, children: '↑↓ setting · ←→ choice' })] }),
  ] })
}
