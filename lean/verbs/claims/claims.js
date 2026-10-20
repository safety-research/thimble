// claims.js: the session's Claims store, as pure functions. No `$`, no Node, no DOM: the observer (in the hooks
// module), the `thimble verb claims` CLI, the browser page and the tests all import it.
//
// The store is one JSON file per session, thimble/claims/<session>.json (CONTRACT 7):
//
//   {v: 1, session, updated,
//    claims: [{id, text, kind, by, cluster, turn, said: [place], sources: [{ref, label}], revises?, revised_by?,
//              precisely?, based_on?, judgment?, unstated?}],
//    clusters: [{id, name, turn, named, from?}],
//    gaps: [{turn, why}]}
//
//   a place  {row, by, turn, quote, sentence, start, end}   where a claim was said: the message row, who said it
//            (claude | person), the words matched and their sentence, as offsets into the row's markdown. A claim
//            from the corpus orientation has {by: 'orientation', at} and its evidence as sources.
//   ×N       a claim's said.length: each distinct place it was said.
//   what it means (the fork gives it with the claim, so pointing at a claim costs nothing):
//            precisely  the claim restated so it can be checked: the quantity, what it is counted out of, the window,
//                       how it was measured
//            based_on   the evidence in a few words: source · scope · rows
//            judgment   only when a word of the claim is Claude's reading, not a measurement: that word and why
//            unstated   only when `precisely` needs a denominator or a window Claude did not state: what is missing
//
// After a turn of work the observer's one fork lists the turn's claims ({claim, quote, by, kind, cluster, same,
// revises, precisely, based_on, judgment, unstated}); applyTurn places each by its quote in the turn's messages, takes the citations in or near its sentence
// as its sources, merges a restatement into the claim it repeats (a new place, so ×N grows), links a correction both
// ways (revises / revised_by), and puts each new claim in a cluster: one named so far, or a new one.
import { blocks, linkMarks } from '../../shell/message.js'

export const KINDS = [
  { id: 'fact', name: 'fact' },
  { id: 'finding', name: 'finding' },
  { id: 'judgment', name: 'judgment call' },
  { id: 'event', name: 'event' },
  { id: 'claim', name: 'claim' },
]
const MAX_TEXT = 200
const MAX_QUOTE = 240
const MAX_SENTENCE = 320
/** A cluster grown this much since it was named is offered to the fork to rename or split. */
export const GROWN = { least: 6, factor: 2 }

const str = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '')
const cutTo = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…')

/** A kind as one of the five ids ("judgment call" reads as judgment); claim when it is none of them. */
export function kindOf(k) {
  const s = String(k == null ? '' : k).toLowerCase().trim()
  if (s.startsWith('judg') || s === 'decision') return 'judgment'
  return KINDS.some(x => x.id === s) ? s : 'claim'
}

export const kindName = k => (KINDS.find(x => x.id === kindOf(k)) || KINDS[4]).name

/** A new, empty store for a session. */
export function emptyStore(session = '') {
  return { v: 1, session: String(session || ''), updated: null, claims: [], clusters: [], gaps: [] }
}

/** A store read from its file's text (or parsed JSON): whatever holds is kept, the rest starts empty. */
export function readStore(text, session = '') {
  let d = text
  if (typeof text === 'string') {
    try { d = JSON.parse(text) } catch { d = null }
  }
  const s = emptyStore(session || d?.session)
  if (!d || typeof d !== 'object') return s
  s.updated = d.updated || null
  s.claims = (Array.isArray(d.claims) ? d.claims : []).filter(c => c && c.id && c.text).map(c => ({ ...c, said: Array.isArray(c.said) ? c.said : [], sources: (Array.isArray(c.sources) ? c.sources : []).map(sourceOf).filter(Boolean) }))
  s.clusters = (Array.isArray(d.clusters) ? d.clusters : []).filter(c => c && c.id)
  s.gaps = Array.isArray(d.gaps) ? d.gaps : []
  for (const [k, v] of Object.entries(d)) if (!(k in s)) s[k] = v
  return s
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
      const m = /^\[([^\]\n]+)\]\(([^)\n]+)\)/.exec(s.slice(i))
      if (m) {
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

const FOLD = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '−': '-', ' ': ' ', '…': '...' }

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

