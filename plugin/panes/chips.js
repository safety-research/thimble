// chips.js: the squeeze chips under a message, a program on the card runtime (draw/kit.js) over the message's record
// (thimble/messages/<session>/<row>.json), drawn under the message; which chip is picked is the program's state.
//
// One row of chips, drawn under the whole answer, after its last card: each its digit, its name, its dots and its level
// (`1 Length ○●○○○ short`); at the level where the original stands a chip reads `as written`. The picked chip has a
// fill. Then the chips the person typed (`4 for my manager ●○○○ as written`), and `+`, which adds one: typed in the
// chips while they hold the keys, else in the prompt as `/squeeze <words>` (the host fills it). On a catch-up (every
// reply since the person's last message, written as one) the chips work as on any answer, and 0 brings the replies
// back. What a chip change does, the rewrite in place, is the host's: the program asks for it with k.do('squeeze',
// {at}) (k.do('dismiss'), k.do('own', {words}), k.do('ownask')), and the record then holds the new text and the levels
// (and, while the call runs, where they go: record.squeeze.want). Nothing is written under the chips: the bar says
// their keys.
//
//   state: {focus: chip id, edge: chip id when the last step met the end of its scale, typing: what is typed after +}
//   keys: [ ] shorter / longer (the picked chip's two ways, in its words) · 1–N chip (each chip drawn after its digit:
//         a numbered list) · 0 revert (the original; on a catch-up the replies it stands in for) · s done · + your own.
//         Claude Code keeps tab, shift+tab, the arrow keys, enter and esc in its prompt; a click on the chips hands
//         them the keyboard (shell/keysclient.js, `data.keys`), and then tab and shift+tab move between the chips,
//         ← and → between the levels, and enter is done, until esc gives the keys back to the prompt. No key is
//         labelled < >: next to Claude Code's `← for agents` it reads as the arrow keys, and ← in an empty prompt leaves
//         the conversation for the agents view. < > and , . still change, unnamed.
//   presses: a chip picks it (the picked one steps up); a dot sets that level; + starts a chip of the person's
import { SCALE, atOf, chipsOf, glyph, isCatchUp, isOriginal, levelWords, ownWords, stepAt } from '../squeeze/chips.mjs'

const same = (a, b) => JSON.stringify(a || {}) === JSON.stringify(b || {})
/** What [ and ] do to each chip, in its words: the way down, then the way up. */
const WAYS = { length: 'shorter / longer', interpret: 'facts / interpretation' }

