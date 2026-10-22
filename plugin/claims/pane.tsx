// pane.tsx: the Claims pane (core/pane.ts kind `claims`), drawn with Claude Code's own elements from what graph.js lays
// out: the head (how many claims), the map of clusters (its cells shorter when the detail needs the rows; a list in a
// narrow pane), the detail under it (the cluster chosen and its claims, or the claim picked in that list with its
// chips, and with e its history and evidence), and the keys. A pane taller than Claude Code gives it scrolls. A click is
// the main way to move: a cluster's name chooses the cluster, a dot or a claim in the list picks that claim (its dot
// again, the cluster); `↑ N earlier` and `↓ N more` page the list; ‹ › step through the citations; a citation opens its
// evidence pane. Tab and Enter reach the same Buttons.
//
//   keys while the pane holds the keyboard, each once: p n the previous or next cluster · k j the previous or next
//   claim (a claim picked, the list in a window) · e the claim's evidence, open or closed · with it open: c the code
//   and output whole · h the whole history · k j the previous or next citation · x repair the citation shown (a failed
//   one: a check of it again in the background, marks/checker.ts launchRepair, started in this feature's ui.press hook,
//   seam.ts) · b back (where it was said). A focused pane hands a plugin only its Buttons' hotkeys, one letter or digit
//   each, so the citations step on k j, not [ ]. The input under the pane asks about what is chosen (threads/pane.tsx).
//
// A claim's citations are the reply's marks near its words (store.js sources): their check and evidence come from
// marks/store.ts as they stand now, so a check that ends after the look shows in the detail.
import type { EngineInterface } from 'claude-code'

import { messageOf } from '../core/answers'
import { tellOpened } from '../core/engaged'
import { failNotice } from '../bar/notice'
import { openPane, paneNow } from '../core/pane'
import { launchRepair, repairOf } from '../marks/checker'
import { CITE_TINT } from '../marks/evidence'
import { rowMarks, type MarkItem } from '../marks/store'
import { claimGroup, evidenceOf, graphView, groupOf, hopCluster, paneData, repairable, selectedOf, sourceView, threadAbout } from './graph.js'
import { claimsBright, claimsStore, placeText, showClaims, type ClaimsArgs } from './term'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Run = { s: string; tone?: string | null; bold?: boolean; underline?: boolean; tint?: boolean; part?: string | null }

/** The clusters' colors (0.10's c1..c6) and what each other tone draws as: theme colors, so light and dark both read;
 *  a faint tone is its color dimmed; `code` the code's color of the citations' card. */
const CLUSTER = ['#3cc2b9', '#a98be0', '#cfae7e', '#8fa1bd', '#e384b2', '#b2c24f']
/** A line of code's color: the theme key thimble draws inline code in (tray/tray.ts), shaded by Claude Code. */
const CODE_INK = 'permission'
const THEME: Record<string, string> = { accent: 'suggestion', good: 'success', bad: 'error', warn: 'warning', cite: 'merged' }

function look(tone: string | null | undefined): Record<string, unknown> {
  if (!tone) return {}
  const faint = tone.endsWith('-faint')
  const t = faint ? tone.slice(0, -6) : tone
  if (t === 'del') return { color: THEME.bad, strikethrough: true }
  if (t === 'ins') return { color: THEME.good }
  const c = /^c(\d)$/.exec(t)
  const color = c ? CLUSTER[(Number(c[1]) - 1) % 6] : t === 'code' ? CODE_INK : THEME[t]
  return { ...(color ? { color } : {}), ...(faint || t === 'dim' ? { dimColor: true } : {}) }
}

/** One row of runs: plain Text, with one Button for each stretch of runs that share a part (a press on it). Each
 *  Button's key is the row's key and its part, so no two in the pane share one: a dot is `<row>:n:<id>`. Cited words
 *  are underlined, and the cited words in evidence tinted as in the citations' card. */
function rowEl(els: Any, runs: Run[], key: string, press: (part: string) => unknown): unknown {
  const { Box, Button, Text } = els
  const span = (r: Run, i: number) => Text({
    key: `t${i}`, ...look(r.tone), ...(r.bold ? { bold: true } : {}), ...(r.underline ? { underline: true } : {}),
    ...(r.tint ? { backgroundColor: CITE_TINT } : {}), children: r.s,
  })
  if (!runs.length) return Text({ key, children: ' ' })
  if (!runs.some(r => r.part)) return Text({ key, wrap: 'truncate-end', children: runs.map(span) })
  const kids: unknown[] = []
  for (let i = 0; i < runs.length;) {
    const part = runs[i]!.part
    if (!part) { kids.push(span(runs[i]!, i)); i++; continue }
    let j = i
    while (j < runs.length && runs[j]!.part === part) j++
    kids.push(Button({ key: `${key}:${part}`, plain: true, onPress: () => press(part), children: runs.slice(i, j).map((r, k) => span(r, i + k)) }))
    i = j
  }
  return Box({ key, flexDirection: 'row', children: kids })
}

