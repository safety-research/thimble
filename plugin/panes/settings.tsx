// settings.tsx: the settings pane (core/pane.ts kind `settings`): /thimble-settings, or a click on `thimble` in the
// bar, opens it. At its top the bar as these switches leave it (bar.tsx, drawn as a preview: nothing in it presses),
// then the switches, each named by what the person gets, then thimble's color: a sample of each of its colors, ▸ on
// the one in use. ↵ on a switch or a click turns it on or off, and ↵ on a color or a click picks it, through Claude
// Code (settings/term.ts settingsAction), which keeps the value and loads the plugin again with it; the pane and the
// bar draw the change at once. Tab walks the switches and the colors, esc closes the pane.
import type { EngineInterface } from 'claude-code'

import { barRows } from '../bar/bar'
import { accent } from '../core/theme'
import { COLOR, COLORS, SWITCHES, switchesFrom } from '../settings/features.mjs'
import { heldColor, heldValues, settingsAction } from '../settings/term'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** Where a switch's words start: after `● on   `. */
const IN = 7

export async function drawSettings($: EngineInterface, e: Any, _args: unknown, els: Any): Promise<unknown> {
  const { Box, Button, Text } = els
  const width = Math.max(30, Number(e.props?.bodyColumns) || 60)
  const values = await heldValues($)
  const color = await heldColor($)
  const act = (a: Record<string, unknown>) => async () => {
    const said = await settingsAction($, a)
    if (typeof said === 'string' && said) $.ui.toast(said)
  }
  const toggle = (key: string) => act({ do: 'toggle', key })
  const bar = await barRows($, els, width - 4, { on: switchesFrom(values), preview: true })
  const rows = SWITCHES.map((s, i) => {
    const on = values[s.key]
    return Box({ key: `sw-${s.key}`, flexDirection: 'column', marginTop: 1, children: [
      Button({ key: `switch-${s.key}`, plain: true, label: `${s.title}: ${on ? 'on' : 'off'}`, onPress: toggle(s.key), ...(i === 0 ? { autoFocus: true } : {}), children: [
        Text({ key: 'state', ...(on ? { color: 'success' } : { dimColor: true }), children: (on ? '● on' : '○ off').padEnd(IN) }),
        Text({ key: 'title', ...(on ? { bold: true } : { dimColor: true }), children: s.title }),
      ] }),
    ] })
  })
  // the colors: ▸ on the one in use, in thimble's color; each sample in its own
  const samples = COLORS.map(c => {
    const now = c.name === color
    return Button({ key: `color-${c.name}`, plain: true, label: `${COLOR.title}: ${c.name}${now ? ', in use' : ''}`, onPress: act({ do: 'color', name: c.name }), children: [
      Text({ key: 'mark', color: accent(), bold: true, children: now ? '▸ ' : '  ' }),
      Text({ key: 'sample', color: c.key, children: '■' }),
      Text({ key: 'name', ...(now ? { bold: true } : { dimColor: true }), children: ` ${c.name}  ` }),
    ] })
  })
  const colors = Box({ key: 'colors', flexDirection: 'column', marginTop: 1, children: [
    Text({ key: 'colors-title', children: [Text({ key: 'gap', children: ' '.repeat(IN) }), Text({ key: 'title', bold: true, children: COLOR.title })] }),
    Box({ key: 'colors-samples', flexDirection: 'row', flexWrap: 'wrap', paddingLeft: IN - 2, children: samples }),
  ] })
  return Box({ flexDirection: 'column', width, children: [
    Box({ key: 'preview', flexDirection: 'column', borderStyle: 'round', borderDimColor: true, paddingX: 1, width, children: bar }),
    ...rows,
    colors,
  ] })
}
