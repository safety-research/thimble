// pane.ts: thimble's one side pane. openPane shows a kind of pane with its arguments in place of what the pane showed,
// and closePane closes it. One `ui.render` hook draws the pane, by the kind it shows, with the drawing's elements:
//
//   evidence   ../marks/evidence.tsx    one mark's evidence
//   labels     ../labels/pane.tsx       the folder's labels and their records
//   coverage   ../panes/coverage.tsx    what Claude read of the folder
//   settings   ../panes/settings.tsx    the three switches
//   fixshare   ../panes/fixshare.tsx    the preview of a fix's share
//   claims     ../claims/seam.ts        the conversation's claims (c)
//   threads    ../threads/seam.ts       the side threads (t)
//   thread     ../threads/seam.ts       one side thread: what it is about, its turns, its input
//
// Under the evidence, labels, coverage and claims panes stands the pane's side thread (threads/seam.ts threadUnder):
// its conversation and an input bar that asks it about what the pane shows, as 0.10's side panel had under each pane.
//
// (Each kind's draw is imported and called by name: Claude Code follows `$` only into functions a file declares or
// imports, so a list of draws that take `$` cannot be called from here.)
import type { EngineInterface, Register } from 'claude-code'

import { drawClaimsPane } from '../claims/seam'
import { drawLabels } from '../labels/pane'
import { drawEvidence } from '../marks/evidence'
import { drawCoverage } from '../panes/coverage'
import { drawFixShare } from '../panes/fixshare'
import { drawSettings } from '../panes/settings'
import { drawThreadsPane, threadUnder } from '../threads/seam'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const PANE_ID = 'thimble'
const NOW = { plugin: 'thimble', key: 'pane' } as const

/** `focus`: the person opened it (a key, a click, a command), so it takes the keyboard and Esc closes it. Answers
 *  whether the pane is on screen. Claude Code places a pane at any width only when the person's own command, prompt
 *  or click opened it; a key at the prompt is none of these, so below 144 columns (110 once the person opened the
 *  pane before) the pane would wait unseen until the terminal grows. Such a pane is closed, and the caller says why. */
export async function openPane($: Engine, kind: string, args: unknown, title: string, o: { focus?: boolean; rows?: number } = {}): Promise<boolean> {
  await $.state.set(NOW, { kind, args })
  const r = await $.ui.open({ id: PANE_ID, title, ...(o.focus ? { focus: true, closeOnEscape: true } : {}), ...(o.rows ? { rows: o.rows } : {}) })
  if (r.isPlaced) return true
  await closePane($)
  return false
}

export async function closePane($: Engine): Promise<void> {
  await $.state.set(NOW, null)
  await $.ui.close({ id: PANE_ID })
}

export async function paneNow($: Engine): Promise<{ kind: string; args: unknown } | null> {
  return ((await $.state.get(NOW)).value ?? null) as { kind: string; args: unknown } | null
}

/** A pane's drawing with its side thread under it (threads/seam.ts threadUnder); the drawing alone when the thread
 *  cannot be drawn. */
async function withThread($: Engine, e: Any, now: { kind: string; args: unknown }, els: Any, drawn: unknown): Promise<unknown> {
  let under: unknown[] = []
  try { under = await threadUnder($, e, now.kind, now.args, els) } catch { under = [] }
  return under.length ? els.Box({ flexDirection: 'column', children: [drawn, ...under] }) : drawn
}

export const registerPanes: Register = on => {
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const els = $.ui.resolve(e) as Any
    const now = await paneNow($)
    try {
      if (now?.kind === 'evidence') return withThread($, e, now, els, await drawEvidence($, e, now.args, els))
      if (now?.kind === 'labels') return withThread($, e, now, els, await drawLabels($, e, now.args, els))
      if (now?.kind === 'coverage') return withThread($, e, now, els, await drawCoverage($, e, now.args, els))
      if (now?.kind === 'settings') return await drawSettings($, e, now.args, els)
      if (now?.kind === 'fixshare') return await drawFixShare($, e, now.args, els)
      if (now?.kind === 'claims') return withThread($, e, now, els, await drawClaimsPane($, e, now.args, els))
      if (now?.kind === 'threads' || now?.kind === 'thread') return await drawThreadsPane($, e, now.kind, now.args, els)
      return els.Text({ dimColor: true, children: now ? `thimble has no pane ${now.kind}.` : 'Nothing is open here.' })
    } catch (err) {
      return els.Text({ color: 'error', wrap: 'wrap', children: `This pane could not be drawn (${String((err as Error)?.message || err).slice(0, 160)}). Press esc, then open it again.` })
    }
  })
}
