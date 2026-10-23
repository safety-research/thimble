// term.ts: Claims in the terminal. The conversation's claims are kept in claims.json in its kept folder (core/env.ts
// keptDir; store.js says the shape); the observer's look adds each answer's (its claims lens, lens.mjs); c opens the
// Claims pane at the right (pane.tsx, graph.js: the claims as a graph in clusters); c on the bar counts them.
//
//   the store    claimsStore / saveClaims: held in $.state for the drawing, written to the kept folder for a resumed
//                conversation
//   a look       claimsDigest (what the lens reads: every claim so far and the clusters) and lookClaims (the lens's
//                claims placed by their words in the looked-at turns' messages, with the citations near them); c is
//                lit on the bar for the answer only when a claim was corrected (store.js noteFor), as a `claims` part
//                of that answer (core/answers.ts setPart)
//   the pane     c (or /claims) opens the Claims pane (core/pane.ts kind `claims`), which takes the keyboard
//
// It registers no model tool and starts no `claude`.
import type { EngineInterface, Register } from 'claude-code'

import { noticeLine } from '../bar/notice'
import { actingRow, messageOf, partOf, setPart, turnOf, turnsNow } from '../core/answers'
import { isPersonPrompt } from '../core/answers.mjs'
import { readKept, writeKept } from '../core/env'
import { openPane } from '../core/pane'
import { sessionKey } from '../hooks/conversation'
import type { Look } from '../observer/observer'
import { applyTurn, clearGap, emptyStore, grownClusters, grownLines, noteFor, noteGap, promptLines, readStore } from './store.js'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Store = ReturnType<typeof emptyStore> & Record<string, Any>
type Place = { row: string; by: 'person' | 'claude'; turn: number | null; text: string }
/** What c shows for one answer: lit with a note when a look corrected a claim in it. */
export type ClaimsPart = { lit: true; note: string; claims: string[] }
/** The pane's arguments: the claim picked, else the cluster chosen (its key: graph.js groupKey), the last turn when it
 *  was chosen; with a claim, `open` while its evidence is open, `cite` the citation shown (from 0), `all` the whole
 *  history, `whole` the citation's code and output whole; `from` the first claim of the list's window, once the person
 *  paged it; with `source`, where that claim was said. */
export type ClaimsArgs = {
  claim?: string | null; group?: string | null; at?: number | null; open?: boolean; cite?: number; all?: boolean; whole?: boolean; from?: number
  source?: string; row?: string
}

const CLAIMS = { plugin: 'thimble', key: 'claims' } as const
const BRIGHT = { plugin: 'thimble', key: 'claimsBright' } as const
/** How long the bar's count is bold after new claims, as in 0.10. */
const BRIGHT_MS = 1600
const FILE = 'claims.json'

// ------------------------------------------------------------------------------------------------ the store

/** This conversation's claims: as held, else as kept, else none yet. A copy: the caller may change it. */
export async function claimsStore($: Engine): Promise<Store> {
  const session = await sessionKey($)
  const held = (await $.state.get(CLAIMS)).value as Store | null | undefined
  if (held && held.session === session) return JSON.parse(JSON.stringify(held))
  return reloadClaims($)
}

/** The claims read again from the kept folder (a resumed conversation), and held. */
async function reloadClaims($: Engine): Promise<Store> {
  const session = await sessionKey($)
  const kept = await readKept<unknown>($, FILE)
  const store = (kept ? readStore(kept, session) : emptyStore(session)) as Store
  store.session = session
  // (a drawing may ask first, and a drawing cannot write the state: it reads the kept claims again until a hook holds
  // them)
  try { await $.state.set(CLAIMS, store) } catch { /* held at the session's start, or at the next change */ }
  return JSON.parse(JSON.stringify(store))
}

/** The claims kept: held for the drawing, and written to the kept folder. */
export async function saveClaims($: Engine, store: Store): Promise<void> {
  const before = ((await $.state.get(CLAIMS)).value as Store | null | undefined)?.claims.length ?? 0
  await $.state.set(CLAIMS, store)
  // more claims: the bar's count is bold for a moment, and plain again after it
  if (store.claims.length > before) {
    await $.state.set(BRIGHT, Number(await $.clock.now()))
    $.clock.after(BRIGHT_MS + 50, () => { void (async () => { await $.state.set(BRIGHT, null) })().catch(() => undefined) })
  }
  await writeKept($, FILE, store).catch(() => undefined)
}

/** A /clear or a /resume (hooks/turnover.ts): the new conversation's claims are held before anything draws their
 *  count. */
export async function turnClaims($: Engine): Promise<void> {
  await $.state.set(BRIGHT, null)
  await claimsStore($)
}

/** How many claims the conversation holds, for the bar. */
export async function claimCount($: Engine): Promise<number> {
  return (await claimsStore($)).claims.length
}

// ------------------------------------------------------------------------------------------------ a look

/** Where the looked-at messages' claims can have been said: each turn's prompt when the person wrote it, then each of
 *  Claude's messages of the turn up to the one looked at. */
async function lookPlaces($: Engine, look: Look): Promise<Place[]> {
  const places: Place[] = []
  const upTo = new Map<string, string>()
  for (const m of look.msgs) upTo.set(m.turnId, m.row)
  for (const [turnId, last] of upTo) {
    const t = await turnOf($, turnId)
    if (!t) continue
    if (isPersonPrompt(t.prompt.by) && t.prompt.text) places.push({ row: t.prompt.row ?? promptRow(t.turnId), by: 'person', turn: t.n, text: t.prompt.text })
    for (const row of t.rows) {
      const m = await messageOf($, row)
      if (m?.text) places.push({ row, by: 'claude', turn: t.n, text: m.text })
      if (row === last) break
    }
  }
  return places
}

