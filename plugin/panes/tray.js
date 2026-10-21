// tray.js: the cite & explain tray, a program on the card runtime (draw/kit.js). The terminal draws it in the band above
// the prompt and the browser at the foot of the chat, from this one file; which cards are open is its state, kept for
// both surfaces (thimble/panes/<session>/tray.json).
//
// It shows one card at a time, the top of a stack: a citation's source card or an explain card (what a term is, a
// small drawing, where it mattered here). A citation's card opens on the most readable form of what it points to (the
// cited span of a file, the query's output as a table with the cited cell marked, a series, the card with its part
// marked: shell/cards.js); what reads less easily is one key away in the same panel, a section the card names (r the
// rows behind the value, c its code, or a record as the file holds it), shown in place of the card until the same key
// or 0 closes it. A citation inside a card opens over it; back returns to the card under it, and back from the first
// card closes the tray. a asks about it: the card opens in the side panel as the mark's side thread (side.ts), the card
// at its top, the thread's conversation under it, its input bar at the bottom holding the keys. Main does not see the
// thread.
//
//   state: {stack: [frame, ...]}
//   frame: {row, i, kind, ref, label, gloss, open, heal?, why?, wrote?} for a mark of a message (frameOf; heal: what the
//          check found, kept, moved, bad, quiet or gone), {kind: 'cite', ref, label, open}
//          for a citation inside a card; `open` is the section shown. A frame carries what it shows, so a surface draws
//          it without the message's record.
//   reads: the session's side threads (whether the mark has one)
//   wants: {card: {kind, ref, label, gloss}, w, h}: the card's parts drawn by the host, each in its sandbox, as
//          {title, right, drawings: [drawing], sections: [{id, key, words, drawings}], mark: [refs], links: [{id, ref,
//          label}], problem} (cards.js drawnCard)
//   keys: a ask (the side panel on the mark, its whole source and its thread, the input bar holding the keys; a
//         citation's ↵ and 1 too, unnamed) · h the heads up (or explainer) on a citation's words, over it (a click on
//         its line too) · ↵ or e expand an explainer (a longer one in its place) · the sections' keys (r records, rows or lines, in
//         the cited files' own word, when entries stand behind it; c code)
//         · o open the first citation inside the card (the rest by a click; 2–9 still open them, unnamed) · 0 back (or
//         close; esc too): esc at the prompt never reaches a plugin, so 0 stays named · ] [ the next and the one before
//         (the host's order of marks and cards: k.do('step')), ] named while there is a next (the `steps` read), else [
//         where there is one before. Letters for what the person does, so the line reads as
//         words (`a ask · o open … · 0 close`), never as a number
//   asks of the host: thread {frame} (the side panel on this card, its input bar holding the keys), expand {frame},
//         step, close
import { threadKey } from '../shell/threads.js'

/** A label cut to `n` characters, with … where it was cut. */
const short = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s))

/** The rows a card may take in the tray: a citation's, and an explainer's, which may hold a picture beside its words. */
export const BODY = 9
export const BODY_EXPLAIN = 16

/** A mark of a message's record as a frame of the tray: what it shows, whatever surface opens it. */
export function frameOf(rec, i) {
  const m = rec && Array.isArray(rec.marks) ? rec.marks[i] : null
  if (!m) return null
  if (m.kind === 'gloss') {
    const g = (rec.glosses && rec.glosses[m.gloss]) || { term: m.label || '' }
    return { row: rec.row, i, kind: 'gloss', label: String(g.term || m.label || ''), gloss: { id: m.gloss, kind: g.kind, term: g.term, title: g.title, body: g.body, here: g.here, program: g.program, data: g.data, refs: g.refs, bullets: g.bullets, todo: g.todo, expanded: g.expanded } }
  }
  // a gloss on words inside the citation's words: a click on those words opens the citation, so its card offers the gloss
  const inner = m.kind === 'cite' ? rec.marks.map((x, j) => (x && x.kind === 'gloss' && x.start >= m.start && x.end <= m.end ? frameOf(rec, j) : null)).filter(Boolean) : []
  // what the healing pass found (message.js healedRecord): the card says it above the place
  const heal = m.kind === 'cite' && (m.heal === 'bad' || m.heal === 'quiet' || m.heal === 'gone') ? { heal: m.heal, why: String(m.why || '') }
    : m.kind === 'cite' && m.heal === 'moved' && m.wrote ? { heal: 'moved', wrote: String(m.wrote) }
      : m.kind === 'cite' && m.heal === 'kept' ? { heal: 'kept' } : {}
  return { row: rec.row, i, kind: m.kind === 'spark' ? 'spark' : 'cite', ref: m.ref, label: m.kind === 'spark' ? `sparkline · ${m.ref}` : String(m.label || m.ref || ''), ...(inner.length ? { inner } : {}), ...heal }
}

