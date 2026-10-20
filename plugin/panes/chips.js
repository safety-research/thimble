// chips.js: the squeeze chips under a message, a program on the card runtime (draw/kit.js) over the message's record
// (thimble/messages/<session>/<row>.json), drawn under the message; which chip is picked is the program's state.
//
// One row of chips: each its name, its dots and its level (`Length ○●○○ short`). The picked chip has a fill. What a
// chip change does, the rewrite
// in place, is the host's: the program asks for it with k.do('squeeze', {at}), and the record then holds the new text
// and the levels (and, while the call runs, where they go: record.squeeze.want).
//
//   state: {focus: chip id}
//   keys: [ ] shorter / longer (the picked chip's two ways, in its words) · 1-3 pick chip (each chip drawn after its
//         digit) · 0 original (at the original: close) · s done. Claude Code keeps tab, shift+tab and the arrow keys
//         in its prompt, so the chips cannot move on them. On a catch-up (a message
//         the chips wrote of several replies) 0 dismisses it: its original is the replies, in the transcript above, so
//         no step lands on the original either. No key is labelled
//         < >: next to Claude Code's `← for agents` it reads as the arrow keys, and ← in an empty prompt leaves the
//         conversation for the agents view. < > and , . still change, unnamed.
//   presses: a chip picks it (the picked one steps up); a dot sets that level
import { chipsOf, glyph, isCatchUp, isOriginal, noteOf, stepAt } from '../squeeze/chips.mjs'

const same = (a, b) => JSON.stringify(a || {}) === JSON.stringify(b || {})
/** What [ and ] do to each chip, in its words: the way down, then the way up. */
const WAYS = { length: 'shorter / longer', interpret: 'more report / more interpret', familiarity: 'newer reader / more expert' }

export default {
  name: 'chips',
  title: 'Squeeze',
  reads: args => [`record:${args.row}`, `sqz:${args.row}`],
  stateKey: args => `chips-${String(args.row || '').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64)}`,
  data(stores, args, size) {
    const rec = stores[`record:${args.row}`] || null
    const ui = stores[`sqz:${args.row}`] || null
    if (!rec) return { row: args.row, rec: null }
    const s = rec.squeeze || {}
    const lean = { text: rec.text, shown: rec.shown ?? null, verbs: rec.verbs ? { s: rec.verbs.s || null } : {}, squeeze: { at: s.at || {}, want: s.want || null, running: !!s.running, error: s.error || null, problems: s.problems || [] } }
    const catchup = isCatchUp(rec) ? { replies: Number(rec.catchup.replies) || 0 } : null
    return {
      row: args.row, rec: lean, catchup,
      note: catchup ? null : typeof rec.shown === 'string' || s.auto ? noteOf(rec, size.w) : null,
      lit: rec.verbs && rec.verbs.s && rec.verbs.s.lit && rec.verbs.s.note ? String(rec.verbs.s.note) : null,
      // the terminal's own: a call running, a call that failed
      running: !!(ui && ui.running) || !!s.running,
      error: (ui && ui.error) || s.error || null,
    }
  },
  program,
}

