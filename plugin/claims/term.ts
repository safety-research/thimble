// term.ts: Claims in the terminal. The session's claims are kept in <root>/thimble/claims/<session>.json (store.js);
// the observer's pass adds each turn's (its claims lens, lens.mjs); c opens the Claims pane at the right, where the card
// detail opens (graph.js, a program on the card runtime: the claims as a graph in clusters); c in the bar counts them.
//
//   the store    claimsStore / saveClaims: held in $.state for the drawing, written to the folder for a resumed session
//   a turn       claimsDigest (what the lens reads: every claim so far and the clusters) and turnClaims (the
//                lens's claims placed by their words in the turn's messages, with the citations near them); c lights
//                under the answer only when a claim was corrected (noteFor)
//   the pane     c (or /claims) opens the Claims pane in the side panel (shell/side.ts openSide), where the card
//                detail opens: the panel draws the program, holds its keys (the ring walks its rows), and gives it a side
//                thread with an input bar like the prompt, each question about the claim selected. Where a claim was
//                said opens over the pane (the same pane with {source}), as a citation does; esc goes back
//   the folder   a press on the pane's folder action (or /claims folder) asks Claude, as a turn of main, to have one
//                subagent map the claims of the whole folder, with its estimate in the request (estimate.mjs); the subagent
//                saves the map as the card folder-claims (prompts/claims-folder/), and the save brings its claims into
//                the store (foldInSaves)
//
// It registers no model tool and starts no `claude`; the folder's map is built only when the person asks for it.
import type { EngineInterface, Register } from 'claude-code'

import { ask, recordNow, recount, rootHere, sessionIndex, personPrompt } from '../shell/shell'
import { openSide } from '../shell/side'
import { promptFile } from '../prompts/prompts'
import { sessionKey } from '../hooks/conversation'
import { applyTurn, clearGap, emptyStore, grownClusters, isFolderCard, mergeFolder, noteFor, noteGap, readStore } from './store.js'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Store = ReturnType<typeof emptyStore> & Record<string, Any>
type Place = { row: string; by: 'person' | 'claude'; turn: number | null; text: string }

const CLAIMS = { plugin: 'thimble', key: 'claims' } as const
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120) || 'none'
const cut = (s: string, n: number) => ([...s].length <= n ? s : [...s].slice(0, Math.max(0, n - 1)).join('') + '…')

// the folder's estimate, read once per folder for a few minutes (a Node child lists the files and their sizes)
let offer: { root: string; at: number; value: Any | null } | null = null
const OFFER_MS = 5 * 60 * 1000

// ------------------------------------------------------------------------------------------------ the store

async function claimsFile($: Engine): Promise<string | null> {
  const root = await rootHere($)
  return root ? `${root.replace(/\/+$/, '')}/thimble/claims/${safe(await sessionKey($))}.json` : null
}

/** This session's claims: as held, else as on disk, else none yet. A copy: the caller may change it. */
export async function claimsStore($: Engine): Promise<Store> {
  const session = await sessionKey($)
  const held = (await $.state.get(CLAIMS)).value as Store | null | undefined
  if (held && held.session === session) return JSON.parse(JSON.stringify(held))
  return reloadClaims($)
}

/** The claims read again from disk (a resumed session), and held. */
async function reloadClaims($: Engine): Promise<Store> {
  const session = await sessionKey($)
  const file = await claimsFile($)
  let store = emptyStore(session) as Store
  try {
    if (file && (await $.fs.exists(file))) store = readStore(String(await $.fs.read(file)), session) as Store
    else {
      const held = (await $.state.get(CLAIMS)).value as Store | null | undefined
      if (held && held.session === session) store = held
    }
  } catch {
    // a file it cannot read: the claims start again, and the next save writes a whole one
  }
  await $.state.set(CLAIMS, store)
  return JSON.parse(JSON.stringify(store))
}

/** The claims kept: held for the drawing, and written to the folder. With no folder yet they are held only. */
export async function saveClaims($: Engine, store: Store): Promise<void> {
  await $.state.set(CLAIMS, store)
  const file = await claimsFile($)
  if (file) await $.fs.write(file, JSON.stringify(store, null, 1))
  $.clock.after(0, () => { void recount($) })
}

/** How many claims the session holds, for the bar. */
export async function claimCount($: Engine): Promise<number> {
  const held = (await $.state.get(CLAIMS)).value as Store | null | undefined
  if (held && held.session === (await sessionKey($))) return held.claims.length
  return (await reloadClaims($)).claims.length
}

// ------------------------------------------------------------------------------------------------ a turn

/** Where a turn's claims can have been said, from the session's index: the person's prompt before the answer, then
 *  each of Claude's messages up to the answer. `answer` is the turn's answer as the look read it. */
