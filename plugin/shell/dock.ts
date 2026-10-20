// dock.ts: thimble's docked panes beside the conversation, where the card detail docks: Coverage (what Claude read
// of the folder, panes/coverage.js) and the label viewer (panes/labels.js). The bar's right pane names them: `coverage
// 34%` with a small bar of the folder's file types, and `2 labels` once the session has labels; a click on either, or
// its key (r, l) from the empty prompt, opens its pane, and the same again closes it.
//
//   open/close   each its own docked pane (ids `coverage` and `labels`), leaving the chat its share as the detail does;
//                it takes the keys while the prompt is empty: ↑↓ walk its rows (Claude Code's ring, which this module
//                turns into the program's focus event), ↵ opens the row, its letters reach its program from the prompt
//                (dockKey), esc goes back a level, then closes it
//   data         the coverage (`thimble coverage --json`, this session's, read again on open and after each turn) and
//                the labels (`thimble label --json`), held here; what a program wants on demand: a file's lines around
//                a read range, and a page of a label's records (`thimble label NAME --records …`)
//   acts         a label value checked with the number keys is the person's check (labels.ts check), as in the detail;
//                when the viewer closes, Claude hears of the checks with the next prompt (labels.ts checksDone)
//   link         under an open file, or a label's selected record, a link that opens the file at its line, as a
//                citation's file link does (cards.js fileLink)
//
// It reads, as the person: nothing it runs counts as what Claude read (shell.tsx leanEnv), and it makes no model call.
import type { EngineInterface, Register } from 'claude-code'

import type { KeyEdit, KeyTurn } from './keys'
import { keyEvent } from '../panes/host.js'
import { mixCells, rangesOf, typeMix } from '../panes/coverage.js'
import { termColor } from '../draw/palette.js'
import { fileLink } from './cards.js'
import { regionOfKey } from './cells'
import { noteDock, paneColumns } from './detail'
import { check as checkLabel, checksDone, labelGen } from './labels'
import { instance, paneClosed, paneDrawing, paneEl, paneFire, paneState, paneTakes, redraw } from './panes'
import { currentTheme, keysMoved, leanEnv, paneWhere, popFocus, pushFocus } from './shell'
import { sessionKey } from '../hooks/conversation'
import { keyColor } from './view'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
export type Dock = 'coverage' | 'labels'
export const DOCKS: readonly Dock[] = ['coverage', 'labels']
const TITLE: Record<Dock, string> = { coverage: 'Coverage', labels: 'Labels' }
/** The key that opens each from the empty prompt, as the bar names it. */
export const DOCK_KEY: Record<Dock, string> = { coverage: 'r', labels: 'l' }
/** The cells of the small type bar beside the coverage share in thimble's bar. */
export const MIX_CELLS = 8
const WORD_MS = 700
const isDock = (x: unknown): x is Dock => x === 'coverage' || x === 'labels'

// the module's memory: what each pane shows, which are open, where the ring is, the pages of records read
const held = {
  coverage: { cov: null as Any, loading: false, error: null as string | null, gen: 0, since: 0 },
  labels: { list: null as Any[] | null, loading: false, error: null as string | null, gen: 0, since: 0 },
}
/** A read still running after this long (one lost with a reload of the module) no longer holds back the next. */
const READ_MS = 30000
const open = new Set<Dock>()
const ringAt: Record<Dock, string | null> = { coverage: null, labels: null }
const refocus: Record<Dock, boolean> = { coverage: false, labels: false }
const pages = new Map<string, Any>()
const PAGES_KEPT = 40
// the ring's moves, each heard by the program in turn (only the one it still stands on)
let focusChain: Promise<unknown> = Promise.resolve()
// the key that opened a pane a moment ago: a letter typed straight after it began a word
let opened: { key: string; at: number; pane: Dock } | null = null