/** A part of a mark's card by its region id: its label and the refs it carries, for the side panel's thread. */
export function partOf(card, id) {
  if (!id) return null
  for (const d of (card && card.drawings) || []) {
    const r = (d.regions || []).find(x => x && x.id === id)
    if (r) {
      const meta = r.meta || {}
      const refs = [].concat(meta.ref || [], meta.refs || []).filter(x => typeof x === 'string')
      return { id, label: String(meta.label || id), refs }
    }
  }
  return /^pic-\d+$/.test(id) ? { id, label: 'the picture', refs: [] } : null
}

/** The side thread's scope for a frame: one thread per mark of a message, or per citation opened inside a card. */
export function scopeOf(f) {
  if (!f) return null
  if (f.row == null) return { mark: { kind: 'cite', ref: f.ref, label: f.label } }
  if (f.kind === 'gloss') return { row: f.row, mark: { kind: 'gloss', term: f.gloss ? f.gloss.term : f.label } }
  return { row: f.row, mark: { kind: f.kind, ref: f.ref, label: f.label } }
}

/** What the host draws for a frame (the want's card). */
export function cardRequest(f) {
  if (f.kind === 'gloss') return { kind: 'gloss', label: f.label, gloss: f.gloss || {} }
  // the message's row: a citation whose place the card finds gone is drawn gone in its message too
  return { kind: f.kind || 'cite', ref: f.ref, label: f.label, ...(f.row ? { row: f.row } : {}) }
}

/** The part of a drawing that carries one of `refs` (its region meta's `ref`), or null: a card's part a citation of
 *  one of its values names. */
export function markedPart(drawing, refs) {
  const want = new Set((Array.isArray(refs) ? refs : []).filter(x => typeof x === 'string'))
  if (!want.size || !drawing) return null
  const hit = (drawing.regions || []).find(r => [].concat(r && r.meta ? r.meta.ref : []).some(x => want.has(x)))
  return hit ? hit.id : null
}

/** Two frames the same (a citation opened twice in a row is not stacked twice). */
export const sameFrame = (a, b) => !!a && !!b && (a.row != null || b.row != null ? a.row === b.row && a.i === b.i : a.ref === b.ref)

export default {
  name: 'tray',
  title: 'cite & explain',
  reads: () => ['threads', 'steps'],
  stateKey: () => 'tray',
  data(stores) {
    const list = Array.isArray(stores.threads) ? stores.threads : []
    // a thread as the tray reads it: its key, its status, its turns (each question and answer), its error
    return {
      threads: list.map(t => ({ key: t.key || (t.scope ? threadKey(t.scope) : ''), status: t.status || '', error: t.error || '', turns: (t.turns || []).map(x => ({ role: x.role === 'user' ? 'person' : x.role, text: String(x.text || '') })) })),
      // whether ] and [ go anywhere from this mark ({next, prev}; null where the host does not say)
      steps: stores.steps && typeof stores.steps === 'object' ? stores.steps : null,
    }
  },
  program,
}

