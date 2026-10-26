// selection.ts: the words the analyst selected with the mouse that e (explain/seam.ts) and c (marks/cite.ts) act on:
// words of Claude's answers only. Claude Code answers the last selection ($.ui.selection, fullscreen layout only) until
// the person selects again, dismisses it, or sends their next prompt, wherever it was made; so a selection in thimble's
// pane (a setting's name) or the prompt is none of theirs, and one the pane held is dropped when the pane closes.
//
//   answerSelection($)   the selection while it lies in Claude's words: on a row of Claude's (`requestId`), or, where
//                        Claude Code names no row (across rows), words one of Claude's rows holds; else undefined
//   dropSelection($)     the pane closes: a selection outside the transcript (the pane's) is dropped
//   selectionUsed($, by, sel), usedBy($, by, sel)   e or c took this selection, so the bar stops naming that key
//                        for it until words are selected anew
//
// state: selectionDone, the selection dropped and the ones e and c took, by row and words: kept across the plugin's
// loads, since a change in the settings loads it again while the same selection stands
import type { EngineInterface } from 'claude-code'

import { messageOf, textRows } from './answers'

type Engine = EngineInterface
type Sel = { text: string; requestId?: string }

const DONE = { plugin: 'thimble', key: 'selectionDone' } as const
type Done = { dropped?: string; explain?: string; cite?: string }
const selKey = (sel: Sel) => `${sel.requestId ?? ''}\n${sel.text}`

async function doneNow($: Engine): Promise<Done> {
  return ((await $.state.get(DONE).catch(() => null))?.value ?? {}) as Done
}
async function noteDone($: Engine, k: keyof Done, sel: Sel): Promise<void> {
  await $.state.set(DONE, { ...(await doneNow($)), [k]: selKey(sel) }).catch(() => undefined)
}

/** Words as read on screen and as written in markdown, compared alike: no emphasis or code marks, one space. */
const plain = (s: string) => s.replace(/[*`_]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()

/** Claude Code's selection; none where it reports none. */
async function selectionNow($: Engine): Promise<Sel | undefined> {
  try { return await $.ui.selection() } catch { return undefined }
}

export async function answerSelection($: Engine): Promise<Sel | undefined> {
  const sel = await selectionNow($)
  if (!sel?.text?.trim() || selKey(sel) === (await doneNow($)).dropped) return undefined
  if (sel.requestId && (await messageOf($, sel.requestId))) return sel
  const words = plain(sel.text)
  for (const row of await textRows($).catch(() => [] as string[])) {
    if (plain((await messageOf($, row))?.text ?? '').includes(words)) return sel
  }
  return undefined
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