/** The folder the panes read: the one under analysis, else the session's. */
async function rootOf($: Engine): Promise<string> {
  return ((await paneWhere($)).root ?? String(await $.session.cwd())).replace(/\/+$/, '')
}

async function thimble($: Engine, root: string, args: string[], env?: Record<string, string>): Promise<{ ok: boolean; out: string; err: string }> {
  const dir = $.plugin.root.replace(/\/+$/, '')
  const r = await $.process.run([`${dir}/bin/thimble`, ...args], { cwd: root, env: env ?? (await leanEnv($, root)), timeoutMs: 90000 })
  return { ok: (r.exitCode ?? 1) === 0, out: String(r.stdout || ''), err: String(r.stderr || '') }
}

/** Draw a docked pane again (its program reads the stores anew). */
async function again($: Engine, pane: Dock): Promise<void> {
  await redraw($, instance(pane, {}))
}

// ------------------------------------------------------------------------------------------------ data

/** This session's coverage, read again: the pane shows the last while it reads. */
export async function readCoverage($: Engine): Promise<void> {
  const h = held.coverage
  const now = Number(await $.clock.now())
  if (h.loading && now - h.since < READ_MS) return
  h.loading = true
  h.since = now
  if (open.has('coverage')) await again($, 'coverage')
  try {
    const root = await rootOf($)
    // this session's reads, so the session's own key (as the bar's count reads it)
    const r = await thimble($, root, ['coverage', '--json'], { THIMBLE_ROOT: root, THIMBLE_SESSION: await sessionKey($) })
    try {
      h.cov = JSON.parse(r.out)
      h.error = null
      h.gen++
    } catch {
      h.error = (r.err || r.out).trim().split('\n').slice(-1)[0]?.slice(0, 200) || 'thimble coverage gave nothing'
    }
  } catch (err) {
    h.error = String((err as Error)?.message || err).slice(0, 200)
  } finally {
    h.loading = false
    if (open.has('coverage')) await again($, 'coverage')
  }
}

/** The coverage the bar's count read after a turn (shell.tsx recount): the pane shows it, and the small type bar is
 *  made from it. */
export function noteCoverage(got: Any): { tone: string; read: boolean; n: number }[] {
  if (got && Array.isArray(got.files)) { held.coverage.cov = got; held.coverage.error = null; held.coverage.gen++ }
  return Array.isArray(got?.types) ? mixCells(typeMix(got.types), MIX_CELLS) : []
}

/** The folder's labels, read again. */
export async function readLabels($: Engine): Promise<void> {
  const h = held.labels
  const now = Number(await $.clock.now())
  if (h.loading && now - h.since < READ_MS) return
  h.loading = true
  h.since = now
  if (open.has('labels')) await again($, 'labels')
  try {
    const r = await thimble($, await rootOf($), ['label', '--json'])
    try {
      const v = JSON.parse(r.out)
      h.list = Array.isArray(v) ? v : []
      h.error = null
      h.gen++
    } catch {
      h.error = (r.err || r.out).trim().split('\n').slice(-1)[0]?.replace(/^thimble label: /, '').slice(0, 200) || 'thimble label gave nothing'
    }
  } catch (err) {
    h.error = String((err as Error)?.message || err).slice(0, 200)
  } finally {
    h.loading = false
    if (open.has('labels')) await again($, 'labels')
  }
}

/** How many labels the folder has (their files in thimble/labels), for the bar. */
export async function countLabels($: Engine, root: string | null): Promise<number> {
  if (!root) return 0
  try {
    const xs = await $.fs.list(`${root.replace(/\/+$/, '')}/thimble/labels`)
    return xs.filter(x => x.name.endsWith('.json') && !x.name.startsWith('.')).length
  } catch {
    return 0
  }
}

/** A store a docked pane reads (shell.tsx paneStore). The pane keys its data by the store as JSON, which for the
 *  coverage of a large folder is long: each store says itself as JSON by its generation alone, so a key is cheap and
 *  changes only when what it holds changes. */