async function turnPlaces($: Engine, answer: string): Promise<{ turn: number | null; rows: string[]; places: Place[] }> {
  const idx = await sessionIndex($)
  const a = answer.trim()
  let end = -1
  for (let i = idx.length - 1; i >= 0 && end < 0; i--) {
    if (idx[i].kind !== 'assistant') continue
    const rec = await recordNow($, String(idx[i].row))
    const t = String(rec?.text || '').trim()
    if (t && (t === a || a.endsWith(t) || t.endsWith(a.slice(-200)))) end = i
  }
  if (end < 0) for (let i = idx.length - 1; i >= 0; i--) if (idx[i].kind === 'assistant') { end = i; break }
  if (end < 0) return { turn: null, rows: [], places: [] }
  let p = -1
  for (let i = end - 1; i >= 0; i--) if (idx[i].kind === 'user' && personPrompt(idx[i])) { p = i; break }
  const turn = p >= 0 ? idx.slice(0, p + 1).filter((x: Any) => x.kind === 'user' && personPrompt(x)).length : null
  const rows = idx.slice(p + 1, end + 1).filter((x: Any) => x.kind === 'assistant').map((x: Any) => String(x.row))
  const places: Place[] = []
  if (p >= 0 && idx[p].text) places.push({ row: String(idx[p].row), by: 'person', turn, text: String(idx[p].text) })
  for (const row of rows) {
    const rec = await recordNow($, row)
    if (rec?.text) places.push({ row, by: 'claude', turn, text: String(rec.text) })
  }
  return { turn, rows, places }
}

/** What the claims lens reads of the state: the store and its grown clusters. */
export async function claimsDigest($: Engine): Promise<{ store: Store; grown: Any[] }> {
  const store = await claimsStore($)
  return { store, grown: grownClusters(store) }
}

/**
 * The lens's claims of one turn into the store, placed by their words in the turn's messages. Returns what the look
 * records, and c's note for the turn's answer when one is due ({row, note, claims}).
 */
export async function turnClaims($: Engine, value: { claims: unknown[]; clusters: unknown[] }, o: { answer: string; turnNo: number; grown: Any[] }): Promise<{ log: Record<string, unknown>; lit: { row: string; note: string; claims: string[] } | null }> {
  const store = await claimsStore($)
  const tp = await turnPlaces($, o.answer)
  const turn = tp.turn ?? o.turnNo
  const at = new Date(await $.clock.now()).toISOString()
  const res = applyTurn(store, { places: tp.places, out: value, turn, at, grown: o.grown })
  clearGap(store, turn)
  await saveClaims($, store)
  const note = noteFor(res)
  const row = tp.rows.at(-1)
  return {
    log: { turn, given: value.claims.length, added: res.added, restated: res.restated, revised: res.revised, dropped: res.dropped, clusters: res.clusters },
    lit: note && row ? { row, note, claims: res.added } : null,
  }
}

/** A turn the observer could not read: said in the pane, with why. */
export async function claimsGap($: Engine, turnNo: number, why: string): Promise<void> {
  const store = await claimsStore($)
  noteGap(store, turnNo, why)
  await saveClaims($, store)
}

// ------------------------------------------------------------------------------------------------ the pane

/** c, or /claims: the Claims pane in the side panel, where the card detail opens, as a thread of its own. Its folder
 *  offer is read meanwhile (a Node child lists the files) and the pane draws again with it. */
export async function openClaims($: Engine): Promise<void> {
  await reloadClaims($)
  await openSide($, { pane: 'claims', args: {}, title: 'Claims' })
  $.clock.after(0, () => { void folderOffer($).catch(() => undefined) })
}

// ------------------------------------------------------------------------------------------------ what the pane asks

/** The store the pane reads: the claims, with the folder's offer when there is no map of it yet. */
export async function claimsPaneStore($: Engine): Promise<unknown> {
  const store = await claimsStore($)
  const root = await rootHere($)
  const o = offer && offer.root === root ? offer.value : null
  return { ...store, offer: store.folder ? null : o?.offer ?? null }
}

/** What the pane's program asks for (k.do) that every pane does not have: where a claim was said (the message that
 *  said it, over the pane, as a citation opens; esc goes back), and the folder's map. False for any other (a citation
 *  opens as any pane's does, over the pane). */
export async function claimsAction($: Engine, a: Record<string, unknown>): Promise<string | boolean | void> {
  const name = String(a.do || '')
  if (name === 'source' && typeof a.id === 'string') {
    await openSide($, { pane: 'claims', args: { source: a.id, ...(typeof a.row === 'string' ? { row: a.row } : {}) }, title: 'Where it was said' }, { push: true })
    return
  }
  // the turn is asked outside the press (as v asks for a view)
  if (name === 'folder') { $.clock.after(0, () => { void askFolder($).then(said => { if (said) $.ui.toast(said) }).catch(() => undefined) }); return }
  return false
}

// ------------------------------------------------------------------------------------------------ the folder

