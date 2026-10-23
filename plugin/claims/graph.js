// graph.js: the Claims pane as pure functions over the conversation's claims (store.js): every cluster a row, the
// cluster chosen open in place, the claim picked with its evidence, and where a claim was said. No `$`, no DOM:
// pane.tsx draws what this returns with Claude Code's own elements, and the tests read it as text.
//
//   the head        Claims, how many and in how many clusters (`no claims yet` before the first); `+N new` bold for a
//                   moment after claims came in
//   the rows        every cluster one row, in the order the lens named them (the order its work began): its claims as
//                   dots, all in one purple, right-aligned in a column as wide as the largest cluster, so the rows read
//                   as a plot of the clusters' sizes, then its name; a blank row between turns while they fit. A hollow
//                   dot is a claim a later one corrected, a heavier one a claim said twice or more, a ◆ a claim that
//                   came in while the person browsed (until the next look); a cluster with more claims than the column
//                   holds says how many before its newest dots. No lines join the dots. When every cluster and its
//                   claims fit the pane, every row is open; else each is one line, its name cut after a word
//   the selection   at rest nothing is chosen. A press on a name, or p n, chooses a cluster: its row opens in place, its
//                   dots and name bold, and the other rows stay round it, folded to `↑ N more clusters` and `↓ N more
//                   clusters` only when they do not fit (a press on one chooses the next cluster folded). A press on
//                   the open row's name closes it. A press on a dot, or on a claim of an open row, picks that claim
//   an open row     its name whole, then its claims, each after a dim – (two lines at most, then …), each a press that
//                   picks it; a window round the claim picked when they do not fit (`↑ N earlier`, `↓ N more · claims
//                   a–b of N`, each a press that pages by a screen). A claim picked is ▸ and bold in purple, whole, the
//                   other claims dim, and under it one line of chips (its citations' checks, `corrected ×N`, its turn).
//                   e keeps the claim alone and opens under it, for a corrected claim, its History (one word-level diff
//                   per correction and its reason; the newest two of more, h all), then its citations one at a time,
//                   the failed ones first, as the citation's card in the reply draws them (the cited words and the
//                   check, the code line that printed the value cut in the middle and the output line cut round the
//                   cited words, tinted; a card's title and the cited cell under its column's name; or the file's
//                   place and the line; c shows both whole), and which citation of how many (`‹ i of n ›`, ‹ and › a
//                   press that steps); a press on a citation opens its evidence pane. A citation is verified (a value
//                   the check corrected counts as verified) or failed (the check could not confirm it)
//   where it was said   the message that said the claim, its words marked, and the other places it was said
//
// The view is rows of runs {s, tone, bold, part}: `part` is what a press on the run does (graphView).
import { blocks } from '../marks/message.js'
import { tableLines } from '../marks/table.mjs'
import { evidenceLine, firstSentence, hiddenOutput, lineWindow, moreLines, printLine } from '../tray/tray.mjs'
import { cutWords, edgesOf, findQuote, plainOf, viewOf } from './store.js'

