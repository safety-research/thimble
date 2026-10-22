// pane.ts: thimble's one side pane. openPane shows a kind of pane with its arguments in place of what the pane showed,
// and closePane closes it. One `ui.render` hook draws the pane, by the kind it shows, with the drawing's elements:
//
//   evidence   ../marks/evidence.tsx    one mark's evidence
//   labels     ../labels/pane.tsx       the folder's labels and their records
//   coverage   ../panes/coverage.tsx    what Claude read of the folder
//   settings   ../panes/settings.tsx    the three switches
//   fixshare   ../panes/fixshare.tsx    the preview of a fix's share
//
// (Each kind's draw is imported and called by name: Claude Code follows `$` only into functions a file declares or
// imports, so a list of draws that take `$` cannot be called from here.)
import type { EngineInterface, Register } from 'claude-code'

import { drawLabels } from '../labels/pane'
import { drawEvidence } from '../marks/evidence'
import { drawCoverage } from '../panes/coverage'
import { drawFixShare } from '../panes/fixshare'
import { drawSettings } from '../panes/settings'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const PANE_ID = 'thimble'
const NOW = { plugin: 'thimble', key: 'pane' } as const

export async function openPane($: Engine, kind: string, args: unknown, title: string): Promise<void> {
  await $.state.set(NOW, { kind, args })
  await $.ui.open({ id: PANE_ID, title })
}

export async function closePane($: Engine): Promise<void> {
  await $.state.set(NOW, null)
  await $.ui.close({ id: PANE_ID })
}

export async function paneNow($: Engine): Promise<{ kind: string; args: unknown } | null> {
  return ((await $.state.get(NOW)).value ?? null) as { kind: string; args: unknown } | null
}

export const registerPanes: Register = on => {
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const els = $.ui.resolve(e) as Any
    const now = await paneNow($)
    try {
      if (now?.kind === 'evidence') return await drawEvidence($, e, now.args, els)
      if (now?.kind === 'labels') return await drawLabels($, e, now.args, els)
      if (now?.kind === 'coverage') return await drawCoverage($, e, now.args, els)
      if (now?.kind === 'settings') return await drawSettings($, e, now.args, els)
      if (now?.kind === 'fixshare') return await drawFixShare($, e, now.args, els)
      return els.Text({ dimColor: true, children: now ? `thimble has no pane ${now.kind}.` : 'Nothing is open here.' })
    } catch (err) {
      return els.Text({ color: 'error', wrap: 'wrap', children: `This pane could not be drawn (${String((err as Error)?.message || err).slice(0, 160)}). Press esc, then open it again.` })
    }
  })
}
