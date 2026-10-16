// The panel's Checks view (term-panel lane, build spec J7 and 3.12): a check's comment on a passage of Claude's answer,
// with the check's name, the passage, the comment and its acts (ask about it, put in the prompt, dismiss, open in the
// browser); with no comment open, the list of checks.
//
// SCAFFOLD STUB (C13): openChecks opens the view, which draws one line, "not built yet". Nothing here runs at import.
import type { RenderElement } from 'claude-code'

import type { Ctx } from './ctx'
import { none } from './panel'
import type { PaneEvent } from './panel'
import { openPanel } from './term'
import type { TermPanel } from './types'

/** The panel at the Checks view, at the comment `commentId` when given. */
export async function openChecks(cx: Ctx, commentId?: string): Promise<void> {
  await openPanel(cx, { view: 'checks', title: 'Checks', ...(commentId ? { ref: commentId } : {}) })
}

/** The Checks view's drawing (registered by views.ts). */
export async function drawChecks(cx: Ctx, e: PaneEvent, _p: TermPanel): Promise<RenderElement> {
  return none(cx, e, 'checks: not built yet')
}
