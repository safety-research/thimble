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
//   the folder   a press on the pane's folder action (or /claims folder) asks Claude, as a turn of main's (core/tell.ts
//                askMain), to have one subagent map the claims of the whole folder, with its estimate in the request
//                (estimate.mjs); the subagent writes the map as JSON and keeps it with `thimble claims save`, which
//                checks every citation (engine/kernel/claims.py) and writes a `folder_claims` line to the change feed;
//                core/feed.ts hands it to folderClaimsFromFeed, which brings the map's claims into the store
//
// It registers no model tool and starts no `claude`; the folder's map is built only when the person asks for it.
import type { EngineInterface, Register } from 'claude-code'

import { busyWhile } from '../bar/busy'
import { failNotice, noticeLine } from '../bar/notice'
import { actingRow, messageOf, partOf, setPart, turnOf, turnsNow } from '../core/answers'
import { isPersonPrompt } from '../core/answers.mjs'
import { readKept, rootHere, startDir, writeKept } from '../core/env'
import { tempDir } from '../core/home'
import { openPane } from '../core/pane'
import { askMain } from '../core/tell'
import { sessionKey } from '../hooks/conversation'
import type { Look } from '../observer/observer'
import { promptText } from '../prompts/prompts'
import { applyTurn, clearGap, emptyStore, grownClusters, grownLines, mergeFolder, noteFor, noteGap, promptLines, readStore } from './store.js'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Store = ReturnType<typeof emptyStore> & Record<string, Any>
type Place = { row: string; by: 'person' | 'claude'; turn: number | null; text: string }
/** What c shows for one answer: lit with a note when a look corrected a claim in it. */
export type ClaimsPart = { lit: true; note: string; claims: string[] }
/** The pane's arguments: the claim selected, what its box opened, the last turn when it was selected; with `source`,
 *  where that claim was said. */
export type ClaimsArgs = { claim?: string | null; open?: 'ev' | 'hist' | null; at?: number | null; source?: string; row?: string }

const CLAIMS = { plugin: 'thimble', key: 'claims' } as const
const OFFER = { plugin: 'thimble', key: 'claimsOffer' } as const
const BRIGHT = { plugin: 'thimble', key: 'claimsBright' } as const
/** How long the bar's count is bold after new claims, as in 0.10. */
const BRIGHT_MS = 1600
const FILE = 'claims.json'
const OFFER_MS = 5 * 60 * 1000

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
  await $.state.set(CLAIMS, store)
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

/** c on the bar: `c 11 claims`, lit with its note when a claim of the answer the keys act on was corrected
 *  (`c ● 12 claims, 1 corrected`). */
/** Whether the bar's count is bold now: for a moment after the count went up. */
export async function claimsBright($: Engine): Promise<boolean> {
  const at = (await $.state.get(BRIGHT)).value
  return typeof at === 'number' && Number(await $.clock.now()) - at < BRIGHT_MS
}

export async function claimsBarWords($: Engine): Promise<string> {
  const n = await claimCount($)
  const words = n === 1 ? '1 claim' : n > 1 ? `${n.toLocaleString('en-US')} claims` : 'claims'
  const row = await actingRow($)
  const lit = row ? await partOf<ClaimsPart>($, row, 'claims') : null
  return lit?.note ? `● ${words}, ${lit.note}` : words
}

/** c, or /claims: the Claims pane, holding the keyboard. Its folder offer is read meanwhile (a Node child lists the
 *  files) and the pane draws again with it. */
export async function openClaims($: Engine, args: ClaimsArgs = {}): Promise<void> {
  await reloadClaims($)
  const placed = await openPane($, 'claims', args, args.source ? 'Where it was said' : 'Claims', { focus: true, rows: 36 })
  if (!placed) noticeLine($, 'Claude Code did not open the Claims pane here: the terminal is too narrow. Type /claims to open it.')
  $.clock.after(0, () => { void folderOffer($).catch(() => undefined) })
}

/** The pane shows other arguments (the person moved in it). */
export async function showClaims($: Engine, args: ClaimsArgs): Promise<void> {
  await openPane($, 'claims', args, args.source ? 'Where it was said' : 'Claims')
}

// ------------------------------------------------------------------------------------------------ the folder

/** The store the pane reads: the claims, with the folder's offer when there is no map of it yet. */
export async function claimsPaneStore($: Engine): Promise<Store> {
  const store = await claimsStore($)
  const root = (await rootHere($)) ?? (await startDir($))
  const o = (await $.state.get(OFFER)).value as { root: string; at: number; value: Any } | null | undefined
  return { ...store, offer: store.folder ? null : o && o.root === root ? o.value?.offer ?? null : null }
}

/** The folder's estimate (estimate.mjs), read again after a few minutes, or null where there is no folder. */
async function folderOffer($: Engine): Promise<Any | null> {
  const root = (await rootHere($)) ?? (await startDir($))
  if (!root) return null
  const now = Number(await $.clock.now())
  const held = (await $.state.get(OFFER)).value as { root: string; at: number; value: Any } | null | undefined
  if (held && held.root === root && now - held.at < OFFER_MS) return held.value
  const dir = $.plugin.root.replace(/\/+$/, '')
  let value: Any = null
  try {
    const r = await $.process.run(['node', '--permission', `--allow-fs-read=${dir}`, `--allow-fs-read=${root}`, `${dir}/claims/estimate.mjs`, root], { timeoutMs: 30000 })
    value = r.exitCode === 0 ? JSON.parse(String(r.stdout)) : null
  } catch {
    value = null
  }
  // the pane draws again with the offer
  await $.state.set(OFFER, { root, at: now, value })
  return value
}

