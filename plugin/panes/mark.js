// mark.js: a citation or an explainer in the side panel, a program on the card runtime (draw/kit.js). The same card the
// tray shows (tray.js cardBody: a citation's source card, an explain card), drawn at the panel's width with more rows.
// The side panel (shell/side.ts) puts the mark's side thread under it and its input bar at the bottom, as under any
// pane: this file says only what the thread is about (`thread`).
//
// Its subject is drawn once, at the top, as every thread's is (subject.js): the cited words, and what they cite. The card
// follows with no frame of its own, the part that holds the cited value selected. What reads less easily (the rows
// behind a value, its code) is an action above the input bar, in words; what it opens is the `side:opened` region, which
// the side panel draws right above the actions, under the thread's conversation.
//
//   args: {frame}: a tray frame (tray.js frameOf): {row, i, kind, ref, label, gloss} for a mark of a message, or
//         {kind: 'cite', ref, label} for a citation inside a card or a thread's answer
//   state: {open: the section shown in place of the card}
//   wants: {card: {kind, ref, label, gloss}, w, h}: the card's parts drawn by the host (cards.js drawnCard)
//   presses: a citation inside the card opens it, over this one in the panel; a part of the card (the picture an
//            explainer draws, or its parts) is selected, and the thread's questions are about it. A citation shows its whole source here,
//            as many rows as the panel has: the panel is the one place a citation opens to read (the tray's ↵ and its
//            a both open it here)
//   actions: each section of the card (`act:<id>`: Rows, Code), shown above the actions and hidden again (`:on` is the
//            one open); esc hides it, then the panel's host goes back
//   actions: an explainer, Longer: written again at more length, in its place (one side call; the host draws it here
//            when it lands)
//   asks of the host: open {mark: frame} (a citation inside the card, opened over this one), expand {frame}
import { threadKey } from '../shell/threads.js'
import { cardBody, cardRequest, partOf, scopeOf } from './tray.js'
import { subjectBlock } from './subject.js'

/** The rows the card may take in the panel. */
export const BODY = 16

const frameOf = args => (args && args.frame && typeof args.frame === 'object' ? args.frame : null)

export default {
  name: 'mark',
  title: 'Citation',
  reads: () => [],
  stateKey: args => `mark-${threadKey(scopeOf(frameOf(args)) || {})}`.slice(0, 110),
  data(_stores, args) {
    return { frame: frameOf(args) }
  },
  /** The pane's title in Claude Code's chrome: what kind of mark, and its words. */
  titleOf(args) {
    const f = frameOf(args)
    if (!f) return 'Citation'
    const heads = f.kind === 'gloss' && f.gloss && f.gloss.kind === 'heads'
    return `${heads ? 'Heads up' : f.kind === 'gloss' ? 'Explain' : f.kind === 'passage' ? 'Passage' : 'Cite'} · ${String(f.label || f.ref || '')}`.slice(0, 60)
  },
  /** What its side thread is about: the mark (one thread per mark, the tray's own), its ref, in words, and what an
   *  explainer or an important detail said, as the person reads it. */
  thread(args, state) {
    const f = frameOf(args)
    if (!f) return null
    const own = f.ref ? [f.ref] : (f.gloss && Array.isArray(f.gloss.refs) ? f.gloss.refs.slice(0, 3) : [])
    // a part of the card selected (a click on it, here or in the tray): the question is about that part
    const part = state && state.part && typeof state.part === 'object' ? state.part : null
    const label = String(f.label || f.ref || 'this mark')
    // a passage of a reply: its words, for the thread's agent
    const about = f.kind === 'gloss' && f.gloss ? saidOf(f.gloss) : f.kind === 'passage' ? String(f.text || '') : ''
    return { scope: scopeOf(f), label: part ? `${label} · ${part.label}`.slice(0, 80) : label, refs: part && part.refs && part.refs.length ? part.refs : own, ...(about ? { about } : {}) }
  },
  program,
}