export async function dockStore($: Engine, kind: string): Promise<unknown> {
  const said = (h: { gen: number; loading: boolean; error: string | null }, more: Record<string, unknown> = {}) => ({ toJSON: () => ({ gen: h.gen, loading: h.loading, error: h.error, ...more }) })
  // a pane open with nothing in hand (a reload of this module lost it) reads it again
  if (kind === 'coverage' && !held.coverage.cov && !held.coverage.loading && !held.coverage.error) $.clock.after(0, () => { void readCoverage($) })
  if (kind === 'labels' && !held.labels.list && !held.labels.loading && !held.labels.error) $.clock.after(0, () => { void readLabels($) })
  if (kind === 'coverage') return { ...held.coverage, ...said(held.coverage) }
  if (kind === 'labels') { const checks = await labelGen($); return { ...held.labels, checks, ...said(held.labels, { checks }) } }
  return undefined
}

/** What a docked pane's program wants on demand (shell.tsx paneWant): a file's lines, a page of a label's records. */
export async function dockWant($: Engine, request: Any): Promise<unknown> {
  const root = await rootOf($)
  if (typeof request?.lines === 'string') {
    const rel = String(request.lines)
    if (rel.startsWith('/') || rel.split('/').includes('..')) return { error: 'that file is outside the folder' }
    const from = Math.max(1, Math.floor(Number(request.from) || 1))
    const to = Math.max(from, Math.min(from + 400, Math.floor(Number(request.to) || from)))
    const r = await $.process.run(['awk', '-v', `a=${from}`, '-v', `b=${to}`, 'NR>=a{print substr($0,1,400)} NR>=b{exit}', `${root}/${rel}`], { cwd: root, timeoutMs: 20000 })
    if ((r.exitCode ?? 1) !== 0) return { error: String(r.stderr || 'the file could not be read').trim().slice(0, 200) }
    const lines = String(r.stdout || '').replace(/\n$/, '').split('\n')
    return { lines: lines.length === 1 && lines[0] === '' && to > from ? [] : lines }
  }
  if (typeof request?.records === 'string') {
    const key = JSON.stringify([request.records, request.value, request.at, request.n, request.gen])
    const kept = pages.get(key)
    if (kept) return kept
    const args = ['label', String(request.records), '--records', String(request.value ?? '*'), '--at', String(Math.max(0, Number(request.at) || 0)), '--count', String(Math.max(1, Number(request.n) || 20)), '--json']
    const r = await thimble($, root, args)
    let v: Any
    try { v = JSON.parse(r.out) } catch { v = { error: (r.out || r.err).trim().split('\n').slice(-1)[0]?.replace(/^thimble label: /, '').slice(0, 200) || 'thimble label gave nothing' } }
    // (kept by the checks made so far, so a check reads the page again; the newest last, a few dozen at most)
    pages.delete(key)
    pages.set(key, v)
    while (pages.size > PAGES_KEPT) pages.delete(pages.keys().next().value as string)
    return v
  }
  return undefined
}

/** What a docked pane's program asks of the host (shell.tsx paneAction): close it, or check a record's value. */
export async function dockAction($: Engine, pane: Dock, a: Record<string, unknown>): Promise<string | boolean | void> {
  const name = String(a.do || '')
  if (name === 'close') { await closeDock($, pane); return }
  if (name === 'check' && pane === 'labels') {
    const said = await checkLabel($, await rootOf($), a)
    // the counts changed: the list read again, and the pages with them
    $.clock.after(0, () => { void readLabels($) })
    return said || undefined
  }
  return false
}

// ------------------------------------------------------------------------------------------------ open and close

export function dockIsOpen(pane: Dock): boolean {
  return open.has(pane)
}

/** Whether a docked pane is open at all (the key path asks before it reads anything). */
export function dockAnyOpen(): boolean {
  return open.size > 0
}

