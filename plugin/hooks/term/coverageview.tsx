// Stand-in for the panel lane's Coverage view (SPEC-v2 3.8, J5): opens the panel at the view's one-line stand-in.
import type { Ctx } from './ctx'
import { openPanel } from './term'

/** The panel at Coverage, at `folder` (the corpus's top level by default). */
export async function openCoverage(cx: Ctx, folder?: string): Promise<void> {
  await openPanel(cx, { view: 'coverage', title: 'Coverage', ...(folder ? { path: folder } : {}) })
}
