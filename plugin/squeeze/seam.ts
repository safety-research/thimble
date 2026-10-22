// seam.ts: where Squeeze and catch-up meet the rest of thimble (core/answerview.ts calls each function by name, since
// Claude Code follows `$` only into functions a file declares or imports). The base leaves each one doing nothing; the
// feature fills them in, with its own modules beside this file (0.10: squeeze/term.ts, squeeze/chips.mjs, the chips'
// pane program panes/chips.js, prompts/squeeze.md).
//
//   SQUEEZE_KEYS                       its letters at an empty prompt, which no card may take (hooks/keys.ts OWN_KEYS)
//   squeezeView($, row, text)          the text a row of Claude's shows now in place of what Claude wrote: a version
//                                      the person squeezed or stretched, the part of it written in so far, a catch-up
//                                      drawn in the newest reply's place (`hidden` for the replies it covers), `dim`
//                                      while a rewrite runs; null: the row as Claude wrote it
//   squeezeRow($, els, row, cols)      the row drawn whole in place of its words, or null: a catch-up, with the rule
//                                      down its side and its head line (0.10's shell/view.ts catchUpEl), its words
//                                      with their marks (marks/view.ts messageEl)
//   squeezeUnder($, els, row, cols)    what stands under the row after its cards: the chips while they are open on it,
//                                      what a squeeze left out of its cards, a catch-up's tail
//   squeezeUnderCard($, els, id, cols) what stands under one card: what a squeeze changed of it
//   squeezeKey($, key, until)          s (and the chips' keys while they are open): a taker as hooks/keys.ts takes it
//   squeezeBar($, on, preview)         its items at the bar's left (`s squeeze`, lit with the levels set)
//   registerSqueeze                    its own hooks (/squeeze, its autocomplete, ...)
import type { EngineInterface, Register } from 'claude-code'

import type { BarItem } from '../bar/bar'
import type { TextView } from '../core/answerview'
import type { Take } from '../hooks/keys'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const SQUEEZE_KEYS = ['s']

export async function squeezeView(_$: Engine, _row: string, _text: string): Promise<TextView | null> {
  return null
}

export async function squeezeRow(_$: Engine, _els: Any, _row: string, _cols: number): Promise<Any | null> {
  return null
}

export async function squeezeUnder(_$: Engine, _els: Any, _row: string, _cols: number): Promise<Any[]> {
  return []
}

export async function squeezeUnderCard(_$: Engine, _els: Any, _id: string, _cols: number): Promise<Any[]> {
  return []
}

export async function squeezeKey(_$: Engine, _key: string, _until: number): Promise<Take | null> {
  return null
}

export async function squeezeBar(_$: Engine, _on: (key: string) => boolean, _preview: boolean): Promise<BarItem[]> {
  return []
}

export const registerSqueeze: Register = () => undefined
