// term.ts: Claims in the terminal. The session's claims are kept in <root>/thimble/claims/<session>.json (store.js);
// the observer's pass adds each turn's (its claims lens, lens.mjs); c opens the Claims pane at the right, where the card
// detail opens (atlas.js, a program on the card runtime); the bar counts the claims.
//
//   the store    claimsStore / saveClaims: held in $.state for the drawing, written to the folder for a resumed session
//   a turn       claimsDigest (what the lens reads: the claims so far that bear on the turn) and turnClaims (the
//                lens's claims placed by their words in the turn's messages, with the citations near them); c lights
//                under the answer only when a new claim reads two ways or one was corrected (noteFor)
//   the pane     toggleClaims (c), docked beside the chat as the detail is, focused: the ring (↑↓) walks its rows and
//                selects what it lands on; 1–9 open the selected claim's evidence as citations open (the tray); a
//                question typed while it is open goes to the selected claim's side thread (thread.ts), never to main
//   the folder   a press on the pane's folder row (or /claims folder) asks Claude, as a turn of main, to have one
//                subagent map the claims of the whole folder, offered with its estimate (estimate.mjs); the subagent
//                saves the map as the card folder-claims (prompts/claims-folder/), and the save brings its claims into
//                the store (foldInSaves)
//
// It registers no model tool and starts no `claude`; the folder's map is built only when the person asks for it.
import type { EngineInterface, Register } from 'claude-code'

import { renderTerm } from '../draw/term.js'
import { barText } from '../panes/host.js'
import { paintRegions, regionOfKey } from '../shell/cells'
import { noteDock, paneColumns } from '../shell/detail'
import { paneClosed, paneDrawing, paneFire, paneNow, paneRun, paneState } from '../shell/panes'
import { ask, currentTheme, keysMoved, openCite, personPrompt, popFocus, pushFocus, recordNow, recount, rootHere, sessionIndex } from '../shell/shell'
import { askThread, restoreThreads } from '../shell/thread'
import { promptFile } from '../prompts/prompts'
import { sessionKey } from '../hooks/conversation'
import { turnWords } from '../observer/turn.mjs'
import { claimRegion } from './atlas.js'
import { applyTurn, clearGap, emptyStore, grownClusters, isFolderCard, mergeFolder, noteFor, noteGap, readStore } from './store.js'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Store = ReturnType<typeof emptyStore> & Record<string, Any>
type Place = { row: string; by: 'person' | 'claude'; turn: number | null; text: string }

export const CPANE = 'claims'
const CLAIMS = { plugin: 'thimble', key: 'claims' } as const
const CLAIMPANE = { plugin: 'thimble', key: 'claimpane' } as const
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120) || 'none'
const cut = (s: string, n: number) => ([...s].length <= n ? s : [...s].slice(0, Math.max(0, n - 1)).join('') + '…')

// the folder's estimate, read once per folder for a few minutes (a Node child lists the files and their sizes)
let offer: { root: string; at: number; value: Any | null } | null = null
const OFFER_MS = 5 * 60 * 1000
// the ring in the pane: the element it stands on, so a drawing puts it back on the selected claim only when it left
let ringAt: string | null = null
// a ring asked for by the program (a press on a related claim), or a row that moved: the region it goes to once drawn
let ringWant: string | null = null

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

