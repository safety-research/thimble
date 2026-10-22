// pane.tsx: the Claims pane (core/pane.ts kind `claims`), drawn with Claude Code's own elements from what graph.js lays
// out: the head (how many claims), the graph of clusters, the panel under it (the claim selected,
// its citations, its cluster and the cluster's claims), and the keys. A click is the main way to move: each dot is a
// Button (on the claim selected it opens where the claim was said; on another it selects that one), as is each claim
// of the cluster in the panel, the claim's sentence (where it was said), a citation (its evidence pane) and a version
// in its history (that claim). Tab and Enter reach the same Buttons.
//
//   keys while the pane holds the keyboard: n p the next or previous cluster · e evidence (the cited lines) ·
//   h history · m where it was said · a ask about it in a side thread · b back (where it was said)
//
// A claim's citations are the reply's marks near its words (store.js sources): their check and evidence come from
// marks/store.ts as they stand now, so a check that ends after the look shows in the panel.
import type { EngineInterface } from 'claude-code'

import { failNotice } from '../bar/notice'
import { messageOf } from '../core/answers'
import { tellOpened } from '../core/engaged'
import { openPane } from '../core/pane'
import { rowMarks, type MarkItem } from '../marks/store'
import { openThread } from '../threads/seam'
import { graphView, hopCluster, paneData, sourceView, threadAbout } from './graph.js'
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

/** What the side thread under the claims pane is about (threads/pane.tsx): the claim selected, or where it was said,
 *  as the pane's `a` asks it, so the input under the pane and `a` share one thread, as 0.10's panel input asked about
 *  the claim selected. The arguments keep only what names the thing (not the e and h toggles). */
export async function claimsThreadScope($: Engine, args: unknown): Promise<{ about: string; args: ClaimsArgs }> {
  const a = (args && typeof args === 'object' ? args : {}) as ClaimsArgs
  const data = paneData(await claimsStore($))
  if (a.source) {
    const c = data.claims.find((x: Any) => x.id === a.source) ?? null
    return { about: threadAbout(c, true), args: { source: a.source, ...(a.row ? { row: a.row } : {}) } }
  }
  const c = a.claim ? data.claims.find((x: Any) => x.id === a.claim) ?? null : null
  return { about: threadAbout(c), args: c ? { claim: c.id } : {} }
}

export async function drawClaims($: Engine, e: Any, args: unknown, els: Any): Promise<unknown> {
  const a = (args && typeof args === 'object' ? args : {}) as ClaimsArgs
  const W = Math.max(40, Number(e?.props?.bodyColumns) || 90)
  const H = Math.max(14, Number(e?.props?.scroll?.bodyRows) || 36)
  const { Box, Button, Text } = els
  const data = await withMarks($, paneData(await claimsStore($)))
  const keys: unknown[] = []
  const key = (k: string, label: string, onPress: () => unknown) => keys.push(Button({ key: `key-${k}`, plain: true, hotkey: k, label, onPress }))
  const keep = { claim: a.claim ?? null, open: a.open ?? null, at: a.at ?? null }
  const ask = async (about: string, args2: ClaimsArgs) => {
    if (!(await openThread($, { about, pane: { kind: 'claims', args: args2 } }))) failNotice($, 'The side thread could not open here. Ask Claude in the prompt instead.', 'claims')
  }

  // ---- where a claim was said
  if (a.source) {
    const c = data.claims.find((x: Any) => x.id === a.source) ?? null
    const text = a.row ? await placeText($, a.row) : null
    const lines = sourceView(c, text, W) as Run[][]
    key('b', 'back to the claims', () => showClaims($, keep))
    if (c) key('a', 'ask about it', () => ask(threadAbout(c, true), { source: c.id, ...(a.row ? { row: a.row } : {}) }))
    return Box({ flexDirection: 'column', children: [
      ...lines.map((r, i) => rowEl(els, r, `s${i}`, () => undefined)),
      rowEl(els, [], 'gap', () => undefined),
      Box({ key: 'keys', flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, children: keys }),
    ] })
  }

  // ---- the graph
  const view = graphView(data, keep, { w: W, h: H - 2 })
  const claim = view.claim as Any
  const pick = (id: string | null, open: ClaimsArgs['open'] = a.open ?? null) => (id ? showClaims($, { claim: id, open, at: data.last }) : undefined)
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
    if (!claim) return
    if (part.startsWith('n:')) {
      const id = part.slice(2)
      // a press on the claim selected (its dot, its row in the panel) opens where it was said; on another it selects that one
      if (id === claim.id && view.chosen) return openSource(claim)
      return pick(id)
    }
    if (part === 'said') return openSource(claim)
    const ev = /^ev-(\d+)$/.exec(part)
    if (ev) return openEvidence((claim.sources || [])[Number(ev[1]) - 1])
    if (part.startsWith('was-')) return pick(part.slice(4), 'hist')
  }
  if (claim) {
    const toggle = (what: 'ev' | 'hist') => showClaims($, { claim: claim.id, open: view.open === what ? null : what, at: data.last })
    if (data.groups.length > 1) {
      key('n', 'next cluster', () => pick(hopCluster(data, claim.id, 1)))
      key('p', 'previous cluster', () => pick(hopCluster(data, claim.id, -1)))
    }
    if ((claim.sources || []).length) key('e', view.open === 'ev' ? 'evidence ●' : 'evidence', () => toggle('ev'))
    if (view.history.length > 1) key('h', view.open === 'hist' ? 'history ●' : 'history', () => toggle('hist'))
    key('m', 'where it was said', () => openSource(claim))
    key('a', 'ask about it', () => ask(threadAbout(claim), { claim: claim.id }))
  }
  // the click is the main way: said once, dim, before the keys
  if (claim) keys.unshift(Text({ key: 'key-click', dimColor: true, children: 'click a dot or a claim to select it' }))
  return Box({ flexDirection: 'column', children: [
    ...(view.head as Run[][]).map((r, i) => rowEl(els, r, `h${i}`, press)),
    rowEl(els, [], 'gap', press),
    ...(view.graph as Run[][]).map((r, i) => rowEl(els, r, `g${i}`, press)),
    ...(view.panel as Run[][]).map((r, i) => rowEl(els, r, `p${i}`, press)),
    ...(keys.length ? [rowEl(els, [], 'gap2', press), Box({ key: 'keys', flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, children: keys })] : []),
  ] })
}
