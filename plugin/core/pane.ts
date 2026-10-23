// pane.ts: thimble's one side pane. openPane shows a kind of pane with its arguments in place of what the pane showed,
// and closePane closes it. One `ui.render` hook draws the pane, by the kind it shows, with the drawing's elements:
//
//   evidence   ../marks/evidence.tsx    one mark's evidence
//   labels     ../labels/pane.tsx       the folder's labels and their records
//   coverage   ../panes/coverage.tsx    what Claude read of the folder
//   settings   ../panes/settings.tsx    the three switches
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

import { failCleared, failLineNow } from '../bar/notice'
import { drawClaimsPane } from '../claims/seam'
import { drawLabels } from '../labels/pane'
import { drawEvidence } from '../marks/evidence'
import { drawCoverage } from '../panes/coverage'
import { drawSettings } from '../panes/settings'
import { drawThreadsPane, threadUnder } from '../threads/seam'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const PANE_ID = 'thimble'
const NOW = { plugin: 'thimble', key: 'pane' } as const

/** `focus`: the person opened it (a key, a click, a command), so it takes the keyboard and Esc closes it. Answers
 *  whether the pane is on screen; once it is, the notice that said the side pane could not open (`pane:…`) goes.
 *  Claude Code places a pane at any width only when the person's own command, prompt or click opened it; a key at the
 *  prompt is none of these, so below 144 columns (110 once the person opened the pane before) the pane would wait
 *  unseen until the terminal grows. Such a pane is closed, and the caller says why. */
/** Claude Code sets `closeOnEscape` and `rows` anew on each open, so an open that only redraws the pane with other
 *  arguments (a key in it: j, v, a page) keeps those the open pane has; else Esc would stop closing it after one key. */
export async function openPane($: Engine, kind: string, args: unknown, title: string, o: { focus?: boolean; rows?: number } = {}): Promise<boolean> {
  const was = await paneNow($)
  const open = was ? await isOpen($) : false
  const escape = Boolean(o.focus || (open && was?.escape))
  const rows = o.rows ?? (open && was?.kind === kind ? was?.rows : undefined)
  await $.state.set(NOW, { kind, args, ...(escape ? { escape } : {}), ...(rows ? { rows } : {}) })
  const r = await $.ui.open({ id: PANE_ID, title, ...(o.focus ? { focus: true } : {}), ...(escape ? { closeOnEscape: true } : {}), ...(rows ? { rows } : {}) })
  if (r.isPlaced) {
    // the line that said the side pane could not open (a narrow terminal: `pane:<kind>`) goes once it is open, on
    // whatever it shows (/threads opens a thread a key asked for on its citation's evidence)
    const line = await failLineNow($)
    if (line?.about?.startsWith('pane:')) await failCleared($, line.about)
    return true
  }
  await closePane($)
  return false
}

/** Whether thimble's pane is open (the person may have closed it); open when Claude Code cannot say. */
async function isOpen($: Engine): Promise<boolean> {
  try { return (await $.ui.panes()).some(p => p.id === PANE_ID) } catch { return true }
}

export async function closePane($: Engine): Promise<void> {
  await $.state.set(NOW, null)
  await $.ui.close({ id: PANE_ID })
}

export type PaneNow = { kind: string; args: unknown; escape?: boolean; rows?: number }

export async function paneNow($: Engine): Promise<PaneNow | null> {
  return ((await $.state.get(NOW)).value ?? null) as PaneNow | null
}

/** A /clear or a /resume (hooks/turnover.ts): a pane on the earlier conversation's records closes (thimble's settings
 *  are no conversation's). */
export async function turnPane($: Engine): Promise<void> {
  const now = await paneNow($)
  if (now && now.kind !== 'settings') await closePane($)
}

/** A pane's drawing with its side thread under it (threads/seam.ts threadUnder); the drawing alone when the thread
 *  cannot be drawn. */
async function withThread($: Engine, e: Any, now: { kind: string; args: unknown }, els: Any, drawn: unknown): Promise<unknown> {
  let under: unknown[] = []
  try { under = await threadUnder($, e, now.kind, now.args, els) } catch { under = [] }
  return under.length ? els.Box({ flexDirection: 'column', children: [drawn, ...under] }) : drawn
}

/** The pane's columns at its last drawing, or 0 before one: the width a copy of it is drawn at (paneDrawing). */
let paneColumns = 0

/** What the pane shows now, drawn with `els`: Claude Code's elements when it draws the pane, or plain ones when the
 *  fixer gets a text copy of the screen (fix/screen.ts). */
export async function drawPane($: Engine, e: Any, now: PaneNow | null, els: Any): Promise<unknown> {
  try {
    if (now?.kind === 'evidence') return withThread($, e, now, els, await drawEvidence($, e, now.args, els))
    if (now?.kind === 'labels') return withThread($, e, now, els, await drawLabels($, e, now.args, els))
    if (now?.kind === 'coverage') return withThread($, e, now, els, await drawCoverage($, e, now.args, els))
    if (now?.kind === 'settings') return await drawSettings($, e, now.args, els)
    if (now?.kind === 'claims') return withThread($, e, now, els, await drawClaimsPane($, e, now.args, els))
    if (now?.kind === 'threads' || now?.kind === 'thread') return await drawThreadsPane($, e, now.kind, now.args, els)
    return els.Text({ dimColor: true, children: now ? `thimble has no pane ${now.kind}.` : 'Nothing is open here.' })
  } catch (err) {
    return els.Text({ color: 'error', wrap: 'wrap', children: `This pane could not be drawn (${String((err as Error)?.message || err).slice(0, 160)}). Press esc, then open it again.` })
  }
}

/** The pane as it shows now, drawn with `els` at the width it was last drawn at, or null when it is closed. */
export async function paneDrawing($: Engine, els: Any): Promise<{ kind: string; drawn: unknown } | null> {
  const now = await paneNow($)
  if (!now || !(await isOpen($))) return null
  const e = { requestId: PANE_ID, props: { bodyColumns: paneColumns || 60 } }
  return { kind: now.kind, drawn: await drawPane($, e, now, els) }
}

export const registerPanes: Register = on => {
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const els = $.ui.resolve(e) as Any
    const cols = Number((e as Any).props?.bodyColumns)
    if (cols > 0) paneColumns = cols
    return drawPane($, e, await paneNow($), els)
  })
}
