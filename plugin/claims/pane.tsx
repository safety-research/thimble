// pane.tsx: the Claims pane (core/pane.ts kind `claims`), drawn with Claude Code's own elements from what graph.js lays
// out: the head (how many claims), the graph of clusters, the panel under it (the cluster selected and its claims, or
// the claim selected and its cluster's name), and the keys. A click is the main way to move, a cluster first, then one
// of its claims: a cluster's name and a dot of another cluster select the cluster; a dot of the cluster selected, or a
// claim in the panel, selects that claim (its dot again, the cluster). Details are on demand: a claim's citations on e,
// where it was said on m. Tab and Enter reach the same Buttons.
//
//   keys while the pane holds the keyboard, drawn as the bar draws its keys: n p the next or previous cluster ·
//   e evidence (the claim's citations, a press on one its evidence pane) · h history · m source (where it was said) ·
//   b back (where it was said). The input under the pane asks about what is selected (threads/pane.tsx).
//
// A claim's citations are the reply's marks near its words (store.js sources): their check and evidence come from
// marks/store.ts as they stand now, so a check that ends after the look shows in the panel.
import type { EngineInterface } from 'claude-code'

import { messageOf } from '../core/answers'
import { tellOpened } from '../core/engaged'
import { openPane } from '../core/pane'
import { rowMarks, type MarkItem } from '../marks/store'
import { claimGroup, graphView, groupOf, hopCluster, paneData, sourceView, threadAbout } from './graph.js'
import { claimsStore, placeText, showClaims, type ClaimsArgs } from './term'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Run = { s: string; tone?: string | null; bold?: boolean; part?: string | null }

/** The clusters' colors (0.10's c1..c6) and what each other tone draws as: theme colors, so light and dark both read;
 *  a faint tone is its color dimmed. */
const CLUSTER = ['#3cc2b9', '#a98be0', '#cfae7e', '#8fa1bd', '#e384b2', '#b2c24f']
const THEME: Record<string, string> = { accent: 'suggestion', good: 'success', bad: 'error', warn: 'warning', cite: 'merged' }

function look(tone: string | null | undefined): Record<string, unknown> {
  if (!tone) return {}
  const faint = tone.endsWith('-faint')
  const t = faint ? tone.slice(0, -6) : tone
  const c = /^c(\d)$/.exec(t)
  const color = c ? CLUSTER[(Number(c[1]) - 1) % 6] : THEME[t]
  return { ...(color ? { color } : {}), ...(faint || t === 'dim' ? { dimColor: true } : {}) }
}

/** One row of runs: plain Text, with one Button for each stretch of runs that share a part (a press on it). Each
 *  Button's key is the row's key and its part, so no two in the pane share one: a dot is `<row>:n:<id>`. */
function rowEl(els: Any, runs: Run[], key: string, press: (part: string) => unknown): unknown {
  const { Box, Button, Text } = els
  const span = (r: Run, i: number) => Text({ key: `t${i}`, ...look(r.tone), ...(r.bold ? { bold: true } : {}), children: r.s })
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
  if (ev.kind === 'card') return { place: `card ${ev.title || ev.card}`, line: ev.value }
  const hit = ev.lines.find(l => l.highlight) ?? ev.lines[0]
  return { place: `${ev.file}:${ev.line}`, ...(hit ? { line: hit.text } : {}) }
}

/** The claims' sources with their marks as they stand now: status, words shown, place, and the mark's number. */
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
      return { ...s, n: m.n, status: m.status, failedBy: m.failedBy, shown: m.shown.replace(/\*\*|`/g, ''), ...placeOf(m) }
    }))
  }
  return data
}

/** What the side thread under the claims pane is about (threads/pane.tsx): the claim selected, the cluster selected, or
 *  where a claim was said. The arguments keep only what names the thing (not the e and h toggles). */
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

/** The keys' row: each key as the bar draws it (its letter lit and bold, its words dim), ` · ` between them, each a
 *  Button the key presses. */
function keysRow(els: Any, keys: { k: string; label: string; onPress: () => unknown }[]): unknown {
  const { Box, Button, Text } = els
  return Box({ key: 'keys', flexDirection: 'row', flexWrap: 'wrap', children: keys.flatMap((x, i) => [
    ...(i ? [Text({ key: `key-sep-${i}`, dimColor: true, children: ' · ' })] : []),
    Button({ key: `key-${x.k}`, plain: true, hotkey: x.k, label: x.label, onPress: x.onPress, children: [
      Text({ key: 'k', color: 'suggestion', bold: true, children: x.k }), Text({ key: 'w', dimColor: true, children: ` ${x.label}` }),
    ] }),
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
  const keep = { claim: a.claim ?? null, group: a.group ?? null, open: a.open ?? null, at: a.at ?? null }

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
  const pick = (id: string | null, open: ClaimsArgs['open'] = null) => (id ? showClaims($, { claim: id, open, at: data.last }) : undefined)
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
      // a dot: its cluster first; within the cluster selected, the claim; the claim selected again, its cluster
      const c = data.claims.find((x: Any) => x.id === part.slice(2))
      if (!c) return
      const k = claimGroup(data, c)
      if (!view.chosen || k !== group) return pickGroup(k)
      return claim?.id === c.id ? pickGroup(k) : pick(c.id)
    }
    if (part.startsWith('n:')) return pick(part.slice(2))
    const ev = /^ev-(\d+)$/.exec(part)
    if (ev && claim) return openEvidence((claim.sources || [])[Number(ev[1]) - 1])
    if (part.startsWith('was-')) return pick(part.slice(4), 'hist')
  }
  if (data.groups.length > 1 && group != null) {
    key('n', 'next', () => pickGroup(hopCluster(data, group, 1)))
    key('p', 'previous', () => pickGroup(hopCluster(data, group, -1)))
  }
  if (claim) {
    const toggle = (what: 'ev' | 'hist') => showClaims($, { claim: claim.id, open: view.open === what ? null : what, at: data.last })
    if ((claim.sources || []).length) key('e', view.open === 'ev' ? 'evidence ●' : 'evidence', () => toggle('ev'))
    if (view.history.length > 1) key('h', view.open === 'hist' ? 'history ●' : 'history', () => toggle('hist'))
    key('m', 'source', () => openSource(claim))
  }
  return Box({ flexDirection: 'column', children: [
    ...(view.head as Run[][]).map((r, i) => rowEl(els, r, `h${i}`, press)),
    rowEl(els, [], 'gap', press),
    ...(view.graph as Run[][]).map((r, i) => rowEl(els, r, `g${i}`, press)),
    ...(view.panel as Run[][]).map((r, i) => rowEl(els, r, `p${i}`, press)),
    ...(keys.length ? [rowEl(els, [], 'gap2', press), keysRow(els, keys)] : []),
  ] })
}
