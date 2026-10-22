// store.js: the conversation's claims, as pure functions. No `$`, no Node, no DOM: the observer's claims lens, the
// Claims pane (graph.js, pane.tsx), the hooks (term.ts) and the tests import it.
//
// A claim is one statement the transcript makes, of one kind. One JSON file per conversation, claims.json in its kept
// folder (core/env.ts keptDir):
//
//   {v: 1, session, updated,
//    claims: [{id, text, by, cluster, turn, said: [place], sources: [source], revises?, revised_by?, why?,
//              links?: [{to, how: supports | contradicts | same topic}]}],
//    clusters: [{id, name, turn, named}],
//    gaps: [{turn, why}]}
//
//   a place  {row, by, turn, quote, sentence, start, end}: where a claim was said, the message row, who said it
//            (claude | person), the words matched and their sentence, as offsets into the row's markdown.
//   ×N       a claim's said.length: each distinct place it was said.
//   why      on a claim that revises another: why the earlier one was wrong, as the lens gave it. The pane shows it in
//            the claim's history (e) with what the earlier one said (graph.js correctionsOf); with none, the reason
//            of the check that failed the earlier one's citation stands for it.
//   a source {ref, label, row?, at?, quote?}: a citation `[words](#)` near the claim's words, {ref: `<row>@<offset>`,
//            row, at: the citation's offset in the row's markdown, label: its words}, which the reply's marks
//            (marks/store.ts) give a check and evidence.
//
// After a turn of work the observer's pass lists the turn's claims ({quote, claim, by, cluster, same, revises, why, links});
// applyTurn places each by its quote in the turn's messages, takes the citations in or near its sentence as its
// sources, merges a restatement into the claim it repeats (a new place, so ×N grows), links a correction both ways
// (revises / revised_by), keeps the links a claim names to others, and puts each new claim in a cluster: one named so
// far, or a new one.
import { blocks, marksIn } from '../marks/message.js'

/** Each markdown link of a text, `[words](target)`, as a match: index, [0] the whole link, [1] its words. */
export function linkSpans(text) {
  return [...String(text || '').matchAll(/\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(([^()\s]*)\)/g)]
}
const MAX_TEXT = 200
const MAX_QUOTE = 240
const MAX_SENTENCE = 320
const MAX_WHY = 240
/** A cluster grown this much since it was named is offered to the lens to rename or split. */
export const GROWN = { least: 6, factor: 2 }

const str = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '')
const cutTo = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…')

/** A new, empty store for a session. */
export function emptyStore(session = '') {
  return { v: 1, session: String(session || ''), updated: null, claims: [], clusters: [], gaps: [] }
}

/** A store read from its file's text (or parsed JSON): whatever holds is kept, the rest starts empty. A map of the
 *  whole folder an earlier version kept (claims by `folder`, clusters from `folder`) is left out. */
export function readStore(text, session = '') {
  let d = text
  if (typeof text === 'string') {
    try { d = JSON.parse(text) } catch { d = null }
  }
  const s = emptyStore(session || d?.session)
  if (!d || typeof d !== 'object') return s
  s.updated = d.updated || null
  s.claims = (Array.isArray(d.claims) ? d.claims : []).filter(c => c && c.id && c.text && c.by !== 'folder').map(c => {
    const { folder: _, ...rest } = c
    return { ...rest, said: (Array.isArray(c.said) ? c.said : []).filter(p => p?.by !== 'folder'), ...(Array.isArray(c.links) ? { links: c.links.filter(l => !l?.folder) } : {}) }
  }).map(c => ({ ...c, said: Array.isArray(c.said) ? c.said : [], sources: (Array.isArray(c.sources) ? c.sources : []).map(sourceOf).filter(Boolean) }))
  s.clusters = (Array.isArray(d.clusters) ? d.clusters : []).filter(c => c && c.id && c.from !== 'folder')
  s.gaps = Array.isArray(d.gaps) ? d.gaps : []
  for (const [k, v] of Object.entries(d)) if (!(k in s) && k !== 'folder' && k !== 'folderAsked') s[k] = v
  return oneNameOneCluster(s)
}

/** Two clusters of the same name are one: the later one's claims move to the
 *  earlier, and the later one goes. A turn can make the second, when its claims name a cluster the same turn's split
 *  then names too. */