export function program(k, data) {
  if (!data.rec) return k.text('{dim:This message has no record here, so it cannot be squeezed.}')
  const st = k.state || {}
  const rec = data.rec
  // where the chips go: a change on its way shows at once
  const at = rec.squeeze.want && !same(rec.squeeze.want, rec.squeeze.at) ? rec.squeeze.want : rec.squeeze.at
  const chips = chipsOf({ ...rec, squeeze: { ...rec.squeeze, at } })
  const focus = chips.some(c => c.id === st.focus) ? st.focus : chips[0].id
  const orig = isOriginal(chips)
  const pending = !!rec.squeeze.want && !same(rec.squeeze.want, rec.squeeze.at)

  // ---- what the person does
  // a catch-up never stands at its original (the replies above it): a level that would bring it there is not set
  const toOriginal = to => !!data.catchup && isOriginal(chipsOf({ ...rec, squeeze: { ...rec.squeeze, at: to } }))
  // a step names the key the bar names for it ([ or ], whichever key made it), so a rewrite that fails says which key
  // tries again
  const step = (id, dir) => {
    const to = stepAt({ ...rec, squeeze: { ...rec.squeeze, at } }, id, dir)
    if (to && !toOriginal(to)) k.do('squeeze', { row: data.row, at: to, key: dir < 0 ? '[' : ']' })
    return { focus: id }
  }
  // [ and ] say which way they move the picked chip, in its words: `[ ] shorter / longer`
  const ways = WAYS[focus] || 'change'
  k.on('[', () => step(focus, -1), ways)
  k.on(']', () => step(focus, 1), ways)
  k.on('<', () => step(focus, -1))
  k.on('>', () => step(focus, 1))
  k.on(',', () => step(focus, -1))
  k.on('.', () => step(focus, 1))
  chips.slice(0, 9).forEach((c, i) => k.on(String(i + 1), () => ({ focus: c.id }), 'pick chip'))
  if (data.catchup) {
    k.on('0', () => { k.do('dismiss', { row: data.row }); return {} }, 'dismiss')
  } else {
    k.on('0', () => {
      if (orig && !pending) k.do('close')
      else k.do('squeeze', { row: data.row, reset: true })
      return {}
    }, orig && !pending ? 'close' : 'original')
  }
  k.on('s', () => { k.do('close'); return {} }, 'done')
  k.on('esc', () => { k.do('close'); return {} })
  k.on('press', e => {
    const r = String(e.region || '')
    const dot = /^lvl-(.+)-(\d+)$/.exec(r)
    if (dot) {
      const c = chips.find(x => x.id === dot[1])
      const lv = Number(dot[2])
      if (c && lv !== c.level && !toOriginal({ ...at, [c.id]: lv })) k.do('squeeze', { row: data.row, at: { ...at, [c.id]: lv } })
      return { focus: dot[1] }
    }
    const id = r.replace(/^(chip|word)-/, '')
    const c = chips.find(x => x.id === id)
    if (!c) return null
    if (c.id !== focus) return { focus: c.id }
    // a press on the picked chip steps it up, and from its last level back to its first
    const to = stepAt({ ...rec, squeeze: { ...rec.squeeze, at } }, c.id, 1) || { ...at, [c.id]: 0 }
    if (!toOriginal(to)) k.do('squeeze', { row: data.row, at: to })
    return { focus: c.id }
  })

  // ---- what the bar says while the chips have the keys
  const problem = (rec.squeeze.problems || [])[0]
  const of = data.catchup ? `catch-up of ${data.catchup.replies} replies` : null
  if (data.error) k.status(`× ${data.error}`, 'bad')
  else if (data.catchup && typeof rec.shown !== 'string') k.status(`s ● writing the ${of}…`, 'warn')
  else if (pending || data.running) k.status('s ● rewriting…', 'warn')
  else if (problem && typeof rec.shown === 'string') k.status(`! ${problem}`, 'warn')
  else if (of) k.status(`s ● ${of}`, 'warn')
  else if (data.note) k.status(`s ● ${data.note}`, 'warn')
  else if (data.lit) k.status(`s ● ${data.lit}`, 'warn')

  // ---- the row of chips, wrapped to the width
  const W = Math.max(30, k.w)
  const items = []
  chips.forEach(c => {
    const picked = c.id === focus
    const bg = picked ? 'warn-faint' : null
    // the chip's digit first, the key that picks it
    const parts = [[' ', 'dim'], [`${items.length + 1}`, picked ? 'warn' : 'dim'], [' ', 'dim'], [c.name, picked ? 'warn' : 'dim', picked], [' ', 'dim'], ['dots'], [' ', 'dim'], [c.levels[c.level] || '', 'ink', picked], [' ', 'dim']]
    const width = parts.reduce((n, p) => n + (p[0] === 'dots' ? c.levels.length : k.len(p[0])), 0)
    items.push({ c, parts, width, bg, picked })
  })
  const rows = [[]]
  let x = 0
  const place = (w, it) => {
    if (x && x + w > W) { rows.push([]); x = 0 }
    rows[rows.length - 1].push({ x, it })
    x += w + 3
  }
  items.forEach(it => place(it.width, it))
  const c = k.canvas(W, rows.length)
  rows.forEach((row, y) => {
    for (const { x: x0, it } of row) {
      let cx = x0
      // the chip's words before its dots are the chip (a press picks it), its dots each a level, its words after the
      // dots the chip again (a press there steps it, as on the picked chip)
      let start = x0
      const label = `${it.c.name}: ${it.c.levels[it.c.level] || ''}`
      for (const p of it.parts) {
        if (p[0] === 'dots') {
          if (cx > start) c.region(`chip-${it.c.id}`, start, y, cx - start, 1, { label })
          const g = glyph(it.c, it.c.level)
          // each dot in its own cell, where its press is (the browser draws them as circles there)
          Array.from(g).forEach((ch, i) => c.put(cx + i, y, ch, it.picked ? 'warn' : 'dim'))
          Array.from(g).forEach((_, i) => c.region(`lvl-${it.c.id}-${i}`, cx + i, y, 1, 1, { label: `${it.c.name}: ${it.c.levels[i]}` }))
          cx += g.length
          start = cx
          continue
        }
        const [s, tone, bold] = p
        if (s.trim()) c.text(cx, y, s, { tone, bold: !!bold, raw: true })
        cx += k.len(s)
      }
      // only the picked chip has a fill
      if (it.bg) c.bg(x0, y, it.width, 1, it.bg)
      if (cx > start) c.region(`word-${it.c.id}`, start, y, cx - start, 1, { label })
    }
  })
  return c
}