export function program(k, data) {
  const st = k.state || {}
  const stack = Array.isArray(st.stack) ? st.stack.filter(f => f && typeof f === 'object') : []
  const top = stack[stack.length - 1]
  if (!top) return k.text('')
  const heads = top.kind === 'gloss' && top.gloss && top.gloss.kind === 'heads'
  const kind = heads ? 'heads up' : top.kind === 'gloss' ? 'explain' : top.kind === 'spark' ? 'series' : 'cite'
  const tone = heads ? 'heads' : top.kind === 'gloss' ? 'explain' : 'cite'
  const inner = Math.max(20, k.w - 4)
  const card = k.want({ card: cardRequest(top), w: inner, h: top.kind === 'gloss' ? BODY_EXPLAIN : BODY })
  const key = threadKey(scopeOf(top))
  const thread = (data.threads || []).find(t => t.key === key) || null
  const links = card && Array.isArray(card.links) ? card.links.slice(0, 8) : []
  // the sections of the card (the rows behind it, its code), each a key away; the open one shows in place of the card
  const sections = card && Array.isArray(card.sections) ? card.sections.filter(s => s && s.id && typeof s.key === 'string' && s.key.length === 1) : []
  const open = sections.find(s => s.id === top.open) || null
  const withTop = patch => ({ stack: [...stack.slice(0, -1), { ...top, ...patch }] })

  // ---- what the person does
  const back = () => {
    if (open) return withTop({ open: null })
    if (stack.length > 1) return { stack: stack.slice(0, -1) }
    k.do('close')
    return { stack: [] }
  }
  const openLink = l => ({ stack: [...stack, { kind: 'cite', ref: l.ref, label: l.label }].slice(-12) })
  // a: the card in the side panel, as the mark's thread, its input bar holding the keys (the question is typed there);
  // 1, its key before, still does it, unnamed
  const toThread = () => { k.do('thread', { frame: { ...top, open: null } }) }
  // a asks about the mark, a citation or an explainer alike: it opens in the side panel, its whole source at the top
  // and its thread under it, the input bar holding the keys, so what is typed next is the question (↵ does the same
  // for a citation where it reaches the tray, but Claude Code keeps ↵ at an empty prompt). An explainer: ↵ or e
  // writes it again at more length in its place, from the turn and the files it cites (one side call)
  if (top.kind !== 'gloss') {
    k.on('a', toThread, 'ask')
    k.on('return', toThread)
  } else if (!heads && !(top.gloss && top.gloss.expanded)) {
    const longer = () => { k.do('expand', { frame: top }); return withTop({ expanding: true }) }
    k.on('return', longer, 'expand')
    k.on('e', longer, 'expand')
  }
  // a section's key opens it in place of the card, and closes it again
  sections.forEach(s => k.on(s.key, () => withTop({ open: open && open.id === s.id ? null : s.id }), s.words))
  if (top.kind === 'gloss') k.on('a', toThread, 'ask')
  k.on('1', toThread)
  // o: the first citation inside the card, over it; the others by a click, or 2–9, unnamed
  if (links.length) k.on('o', () => openLink(links[0]), `open ${short(links[0].label || links[0].ref || '', 28)}`)
  links.forEach((l, j) => k.on(String(j + 2), () => openLink(l)))
  k.on('0', back, open || stack.length > 1 ? 'back' : 'close')
  k.on('esc', back)
  // ] is named while there is a next mark or card; at the newest reply's last stop, [ is named instead, where there
  // is one before (both still work unnamed)
  const steps = data.steps || { next: true, prev: true }
  k.on(']', () => { k.do('step', { dir: 1 }) }, steps.next !== false ? 'next' : undefined)
  k.on('[', () => { k.do('step', { dir: -1 }) }, steps.next === false && steps.prev !== false ? 'previous' : undefined)
  // the gloss on the citation's words (frameOf `inner`): over the citation, as a citation inside a card opens
  const onWords = !open && Array.isArray(top.inner) ? top.inner.find(f => f && f.kind === 'gloss') : null
  const wordsHeads = !!(onWords && onWords.gloss && onWords.gloss.kind === 'heads')
  const openOnWords = () => ({ stack: [...stack, onWords].slice(-12) })
  if (onWords) k.on('h', openOnWords, wordsHeads ? 'heads up' : `explain ${short(onWords.label, 24)}`)
  k.on('press', e => {
    const l = links.find(x => x.id === e.region)
    if (l) return openLink(l)
    if (e.region === 'thread') { toThread(); return null }
    if (e.region === 'inner' && onWords) return openOnWords()
    // a part of the card (the picture an explainer draws, its parts, a row of a source): the card in the side panel,
    // that part selected, as a click on a card's part opens it elsewhere
    const part = partOf(card, e.region)
    if (part) k.do('thread', { frame: { ...top, open: null }, part })
    return null
  })

  // ---- the card
  const parts = cardBody(k, card, top, open)
  if (onWords && !(card && (card.problem || card.error))) {
    const words = wordsHeads ? String((onWords.gloss && onWords.gloss.title) || onWords.label) : onWords.label
    parts.push(k.region('inner', { label: `${wordsHeads ? 'heads up' : 'explain'} ${onWords.label}` }, k.text(`{${wordsHeads ? 'heads' : 'explain'}:${wordsHeads ? '▲ heads up' : 'explain'}} ${k.escape(words.length > 70 ? words.slice(0, 69) + '…' : words)}`, { wrap: false })))
  }
  if (top.expanding && !(top.gloss && top.gloss.expanded)) parts.push(k.text('{dim:writing a longer explanation…}'))
  if (thread && thread.turns.length && !open && card && !card.problem && !card.error) {
    const q = (thread.turns.find(t => t.role === 'person') || {}).text || ''
    parts.push(k.region('thread', { label: 'the thread about this mark' }, k.text(`{dim:↳ thread:} ${k.escape(q.length > 60 ? q.slice(0, 59) + '…' : q)} {dim:· a opens it}`, { wrap: false })))
  }
  const title = top.label.length > inner - 12 ? top.label.slice(0, Math.max(8, inner - 13)) + '…' : top.label
  // the frame's right says what the card is from (the card's own words, `cite · revisions.jsonl`), the section open,
  // and how deep the stack is
  const from = card && !card.problem && !card.error && typeof card.right === 'string' && card.right ? card.right : kind
  const right = [from, open ? open.words : '', stack.length > 1 ? String(stack.length) : ''].filter(Boolean).join(' · ')
  return k.frame(k.size(k.stack(parts), { w: inner }), { title: k.escape(title), right: k.escape(right), tone })
}