/** Where `path:line` a mark's evidence shows, and its first highlighted line. */
function placeOf(m: MarkItem): { place?: string; line?: string } {
  const ev = m.evidence
  if (!ev) return {}
  if (ev.kind === 'computed') return { place: 'computed', line: ev.output.split('\n')[0] }
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
      if (!r) return { ...s, status: 'unchecked' }
      const m = r.items.find(x => x.start === s.at) ?? r.items.find(x => x.words.replace(/\*\*|`/g, '') === s.label)
      if (!m) return { ...s, status: 'gone' }
      return {
        ...s, n: m.n, status: m.status, failedBy: m.failedBy, shown: m.shown.replace(/\*\*|`/g, ''), ...placeOf(m),
        ...(m.was ? { was: m.was.replace(/\*\*|`/g, '') } : {}), ...(m.reason ? { reason: m.reason } : {}), ...(m.evidence ? { evidence: m.evidence } : {}),
      }
    }))
  }
  return data
}

/** What the side thread under the claims pane is about (threads/pane.tsx): the claim selected, the cluster selected, or
 *  where a claim was said. The arguments keep only what names the thing. */
export async function claimsThreadScope($: Engine, args: unknown): Promise<{ about: string; args: ClaimsArgs }> {
  const a = (args && typeof args === 'object' ? args : {}) as ClaimsArgs
  const data = paneData(await claimsStore($))
  if (a.source) {
    const c = data.claims.find((x: Any) => x.id === a.source) ?? null
    return { about: threadAbout(c, true), args: { source: a.source, ...(a.row ? { row: a.row } : {}) } }
  }
  const c = a.claim ? data.claims.find((x: Any) => x.id === a.claim) ?? null : null
  if (c) return { about: threadAbout(c), args: { claim: c.id } }
  if (a.group != null && data.groups.some((g: Any) => (g.id == null ? '-' : String(g.id)) === String(a.group))) {
    const { name, cs } = groupOf(data, a.group)
    return { about: threadAbout(null, false, { name, n: cs.length }), args: { group: String(a.group) } }
  }
  return { about: threadAbout(null), args: {} }
}

type Key = { k: string; label: string; onPress: () => unknown; id?: string }

/** The keys' row, ` · ` between them: each a plain Button the key presses (its address `key-<k>`, or its own `id`).
 *  Claude Code draws its key itself (lit, then a colon), so its words are only the label's, dim as the bar's: words
 *  that held the key too drew it twice. */
function keysRow(els: Any, keys: Key[]): unknown {
  const { Box, Button, Text } = els
  return Box({ key: 'keys', flexDirection: 'row', flexWrap: 'wrap', children: keys.flatMap((x, i) => [
    ...(i ? [Text({ key: `key-sep-${i}`, dimColor: true, children: ' · ' })] : []),
    Button({ key: x.id ?? `key-${x.k}`, plain: true, hotkey: x.k, label: x.label, onPress: x.onPress, children: [Text({ key: 'w', dimColor: true, children: x.label })] }),
  ]) })
}

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
  if (!a.open || a.source) return false
  const data = await withMarks($, paneData(await claimsStore($)))
  const claim = selectedOf(data, a).claim as Any
  if (!claim) return false
  const cites = evidenceOf(claim) as Any[]
  const s = cites[Math.max(0, Math.min(cites.length - 1, Number(a.cite) || 0))]
  if (!repairable(s)) return false
  const r = await repairOf($, s.row, s.n)
  if (r === null) return false
  // no word window in a pane that holds the keyboard: x is a key of the pane's, never a letter of the prompt
  const why = typeof r === 'string' ? r : await launchRepair($, r, { until: 0, cancelled: false })
  if (why) failNotice($, why, 'claims:repair')
  return true
}

export async function drawClaims($: Engine, e: Any, args: unknown, els: Any): Promise<unknown> {
  const a = (args && typeof args === 'object' ? args : {}) as ClaimsArgs
  const W = Math.max(24, Number(e?.props?.bodyColumns) || 90)
  const H = Math.max(14, Number(e?.props?.scroll?.bodyRows) || 36)
  const { Box } = els
  const raw = await withMarks($, paneData(await claimsStore($)))
  const keys: Key[] = []
  const key = (k: string, label: string, onPress: () => unknown, id?: string) => keys.push({ k, label, onPress, ...(id ? { id } : {}) })
  const keep = { claim: a.claim ?? null, group: a.group ?? null, at: a.at ?? null, ...(a.open ? { open: true, cite: a.cite ?? 0 } : {}) }

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
  const view = graphView(raw, { ...keep, ...(a.from != null ? { from: a.from } : {}) }, { w: W, h: H, bright: await claimsBright($) })
  // the clusters as the map draws them (graph.js fitClusters): p n walk these
  const data = view.data as Any
  const claim = view.claim as Any
  const group = view.group as string | null
  const pick = (id: string | null) => (id ? showClaims($, { claim: id, at: data.last }) : undefined)
  const pickGroup = (k: string | null) => (k != null ? showClaims($, { group: k, at: data.last }) : undefined)
  const cites = claim ? (evidenceOf(claim) as Any[]) : []
  const openEvidence = async (s: Any) => {
    if (!s?.row || !s.n) return
    await openPane($, 'evidence', { row: s.row, n: s.n }, `citation ${s.n}`, { focus: true })
    const m = await messageOf($, s.row)
    await tellOpened($, { kind: 'citation', row: s.row, n: s.n, words: s.label, status: s.status }, m?.text ?? '')
  }
  const at = claim ? { claim: claim.id, at: data.last } : null
  const cite = Math.max(0, Math.min(view.cites - 1, Number(a.cite) || 0))
  const stepCite = (d: number) => () => (at ? showClaims($, { ...at, open: true, cite: (cite + d + view.cites) % view.cites, ...(a.all ? { all: true } : {}) }) : undefined)
  const press = (part: string) => {
    if (part === 'cite-prev') return stepCite(-1)()
    if (part === 'cite-next') return stepCite(1)()
    const pg = /^pg:(\d+)$/.exec(part)
    if (pg) return showClaims($, { ...keep, from: Number(pg[1]) })
    if (part.startsWith('g:')) return pickGroup(part.slice(2))
    if (part.startsWith('d:')) {
      // a dot: its claim; the claim picked again, its cluster
      const c = data.claims.find((x: Any) => x.id === part.slice(2))
      if (!c) return
      return claim?.id === c.id ? pickGroup(claimGroup(data, c)) : pick(c.id)
    }
    if (part.startsWith('n:')) return pick(part.slice(2))
    const ev = /^ev-(\d+)$/.exec(part)
    if (ev && claim) return openEvidence(cites[Number(ev[1]) - 1])
    if (part.startsWith('was-')) return pick(part.slice(4))
  }
  if (claim && a.open && at) {
    // the evidence open: its own keys, as the citation's card in the reply has them
    const now = { ...at, open: true, cite, ...(a.all ? { all: true } : {}), ...(a.whole ? { whole: true } : {}) }
    if (view.cut || a.whole) key('c', a.whole ? 'shorter' : 'all code and output', () => showClaims($, { ...now, whole: !a.whole }))
    if (view.fixes > 2) key('h', a.all ? 'newest history' : 'all history', () => showClaims($, { ...now, all: !a.all }))
    if (view.cites > 1) {
      key('k', 'previous citation', stepCite(-1))
      key('j', 'next citation', stepCite(1))
    }
    // the press is the ui.press hook's (seam.ts), which starts the repair inside a hook
    if (repairable(view.shown)) key('x', 'repair', () => undefined, CLAIMS_REPAIR)
    key('e', 'close', () => showClaims($, at))
  } else {
    if (claim && view.windowed) {
      // the list in a window: k j walk its claims
      const cs = groupOf(data, group).cs as Any[]
      const i = cs.findIndex(c => c.id === claim.id)
      key('k', 'previous claim', () => pick(cs[(i - 1 + cs.length) % cs.length]?.id ?? null))
      key('j', 'next claim', () => pick(cs[(i + 1) % cs.length]?.id ?? null))
    }
    if (data.groups.length > 1 && group != null) {
      // at rest nothing is chosen: n chooses the cluster of what is newest, p the one before it
      key('p', 'previous', () => pickGroup(hopCluster(data, group, -1)))
      key('n', 'next', () => pickGroup(view.chosen ? hopCluster(data, group, 1) : group))
    }
    if (claim && at && (view.cites || view.fixes)) key('e', 'evidence', () => showClaims($, { ...at, open: true, cite: 0 }))
  }
  const row = (r: Run[], k: string) => rowEl(els, r, k, press)
  const rule: Run[] = [{ s: '─'.repeat(W), tone: 'dim-faint' }]
  return Box({ flexDirection: 'column', children: [
    ...(view.head as Run[][]).map((r, i) => row(r, `h${i}`)),
    ...((view.graph as Run[][]).length ? [row([], 'gap')] : []),
    ...(view.graph as Run[][]).map((r, i) => row(r, `g${i}`)),
    ...(view.panel as Run[][]).map((r, i) => row(r, `p${i}`)),
    ...(keys.length ? [row(rule, 'rule'), keysRow(els, keys)] : []),
  ] })
}
