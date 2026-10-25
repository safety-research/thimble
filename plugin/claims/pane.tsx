// pane.tsx: the Claims pane (core/pane.ts kind `claims`), drawn with Claude Code's own elements from what graph.js lays
// out: at rest the head (how many claims) and the line that finds the claims of the answers not read yet (f, a press
// the observer's ui.press hook takes: claims are found on demand unless Extract claims is auto), the overview of clusters
// on top (the map, or one row per cluster when the map would be too crowded), and with a cluster chosen its claims one
// line each under it; a claim picked takes the whole pane: its cluster, the claim, its description and its citations as
// the tray's cards. The keys at the bottom. A click is the main way to move: a cluster's name chooses the cluster, a dot
// or a claim of the list picks that claim (its dot again, nothing); a citation's card opens as a press on it in the
// reply does (the tray; else its evidence pane), and a citation's line makes it the current one. Tab and Enter reach
// the same Buttons. A detail taller than its room scrolls with the wheel (core/pane.ts scrollsOwn; ↑ ↓ press k j) and
// d u, which show in the keys only then; `↑ N more lines` and `↓ N more lines` (`N more claims` in a cluster's list)
// each a press that scrolls a page.
//
//   keys while the pane holds the keyboard, each once:
//     at rest            n the first cluster, in reading order of the map as drawn (row by row, left to right)
//     a cluster chosen   k j the previous or next claim of its list (the ends hold) · e opens it · p n the previous or
//                        next cluster
//     any, overflowing   d u the detail a page down or up
//     a claim picked     k j the previous or next claim of its cluster (its evidence shown: citation) · e its
//                        evidence shown or hidden (the line in the detail that says so) · h its History (a corrected
//                        claim) · c the current citation's code and output whole · x repair the current citation
//                        (the evidence hidden: its first failed one) when it failed (a check of it again in the background, marks/checker.ts
//                        launchRepair, started in this feature's ui.press hook, seam.ts; while that check runs, x says so),
//                        or x check the current citation when it was not checked yet (auto cite, manual: checkOpened)
//   A focused pane hands a plugin only its Buttons' hotkeys, one letter or digit each, and Claude Code types any other
//   letter into the prompt, the keyboard going with it; so a key shows while its press can still be expected (x after
//   a repair began). f at rest finds the claims of the answers not read. The input under the pane asks about what is
//   chosen (threads/pane.tsx). A claim or a card that takes several rows is one press over all of them (rowEls), so it
//   highlights whole.
//
// A claim's citations are the reply's marks near its words (store.js sources): their check and evidence come from
// marks/store.ts as they stand now, so a check that ends after the look shows in the detail.
import type { EngineInterface } from 'claude-code'

import { messageOf } from '../core/answers'
import { markPressed } from '../core/answerview'
import { quiet } from '../core/askcell.js'
import { tellOpened } from '../core/engaged'
import { failNotice } from '../bar/notice'
import { openPane, paneNow, scrollsOwn } from '../core/pane'
import { textWidth } from '../core/text.js'
import { treeRows } from '../core/trail.mjs'
import { accent, themeLast, themeNow } from '../core/theme'
import { checkOpened, launchRepair, repairOf } from '../marks/checker'
import { citeWords } from '../marks/evidence'
import { citeHeat, wordsLook, type MarkStatus } from '../marks/view'
import { plainSentence } from '../marks/message.js'
import { NOT_RUN, rowMarks, type MarkItem } from '../marks/store'
import { markColors } from '../explain/place.mjs'
import { checkable, evidenceOf, graphView, groupOf, hopCluster, paneData, repairable, selectedOf, sourceView, threadAbout } from './graph.js'
import { claimsBright, claimsStore, claimsToFind, placeText, showClaims, type ClaimsArgs } from './term'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Run = { s: string; tone?: string | null; bold?: boolean; underline?: boolean; inverse?: boolean; tint?: boolean; cite?: string; bg?: string; part?: string | null }