export function oneNameOneCluster(store) {
  const seen = new Map()
  const gone = new Set()
  for (const c of store.clusters) {
    const key = String(c.name || '').toLowerCase().trim()
    const first = seen.get(key)
    if (!first) { seen.set(key, c); continue }
    for (const x of store.claims) if (x.cluster === c.id) x.cluster = first.id
    gone.add(c.id)
  }
  if (gone.size) store.clusters = store.clusters.filter(c => !gone.has(c.id))
  return store
}

// ------------------------------------------------------------------------------------------------ the words as read

/**
 * Markdown as a person reads it: a link reads as its words, and emphasis, code ticks, heading hashes and quote marks
 * go. `at[i]` is the markdown offset of `plain[i]`, so a match in the words maps back to the markdown.
 */
export function plainOf(md) {
  const s = String(md || '')
  let plain = ''
  const at = []
  const put = (ch, i) => { plain += ch; at.push(i) }
  let i = 0
  let lineStart = true
  while (i < s.length) {
    const c = s[i]
    if (lineStart) {
      const head = /^(#{1,6}\s+|>\s?)/.exec(s.slice(i, i + 8))
      if (head) { i += head[0].length; lineStart = false; continue }
    }
    lineStart = c === '\n'
    if (c === '[') {
      const m = linkSpans(s.slice(i))[0]
      if (m && m.index === 0) {
        for (let k = 0; k < m[1].length; k++) if (!'*_`'.includes(m[1][k])) put(m[1][k], i + 1 + k)
        i += m[0].length
        continue
      }
    }
    if (c === '`' || c === '*') { i++; continue }
    if (c === '_' && !(/[\p{L}\p{N}]/u.test(s[i - 1] || '') && /[\p{L}\p{N}]/u.test(s[i + 1] || ''))) { i++; continue }
    if (c === '\\' && i + 1 < s.length && /[\\`*_{}[\]()#+\-.!|~>]/.test(s[i + 1])) { put(s[i + 1], i + 1); i += 2; continue }
    put(c, i)
    i++
  }
  return { plain, at }
}

const FOLD = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '−': '-', ' ': ' ', '…': '...' }

/** Text folded for matching: lower case, one kind of quote and dash, runs of space as one; `at` maps back. */
export function foldOf(text, at0 = null) {
  const s = String(text || '')
  let out = ''
  const at = []
  let space = false
  for (let i = 0; i < s.length; i++) {
    let ch = FOLD[s[i]] ?? s[i]
    if (/\s/.test(ch)) {
      if (space || !out.length) continue
      space = true
      out += ' '
      at.push(at0 ? at0[i] : i)
      continue
    }
    space = false
    ch = ch.toLowerCase()
    for (const x of ch) { out += x; at.push(at0 ? at0[i] : i) }
  }
  if (out.endsWith(' ')) { out = out.slice(0, -1); at.pop() }
  return { text: out, at }
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'.,%-]*/gu
const STOP = new Set('the a an of to in on at for and or but is are was were be been it its this that these those with by from as than then so not no'.split(' '))
/** The words that carry a claim: numbers and words of three letters or more, folded. */
export function wordsOf(text) {
  const out = []
  for (const m of foldOf(plainOf(text).plain).text.matchAll(WORD)) {
    const w = m[0].replace(/[.,'-]+$/, '')
    if (!w || STOP.has(w)) continue
    if (/\d/.test(w) || w.length >= 3) out.push(w)
  }
  return out
}

/** How much of claim a's words claim b holds, and b of a: their overlap over the larger set (0..1). */
export function likeness(a, b) {
  const A = new Set(wordsOf(a))
  const B = new Set(wordsOf(b))
  if (!A.size || !B.size) return 0
  let n = 0
  for (const w of A) if (B.has(w)) n++
  return n / Math.max(A.size, B.size)
}

// ------------------------------------------------------------------------------------------------ where it was said

/** The sentence around [start, end) of the markdown: from the end of the sentence before to the end of this one. A
 *  line break ends a sentence too (a list item, a table row); a link's words never do. */
export function sentenceAt(md, start, end = start) {
  const s = String(md || '')
  const links = linkSpans(s).map(m => [m.index, m.index + m[0].length])
  const inLink = i => links.some(([a, b]) => i > a && i < b)
  const stop = i => {
    const c = s[i]
    if (c === '\n') return true
    if (!/[.!?]/.test(c) || inLink(i)) return false
    let j = i + 1
    while (j < s.length && /["')\]*_”’]/.test(s[j])) j++
    return j >= s.length || /\s/.test(s[j])
  }
  let a = Math.max(0, Math.min(start, s.length))
  while (a > 0 && !stop(a - 1)) a--
  while (a < s.length && /[\s"'*_>#-]/.test(s[a]) && a < start) a++
  let b = Math.max(a, Math.min(end, s.length))
  if (!(b > a && b <= s.length && stop(b - 1))) {
    while (b < s.length && !stop(b)) b++
    if (b < s.length && s[b] !== '\n') {
      b++
      while (b < s.length && /["')\]*_”’]/.test(s[b])) b++
    }
  }
  return { start: a, end: Math.max(a, b) }
}

/**
 * Where a quote stands in a text: the exact words (as read, folded), else the sentence that holds most of its words
 * (at least 60% of them, and three or more). Returns {start, end, exact} in markdown offsets, or null.
 */
export function findQuote(md, quote) {
  const p = plainOf(md)
  const hay = foldOf(p.plain, p.at)
  const q = foldOf(plainOf(quote).plain).text.replace(/^[\s"'.,;:…-]+|[\s"'.,;:…-]+$/g, '')
  if (!q || !hay.text) return null
  const tries = [q, ...q.split(/\s*\.\.\.\s*/).filter(x => x.split(' ').length >= 3)]
  for (const t of tries) {
    const k = hay.text.indexOf(t)
    if (k >= 0) return { start: hay.at[k], end: hay.at[k + t.length - 1] + 1, exact: t === q }
  }
  const want = new Set(wordsOf(quote))
  if (want.size < 3) return null
  let best = null
  let at = 0
  const s = String(md || '')
  while (at < s.length) {
    const sent = sentenceAt(s, at, at)
    const end = Math.max(sent.end, at + 1)
    const got = new Set(wordsOf(s.slice(sent.start, end)))
    let n = 0
    for (const w of want) if (got.has(w)) n++
    const score = n / want.size
    let from = sent.start
    const lead = /^(\s|[-*+>#]\s?|\d{1,3}[.)]\s)+/.exec(s.slice(from, end))
    if (lead) from += lead[0].length
    if (n >= 3 && score >= 0.6 && (!best || score > best.score)) best = { start: from, end, score }
    at = end
  }
  return best ? { start: best.start, end: best.end, exact: false } : null
}

const numbersIn = t => new Set((String(t || '').match(/\d[\d,.]*/g) || []).map(x => x.replace(/[,.]+$/, '').replace(/,/g, '')))

/** The citations in or near [start, end): those in its own words, else those in its sentence (a sentence can hold
 *  several claims, each with its citations); with none there, those of its block (a paragraph, a list item, a table
 *  row) whose words hold a number the claim states (`text`), so a sentence with no citation of its own borrows only one
 *  that shows the same value. At most four, each {at, label}: the citation's offset in the markdown and its words. */
export function sourcesNear(md, start, end, text = '') {
  const s = String(md || '')
  const marks = marksIn(s).map(m => ({ ...m, label: m.words }))
  if (!marks.length) return []
  const sent = sentenceAt(s, start, end)
  const own = marks.filter(m => m.start < end && m.end > start)
  let got = own.length ? own : marks.filter(m => m.start >= sent.start && m.end <= Math.max(sent.end, end))
  const want = numbersIn(text)
  if (!got.length && want.size) {
    const b = blocks(s).find(x => start >= x.start && start <= x.end)
    if (b) {
      let from = b.start
      let to = b.end
      if (b.type === 'table') {
        const row = (b.rows || []).find(r => start >= r.start && start <= r.end)
        if (row) { from = row.start; to = row.end }
      }
      got = marks.filter(m => m.start >= from && m.end <= to && [...numbersIn(m.label)].some(n => want.has(n))).sort((x, y) => Math.abs(x.start - start) - Math.abs(y.start - start)).slice(0, 2)
    }
  }
  const out = []
  for (const m of got) if (!out.some(x => x.at === m.start)) out.push({ at: m.start, label: String(m.label).replace(/\*\*|`/g, '') })
  return out.slice(0, 4)
}

/** Sources as {ref, label, ...}: a bare ref is read as its own label; a citation keeps its row and offset. */
export const sourceOf = x => (typeof x === 'string' ? { ref: x, label: shortRef(x) } : x && typeof x.ref === 'string' ? { ref: x.ref, label: x.label || shortRef(x.ref), ...(typeof x.row === 'string' ? { row: x.row } : {}), ...(typeof x.at === 'number' ? { at: x.at } : {}), ...(x.quote ? { quote: String(x.quote) } : {}) } : null)

/** A citation near a claim as a source: its row and its offset there, which name it among the reply's marks. */
export const citationSource = (row, s) => ({ ref: `${row}@${s.at}`, row: String(row), at: s.at, label: s.label })

/** A ref as a person reads it: a line of a file as `file:line`. */
export function shortRef(ref) {
  const r = String(ref || '')
  const [path, loc] = r.split('#')
  const file = path.split('/').pop() || path
  const line = /^L(\d+)(?:-L?(\d+))?/.exec(loc || '')
  return line ? `${file}:${line[1]}${line[2] ? '-' + line[2] : ''}` : file + (loc ? '#' + loc : '')
}

const addSources = (claim, list) => {
  claim.sources = (claim.sources || []).map(sourceOf).filter(Boolean)
  for (const x of list || []) {
    const s = sourceOf(x)
    if (s && !claim.sources.some(y => y.ref === s.ref)) claim.sources.push(s)
  }
  claim.sources = claim.sources.slice(0, 8)
}

/** The words a person reads in [start, end) of the markdown, on one line. */
export function wordsIn(md, start, end) {
  const p = plainOf(md)
  let out = ''
  for (let i = 0; i < p.plain.length; i++) if (p.at[i] >= start && p.at[i] < end) out += p.plain[i]
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * Where a claim was said: its quote found in one of the turn's places (the person's message for `by: person`, else
 * Claude's messages, newest first; then any). A place is {row, by, turn, text}; returns the place as the store keeps
 * it, with the sources near it, or null when the quote is in none of them.
 */
export function locate(quote, places, by = 'claude', text = '') {
  const list = Array.isArray(places) ? places : []
  const mine = list.filter(p => (p.by || 'claude') === by).reverse()
  const rest = list.filter(p => (p.by || 'claude') !== by).reverse()
  for (const p of [...mine, ...rest]) {
    const hit = findQuote(p.text, quote)
    if (!hit) continue
    const sent = sentenceAt(p.text, hit.start, hit.end)
    return {
      place: {
        row: p.row, by: p.by || 'claude', turn: p.turn ?? null,
        quote: cutTo(wordsIn(p.text, hit.start, hit.end), MAX_QUOTE),
        sentence: cutTo(wordsIn(p.text, sent.start, sent.end), MAX_SENTENCE),
        start: hit.start, end: hit.end,
      },
      sources: sourcesNear(p.text, hit.start, hit.end, text).map(x => citationSource(p.row, x)),
      exact: hit.exact,
    }
  }
  return null
}

// ------------------------------------------------------------------------------------------------ clusters

const nextId = (list, prefix) => {
  let n = 0
  for (const x of list) { const m = new RegExp(`^${prefix}(\\d+)$`).exec(String(x.id)); if (m) n = Math.max(n, Number(m[1])) }
  return `${prefix}${n + 1}`
}

export const sizeOf = (store, id) => store.claims.filter(c => c.cluster === id).length

/** The cluster a claim names: a cluster's id, else a cluster's name (any case), else a new cluster of that name. An
 *  empty name puts it between clusters (null). */
export function clusterFor(store, ref, turn = null) {
  const raw = str(String(ref ?? '').replace(/^new\s*:\s*/i, ''), 60)
  if (!raw) return null
  const byId = store.clusters.find(c => c.id === raw)
  if (byId) return byId.id
  const byName = store.clusters.find(c => String(c.name).toLowerCase() === raw.toLowerCase())
  if (byName) return byName.id
  const id = nextId(store.clusters, 'k')
  store.clusters.push({ id, name: raw, turn, named: 0 })
  return id
}

/** The clusters grown enough since they were named that the lens may rename or split them: {id, name, from, to}. */
export function grownClusters(store) {
  const out = []
  for (const c of store.clusters) {
    const n = sizeOf(store, c.id)
    const named = Math.max(1, Number(c.named) || 1)
    if (n >= GROWN.least && n >= named * GROWN.factor) out.push({ id: c.id, name: c.name, from: named, to: n })
  }
  return out
}

/** The lens's renames and splits: {id, name} renames a cluster; {split, name, claims} moves those claims of the split
 *  cluster to a new cluster of that name. A cluster offered as grown is counted as named at its size now. */
function applyClusters(store, list, grown, turn) {
  const done = []
  for (const x of Array.isArray(list) ? list : []) {
    if (!x || typeof x !== 'object') continue
    if (x.split) {
      const from = store.clusters.find(c => c.id === String(x.split))
      const name = str(x.name, 60)
      const ids = new Set((Array.isArray(x.claims) ? x.claims : []).map(String))
      const moving = store.claims.filter(c => from && c.cluster === from.id && ids.has(c.id))
      if (!from || !name || !moving.length || moving.length === sizeOf(store, from.id)) continue
      const id = nextId(store.clusters, 'k')
      store.clusters.push({ id, name, turn, named: moving.length, split: from.id })
      for (const c of moving) c.cluster = id
      done.push({ split: from.id, into: id, name, claims: moving.map(c => c.id) })
    } else if (x.id) {
      const c = store.clusters.find(k => k.id === String(x.id))
      const name = str(x.name, 60)
      if (!c || !name || name === c.name) continue
      done.push({ renamed: c.id, from: c.name, to: name })
      c.name = name
    }
  }
  for (const g of grown || []) {
    const c = store.clusters.find(k => k.id === g.id)
    if (c) c.named = sizeOf(store, c.id)
  }
  return done
}

// ------------------------------------------------------------------------------------------------ one turn

const capital = t => (t ? t[0].toUpperCase() + t.slice(1) : t)

/** The lens's claims, held to what the store needs; anything else is dropped. */
/** How one claim bears on another, as the lens names it: supports, contradicts or same topic, or
 *  null. */
export function howOf(v) {
  const s = String(v ?? '').toLowerCase()
  if (/contra|conflict|disagree/.test(s)) return 'contradicts'
  if (/support|back|show|explain/.test(s)) return 'supports'
  if (/topic|same|about|relat/.test(s)) return 'same topic'
  return null
}

export function parseClaims(list) {
  const out = []
  for (const [i, x] of (Array.isArray(list) ? list : []).entries()) {
    if (!x || typeof x !== 'object') continue
    const quote = str(x.quote, 400)
    const by = String(x.by || '').toLowerCase().startsWith('person') || /^(you|analyst|the analyst)$/.test(String(x.by || '').toLowerCase()) ? 'person' : 'claude'
    const same = str(String(x.same ?? ''), 20)
    // a new claim with no "claim" of its own is named by the words that said it
    const own = str(x.claim ?? x.text, MAX_TEXT)
    const text = own || (same ? '' : capital(plainOf(quote).plain.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)))
    if (!quote || (!same && !text)) continue
    // `at`: its place in the lens's list (1 for the first), which a later claim of the same turn revises as "#1"
    const links = (Array.isArray(x.links) ? x.links : []).map(l => ({ to: str(String(l?.to ?? ''), 20), how: howOf(l?.how ?? l?.type) })).filter(l => l.to && l.how).slice(0, 4)
    const revises = str(String(x.revises ?? ''), 20) || null
    out.push({ at: i + 1, text, quote, by, cluster: x.cluster == null ? '' : String(x.cluster), same: same || null, revises, why: (revises && str(x.why, MAX_WHY)) || null, links })
  }
  // every claim the turn gave: a long answer can state many
  return out
}

const samePlace = (a, b) => a.row === b.row && a.start < b.end && b.start < a.end
const liveClaim = c => !c.revised_by

/** A claim the text repeats almost word for word (code's own dedupe, beside the lens's `same`), or null. */
export function restates(store, text, skip = new Set()) {
  let best = null
  for (const c of store.claims) {
    if (skip.has(c.id) || !liveClaim(c)) continue
    const l = likeness(c.text, text)
    if (l >= 0.85 && (!best || l > best.l)) best = { c, l }
  }
  return best ? best.c : null
}

/**
 * One turn's claims into the store (changed in place, and returned). `places` are the turn's messages, each
 * {row, by, turn, text}; `out` is the lens's {claims, clusters}; `grown` the clusters the lens was offered to rename
 * or split. Returns {store, added, restated, revised, dropped, clusters}.
 */
export function applyTurn(store, { places = [], out = {}, turn = null, at = null, grown = [] } = {}) {
  const res = { store, added: [], restated: [], revised: [], dropped: [], clusters: [] }
  const items = parseClaims(out?.claims)
  const local = new Map()
  const links = []
  for (const it of items) {
    // #N: the Nth claim of this same list, which has no id yet
    if (it.revises && /^#\d+$/.test(it.revises)) it.revises = local.get(Number(it.revises.slice(1))) || null
    if (it.same && /^#\d+$/.test(it.same)) it.same = local.get(Number(it.same.slice(1))) || null
    const known = it.same ? store.claims.find(c => c.id === it.same) : null
    const where = locate(it.quote, places, it.by, it.text || known?.text || '')
    if (!where) { res.dropped.push({ claim: it.text || it.same, why: `its words "${cutTo(it.quote, 60)}" are not in this turn's messages` }); continue }
    let target = it.same && !it.revises ? known : null
    if (it.same && !it.revises && !target && !it.text) { res.dropped.push({ claim: it.same, why: `no claim ${it.same} so far` }); continue }
    if (!target && !it.revises && it.text) target = restates(store, it.text, new Set(res.added))
    if (!target && it.text) {
      // a second item of this turn at the same place, almost the same words: one claim
      const twin = res.added.map(id => store.claims.find(c => c.id === id)).find(c => c && c.said.some(p => samePlace(p, where.place)) && likeness(c.text, it.text) >= 0.6)
      if (twin) continue
    }
    if (target) {
      local.set(it.at, target.id)
      for (const l of it.links) links.push({ from: target.id, ...l })
      if (!target.said.some(p => samePlace(p, where.place))) {
        target.said.push(where.place)
        addSources(target, where.sources)
        if (!res.restated.includes(target.id) && !res.added.includes(target.id)) res.restated.push(target.id)
      }
      continue
    }
    const id = nextId(store.claims, 'c')
    const claim = { id, text: it.text, by: it.by, cluster: clusterFor(store, it.cluster, turn), turn, at, said: [where.place], sources: where.sources }
    const old = it.revises ? store.claims.find(c => c.id === it.revises) : null
    if (old) {
      claim.revises = old.id
      if (it.why) claim.why = it.why
      old.revised_by = id
      res.revised.push(old.id)
      if (!claim.cluster) claim.cluster = old.cluster ?? null
    }
    store.claims.push(claim)
    res.added.push(id)
    local.set(it.at, id)
    for (const l of it.links) links.push({ from: id, ...l })
  }
  // the links each claim names to another (an id so far, or #N of this turn), kept on the claim that names them
  res.linked = 0
  for (const l of links) {
    const to = /^#\d+$/.test(l.to) ? local.get(Number(l.to.slice(1))) : l.to
    const a = store.claims.find(c => c.id === l.from)
    if (!a || !to || to === a.id || !store.claims.some(c => c.id === to)) continue
    a.links = [...(a.links || []).filter(x => x.to !== to), { to, how: l.how }].slice(-6)
    res.linked++
  }
  res.clusters = applyClusters(store, out?.clusters, grown, turn)
  oneNameOneCluster(store)
  for (const c of store.clusters) if (!c.named) c.named = Math.max(1, sizeOf(store, c.id))
  store.updated = at || store.updated
  return res
}

/** A turn the observer could not read (its call failed): said in the store, so the pane says it. */
export function noteGap(store, turn, why) {
  if (turn == null) return store
  store.gaps = [...(store.gaps || []).filter(g => g.turn !== turn), { turn, why: str(why, 160) }].slice(-20)
  return store
}

/** A turn that was read after all: its gap goes. */
export function clearGap(store, turn) {
  if (turn != null && Array.isArray(store.gaps)) store.gaps = store.gaps.filter(g => g.turn !== turn)
  return store
}

/** The note c lights with for one turn, or '' to stay dim: only a correction lights it. New claims alone light nothing:
 *  c's count in the bar says they came. The bar draws it after the count: `c ● 12 claims, 1 corrected`. */
export function noteFor(res) {
  const fixed = res?.revised?.length || 0
  if (fixed) return `${fixed} corrected`
  return ''
}

// ------------------------------------------------------------------------------------------------ what the lens reads

/** The claims so far and the clusters, as the lens reads them: one line each, newest last, at most `max` claims. */
export function promptLines(store, max = 120) {
  const claims = store.claims.slice(-max)
  const lines = claims.map(c => {
    const flags = [c.by === 'person' ? 'the analyst' : '', c.revised_by ? `corrected by ${c.revised_by}` : '', c.said.length > 1 ? `×${c.said.length}` : ''].filter(Boolean)
    return `- ${c.id} · ${c.cluster || '-'} · ${c.text}${flags.length ? ` (${flags.join(', ')})` : ''}`
  })
  const clusters = store.clusters.filter(k => sizeOf(store, k.id)).map(k => `- ${k.id} · ${k.name} · ${sizeOf(store, k.id)} claim${sizeOf(store, k.id) === 1 ? '' : 's'}`)
  return {
    claims: lines.length ? (store.claims.length > claims.length ? `(${store.claims.length - claims.length} older claims not shown)\n` : '') + lines.join('\n') : '(none yet)',
    clusters: clusters.length ? clusters.join('\n') : '(none yet)',
  }
}

/** The grown clusters, as the lens reads them, or '' with none. */
export function grownLines(grown) {
  if (!grown || !grown.length) return ''
  return grown.map(g => `Cluster ${g.id} "${g.name}" grew from ${g.from} to ${g.to} claims since it was named.`).join('\n')
}

// ------------------------------------------------------------------------------------------------ the view

/**
 * The store as the pane shows it: the clusters in the order their work began, each with its claims in the order said, and the claims between clusters last. Each claim carries `n` (×N).
 */
export function viewOf(store) {
  const groups = store.clusters.map(k => ({ ...k, claims: store.claims.filter(c => c.cluster === k.id) })).filter(g => g.claims.length)
  const rank = g => g.turn ?? Math.min(...g.claims.map(c => c.turn ?? 0))
  groups.sort((a, b) => rank(a) - rank(b) || String(a.id).localeCompare(String(b.id), 'en', { numeric: true }))
  const loose = store.claims.filter(c => !c.cluster || !store.clusters.some(k => k.id === c.cluster))
  if (loose.length) groups.push({ id: null, name: 'between clusters', claims: loose })
  const flat = []
  for (const g of groups) {
    g.claims = g.claims.map(c => ({ ...c, n: c.said.length }))
    for (const c of g.claims) flat.push(c)
  }
  const turns = store.claims.map(c => c.turn).filter(t => typeof t === 'number')
  return { groups, flat, total: store.claims.length, clusters: groups.filter(g => g.id).length, last: turns.length ? Math.max(...turns) : null, gaps: store.gaps || [] }
}

/**
 * The graph's edges: a correction (the claim that corrects to the one it corrects), a link one claim names to another
 * (supports, contradicts, same topic), and two claims that cite the same place of a file (each later claim citing it to
 * the first claim that cited it, so a place many claims cite draws a star, not every pair). A source's place is the
 * `path:line` its check's evidence showed (`place`, which the pane adds), else its ref. One edge per pair, in that order
 * of kinds. [{a, b, kind: 'corrects' | 'relates' | 'rows', ref?, how?}]
 */
export function edgesOf(flat) {
  const ids = new Set(flat.map(c => c.id))
  const out = []
  const seen = new Set()
  const add = (a, b, kind, ref, how) => {
    if (!ids.has(a) || !ids.has(b) || a === b) return
    const key = [a, b].sort().join('|')
    if (seen.has(key)) return
    seen.add(key)
    out.push({ a, b, kind, ...(ref ? { ref } : {}), ...(how ? { how } : {}) })
  }
  for (const c of flat) if (c.revises) add(c.id, c.revises, 'corrects')
  for (const c of flat) for (const l of c.links || []) add(c.id, l.to, 'relates', null, l.how)
  // the same place of a file: what the citations' evidence showed, else the source's ref
  const first = new Map()
  for (const c of flat) {
    for (const s of c.sources || []) {
      const key = String(s.place || s.ref)
      if (!first.has(key)) first.set(key, c.id)
      else add(c.id, first.get(key), 'rows', s.ref)
    }
  }
  return out
}
