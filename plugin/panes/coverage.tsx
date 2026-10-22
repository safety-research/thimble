// coverage.tsx: the coverage pane (core/pane.ts kind `coverage`): what Claude read of the folder, from bar/counts.ts
// lastCoverage.
//
// Its lane draws it here. Until then the pane says so in one dim line.
import type { EngineInterface } from 'claude-code'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export async function drawCoverage(_$: EngineInterface, _e: Any, _args: unknown, els: Any): Promise<unknown> {
  return els.Text({ dimColor: true, children: 'The coverage is not drawn yet.' })
}