/** The clusters' colors (0.10's c1..c6) and what each other tone draws as: theme colors, so light and dark both read;
 *  a faint tone is its color dimmed; `code` the code's color of the citations' card; `plain` the theme's text color
 *  (the map's other clusters while one is chosen: dim gray dots and names read too faint on a light background). */
const CLUSTER = ['#3cc2b9', '#a98be0', '#cfae7e', '#8fa1bd', '#e384b2', '#b2c24f']
/** The same hues for a light background, darker, so a dot and a name read on white (contrast 4.8 or more; the dark set
 *  is near 2 there). */
const CLUSTER_LIGHT = ['#0f7f78', '#7650c4', '#87662a', '#4f6386', '#b03a74', '#677510']
/** A line of code's color: the theme key thimble draws inline code in (tray/tray.ts), shaded by Claude Code. */
const CODE_INK = 'permission'
const THEME: Record<string, string> = { plain: 'text', good: 'success', bad: 'error', warn: 'warning', cite: 'merged' }

function look(tone: string | null | undefined): Record<string, unknown> {
  if (!tone) return {}
  const faint = tone.endsWith('-faint')
  const t = faint ? tone.slice(0, -6) : tone
  if (t === 'del') return { color: THEME.bad, strikethrough: true }
  if (t === 'ins') return { color: THEME.good }
  const c = /^c(\d)$/.exec(t)
  const color = c ? (themeLast() === 'light' ? CLUSTER_LIGHT : CLUSTER)[(Number(c[1]) - 1) % 6] : t === 'code' ? CODE_INK : t === 'accent' ? accent() : THEME[t]
  return { ...(color ? { color } : {}), ...(faint || t === 'dim' ? { dimColor: true } : {}) }
}

/** A run as a Text: its tone, bold, underline and inverse (the claim picked, on the map); cited words in evidence look as in the citations' card (citeWords,
 *  in hover group `id`); a citation (`cite`, its status) as citations look in the reply (wordsLook). */
function spanOf(els: Any, r: Run, i: number, id: string): unknown {
  // `gloss`: an explainer's term, in the explainers' fill as the reply draws it
  const bg = r.bg === 'gloss' ? { backgroundColor: markColors(themeLast()).glossBg } : {}
  return els.Text({
    key: `t${i}`, ...look(r.tone), ...bg, ...(r.bold ? { bold: true } : {}), ...(r.underline ? { underline: true } : {}), ...(r.inverse ? { inverse: true } : {}),
    ...(r.tint ? citeWords(id) : {}), ...(r.cite ? wordsLook(r.cite as MarkStatus, id) : {}), children: r.s,
  })
}

/** One row of runs: plain Text, with one Button for each stretch of runs that share a part (a press on it). Each
 *  Button's key is the row's key and its part, so no two in the pane share one: a dot is `<row>:n:<id>`. Cited words
 *  are underlined, and the cited words in evidence look as in the citations' card (citeWords: tinted on hover). */
function rowEl(els: Any, runs: Run[], key: string, press: (part: string) => unknown): unknown {
  const { Box, Button, Text } = els
  // the row's cited words are one hover group: a Text that holds them nested joins it, so the pointer over it lights them
  const id = `claims:${key}`
  const heat = (rs: Run[]) => (rs.some(r => r.tint || r.cite) ? citeHeat(id) : {})
  const span = (r: Run, i: number) => spanOf(els, r, i, id)
  if (!runs.length) return Text({ key, children: ' ' })
  if (!runs.some(r => r.part)) return Text({ key, wrap: 'truncate-end', ...heat(runs), children: runs.map(span) })
  const kids: unknown[] = []
  for (let i = 0; i < runs.length;) {
    const part = runs[i]!.part
    if (!part) { kids.push(span(runs[i]!, i)); i++; continue }
    let j = i
    while (j < runs.length && runs[j]!.part === part) j++
    kids.push(Button({ key: `${key}:${part}`, plain: true, ...heat(runs.slice(i, j)), onPress: () => press(part), children: runs.slice(i, j).map((r, k) => span(r, i + k)) }))
    i = j
  }
  return Box({ key, flexDirection: 'row', children: kids })
}