/** After a reload of this module (Claude Code reloads it when its files change) a pane may still be up: the bar's first
 *  drawing finds it again, so its keys stay its own. */
let synced = false
export async function syncDock($: Engine): Promise<void> {
  if (synced) return
  synced = true
  try {
    // (the ring goes back on the row selected, where the pane left it)
    for (const p of await $.ui.panes()) if (isDock(p.id) && p.isPlaced) { open.add(p.id); refocus[p.id] = true }
  } catch {
    // no panes to find: none open
  }
}

/** Open a docked pane, docked, with the keys; its data read again. */
export async function openDock($: Engine, pane: Dock): Promise<void> {
  open.add(pane)
  await pushFocus($, pane)
  refocus[pane] = true
  if (pane === 'coverage') $.clock.after(0, () => { void readCoverage($) })
  else $.clock.after(0, () => { void readLabels($) })
  const r = await $.ui.open({ id: pane, title: TITLE[pane], focus: true, closeOnEscape: true, columns: paneColumns() })
  if (r && (r as Any).isPlaced === false) {
    await closeDock($, pane)
    $.ui.toast(`${TITLE[pane]} needs a wider terminal when a key opens it (${String((r as Any).reason || 'it was not placed')}). Widen the terminal, or click ${pane === 'coverage' ? 'coverage' : 'labels'} in thimble's bar.`)
  }
}

export async function closeDock($: Engine, pane: Dock): Promise<void> {
  const was = open.has(pane)
  await closed($, pane)
  if (was) await $.ui.close({ id: pane }).catch(() => undefined)
}

async function closed($: Engine, pane: Dock): Promise<void> {
  open.delete(pane)
  ringAt[pane] = null
  paneClosed(pane, {})
  await popFocus($, pane)
  // the labels the person checked are counted again, their cards drawn again, and Claude hears of the checks
  if (pane === 'labels') $.clock.after(0, () => { void checksDone($).catch(() => undefined) })
}

/** A press on the bar's count, or its key: open the pane, or close it when it is open. */
export async function toggleDock($: Engine, pane: Dock): Promise<void> {
  if (open.has(pane)) await closeDock($, pane)
  else await openDock($, pane)
}

/** The pane takes the keys again (after a refused close, a key that acted): the ring back on the selected row. */
function regrab($: Engine, pane: Dock): void {
  refocus[pane] = true
  $.clock.after(0, () => {
    void (async () => {
      if (!open.has(pane)) return
      await $.ui.open({ id: pane, focus: true, closeOnEscape: true, columns: paneColumns() }).catch(() => undefined)
      $.ui.invalidate('ui.render')
    })()
  })
}

// ------------------------------------------------------------------------------------------------ keys

/** A key from the empty prompt at rest: r opens Coverage, l the labels, when the bar names them (`counts`). The key
 *  may begin a word: a letter typed at once after it gives both letters back and closes the pane again. */
export function restKey($: Engine, k: string, e: KeyEdit, now: number, named: { cov: boolean; labels: boolean }): KeyTurn | null {
  const pane = k === DOCK_KEY.coverage && named.cov ? 'coverage' : k === DOCK_KEY.labels && named.labels ? 'labels' : null
  if (!pane) return null
  const was = open.has(pane)
  return {
    box: { text: e.text, cursor: e.cursor },
    work: async () => { await toggleDock($, pane); opened = was ? null : { key: k, at: now, pane } },
    word: async () => { opened = null; if (!was) await closeDock($, pane) },
  }
}

/** A key while a docked pane is on top of the focus stack (shell.tsx keyTurn asks it first): its program's keys. A letter
 *  that is none of them types; one typed straight after the key that opened the pane begins a word, so the pane closes
 *  and both letters stay in the prompt. Null: not the pane pane's. */
