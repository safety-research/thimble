// settings.tsx: the settings pane (core/pane.ts kind `settings`): the three switches, each turned on or off through
// Claude Code with settings/term.ts settingsAction.
//
// The bar lane draws it in full here (and adds /thimble-settings). Until then it is this plain form.
import type { EngineInterface } from 'claude-code'

import { SWITCHES } from '../settings/features.mjs'
import { heldValues, settingsAction } from '../settings/term'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export async function drawSettings($: EngineInterface, _e: Any, _args: unknown, els: Any): Promise<unknown> {
  const { Box, Button, Text } = els
  const values = await heldValues($)
  const toggle = (key: string) => async () => {
    const said = await settingsAction($, { do: 'toggle', key })
    if (typeof said === 'string' && said) $.ui.toast(said)
  }
  return Box({
    flexDirection: 'column',
    children: SWITCHES.map(s => Box({ key: s.key, flexDirection: 'column', children: [
      Button({ key: `b-${s.key}`, label: `${values[s.key] ? '[x]' : '[ ]'} ${s.title}`, onPress: toggle(s.key) }),
      Text({ key: `d-${s.key}`, dimColor: true, wrap: 'wrap', children: `    ${s.does}` }),
    ] })),
  })
}
