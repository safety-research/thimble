// settings.tsx: the settings pane (core/pane.ts kind `settings`): /thimble-settings, or a click on `thimble` in the
// bar, opens it. At its top the bar as these switches leave it (bar.tsx, drawn as a preview: nothing in it presses),
// then the switches, each named by what the person gets; a group's (Comments: Explainers, Heads-ups) under its
// heading, indented. ↵ on a switch or a click
// turns it on or off through Claude Code (settings/term.ts settingsAction), which keeps the value and loads the plugin
// again with it; the pane and the bar draw the change at once. Tab walks the switches, esc closes the pane.
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
  const toggle = (key: string) => async () => {
    const said = await settingsAction($, { do: 'toggle', key })
    if (typeof said === 'string' && said) $.ui.toast(said)
  }
  const bar = await barRows($, els, width - 4, { on: switchesFrom(values), preview: true })
  const rows = SWITCHES.flatMap((s, i) => {
    const on = values[s.key]
    const group = (s as { group?: string }).group
    const opens = group && (SWITCHES[i - 1] as { group?: string } | undefined)?.group !== group
    const head = opens ? [Box({ key: `group-${group}`, marginTop: 1, children: [Text({ bold: true, children: group })] })] : []
    return [...head, Box({ key: `sw-${s.key}`, flexDirection: 'column', marginTop: opens ? 0 : 1, ...(group ? { marginLeft: 2 } : {}), children: [
      Button({ key: `switch-${s.key}`, plain: true, label: `${s.title}: ${on ? 'on' : 'off'}`, onPress: toggle(s.key), ...(i === 0 ? { autoFocus: true } : {}), children: [
        Text({ key: 'state', ...(on ? { color: 'success' } : { dimColor: true }), children: (on ? '● on' : '○ off').padEnd(IN) }),
        Text({ key: 'title', ...(on ? { bold: true } : { dimColor: true }), children: s.title }),
      ] }),
    ] })]
  })
  return Box({ flexDirection: 'column', width, children: [
    Box({ key: 'preview', flexDirection: 'column', borderStyle: 'round', borderDimColor: true, paddingX: 1, width, children: bar }),
    ...rows,
  ] })
}
