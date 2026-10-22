// seam.ts: where Claims meet the rest of thimble (core/answerview.ts, core/pane.ts and observer/observer.ts call each
// function by name, since Claude Code follows `$` only into functions a file declares or imports). The base leaves each
// one doing nothing; the feature fills them in, with its own modules beside this file (0.10: claims/term.ts, store.js,
// graph.js, estimate.mjs, folder.program.js, prompts/lens-claims.md, claims-folder.md).
//
//   CLAIMS_KEYS                        its letters at an empty prompt, which no card may take (hooks/keys.ts OWN_KEYS)
//   claimsKey($, key, until)           c: the Claims pane (a taker as hooks/keys.ts takes it)
//   claimsBar($, on, preview)          its items at the bar's left (`c 11 claims`, lit when a claim was corrected)
//   claimsState($)                     what the claims lens's digest reads (./lens.mjs): every claim so far and the
//                                      clusters, as its {{CLAIMS}}, {{CLUSTERS}} and {{GROWN}} lines
//   claimsMerge($, look)               what one look of the observer gave for the claims lens (look.out.claims,
//                                      look.out.clusters), placed by their words in the look's messages
//   claimsLookFailed($, look, why)     a look that gave nothing: the turn's claims are missing, and why
//   drawClaimsPane($, e, args, els)    the side pane of kind `claims` (core/pane.ts)
//   registerClaims                     its own hooks (/claims, ...)
import type { EngineInterface, Register } from 'claude-code'

import type { BarItem } from '../bar/bar'
import type { Take } from '../hooks/keys'
import type { Look } from '../observer/observer'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const CLAIMS_KEYS = ['c']

export async function claimsKey(_$: Engine, _key: string, _until: number): Promise<Take | null> {
  return null
}

export async function claimsBar(_$: Engine, _on: (key: string) => boolean, _preview: boolean): Promise<BarItem[]> {
  return []
}

export async function claimsState(_$: Engine): Promise<Record<string, unknown>> {
  return {}
}

export async function claimsMerge(_$: Engine, _look: Look): Promise<void> {
  return undefined
}

export async function claimsLookFailed(_$: Engine, _look: Look, _why: string): Promise<void> {
  return undefined
}

export async function drawClaimsPane(_$: Engine, _e: Any, _args: unknown, els: Any): Promise<unknown> {
  return els.Text({ dimColor: true, children: 'No claims yet.' })
}

export const registerClaims: Register = () => undefined
