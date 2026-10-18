// tray.js: the cite & explain tray, a program on the card runtime (draw/kit.js). The terminal draws it in the band above
// the prompt and the browser at the foot of the chat, from this one file; which cards are open is its state, kept for
// both surfaces (thimble/panes/<session>/tray.json).
//
// It shows one card at a time, the top of a stack: a citation's source card (what the value rests on: the query's
// output around the cited row, a series, a code hunk, or the rows) or an explain card (what a term is, a small drawing,
// where it mattered here). A citation inside a card opens over it; back returns to the card under it, and back from the
// first card closes the tray. 1 asks: the question goes to the mark's side thread, which main does not see.
//
//   state: {stack: [frame, ...], asking: true while the person asks the mark's thread}
//   frame: {row, i, kind, ref, label, gloss} for a mark of a message (frameOf), {kind: 'cite', ref, label} for a citation
//          inside a card. A frame carries what it shows, so a surface draws it without the message's record.
//   reads: the session's side threads (the mark's thread, its questions and answers)
//   wants: {card: {kind, ref, label, gloss}, w, h}: the card's parts drawn by the host, each in its sandbox, as
//          {title, right, drawings: [drawing], links: [{id, ref, label}], problem}
//   keys: 1 ask · 2–9 open a citation inside the card · 0 back (or close) · ] [ the next and the one before (the host's
//         order of marks and cards: k.do('step'))
import { threadKey } from '../shell/threads.js'

/** The rows a card may take in the tray. */
export const BODY = 9

/** A mark of a message's record as a frame of the tray: what it shows, whatever surface opens it. */
export function frameOf(rec, i) {
  const m = rec && Array.isArray(rec.marks) ? rec.marks[i] : null
  if (!m) return null
  if (m.kind === 'gloss') {
    const g = (rec.glosses && rec.glosses[m.gloss]) || { term: m.label || '' }
    return { row: rec.row, i, kind: 'gloss', label: String(g.term || m.label || ''), gloss: { id: m.gloss, term: g.term, title: g.title, body: g.body, here: g.here, program: g.program, data: g.data, refs: g.refs } }
  }
  return { row: rec.row, i, kind: m.kind === 'spark' ? 'spark' : 'cite', ref: m.ref, label: m.kind === 'spark' ? `sparkline · ${m.ref}` : String(m.label || m.ref || '') }
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
  return { kind: f.kind || 'cite', ref: f.ref, label: f.label }
}

/** Two frames the same (a citation opened twice in a row is not stacked twice). */
export const sameFrame = (a, b) => !!a && !!b && (a.row != null || b.row != null ? a.row === b.row && a.i === b.i : a.ref === b.ref)

export default {
  name: 'tray',
  title: 'cite & explain',
  reads: () => ['threads'],
  stateKey: () => 'tray',
  data(stores) {
    const list = Array.isArray(stores.threads) ? stores.threads : []
    // a thread as the tray reads it: its key, its status, its turns (each question and answer), its error
    return {
      threads: list.map(t => ({ key: t.key || (t.scope ? threadKey(t.scope) : ''), status: t.status || '', error: t.error || '', turns: (t.turns || []).map(x => ({ role: x.role === 'user' ? 'person' : x.role, text: String(x.text || '') })) })),
    }
  },
  program,
}

