// Stand-in for the panel lane's offramp.ts (SPEC-v2 C12, C13): the press that opens the browser on a thimble ref.
import type { Ctx } from './ctx'

/** Opens the browser workbench on `ref` (`home`, `card:<id>`, `answer:<turn>#s<n>`, …). Not built yet: a toast. */
export async function openInBrowser(cx: Ctx, ref: string): Promise<void> {
  cx.toast(`thimble: opening ${ref} in the browser is not built yet`)
}
