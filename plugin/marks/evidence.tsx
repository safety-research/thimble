// evidence.tsx: the side pane of one mark's evidence (core/pane.ts kind `evidence`): for a number, the code and its
// output with the marked words highlighted; for a quote or a code claim, the file at its line (path:line, which the
// terminal opens).
//
// Its lane draws it here. Until then the pane says so in one dim line.
import type { EngineInterface } from 'claude-code'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export async function drawEvidence(_$: EngineInterface, _e: Any, _args: unknown, els: Any): Promise<unknown> {
  return els.Text({ dimColor: true, children: 'The evidence of a mark is not drawn yet.' })
}