export async function dockKey($: Engine, top: unknown, e: KeyEdit, now: number): Promise<KeyTurn | null> {
  if (!isDock(top) || !open.has(top) || !e.key || e.key.ctrl || e.key.meta || e.text !== '') return null
  const k = e.key.key
  const ev = keyEvent(k === 'enter' ? 'return' : k)
  const was = opened
  if (was && was.pane === top && now - was.at < WORD_MS && /^\p{L}$/u.test(k)) {
    opened = null
    return { box: { text: `${was.key}${e.inputText}`, cursor: was.key.length + e.inputText.length }, work: () => closeDock($, top) }
  }
  if (!(await paneTakes($, top, {}, ev))) return null
  return { box: { text: e.text, cursor: e.cursor }, work: async () => { opened = null; await paneFire($, top, {}, ev); regrab($, top) } }
}

/** The keys a docked pane names in the bar while it has the focus, from its program (shell.tsx focusWords). */
export function dockOpen(pane: unknown): pane is Dock {
  return isDock(pane) && open.has(pane)
}

// ------------------------------------------------------------------------------------------------ the bar's counts

type Count = { id: string; text: string; bright: boolean }
type Counts = { cov: number; labels?: number; mix?: { tone: string; read: boolean; n: number }[] }

/** The bar's counts of the pane panes, as fitBar measures them: `r coverage 34% ▆▆▆▆▆▆▆▆` and `l 2 labels`. */
export function dockCounts(c: Counts, percent: (x: number) => string): [string, number, string][] {
  const mix = (c.mix || []).reduce((s, x) => s + x.n, 0)
  return [
    ['cov', c.cov, `${DOCK_KEY.coverage} coverage ${percent(c.cov)}${mix ? ` ${'█'.repeat(mix)}` : ''}`],
    ['labels', c.labels ?? 0, `${DOCK_KEY.labels} ${c.labels === 1 ? '1 label' : `${(c.labels ?? 0).toLocaleString('en-US')} labels`}`],
  ]
}

/** One pane count drawn: its key in the key's color, its words, the coverage's small type bar in the types' colors
 *  (read bright, the rest pale), the whole a press that opens its pane. */
export function dockCountEl($: Engine, els: Any, x: Count, c: Counts, press: boolean): Any {
  const { Button, Text } = els
  const theme = currentTheme()
  const pane: Dock = x.id === 'cov' ? 'coverage' : 'labels'
  const key = DOCK_KEY[pane]
  const words = x.text.slice(key.length + 1).replace(/ █+$/, '')
  const kids: Any[] = [
    Text({ key: `ck-${x.id}`, color: keyColor(key, theme), ...(x.bright ? { bold: true } : {}), children: key }),
    Text({ key: `cw-${x.id}`, ...(x.bright ? { bold: true } : { dimColor: true }), children: ` ${words}` }),
  ]
  if (pane === 'coverage' && c.mix?.length) {
    kids.push(Text({ key: 'cm-gap', children: ' ' }))
    c.mix.forEach((m, i) => kids.push(Text({ key: `cm-${i}`, color: termColor(m.read ? m.tone : `${m.tone}-faint`, theme) ?? 'inactive', children: '█'.repeat(m.n) })))
  }
  if (!press) return Text({ key: `count-${x.id}`, children: kids })
  return Button({ key: `count-${x.id}`, plain: true, label: pane === 'coverage' ? 'open Coverage: what Claude read' : 'open the labels', onPress: () => toggleDock($, pane), children: kids })
}

// ------------------------------------------------------------------------------------------------ drawing

/** The link under the pane: the open file at the read range selected (Coverage), the selected record's place (the
 *  label viewer). Null when nothing is open. */