/** How much of claim a's words claim b holds, and b of a: their overlap over the smaller set (0..1). */
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
  const links = [...s.matchAll(/\[[^\]\n]+\]\([^)\n]+\)/g)].map(m => [m.index, m.index + m[0].length])
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
  if (b > a && b <= s.length && stop(b - 1)) {
    // the match already ends its sentence
  } else {
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
  // the sentence that holds most of its words
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
    // the sentence's words, without a list item's marker or a quote's
    let from = sent.start
    const lead = /^(\s|[-*+>#]\s?|\d{1,3}[.)]\s)+/.exec(s.slice(from, end))
    if (lead) from += lead[0].length
    if (n >= 3 && score >= 0.6 && (!best || score > best.score)) best = { start: from, end, score }
    at = end
  }
  return best ? { start: best.start, end: best.end, exact: false } : null
}

const numbersIn = t => new Set((String(t || '').match(/\d[\d,.]*/g) || []).map(x => x.replace(/[,.]+$/, '').replace(/,/g, '')))

/** The citations in or near [start, end): those in its sentence; with none there, those of its block (a paragraph, a
 *  list item, a table row) whose words hold a number the claim states (`text`), so a sentence with no citation of its
 *  own borrows only one that shows the same value. At most four, each {ref, label}: the ref as written and its words. */
export function sourcesNear(md, start, end, text = '') {
  const s = String(md || '')
  const marks = linkMarks(s)
  if (!marks.length) return []
  const sent = sentenceAt(s, start, end)
  let got = marks.filter(m => m.start >= sent.start && m.end <= Math.max(sent.end, end))
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
  for (const m of got) if (m.ref && !out.some(x => x.ref === m.ref)) out.push({ ref: m.ref, label: m.kind === 'spark' ? `~ ${m.ref}` : String(m.label || m.ref) })
  return out.slice(0, 4)
}

/** Sources as {ref, label}: a bare ref (an older store, an orientation's evidence) is read as its own label. */
export const sourceOf = x => (typeof x === 'string' ? { ref: x, label: shortRef(x) } : x && typeof x.ref === 'string' ? { ref: x.ref, label: x.label || shortRef(x.ref), ...(Array.isArray(x.values) ? { values: x.values } : {}) } : null)

/** A ref as a person reads it: a row as `file:line`, a query value as `r3 · day=… · n`. */
export function shortRef(ref) {
  const r = String(ref || '')
  const m = /^([qr]\d+)(?:#(.*))?$/.exec(r)
  if (m) {
    const [frag, col] = String(m[2] || '').split('@')
    let words = frag || ''
    try { words = decodeURIComponent(words) } catch { /* as written */ }
    return [m[1], words.replace(/&/g, ' '), col].filter(Boolean).join(' · ')
  }
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
  // read as a whole, so a range that ends inside a link's words still reads as words
  const p = plainOf(md)
  let out = ''
  for (let i = 0; i < p.plain.length; i++) if (p.at[i] >= start && p.at[i] < end) out += p.plain[i]
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * Where a claim was said: its quote found in one of the turn's places (the person's message for `by: person`, else
 * Claude's messages, newest first; then any). A place is {row, by, turn, text, sparks?: {ref: values}}; returns the place as the store keeps
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
    // a sparkline's values come along with its source, so the views draw it with no lookup
    const sources = sourcesNear(p.text, hit.start, hit.end, text).map(s => (p.sparks && Array.isArray(p.sparks[s.ref]) ? { ...s, values: p.sparks[s.ref] } : s))
    return {
      place: {
        row: p.row, by: p.by || 'claude', turn: p.turn ?? null,
        quote: cutTo(wordsIn(p.text, hit.start, hit.end), MAX_QUOTE),
        sentence: cutTo(wordsIn(p.text, sent.start, sent.end), MAX_SENTENCE),
        start: hit.start, end: hit.end,
      },
      sources,
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

/** The clusters grown enough since they were named that the fork may rename or split them: {id, name, from, to}. */
export function grownClusters(store) {
  const out = []
  for (const c of store.clusters) {
    if (c.from === 'orientation') continue
    const n = sizeOf(store, c.id)
    const named = Math.max(1, Number(c.named) || 1)
    if (n >= GROWN.least && n >= named * GROWN.factor) out.push({ id: c.id, name: c.name, from: named, to: n })
  }
  return out
}

/** The fork's renames and splits: {id, name} renames a cluster; {split, name, claims} moves those claims of the
 *  split cluster to a new cluster of that name. A cluster offered as grown is counted as named at its size now. */
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

/** What a claim means, as the fork gave it: each part a short line of plain words, or left out. */
export const MEANING = { precisely: 240, based_on: 140, judgment: 160, unstated: 160 }
export function meaningOf(x) {
  const out = {}
  for (const [k, n] of Object.entries(MEANING)) {
    const v = str(x?.[k] ?? (k === 'based_on' ? x?.basedOn : undefined), n).trim()
    if (v && !/^(none|n\/a|-|null)$/i.test(v)) out[k] = v
  }
  return out
}

/** The fork's claims, held to what the store needs; anything else is dropped. */
export function parseClaims(list) {
  const out = []
  for (const [i, x] of (Array.isArray(list) ? list : []).entries()) {
    if (!x || typeof x !== 'object') continue
    const quote = str(x.quote, 400)
    // the lens may name the user "analyst" or "person" (its earlier versions); the store keeps 'person' either way
    const who = String(x.by || '').toLowerCase()
    const by = who.startsWith('person') || who.startsWith('analyst') || who === 'you' ? 'person' : 'claude'
    const same = str(String(x.same ?? ''), 20)
    // a new claim with no "claim" of its own is named by the words that said it (lens-claims v2 gives "claim" only when
    // the quote does not say the claim by itself)
    const own = str(x.claim ?? x.text, MAX_TEXT)
    const text = own || (same ? '' : capital(plainOf(quote).plain.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)))
    if (!quote || (!same && !text)) continue
    // `at`: its place in the fork's list (1 for the first), which a later claim of the same turn revises as "#1"
    out.push({ at: i + 1, text, quote, by, kind: kindOf(x.kind), cluster: x.cluster == null ? '' : String(x.cluster), same: same || null, revises: str(String(x.revises ?? ''), 20) || null, meaning: meaningOf(x) })
  }
  return out.slice(0, 40)
}

const capital = t => (t ? t[0].toUpperCase() + t.slice(1) : t)

const samePlace = (a, b) => a.row === b.row && a.start < b.end && b.start < a.end
const liveClaim = c => !c.revised_by

/** A claim the text repeats almost word for word (code's own dedupe, beside the fork's `same`), or null. */
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
 * {row, by, turn, text}; `out` is the fork's {claims, clusters}; `grown` the clusters the fork was offered to rename
 * or split. Returns {store, added, restated, revised, unstated, dropped, clusters}: the ids of new claims, of claims
 * said again, of claims a new one corrects, of new claims whose denominator or window was not stated, and why each
 * dropped one was dropped.
 */
export function applyTurn(store, { places = [], out = {}, turn = null, at = null, grown = [] } = {}) {
  const res = { store, added: [], restated: [], revised: [], dropped: [], clusters: [] }
  const items = parseClaims(out?.claims)
  // this turn's claims by their place in the fork's list: a claim the person states and Claude corrects in the same
  // turn is revised as "#N"
  const local = new Map()
  for (const it of items) {
    if (it.revises && /^#\d+$/.test(it.revises)) it.revises = local.get(Number(it.revises.slice(1))) || null
    const known = it.same ? store.claims.find(c => c.id === it.same) : null
    const where = locate(it.quote, places, it.by, it.text || known?.text || '')
    if (!where) { res.dropped.push({ claim: it.text || it.same, why: `its words "${cutTo(it.quote, 60)}" are not in this turn's messages` }); continue }
    let target = it.same && !it.revises ? store.claims.find(c => c.id === it.same) : null
    if (it.same && !it.revises && !target && !it.text) { res.dropped.push({ claim: it.same, why: `no claim ${it.same} so far` }); continue }
    // code's own dedupe: a new claim that repeats one so far almost word for word is the same claim
    if (!target && !it.revises && it.text) target = restates(store, it.text, new Set(res.added))
    if (!target && it.text) {
      // a second item of this turn at the same place, almost the same words: one claim
      const twin = res.added.map(id => store.claims.find(c => c.id === id)).find(c => c && c.said.some(p => samePlace(p, where.place)) && likeness(c.text, it.text) >= 0.6)
      if (twin) continue
    }
    if (target) {
      local.set(it.at, target.id)
      // a restatement can say what the claim means when the first saying did not
      for (const [k, v] of Object.entries(it.meaning)) if (!target[k]) target[k] = v
      if (!target.said.some(p => samePlace(p, where.place))) {
        target.said.push(where.place)
        addSources(target, where.sources)
        if (!res.restated.includes(target.id) && !res.added.includes(target.id)) res.restated.push(target.id)
      }
      continue
    }
    const id = nextId(store.claims, 'c')
    const claim = { id, text: it.text, kind: it.kind, by: it.by, cluster: clusterFor(store, it.cluster, turn), turn, at, said: [where.place], sources: where.sources, ...it.meaning }
    const old = it.revises ? store.claims.find(c => c.id === it.revises) : null
    if (old) {
      claim.revises = old.id
      old.revised_by = id
      res.revised.push(old.id)
      // a correction with no cluster of its own stays beside what it corrects
      if (!claim.cluster) claim.cluster = old.cluster ?? null
    }
    store.claims.push(claim)
    res.added.push(id)
    local.set(it.at, id)
  }
  res.unstated = res.added.filter(id => store.claims.find(c => c.id === id)?.unstated)
  res.clusters = applyClusters(store, out?.clusters, grown, turn)
  // a cluster named this turn counts its first claims as named
  for (const c of store.clusters) if (!c.named) c.named = Math.max(1, sizeOf(store, c.id))
  store.updated = at || store.updated
  return res
}

/** A turn the observer could not read (its call failed): said in the store, so the list says it. `again`: the
 *  observer kept what it needs to read the turn again. */
export function noteGap(store, turn, why, again = false) {
  if (turn == null) return store
  store.gaps = [...(store.gaps || []).filter(g => g.turn !== turn), { turn, why: str(why, 160), ...(again ? { again: true } : {}) }].slice(-20)
  return store
}

/** A turn that was read after all: its gap goes. */
export function clearGap(store, turn) {
  if (turn != null && Array.isArray(store.gaps)) store.gaps = store.gaps.filter(g => g.turn !== turn)
  return store
}

/** The note `c` lights with for one turn: what the new claims leave open first ("2 claims need a denominator": their
 *  denominator or window was not stated), else "3 new claims", or '' when nothing new came. A revision is a new claim
 *  too: the graph shows the claim it replaced as a hollow dot, and nothing more says so. */
export function noteFor(res) {
  const n = res?.added?.length || 0
  const open = res?.unstated?.length || 0
  if (open) return `${open} claim${open === 1 ? ' needs' : 's need'} a denominator`
  return n ? `${n} new claim${n === 1 ? '' : 's'}` : ''
}

/** Whether a kind reads as a fact (what the setup or the data shows) or an interpretation (a reading or an assertion):
 *  the tag the views show beside a claim. */
export const tagOf = kind => (['fact', 'finding', 'event'].includes(kindOf(kind)) ? 'fact' : 'interp')

// ------------------------------------------------------------------------------------------------ what the fork reads

/** The claims so far and the clusters, as the fork reads them: one line each, newest last, at most `max` claims. */
export function promptLines(store, max = 120) {
  const claims = store.claims.slice(-max)
  const lines = claims.map(c => {
    const flags = [c.by === 'person' ? 'the analyst' : c.by === 'orientation' ? 'orientation' : '', c.revised_by ? `revised by ${c.revised_by}` : '', c.said.length > 1 ? `×${c.said.length}` : ''].filter(Boolean)
    return `- ${c.id} · ${c.cluster || '-'} · ${c.text}${flags.length ? ` (${flags.join(', ')})` : ''}`
  })
  const clusters = store.clusters.filter(k => sizeOf(store, k.id)).map(k => `- ${k.id} · ${k.name} · ${sizeOf(store, k.id)} claim${sizeOf(store, k.id) === 1 ? '' : 's'}${k.from === 'orientation' ? ' (orientation)' : ''}`)
  return {
    claims: lines.length ? (store.claims.length > claims.length ? `(${store.claims.length - claims.length} older claims not shown)\n` : '') + lines.join('\n') : '(none yet)',
    clusters: clusters.length ? clusters.join('\n') : '(none yet)',
  }
}

/**
 * The claims so far that bear on this turn, as the fork reads them: every claim while the store is small; once it is
 * long, the claims that share at least two words with the turn's words (a number counts twice) and the latest few, so
 * the digest stays about the same size as a session grows. Returns {claims, clusters, left}: `left` is how many were
 * left out.
 */
export function nearLines(store, text, { all = 24, latest = 8, max = 40 } = {}) {
  const list = store.claims
  if (list.length <= all) return { ...promptLines(store, max + all), left: 0 }
  const turn = new Set(wordsOf(text))
  const score = c => {
    let n = 0
    for (const w of new Set(wordsOf(c.text))) if (turn.has(w)) n += /\d/.test(w) ? 2 : 1
    return n
  }
  const recent = new Set(list.slice(-latest).map(c => c.id))
  const near = list.map(c => ({ c, n: score(c) })).filter(x => recent.has(x.c.id) || x.n >= 2)
  const keep = new Set(near.sort((a, b) => b.n - a.n).slice(0, max).map(x => x.c.id))
  const sub = { ...store, claims: list.filter(c => keep.has(c.id)) }
  const lines = promptLines(sub, max)
  return { claims: lines.claims, clusters: promptLines(store).clusters, left: list.length - sub.claims.length }
}

/**
 * A claim's "based on", in words, from the rows behind the citation in its sentence (`thimble resolve <ref> --json`): the
 * files, the group the value is of (the ref's key, as words) and how many rows stand behind it, such as
 * "revisions.jsonl, phase 3 Jun18 · 6,543 rows". Null when the rows say nothing a person can read.
 */
export function basedOnFrom(ref, resolved) {
  if (!resolved || typeof resolved !== 'object') return null
  const files = []
  for (const r of Array.isArray(resolved.rows) ? resolved.rows : []) {
    const f = String(r).split('#')[0].split('/').pop()
    if (f && !files.includes(f)) files.push(f)
  }
  if (!files.length) return null
  const m = /^[qr]\d+(?:#([^@]*))?(?:@.*)?$/.exec(String(ref || ''))
  let key = ''
  if (m && m[1]) {
    try { key = decodeURIComponent(m[1]) } catch { key = m[1] }
    key = key.split('&').map(kv => kv.replace('=', ' ')).join(', ')
  } else if (!m) {
    const line = /#L(\d+)/.exec(String(ref || ''))
    if (line) key = `line ${line[1]}`
  }
  const n = Number(resolved.count)
  const count = Number.isFinite(n) && n > 0 ? `${n.toLocaleString('en-US')} row${n === 1 ? '' : 's'}` : ''
  const head = files.length > 2 ? `${files.slice(0, 2).join(', ')} and ${files.length - 2} more` : files.join(', ')
  return str([[head, key].filter(Boolean).join(', '), count].filter(Boolean).join(' · '), MEANING.based_on) || null
}

const CLAIMY = /\d|\]\(|\b(all|every|most|none|never|always|only|no one|nobody|more|less|fewer|than|because|caused?|due to|led to|drove|drives|so that|therefore|biased?|typical|usually|rarely|often|increase[ds]?|decrease[ds]?|rose|fell|grew|dropped|same|different|wrong|right|true|false|correct)\b/i

/** Whether a turn's words state nothing that could be true or false: no number, no citation, no cause, no comparison and
 *  no "all" or "most" (a turn of greetings, questions or plans). The claims lens is told to give none then. */
export function claimless(text) {
  return !CLAIMY.test(String(text || ''))
}

/** The grown clusters, as the fork reads them: what to do with each, or '' with none. */
export function grownLines(grown) {
  if (!grown || !grown.length) return ''
  return grown.map(g => `Cluster ${g.id} "${g.name}" grew from ${g.from} to ${g.to} claims since it was named.`).join('\n')
}

// ------------------------------------------------------------------------------------------------ the corpus orientation

/**
 * An orientation's claims (the atlas JSON the subagent wrote: {clusters, claims: [{id, name, kind, cluster, evidence}]})
 * into the store, each marked `by: orientation`, its evidence refs as its sources and its quotes as where it was said
 * in the corpus. Its clusters come along, marked as the orientation's. A claim already in the store word for word is
 * said again, not added. Returns {store, added, restated}.
 */
export function mergeOrientation(store, data, { at = null, turn = null } = {}) {
  const d = data && data.data && Array.isArray(data.data.claims) ? data.data : data || {}
  const res = { store, added: [], restated: [] }
  const ids = new Map()
  for (const k of Array.isArray(d.clusters) ? d.clusters : []) {
    if (!k || k.id == null) continue
    const name = str(k.name || String(k.id), 60)
    let c = store.clusters.find(x => x.from === 'orientation' && String(x.name).toLowerCase() === name.toLowerCase())
    if (!c) {
      c = { id: nextId(store.clusters, 'k'), name, turn, named: 0, from: 'orientation' }
      store.clusters.push(c)
    }
    ids.set(String(k.id), c.id)
  }
  for (const x of Array.isArray(d.claims) ? d.claims : []) {
    const text = str(x?.name ?? x?.text, MAX_TEXT)
    if (!text) continue
    const ev = (Array.isArray(x.evidence) ? x.evidence : []).map(e => (typeof e === 'string' ? { ref: e } : e)).filter(e => e && typeof e.ref === 'string')
    const place = { by: 'orientation', turn, at, quote: cutTo(str(ev.find(e => e.quote)?.quote, MAX_QUOTE), MAX_QUOTE), sentence: '', ref: ev[0]?.ref || null }
    const same = restates(store, text)
    if (same) {
      if (!same.said.some(p => p.by === 'orientation')) { same.said.push(place); res.restated.push(same.id) }
      addSources(same, ev.map(e => ({ ref: e.ref, label: shortRef(e.ref) })))
      continue
    }
    const id = nextId(store.claims, 'c')
    const claim = { id, text, kind: kindOf(x.kind), by: 'orientation', cluster: ids.get(String(x.cluster)) ?? null, turn, at, said: [place], sources: ev.slice(0, 6).map(e => ({ ref: e.ref, label: shortRef(e.ref) })) }
    if (typeof x.n === 'number') claim.n = x.n
    if (typeof x.of === 'number') claim.of = x.of
    store.claims.push(claim)
    res.added.push(id)
  }
  for (const c of store.clusters) if (!c.named) c.named = Math.max(1, sizeOf(store, c.id))
  store.orientation = { at, turn, claims: res.added.length, clusters: ids.size }
  store.updated = at || store.updated
  return res
}

// ------------------------------------------------------------------------------------------------ the view

/**
 * The store as the views list it: the clusters in the order their work began (the session's first, the orientation's
 * after), each with its claims in the order said, and the claims between clusters last. `fresh` holds the ids to mark
 * as new (a message's own). Each claim carries `n` (×N), `replacement` (the claim that revised it) and `order` (its
 * place in the flat list).
 */
export function viewOf(store, { fresh = [] } = {}) {
  const isNew = new Set(fresh)
  const byId = new Map(store.claims.map(c => [c.id, c]))
  const groups = store.clusters.map(k => ({ ...k, claims: store.claims.filter(c => c.cluster === k.id) })).filter(g => g.claims.length)
  const rank = g => (g.from === 'orientation' ? 1e6 : 0) + (g.turn ?? Math.min(...g.claims.map(c => c.turn ?? 0)))
  groups.sort((a, b) => rank(a) - rank(b) || String(a.id).localeCompare(String(b.id), 'en', { numeric: true }))
  const loose = store.claims.filter(c => !c.cluster || !store.clusters.some(k => k.id === c.cluster))
  if (loose.length) groups.push({ id: null, name: 'between clusters', claims: loose })
  const flat = []
  for (const g of groups) {
    g.claims = g.claims.map(c => ({ ...c, n: c.said.length, tag: tagOf(c.kind), fresh: isNew.has(c.id), replacement: c.revised_by ? byId.get(c.revised_by) || null : null, original: c.revises ? byId.get(c.revises) || null : null }))
    g.fresh = g.claims.filter(c => c.fresh).length
    g.revised = g.claims.filter(c => c.revised_by).length
    for (const c of g.claims) { c.order = flat.length; flat.push(c) }
  }
  const turns = store.claims.map(c => c.turn).filter(t => typeof t === 'number')
  return { groups, flat, total: store.claims.length, clusters: groups.filter(g => g.id).length, fresh: isNew.size, turns: turns.length ? [Math.min(...turns), Math.max(...turns)] : null, gaps: store.gaps || [] }
}

/**
 * The session in time: one moment per message that first said a claim (the person's prompt, Claude's messages, the
 * corpus orientation), in the order said. `order` is the session's message rows in order (its index); `final` the
 * rows that are a turn's answer. Each moment is {key, row, by, turn, what, claims: [ids first said there]}, `what`
 * being 'you', 'answer', 'working' or 'corpus'. A replay grows the graph in this order.
 */
export function timeline(store, { order = [], final = [] } = {}) {
  const pos = new Map(order.map((r, i) => [r, i]))
  const fin = new Set(final)
  const ms = new Map()
  for (const c of store.claims || []) {
    const p = (c.said || [])[0] || {}
    const corpus = c.by === 'orientation' || p.by === 'orientation'
    const key = corpus ? `corpus:${c.turn ?? ''}` : p.row ? `row:${p.row}` : `turn:${c.turn ?? ''}`
    if (!ms.has(key)) ms.set(key, { key, row: corpus ? null : p.row || null, by: corpus ? 'orientation' : p.by || c.by || 'claude', turn: c.turn ?? null, claims: [] })
    ms.get(key).claims.push(c.id)
  }
  const num = id => Number(String(id).replace(/\D/g, '')) || 0
  const rank = m => [m.turn ?? 1e9, m.by === 'orientation' ? 1e9 : m.row != null && pos.has(m.row) ? pos.get(m.row) : 1e8 + Math.min(...m.claims.map(num))]
  const list = [...ms.values()].sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1] })
  // a turn's last message of Claude's is its answer, unless the index says which is
  const lastOfTurn = new Map()
  list.forEach(m => { if (m.by === 'claude') lastOfTurn.set(m.turn, m.key) })
  for (const m of list) m.what = m.by === 'person' ? 'you' : m.by === 'orientation' ? 'corpus' : (fin.size ? fin.has(m.row) : lastOfTurn.get(m.turn) === m.key) ? 'answer' : 'working'
  return list
}

/** The claims in the order they were made (the order a replay grows them in): the timeline's moments, each one's
 *  claims in the order said. */
export const madeOrder = (store, o = {}) => timeline(store, o).flatMap(m => m.claims)

/** The claims first said in a turn (a message's new claims). */
export const claimsOfTurn = (store, turn) => store.claims.filter(c => c.turn === turn && c.by !== 'orientation').map(c => c.id)