/** What the claims lens reads of the state: the store, its grown clusters and the turn's own words. */
export async function claimsDigest($: Engine, msgs: Any[], question: string): Promise<{ store: Store; grown: Any[]; turnText: string }> {
  const store = await claimsStore($)
  return { store, grown: grownClusters(store), turnText: turnWords(msgs, question) }
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

export async function claimsOpen($: Engine): Promise<boolean> {
  return !!(await $.state.get(CLAIMPANE)).value
}

/** c: open the Claims pane, focused, beside the chat (the detail closes: they share the place); c again closes it. */
export async function toggleClaims($: Engine, row: string | null): Promise<void> {
  if (await claimsOpen($)) { await closeClaims($); return }
  await reloadClaims($)
  await $.state.set(CLAIMPANE, { row: row ?? '' })
  await pushFocus($, 'claims')
  ringAt = null
  if ((await $.ui.panes().catch(() => [] as Any[])).some((x: Any) => x.id === 'object' && x.isPlaced)) await $.ui.close({ id: 'object' }).catch(() => undefined)
  // after the key that asked for it is done, so the pane takes the keyboard from the prompt
  $.clock.after(0, () => { void openClaimsPane($) })
  // the folder's offer, read outside the key (a Node child lists the files)
  $.clock.after(0, () => { void folderOffer($).catch(() => undefined) })
}

async function openClaimsPane($: Engine): Promise<void> {
  const r = await $.ui.open({ id: CPANE, title: 'Claims', focus: true, closeOnEscape: true, columns: paneColumns() })
  if (r && (r as Any).isPlaced === false) {
    await closeClaims($)
    $.ui.toast(`The Claims pane needs a wider terminal${(r as Any).reason ? ` (${(r as Any).reason})` : ''}. Widen it, then press c again.`)
  }
}

/** The pane closes; the keys go back to the bar. */
export async function closeClaims($: Engine): Promise<void> {
  if (!(await claimsOpen($))) return
  await $.state.set(CLAIMPANE, null)
  await popFocus($, 'claims')
  paneClosed('claims')
  ringAt = null
  await $.ui.close({ id: CPANE }).catch(() => undefined)
}

/** The keys the pane takes now, as the bar says them, with where a typed question goes. */
export async function claimsKeys($: Engine): Promise<string | undefined> {
  if (!(await claimsOpen($))) return undefined
  // the program run now, at the room it was last drawn in: the bar follows each new selection
  const d = await paneNow($, 'claims')
  const keys = barText([d]).split(' · ').filter(Boolean)
  const c = await selectedClaim($)
  const typed = c ? `type to ask about ${cut(String(c.text), 32)}` : ''
  const esc = keys.findIndex(x => x.startsWith('esc '))
  if (typed) keys.splice(esc >= 0 ? esc : keys.length, 0, typed)
  return keys.join(' · ')
}

/** The claim the pane has selected (its program's selection), or null. */
export async function selectedClaim($: Engine): Promise<Any | null> {
  if (!(await claimsOpen($))) return null
  const d = paneDrawing('claims')
  const id = typeof d?.selected === 'string' && d.selected.startsWith('c-') ? d.selected.slice(2) : ((await paneState($, 'claims')).claim as string | undefined)
  if (!id) return null
  const store = await claimsStore($)
  return store.claims.find((c: Any) => c.id === id || claimRegion(c.id) === `c-${id}`) ?? null
}

/** The thread's label in the bar (`thimble:main/<claim>`), while the pane is open on a claim. */
export async function claimThreadLabel($: Engine): Promise<string | null> {
  const c = await selectedClaim($)
  return c ? `thimble:main/${cut(String(c.text), 32)}` : null
}

/** A question typed while the pane is open: the selected claim's side thread, which main never sees. Returns the
 *  reason Claude Code shows for the dropped prompt, or null when no claim is selected (the prompt goes to main). */
export async function askClaimThread($: Engine, text: string): Promise<string | null> {
  const c = await selectedClaim($)
  if (!c) return null
  const root = (await rootHere($)) || String(await $.session.cwd())
  await restoreThreads($, root)
  const said = (c.said || []).find((s: Any) => s.sentence || s.quote)
  const r = await askThread($, {
    text, root, card: null,
    scope: { claim: c.id, label: cut(String(c.text), 120), ...(said?.row ? { row: said.row } : {}), ...(said ? { said: cut(String(said.sentence || said.quote), 240) } : {}) },
    refs: (c.sources || []).map((s: Any) => s.ref).slice(0, 6),
  })
  if (r.problem) return `${r.problem}. Your words are back in the prompt; esc closes the Claims pane, and the prompt then goes to Claude here.`
  $.clock.after(30, () => { void $.prompt.fill({ text: '', mode: 'replace' }).catch(() => undefined) })
  // the pane takes the keys again, the ring on the claim
  $.clock.after(60, () => { void claimsTakeKeys($).catch(() => undefined) })
  return `asked the thread of the claim "${cut(String(c.text), 40)}"`
}

/** The pane takes the keys again (after the tray closed over it, or a question went to a claim's thread): the ring on
 *  the selected claim. */
export async function claimsTakeKeys($: Engine, tries = 3): Promise<void> {
  if (!(await claimsOpen($))) return
  ringAt = null
  // Claude Code grants the keys only over an empty prompt, and the key that closed the tray may still stand in it: so
  // the keys are asked for again a moment later, until the ring is on the claim
  await $.ui.open({ id: CPANE, focus: true, closeOnEscape: true, columns: paneColumns() }).catch(() => null)
  const focused = (await $.ui.panes().catch(() => [] as Any[])).some((x: Any) => x.id === CPANE && x.isFocused)
  if (focused) await ringToSelected($)
  else if (tries > 1) $.clock.after(250, () => { void claimsTakeKeys($, tries - 1).catch(() => undefined) })
}

/** The ring onto the selected claim's row, when the drawing has it. */
async function ringToSelected($: Engine, region?: string): Promise<void> {
  const d = paneDrawing('claims')
  const want = region ?? (typeof d?.selected === 'string' ? d.selected : null)
  if (!want || !lastKeys.has(want)) return
  const key = lastKeys.get(want)!
  if (ringAt === key) return
  const r = await $.ui.focus({ requestId: CPANE, key }).catch(() => ({ deny: 'failed' }))
  if (!(r as Any)?.deny) ringAt = key
}

// the cell key of each region's first row in the last drawing (`r|p-claims|<row>|<region>`)
const lastKeys = new Map<string, string>()

/** The pane drawn: the program on the store, in the room the dock gives, each row a press and a place for the ring. */
async function claimsPaneNow($: Engine, e: Any): Promise<Any> {
  noteDock(e)
  await $.state.get(CLAIMS)
  await $.state.get(CLAIMPANE)
  const els = $.ui.resolve(e) as Any
  const w = Math.max(40, (e.props.bodyColumns ?? 100) - 1)
  const h = Math.max(12, e.props.scroll?.bodyRows ?? 40)
  const d = await paneRun($, 'claims', {}, { w, h })
  const grid = renderTerm(d, { w })
  lastKeys.clear()
  const keys = new Set<string>()
  for (const r of grid.regions as Any[]) {
    for (const q of r.rects || []) for (let y = q.y; y < q.y + q.h; y++) keys.add(`r|p-claims|${y}|${r.id}`)
    if (r.rects?.length && !lastKeys.has(r.id)) lastKeys.set(r.id, `r|p-claims|${r.rects[0].y}|${r.id}`)
  }
  // the ring stays on what it was on: a row that moved (a line came in above it) takes it to the row's new place, and
  // a row that went puts it back on the selected claim
  if (ringAt && !keys.has(ringAt)) {
    const was = regionOfKey(ringAt)
    ringAt = null
    if (was && lastKeys.has(was)) ringWant = was
  }
  // the ring follows the selection: a drawing that moved it (a press on a related claim) puts it back on the claim
  if (e.props.isFocused) $.clock.after(0, () => { void ringFollow($).catch(() => undefined) })
  return paintRegions(grid as Any, els, {
    theme: currentTheme(), key: 'p-claims', painted: true, selected: typeof d?.selected === 'string' ? d.selected : null,
    onPress: (id: string) => { void paneFire($, 'claims', {}, { type: 'press', region: id }) },
  })
}

async function ringFollow($: Engine): Promise<void> {
  if (ringWant && lastKeys.has(ringWant)) { const w = ringWant; ringWant = null; await ringToSelected($, w); return }
  if (!ringAt) await ringToSelected($)
}

// ------------------------------------------------------------------------------------------------ what the pane asks

/** The store the pane reads: the claims, with the folder's offer when there is no map of it yet. */
export async function claimsPaneStore($: Engine): Promise<unknown> {
  const store = await claimsStore($)
  const root = await rootHere($)
  const o = offer && offer.root === root ? offer.value : null
  return { ...store, offer: store.folder ? null : o?.offer ?? null }
}

/** What the pane's program asks for (k.do): a citation opened in the tray, the message where a claim was said, the
 *  folder's map, the ring on a row, closing. */
export async function claimsAction($: Engine, a: Record<string, unknown>): Promise<string | boolean | void> {
  const name = String(a.do || '')
  if (name === 'cite' && typeof a.ref === 'string') { await openCite($, a.ref, typeof a.label === 'string' ? a.label : a.ref); return }
  if (name === 'said' && typeof a.row === 'string') {
    await $.ui.scroll({ to: { key: `msg-${a.row}-b0` }, block: 'nearest' }).catch(() => undefined)
    return
  }
  // the turn is asked outside the press (as v asks for a view)
  if (name === 'folder') { $.clock.after(0, () => { void askFolder($).then(said => { if (said) $.ui.toast(said) }).catch(() => undefined) }); return }
  if (name === 'ring' && typeof a.region === 'string') { ringWant = a.region; return }
  if (name === 'close') { await closeClaims($); return }
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
  // /claims: the pane; /claims folder: the folder's map, as f in the pane
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
    if (!(await claimsOpen($))) await toggleClaims($, null)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: CPANE }, async ($, e) => {
    try {
      return await claimsPaneNow($, e)
    } catch (err) {
      const { Text } = $.ui.resolve(e) as Any
      return Text({ color: 'error', wrap: 'wrap', children: `The claims could not be drawn (${cut(String((err as Error)?.message || err), 120)}). Press esc, then c to open them again.` })
    }
  })

  on('ui.close', { id: CPANE }, async ($, e, next) => {
    try {
      if ((e.origin as { kind?: string }).kind === 'person') keysMoved(await $.clock.now())
      await $.state.set(CLAIMPANE, null)
      await popFocus($, 'claims')
      paneClosed('claims')
      ringAt = null
    } catch {
      // the pane closes whatever the shell makes of it
    }
    return next(e)
  })

  // the ring on a row of the pane: a cluster or a claim it lands on is selected (the program's focus event)
  on('ui.focus', { requestId: CPANE }, async ($, e, next) => {
    const r = await next(e)
    try {
      const el = typeof e.element === 'string' ? e.element : ''
      if (!r.deny && el) {
        ringAt = el
        const region = regionOfKey(el)
        if (region && (e.origin as { kind?: string }).kind === 'person') await paneFire($, 'claims', {}, { type: 'focus', region })
      }
    } catch {
      // the ring moves whatever the shell makes of it
    }
    return r
  }).catch(($, e, next) => next(e))
}

/** For tests: the module's memory, cleared. */
export function resetClaims(): void {
  offer = null
  ringAt = null
  ringWant = null
  lastKeys.clear()
}
