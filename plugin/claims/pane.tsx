// pane.tsx: the Claims pane (core/pane.ts kind `claims`), drawn with Claude Code's own elements from what graph.js lays
// out: the head (how many claims), the graph of clusters, the panel under it (the cluster selected and its claims, or
// the claim selected in that list, with its chips, and its evidence when opened), and the keys. A click is the main way
// to move: a cluster's name selects the cluster, a dot or a claim in the panel selects that claim (its dot again, the
// cluster); a citation opens its evidence pane; where it was said opens the message. Tab and Enter reach the same
// Buttons.
//
//   keys while the pane holds the keyboard, each once: n p the next or previous cluster · e the claim's evidence, open
//   or closed (a claim selected) · j k the next or previous citation (evidence open, two or more citations) · b back
//   (where it was said). A Button's hotkey is a letter or a digit, so the citations step on j k, not ] [. The input
//   under the pane asks about what is selected (threads/pane.tsx).
//
// A claim's citations are the reply's marks near its words (store.js sources): their check and evidence come from
// marks/store.ts as they stand now, so a check that ends after the look shows in the panel.
import type { EngineInterface } from 'claude-code'

import { messageOf } from '../core/answers'
import { tellOpened } from '../core/engaged'
import { openPane } from '../core/pane'
import { CITE_TINT } from '../marks/evidence'
import { rowMarks, type MarkItem } from '../marks/store'
import { claimGroup, graphView, groupOf, hopCluster, paneData, sourceView, threadAbout } from './graph.js'
import { claimsStore, placeText, showClaims, type ClaimsArgs } from './term'

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

/** The keys' row, ` · ` between them: each a plain Button the key presses. Claude Code draws its key itself (lit, then
 *  a colon), so its words are only the label's, dim as the bar's: words that held the key too drew it twice. */
function keysRow(els: Any, keys: { k: string; label: string; onPress: () => unknown }[]): unknown {
  const { Box, Button, Text } = els
  return Box({ key: 'keys', flexDirection: 'row', flexWrap: 'wrap', children: keys.flatMap((x, i) => [
    ...(i ? [Text({ key: `key-sep-${i}`, dimColor: true, children: ' · ' })] : []),
    Button({ key: `key-${x.k}`, plain: true, hotkey: x.k, label: x.label, onPress: x.onPress, children: [Text({ key: 'w', dimColor: true, children: x.label })] }),
  ]) })
}

export async function drawClaims($: Engine, e: Any, args: unknown, els: Any): Promise<unknown> {
  const a = (args && typeof args === 'object' ? args : {}) as ClaimsArgs
  const W = Math.max(40, Number(e?.props?.bodyColumns) || 90)
  const H = Math.max(14, Number(e?.props?.scroll?.bodyRows) || 36)
  const { Box } = els
  const data = await withMarks($, paneData(await claimsStore($)))
  const keys: { k: string; label: string; onPress: () => unknown }[] = []
  const key = (k: string, label: string, onPress: () => unknown) => keys.push({ k, label, onPress })
  const keep = { claim: a.claim ?? null, group: a.group ?? null, at: a.at ?? null, ...(a.open ? { open: true, cite: a.cite ?? 0 } : {}) }

  // ---- where a claim was said
  if (a.source) {
    const c = data.claims.find((x: Any) => x.id === a.source) ?? null
    const text = a.row ? await placeText($, a.row) : null
    const lines = sourceView(c, text, W) as Run[][]
    key('b', 'back', () => showClaims($, keep))
    return Box({ flexDirection: 'column', children: [
      ...lines.map((r, i) => rowEl(els, r, `s${i}`, () => undefined)),
      rowEl(els, [], 'gap', () => undefined),
      keysRow(els, keys),
    ] })
  }

  // ---- the graph
  const view = graphView(data, keep, { w: W, h: H - 2 })
  const claim = view.claim as Any
  const group = view.group as string | null
  const pick = (id: string | null) => (id ? showClaims($, { claim: id, at: data.last }) : undefined)
  const pickGroup = (k: string | null) => (k != null ? showClaims($, { group: k, at: data.last }) : undefined)
  const openSource = (c: Any) => {
    const said = (c.said || []).find((x: Any) => x.row)
    return showClaims($, { ...keep, claim: c.id, source: c.id, ...(said ? { row: said.row } : {}) })
  }
  const openEvidence = async (s: Any) => {
    if (!s?.row || !s.n) return
    await openPane($, 'evidence', { row: s.row, n: s.n }, `citation ${s.n}`, { focus: true })
    const m = await messageOf($, s.row)
    await tellOpened($, { kind: 'citation', row: s.row, n: s.n, words: s.label, status: s.status }, m?.text ?? '')
  }
  const press = (part: string) => {
    if (part.startsWith('g:')) return pickGroup(part.slice(2))
    if (part.startsWith('d:')) {
      // a dot: its claim; the claim selected again, its cluster
      const c = data.claims.find((x: Any) => x.id === part.slice(2))
      if (!c) return
      return claim?.id === c.id ? pickGroup(claimGroup(data, c)) : pick(c.id)
    }
    if (part.startsWith('n:')) return pick(part.slice(2))
    const ev = /^ev-(\d+)$/.exec(part)
    if (ev && claim) return openEvidence((claim.sources || [])[Number(ev[1]) - 1])
    if (part.startsWith('was-')) return pick(part.slice(4))
    if (part === 'src' && claim) return openSource(claim)
  }
  if (data.groups.length > 1 && group != null) {
    // at rest the panel shows a cluster the map does not light yet: n lights that one, then walks on
    key('n', 'next', () => pickGroup(view.chosen ? hopCluster(data, group, 1) : group))
    key('p', 'previous', () => pickGroup(hopCluster(data, group, -1)))
  }
  if (claim) {
    const at = { claim: claim.id, at: data.last }
    const cite = Math.max(0, Math.min(view.cites - 1, Number(a.cite) || 0))
    if (a.open && view.cites > 1) {
      key('j', 'next citation', () => showClaims($, { ...at, open: true, cite: (cite + 1) % view.cites }))
      key('k', 'previous citation', () => showClaims($, { ...at, open: true, cite: (cite + view.cites - 1) % view.cites }))
    }
    key('e', a.open ? 'close' : 'evidence', () => showClaims($, a.open ? at : { ...at, open: true, cite }))
  }
  const row = (r: Run[], k: string) => rowEl(els, r, k, press)
  return Box({ flexDirection: 'column', children: [
    ...(view.head as Run[][]).map((r, i) => row(r, `h${i}`)),
    row([], 'gap'),
    ...(view.graph as Run[][]).map((r, i) => row(r, `g${i}`)),
    ...(view.panel as Run[][]).map((r, i) => row(r, `p${i}`)),
    ...(keys.length ? [row([], 'gap2'), keysRow(els, keys)] : []),
  ] })
}
