// The panel's Coverage view (term-panel lane, build spec J5 and 3.8): what this session's tool calls read, searched or
// never opened of the data files, at most 10 rows grouped by folder and file type, with drill-in by folder.
//
// SCAFFOLD STUB (C13): openCoverage opens the view, which draws one line, "not built yet". Nothing here runs at import.
import type { RenderElement } from 'claude-code'

import type { Ctx } from './ctx'
import { none } from './panel'
import type { PaneEvent } from './panel'
import { openPanel } from './term'
import type { TermPanel } from './types'

/** The panel at the Coverage view, at `folder` ('' or left out: the corpus's top level). */
export async function openCoverage(cx: Ctx, folder?: string): Promise<void> {
  await openPanel(cx, { view: 'coverage', title: 'Coverage', ...(folder ? { path: folder } : {}) })
}

/** The Coverage view's drawing (registered by views.ts). */
export async function drawCoverage(cx: Ctx, e: PaneEvent, _p: TermPanel): Promise<RenderElement> {
  return none(cx, e, 'coverage: not built yet')
}
