// pane.tsx: the Claims pane (core/pane.ts kind `claims`), drawn with Claude Code's own elements from what graph.js lays
// out: the head (how many claims), every cluster's row (its claims as dots, then its name; every row open when all
// fit), the cluster chosen open in place (its claims, or the claim picked with its chips, and with e its history and
// evidence), and the keys. A pane taller than Claude Code gives it scrolls. A click is the main way to move: a
// cluster's name chooses the cluster (the open row's name again closes it), a dot or a claim of an open row picks that
// claim (its dot again, the cluster); `↑ N more clusters` and `↓ N more clusters` choose the next cluster folded; `↑ N
// earlier` and `↓ N more` page an open row's claims; ‹ › step through the citations; a citation opens its evidence
// pane. Tab and Enter reach the same Buttons.
//
//   keys while the pane holds the keyboard, each once: p n the previous or next cluster, top to bottom (nothing chosen
//   yet: n the first, p the last) · k j the
//   previous or next claim of the cluster shown (none picked yet: the last or the first; with one cluster, its claims
//   from the start; nothing chosen: the first claim of the first cluster, the last of the last) · e the claim's
//   evidence, open or closed (`no citations` on a claim with none to show) · x repair a failed citation (a check of it
//   again in the background, marks/checker.ts launchRepair, started in this feature's ui.press hook, seam.ts; while
//   that check runs, x says so): with the evidence open the one it shows, else the claim's first failed one, whose
//   evidence then opens · with it open: c the code and output whole · h the whole history · k j the previous or next
//   citation (the claim's, when it has one citation) · b back (where it was said). A focused pane hands a plugin only
//   its Buttons' hotkeys, one letter or digit each, so the citations step on k j, not [ ]; and Claude Code types any
//   other letter into the prompt, the keyboard going with it. So k j p n are keys in every state (p n with one cluster
//   choose it), e in every state with a claim picked, and a key the pane showed stays while its press can still be
//   expected (x after a repair began). The input under the pane asks about what is chosen (threads/pane.tsx). A claim
//   that wraps is one press over all its lines (rowEls), so it highlights whole.
//
// A claim's citations are the reply's marks near its words (store.js sources): their check and evidence come from
// marks/store.ts as they stand now, so a check that ends after the look shows in the open row.
import type { EngineInterface } from 'claude-code'

import { messageOf } from '../core/answers'
import { tellOpened } from '../core/engaged'
import { failNotice } from '../bar/notice'
import { openPane, paneNow } from '../core/pane'
import { themeLast, themeNow } from '../core/theme'
import { launchRepair, repairOf } from '../marks/checker'
import { citeWords } from '../marks/evidence'
import { citeHeat } from '../marks/view'
import { plainSentence } from '../marks/message.js'
import { NOT_RUN, rowMarks, type MarkItem } from '../marks/store'
import { claimGroup, evidenceOf, graphView, groupOf, hopCluster, paneData, repairable, selectedOf, sourceView, threadAbout } from './graph.js'
import { claimsBright, claimsStore, placeText, showClaims, type ClaimsArgs } from './term'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Run = { s: string; tone?: string | null; bold?: boolean; underline?: boolean; tint?: boolean; part?: string | null }

/** The clusters' palette (0.10's c1..c6; the rows draw in its purple, c2: graph.js MARK) and what each other tone draws
 *  as: theme colors, so light and dark both read; a faint tone is its color dimmed; `code` the code's color of the
 *  citations' card; `plain` the theme's text color. */
const CLUSTER = ['#3cc2b9', '#a98be0', '#cfae7e', '#8fa1bd', '#e384b2', '#b2c24f']
/** The same hues for a light background, darker, so a dot and a name read on white (contrast 4.8 or more; the dark set
 *  is near 2 there). */
const CLUSTER_LIGHT = ['#0f7f78', '#7650c4', '#87662a', '#4f6386', '#b03a74', '#677510']
/** A line of code's color: the theme key thimble draws inline code in (tray/tray.ts), shaded by Claude Code. */
const CODE_INK = 'permission'
const THEME: Record<string, string> = { plain: 'text', accent: 'suggestion', good: 'success', bad: 'error', warn: 'warning', cite: 'merged' }

