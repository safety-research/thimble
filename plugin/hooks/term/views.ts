// The panel's new views and the summary line's counts (term-panel lane, build spec 3.8): registerPanelViews adds the
// Coverage, Citations and Checks views through panel.tsx drawsView and term.ts loadsView, so panel.tsx's own switch
// does not change for them; refreshSummary recomputes the summary line's counts when term.ts tick sees the labels,
// coverage, answers, cards or docs areas change.
//
// SCAFFOLD STUB (C13): the three views draw one line each, "not built yet", and read nothing; refreshSummary does
// nothing. register.tsx calls registerPanelViews once; nothing here runs at import.
import type { On } from 'claude-code'

import { drawChecks } from './checksview'
import { drawCitations } from './citesview'
import { drawCoverage } from './coverageview'
import type { Ctx } from './ctx'
import { drawsView } from './panel'
import { loadsView } from './term'

/** The Coverage, Citations and Checks views, drawn and read by their own files. */
export function registerPanelViews(_on: On): void {
  drawsView('coverage', drawCoverage)
  drawsView('citations', drawCitations)
  drawsView('checks', drawChecks)
  for (const view of ['coverage', 'citations', 'checks']) loadsView(view, async () => undefined)
}

/** The summary line's counts read again (term.ts tick, on the C13 area changes). The stub reads nothing. */
export async function refreshSummary(_cx: Ctx): Promise<void> {
  return undefined
}
