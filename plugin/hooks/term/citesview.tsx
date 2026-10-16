// The panel's Citations view (term-panel lane, build spec 3.8 and 3.10): the session's chat citations and each card's
// link-check problems, refuted and missing first, each opening the citation's place.
//
// SCAFFOLD STUB (C13): openCitations opens the view, which draws one line, "not built yet". Nothing here runs at import.
import type { RenderElement } from 'claude-code'

import type { Ctx } from './ctx'
import { none } from './panel'
import type { PaneEvent } from './panel'
import { openPanel } from './term'
import type { TermPanel } from './types'

/** The panel at the Citations view, with the citation `pick` chosen when given. */
export async function openCitations(cx: Ctx, pick?: string): Promise<void> {
  await openPanel(cx, { view: 'citations', title: 'Citations', ...(pick ? { ref: pick } : {}) })
}

/** The Citations view's drawing (registered by views.ts). */
export async function drawCitations(cx: Ctx, e: PaneEvent, _p: TermPanel): Promise<RenderElement> {
  return none(cx, e, 'citations: not built yet')
}