async function linkOf($: Engine, pane: Dock): Promise<{ href: string; label: string } | null> {
  const st = await paneState($, pane, {})
  const root = await rootOf($)
  if (pane === 'coverage') {
    const f = typeof st.file === 'string' ? (held.coverage.cov?.files || []).find((x: Any) => x.path === st.file) : null
    if (!f) return null
    const rs = rangesOf(f)
    const m = /^rg-(\d+)$/.exec(String(st.at || ''))
    const r = rs[m ? Number(m[1]) : 0] ?? rs[0]
    return fileLink(r ? `${f.path}#L${r.from}` : f.path, root)
  }
  if (typeof st.open !== 'string') return null
  const rec = Number(st.rec) || 0
  for (const v of [...pages.values()].reverse()) {
    const hit = v?.label?.name === st.open && (v.value ?? null) === (st.filter ?? null) ? (v.records || []).find((x: Any) => x.i === rec) : null
    if (hit) return fileLink(hit.ref, root)
  }
  return null
}

/** A pane pane drawn: its program in the room the dock gives, the link under it, and the ring on the selected row
 *  after a key moved it. */
export async function dockPane($: Engine, e: Any, pane: Dock): Promise<Any> {
  noteDock(e)
  const els = $.ui.resolve(e) as Any
  const { Box, Markdown, Text } = els
  const C = Math.max(40, (e.props.bodyColumns ?? 100) - 1)
  const R = Math.max(8, e.props.scroll?.bodyRows ?? 40)
  const link = await linkOf($, pane)
  // the link's rows: a terminal that takes no hyperlinks shows its address after its words, which may wrap
  const linkRows = link ? 1 + Math.ceil((Array.from(link.label).length + link.href.length + 6) / C) : 0
  const body = await paneEl($, e, pane, {}, { w: C, h: Math.max(6, R - linkRows) }, { painted: true, stable: true, focus: true })
  const kids: Any[] = [body]
  if (link && Markdown) kids.push(Text({ key: 'pane-gap', children: ' ' }), Markdown({ key: 'pane-link', text: `↗ [${link.label.replace(/[[\]\\]/g, ch => '\\' + ch)}](${link.href})` }))
  // after a key moved the selection (or the pane opened), the ring goes to the selected row
  const sel = await selectedKey($, pane)
  const order = ((paneDrawing(pane, {})?.regions || []) as Any[]).map(g => String(g?.id))
  const ring = ringAt[pane] ? regionOfKey(ringAt[pane]!) : null
  if (ring && e.props.isFocused) {
    const before = lastOrder[pane].indexOf(ring)
    const now = order.indexOf(ring)
    if (before >= 0 && now >= 0 && before !== now) refocus[pane] = true
  }
  lastOrder[pane] = order
  const selId = paneDrawing(pane, {})?.selected ?? null
  if (e.props.isFocused && selId && selId !== lastSel[pane] && selId !== ring) refocus[pane] = true
  lastSel[pane] = selId
  if (refocus[pane] && e.props.isFocused && sel) {
    refocus[pane] = false
    $.clock.after(0, () => { void $.ui.focus({ requestId: pane, key: sel }).catch(() => undefined) })
  }
  return Box({ flexDirection: 'column', width: C, children: kids })
}

/** A row of a list: its kind (g, f, rg, lb, rec, val) and its number. */
const ROW = /^(g|f|rg|lb|rec|val)-(\d+)$/

/** The element a move of the ring by the person goes to: from a row of a list to another row of the same list, the
 *  row one step from the one selected, toward where the ring went; any other move as the person made it (null). */
async function stepOf($: Engine, pane: Dock, element: string): Promise<string | null> {
  const to = ROW.exec(regionOfKey(element) ?? '')
  const st = await paneState($, pane, {})
  const sel = paneDrawing(pane, {})?.selected
  const from = ROW.exec(typeof sel === 'string' ? sel : String(st.at ?? ''))
  if (!to || !from || to[1] !== from[1] || to[2] === from[2]) return null
  const n = Number(from[2]) + (Number(to[2]) > Number(from[2]) ? 1 : -1)
  const id = `${from[1]}-${n}`
  return (paneDrawing(pane, {})?.regions || []).some((g: Any) => g?.id === id) ? `r|p-${pane}|~|${id}` : null
}

