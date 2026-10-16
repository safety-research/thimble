// Stand-in for the panel lane's views.ts (SPEC-v2 C13): the panel's Coverage, Citations and Checks views registered as
// one-line views, and the summary line's refresh, which does nothing yet.
import type { On } from 'claude-code'

import type { Ctx } from './ctx'
import { drawsView } from './panel'

const NOT_BUILT: Record<string, string> = { coverage: 'Coverage', citations: 'Citations', checks: 'Checks' }

/** The panel's new views, through panel.tsx drawsView; called once from register.tsx. */
export function registerPanelViews(on: On): void {
  void on
  for (const [view, title] of Object.entries(NOT_BUILT)) {
    drawsView(view, async (cx, e) => {
      const { Text } = cx.els(e)
      return Text({ dimColor: true, children: [`${title}: not built yet`] })
    })
  }
}

/** The summary line's counts, recomputed when an area it counts changed (term.ts tick). */
export async function refreshSummary(cx: Ctx): Promise<void> {
  void cx
}