function look(tone: string | null | undefined): Record<string, unknown> {
  if (!tone) return {}
  const faint = tone.endsWith('-faint')
  const t = faint ? tone.slice(0, -6) : tone
  if (t === 'del') return { color: THEME.bad, strikethrough: true }
  if (t === 'ins') return { color: THEME.good }
  const c = /^c(\d)$/.exec(t)
  const color = c ? (themeLast() === 'light' ? CLUSTER_LIGHT : CLUSTER)[(Number(c[1]) - 1) % 6] : t === 'code' ? CODE_INK : THEME[t]
  return { ...(color ? { color } : {}), ...(faint || t === 'dim' ? { dimColor: true } : {}) }
}

/** A run as a Text: its tone, bold and underline; cited words in evidence look as in the citations' card (citeWords,
 *  in hover group `id`). */
function spanOf(els: Any, r: Run, i: number, id: string): unknown {
  return els.Text({
    key: `t${i}`, ...look(r.tone), ...(r.bold ? { bold: true } : {}), ...(r.underline ? { underline: true } : {}),
    ...(r.tint ? citeWords(id) : {}), children: r.s,
  })
}

/** One row of runs: plain Text, with one Button for each stretch of runs that share a part (a press on it). Each
 *  Button's key is the row's key and its part, so no two in the pane share one: a dot is `<row>:n:<id>`. Cited words
 *  are underlined, and the cited words in evidence look as in the citations' card (citeWords: tinted on hover). */