/** The folder's estimate (estimate.mjs), read again after a few minutes, or null where there is no folder. */
async function folderOffer($: Engine): Promise<Any | null> {
  const root = await rootHere($)
  if (!root) return null
  const now = await $.clock.now()
  if (offer && offer.root === root && now - offer.at < OFFER_MS) return offer.value
  const dir = $.plugin.root.replace(/\/+$/, '')
  let value: Any = null
  try {
    const r = await $.process.run(['node', '--permission', `--allow-fs-read=${dir}`, `--allow-fs-read=${root}`, `${dir}/claims/estimate.mjs`, root], { timeoutMs: 30000 })
    value = r.exitCode === 0 ? JSON.parse(r.stdout) : null
  } catch {
    value = null
  }
  offer = { root, at: now, value }
  // the pane draws again with the offer
  const store = (await $.state.get(CLAIMS)).value as Store | null | undefined
  if (store) await $.state.set(CLAIMS, { ...store })
  return value
}

/**
 * The request main gets to map the folder's claims: one subagent reads the rows and saves the map as the card
 * folder-claims; main replies in one or two sentences. Text a model reads (logged with the prompts).
 */
export function folderRequest(o: { root: string; est: Any; guide: string; program: string }): string {
  const file = `${o.root}/thimble/claims/folder.json`
  const under = o.est.read ? ` under ${o.est.read}` : ''
  return [
    `The analyst asked for the claims of the whole folder: ${o.est.what}${under} (${o.est.detail}). It takes a subagent about ${o.est.minutes} minutes.`,
    '',
    'Hand the reading to one subagent with the Agent tool, so the rows it reads stay out of this conversation. Give it this prompt, and add one sentence on what the analyst is looking into if you know:',
    '',
    `"Map the claims of the folder ${o.root}: ${o.est.what}${under}. First read ${o.guide} and follow it. Write the map as JSON to ${file}, then save it with \`thimble save folder-claims --from ${file} --program ${o.program}\` and fix what the save lists. Your last message is the save's line of how many citations hold."`,
    '',
    'When the subagent is done, reply in one or two sentences: what the map holds, and the one thing in it that surprised you most. The analyst sees its claims in the Claims pane (c), beside the claims of this session.',
  ].join('\n')
}

/** The pane's folder row pressed, or /claims folder: Claude is asked to map the folder's claims, as a turn of main. */
async function askFolder($: Engine): Promise<string | void> {
  const root = await rootHere($)
  if (!root) return 'There is no folder here to map yet: ask Claude a question about the files first.'
  const est = (await folderOffer($))?.offer
  if (!est) return 'There are no files here to map.'
  const guide = await promptFile($, 'claims-folder')
  const program = `${$.plugin.root.replace(/\/+$/, '')}/claims/folder.program.js`
  const store = await claimsStore($)
  store.folderAsked = new Date(await $.clock.now()).toISOString()
  await saveClaims($, store)
  // its row reads as the press: `claims of the whole folder (4 files, about 4 min)`
  await ask($, folderRequest({ root, est, guide: guide.file, program }), 'claims', `of the whole folder (${est.what}, about ${est.minutes} min)`)
}

/** Saves the kernel's feed showed (main's or a subagent's): a map of the folder's claims comes into the store. */
export async function foldInSaves($: Engine, saves: { id: string; v: number | null; root: string }[]): Promise<void> {
  for (const ref of saves) {
    if (!isFolderCard(ref.id)) continue
    try {
      const o = JSON.parse(String(await $.fs.read(`${ref.root}/thimble/objects/${ref.id}.json`)))
      const store = await claimsStore($)
      const res = mergeFolder(store, o.data || {}, { card: ref.id, v: Number(o.version) || ref.v, at: new Date(await $.clock.now()).toISOString() })
      delete store.folderAsked
      await saveClaims($, store)
      if (res.added.length || res.restated.length) $.ui.toast(`The folder's map is in Claims: ${store.folder?.claims ?? res.added.length} claims in ${store.folder?.clusters ?? 0} clusters. Press c to see them.`)
    } catch {
      // a map that cannot be read stays a card; the next save of it tries again
    }
  }
}

// ------------------------------------------------------------------------------------------------ hooks

export const registerClaims: Register = on => {
  // /claims: the pane; /claims folder: the folder's map, as a press on the pane's offer
  on('session.start', { cwd: /\// }, async ($, e, next) => {
    const r = await next(e)
    try {
      await $.command.register({ name: 'claims', description: "Open the Claims pane (c), or map the claims of the whole folder: /claims folder", argumentHint: '[folder]', immediate: true })
    } catch {
      // c still opens the pane
    }
    return r
  })
  on('command.run', { command: 'claims' }, async ($, e) => {
    if (/^\s*folder\b/.test(String(e.args || ''))) {
      // the turn is asked after the command is done (a command's hook cannot start one)
      $.clock.after(0, () => { void askFolder($).then(said => { if (said) $.ui.toast(said) }).catch(() => undefined) })
      return {}
    }
    await openClaims($)
    return {}
  })
}

/** For tests: the module's memory, cleared. */
export function resetClaims(): void {
  offer = null
}