const cut = (s, k) => (Array.from(String(s ?? '')).length <= k ? String(s ?? '') : Array.from(String(s ?? '')).slice(0, Math.max(0, k - 1)).join('') + '…')
const one = s => String(s ?? '').replace(/\s+/g, ' ').trim()
const len = s => Array.from(String(s ?? '')).length
/** A claim's words as a sentence: with its full stop. */
export const sentenceOf = s => one(s).replace(/([\p{L}\p{N}%)"'”’])$/u, '$1.')

/** Words wrapped to lines of at most n characters; a word longer than n goes on over the next lines, so no letter is
 *  lost. */
export function wrap(text, n) {
  const out = []
  let cur = ''
  for (const w of one(text).split(' ')) {
    if (!w) continue
    let word = Array.from(w)
    if (cur && Array.from(cur).length + 1 + word.length <= n) { cur += ' ' + word.join(''); continue }
    if (cur) out.push(cur)
    while (word.length > n) { out.push(word.slice(0, n).join('')); word = word.slice(n) }
    cur = word.join('')
  }
  if (cur) out.push(cur)
  return out
}

/** A cluster's name wrapped to lines of at most n characters (wrap), a … that ends it on the line of the word before
 *  it. */
export const wrapName = (name, n) => wrap(one(name).replace(/ …$/, '\u2060…'), n).map(l => l.replace('\u2060…', ' …'))

/** A claim's dot: hollow once corrected, heavier when said twice or more. */
export const dotOf = c => (c.revised_by ? '○' : (c.n || 1) >= 2 ? '◉' : '●')

/** Who said a claim and when, in a few words, for a side thread: `turn 2`, `turn 2 · you`. */
export function whenOf(c) {
  return [c.turn != null ? `turn ${c.turn}` : '', c.by === 'person' ? 'you' : ''].filter(Boolean).join(' · ')
}

/** A row of runs as plain text (tests). */
export const rowText = runs => runs.map(r => r.s).join('')

/** A claim's history: the claims before it that it corrected, itself, and the claims after it that corrected it, oldest
 *  first. A claim never corrected and correcting none has a history of one. */
export function historyOf(claim, byId) {
  const out = [claim]
  const seen = new Set([claim.id])
  for (let c = claim; c.revises && byId.has(c.revises) && !seen.has(c.revises);) { c = byId.get(c.revises); seen.add(c.id); out.unshift(c) }
  for (let c = claim; c.revised_by && byId.has(c.revised_by) && !seen.has(c.revised_by);) { c = byId.get(c.revised_by); seen.add(c.id); out.push(c) }
  return out
}

// ------------------------------------------------------------------------------------------------ the data

const slim = c => ({
  id: c.id, text: c.text, by: c.by, cluster: c.cluster ?? null, turn: c.turn ?? null, n: c.n || 1,
  ...(c.revised_by ? { revised_by: c.revised_by } : {}), ...(c.revises ? { revises: c.revises } : {}), ...(c.why ? { why: c.why } : {}),
  ...(c.links && c.links.length ? { links: c.links.map(l => ({ to: l.to, how: l.how })) } : {}),
  sources: (c.sources || []).slice(0, 8),
  said: (c.said || []).slice(0, 6).map(s => ({ row: s.row ?? null, by: s.by, turn: s.turn ?? null, quote: s.quote || '', sentence: s.sentence || '', ...(s.start != null ? { start: s.start, end: s.end } : {}), ...(s.ref ? { ref: s.ref } : {}) })),
})

/** The store as the pane reads it: its claims in the order listed (cluster by cluster), the groups in the order the
 *  lens named them with the turn each began (`turn`), the edges, and the head's facts. */
export function paneData(store) {
  const view = viewOf({ clusters: [], gaps: [], ...(store || {}), claims: Array.isArray(store?.claims) ? store.claims : [] })
  const claims = view.flat.map(slim)
  const began = g => g.turn ?? (g.claims.some(c => c.turn != null) ? Math.min(...g.claims.filter(c => c.turn != null).map(c => c.turn)) : null)
  const groups = view.groups.map((g, i) => ({ id: g.id ?? null, name: g.name, i, turn: began(g) }))
  return {
    total: view.total, clusters: view.clusters, last: view.last, gaps: (view.gaps || []).slice(-3),
    claims, groups, edges: edgesOf(view.flat),
  }
}

const num = c => Number(/\d+$/.exec(String(c.id))?.[0] || 0)

/** The key of a group (a cluster's id, `-` for the claims between clusters), and of the group a claim is in. */
export const groupKey = g => (g?.id == null || g.id === '' ? '-' : String(g.id))
export function claimGroup(data, c) {
  const k = String(c?.cluster)
  return (data.groups || []).some(g => g.id != null && String(g.id) === k) ? k : '-'
}

/** What the pane shows: the claim the state names, else the cluster it names; else, at rest, nothing chosen (`group`
 *  then the cluster of the newest correction of the last turn, else of the newest claim). New claims do not move the
 *  selection. {claim, group, chosen}: claim null while a cluster is chosen or at rest. */
export function selectedOf(data, st = {}) {
  const claims = data.claims || []
  if (!claims.length) return { claim: null, group: null, chosen: false }
  const byId = new Map(claims.map(c => [c.id, c]))
  const picked = st.claim ? byId.get(st.claim) : null
  if (picked) return { claim: picked, group: claimGroup(data, picked), chosen: true }
  if (st.group != null && (data.groups || []).some(g => groupKey(g) === String(st.group))) return { claim: null, group: String(st.group), chosen: true }
  const newest = claims.reduce((b, c) => ((c.turn ?? -1) > (b.turn ?? -1) || ((c.turn ?? -1) === (b.turn ?? -1) && num(c) > num(b)) ? c : b))
  const fixes = claims.filter(c => c.revises && c.turn != null && c.turn === newest.turn)
  const rest = fixes.length ? fixes.reduce((b, c) => (num(c) > num(b) ? c : b)) : newest
  return { claim: null, group: claimGroup(data, rest), chosen: false }
}

/** The claims that came in while the person browsed: the last look's, when it came after the selection (`st.at`, the
 *  last turn when it was made). They stay new until the next look. A Set of ids. */
export function freshOf(data, st = {}) {
  if (st.at == null || data.last == null || !(st.at < data.last)) return new Set()
  return new Set((data.claims || []).filter(c => c.turn === data.last).map(c => c.id))
}

/** The key of the cluster after or before the one given (n p), in `order` (the clusters' keys in reading order:
 *  graphView's `order`), else in the order the data lists them. No key (nothing chosen): n the first, p the last. */
export function hopCluster(orderOrData, key, dir) {
  const order = Array.isArray(orderOrData) ? orderOrData.map(String) : (orderOrData?.groups || []).map(groupKey)
  if (!order.length) return null
  const at = key == null ? -1 : order.indexOf(String(key))
  return order[at < 0 ? (dir > 0 ? 0 : order.length - 1) : (at + dir + order.length) % order.length]
}

/** A claim's citations in the order the pane steps through them: the failed ones first. One x checks again (`repair`)
 *  keeps its place among them while it runs and after, so the pane goes on showing it. */
export function evidenceOf(c) {
  const srcs = c.sources || []
  const bad = s => s.status === 'failed' || !!s.repair
  return [...srcs.filter(bad), ...srcs.filter(s => !bad(s))]
}

/** What the side thread about the pane is about: the claim selected, the cluster selected, or the place a claim was
 *  said. Text a model reads. */
export function threadAbout(c, source = false, cluster = null) {
  if (!c && cluster) return `the claims of this session as a graph, in clusters; the cluster selected is "${cutWords(cluster.name, 160)}" (${cluster.n} claim${cluster.n === 1 ? '' : 's'})`
  if (!c) return 'the claims of this session as a graph, in clusters'
  if (source) return `where the claim "${cut(c.text, 200)}" was said (${whenOf(c) || 'this session'})`
  const said = (c.said || []).find(x => x.sentence || x.quote)
  return `the claims of this session as a graph, in clusters; the claim selected is "${cut(c.text, 200)}" (${whenOf(c) || 'this session'}${said ? `, said as "${cut(said.sentence || said.quote, 240)}"` : ''})`
}

// ------------------------------------------------------------------------------------------------ a claim's citations

// a citation's check as the citation's card says it beside `cite`: the sign and word, its tone; and as a chip under a
// claim counts it. Two outcomes: verified (a value the check corrected counts as verified; the claim says corrected),
// and failed (the check could not confirm it, or did not run); and the states before an outcome
const STATUS = {
  verified: ['✓ verified', 'good'], corrected: ['✓ verified', 'good'], failed: ['× failed', 'bad'],
  checking: ['checking', 'dim'], gone: ['no longer in the session', 'dim'],
}
const CHIP = [['good', '✓', 'verified'], ['bad', '×', 'failed'], ['checking', '…', 'checking'], ['dim', '·', 'not checked']]
// a status without an outcome (no check of it ran) is failed
const statusKey = s => (STATUS[s.status] ? s.status : 'failed')

/** Whether x can repair a citation: the check could not confirm it, or did not run (tray/tray.mjs canRepair). */
export const repairable = s => !!s && s.status === 'failed' && !!s.row && !!s.n

/** A line with spans of it tinted (the cited words), as runs; `rest` the look of the words outside them. */
export function tinted(text, spans = [], rest = {}) {
  const out = []
  let at = 0
  for (const [a, b] of spans.filter(([x, y]) => y > x).sort((x, y) => x[0] - y[0])) {
    if (a < at) continue
    if (a > at) out.push({ s: text.slice(at, a), ...rest })
    out.push({ s: text.slice(a, b), tint: true })
    at = b
  }
  if (at < text.length) out.push({ s: text.slice(at), ...rest })
  return out.length ? out : [{ s: ' ' }]
}

/** A line cut in the middle to n characters, ` … ` where it was cut. */
export function midCut(s, n) {
  const t = String(s ?? '')
  if (len(t) <= n || n < 9) return t
  const a = Array.from(t)
  const keep = n - 3
  const head = Math.ceil(keep * 0.6)
  return a.slice(0, head).join('').trimEnd() + ' … ' + a.slice(a.length - (keep - head)).join('').trimStart()
}

/** A line in pieces of at most n characters, with its spans moved into each piece. [{text, spans}] */
function pieces(text, spans, n) {
  const a = Array.from(String(text ?? ''))
  if (!a.length) return [{ text: '', spans: [] }]
  const out = []
  for (let i = 0; i < a.length; i += n) {
    const j = Math.min(a.length, i + n)
    out.push({ text: a.slice(i, j).join(''), spans: spans.map(([x, y]) => [Math.max(x, i) - i, Math.min(y, j) - i]).filter(([x, y]) => y > x) })
  }
  return out
}

/**
 * A citation's evidence as its card in the reply draws it (tray/tray.ts citationBody), in `room` characters: for a
 * value code computed, the one line of the code that printed it, cut in the middle, and the output line that holds it,
 * cut around the cited words, with how many output lines it leaves out; for a card's value, the card's title and the
 * header over the cited row when the value is a table's cell (`table`: the header and the row, tableLines), else the
 * line that holds it; for a file, its place and the cited line. The cited words' spans in the line. Null without
 * evidence. {code?, card?, table?, place?, text, spans, more, cut}: cut when the code or the line was cut.
 */
export function snippetOf(ev, room) {
  const line = evidenceLine(ev)
  if (!line) return null
  const fit = lineWindow(line, Math.max(9, room))
  const cutLine = fit.text !== line.text
  if (ev.kind === 'computed') {
    const code = printLine(ev.code, line.text)
    const shown = midCut(code, room)
    return { code: shown, text: fit.text, spans: fit.spans, more: hiddenOutput(ev), cut: cutLine || shown !== code }
  }
  if (ev.kind === 'card') {
    const table = ev.table ? tableLines(ev.table, Math.max(9, room)) : null
    return { card: one(ev.title || ev.card), ...(table ? { table } : {}), text: fit.text, spans: fit.spans, more: 0, cut: cutLine }
  }
  return { place: `${ev.file}:${line.n ?? ev.line}`, text: fit.text, spans: fit.spans, more: 0, cut: cutLine }
}

/** A citation's evidence whole, for c: every line of the code, then every output line (or the file's lines), each in
 *  pieces W wide, the cited words tinted. Rows of runs. */
function wholeRows(ev, W) {
  const rows = []
  const bar = (p, look = {}) => [{ s: '│', tone: 'dim-faint' }, { s: ' ' }, ...tinted(p.text || ' ', p.spans, look)]
  if (ev.kind === 'computed') {
    for (const l of String(ev.code || '').replace(/\n+$/, '').split('\n')) for (const p of pieces(l, [], W)) rows.push([{ s: p.text || ' ', tone: 'code' }])
    const hit = evidenceLine(ev)
    let found = false
    for (const l of String(ev.output || '').replace(/\n+$/, '').split('\n')) {
      const mine = !found && hit && l === hit.text
      if (mine) found = true
      for (const p of pieces(l, mine ? hit.spans : [], W - 2)) rows.push(bar(p))
    }
    return rows
  }
  if (ev.kind === 'card') {
    // a card's value: the card, then the cited cell's header and row (the columns round it that fit, as the reply's
    // card shows them: a table wrapped reads worse), else what its code printed, else the value
    rows.push(cardLine(ev, W))
    const table = ev.table ? tableLines(ev.table, W - 2) : null
    const lines = table || (ev.output != null ? [] : [evidenceLine(ev)].filter(Boolean))
    for (const l of lines) for (const p of pieces(l.text, l.spans, W - 2)) rows.push(bar(p))
    if (!table && ev.output != null) {
      const hit = evidenceLine(ev)
      let found = false
      for (const l of String(ev.output).replace(/\n+$/, '').split('\n')) {
        const mine = !found && hit && l === hit.text
        if (mine) found = true
        for (const p of pieces(l, mine ? hit.spans : [], W - 2)) rows.push(bar(p))
      }
    }
    return rows
  }
  rows.push([{ s: cut(`${ev.file}:${ev.line}`, W), tone: 'dim' }])
  for (const l of Array.isArray(ev.lines) ? ev.lines : []) for (const p of pieces(String(l.text ?? ''), l.highlight ? [l.highlight] : [], W - 2)) rows.push(bar(p))
  return rows
}

/** A card's value's first row, as the citation's card in the reply has it: `card` dim, then the card's title bold. */
const cardLine = (ev, W) => fit([{ s: 'card ', tone: 'dim' }, { s: one(ev.title || ev.card), bold: true }], W)

/**
 * A citation as its card in the reply draws it, as rows of runs W wide: the cited words bold in the citations' look
 * (underlined, tinted on hover; a failed one's red) and
 * its check beside them (`✓ verified · cite`); what it was, when the check corrected it, or why it failed, dim; then
 * its evidence (snippetOf): the code line in the code's color or the file's place dim, then the line after a dim │, the
 * cited words tinted (the rest dim where the line was cut), and `+ N more lines` under it when the output has more.
 * `whole`: the code and output whole (c). {rows, cut}: cut when the code or the line was cut.
 */
export function cardOf(s, W, { whole = false } = {}) {
  const key = statusKey(s)
  const [word, tone] = STATUS[key]
  const right = [{ s: '   ' }, { s: word, tone }, { s: ' · cite', tone: 'dim' }]
  const words = one(s.shown || s.label)
  const look = key === 'failed' ? { tone: 'bad', underline: true } : { tint: true }
  const rows = [[{ s: cut(words, Math.max(8, W - 3 - len(word) - 7)), ...look, bold: true }, ...right]]
  const dim = t => wrap(t, W).forEach(l => rows.push([{ s: l, tone: 'dim' }]))
  if (s.status === 'corrected' && s.was) dim(`${s.rewritten ? 'sentence rewritten' : s.narrowed ? 'narrowed' : 'corrected'}; was ${one(s.was)}`)
  else if (s.status === 'failed' && s.reason) dim(firstSentence(s.reason))
  if (s.status === 'checking' || s.status === 'gone' || !s.evidence) return { rows, cut: false }
  if (whole) return { rows: [...rows, ...wholeRows(s.evidence, W)], cut: true }
  const sn = snippetOf(s.evidence, W - 2)
  if (!sn) return { rows, cut: false }
  if (sn.code) rows.push([{ s: sn.code, tone: 'code' }])
  if (sn.place) rows.push([{ s: cut(sn.place, W), tone: 'dim' }])
  if (sn.card != null) rows.push(cardLine(s.evidence, W))
  if (sn.table) {
    // a table's cell: the header over the cited row (and any other cited row), the cited cells tinted
    for (const l of sn.table) rows.push([{ s: '│', tone: 'dim-faint' }, { s: ' ' }, ...tinted(l.text || ' ', l.spans)])
    return { rows, cut: sn.cut }
  }
  const clipped = /^…|…$/.test(sn.text)
  rows.push([{ s: '│', tone: 'dim-faint' }, { s: ' ' }, ...tinted(sn.text, sn.spans, clipped ? { tone: 'dim' } : {})])
  if (sn.more) rows.push([{ s: '│', tone: 'dim-faint' }, { s: ' ' }, { s: moreLines(sn.more), tone: 'dim' }])
  return { rows, cut: sn.cut }
}

export const citationRows = (s, W) => cardOf(s, W).rows

/** What a claim's citations' checks found, as chips: `✓ 3 citations verified` when all are alike, else each status
 *  counted (`✓ 10 verified  × 2 failed`), each in its tone; `no citations` without. `short` (a narrow
 *  pane) leaves out `citations`. Runs, two spaces between. */
export function checkChips(c, { short = false } = {}) {
  const srcs = c.sources || []
  if (!srcs.length) return [{ s: 'no citations', tone: 'dim' }]
  const count = { good: 0, bad: 0, checking: 0, dim: 0 }
  for (const s of srcs) {
    const k = statusKey(s)
    count[k === 'checking' ? 'checking' : STATUS[k][1]]++
  }
  const kinds = CHIP.filter(([k]) => count[k]).length
  const out = []
  for (const [k, sign, word] of CHIP) {
    const n = count[k]
    if (!n) continue
    if (out.length) out.push({ s: '  ' })
    out.push({ s: `${sign} ${n}${kinds === 1 && !short ? ` citation${n === 1 ? '' : 's'}` : ''} ${word}`, tone: k === 'checking' ? 'dim' : k })
  }
  return out
}

// why a claim was wrong, as a check of its citations said it: the reason of one it failed or corrected
const checkWhy = c => (c?.sources || []).map(s => ((s.status === 'failed' || s.status === 'corrected') && s.reason ? s.reason : '')).find(Boolean) || ''

/**
 * A claim's corrections, oldest first, each {from, to, old, now, why, part}: each step of its history (historyOf), what
 * the earlier version said and what the later says, in their turns, and why it changed (the claims look's reason, kept
 * with the later claim, else the reason of the check that failed the earlier one's citation); and a citation the check
 * corrected, what it said before the check. `part`: a press selects the other version.
 */
export function correctionsOf(claim, byId) {
  const out = []
  const turn = c => (c.turn != null ? `turn ${c.turn}` : 'before')
  const chain = historyOf(claim, byId)
  for (let i = 1; i < chain.length; i++) {
    const a = chain[i - 1], b = chain[i]
    const other = a.id === claim.id ? b : a
    out.push({ from: turn(a), to: turn(b), old: sentenceOf(a.text), now: sentenceOf(b.text), why: b.why || checkWhy(a), part: `was-${other.id}` })
  }
  for (const s of claim.sources || []) {
    if (s.status !== 'corrected' || !s.was) continue
    out.push({ from: turn(claim), to: 'the check', old: one(s.was), now: one(s.now || s.shown || s.label), why: s.reason || '', part: null })
  }
  return out.map(x => ({ ...x, why: x.why ? sentenceOf(x.why) : '' }))
}

/** A sentence's words, a full stop or comma after a word a token of its own (`glue`: no space before it). */
const tokens = t => one(t).split(' ').filter(Boolean).flatMap(w => {
  const m = /^(.*?[^.,;:!?])([.,;:!?]+)$/.exec(w)
  return m ? [{ s: m[1] }, { s: m[2], glue: true }] : [{ s: w }]
})

/**
 * The words of `a` and `b` compared: [{s, op, glue}] with op `same`, `del` (only in a) or `ins` (only in b), the
 * deleted words of a change before the inserted. Null when most words changed (a rewrite: show both whole).
 */
export function wordDiff(a, b) {
  const tx = tokens(a), ty = tokens(b)
  const x = tx.map(t => t.s), y = ty.map(t => t.s)
  const m = x.length, n = y.length
  const L = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  if (!m || !n || L[0][0] < 0.4 * Math.min(m, n)) return null
  const raw = []
  let i = 0, j = 0
  while (i < m || j < n) {
    if (i < m && j < n && x[i] === y[j]) { raw.push({ ...tx[i], op: 'same' }); i++; j++ } else if (j < n && (i >= m || L[i][j + 1] >= L[i + 1][j])) raw.push({ ...ty[j++], op: 'ins' })
    else raw.push({ ...tx[i++], op: 'del' })
  }
  // one word alike between two changes reads as part of one change: it goes into both
  const seq = []
  for (let k = 0; k < raw.length;) {
    if (raw[k].op !== 'same') { seq.push(raw[k++]); continue }
    let e = k
    while (e < raw.length && raw[e].op === 'same') e++
    const run = raw.slice(k, e)
    const lone = run.filter(t => !t.glue).length <= 1 && k > 0 && e < raw.length
    if (lone) for (const t of run) seq.push({ ...t, op: 'del' }, { ...t, op: 'ins' })
    else seq.push(...run)
    k = e
  }
  const out = []
  let dels = [], ins = []
  const flush = () => { out.push(...dels, ...ins); dels = []; ins = [] }
  for (const t of seq) {
    if (t.op === 'same') { flush(); out.push(t) } else (t.op === 'del' ? dels : ins).push(t)
  }
  flush()
  return out
}

const OP = { del: 'del', ins: 'ins', same: null }

/** Words with their ops wrapped to lines of at most n characters, as rows of runs: deleted words in the `del` tone
 *  (red, struck through), inserted in `ins` (green); the space between two words of one change takes its tone. */
function diffRows(words, n) {
  const rows = []
  let row = [], at = 0, prev = null
  words.forEach((w, k) => {
    // a word and the full stop glued after it go on one line
    const l = len(w.s) + (words[k + 1]?.glue ? len(words[k + 1].s) : 0)
    // a full stop stays on its word's line, with no space before it when the two are alike
    const glued = w.glue && at && (prev === w.op || (prev !== 'same' && w.op === 'same'))
    if (at && !glued && at + 1 + l > n) { rows.push(row); row = []; at = 0; prev = null }
    if (at && !glued) { row.push({ s: ' ', tone: prev && prev === w.op && w.op !== 'same' ? OP[w.op] : null }); at++ }
    row.push({ s: w.s, tone: OP[w.op] })
    at += len(w.s)
    prev = w.op
  })
  if (row.length) rows.push(row)
  return rows
}

/**
 * A claim's History, as rows W wide: each correction as `turn 2 → turn 3` (dim; a press selects the other version),
 * one word-level diff of the two versions, whole sentences (a rewrite shows the old one struck through, then the new),
 * and `reason: …` dim; a blank row between. All of them when `all` or two at most, oldest first; else the newest two,
 * newest first, and how many earlier ones h shows.
 */
export function historyRows(fixes, W, all = false) {
  if (!fixes.length) return []
  const rows = [[{ s: 'History', bold: true }]]
  const folded = !all && fixes.length > 2
  const shown = folded ? fixes.slice(-2).reverse() : fixes
  shown.forEach((x, k) => {
    if (k) rows.push([])
    rows.push([{ s: cut(`${x.from} → ${x.to}`, W), tone: 'dim', part: x.part }])
    const d = wordDiff(x.old, x.now)
    if (d) rows.push(...diffRows(d, W))
    else {
      for (const l of wrap(x.old, W)) rows.push([{ s: l, tone: 'del' }])
      for (const l of wrap(x.now, W)) rows.push([{ s: l, tone: 'ins' }])
    }
    if (x.why) for (const l of wrap(`reason: ${x.why}`, W)) rows.push([{ s: l, tone: 'dim' }])
  })
  if (folded) rows.push([], [{ s: `+ ${fixes.length - 2} earlier correction${fixes.length - 2 === 1 ? '' : 's'}`, tone: 'dim' }])
  return rows
}

/**
 * A claim's evidence, opened under it with e, as rows W wide: a blank row, for a corrected claim its History
 * (historyRows) and a blank row, then one citation as its card draws it (cardOf; a press opens its evidence pane,
 * `ev-N`), a blank row and which citation of how many, `‹ i of n ›` (with more than one, ‹ a press on the one before,
 * `cite-prev`, › on the next, `cite-next`). `st`: {cite, all, whole}. {rows, cites, shown, cut, fixes}
 */
export function evidenceRows(claim, byId, W, st = {}) {
  const rows = [[]]
  const fixes = correctionsOf(claim, byId)
  if (fixes.length) rows.push(...historyRows(fixes, W, !!st.all), [])
  const evidence = evidenceOf(claim)
  const i = Math.max(0, Math.min(evidence.length - 1, Number(st.cite) || 0))
  const s = evidence[i] || null
  let clipped = false
  if (s) {
    const part = s.row && s.n ? `ev-${i + 1}` : null
    const card = cardOf(s, W, { whole: !!st.whole })
    clipped = card.cut
    for (const r of card.rows) rows.push(r.map(x => ({ ...x, part })))
    const step = evidence.length > 1
    rows.push([], [
      { s: '‹', tone: 'accent', part: step ? 'cite-prev' : null }, { s: ' ' }, { s: `${i + 1} of ${evidence.length}`, tone: 'dim' }, { s: ' ' },
      { s: '›', tone: 'accent', part: step ? 'cite-next' : null },
    ])
  } else if (fixes.length) rows.pop()
  return { rows, cites: evidence.length, shown: s, cut: clipped, fixes: fixes.length }
}

/** Runs cut to n cells, the last cut one ending in an ellipsis. */
function fit(runs, n) {
  const out = []
  let left = n
  for (const r of runs) {
    if (left <= 0) break
    const l = len(r.s)
    out.push(l <= left ? r : { ...r, s: cut(r.s, left) })
    left -= l
  }
  return out
}

/** A group's name and claims. {g, name, cs} */
export function groupOf(data, key) {
  const g = (data.groups || []).find(x => groupKey(x) === String(key)) ?? null
  return { g, name: g ? g.name : 'between clusters', cs: (data.claims || []).filter(c => claimGroup(data, c) === String(key)) }
}

/** A claim in an open row, as rows W wide from column `at`, each a press on `part`: `–` and its sentence, wrapped under
 *  its first word, two lines at most (then …). The claim picked: `▸` and the whole sentence bold in MARK; `dim` (another
 *  claim is picked, or another cluster chosen) dim; a new claim (`fresh`) bold. */
function itemRows(c, W, { at = 0, picked = false, dim = false, fresh = false, part = null }) {
  const look = picked ? { tone: MARK, bold: true } : fresh ? { bold: true } : dim ? { tone: 'dim' } : {}
  const room = Math.max(8, W - at - 2)
  let lines = wrap(sentenceOf(c.text), room)
  if (!picked && lines.length > 2) {
    const words = lines[1].split(' ')
    while (words.length > 1 && len(words.join(' ')) + 2 > room) words.pop()
    lines = [lines[0], `${words.join(' ')} …`]
  }
  return lines.map((l, i) => (i
    ? [{ s: ' '.repeat(at + 2), part }, { s: l, ...look, part }]
    : [...(at ? [{ s: ' '.repeat(at), part }] : []), { s: picked ? '▸ ' : '– ', ...(picked || fresh ? look : { tone: 'dim' }), part }, { s: l, ...look, part }]))
}

/** Rows indented by n cells. */
const indent = (rows, n) => rows.map(r => (r.length ? [{ s: ' '.repeat(n), part: r[0].part ?? null }, ...r] : r))

/** The chips under a picked claim: its citations' checks (checkChips), `corrected ×N` (or `corrected later`), its
 *  turn. Runs. */
function chipRuns(claim, fixes, short) {
  const chips = [...checkChips(claim, { short })]
  if (fixes) chips.push({ s: '  ' }, { s: claim.revised_by ? 'corrected later' : fixes > 1 ? `corrected ×${fixes}` : 'corrected', tone: 'cite' })
  const when = whenOf(claim)
  if (when) chips.push({ s: '  ' }, { s: when, tone: 'dim' })
  return chips
}

// ------------------------------------------------------------------------------------------------ the rows

/** The rows' one color, the purple of the clusters' palette (pane.tsx draws c2 so in either theme): every dot, and the
 *  claim picked. A dot's row, not its color, says which cluster it is in. */
export const MARK = 'c2'
/** The dots' column at most, by the pane's width: a cluster with more claims says how many before its newest dots. */
const DOTS = { narrow: 8, mid: 14, wide: 21 }
/** A pane this wide or wider has the widest column of dots. */
const WIDE = 96
/** A pane narrower than this has the narrowest column of dots, and says less in the head and the chips. */
export const NARROW = 48
/** The rows of the other clusters an open row leaves room for at least, when they do not all fit beside it. */
const AROUND = 4
/** The rows of the other clusters above an open row at most, when they do not all fit: the rest go under it. */
const ABOVE = 3
/** The rows an open row keeps at least, however short the pane: its name and a few claims, or a claim's evidence. */
const OPEN_MIN = 8

/** The dots' column: as wide as the largest cluster's claims, at most DOTS's for the pane's width W. */
export function dotColumn(sizes, W) {
  const most = W < NARROW ? DOTS.narrow : W >= WIDE ? DOTS.wide : DOTS.mid
  return Math.min(most, Math.max(1, ...sizes))
}

/** A cluster's dots right-aligned in a column dw wide, oldest first: each claim's dot (dotOf; a new one ◆, bold) in MARK,
 *  a press on its claim (`d:<id>`); `lit` all bold. More claims than the column holds: how many, dim, then the newest
 *  that fit. Runs. */
function dotRuns(cs, dw, { lit = false, fresh = new Set() } = {}) {
  const count = cs.length > dw ? `${cs.length} ` : ''
  const shown = count ? cs.slice(cs.length - Math.max(1, dw - len(count))) : cs
  const pad = dw - len(count) - shown.length
  return [
    ...(pad > 0 ? [{ s: ' '.repeat(pad) }] : []),
    ...(count ? [{ s: count, tone: 'dim' }] : []),
    ...shown.map(c => ({ s: fresh.has(c.id) ? '◆' : dotOf(c), tone: MARK, bold: lit || fresh.has(c.id), part: `d:${c.id}` })),
  ]
}

/** A cluster's row folded: its dots, then its name on the same line, cut after a whole word (cutWords), a press that
 *  chooses the cluster (`g:<key>`); `lit` bold. */
function foldedRow(g, cs, dw, W, { lit = false, fresh } = {}) {
  return [...dotRuns(cs, dw, { lit, fresh }), { s: ` ${cutWords(g.name, Math.max(4, W - dw - 1))}`, bold: lit, part: `g:${g.key}` }]
}

/**
 * A cluster's row open, as rows W wide: its dots and its name whole, wrapped under the name's first letter (a press on
 * it chooses the cluster, `g:<key>`), then its claims under the name (itemRows; a press picks one, `n:<id>`). A claim
 * picked: ▸ and bold in MARK, whole, the others dim, and under it one line of chips (chipRuns); with `st.open` only
 * that claim, its evidence under it (evidenceRows). `lit`: the cluster chosen (its dots and name bold); `dim`: another
 * cluster is chosen, so its claims are dim. `room`: the rows it may take; past them its claims keep a window round the
 * claim picked (or from `st.from`, the first claim it shows once the person paged), `↑ N earlier` above and `↓ N more
 * · claims a–b of N` under, each a press that pages by a screen (`pg:<first claim of that screen>`), and an evidence
 * keeps its head and its steps (clipped). {rows, shown, cut, windowed}
 */
function openRows({ g, cs, claim, dw, W, byId, st, fresh, narrow, lit = false, dim = false, room = Infinity }) {
  const at = dw + 1
  const part = `g:${g.key}`
  const rows = wrapName(g.name, Math.max(4, W - at)).map((l, i) => (i
    ? [{ s: ' '.repeat(at), part }, { s: l, bold: lit, part }]
    : [...dotRuns(cs, dw, { lit, fresh }), { s: ` ${l}`, bold: lit, part }]))
  const fixes = claim ? correctionsOf(claim, byId).length : 0
  const pickedRows = c => [...itemRows(c, W, { at, picked: true, part: `c:${c.id}` }), fit([{ s: ' '.repeat(at + 2) }, ...chipRuns(c, fixes, narrow)], W)]
  if (claim && st.open) {
    const ev = evidenceRows(claim, byId, W - at - 2, st)
    const out = { rows: [...rows, ...pickedRows(claim), ...indent(ev.rows, at + 2)], shown: ev.shown, cut: ev.cut, windowed: false }
    // too tall for its room: the rows that do not fit go from the middle, the steps between citations stay; c (all code
    // and output) and h (the whole history) show it all, and the pane scrolls
    return out.rows.length > room && !st.whole && !st.all ? clipped(out, Math.max(OPEN_MIN, room), ev.cites ? 2 : 0, at + 2) : out
  }
  const items = cs.map(c => (claim?.id === c.id ? pickedRows(c) : itemRows(c, W, { at, dim: dim || !!claim, fresh: fresh.has(c.id), part: `n:${c.id}` })))
  // the window of claims the list shows: all when they fit, else round the claim picked (or from the first), or from
  // the claim the person paged to
  const all = items.reduce((a, r) => a + r.length, 0)
  const budget = Math.max(3, room - rows.length)
  const fitIn = budget - 2
  // the claims a screen shows from claim `a` down
  const downFrom = a => { let b = a, used = 0; while (b < items.length && (b === a || used + items[b].length <= fitIn)) { used += items[b].length; b++ } return b }
  // the first claim of the screen that ends just above claim `b`
  const upFrom = b => { let a = b, used = 0; while (a > 0 && (a === b || used + items[a - 1].length <= fitIn)) { a--; used += items[a].length } return a }
  let lo = 0, hi = items.length
  if (all > budget) {
    const from = Number(st.from)
    if (Number.isInteger(from) && from >= 0 && from < items.length) {
      lo = from; hi = downFrom(lo)
      // the last screen ends with the last claim
      if (hi === items.length) lo = upFrom(items.length)
    } else {
      const me = Math.max(0, claim ? cs.findIndex(c => c.id === claim.id) : 0)
      lo = me; hi = me + 1
      let used = items[me]?.length || 0
      for (let grew = true; grew;) {
        grew = false
        // a few claims above the one picked, then the ones under it, then the rest above
        if (lo > 0 && me - lo < Math.min(3, Math.floor(fitIn / 3)) && used + items[lo - 1].length <= fitIn) { lo--; used += items[lo].length; grew = true; continue }
        if (hi < items.length && used + items[hi].length <= fitIn) { used += items[hi].length; hi++; grew = true; continue }
        if (lo > 0 && used + items[lo - 1].length <= fitIn) { lo--; used += items[lo].length; grew = true }
      }
    }
  }
  const windowed = lo > 0 || hi < items.length
  const pad = ' '.repeat(at)
  if (lo > 0) rows.push([{ s: `${pad}↑ ${lo} earlier`, tone: 'dim', part: `pg:${upFrom(lo)}` }])
  for (let i = lo; i < hi; i++) rows.push(...items[i])
  if (windowed) rows.push([{ s: `${pad}${hi < items.length ? `↓ ${items.length - hi} more · ` : ''}claims ${lo + 1}–${hi} of ${items.length}`, tone: 'dim', part: hi < items.length ? `pg:${hi}` : null }])
  return { rows, shown: null, cut: false, windowed }
}

/** An open row cut to `room` rows: its head and its last `tail` rows (the steps between citations) kept, and `… N more
 *  rows` dim where rows went, from column `at`. Cut, so c offers the whole. */
function clipped(o, room, tail, at) {
  const end = tail ? o.rows.slice(-tail) : []
  const keep = Math.max(1, room - end.length - 1)
  const gone = o.rows.length - keep - end.length
  return { ...o, rows: [...o.rows.slice(0, keep), [{ s: `${' '.repeat(at)}… ${gone} more row${gone === 1 ? '' : 's'}`, tone: 'dim' }], ...end], cut: true }
}

/** The groups with their claims' count, in the order listed: [{...group, key, n}], the empty ones left out. */
function counted(data) {
  const counts = new Map()
  for (const c of data.claims || []) counts.set(claimGroup(data, c), (counts.get(claimGroup(data, c)) || 0) + 1)
  return (data.groups || []).map(g => ({ ...g, key: groupKey(g), n: counts.get(groupKey(g)) || 0 })).filter(g => g.n)
}

/**
 * Every cluster's row, as rows W wide in `room` rows: every row open when all of them fit (openRows, a blank row
 * between clusters), but not while a claim's evidence is open; else each folded to one line (foldedRow) and the
 * cluster chosen open in place, with room for at least AROUND rows of the others, and a blank row between turns when
 * all of that fits. The rows that do not fit fold to `↑ N more clusters` above and `↓ N more clusters` under, each a
 * press that chooses the cluster next to the rows shown: ABOVE of them above the open row at most, the rest under it;
 * with nothing chosen, from the top. {rows, shown, cut, windowed, every}
 */
function clusterRows({ data, groups, claim, group, chosen, st, fresh, W, byId, narrow, room }) {
  const csOf = new Map(groups.map(g => [g.key, groupOf(data, g.key).cs]))
  const dw = dotColumn(groups.map(g => g.n), W)
  const mine = g => chosen && g.key === group
  const open = (g, r) => openRows({ g, cs: csOf.get(g.key), claim: mine(g) ? claim : null, dw, W, byId, st, fresh, narrow, lit: mine(g), dim: chosen && !mine(g), room: r })
  if (!(claim && st.open)) {
    const all = groups.map(g => open(g))
    if (all.reduce((a, o) => a + o.rows.length, 0) + groups.length - 1 <= room) {
      return { rows: all.flatMap((o, i) => (i ? [[], ...o.rows] : o.rows)), shown: null, cut: false, windowed: false, every: true }
    }
  }
  const at = chosen ? groups.findIndex(mine) : -1
  const others = groups.length - (at >= 0 ? 1 : 0)
  const opened = at >= 0 ? open(groups[at], Math.max(OPEN_MIN, room - Math.min(others, AROUND) - (others > AROUND ? 2 : 0))) : null
  const left = room - (opened ? opened.rows.length : 0)
  const n = groups.length
  // the rows shown, lo to hi: all when they fit; else round the open row, a few above it and the rest under it; else
  // from the top
  let lo = 0, hi = n
  if (others > left) {
    if (at < 0) hi = Math.max(1, left - 1)
    else {
      const cost = (l, h) => h - l - 1 + (l > 0 ? 1 : 0) + (h < n ? 1 : 0)
      lo = at; hi = at + 1
      for (;;) {
        const up = lo > 0 ? [lo - 1, hi] : null
        const down = hi < n ? [lo, hi + 1] : null
        const next = (up && (at - lo < ABOVE || !down) ? [up, down] : [down, up]).find(x => x && cost(...x) <= left)
        if (!next) break
        ;[lo, hi] = next
      }
    }
  }
  const turnOf = g => g.turn ?? null
  const turned = i => i > 0 && turnOf(groups[i]) !== turnOf(groups[i - 1])
  const gaps = lo === 0 && hi === n && groups.filter((g, i) => turned(i)).length <= left - others
  const pad = { s: ' '.repeat(dw + 1) }
  const more = k => `${k} more cluster${k === 1 ? '' : 's'}`
  const rows = []
  if (lo > 0) rows.push([pad, { s: `↑ ${more(lo)}`, tone: 'dim', part: `g:${groups[lo - 1].key}` }])
  for (let i = lo; i < hi; i++) {
    if (gaps && turned(i)) rows.push([])
    if (i === at) rows.push(...opened.rows)
    else rows.push(foldedRow(groups[i], csOf.get(groups[i].key), dw, W, { fresh }))
  }
  if (hi < n) rows.push([pad, { s: `↓ ${more(n - hi)}`, tone: 'dim', part: `g:${groups[hi].key}` }])
  return { rows, shown: opened?.shown ?? null, cut: !!opened?.cut, windowed: !!opened?.windowed, every: false }
}

/** The rows the keys take under the rows, their rule's included: pane.tsx's keys for the state, the longest words each
 *  can have, each drawn `k: words` with ` · ` between, wrapped to W as their row wraps. */
function keyRows(W, { claim, open, cites, fixes }) {
  const step = cites > 1 ? ['k: previous citation', 'j: next citation'] : ['k: previous claim', 'j: next claim']
  const keys = !claim ? ['k: previous claim', 'j: next claim', 'p: previous', 'n: next']
    : open ? ['c: all code and output', ...(fixes > 2 ? ['h: newest history'] : []), ...step, 'x: checking again', 'p: previous', 'n: next', 'e: close']
      : ['k: previous claim', 'j: next claim', 'p: previous', 'n: next', 'e: no citations', 'x: repair']
  let rows = 1, at = 0
  for (const k of keys) {
    if (at && at + 3 + len(k) > W) { rows++; at = len(k) } else at += (at ? 3 : 0) + len(k)
  }
  return 1 + rows
}

/**
 * The Claims pane as rows of runs, w × h cells (the rows the pane has, the keys' rule and row included): the head, then
 * every cluster's row (clusterRows), the cluster chosen open in place. `st` = {claim, group, at, open, cite, all, whole,
 * from}: the claim picked, else the cluster chosen (its key), the last turn when it was chosen; with a claim, whether
 * its evidence is open, the citation shown, the whole history, the whole evidence; `from` the first claim of the open
 * row's window, once the person paged. `bright`: claims came in a moment ago. Returns {head, body, claim, group,
 * chosen, cites, shown, cut, fixes, windowed, every, narrow, data, order}: `every` when every row is open; `order` the
 * clusters' keys top to bottom, the order p n walk. head and body are rows of runs, a run's `part` what a press on it
 * does (`g:<key>` a cluster, `d:<id>` a dot, `n:<id>` a claim of an open row, `c:<id>` the claim picked, `ev-N` a
 * citation, `cite-prev` `cite-next` the citation before or after, `was-<id>` another version of the claim, `pg:<i>` a
 * screen of the open row's claims from its claim i).
 */
export function graphView(data, st = {}, { w = 90, h = 40, bright = false } = {}) {
  const W = Math.max(24, w)
  const narrow = W < NARROW
  const H = Math.max(12, h)
  const claims = data.claims || []
  const byId = new Map(claims.map(c => [c.id, c]))
  const { claim, group, chosen } = selectedOf(data, st)
  const fresh = freshOf(data, st)
  // `+N new` for a moment: the claims that came in while browsing, else the last look's
  const head = [headRuns(data, { narrow, fresh: bright ? fresh.size || claims.filter(c => c.turn != null && c.turn === data.last).length : 0 })]
  for (const g of data.gaps || []) head.push([{ s: `Turn ${g.turn} was not read: `, tone: 'bad' }, { s: cut(g.why || 'the look at the answer failed', W - 24), tone: 'dim' }])
  const cites = claim ? evidenceOf(claim).length : 0
  const fixes = claim ? correctionsOf(claim, byId).length : 0
  const base = { claim, group, chosen, cites, fixes, narrow, data }
  if (!claims.length) return { head, body: [], ...base, shown: null, cut: false, windowed: false, every: false, order: [] }
  const groups = counted(data)
  // the rows under the head and the blank row after it, over the keys
  const room = H - head.length - 1 - keyRows(W, { claim, open: !!st.open, cites, fixes })
  const got = clusterRows({ data, groups, claim, group, chosen, st, fresh, W, byId, narrow, room })
  return { head, body: got.rows, ...base, shown: got.shown, cut: got.cut, windowed: got.windowed, every: got.every, order: groups.map(g => g.key) }
}

/** The head: Claims, how many and in how many clusters (`no claims yet` before the first), and `+N new` for a moment
 *  after claims came in. The clusters are the lens's that hold claims (the claims between clusters are none). */
function headRuns(data, { narrow = false, fresh = 0 } = {}) {
  const n = data.total || 0
  const groups = (data.groups || []).filter(g => g.id != null).length
  const out = [{ s: 'Claims', bold: true }]
  if (!n) out.push({ s: ' · no claims yet', tone: 'dim' })
  else out.push({ s: ` · ${n.toLocaleString('en-US')}${narrow ? '' : ` claim${n === 1 ? '' : 's'}`}${groups > 1 ? ` · ${groups} clusters` : ''}`, tone: 'dim' })
  if (fresh) out.push({ s: '  ' }, { s: `+${fresh} new`, bold: true })
  return out
}

// ------------------------------------------------------------------------------------------------ where it was said

/** Where a place's words are in a message's markdown: [start, end), from the place's offsets when they still hold its
 *  words, else found again by its quote; null when they are not there. */
export function spanOf(md, place) {
  const s = String(md || '')
  const start = Number(place.start), end = Number(place.end)
  const fold = x => String(x || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  if (Number.isFinite(start) && Number.isFinite(end) && end > start && end <= s.length && fold(plainOf(s.slice(start, end)).plain) === fold(plainOf(place.quote).plain)) return [start, end]
  const hit = findQuote(s, place.quote || place.sentence || '')
  return hit ? [hit.start, hit.end] : null
}

/**
 * A message as a person reads it, in rows of at most n characters: each block's words (an item after a bullet), a
 * blank row where the message has one, and the place's words marked. A window of at most `max` rows that opens a few
 * rows above the marked words. {rows: [[{s, on}]], at, last}: at and last, the first and last rows marked.
 */
export function messageRows(md, place, n, max = 16) {
  const s = String(md || '')
  const span = spanOf(s, place)
  if (!span) return null
  const rows = []
  for (const b of blocks(s)) {
    if (b.type === 'rule') continue
    if (rows.length && b.gap) rows.push([{ s: ' ', on: false }])
    const lead = b.type === 'item' ? '• ' : b.type === 'quote' ? '│ ' : ''
    const p = plainOf(s.slice(b.from, b.to))
    const marked = p.at.map(m => m + b.from >= span[0] && m + b.from < span[1])
    markWrap(p.plain, marked, n - lead.length).forEach((l, i) => rows.push([{ s: i ? ' '.repeat(lead.length) : lead, on: false }, ...l]))
  }
  const on = rows.map(r => r.some(x => x.on))
  const at = on.indexOf(true)
  if (at < 0) return null
  const last = on.lastIndexOf(true)
  const from = Math.max(0, Math.min(at - 4, last + 3 - max))
  return { rows: rows.slice(from, from + max), at: at - from, last: Math.min(last, from + max - 1) - from }
}

/** Plain words wrapped to lines of at most n characters, each line runs {s, on}, a word on when any of its characters
 *  is marked. */
export function markWrap(plain, marked, n) {
  const lines = []
  let cur = []
  let l = 0
  const re = /\S+/g
  let m
  while ((m = re.exec(plain))) {
    const w = m[0].length > n ? m[0].slice(0, n - 1) + '…' : m[0]
    const on = marked.slice(m.index, m.index + m[0].length).some(Boolean)
    if (l && l + 1 + w.length > n) { lines.push(cur); cur = []; l = 0 }
    if (cur.length) cur.push({ s: ' ', on: on && cur[cur.length - 1].on })
    cur.push({ s: w, on })
    l += (l ? 1 : 0) + w.length
  }
  if (cur.length) lines.push(cur)
  return lines
}

/** Where a claim was said, as rows of runs: the message that said it, its words marked, and the other places it was
 *  said. `text` is the message's markdown (null when it is not in the session any more). */
export function sourceView(c, text, w = 90) {
  const W = Math.max(40, w)
  if (!c) return [[{ s: 'That claim is not in this session any more.', tone: 'dim' }]]
  const said = c.said || []
  const first = said[0] || null
  const who = first ? (first.by === 'person' ? 'your message' : "Claude's message") : ''
  const lines = [[{ s: 'Where it was said', tone: 'c2', bold: true }, { s: `  ${who}`, tone: 'dim' }], []]
  const msg = first && text ? messageRows(text, first, W - 1) : null
  if (msg) msg.rows.forEach(r => lines.push(r.map(x => (x.on ? { s: x.s, tone: 'accent', bold: true } : { s: x.s }))))
  else if (first) lines.push([{ s: `“${cut(first.sentence || first.quote, W - 4)}”`, tone: 'accent', bold: true }])
  const again = said.slice(1)
  if (again.length) {
    lines.push([], [{ s: 'also said', tone: 'dim' }])
    for (const p of again) lines.push([...(p.by === 'person' ? [{ s: 'you ', tone: 'dim' }] : []), { s: `“${cut(p.sentence || p.quote, W - 8)}”` }])
  }
  return lines
}
