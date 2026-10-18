// The panel's views drawn by modules of their own, registered once (register.tsx calls registerPanelViews): a file,
// opened to verify a place (filesview.tsx; the terminal has no file browser), coverage (coverageview.tsx), the citations (citesview.tsx) and the checks on
// answers (checksview.tsx), each through panel.tsx drawsView and term.ts loadsView; a row above the prompt with its acts
// on keys, for the main screen, which takes no clicks (waitview.tsx); and what a terminal view's acts do.
// refreshSummary counts again what the summary line above the prompt shows (term.ts tick calls it when the workspace
// changes). The other files of the panel's lane are reached through this one.
import type { On } from 'claude-code'

import { registerChecksView } from './checksview'
import { registerCitationsView } from './citesview'
import { registerCoverageView } from './coverageview'
import { registerFilesView } from './filesview'
import { registerViewActs } from './panel'
import { registerWaitingView } from './waitview'

export { refreshSummary, registerBand } from './band'
export { openCoverage } from './coverageview'
export { openCitations } from './citesview'
export { openChecks } from './checksview'
export { openInBrowser } from './offramp'
export { postNotice } from './notices'

/** The panel's views and acts registered with the panel; called once, from register.tsx's register. */
export function registerPanelViews(on: On): void {
  void on
  registerFilesView()
  registerCoverageView()
  registerCitationsView()
  registerChecksView()
  registerWaitingView()
  registerViewActs()
}