/**
 * The request main gets to map the folder's claims: one subagent reads the files, writes the map and keeps it with
 * `thimble claims save`; main then draws the map as a card and replies in one or two sentences. Text a model reads.
 */
export function folderRequest(o: { root: string; est: Any; guide: string; file: string }): string {
  const under = o.est.read ? ` under ${o.est.read}` : ''
  return [
    `The analyst asked for the claims of the whole folder: ${o.est.what}${under} (${o.est.detail}). It takes a subagent about ${o.est.minutes} minutes.`,
    '',
    'Hand the reading to one subagent with the Agent tool, so the records it reads stay out of this conversation. Give it this prompt, and add one sentence on what the analyst is looking into if you know:',
    '',
    `"Map the claims of the folder ${o.root}: ${o.est.what}${under}. First read ${o.guide} and follow it. Write the map as JSON to ${o.file}, then keep it with \`thimble claims save --from ${o.file}\` and fix what the save lists. Your last message is the save's line of how many citations hold."`,
    '',
    `When the subagent is done, draw the map as a card from ${o.file}: one row per cluster, with its name, a dot per claim in the cluster's color, how many, and its lead claim. Then reply in one or two sentences: what the map holds, and the one thing in it that surprised you most. The analyst sees its claims in the Claims pane (c), beside the claims of this session.`,
  ].join('\n')
}

/** The pane's folder action pressed, or /claims folder: Claude is asked to map the folder's claims, as a turn of
 *  main's. Answers why it did not ask, or nothing. */
export async function askFolder($: Engine): Promise<string | void> {
  const root = (await rootHere($)) ?? (await startDir($))
  if (!root) return 'There is no folder here to map.'
  const est = (await folderOffer($))?.offer
  if (!est) return 'There are no files here to map.'
  // the subagent's guide, as a file it reads (main hands it the path, not the text)
  const tmp = await tempDir($)
  const guide = `${tmp}/claims-folder.md`
  await $.fs.write(guide, await promptText($, 'claims-folder'))
  const file = `${tmp}/folder-claims.json`
  const store = await claimsStore($)
  store.folderAsked = new Date(Number(await $.clock.now())).toISOString()
  await saveClaims($, store)
  // the prompt reads as the press: `map the claims of this folder (4 files, about 4 min)`
  await askMain($, 'claims-folder', folderRequest({ root, est, guide, file }), `map the claims of this folder (${est.what}, about ${est.minutes} min)`)
  // the bar shows the map on its way: until its claims come in, while the turn that asked for it runs (or is about to)
  const asked = Number(await $.clock.now())
  void busyWhile($, 'mapping claims', async () => {
    if (!(await claimsStore($)).folderAsked) return false
    const last = (await turnsNow($)).at(-1)
    return Number(await $.clock.now()) - asked < 60000 || (!!last && last.endedAt == null)
  })
}

/** Runs askFolder outside the hook that asked (a command's or a press's hook cannot start a turn), saying why when it
 *  did not ask. */
export function askFolderLater($: Engine): void {
  $.clock.after(0, () => {
    void askFolder($).then(said => { if (said) noticeLine($, said) }).catch(err => failNotice($, `thimble could not ask Claude for the folder's claims: ${String((err as Error)?.message || err).slice(0, 160)}.`, 'claims'))
  })
}

/** A `folder_claims` line of the change feed (`thimble claims save`, main's or a subagent's): the kept map's claims come
 *  into the store. */
export async function folderClaimsFromFeed($: Engine, ev: Any): Promise<void> {
  const path = typeof ev?.path === 'string' ? ev.path : ''
  if (!path) return
  let o: Any
  try {
    o = JSON.parse(String(await $.fs.read(path)))
  } catch (err) {
    failNotice($, `thimble could not read the folder's map of claims (${String((err as Error)?.message || err).slice(0, 120)}). Ask Claude to save it again with thimble claims save.`, 'claims')
    return
  }
  const store = await claimsStore($)
  const res: Any = mergeFolder(store, o.data || {}, { card: 'folder-claims', v: null, at: new Date(Number(await $.clock.now())).toISOString() })
  delete store.folderAsked
  await saveClaims($, store)
  if (res.added.length || res.restated.length) noticeLine($, `The folder's map is in Claims: ${store.folder?.claims ?? res.added.length} claims in ${store.folder?.clusters ?? 0} clusters. Press c to see them.`)
}

// ------------------------------------------------------------------------------------------------ hooks

export const registerClaimsTerm: Register = on => {
  // /claims: the pane; /claims folder: the folder's map, as a press on the pane's offer
  on('session.start', { cwd: /\// }, async ($, e, next) => {
    const r = await next(e)
    try {
      await $.command.register({ name: 'claims', description: 'Open the Claims pane (c), or map the claims of the whole folder: /claims folder', argumentHint: '[folder]', immediate: true })
    } catch {
      // c still opens the pane
    }
    return r
  }).catch(($, e, next) => next(e))
  on('command.run', { command: /^(thimble:)?claims$/ }, async ($, e) => {
    if (/^\s*folder\b/.test(String(e.args || ''))) {
      askFolderLater($)
      return {}
    }
    await openClaims($)
    return {}
  })
}
