// seam.ts: where Claims meet the rest of thimble (core/answerview.ts, core/pane.ts, core/feed.ts and observer/observer.ts
// call each function by name, since Claude Code follows `$` only into functions a file declares or imports). The
// feature's modules stand beside this file: term.ts (the store, a look's claims, c, /claims, the folder's map),
// store.js (the claims as pure functions), graph.js and pane.tsx (the pane), estimate.mjs (the folder's size for the
// map's estimate), lens.mjs (the observer's claims lens); prompts/lens-claims.md, prompts/claims-folder.md.
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
//   claimsThreadScope($, args)         what the side thread under the claims pane is about: the claim selected, or
//                                      where it was said (threads/pane.tsx)
//   folderClaimsFromFeed($, ev)        a `folder_claims` line of the change feed: the folder's map kept by
//                                      `thimble claims save`, brought into the claims
//   registerClaims                     its own hooks (/claims)
import type { EngineInterface, Register } from 'claude-code'

import type { BarItem } from '../bar/bar'
import type { Take } from '../hooks/keys'
import type { Look } from '../observer/observer'
import { featureOn } from '../settings/features.mjs'
import { claimsThreadScope as threadScope, drawClaims } from './pane'
import { claimsBarWords, claimsDigest, folderClaimsFromFeed as fromFeed, lookClaims, lookFailed, openClaims, registerClaimsTerm } from './term'

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
  return [{ id: 'claims', key: 'c', words: await claimsBarWords($), press: () => openClaims($) }]
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

export async function folderClaimsFromFeed($: Engine, ev: Any): Promise<void> {
  await fromFeed($, ev)
}

export const registerClaims: Register = (on, options) => {
  registerClaimsTerm(on, options)
}
