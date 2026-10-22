// seam.ts: where the tray (the citation and explanation tray above the prompt) meets the rest of thimble
// (core/answerview.ts calls each function by name, since Claude Code follows `$` only into functions a file declares or
// imports). Each one calls the tray's own module, tray.ts (0.10: shell/tray.js, the tray's pane program panes/tray.js
// and panes/mark.js, shell.tsx trayBand, stepMark, trayScope), with its pure parts in tray.mjs. What the person opens
// reaches main through core/engaged.ts.
//
//   trayKey($, key, until)             its keys at an empty prompt: ] and [ step through the answers' citations and
//                                      explainers at rest; while it is open, its own (a taker as hooks/keys.ts takes it)
//   trayBand($, els, width)            the tray, drawn above the bar while it is open
//   trayBar($, on, preview)            its items at the bar's left (`] next citation`)
//   trayFocus($, row)                  what the tray shows on this row, so the row draws it in focus: a citation by its
//                                      number (MarkRef kind `citation`), or an explainer's or heads-up's span by its id
//   markPressed($, row, n)             a press on citation `n` of the row: true when the tray took it (else the
//                                      citation's evidence opens in the side pane, marks/register.ts)
//   openTray($, mark)                  open the tray on a mark (an explainer's press, explain/seam.ts): true when it did
//   trayOffRow($, row)                 close the tray when it stands on this row, whose text changed under its marks
//                                      (a squeeze version shown, squeeze/term.ts)
//   registerTray                       its own hooks (a question asked with the tray open, ...)
import type { EngineInterface, Register } from 'claude-code'

import type { BarItem } from '../bar/bar'
import type { MarkRef } from '../core/answerview'
import type { Take } from '../hooks/keys'
import { closeTray, markPressed as pressed, openTray as openOn, registerTray as register, trayBand as band, trayBar as bar, trayFocus as focus, trayKey as key, trayNow } from './tray'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export async function trayKey($: Engine, k: string, _until: number): Promise<Take | null> {
  return key($, k)
}

export async function trayBand($: Engine, els: Any, width: number): Promise<Any[]> {
  return band($, els, width)
}

export async function trayBar($: Engine, on: (key: string) => boolean, preview: boolean): Promise<BarItem[]> {
  return bar($, on, preview)
}

export async function trayFocus($: Engine, row: string): Promise<MarkRef | null> {
  return focus($, row)
}

export async function markPressed($: Engine, row: string, n: number): Promise<boolean> {
  return pressed($, row, n)
}

export async function openTray($: Engine, mark: MarkRef): Promise<boolean> {
  return openOn($, mark)
}

export async function trayOffRow($: Engine, row: string): Promise<void> {
  const tray = await trayNow($)
  if (tray?.stack[0]?.row === row) await closeTray($)
}

export const registerTray: Register = (on, ctx) => register(on, ctx)
