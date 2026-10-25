// settings.tsx: the settings pane (core/pane.ts kind `settings`): /thimble-settings, or a click on `thimble` in the
// bar, opens it. At its top the bar as these switches leave it (bar.tsx, drawn as a preview: nothing in it presses),
// then the switches, each named by what the person gets; a group's (Comments: Explainers, Heads-ups) under its
// heading, indented. ↵ on a switch or a click
// turns it on or off through Claude Code (settings/term.ts settingsAction), which keeps the value and loads the plugin
// again with it; the pane and the bar draw the change at once. A feature with modes (Citations) names them after its
// title, the one set in bold: a click on one sets it, ↵ on the row goes to the next; a dim line under the row says what
// the mode set gives (its `says`). Tab walks the switches, esc closes the pane.
import type { EngineInterface } from 'claude-code'

import { barRows } from '../bar/bar'
import { SWITCHES, switchesFrom } from '../settings/features.mjs'
import { heldValues, settingsAction } from '../settings/term'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** Where a switch's words start: after `● on   `. */
const IN = 7

export async function drawSettings($: EngineInterface, e: Any, _args: unknown, els: Any): Promise<unknown> {
  const { Box, Button, Text } = els
  const width = Math.max(30, Number(e.props?.bodyColumns) || 60)
  const values = await heldValues($)
  const act = (a: Record<string, unknown>) => async () => {
    const said = await settingsAction($, a)
    if (typeof said === 'string' && said) $.ui.toast(said)
  }
  const bar = await barRows($, els, width - 4, { on: switchesFrom(values), preview: true })
  const rows = SWITCHES.flatMap((s, i) => {
    const v = values[s.key]
    const on = typeof v === 'string' ? v !== 'off' : !!v
    const choices: string[] = (s as { choices?: string[] }).choices ?? []
    const group = (s as { group?: string }).group
    const says = (s as { says?: Record<string, string> }).says
    const opens = group && (SWITCHES[i - 1] as { group?: string } | undefined)?.group !== group
    const head = opens ? [Box({ key: `group-${group}`, marginTop: 1, children: [Text({ bold: true, children: group })] })] : []
    // a feature with modes: each mode after the title, the one set in bold, each a press that sets it
    const modes = choices.flatMap((c, k) => [
      ...(k ? [Text({ key: `sep-${c}`, dimColor: true, children: ' · ' })] : []),
      Button({ key: `mode-${s.key}-${c}`, plain: true, label: `${s.title}: ${c}`, onPress: act({ do: 'set', key: s.key, value: c }), children: [
        Text({ key: 'w', ...(c === v ? { bold: true, color: on ? 'success' : undefined } : { dimColor: true }), children: c }),
      ] }),
    ])
    return [...head, Box({ key: `sw-${s.key}`, flexDirection: 'row', flexWrap: 'wrap', marginTop: opens ? 0 : 1, ...(group ? { marginLeft: 2 } : {}), children: [
      Button({ key: `switch-${s.key}`, plain: true, label: `${s.title}: ${typeof v === 'string' ? v : on ? 'on' : 'off'}`, onPress: act({ do: 'toggle', key: s.key }), ...(i === 0 ? { autoFocus: true } : {}), children: [
        // a feature with modes names its mode after its title, not on or off here
        Text({ key: 'state', ...(on ? { color: 'success' } : { dimColor: true }), children: (choices.length ? '' : on ? '● on' : '○ off').padEnd(IN) }),
        Text({ key: 'title', ...(on ? { bold: true } : { dimColor: true }), children: s.title }),
      ] }),
      ...(modes.length ? [Text({ key: 'gap', children: '   ' }), ...modes] : []),
    ] }),
    // what the mode set gives, under its row
    ...(says?.[v as string] ? [Box({ key: `says-${s.key}`, marginLeft: IN + (group ? 2 : 0), width: width - IN - (group ? 2 : 0), children: [Text({ dimColor: true, children: says[v as string] })] })] : [])]
  })
  return Box({ flexDirection: 'column', width, children: [
    Box({ key: 'preview', flexDirection: 'column', borderStyle: 'round', borderDimColor: true, paddingX: 1, width, children: bar }),
    ...rows,
  ] })
}