const unquote = s => { try { return decodeURIComponent(s) } catch (e) { return s } }

/** The place a ref names, in words a person reads, never the ref's own syntax: a query's row by its key (`the row with
 *  user Wren (column n)`), a card's value, or a file's line or row (`revisions.jsonl:41`, `runs.csv row 3`). */
export function placeWords(ref) {
  const r = String(ref || '').trim()
  const q = /^[qr]\d+(?:#([^@]*))?(?:@(.*))?$/.exec(r)
  if (q) {
    const col = q[2] ? ` (column ${unquote(q[2])})` : ''
    const frag = q[1] || ''
    const row = /^row=(\d+)$/.exec(frag)
    if (row) return `row ${row[1]} of a query's result${col}`
    const keys = frag.split('&').filter(x => x.indexOf('=') > 0).map(x => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)])
    if (keys.length) return `the row with ${keys.map(([key, v]) => `${unquote(key)} ${unquote(v)}`).join(' and ')}${col}`
    return q[2] ? `column ${unquote(q[2])} of a query's result` : "a query's whole result"
  }
  if (/^(?:obj|card):/.test(r)) return 'a value of another card'
  const [path, frag = ''] = r.split(/#(.*)/s)
  const lines = /^L(\d+)(?:-L?(\d+))?(?:\.b\d+)?$/.exec(frag)
  if (lines) return `${path}:${lines[1]}${lines[2] && lines[2] !== lines[1] ? `-${lines[2]}` : ''}`
  return frag ? `${path} ${frag.replace(/^row=/, 'row ')}` : path
}

/** A mark's card as the tray and the side panel draw it (panes/mark.js): a line while it is read, its problem, the
 *  section open in place of it, else its drawings with the part that holds the value marked, and why it was cited. */
export function cardBody(k, card, top, open) {
  const parts = []
  // a citation the healing pass found wrong: a red × and its reason; one whose place is gone (when the pass checked
  // it, or when its card was read later): a grey ? and what is missing; one it unwrapped: why, in grey
  const unresolved = !!(card && card.unresolved)
  if (unresolved) parts.push(k.text(`{dim:? ${k.escape(top && top.heal === 'gone' && top.why ? top.why : `the cited place is gone${card.gone ? ` (${card.gone})` : ''}`)}}`))
  else if (top && top.heal === 'bad') parts.push(k.text(`{bad:× ${k.escape(top.why || 'the cited place contradicts this value')}}`))
  else if (top && top.heal === 'gone') parts.push(k.text(`{dim:? ${k.escape(top.why || 'the cited place is gone')}}`))
  else if (top && top.heal === 'quiet' && top.why) parts.push(k.text(`{dim:${k.escape(top.why)}}`))
  // one it re-pointed: where it pointed as written, in words, so the fix is not invisible
  else if (top && top.heal === 'moved' && top.wrote) parts.push(k.text(`{dim:moved here from ${k.escape(placeWords(top.wrote))}, which does not show this value}`))
  if (!card) {
    parts.push(k.text(`{dim:${top.kind === 'gloss' ? 'drawing the explainer…' : 'reading it through the kernel…'}}`))
  } else if (card.problem || card.error) {
    parts.push(k.text(`{dim:${k.escape(String(card.problem || card.error))}}`))
  } else if (unresolved) {
    // a citation whose place is gone: the line above already says what is missing
  } else if (open) {
    if (open.problem) parts.push(k.text(`{dim:${k.escape(String(open.problem))}}`))
    ;(open.drawings || []).forEach((d, j) => {
      if (j) parts.push(k.space(1, 1))
      parts.push(k.embed(d))
    })
  } else {
    (card.drawings || []).forEach((d, j) => {
      if (j) parts.push(k.space(1, 1))
      // the picture an explainer draws is a press as a whole, its own parts inside it too
      parts.push(d && d.pic ? k.region(`pic-${j}`, { label: 'the picture' }, k.embed(d)) : k.embed(d))
    })
    // a value of a card: the card's part that holds it, marked as a selection is
    const marked = (top && top.part) || markedPart((card.drawings || [])[0], card.mark)
    if (marked) k.select(marked)
    // why a value has no rows behind it is the code section's to say, not the card's
  }
  return parts
}
