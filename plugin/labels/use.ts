// use.ts: where the label rows (which labels an answer or a card used) and the ask before a large label run meet the
// rest of thimble (core/answerview.ts calls each function by name, since Claude Code follows `$` only into functions a
// file declares or imports). The base leaves each one doing nothing; the feature fills them in (0.10:
// shell/labeluse.ts; the ask in shell/labels.ts askFromFeed, answerAsk, setLabelAsk and the kernel's label_ask feed line
// and `thimble label NAME --answer … --ask ID`). Which labels a turn used are the `thimble label` commands its Bash
// calls ran (core/answers.ts labelsOf; a card's: those before its call, CardUse.seq).
//
//   labelsUnderAnswer($, els, row, cols)   the row under an answer: the labels its turn used that none of its cards shows
//   labelsUnderCard($, els, id, cols)      the row under a card: the labels the turn used before the card's call
//   labelAskKey($, key, until)             the ask's keys while it waits (0.10: 1 run all, 2 run on a sample, 0 cancel)
//   labelAskBand($, els, width)            the ask, drawn above the bar while it waits
//   labelAskBar($, on, preview)            its items at the bar's left while it waits
//   labelAskFromFeed($, ev)                a `label_ask` line of the kernel's change feed (core/feed.ts hands it here):
//                                          a large run that waits for the person's choice
//   registerLabelUse                       its own hooks
import type { EngineInterface, Register } from 'claude-code'

import type { BarItem } from '../bar/bar'
import type { Take } from '../hooks/keys'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export async function labelsUnderAnswer(_$: Engine, _els: Any, _row: string, _cols: number): Promise<Any[]> {
  return []
}

export async function labelsUnderCard(_$: Engine, _els: Any, _id: string, _cols: number): Promise<Any[]> {
  return []
}

export async function labelAskKey(_$: Engine, _key: string, _until: number): Promise<Take | null> {
  return null
}

export async function labelAskBand(_$: Engine, _els: Any, _width: number): Promise<Any[]> {
  return []
}

export async function labelAskBar(_$: Engine, _on: (key: string) => boolean, _preview: boolean): Promise<BarItem[]> {
  return []
}

export async function labelAskFromFeed(_$: Engine, _ev: unknown): Promise<void> {
  return undefined
}

export const registerLabelUse: Register = () => undefined