/** The order of the regions each pane drew last: a drawing that moved the ring's row (a list scrolled) puts the ring
 *  back on it, so Claude Code's next move starts from where it is drawn now. */
const lastOrder: Record<Dock, string[]> = { coverage: [], labels: [] }
/** The row each pane selected in its last drawing: a selection that changed by anything but the ring (a press that
 *  opened a group, a key, esc going back) puts the ring on the row selected now, so ↵ acts on the row the pane shows. */
const lastSel: Record<Dock, string | null> = { coverage: null, labels: null }

/** The key of the selected row's Button, as cells.ts draws it with stable keys. */
async function selectedKey(_$: Engine, pane: Dock): Promise<string | null> {
  const d = paneDrawing(pane, {})
  return typeof d?.selected === 'string' ? `r|p-${pane}|~|${d.selected}` : null
}

export const registerDock: Register = on => {
  for (const pane of DOCKS) {
    on('ui.render', { component: 'Pane', requestId: pane }, async ($, e) => {
      try {
        return await dockPane($, e, pane)
      } catch (err) {
        const { Text } = $.ui.resolve(e) as Any
        return Text({ color: 'error', wrap: 'wrap', children: `× ${TITLE[pane]} could not be drawn: ${String((err as Error)?.message || err).slice(0, 200)}. Press esc and open it again.` })
      }
    })
    // esc goes back a level (a file to its group, a label to the list), then closes the pane
    on('ui.close', { id: pane }, async ($, e, next) => {
      const person = (e.origin as { kind?: string }).kind === 'person'
      try {
        if (person) keysMoved(await $.clock.now())
        const st = await paneState($, pane, {})
        const deep = pane === 'coverage' ? !!(st.group != null || st.file) : typeof st.open === 'string'
        if (person && open.has(pane) && deep) {
          await paneFire($, pane, {}, { type: 'key', key: 'esc' })
          regrab($, pane)
          return { value: undefined } as Any
        }
        await closed($, pane)
      } catch {
        // the pane closes whatever the module makes of it
      }
      return next(e)
    })
    // the ring moved by the person (↑↓, Tab, a click) selects the row it lands on
    // (the ring moves at once, and the program hears of it after, so arrows pressed fast all move it). Claude Code keeps
    // the ring by its place among the pane's rows, so after a list scrolled its next move may land rows away: a move from
    // a row of a list to another row of it is one step, up or down, from the row selected, as the detail reads its ring
    on('ui.focus', { requestId: pane }, async ($, e, next) => {
      const step = (e.origin as { kind?: string }).kind === 'person' && typeof e.element === 'string' ? await stepOf($, pane, e.element) : null
      const r = await next(step ? { ...e, element: step } : e)
      try {
        const element = step ?? e.element
        if (!r.deny && typeof element === 'string') {
          ringAt[pane] = element
          const region = regionOfKey(element)
          if ((e.origin as { kind?: string }).kind === 'person' && region) {
            focusChain = focusChain.then(() => (ringAt[pane] === element ? paneFire($, pane, {}, { type: 'focus', region }) : undefined)).catch(() => undefined)
          }
        }
      } catch {
        // the ring moves whatever the pane makes of it
      }
      return r
    }).catch(($, e, next) => next(e))
  }
}

/** For tests: the module's memory, cleared. */
export function resetDock(): void {
  held.coverage = { cov: null, loading: false, error: null, gen: 0, since: 0 }
  held.labels = { list: null, loading: false, error: null, gen: 0, since: 0 }
  open.clear()
  pages.clear()
  ringAt.coverage = ringAt.labels = null
  refocus.coverage = refocus.labels = false
  lastOrder.coverage = []
  lastOrder.labels = []
  lastSel.coverage = lastSel.labels = null
  opened = null
  synced = false
}