function rowEl(els: Any, runs: Run[], key: string, press: (part: string) => unknown): unknown {
  const { Box, Button, Text } = els
  // the row's cited words are one hover group: a Text that holds them nested joins it, so the pointer over it lights them
  const id = `claims:${key}`
  const heat = (rs: Run[]) => (rs.some(r => r.tint) ? citeHeat(id) : {})
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
 *  whole claim, not one of its lines. Any other row is rowEl's. */
function rowEls(els: Any, rows: Run[][], prefix: string, press: (part: string) => unknown): unknown[] {
  const { Button, Text } = els
  const out: unknown[] = []
  for (let i = 0; i < rows.length;) {
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
  if (a.source) return false
  const data = await withMarks($, paneData(await claimsStore($)))
  const claim = selectedOf(data, a).claim as Any
  if (!claim) return false
  const cites = evidenceOf(claim) as Any[]
  // the evidence open: the citation it shows; closed: the claim's first failed citation (the failed ones come first)
  const at = a.open ? Math.max(0, Math.min(cites.length - 1, Number(a.cite) || 0)) : cites.findIndex(repairable)
  const s = cites[at]
  if (!repairable(s)) return false
  const r = await repairOf($, s.row, s.n)
  if (r === null) return false
  // no word window in a pane that holds the keyboard: x is a key of the pane's, never a letter of the prompt
  const why = typeof r === 'string' ? r : await launchRepair($, r, { until: 0, cancelled: false })
  if (why) failNotice($, why, 'claims:repair')
  // with the evidence closed, it opens on that citation, so the person sees it checked again
  else if (!a.open) await showClaims($, { claim: claim.id, ...(a.at != null ? { at: a.at } : {}), open: true, cite: at })
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

  // ---- every cluster's row, the one chosen open
  const view = graphView(raw, { ...keep, ...(a.from != null ? { from: a.from } : {}) }, { w: W, h: H, bright: await claimsBright($) })
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
    await tellOpened($, { kind: 'citation', row: s.row, n: s.n, words: s.label, status: s.status, failedBy: s.failedBy }, m?.text ?? '')
  }
  const at = claim ? { claim: claim.id, at: data.last } : null
  const cite = Math.max(0, Math.min(view.cites - 1, Number(a.cite) || 0))
  const stepCite = (d: number) => () => (at ? showClaims($, { ...at, open: true, cite: (cite + d + view.cites) % view.cites, ...(a.all ? { all: true } : {}) }) : undefined)
  const press = (part: string) => {
    if (part === 'cite-prev') return stepCite(-1)()
    if (part === 'cite-next') return stepCite(1)()
    const pg = /^pg:(\d+)$/.exec(part)
    if (pg) return showClaims($, { ...keep, from: Number(pg[1]) })
    // a cluster's name: its row opens; the open row's name again closes it
    if (part.startsWith('g:')) return view.chosen && !claim && part.slice(2) === group ? showClaims($, { at: data.last }) : pickGroup(part.slice(2))
    if (part.startsWith('d:')) {
      // a dot: its claim; the claim picked again, its cluster
      const c = data.claims.find((x: Any) => x.id === part.slice(2))
      if (!c) return
      return claim?.id === c.id ? pickGroup(claimGroup(data, c)) : pick(c.id)
    }
    if (part.startsWith('n:')) return pick(part.slice(2))
    // the claim picked: its cluster
    if (part.startsWith('c:')) {
      const c = data.claims.find((x: Any) => x.id === part.slice(2))
      return c ? pickGroup(claimGroup(data, c)) : undefined
    }
    const ev = /^ev-(\d+)$/.exec(part)
    if (ev && claim) return openEvidence(cites[Number(ev[1]) - 1])
    if (part.startsWith('was-')) return pick(part.slice(4))
  }
  // the clusters top to bottom (graph.js graphView): p n walk these
  const order = view.order as string[]
  // k j: the claims of the cluster shown, once one is chosen (none picked yet: k the last, j the first); with one
  // cluster, its claims from the start; nothing chosen: j the first claim of the first cluster, k the last of the last
  const cs = (view.chosen || data.groups.length < 2) && group != null ? (groupOf(data, group).cs as Any[]) : []
  const i = claim ? cs.findIndex(c => c.id === claim.id) : -1
  const claimKeys = () => {
    if (cs.length) {
      key('k', 'previous claim', () => pick(cs[i < 0 ? cs.length - 1 : (i - 1 + cs.length) % cs.length]?.id ?? null))
      key('j', 'next claim', () => pick(cs[(i + 1) % cs.length]?.id ?? null))
    } else if (order.length) {
      key('k', 'previous claim', () => pick((groupOf(data, order[order.length - 1]).cs as Any[]).at(-1)?.id ?? null))
      key('j', 'next claim', () => pick((groupOf(data, order[0]).cs as Any[])[0]?.id ?? null))
    }
  }
  // p n: the cluster before or after the one shown, in reading order; nothing chosen yet, n the first, p the last
  const clusterKeys = () => {
    if (!order.length) return
    key('p', 'previous', () => pickGroup(hopCluster(order, view.chosen ? group : null, -1)))
    key('n', 'next', () => pickGroup(hopCluster(order, view.chosen ? group : null, 1)))
  }
  const shown = view.shown as Any
  const hasEvidence = !!shown?.evidence && shown.status !== 'checking' && shown.status !== 'gone'
  if (claim && a.open && at) {
    // the evidence open: its own keys, as the citation's card in the reply has them
    const now = { ...at, open: true, cite, ...(a.all ? { all: true } : {}), ...(a.whole ? { whole: true } : {}) }
    if (view.cut || a.whole || hasEvidence) key('c', a.whole ? 'shorter' : 'all code and output', () => showClaims($, { ...now, whole: !a.whole }))
    if (view.fixes > 2) key('h', a.all ? 'newest history' : 'all history', () => showClaims($, { ...now, all: !a.all }))
    if (view.cites > 1) {
      key('k', 'previous citation', stepCite(-1))
      key('j', 'next citation', stepCite(1))
    } else claimKeys()
    // the press is the ui.press hook's (seam.ts), which starts the repair inside a hook; while the check runs again, x
    // says so (a second x is not typed into the prompt)
    if (repairable(view.shown)) key('x', 'repair', () => undefined, CLAIMS_REPAIR)
    else if (shown?.repair && shown.status === 'checking') key('x', 'checking again', () => undefined)
    clusterKeys()
    key('e', 'close', () => showClaims($, at))
  } else {
    claimKeys()
    clusterKeys()
    // a claim with nothing to show under it: e says so (and is not typed into the prompt)
    if (claim && at) key('e', view.cites || view.fixes ? 'evidence' : 'no citations', view.cites || view.fixes ? () => showClaims($, { ...at, open: true, cite: 0 }) : () => undefined)
    // a claim picked with a failed citation: x repairs it (its first failed one) as with the evidence open (seam.ts)
    if (claim && at && cites.some(repairable)) key('x', 'repair', () => undefined, CLAIMS_REPAIR)
  }
  const row = (r: Run[], k: string) => rowEl(els, r, k, press)
  const rule: Run[] = [{ s: '─'.repeat(W), tone: 'dim-faint' }]
  return Box({ flexDirection: 'column', children: [
    ...(view.head as Run[][]).map((r, i) => row(r, `h${i}`)),
    ...((view.body as Run[][]).length ? [row([], 'gap')] : []),
    ...rowEls(els, view.body as Run[][], 'b', press),
    ...(keys.length ? [row(rule, 'rule'), keysRow(els, keys)] : []),
  ] })
}
