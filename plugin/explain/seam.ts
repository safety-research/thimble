// seam.ts: where the explainers and the important details (heads-ups) meet the rest of thimble (core/answerview.ts and
// observer/observer.ts call each function by name, since Claude Code follows `$` only into functions a file declares or
// imports). The base leaves each one doing nothing; the feature fills them in, with its own modules beside this file
// (0.10: the explain and heads lenses' merges in observer/observer.ts, shell/message.js glossesOf and headsOf,
// shell/expand.ts, the explainer card in shell/cards.js, prompts/lens-explain.md, lens-heads.md, explain-expand.md).
//
//   explainSpans($, row, text, marks)  the explainers and heads-ups on the words of a row as it shows now (`text`, whose
//                                      citations are `marks`), each a press: a teal fill for an explainer, an orange one
//                                      for a heads-up, in 0.10's colors
//   explainKey($, key, until)          its keys at an empty prompt, if any (the Longer of an open explainer: e)
//   explainState($)                    what the lenses' digests read (lenses explain and heads in ./lens.mjs): the terms
//                                      already explained in this conversation, the heads-ups already given
//   explainMerge($, look)              what one look of the observer gave for the explain and heads lenses
//                                      (look.out.glosses, look.out.heads), placed on the words of the look's messages
//   expandExplainer($, mark)           Longer: the explainer or heads-up written again at more length, in its place
//                                      (the tray's e, 0.10's shell/expand.ts); null when it did, else why not
//   registerExplain                    its own hooks
//
// Each row's explainers and heads-ups are its part `explain` (core/answers.ts partOf/setPart, ExplainPart below), which
// the tray reads to show one and to step through them.
import type { EngineInterface, Register } from 'claude-code'

import type { MarkRef, Span } from '../core/answerview'
import type { Take } from '../hooks/keys'
import type { Look } from '../observer/observer'

type Engine = EngineInterface

/** An explainer, or (kind `heads`) an important detail, as 0.10's types/index.d.ts Gloss: the words it stands on as the
 *  person reads them (`term`), what it is (`body`), where it mattered here (`here`), a heads-up's `title`, `bullets`
 *  and `todo`, and, once written at more length (`expanded`), the short one kept in `short`. Words in it may hold
 *  citations as `[words](#)`. */
export type Gloss = {
  id: string; term: string; kind?: 'heads'; title?: string; body?: string; here?: string; bullets?: string[]; todo?: string
  expanded?: boolean; short?: { body: string; here: string }
}
/** A row's part `explain`: its explainers and heads-ups by id, in reading order. */
export type ExplainPart = { items: Record<string, Gloss>; order: string[] }

export async function explainSpans(_$: Engine, _row: string, _text: string, _marks: { start: number; end: number; words: string }[]): Promise<Span[]> {
  return []
}

export async function explainKey(_$: Engine, _key: string, _until: number): Promise<Take | null> {
  return null
}

export async function explainState(_$: Engine): Promise<Record<string, unknown>> {
  return {}
}

export async function explainMerge(_$: Engine, _look: Look): Promise<void> {
  return undefined
}

export async function expandExplainer(_$: Engine, _mark: MarkRef): Promise<string | null> {
  return 'explainers are not here yet'
}

export const registerExplain: Register = () => undefined
