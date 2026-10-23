// seam.ts: where Claims meet the rest of thimble (core/answerview.ts, core/pane.ts and observer/observer.ts
// call each function by name, since Claude Code follows `$` only into functions a file declares or imports). The
// feature's modules stand beside this file: term.ts (the store, a look's claims, c, /claims), store.js (the claims as
// pure functions), graph.js and pane.tsx (the pane), lens.mjs (the observer's claims lens); prompts/lens-claims.md.
//
//   CLAIMS_KEYS                        its letters at an empty prompt, which no card may take (hooks/keys.ts ownKeys)
//   claimsKey($, key, until)           c: the Claims pane, once the word window closed (a taker as hooks/keys.ts takes it)
//   claimsBar($, on, preview)          its items at the bar's left (`c 11 claims`, lit when a claim was corrected)
//   claimsState($)                     what the claims lens's digest reads (./lens.mjs): every claim so far and the
//                                      clusters, as its {{CLAIMS}}, {{CLUSTERS}} and {{GROWN}} lines
//   claimsMerge($, look)               what one look of the observer gave for the claims lens (look.out.claims,
//                                      look.out.clusters), placed by their words in the look's messages
//   claimsLookFailed($, look, why)     a look that gave nothing: the turn's claims are missing, and why
//   drawClaimsPane($, e, args, els)    the side pane of kind `claims` (core/pane.ts)
//   claimsThreadScope($, args)         what the side thread under the claims pane is about: the claim selected, the
//                                      cluster selected, or where a claim was said (threads/pane.tsx)
//   registerClaims                     its own hooks (/claims; x in the pane, which starts a repair inside its
//                                      ui.press hook, as the tray's does)
import type { EngineInterface, Register } from 'claude-code'

import type { BarItem } from '../bar/bar'
import { failNotice } from '../bar/notice'
import { ACCENT } from '../core/theme'
import type { Take } from '../hooks/keys'
import type { Look } from '../observer/observer'
import { featureOn } from '../settings/features.mjs'
import { CLAIMS_REPAIR, claimsThreadScope as threadScope, drawClaims, repairShown } from './pane'
import { claimCount, claimsBarWords, claimsBright, claimsDigest, claimsLit, lookClaims, lookFailed, openClaims, registerClaimsTerm } from './term'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const CLAIMS_KEYS = ['c']

export async function claimsKey($: Engine, key: string, _until: number): Promise<Take | null> {
  if (key !== 'c' || !featureOn('claims')) return null
  // after the word window, as 0.10 did: `c` that starts a word is typed
  return { later: () => openClaims($) }
}

export async function claimsBar($: Engine, on: (key: string) => boolean, preview: boolean): Promise<BarItem[]> {
  if (!on('claims')) return []
  if (preview) return [{ id: 'claims', key: 'c', words: 'claims' }]
  // no claims yet: nothing to open, so the bar shows no claims item until the first claim
  if (!(await claimCount($))) return []
  const words = await claimsBarWords($)
  // in thimble's color when a claim was corrected, as squeeze's; bold for a moment after new claims
  const look = await claimsLit($) ? { color: ACCENT } : {}
  return [{ id: 'claims', key: 'c', words, ...look, ...(await claimsBright($) ? { bold: true } : {}), press: () => openClaims($) }]
}

export async function claimsState($: Engine): Promise<Record<string, unknown>> {
  return claimsDigest($)
}

export async function claimsMerge($: Engine, look: Look): Promise<void> {
  await lookClaims($, look)
}

export async function claimsLookFailed($: Engine, look: Look, why: string): Promise<void> {
  await lookFailed($, look, why)
}

export async function drawClaimsPane($: Engine, e: Any, args: unknown, els: Any): Promise<unknown> {
  return drawClaims($, e, args, els)
}

export async function claimsThreadScope($: Engine, args: unknown): Promise<{ about: string; args: unknown }> {
  return threadScope($, args)
}

export const registerClaims: Register = (on, options) => {
  registerClaimsTerm(on, options)
  // x in the pane, or a click on its `repair`: the repair starts in this hook, so the plugin's other hooks serve its
  // fork (core/forks.ts)
  on('ui.press', { element: /^claims-repair$/ }, async ($, e, next) => {
    try {
      if (e.plugin !== 'thimble' || e.element !== CLAIMS_REPAIR) return next(e)
      if (!(await repairShown($))) return next(e)
      return { element: e.element }
    } catch (err) {
      failNotice($, `The repair did not start: ${String((err as Error)?.message || err).slice(0, 160)}. Press x to try again.`, 'claims:repair')
      return { element: e.element }
    }
  }).catch(($, e, next) => next(e))
}
