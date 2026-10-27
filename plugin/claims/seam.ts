// seam.ts: where Claims meet the rest of thimble (core/answerview.ts, core/pane.ts and observer/observer.ts
// call each function by name, since Claude Code follows `$` only into functions a file declares or imports). The
// feature's modules stand beside this file: term.ts (the store, a look's claims, w), store.js (the claims as
// pure functions), graph.js and pane.tsx (the pane), lens.mjs (the observer's claims lens); prompts/lens-claims.md.
//
//   CLAIMS_KEYS                        its letters at an empty prompt, which no card may take (hooks/keys.ts ownKeys)
//   claimsKey($, key, until)           w, while the bar names it: the Claims pane, or closed while the side pane shows
//                                      it, once the word window closed (a taker as hooks/keys.ts takes it); a w while
//                                      the bar last drew beside the pane only closes it, if it still shows then
//   claimsPaneClosed()                 the side pane closed (core/pane.ts): the next w opens the claims, though the bar
//                                      has not drawn since
//   claimsBar($, on, preview)          its items at the bar's right (`w 11 claims`, lit when a claim was corrected); a
//                                      press does what w does. claimsReady: whether it names w, as the plugin loads
//   claimsState($)                     what the claims lens's digest reads (./lens.mjs): every claim so far and the
//                                      clusters, as its {{CLAIMS}}, {{CLUSTERS}} and {{GROWN}} lines
//   claimsMerge($, look)               what one look of the observer gave for the claims lens (look.out.claims,
//                                      look.out.clusters), placed by their words in the look's messages
//   claimsLookFailed($, look, why)     a look that gave nothing: the turn's claims are missing, and why
//   claimsUnread($)                    the answered turns whose answers the claims have not read (found on demand)
//   claimsFindStart($, n), claimsFindEnd($)   a look that reads the claims of n answers (on demand, or after a reply)
//                                      began, or ended
//   CLAIMS_FIND                        the address of f's Button in the pane (the observer's ui.press hook finds)
//   drawClaimsPane($, e, args, els)    the side pane of kind `claims` (core/pane.ts)
//   claimsThreadScope($, args)         what the side thread under the claims pane is about: the claim selected, the
//                                      cluster selected, or where a claim was said, with the words its input bar's
//                                      placeholder names and the claim a side answer answers (threads/pane.tsx)
//   registerClaims                     its own hooks (x in the pane, which starts a repair inside its
//                                      ui.press hook, as the tray's does)
import type { EngineInterface, Register } from 'claude-code'

import type { BarItem } from '../bar/bar'
import { failNotice } from '../bar/notice'
import { closePane, paneShows } from '../core/pane'
import { accent } from '../core/theme'
import type { Take } from '../hooks/keys'
import type { Look } from '../observer/observer'
import { featureOn } from '../settings/features.mjs'
import type { TurnRec } from '../core/answers'
import { CLAIMS_FIND as FIND, CLAIMS_REPAIR, claimsThreadScope as threadScope, drawClaims, repairShown } from './pane'
import { claimCount, claimsBarWords, claimsBright, claimsDigest, claimsFresh, claimsLit, claimsToFind, claimsUnread as unread, findEnd, findStart, lookClaims, lookFailed, openClaims, registerClaimsTerm } from './term'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const CLAIMS_KEYS = ['w']
export const CLAIMS_FIND = FIND

/** Whether the bar names w, as it last drew (claimsBar): w acts only then, as r and l act only while the bar names them
 *  (bar/register.ts barKey). Kept in memory, so the key reads no state. */
let named = false
/** Whether the side pane showed the claims as the bar last drew: a w then means to close it. */
let drawnOpen = false

export async function claimsKey($: Engine, key: string, _until: number): Promise<Take | null> {
  if (key !== 'w' || !named || !featureOn('claims')) return null
  // after the word window, as 0.10 did: `w` that starts a word is typed. A w typed while the pane shows the claims (in
  // the pane, which leaves w to the prompt) closes it, if esc, its × or a click has not closed it within the window;
  // it never opens it again
  const close = drawnOpen
  return { later: () => (close ? closeClaims($) : toggleClaims($, true)) }
}

/** The side pane closed (esc or its close mark, core/pane.ts), which may draw the bar no more: a w then opens the
 *  claims again. */
export function claimsPaneClosed(): void {
  drawnOpen = false
}

/** The pane closed, while it shows the claims. */
async function closeClaims($: Engine): Promise<void> {
  if (await paneShows($, 'claims').catch(() => false)) await closePane($)
}

/** w, or a press on the bar's item: the Claims pane, or closed while the side pane shows it, as r and l do for theirs
 *  (bar/register.ts). `byKey`: w at the prompt (term.ts openClaims). */
async function toggleClaims($: Engine, byKey = false): Promise<void> {
  if (await paneShows($, 'claims').catch(() => false)) await closePane($)
  else await openClaims($, {}, byKey)
}

export async function claimsBar($: Engine, on: (key: string) => boolean, preview: boolean): Promise<BarItem[]> {
  if (preview) return on('claims') ? [{ id: 'claims', key: 'w', words: 'evidence' }] : []
  const items = on('claims') ? await barItems($) : []
  named = items.length > 0
  return items
}

/** Whether the bar names w, worked out as the plugin loads (core/answerview.ts keysReady), so a w before the bar's
 *  first drawing acts as the bar will name it. */
export async function claimsReady($: Engine): Promise<void> {
  await claimsBar($, featureOn, false)
}

async function barItems($: Engine): Promise<BarItem[]> {
  const press = () => toggleClaims($)
  drawnOpen = await paneShows($, 'claims').catch(() => false)
  // no claims yet: the pane finds them on demand, so the item shows, without a count, once an answer waits for it, and
  // while the pane shows (it found none), so that w closes it
  if (!(await claimCount($))) return (await claimsToFind($)).answers || drawnOpen ? [{ id: 'claims', key: 'w', words: 'evidence', press }] : []
  const words = await claimsBarWords($)
  // in thimble's color when a claim was corrected, as squeeze's; bold for a moment after new claims. The session's
  // first claims: the count pulses
  const first = await claimsFresh($)
  const look = first.lit || await claimsLit($) ? { color: accent() } : {}
  return [{ id: 'claims', key: 'w', words, ...look, ...(first.lit || await claimsBright($) ? { bold: true } : {}), press }]
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

export async function claimsUnread($: Engine): Promise<TurnRec[]> {
  return unread($)
}

export async function claimsFindStart($: Engine, n: number): Promise<void> {
  await findStart($, n)
}

export async function claimsFindEnd($: Engine): Promise<void> {
  await findEnd($)
}

export async function drawClaimsPane($: Engine, e: Any, args: unknown, els: Any): Promise<unknown> {
  return drawClaims($, e, args, els)
}

export async function claimsThreadScope($: Engine, args: unknown): Promise<{ about: string; args: unknown; ask: string; quote?: string }> {
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