/** The one part a whole row is a press on, or null (a row of several parts, or of words that press nothing). */
function partOfRow(runs: Run[]): string | null {
  const p = runs[0]?.part
  return p && runs.every(r => r.part === p) ? p : null
}

/** Rows as elements (`<prefix><index>` each): the rows in a run that are each a press on one same part (a claim, or a
 *  cluster's name, that wraps) are one Button over all their lines, so the pointer's highlight and a press take the
 *  whole claim, not one of its lines. A row `special` draws (an element) is its; any other row is rowEl's. */
function rowEls(els: Any, rows: Run[][], prefix: string, press: (part: string) => unknown, special: (r: Run[], key: string) => unknown = () => null): unknown[] {
  const { Button, Text } = els
  const out: unknown[] = []
  for (let i = 0; i < rows.length;) {
    const own = special(rows[i]!, `${prefix}${i}`)
    if (own) { out.push(own); i++; continue }
    const part = partOfRow(rows[i]!)
    let j = i + 1
    if (part) while (j < rows.length && partOfRow(rows[j]!) === part) j++
    if (!part || j - i < 2) { out.push(rowEl(els, rows[i]!, `${prefix}${i}`, press)); i++; continue }
    // a Button holds strings and Text only: its lines are one Text, a line break between them (each fits the pane)
    const id = `claims:${prefix}${i}`
    const runs = rows.slice(i, j)
    const lines = runs.flatMap((r, k) => [...(k ? ['\n'] : []), Text({ key: `l${k}`, children: r.map((x, n) => spanOf(els, x, n, id)) })])
    out.push(Button({ key: `${prefix}${i}:${part}`, plain: true, ...(runs.flat().some(r => r.tint) ? citeHeat(id) : {}), onPress: () => press(part), children: [Text({ key: 'ls', wrap: 'wrap', children: lines })] }))
    i = j
  }
  return out
}

/** Where `path:line` a mark's evidence shows, and its first highlighted line. */
function placeOf(m: MarkItem): { place?: string; line?: string } {
  const ev = m.evidence
  if (!ev) return {}
  if (ev.kind === 'computed') return { place: 'computed', line: ev.output.split('\n')[0] }
  if (ev.kind === 'card') return { place: `card ${ev.title || ev.card}`, line: ev.value }
  const hit = ev.lines.find(l => l.highlight) ?? ev.lines[0]
  return { place: `${ev.file}:${ev.line}`, ...(hit ? { line: hit.text } : {}) }
}

/** The claims' sources with their marks as they stand now: status, words shown, place, the mark's number, what it was
 *  and why (the check's reason), and its evidence. */
