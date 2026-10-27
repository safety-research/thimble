// selection.ts: the words the analyst selected with the mouse that e (explain/seam.ts) and c (marks/cite.ts) act on:
// words of Claude's answers only. Claude Code answers the last selection ($.ui.selection, fullscreen layout only) until
// the person selects again, dismisses it, or sends their next prompt, wherever it was made; so a selection in thimble's
// pane (a setting's name) or the prompt is none of theirs, and one the pane held is dropped when the pane closes.
//
//   answerSelection($)   the selection's words that lie in Claude's answers, a line at a time: a drag that starts on a
//                        row of Claude Code's own (`Ran 3 shell commands`, the answer's ● dot) keeps the answer's lines;
//                        undefined when no line is an answer's (answerSelectionOf: of a selection read before)
//   selectionNow($), selectionKey(sel)   Claude Code's selection as it answers it, and what tells one selection from
//                        another ('' for none)
//   dropSelection($)     the pane closes: a selection outside the transcript (the pane's) is dropped
//   selectionUsed($, by, sel), usedBy($, by, sel)   e or c took this selection, so the bar stops naming that key
//                        for it until words are selected anew
//
// state: selectionDone, the selection dropped and the ones e and c took, by row and words: kept across the plugin's
// loads, since a change in the settings loads it again while the same selection stands
import type { EngineInterface } from 'claude-code'

import { messageOf, textRows } from './answers'

type Engine = EngineInterface
export type Sel = { text: string; requestId?: string }

const DONE = { plugin: 'thimble', key: 'selectionDone' } as const
type Done = { dropped?: string; explain?: string; cite?: string }
const selKey = (sel: Sel) => `${sel.requestId ?? ''}\n${sel.text}`

/** What tells a selection from another: its row and its words; '' for none. */
export const selectionKey = (sel: Sel | undefined): string => (sel ? selKey(sel) : '')

async function doneNow($: Engine): Promise<Done> {
  return ((await $.state.get(DONE).catch(() => null))?.value ?? {}) as Done
}
async function noteDone($: Engine, k: keyof Done, sel: Sel): Promise<void> {
  await $.state.set(DONE, { ...(await doneNow($)), [k]: selKey(sel) }).catch(() => undefined)
}

/** Words as read on screen and as written in markdown, compared alike: a link as its words, no emphasis or code marks,
 *  one space. */
const plain = (s: string) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*`_]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
/** A selected line as its words: without the marks Claude Code draws before a row (● ⎿ and the like). */
const lineWords = (line: string) => plain(line.replace(/^[\s●⏺⎿▎│]+/u, ''))

/** Claude Code's selection; none where it reports none. */
export async function selectionNow($: Engine): Promise<Sel | undefined> {
  try { return await $.ui.selection() } catch { return undefined }
}

export async function answerSelection($: Engine): Promise<Sel | undefined> {
  return answerSelectionOf($, await selectionNow($))
}

/** answerSelection of a selection read before (selectionNow), so a key that read it reads it no more. */
export async function answerSelectionOf($: Engine, sel: Sel | undefined): Promise<Sel | undefined> {
  if (!sel?.text?.trim() || selKey(sel) === (await doneNow($)).dropped) return undefined
  const own = sel.requestId ? (await messageOf($, sel.requestId))?.text : undefined
  const answers = own != null ? [own] : await Promise.all((await textRows($).catch(() => [] as string[]))
    .map(async row => (await messageOf($, row))?.text ?? ''))
  const texts = answers.map(plain)
  const kept = sel.text.split('\n').filter(line => {
    const words = lineWords(line)
    return words && texts.some(t => t.includes(words))
  })
  if (!kept.length) return own != null ? sel : undefined
  const text = kept.map(line => line.replace(/^[\s●⏺⎿▎│]+/u, '').trim()).join('\n')
  return text === sel.text ? sel : { ...sel, text }
}

export async function dropSelection($: Engine): Promise<void> {
  const sel = await selectionNow($)
  if (sel?.text && !sel.requestId) await noteDone($, 'dropped', sel)
}

export async function selectionUsed($: Engine, by: 'explain' | 'cite', sel: Sel | undefined): Promise<void> {
  if (sel) await noteDone($, by, sel)
}

export async function usedBy($: Engine, by: 'explain' | 'cite', sel: Sel | undefined): Promise<boolean> {
  return !!sel && (await doneNow($))[by] === selKey(sel)
}
