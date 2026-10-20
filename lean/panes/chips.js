// chips.js: the squeeze chips under a message, a program on the card runtime (draw/kit.js) over the message's record
// (thimble/messages/<session>/<row>.json). The terminal draws it under the message and the browser under the same
// message in the chat, from this one file; which chip is picked is the program's state, kept for both.
//
// One row of chips: each its name, its dots and its level (`Length ○●○○ short`); a stretch as its two ends around its
// dots (`engineer ●○○○ manager`). The picked chip has a fill. A `+` ends the row. What a chip change does, the rewrite
// in place, is the host's: the program asks for it with k.do('squeeze', {at}), and the record then holds the new text
// and the levels (and, while the call runs, where they go: record.squeeze.want).
//
//   state: {focus: chip id, adding: true while the person types a stretch}
//   keys: 1-9 pick · ] [ next chip · < > (or , .) change · + new stretch · 0 original (at the original: close) · s done
//   presses: a chip picks it (the picked one steps up); a dot sets that level; + starts a stretch
//   events: stretch {text} (the two ends the person typed, from the host's input)
import { chipsOf, glyph, isOriginal, noteOf, stepAt, stretchChip } from '../verbs/squeeze/chips.mjs'

const same = (a, b) => JSON.stringify(a || {}) === JSON.stringify(b || {})

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
    const lean = { text: rec.text, shown: rec.shown ?? null, verbs: rec.verbs ? { s: rec.verbs.s || null } : {}, squeeze: { at: s.at || {}, own: s.own || [], want: s.want || null, running: !!s.running, error: s.error || null, problems: s.problems || [] } }
    return {
      row: args.row, rec: lean,
      note: typeof rec.shown === 'string' || s.auto ? noteOf(rec, size.w) : null,
      lit: rec.verbs && rec.verbs.s && rec.verbs.s.lit && rec.verbs.s.note ? String(rec.verbs.s.note) : null,
      // the terminal's own: a stretch being typed in its prompt, a call running, a call that failed
      typing: ui && ui.adding ? String(ui.typing || '+') : null,
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
  // a step names the key it came from (, and . are < and >), so a rewrite that fails says which key tries again
  const step = (id, dir) => {
    const to = stepAt({ ...rec, squeeze: { ...rec.squeeze, at } }, id, dir)
    if (to) k.do('squeeze', { row: data.row, at: to, key: dir < 0 ? '<' : '>' })
    return { focus: id, adding: false }
  }
  chips.slice(0, 9).forEach((c, i) => k.on(String(i + 1), () => ({ focus: c.id, adding: false })))
  const next = dir => () => {
    const i = Math.max(0, chips.findIndex(c => c.id === focus))
    return { focus: chips[(i + dir + chips.length) % chips.length].id, adding: false }
  }
  k.on('<', () => step(focus, -1), 'change')
  k.on('>', () => step(focus, 1), 'change')
  k.on(',', () => step(focus, -1))
  k.on('.', () => step(focus, 1))
  k.on(']', next(1), 'next chip')
  k.on('[', next(-1))
  const stretch = () => {
    k.do('input', { row: data.row, label: 'two ends, such as engineer and manager', event: 'stretch', prefix: '+' })
    return { adding: true }
  }
  k.on('+', stretch, 'new stretch')
  k.on('stretch', e => {
    const chip = stretchChip(rec, String(e.text || ''))
    if (!chip) { k.do('say', { text: 'A stretch needs two ends, such as "+engineer and manager".' }); return { adding: false } }
    k.do('squeeze', { row: data.row, stretch: String(e.text || '') })
    return { focus: chip.id, adding: false }
  })
  k.on('0', () => {
    if (orig && !pending) k.do('close')
    else k.do('squeeze', { row: data.row, reset: true })
    return { adding: false }
  }, orig && !pending ? 'close' : 'original')
  k.on('s', () => { k.do('close'); return { adding: false } }, 'done')
  k.on('esc', () => { k.do('close'); return { adding: false } })
  k.on('press', e => {
    const r = String(e.region || '')
    const dot = /^lvl-(.+)-(\d+)$/.exec(r)
    if (dot) {
      const c = chips.find(x => x.id === dot[1])
      const lv = Number(dot[2])
      if (c && lv !== c.level) k.do('squeeze', { row: data.row, at: { ...at, [c.id]: lv } })
      return { focus: dot[1], adding: false }
    }
    if (r === 'add') return stretch()
    const id = r.replace(/^(chip|word)-/, '')
    const c = chips.find(x => x.id === id)
    if (!c) return null
    if (c.id !== focus) return { focus: c.id, adding: false }
    // a press on the picked chip steps it up, and from its last level back to its first
    const to = stepAt({ ...rec, squeeze: { ...rec.squeeze, at } }, c.id, 1) || { ...at, [c.id]: 0 }
    k.do('squeeze', { row: data.row, at: to })
    return { focus: c.id, adding: false }
  })

  // ---- what the bar says while the chips have the keys
  const problem = (rec.squeeze.problems || [])[0]
  if (data.error) k.status(`× ${data.error}`, 'bad')
  else if (pending || data.running) k.status('s ● rewriting…', 'warn')
  else if (problem && typeof rec.shown === 'string') k.status(`! ${problem}`, 'warn')
  else if (data.note) k.status(`s ● ${data.note}`, 'warn')
  else if (data.lit) k.status(`s ● ${data.lit}`, 'warn')

  // ---- the row of chips, wrapped to the width
  const W = Math.max(30, k.w)
  const items = []
  chips.forEach(c => {
    const picked = c.id === focus && !st.adding && !data.typing
    const bg = picked ? 'warn-faint' : null
    const parts = c.kind === 'stretch'
      ? [[' ', 'dim'], [c.from, picked && c.level === 0 ? 'warn' : 'dim', picked && c.level === 0], [' ', 'dim'], ['dots'], [' ', 'dim'], [c.to, picked ? 'warn' : 'ink', picked && c.level === c.levels.length - 1], [' ', 'dim']]
      : [[' ', 'dim'], [c.name, picked ? 'warn' : 'dim', picked], [' ', 'dim'], ['dots'], [' ', 'dim'], [c.levels[c.level] || '', 'ink', picked], [' ', 'dim']]
    const width = parts.reduce((n, p) => n + (p[0] === 'dots' ? c.levels.length : k.len(p[0])), 0)
    items.push({ c, parts, width, bg, picked })
  })
  const typing = data.typing || (st.adding && k.surface === 'terminal' ? '+' : null)
  const rows = [[]]
  let x = 0
  const place = (w, it) => {
    if (x && x + w > W) { rows.push([]); x = 0 }
    rows[rows.length - 1].push({ x, it })
    x += w + 3
  }
  items.forEach(it => place(it.width, it))
  const ends = typing ? endsWords(typing) : null
  const tail = ends ? ` stretch between ${ends[0]} and ${ends[1]} ` : '+'
  place(k.len(tail), { tail })
  const c = k.canvas(W, rows.length)
  rows.forEach((row, y) => {
    for (const { x: x0, it } of row) {
      if (it.tail) {
        if (ends) c.text(x0, y, tail, { tone: 'ink', raw: true })
        else { c.text(x0, y, '+', { tone: 'dim', raw: true }); c.region('add', x0, y, 1, 1, { label: 'new stretch' }) }
        continue
      }
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

/** The two ends as typed so far, for "stretch between … and …". */
function endsWords(typed) {
  const w = String(typed || '').replace(/^\s*\+\s*/, '').replace(/^(stretch\s+)?(between|from)\s+/i, '').trim()
  if (!w) return ['…', '…']
  const m = /^(.+?)\s*(?:↔|<->|<>|\/|\s(?:and|to|vs\.?|versus|-|–|—)\s)\s*(.*)$/i.exec(w)
  return m ? [m[1], m[2] || '…'] : [w, '…']
}
