// Stand-in for the panel lane's Citations view (SPEC-v2 3.8): opens the panel at the view's one-line stand-in.
import type { Ctx } from './ctx'
import { openPanel } from './term'

/** The panel at Citations, `pick` chosen. */
export async function openCitations(cx: Ctx, pick?: string): Promise<void> {
  await openPanel(cx, { view: 'citations', title: 'Citations', ...(pick ? { ref: pick } : {}) })
}
