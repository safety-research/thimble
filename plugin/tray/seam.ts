// seam.ts: where the tray (the citation and explanation tray above the prompt) meets the rest of thimble
// (core/answerview.ts calls each function by name, since Claude Code follows `$` only into functions a file declares or
// imports). The base leaves each one doing nothing; the feature fills them in, with its own modules beside this file
// (0.10: shell/tray.js, the tray's pane program panes/tray.js and panes/mark.js, shell.tsx trayBand, stepMark,
// trayScope). What the person opens reaches main through core/engaged.ts.
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
//   registerTray                       its own hooks (a question asked with the tray open, ...)
import type { EngineInterface, Register } from 'claude-code'

import type { BarItem } from '../bar/bar'
import type { MarkRef } from '../core/answerview'
import type { Take } from '../hooks/keys'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export async function trayKey(_$: Engine, _key: string, _until: number): Promise<Take | null> {
  return null
}

export async function trayBand(_$: Engine, _els: Any, _width: number): Promise<Any[]> {
  return []
}

export async function trayBar(_$: Engine, _on: (key: string) => boolean, _preview: boolean): Promise<BarItem[]> {
  return []
}

export async function trayFocus(_$: Engine, _row: string): Promise<MarkRef | null> {
  return null
}

export async function markPressed(_$: Engine, _row: string, _n: number): Promise<boolean> {
  return false
}

export async function openTray(_$: Engine, _mark: MarkRef): Promise<boolean> {
  return false
}

export const registerTray: Register = () => undefined
