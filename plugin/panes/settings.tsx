// settings.tsx: the settings pane (core/pane.ts kind `settings`): /thimble-settings, or a click on `thimble` in the
// bar, opens it. At its top the bar as these switches leave it (bar.tsx, drawn as a preview: nothing in it presses),
// then the three switches, each named by what the person gets, with one line on what that is. ↵ on a switch or a click
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
  const rows = SWITCHES.map((s, i) => {
    const on = values[s.key]
    return Box({ key: `sw-${s.key}`, flexDirection: 'column', marginTop: 1, children: [
      Button({ key: `switch-${s.key}`, plain: true, label: `${s.title}: ${on ? 'on' : 'off'}`, onPress: toggle(s.key), ...(i === 0 ? { autoFocus: true } : {}), children: [
        Text({ key: 'state', ...(on ? { color: 'success' } : { dimColor: true }), children: (on ? '● on' : '○ off').padEnd(IN) }),
        Text({ key: 'title', ...(on ? { bold: true } : { dimColor: true }), children: s.title }),
      ] }),
      Box({ key: 'does', marginLeft: IN, children: [Text({ dimColor: true, wrap: 'wrap', children: s.does })] }),
    ] })
  })
  return Box({ flexDirection: 'column', width, children: [
    Text({ key: 'head', dimColor: true, children: 'The bar, with these settings' }),
    Box({ key: 'preview', flexDirection: 'column', borderStyle: 'round', borderDimColor: true, paddingX: 1, width, children: bar }),
    ...rows,
  ] })
}
