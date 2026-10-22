// pane.tsx: the labels pane (core/pane.ts kind `labels`): the folder's labels, each value's records, and the
// person's checks.
//
// Its lane draws it here. Until then the pane says so in one dim line.
import type { EngineInterface } from 'claude-code'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export async function drawLabels(_$: EngineInterface, _e: Any, _args: unknown, els: Any): Promise<unknown> {
  return els.Text({ dimColor: true, children: 'The labels are not drawn yet.' })
}
