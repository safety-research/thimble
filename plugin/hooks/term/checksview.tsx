// Stand-in for the panel lane's Checks view (SPEC-v2 3.8, J7): opens the panel at the view's one-line stand-in.
import type { Ctx } from './ctx'
import { openPanel } from './term'

/** The panel at Checks, on the comment `commentId` when given. */
export async function openChecks(cx: Ctx, commentId?: string): Promise<void> {
  await openPanel(cx, { view: 'checks', title: 'Checks', ...(commentId ? { slug: commentId } : {}) })
}