export default {
  name: 'chips',
  title: 'Squeeze',
  reads: args => [`record:${args.row}`, `sqz:${args.row}`, `held:chips-${args.row}`, 'busy'],
  stateKey: args => `chips-${String(args.row || '').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64)}`,
  data(stores, args) {
    const rec = stores[`record:${args.row}`] || null
    const ui = stores[`sqz:${args.row}`] || null
    if (!rec) return { row: args.row, rec: null }
    const s = rec.squeeze || {}
    // (the levels as Length's scale reads them now: a record from before the scale is read as atOf says)
    const lean = { text: rec.text, shown: rec.shown ?? null, verbs: rec.verbs ? { s: rec.verbs.s || null } : {}, squeeze: { at: atOf(rec), scale: SCALE, own: Array.isArray(s.own) ? s.own : [], want: s.want || null, running: !!s.running, error: s.error || null, problems: s.problems || [] } }
    const catchup = isCatchUp(rec) ? { replies: Number(rec.catchup.replies) || 0 } : null
    return {
      row: args.row, rec: lean, catchup,
      // the chips hold the keyboard (a click gave it them): tab and the arrows reach them
      keys: !!stores[`held:chips-${args.row}`],
      // the terminal's own: a call running, a call that failed
      running: !!(ui && ui.running) || !!s.running,
      // the glyph that turns while thimble works (the terminal's shell/busy.ts), in place of the still dot
      busy: typeof stores.busy === 'string' ? stores.busy : null,
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
  // the row in order: the fixed three, then the person's own
  const row = [...chips.filter(c => c.kind !== 'own'), ...chips.filter(c => c.kind === 'own')]
  const focus = row.some(c => c.id === st.focus) ? st.focus : row[0].id
  const orig = isOriginal(chips)
  const pending = !!rec.squeeze.want && !same(rec.squeeze.want, rec.squeeze.at)
  const held = !!data.keys
  const typing = held && typeof st.typing === 'string' ? st.typing : null

  // ---- what the person does
  // a catch-up never stands at its original (the replies it stands in for): a level that would bring it there is not
  // set (0 shows the replies again)
  const toOriginal = to => !!data.catchup && isOriginal(chipsOf({ ...rec, squeeze: { ...rec.squeeze, at: to } }))
  // a step names the key the bar names for it ([ or ], whichever key made it), so a rewrite that fails says which key
  // tries again; a step past the end of the scale says so, since nothing else would change. On a catch-up a step that
  // would land on the original goes on past it
  const step = (id, dir) => {
    let to = stepAt({ ...rec, squeeze: { ...rec.squeeze, at } }, id, dir)
    if (to && toOriginal(to)) to = stepAt({ ...rec, squeeze: { ...rec.squeeze, at: to } }, id, dir)
    if (!to) return { focus: id, edge: id }
    k.do('squeeze', { row: data.row, at: to, key: dir < 0 ? '[' : ']' })
    return { focus: id, edge: null }
  }
  const revert = () => {
    if (data.catchup) k.do('dismiss', { row: data.row })
    else if (!orig || pending) k.do('squeeze', { row: data.row, reset: true })
    return { edge: null }
  }
  if (typing != null) {
    // typing a chip of the person's own, after +: the words, ⌫, ↵ adds it, tab lets it go
    k.on('key', e => {
      const key = String(e.key || '')
      if (key === 'return' || key === 'enter') { if (ownWords(typing)) k.do('own', { row: data.row, words: typing }); return { typing: null } }
      if (key === 'tab' || key === 'shift+tab') return { typing: null }
      if (key === 'backspace' || key === 'delete') return { typing: typing.slice(0, -1) }
      if (key === 'space') return { typing: `${typing} ` }
      if ([...key].length === 1 && typing.length < 40) return { typing: typing + key }
      return null
    })
  } else {
    // [ and ] say which way they move the picked chip, in its words: `[ ] shorter / longer`; with the keyboard in the
    // chips, ← and → do (and tab and shift+tab move between the chips)
    const ways = WAYS[focus] || (focus.startsWith('x-') ? 'less / more' : 'change')
    k.on('[', () => step(focus, -1), held ? undefined : ways)
    k.on(']', () => step(focus, 1), held ? undefined : ways)
    const at0 = row.findIndex(c => c.id === focus)
    const pickAt = d => ({ focus: row[(at0 + d + row.length) % row.length].id, edge: null })
    k.on('tab', () => pickAt(1), held ? 'next chip' : undefined)
    k.on('shift+tab', () => pickAt(-1))
    k.on('left', () => step(focus, -1), held ? ways : undefined)
    k.on('right', () => step(focus, 1), held ? ways : undefined)
    k.on('return', () => { k.do('close'); return {} }, held ? 'done' : undefined)
    k.on('<', () => step(focus, -1))
    k.on('>', () => step(focus, 1))
    k.on(',', () => step(focus, -1))
    k.on('.', () => step(focus, 1))
    row.slice(0, 9).forEach((c, i) => k.on(String(i + 1), () => ({ focus: c.id, edge: null }), held ? undefined : 'chip'))
    // 0: revert to the original (a catch-up: the replies it stands in for)
    if (data.catchup || !orig || pending) k.on('0', revert, 'revert')
    k.on('s', () => { k.do('close'); return {} }, held ? undefined : 'done')
    // +: a chip of the person's own, typed here while the chips hold the keys, else in the prompt (the host fills it)
    k.on('+', () => (held ? { typing: '', edge: null } : (k.do('ownask', { row: data.row }), { edge: null })), 'your own')
    // esc with the keyboard in the chips gives it back to the prompt (Claude Code's own); the chips stay open. Where a
    // pane catches esc for the person (the side panel open), esc is done
    k.on('esc', () => { k.do('close'); return {} }, held ? 'back to the prompt' : undefined)
  }
  k.on('press', e => {
    const r = String(e.region || '')
    if (r === 'add') return held ? { typing: '', edge: null } : (k.do('ownask', { row: data.row }), { edge: null })
    const dot = /^lvl-(.+)-(\d+)$/.exec(r)
    if (dot) {
      const lv = Number(dot[2])
      const c = chips.find(x => x.id === dot[1])
      if (c && lv !== c.level && !toOriginal({ ...at, [c.id]: lv })) k.do('squeeze', { row: data.row, at: { ...at, [c.id]: lv } })
      return { focus: dot[1], edge: null, typing: null }
    }
    const id = r.replace(/^(chip|word)-/, '')
    const c = row.find(x => x.id === id)
    if (!c) return null
    if (c.id !== focus) return { focus: c.id, edge: null, typing: null }
    // a press on the picked chip steps it up, and from its last level back to its first
    const to = stepAt({ ...rec, squeeze: { ...rec.squeeze, at } }, c.id, 1) || { ...at, [c.id]: 0 }
    if (!toOriginal(to)) k.do('squeeze', { row: data.row, at: to })
    return { focus: c.id, edge: null, typing: null }
  })

  // ---- what the bar says while the chips have the keys (no line counts: the levels are on the chips)
  const problem = (rec.squeeze.problems || [])[0]
  const edge = row.find(c => c.id === st.edge) || null
  if (typing != null) k.status(`+ ${typing}▏ ↵ adds it · tab lets it go`, 'warn')
  else if (data.error) k.status(`× ${data.error}`, 'bad')
  else if (data.catchup && typeof rec.shown !== 'string') k.status(`s ● writing the catch-up of ${data.catchup.replies} replies…`, 'warn')
  else if (pending || data.running) k.status(`s ${data.busy || '●'} rewriting…`, 'warn')
  else if (edge) k.status(`${edge.name} goes no further than ${edge.levels[edge.level]}`, 'warn')
  else if (problem && typeof rec.shown === 'string') k.status(`! ${problem}`, 'warn')

  // ---- the row of chips, wrapped to the width
  const W = Math.max(30, k.w)
  const items = []
  row.forEach(c => {
    const picked = c.id === focus && typing == null
    const bg = picked ? 'warn-faint' : null
    // at the level where the original stands a chip reads `as written`; Interpretation says it only
    // while picked (`balanced, as written`), so the row keeps its width
    const word = c.kind === 'fixed' && c.id !== 'length' && !picked && c.level === c.level0 ? c.levels[c.level] : levelWords(c)
    // the chip's digit first, the key that picks it
    const parts = [[' ', 'dim'], [`${items.length + 1}`, picked ? 'warn' : 'dim'], [' ', 'dim'], [c.name, picked ? 'warn' : 'dim', picked], [' ', 'dim'], ['dots'], [' ', 'dim'], [word, 'ink', picked], [' ', 'dim']]
    const width = parts.reduce((n, p) => n + (p[0] === 'dots' ? c.levels.length : k.len(p[0])), 0)
    items.push({ c, parts, width, bg, picked, word })
  })
  // + at the end: what is typed after it, while it is typed
  const plus = typing != null ? ` + ${typing}▏ ` : ' + '
  const rows = [[]]
  let x = 0
  const place = (w, it) => {
    if (x && x + w > W) { rows.push([]); x = 0 }
    rows[rows.length - 1].push({ x, it })
    x += w + 3
  }
  items.forEach(it => place(it.width, it))
  place(k.len(plus), { add: true })
  const c = k.canvas(W, rows.length)
  rows.forEach((line, y) => {
    for (const { x: x0, it } of line) {
      if (it.add) {
        c.text(x0, y, plus, { tone: typing != null ? 'warn' : 'dim', bold: typing != null, raw: true })
        if (typing != null) c.bg(x0, y, k.len(plus), 1, 'warn-faint')
        c.region('add', x0, y, k.len(plus), 1, { label: 'add a chip of your own' })
        continue
      }
      let cx = x0
      // the chip's words before its dots are the chip (a press picks it), its dots each a level, its words after the
      // dots the chip again (a press there steps it, as on the picked chip)
      let start = x0
      const label = `${it.c.name}: ${it.word}`
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