/** The row a turn's prompt is known by when Claude Code gave it none. */
const promptRow = (turnId: string) => `prompt-${turnId}`

/** The words of the message a claim was said in: one of Claude's text rows, or a turn's prompt. */
export async function placeText($: Engine, row: string): Promise<string | null> {
  const m = await messageOf($, row)
  if (m?.text) return m.text
  const t = (await turnsNow($)).find(x => x.prompt.row === row || promptRow(x.turnId) === row)
  return t?.prompt.text ?? null
}

/** What the claims lens reads: every claim so far and the clusters, and the clusters grown enough to rename or split. */
export async function claimsDigest($: Engine): Promise<{ claims: { CLAIMS: string; CLUSTERS: string; GROWN: string } }> {
  const store = await claimsStore($)
  const lines = promptLines(store, Infinity)
  const grown = grownClusters(store)
  return { claims: { CLAIMS: lines.claims, CLUSTERS: lines.clusters, GROWN: grown.length ? `\nGrown clusters, which you can rename or split:\n${grownLines(grown)}\n` : '' } }
}

/** The lens's claims of one look into the store, placed by their words in the looked-at messages; c lit for the
 *  newest answer when a claim was corrected. */
export async function lookClaims($: Engine, look: Look): Promise<void> {
  const store = await claimsStore($)
  const grown = grownClusters(store)
  const newest = look.msgs[look.msgs.length - 1]
  if (!newest) return
  const places = await lookPlaces($, look)
  const turn = newest.turnNo
  const at = new Date(Number(await $.clock.now())).toISOString()
  const res: Any = applyTurn(store, { places, out: { claims: look.out.claims, clusters: look.out.clusters }, turn, at, grown })
  for (const m of look.msgs) clearGap(store, m.turnNo)
  await saveClaims($, store)
  look.log('claims', { turn, given: Array.isArray(look.out.claims) ? look.out.claims.length : 0, added: res.added, restated: res.restated, revised: res.revised, dropped: res.dropped, clusters: res.clusters })
  const note = noteFor(res)
  if (note && newest.kind === 'answer') await setPart<ClaimsPart>($, newest.row, 'claims', { lit: true, note, claims: res.added })
}

/** A look that gave nothing: said in the pane, with why. */
export async function lookFailed($: Engine, look: Look, why: string): Promise<void> {
  const store = await claimsStore($)
  for (const turn of new Set(look.msgs.map(m => m.turnNo))) noteGap(store, turn, why)
  await saveClaims($, store)
}

// ------------------------------------------------------------------------------------------------ the bar and c

/** c on the bar: `c 11 claims`, in the lit color when a claim of the answer the keys act on was corrected. */
/** Whether the bar's count is bold now: for a moment after the count went up. */
export async function claimsBright($: Engine): Promise<boolean> {
  const at = (await $.state.get(BRIGHT)).value
  return typeof at === 'number' && Number(await $.clock.now()) - at < BRIGHT_MS
}

export async function claimsBarWords($: Engine): Promise<string> {
  const n = await claimCount($)
  const words = n === 1 ? '1 claim' : n > 1 ? `${n.toLocaleString('en-US')} claims` : 'claims'
  return words
}

/** Whether the bar's count is lit: a claim of the answer the keys act on was corrected. */
export async function claimsLit($: Engine): Promise<boolean> {
  const row = await actingRow($)
  const lit = row ? await partOf<ClaimsPart>($, row, 'claims') : null
  return !!lit?.note
}

/** c, or /claims: the Claims pane, holding the keyboard. */
export async function openClaims($: Engine, args: ClaimsArgs = {}): Promise<void> {
  await reloadClaims($)
  const placed = await openPane($, 'claims', args, args.source ? 'Where it was said' : 'Claims', { focus: true, rows: 36 })
  if (!placed) noticeLine($, 'Claude Code did not open the Claims pane here: the terminal is too narrow. Type /claims to open it.')
}

/** The pane shows other arguments (the person moved in it, by a key or a click), and holds the keyboard: Claude Code
 *  stops a click at the Button it lands on, so a click alone does not give the pane back the keyboard. (Claude Code
 *  leaves the keyboard at a prompt that holds typed words.) */
export async function showClaims($: Engine, args: ClaimsArgs): Promise<void> {
  await openPane($, 'claims', args, args.source ? 'Where it was said' : 'Claims', { focus: true })
}

// ------------------------------------------------------------------------------------------------ hooks

export const registerClaimsTerm: Register = on => {
  // /claims: the pane; a resumed conversation's claims, held before the bar draws their count
  on('session.start', { cwd: /\// }, async ($, e, next) => {
    const r = await next(e)
    try { await turnClaims($) } catch { /* read from the kept folder when drawn */ }
    try {
      await $.command.register({ name: 'claims', description: 'Open the Claims pane (c)', immediate: true })
    } catch {
      // c still opens the pane
    }
    return r
  }).catch(($, e, next) => next(e))
  on('command.run', { command: /^(thimble:)?claims$/ }, async ($) => {
    await openClaims($)
    return {}
  })
}