const plainCites = s => String(s || '').replace(/`/g, '').replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, '$1')

export function program(k, data) {
  const st = k.state || {}
  const stack = Array.isArray(st.stack) ? st.stack.filter(f => f && typeof f === 'object') : []
  const top = stack[stack.length - 1]
  if (!top) return k.text('')
  const kind = top.kind === 'gloss' ? 'explain' : top.kind === 'spark' ? 'series' : 'cite'
  const tone = top.kind === 'gloss' ? 'explain' : 'cite'
  const inner = Math.max(20, k.w - 4)
  const card = k.want({ card: cardRequest(top), w: inner, h: BODY })
  const scope = scopeOf(top)
  const key = threadKey(scope)
  const thread = (data.threads || []).find(t => t.key === key) || null
  const links = card && Array.isArray(card.links) ? card.links.slice(0, 8) : []
  const asking = !!st.asking

  // ---- what the person does
  const back = () => {
    if (asking) return { asking: false }
    if (stack.length > 1) return { stack: stack.slice(0, -1) }
    k.do('close')
    return { stack: [], asking: false }
  }
  const open = l => ({ stack: [...stack, { kind: 'cite', ref: l.ref, label: l.label }].slice(-12), asking: false })
  // while the person asks, the bar says how (k.status), and only back besides
  k.on('1', () => {
    // in the browser the question is typed in the tray; in the terminal, in the prompt (the bar says so)
    if (k.surface === 'browser') k.do('input', { label: `ask about ${top.label}…`, event: 'ask' })
    return { asking: true }
  }, asking ? undefined : thread ? 'thread' : 'ask')
  links.forEach((l, j) => k.on(String(j + 2), () => open(l), asking ? undefined : 'open'))
  k.on('0', back, asking || stack.length > 1 ? 'back' : 'close')
  k.on('esc', back)
  k.on(']', () => { k.do('step', { dir: 1 }) }, asking ? undefined : 'next')
  k.on('[', () => { k.do('step', { dir: -1 }) })
  k.on('ask', e => {
    const text = String(e.text || '').trim()
    if (text) k.do('ask', { text, scope, refs: top.ref ? [top.ref] : (top.gloss && top.gloss.refs) || [] })
    return { asking: true }
  })
  k.on('press', e => {
    const l = links.find(x => x.id === e.region)
    if (l) return open(l)
    if (e.region === 'thread') return { asking: true }
    return null
  })
  if (asking && k.surface === 'terminal') k.status(thread && thread.status === 'running' ? 'answering… · type to ask' : 'type to ask · ↵ asks this thread', 'warn')

  // ---- the card, or the mark's thread once the person asks
  const parts = []
  if (asking) {
    if (!thread || !thread.turns.length) parts.push(k.text(`{dim:ask about ${k.escape(top.label)}…}`))
    else {
      for (const t of thread.turns.slice(-6)) {
        if (t.role === 'person') parts.push(k.text(`**❯ ${k.escape(t.text)}**`))
        else plainCites(t.text).split(/\n+/).map(x => x.trim()).filter(Boolean).slice(0, 8).forEach((p, j) => parts.push(k.text(`${j ? '  ' : '⏺ '}${k.escape(p)}`)))
      }
      if (thread.status === 'running') parts.push(k.text('{warn:✻ answering…}'))
      if (thread.status === 'failed') parts.push(k.text(`{bad:× ${k.escape(thread.error || 'the thread stopped')}} {dim:· ask again, or 0 and ask in main}`))
    }
  } else if (!card) {
    parts.push(k.text(`{dim:${top.kind === 'gloss' ? 'drawing the explainer…' : 'reading it through the kernel…'}}`))
  } else if (card.problem || card.error) {
    parts.push(k.text(`{dim:${k.escape(String(card.problem || card.error))}}`))
  } else {
    (card.drawings || []).forEach((d, j) => {
      if (j) parts.push(k.space(1, 1))
      parts.push(k.embed(d))
    })
    if (card.why) parts.push(k.text(`{dim:${k.escape(card.why)}}`))
    if (thread && thread.turns.length) {
      const q = (thread.turns.find(t => t.role === 'person') || {}).text || ''
      parts.push(k.region('thread', { label: 'the thread about this mark' }, k.text(`{dim:↳ thread:} ${k.escape(q.length > 60 ? q.slice(0, 59) + '…' : q)}`, { wrap: false })))
    }
  }
  const title = top.label.length > inner - 12 ? top.label.slice(0, Math.max(8, inner - 13)) + '…' : top.label
  return k.frame(k.size(k.stack(parts), { w: inner }), { title: k.escape(title), right: k.escape(stack.length > 1 ? `${kind} · ${stack.length}` : kind), tone })
}