async function withMarks($: Engine, data: Any): Promise<Any> {
  const rows = new Map<string, Awaited<ReturnType<typeof rowMarks>>>()
  for (const c of data.claims) {
    c.sources = await Promise.all((c.sources || []).map(async (s: Any) => {
      if (!s.row) return s
      if (!rows.has(s.row)) rows.set(s.row, await rowMarks($, s.row).catch(() => null))
      const r = rows.get(s.row)
      // a reply with no check in the store: its check did not run (marks/store.ts notRun)
      if (!r) return { ...s, status: 'failed', failedBy: 'none', reason: NOT_RUN }
      const m = r.items.find(x => x.start === s.at) ?? r.items.find(x => x.words.replace(/\*\*|`/g, '') === s.label)
      if (!m) return { ...s, status: 'gone' }
      return {
        ...s, n: m.n, status: m.status, failedBy: m.failedBy, shown: m.shown.replace(/\*\*|`/g, ''), ...placeOf(m),
        ...(m.was ? { was: m.was.replace(/\*\*|`/g, '') } : {}), ...(m.narrowed ? { narrowed: true } : {}), ...(m.rewrite ? { was: plainSentence(m.sentence), now: plainSentence(m.rewrite), rewritten: true } : {}), ...(m.reason ? { reason: m.reason } : {}), ...(m.evidence ? { evidence: m.evidence } : {}),
        ...(m.repair ? { repair: true } : {}),
      }
    }))
  }
  return data
}

/** What the side thread under the claims pane is about (threads/pane.tsx): the claim selected, the cluster selected, or
 *  where a claim was said. The arguments keep only what names the thing. `ask` is what the input bar's placeholder
 *  says it asks about, and `quote` the claim a side answer answers, which the thread shows above each question. */
export async function claimsThreadScope($: Engine, args: unknown): Promise<{ about: string; args: ClaimsArgs; ask: string; quote?: string }> {
  const a = (args && typeof args === 'object' ? args : {}) as ClaimsArgs
  const data = paneData(await claimsStore($))
  if (a.source) {
    const c = data.claims.find((x: Any) => x.id === a.source) ?? null
    return { about: threadAbout(c, true), args: { source: a.source, ...(a.row ? { row: a.row } : {}) }, ask: 'Ask about where this claim was said…', ...(c ? { quote: String(c.text) } : {}) }
  }
  const c = a.claim ? data.claims.find((x: Any) => x.id === a.claim) ?? null : null
  // the claim stands right above the input: the words name it, and the question goes to it
  if (c) return { about: threadAbout(c), args: { claim: c.id }, ask: 'Ask about this claim…', quote: String(c.text) }
  if (a.group != null && data.groups.some((g: Any) => (g.id == null ? '-' : String(g.id)) === String(a.group))) {
    const { name, cs } = groupOf(data, a.group)
    return { about: threadAbout(null, false, { name, n: cs.length }), args: { group: String(a.group) }, ask: `Ask about the whole cluster “${String(name)}”…` }
  }
  return { about: threadAbout(null), args: {}, ask: 'Ask about all the claims…' }
}

type Key = { k: string; label: string; onPress: () => unknown; id?: string }

/** The keys' rows, ` · ` between them: each a plain Button the key presses (its address `key-<k>`, or its own `id`).
 *  Claude Code draws its key itself (lit, then a colon), so its words are only the label's, dim as the bar's: words
 *  that held the key too drew it twice. The keys are cut into rows of `W` cells here, each key as wide as it is drawn
 *  with its `k: `: Claude Code lays a Button out without that colon, so a row it wrapped itself lost its last key. */
function keysRow(els: Any, keys: Key[], W = Infinity): unknown {
  const { Box, Button, Text } = els
  const lines: Key[][] = [[]]
  let used = 0
  for (const x of keys) {
    const w = textWidth(`${x.k}: ${x.label}${ARROW[x.k] ?? ''}`)
    if (used && used + 3 + w > W) { lines.push([]); used = 0 }
    used += (used ? 3 : 0) + w
    lines[lines.length - 1]!.push(x)
  }
  const row = (line: Key[], r: number) => Box({ key: `keys-${r}`, flexDirection: 'row', children: line.flatMap((x, i) => [
    ...(i ? [Text({ key: `key-sep-${i}`, dimColor: true, children: ' · ' })] : []),
    Button({ key: x.id ?? `key-${x.k}`, plain: true, hotkey: x.k, label: x.label, hover: quiet(`claims-${x.id ?? `key-${x.k}`}`), onPress: x.onPress, children: [Text({ key: 'w', dimColor: true, children: `${x.label}${ARROW[x.k] ?? ''}` })] }),
  ]) })
  return Box({ key: 'keys', flexDirection: 'column', children: lines.map(row) })
}

/** ↑ and ↓ press k and j in a pane that holds the keyboard (core/pane.ts): the row says so beside them. */
const ARROW: Record<string, string> = { k: ' ↑', j: ' ↓' }

/** The address of x's Button in the keys' row: this feature's ui.press hook (seam.ts) starts the repair, so the
 *  repair's fork starts inside a hook (core/forks.ts). */
export const CLAIMS_REPAIR = 'claims-repair'

/** x in the Claims pane, or a click on `repair`: a check again, in the background, of the failed citation the pane
 *  shows (marks/checker.ts). Call it inside a hook: the spawn is launchRepair's first call. Answers whether the press
 *  was a repair's (a repair started, or a notice says why none did). */
export async function repairShown($: Engine): Promise<boolean> {
  const now = await paneNow($)
  if (now?.kind !== 'claims') return false
  const a = (now.args && typeof now.args === 'object' ? now.args : {}) as ClaimsArgs
  if (a.source) return false
  const data = await withMarks($, paneData(await claimsStore($)))
  const claim = selectedOf(data, a).claim as Any
  if (!claim) return false
  const cites = evidenceOf(claim) as Any[]
  // the evidence shown: the citation it shows; hidden: the claim's first failed citation (the failed ones come first)
  const at = a.open ? Math.max(0, Math.min(cites.length - 1, Number(a.cite) || 0)) : cites.findIndex(repairable)
  const s = cites[at]
  // a citation not checked yet (auto cite, manual): x checks it, as opening it in the reply does
  if (a.open && checkable(s)) { await checkOpened($, s.row, s.n); return true }
  if (!repairable(s)) return false
  const r = await repairOf($, s.row, s.n)
  if (r === null) return false
  // no word window in a pane that holds the keyboard: x is a key of the pane's, never a letter of the prompt
  const why = typeof r === 'string' ? r : await launchRepair($, r, { until: 0, cancelled: false })
  if (why) failNotice($, why, 'claims:repair')
  // with the evidence hidden, it shows on that citation, so the person sees it checked again
  else if (!a.open) await showClaims($, { claim: claim.id, ...(a.at != null ? { at: a.at } : {}), open: true, cite: at })
  return true
}

/** The detail's scroll (graph.js scrollWindow): which claim or cluster it is of, its first row shown, the current
 *  claim or citation it last brought into view, how far it can go, and the rows it has. */
let detail: { where: string; top: number; mark: number | null; max: number; room: number } = { where: '', top: 0, mark: null, max: 0, room: 0 }

/** The detail scrolled by `by` rows (negative toward its top), clamped; drawn again when it moved. Answers whether it
 *  moved. */
function scrollDetail($: Engine, by: number): boolean {
  const top = Math.max(0, Math.min(detail.max, detail.top + by))
  if (top === detail.top) return false
  detail = { ...detail, top }
  $.ui.invalidate('ui.render')
  return true
}

export async function drawClaims($: Engine, e: Any, args: unknown, els: Any): Promise<unknown> {
  const a = (args && typeof args === 'object' ? args : {}) as ClaimsArgs
  const W = Math.max(24, Number(e?.props?.bodyColumns) || 90)
  const H = Math.max(14, Number(e?.props?.scroll?.bodyRows) || 36)
  const { Box } = els
  // the cited words' tint and the clusters' colors are the theme set's (marks/view.ts citeLook, look)
  await themeNow($)
  const raw = await withMarks($, paneData(await claimsStore($)))
  const keys: Key[] = []
  const key = (k: string, label: string, onPress: () => unknown, id?: string) => keys.push({ k, label, onPress, ...(id ? { id } : {}) })
  const keep = {
    claim: a.claim ?? null, group: a.group ?? null, at: a.at ?? null, ...(a.cur != null ? { cur: a.cur } : {}), ...(a.cite != null ? { cite: a.cite } : {}),
    ...(a.open ? { open: true } : {}), ...(a.history ? { history: true } : {}), ...(a.whole ? { whole: true } : {}),
  }

  // ---- where a claim was said
  if (a.source) {
    const c = raw.claims.find((x: Any) => x.id === a.source) ?? null
    const text = a.row ? await placeText($, a.row) : null
    const lines = sourceView(c, text, W) as Run[][]
    key('b', 'back', () => showClaims($, keep))
    return Box({ flexDirection: 'column', children: [
      ...lines.map((r, i) => rowEl(els, r, `s${i}`, () => undefined)),
      rowEl(els, [], 'gap', () => undefined),
      keysRow(els, keys),
    ] })
  }

  // ---- the map and the detail
  // the claim picked: the reply it came from, whose sentences say why it holds when the lens gave no reason
  const sel = selectedOf(raw, keep).claim as Any
  const said = sel ? ((sel.said || []) as Any[]).find(x => x.row && x.by === 'claude') ?? (sel.said || []).find((x: Any) => x.row) ?? null : null
  const md = said ? await placeText($, said.row, said) : null
  const passage = md ? { md, place: said } : null
  // the detail's scroll: kept while the pane shows the same claim or cluster; the current claim or citation is brought
  // into view when it changed (k j, e showing the evidence), and on the first drawing
  const where = keep.claim ? `c:${keep.claim}` : keep.group != null ? `g:${keep.group}` : ''
  if (detail.where !== where) detail = { where, top: 0, mark: null, max: 0, room: 0 }
  const mark = keep.claim ? `${keep.open ? 'open' : 'shut'}:${Number(keep.cite) || 0}` : String(Number(keep.cur) || 0)
  const st = { ...keep, top: detail.top, follow: detail.mark !== mark }
  const opts = { w: W, h: H, bright: await claimsBright($), passage }
  const view = graphView(raw, st, opts)
  // the claims and clusters as the map draws them (graph.js fitClusters)
  const data = view.data as Any
  const claim = view.claim as Any
  const group = view.group as string | null
  const pick = (id: string | null) => (id ? showClaims($, { claim: id, at: data.last }) : undefined)
  // a cluster chosen: the claim picked, when it is one of the cluster's, is its list's current claim
  const pickGroup = (k: string | null) => {
    if (k == null) return undefined
    const j = claim ? (groupOf(data, k).cs as Any[]).findIndex(c => c.id === claim.id) : -1
    return showClaims($, { group: k, ...(j > 0 ? { cur: j } : {}), at: data.last })
  }
  const cites = claim ? (evidenceOf(claim) as Any[]) : []
  const openEvidence = async (s: Any) => {
    if (!s?.row || !s.n) return
    await openPane($, 'evidence', { row: s.row, n: s.n }, `citation ${s.n}`, { focus: true })
    const m = await messageOf($, s.row)
    await tellOpened($, { kind: 'citation', row: s.row, n: s.n, words: s.label, status: s.status, failedBy: s.failedBy }, m?.text ?? '')
  }
  // a citation in why a claim holds: as a press on it in the reply, the tray opens on it (else its evidence pane); the
  // pane keeps the keyboard, so k j e still move in it
  const openCite = async (s: Any) => {
    if (!s?.row || !s.n) return
    if (!(await markPressed($, s.row, s.n))) return openEvidence(s)
    await showClaims($, a)
  }
  const at = claim ? { claim: claim.id, at: data.last } : null
  const cite = Math.max(0, Math.min(view.cites - 1, Number(a.cite) || 0))
  // the claim picked with another citation current, or its History or a citation's code shown or not
  const onClaim = (o: Partial<ClaimsArgs>) => (at ? showClaims($, { ...at, cite, ...(a.open ? { open: true } : {}), ...(a.history ? { history: true } : {}), ...(a.whole ? { whole: true } : {}), ...o }) : undefined)
  // e, or a press on its line: the claim's evidence shown, or hidden again (back to the claim: core/trail.mjs)
  const toggleEvidence = () => (at ? (a.open ? showClaims($, { ...at, ...(a.history ? { history: true } : {}) }) : onClaim({ open: true, cite: 0, whole: false })) : undefined)
  // the cluster chosen with claim i of its list current
  const toCur = (i: number) => (group != null ? showClaims($, { group, cur: i, at: data.last }) : undefined)
  const press = (part: string) => {
    const sc = /^sc:(-?1)$/.exec(part)
    if (sc) return scrollDetail($, Number(sc[1]) * Math.max(1, detail.room - 2))
    if (part.startsWith('g:')) return pickGroup(part.slice(2))
    // a dot or a claim of the list: that claim, which a question in the input under the pane is then about; the claim
    // picked again stays picked (its cluster's name chooses the cluster)
    if (part.startsWith('d:')) {
      const c = data.claims.find((x: Any) => x.id === part.slice(2))
      return c && claim?.id !== c.id ? pick(c.id) : undefined
    }
    if (part.startsWith('n:')) return pick(part.slice(2))
    if (part.startsWith('c:')) return undefined
    // a citation's card: opens as a press on it in the reply does; a citation's line: it becomes the current one
    const ev = /^ev:(\d+)$/.exec(part)
    if (ev && claim) return openCite(cites[Number(ev[1])])
    const to = /^at:(\d+)$/.exec(part)
    if (to && claim) return onClaim({ cite: Number(to[1]), whole: false })
    if (part === 'evidence') return toggleEvidence()
    if (part.startsWith('was-')) return pick(part.slice(4))
  }
  // the clusters in reading order of the map as drawn (graph.js graphView): p n walk these
  const order = view.order as string[]
  // the claims of the cluster shown, and which of them is current: the claim picked, else the list's `cur`
  const cs = group != null && view.chosen ? (groupOf(data, group).cs as Any[]) : []
  const i = claim ? cs.findIndex(c => c.id === claim.id) : Math.max(0, Math.min(cs.length - 1, Number(a.cur) || 0))
  const shown = view.shown as Any
  if (claim && at) {
    // a claim picked: k j the claim before or after it in its cluster (the ends hold), or with its evidence shown the
    // citation before or after the current one; e its evidence shown or hidden (on its line in the detail, here when
    // that line is scrolled away), h its History, c the current citation's code and output whole, x a repair of the
    // current citation (the evidence hidden: of its first failed one, whose evidence then shows)
    if (a.open && view.cites > 1) {
      key('k', 'previous citation', () => onClaim({ cite: (cite - 1 + view.cites) % view.cites, whole: false }))
      key('j', 'next citation', () => onClaim({ cite: (cite + 1) % view.cites, whole: false }))
    } else if (cs.length > 1) {
      key('k', 'previous claim', () => pick(cs[Math.max(0, i - 1)]?.id ?? null))
      key('j', 'next claim', () => pick(cs[Math.min(cs.length - 1, i + 1)]?.id ?? null))
    }
    if (view.cites && !(view.panel as Run[][]).some(r => r[0]?.part === 'evidence')) key('e', a.open ? 'hide evidence' : 'show evidence', toggleEvidence)
    if (view.fixes) key('h', a.history ? 'hide corrections' : 'corrections', () => onClaim({ history: !a.history }))
    if (a.open && (view.cut || a.whole)) key('c', a.whole ? 'shorter' : 'all code and output', () => onClaim({ whole: !a.whole }))
    // the press is the ui.press hook's (seam.ts), which starts the repair inside a hook; while the check runs again, x
    // says so (a second x is not typed into the prompt)
    if (a.open && checkable(shown)) key('x', 'check', () => undefined, CLAIMS_REPAIR)
    else if (a.open ? repairable(shown) : cites.some(repairable)) key('x', 'repair', () => undefined, CLAIMS_REPAIR)
    else if (a.open && shown?.repair && shown.status === 'checking') key('x', 'checking again', () => undefined)
  } else if (view.chosen && cs.length) {
    // a cluster chosen: k j move the current claim of its list (the ends hold), e opens it; p n the other clusters
    key('k', 'previous claim', () => toCur(Math.max(0, i - 1)))
    key('j', 'next claim', () => toCur(Math.min(cs.length - 1, i + 1)))
    key('e', 'open claim', () => pick(cs[i]?.id ?? null))
    if (order.length > 1) {
      key('p', 'previous cluster', () => pickGroup(hopCluster(order, group, -1)))
      key('n', 'next cluster', () => pickGroup(hopCluster(order, group, 1)))
    }
  } else if (order.length) {
    // at rest: n the first cluster
    key('n', 'first cluster', () => pickGroup(order[0]!))
  }
  // a detail taller than its room: d u scroll it a page (the wheel too, a row a tick)
  const page = () => Math.max(1, detail.room - 2)
  if ((view.scroll as { max: number }).max) {
    key('d', 'scroll down', () => scrollDetail($, page()))
    key('u', 'scroll up', () => scrollDetail($, -page()))
  }
  const row = (r: Run[], k: string) => rowEl(els, r, k, press)
  // the answers the claims have not read yet (claims are found on demand): f finds theirs, in the ui.press hook of the
  // observer's (observer.ts), which runs the claims step on them
  const find = await claimsToFind($)
  const findRows = !view.chosen ? findEls(els, find, !raw.claims.length) : []
  // graph.js keeps two rows for the keys (a blank row and theirs); when they wrap in a narrow pane, or the line that
  // finds claims shows, the map and the detail are laid out again in the rows left, so the pane's rows hold the whole
  // drawing
  const more = (keys.length ? 1 + treeRows(keysRow(els, keys, W), W) : 0) + (findRows.length ? treeRows(findRows, W) : 0) - 2
  const laid = more ? graphView(raw, st, { ...opts, h: H - more }) : view
  const sc = laid.scroll as { top: number; max: number; room: number }
  detail = { where, top: sc.top, mark, max: sc.max, room: sc.room }
  // the wheel and the page keys over the pane scroll the detail (core/pane.ts scrollPane), the overview staying
  scrollsOwn(sc.max ? (by: number) => scrollDetail($, Math.abs(by) > 1 ? Math.sign(by) * page() : by) : null)
  return Box({ flexDirection: 'column', children: [
    ...(laid.head as Run[][]).map((r, i) => row(r, `h${i}`)),
    ...findRows,
    ...((laid.graph as Run[][]).length ? [row([], 'gap')] : []),
    ...(laid.graph as Run[][]).map((r, i) => row(r, `g${i}`)),
    ...rowEls(els, laid.panel as Run[][], 'p', press, (r, k) => (r[0]?.part === 'evidence' ? evidenceEl(els, r[0]!.s, k, toggleEvidence) : null)),
    ...(keys.length ? [row([], 'keys-gap'), keysRow(els, keys, W)] : []),
  ] })
}

/** The line that shows a picked claim's evidence, or hides it: a Button e presses (Claude Code draws `e: ` before its
 *  words), in thimble's color. */
function evidenceEl(els: Any, words: string, key: string, onPress: () => unknown): unknown {
  const { Button, Text } = els
  return Button({ key: `${key}:evidence`, plain: true, hotkey: 'e', label: words, hover: quiet('claims-evidence'), onPress, children: [Text({ key: 'w', color: accent(), children: words })] })
}

/** The address of f's Button: the observer's ui.press hook (observer.ts) runs the claims step on the answers. */
export const CLAIMS_FIND = 'claims-find'

/** The line that finds claims, at the pane's top: `f: extract claims` (a press, or f; `of the N newest answers` when
 *  some answers were read), or that they are being found; none when every answer was read. `empty`: no claims yet, so
 *  a blank line sets it apart from the head. */
function findEls(els: Any, find: { answers: number; finding: number }, empty: boolean): unknown[] {
  const { Button, Text } = els
  const many = (n: number) => `${n} answer${n === 1 ? '' : 's'}`
  if (find.finding) return [Text({ key: 'find', dimColor: true, wrap: 'wrap', children: `Finding the claims of ${many(find.finding)}…` })]
  if (!find.answers) return empty ? [Text({ key: 'find', dimColor: true, wrap: 'wrap', children: 'No answers to read yet.' })] : []
  const words = empty ? 'extract claims' : `extract claims of ${find.answers === 1 ? 'the newest answer' : `the ${find.answers} newest answers`}`
  return [
    ...(empty ? [Text({ key: 'find-gap', children: ' ' })] : []),
    Button({ key: CLAIMS_FIND, plain: true, hotkey: 'f', label: words, hover: quiet('claims-find'), onPress: () => undefined, children: [Text({ key: 'w', color: accent(), children: words })] }),
  ]
}
