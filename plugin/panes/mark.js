// mark.js: a citation or an explainer in the side panel, a program on the card runtime (draw/kit.js). The same card the
// tray shows (tray.js cardBody: a citation's source card, an explain card), drawn at the panel's width with more rows.
// The side panel (shell/side.ts) puts the mark's side thread under it and its input bar at the bottom, as under any
// pane: this file says only what the thread is about (`thread`).
//
//   args: {frame}: a tray frame (tray.js frameOf): {row, i, kind, ref, label, gloss} for a mark of a message, or
//         {kind: 'cite', ref, label} for a citation inside a card or a thread's answer
//   state: {open: the section shown in place of the card}
//   wants: {card: {kind, ref, label, gloss}, w, h}: the card's parts drawn by the host (cards.js drawnCard)
//   keys: the sections' keys (r rows, c code) · o open the first citation inside the card (over this one, in the
//         panel; 2–9 the others, unnamed) · e expand an explainer (written again at more length, in its place) · ] [ the
//         next mark of the message and the one before, in its place (a mark of a message only)
//   asks of the host: open {mark: frame} (a citation inside the card, opened over this one), expand {frame}, step {dir}
import { threadKey } from '../shell/threads.js'
import { cardBody, cardRequest, scopeOf } from './tray.js'

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
    return `${heads ? 'Heads up' : f.kind === 'gloss' ? 'Explain' : 'Cite'} · ${String(f.label || f.ref || '')}`.slice(0, 60)
  },
  /** What its side thread is about: the mark (one thread per mark, the tray's own), its ref, in words, and what an
   *  explainer or an important detail said, as the person reads it. */
  thread(args) {
    const f = frameOf(args)
    if (!f) return null
    const refs = f.ref ? [f.ref] : (f.gloss && Array.isArray(f.gloss.refs) ? f.gloss.refs.slice(0, 3) : [])
    return { scope: scopeOf(f), label: String(f.label || f.ref || 'this mark'), refs, ...(f.kind === 'gloss' && f.gloss ? { about: saidOf(f.gloss) } : {}) }
  },
  program,
}

/** What an explainer or an important detail says, in words for a side thread's agent. */
export function saidOf(g) {
  if (g.kind === 'heads') return `thimble marked them as an important detail, "${g.title || g.term}": ${(g.bullets || []).join(' ')}${g.todo ? ` What to do: ${g.todo}` : ''}`
  return `thimble's explainer of them says: ${g.body || g.title || ''}${g.here ? ` ${g.here}` : ''}`
}

export function program(k, data) {
  const top = data.frame
  if (!top) return k.text('{dim:Nothing is open here.}')
  const st = k.state || {}
  const heads = top.kind === 'gloss' && top.gloss && top.gloss.kind === 'heads'
  const tone = heads ? 'heads' : top.kind === 'gloss' ? 'explain' : 'cite'
  const inner = Math.max(20, k.w - 4)
  // a citation expanded (↵ in the tray): its whole source, as many rows as the panel has
  const card = k.want({ card: cardRequest(top), w: inner, h: top.full ? Math.max(BODY, (k.h || 0) - 4) : BODY })
  const links = card && Array.isArray(card.links) ? card.links.slice(0, 8) : []
  const sections = card && Array.isArray(card.sections) ? card.sections.filter(s => s && s.id && typeof s.key === 'string' && s.key.length === 1) : []
  const open = sections.find(s => s.id === st.open) || null
  const openLink = l => { k.do('open', { mark: { kind: 'cite', ref: l.ref, label: l.label } }) }
  sections.forEach(s => k.on(s.key, () => ({ open: open && open.id === s.id ? null : s.id }), s.words))
  // o: the first citation inside the card (the rest by a click; 2–9 still open them, unnamed), so the line reads as words
  if (links.length) k.on('o', () => openLink(links[0]), `open ${String(links[0].label || links[0].ref || '').slice(0, 28)}`)
  links.forEach((l, j) => k.on(String(j + 2), () => openLink(l)))
  // e: an explainer written again at more length, in its place (one side call; the host draws it here when it lands)
  if (top.kind === 'gloss' && !heads && !(top.gloss && top.gloss.expanded) && top.row != null) k.on('e', () => { k.do('expand', { frame: top }); return { expanding: true } }, 'expand')
  // esc closes the section open first; then the panel's host goes back
  if (open) k.on('esc', () => ({ open: null }), 'back')
  // a mark of a message: the next one and the one before (the host's order of marks and cards), in its place
  if (top.row != null) {
    k.on(']', () => { k.do('step', { dir: 1 }) }, 'next')
    k.on('[', () => { k.do('step', { dir: -1 }) })
  }
  k.on('press', e => {
    const l = links.find(x => x.id === e.region)
    if (l) openLink(l)
    return null
  })
  const parts = cardBody(k, card, top, open)
  if (st.expanding && !(top.gloss && top.gloss.expanded)) parts.push(k.text('{dim:writing a longer explanation…}'))
  const kind = heads ? 'heads up' : top.kind === 'gloss' ? 'explain' : top.kind === 'spark' ? 'series' : 'cite'
  const from = card && !card.problem && !card.error && typeof card.right === 'string' && card.right ? card.right : kind
  const label = String(top.label || top.ref || '')
  const title = label.length > inner - 12 ? label.slice(0, Math.max(8, inner - 13)) + '…' : label
  return k.frame(k.size(k.stack(parts), { w: inner }), { title: k.escape(title), right: k.escape([from, open ? open.words : ''].filter(Boolean).join(' · ')), tone })
}