/** What an explainer or an important detail says, in words for a side thread's agent. */
export function saidOf(g) {
  if (g.kind === 'heads') return `thimble marked them as an important detail, "${g.title || g.term}": ${(g.bullets || []).join(' ')}${g.todo ? ` What to do: ${g.todo}` : ''}`
  return `thimble's explainer of them says: ${g.body || g.title || ''}${g.here ? ` ${g.here}` : ''}`
}

// what each section's action says
const ACTION = { rows: 'Rows', code: 'Code', raw: 'As in the file' }

export function program(k, data) {
  const top = data.frame
  if (!top) return k.text('{dim:Nothing is open here.}')
  // a passage of a reply (its margin's ?): its words, under its subject
  if (top.kind === 'passage') return k.stack(subjectBlock(k, { title: k.escape(String(top.label || 'a passage')), line: 'passage of the reply' }), k.size(k.text(k.escape(String(top.text || ''))), { w: Math.max(20, k.w - 2) }))
  const st = k.state || {}
  const heads = top.kind === 'gloss' && top.gloss && top.gloss.kind === 'heads'
  const inner = Math.max(20, k.w - 2)
  // its whole source, as many rows as the panel gives it
  const card = k.want({ card: cardRequest(top), w: inner, h: Math.max(BODY, (k.h || 0) - 10) })
  const links = card && Array.isArray(card.links) ? card.links.slice(0, 8) : []
  const sections = card && Array.isArray(card.sections) ? card.sections.filter(s => s && s.id) : []
  const open = sections.find(s => s.id === st.open) || null
  const openLink = l => { k.do('open', { mark: { kind: 'cite', ref: l.ref, label: l.label } }) }
  // each section an action above the input bar: shown in place of the card, hidden again
  sections.forEach(s => k.on(open && open.id === s.id ? `act:${s.id}:on` : `act:${s.id}`, () => ({ open: open && open.id === s.id ? null : s.id }), ACTION[s.id] || s.words))
  // an explainer written again at more length, in its place
  if (top.kind === 'gloss' && !heads && !(top.gloss && top.gloss.expanded) && top.row != null) k.on('act:expand', () => { k.do('expand', { frame: top }); return { expanding: true } }, 'Longer')
  // esc hides the section open first; then the panel's host goes back
  if (open) k.on('esc', () => ({ open: null }), 'the citation')
  k.on('press', e => {
    const l = links.find(x => x.id === e.region)
    if (l) { openLink(l); return null }
    // a part of the card (the picture an explainer draws, or its parts): selected, the questions about it
    const part = partOf(card, e.region)
    return part ? { part } : null
  })
  // the card always; what a section opened, under the conversation (`side:opened`)
  const part = st.part && typeof st.part === 'object' ? st.part : null
  const parts = cardBody(k, card, part ? { ...top, part: part.id } : top, null)
  if (st.expanding && !(top.gloss && top.gloss.expanded)) parts.push(k.text('{dim:writing a longer explanation…}'))
  const opened = open ? [...(open.problem ? [k.text(`{dim:${k.escape(String(open.problem))}}`)] : []), ...(open.drawings || []).map(d => k.embed(d))] : []
  const kind = heads ? 'heads up' : top.kind === 'gloss' ? 'explainer' : top.kind === 'spark' ? 'series' : 'citation'
  // what it cites, in the card's own words without its kind (`cite · revisions.jsonl` says revisions.jsonl)
  const from = card && !card.problem && !card.error && typeof card.right === 'string' ? card.right.replace(/^(cite|explain|series|heads up)\s*·\s*/, '') : ''
  const label = String(top.label || top.ref || '')
  const title = label.length > inner - 4 ? label.slice(0, Math.max(8, inner - 5)) + '…' : label
  const line = [kind, from].filter(Boolean).join(' · ')
  return k.stack(subjectBlock(k, { title: k.escape(title), line: k.escape(line) }), k.size(k.stack(parts), { w: inner }), opened.length ? k.region('side:opened', { label: String(ACTION[open.id] || open.words) }, k.size(k.stack(opened), { w: inner })) : false)
}
