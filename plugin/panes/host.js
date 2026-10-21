// host.js: what every surface does with a program on the runtime (draw/kit.js), as pure functions. A program is a card
// Claude saved or a pane of thimble's own (the card detail, the tray, the squeeze chips): the same API, the same
// drawing, and the same rules for what reaches it. No `$`, no DOM, no Node: the terminal (shell/panes.ts) and the
// browser (shell/browser/src/panes/) both import this file, so the two read a program's keys the same way.
//
//   keysOf(drawing)            the keys a program takes, as the bar says them: [{key: '[ ]', words: 'change'}]. Keys
//                              that share their words are one entry; a key with no words is not shown (an alias)
//   barText(drawings)          the keys of a focus stack (top first) as one line: 'r replay · esc close'
//   takes(drawing, event)      whether the program has a handler the event reaches
//   keyEvent(key)              a key as an event {type: 'key', key}, named as handlers name keys ('space', 'return')
//   route(stack, event)        the first program of a focus stack (top first) that takes the event, or null
//   nextState(was, drawing)    the state a program answered with, or the state it had
//   same(a, b)                 two states the same
//   wantsOpen(drawing, got)    the wants of a drawing the host has not got yet
//   actionsOf(drawing)         what a pane offers above the side panel's input bar: its `act:<id>` handlers, each
//                              [{event, words, on}] in the order defined (`act:<id>:on` is one open now); the host
//                              draws them as presses, the open one bold, and draws the program's `side:opened` region (what
//                              an action opened) right above them
//   backOf(drawing)            where the pane's esc goes back to, in its words (the esc handler's label), or null

/** How the bar shows a key name. */
export const KEY_SHOW = { space: 'space', return: '↵', enter: '↵', up: '↑', down: '↓', left: '←', right: '→', esc: 'esc', escape: 'esc', tab: 'tab', backspace: '⌫', '-': '−' }
const ARROW = /^[↑↓←→]$/

const SKIP = /^(press|brush|hover|focus|key|tick|input|act)(:|$)/

/** The keys a program takes, as the bar says them. A key that turns a knob one step (kit.js probes each key: `turn`)
 *  says which way, in plain words: two keys a program labelled `chapter` read `n next chapter · p previous chapter`. */
export function keysOf(drawing) {
  const on = Array.isArray(drawing?.on) ? drawing.on : []
  const out = []
  for (const h of on) {
    const name = String(h?.name || '')
    const words = turnWords(h, drawing)
    if (!name || !words || SKIP.test(name)) continue
    const key = KEY_SHOW[name] || name
    const hit = out.find(x => x.words === words)
    if (hit) { if (!hit.keys.includes(key)) hit.keys.push(key) } else out.push({ keys: [key], words })
  }
  // arrows that share their words read as one key (↑↓), digits in a row as a range (2–4), any other keys with a space
  // between (< >)
  const digits = ks => ks.length > 2 && ks.every(k => /^[0-9]$/.test(k)) && ks.every((k, i) => !i || Number(k) === Number(ks[i - 1]) + 1)
  return out.map(x => ({ key: x.keys.every(k => ARROW.test(k)) ? x.keys.join('') : digits(x.keys) ? `${x.keys[0]}–${x.keys[x.keys.length - 1]}` : x.keys.join(' '), words: x.words }))
}

/** A key's words in the bar: its label, and for a key that turns a knob one step, which way (`next chapter`), unless
 *  the label says so already. */
export function turnWords(h, drawing) {
  const label = String(h?.label || '').trim()
  const t = h?.turn
  if (!label || !t || !t.dir || /\b(next|previous|prev|back|forward|earlier|later|up|down|more|less|in|out)\b/i.test(label)) return label
  const knob = ((drawing && drawing.controls) || []).find(c => c.id === t.knob)
  return `${t.dir > 0 ? 'next' : 'previous'} ${label || knob?.label || t.knob}`
}

/** The keys of a focus stack, top first, as one line of the bar; a key the top takes is not said again below it, even
 *  in a group (`p` of `p program` goes when the card above takes `p`). */
export function barText(drawings) {
  const seen = new Set()
  const segs = []
  for (const d of drawings || []) {
    const mine = []
    for (const k of keysOf(d)) {
      const keys = /^\d–\d$/.test(k.key) || [...k.key].length <= 2 || !k.key.includes(' ') ? [k.key] : k.key.split(' ')
      const left = keys.filter(x => !seen.has(x))
      if (!left.length) continue
      mine.push(...left)
      segs.push(`${left.join(' ')} ${k.words}`)
    }
    mine.forEach(x => seen.add(x))
  }
  return segs.join(' · ')
}

/** A key as handlers name it. */
export function keyName(key) {
  const k = String(key || '')
  if (k === ' ') return 'space'
  if (k === 'enter') return 'return'
  if (k === 'escape') return 'esc'
  return k
}

export const keyEvent = key => ({ type: 'key', key: keyName(key) })

/** Whether the program has a handler the event reaches: its key, its type, or its type and target. */
export function takes(drawing, event) {
  const on = Array.isArray(drawing?.on) ? drawing.on : []
  if (!event || !on.length) return false
  const names = []
  const type = String(event.type || '')
  if (type === 'key' && event.key != null) names.push(String(event.key))
  if (type) names.push(type)
  if (type && (event.region || event.id)) names.push(`${type}:${event.region || event.id}`)
  return on.some(h => names.includes(h.name))
}

/** The first program of a focus stack (top first: [{id, drawing}, ...]) that takes the event, or null. */
export function route(stack, event) {
  for (const layer of stack || []) if (layer && takes(layer.drawing, event)) return layer
  return null
}

export function same(a, b) {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {})
}

/** The state a program answered with (a handler patched it), else the state it ran with. */
export function nextState(was, drawing) {
  return drawing && drawing.state && typeof drawing.state === 'object' && !drawing.error ? drawing.state : (was || {})
}

/** What a pane offers above the side panel's input bar: its `act:<id>` handlers with their words, in order. Each is
 *  pressed as the event {type: 'act:<id>'}. */
export function actionsOf(drawing) {
  const on = Array.isArray(drawing?.on) ? drawing.on : []
  return on.filter(h => /^act:[\w.-]+(:on)?$/.test(String(h?.name || '')) && h.label).map(h => ({ event: String(h.name), words: String(h.label), on: /:on$/.test(String(h.name)) }))
}

/** The rows of a drawing's `side:opened` region, what an action opened, which the side panel draws right above its actions
 *  and its input bar: the first of them, or the drawing's height when it has none. */
export function belowAt(grid) {
  const r = ((grid && grid.regions) || []).find(x => x && x.id === 'side:opened')
  return r && r.rects && r.rects.length ? Math.min(...r.rects.map(q => q.y)) : (grid ? grid.h : 0)
}

/** Where a pane's esc goes back to, as its handler names it (`labels`), or null when esc is not the pane's. */
export function backOf(drawing) {
  const h = (Array.isArray(drawing?.on) ? drawing.on : []).find(x => x && x.name === 'esc')
  return h ? String(h.label || 'back') : null
}

/** The wants of a drawing that are not in `got`. */
export function wantsOpen(drawing, got) {
  return (Array.isArray(drawing?.wants) ? drawing.wants : []).filter(w => !got || !Object.prototype.hasOwnProperty.call(got, w.key))
}

// ---------------------------------------------------------------- what stays on one surface
// A program's state is shared by every surface (a filter, a zoom, a flip, the cards open), except the keys it names
// with k.local (or a pane module's `local`): a hover, a replay's frame. Each surface keeps those for itself, so a
// pointer on one surface never moves a mark on the other.

/** The state keys that stay on the surface they were set on: the pane module's `local` and the drawing's (k.local). */
export function localKeys(drawing, pane) {
  const a = Array.isArray(pane?.local) ? pane.local : []
  const b = Array.isArray(drawing?.local) ? drawing.local : []
  return [...new Set([...a, ...b].map(String))]
}

/** The part of a state every surface shares: the state without its local keys. */
export function shared(state, keys) {
  const out = {}
  for (const [k, v] of Object.entries(state || {})) if (!(keys || []).includes(k)) out[k] = v
  return out
}

/** A state another surface answered with, joined with this surface's own local keys. */
export function joinShared(mine, theirs, keys) {
  const out = shared(theirs, keys)
  for (const k of keys || []) if (mine && Object.prototype.hasOwnProperty.call(mine, k)) out[k] = mine[k]
  return out
}

// ---------------------------------------------------------------- the keys a host keeps
// Where a card is drawn, a few keys are the host's: moving between things, going back, and the keys Claude Code keeps
// for its own prompt. A card's program learns them as k.keys (draw/kit.js); a key it takes there never reaches it, and
// the bar names only the keys that do.

// ← and → never reach a program in the terminal either: Claude Code keeps them (← in an empty prompt opens its agents
// view), so no bar names them there
const CC_OWN = { esc: 'Claude Code keeps it', return: 'Claude Code keeps it', tab: 'Claude Code keeps it', 'shift+tab': 'Claude Code keeps it', up: 'Claude Code keeps it for the prompt history', down: 'Claude Code keeps it for the prompt history', left: 'Claude Code keeps it (← opens its agents view)', right: 'Claude Code keeps it', backspace: 'Claude Code keeps it' }

/** The keys the host keeps where a card is drawn ('inline': under a reply, focused with ]; 'detail': its detail), on a
 *  surface ('terminal' | 'browser'), each with why: {key: why}. */
export function hostKeys(mode, surface = 'terminal') {
  if (mode === 'detail') {
    const kept = surface === 'terminal' ? { left: 'Claude Code keeps it', right: 'Claude Code keeps it' } : {}
    return { esc: 'goes back', up: 'moves between parts', down: 'moves between parts', tab: 'moves between parts', 'shift+tab': 'moves between parts', return: 'opens the part', '0': 'clears', ...kept }
  }
  const moving = { 0: 'goes back', 1: 'opens the detail', ']': 'moves to the next thing', '[': 'moves to the one before' }
  return surface === 'terminal' ? { ...CC_OWN, ...moving } : { ...moving, esc: 'goes back' }
}

// ---------------------------------------------------------------- the one bar, in the room it has
// The bar is one line: `thimble  v visualize · s squeeze · c 9 claims      t 2 threads · r coverage 34%`. With
// less room it gives up, in this order: the words of a key that yields (the reply the keys act on, `{ } reply 2 of 4:
// The writers…`), cut at their end down to their short form, then the counts other than coverage, then each key's words
// beyond their first word (`visualize`, `squeeze`, `cite`), then the label to its short form (`Coverage` for
// `thimble:main/Coverage`), then coverage, then the label, then the end of the line (an ellipsis). It never wraps.
// Coverage stays longest: it is what the session has seen of the folder, which no key shows.
//
//   bar: {label, labelShort?, left: [{key, words, short?, yields?, ...}], counts: [{id, text, ...}]}
//   barLadder(bar) -> the bar at each step, fullest first
//   fitBar(bar, width, measure) -> the first step whose line fits `width` (measure: text -> width, default columns)

const COUNT_ORDER = ['threads', 'labels', 'claims', 'cov']
const GAP = 3 // between the keys and the counts

/** The line a bar draws, as text (for measuring). */
export function barLine(b) {
  const keys = (b.left || []).map(s => [s.key, s.words].filter(Boolean).join(' ')).join(' · ')
  const head = [b.label || '', keys].filter(Boolean).join('  ')
  const counts = (b.counts || []).map(c => c.text).join(' · ')
  return counts ? `${head}${' '.repeat(GAP)}${counts}` : head
}

/** The first word of a key's words, as the narrowest bar says it (`cite & explain` → `cite`; a lit `● 2 views` keeps
 *  its verb's name when it gives one as `short`). */
export function firstWord(seg) {
  if (seg.short) return seg.short
  const w = String(seg.words || '').trim()
  if (!w) return w
  const parts = w.split(/\s+/)
  // a dot or an arrow alone is no word: keep the word after it
  return /^[^\p{L}\p{N}]+$/u.test(parts[0]) && parts[1] ? `${parts[0]} ${parts[1]}` : parts[0]
}

export function barLadder(bar) {
  const steps = []
  let b = { label: bar.label || '', left: (bar.left || []).slice(), counts: (bar.counts || []).slice() }
  steps.push(b)
  // the words of a key that yields, to their short form, before any count goes (fitBar cuts them at their end first)
  if (b.left.some(x => x.yields && x.short && x.short !== x.words)) {
    b = { ...b, left: b.left.map(x => (x.yields && x.short ? { ...x, words: x.short, shortened: true } : x)) }
    steps.push(b)
  }
  // the counts, one at a time, all but coverage
  const order = [...b.counts].sort((x, y) => (COUNT_ORDER.indexOf(x.id) + 1 || 99) - (COUNT_ORDER.indexOf(y.id) + 1 || 99) || 0)
  const cov = order.filter(c => c.id === 'cov')
  for (const c of order.filter(x => x.id !== 'cov')) {
    b = { ...b, counts: b.counts.filter(x => x !== c) }
    steps.push(b)
  }
  // each key's words to their first word, from the last key back (the first keys keep their words longest)
  const left = b.left.slice()
  for (let i = left.length - 1; i >= 0; i--) {
    // a status (what the focused surface says now) is cut at its end by fitBar, never to its first word
    if (left[i].status) continue
    const short = firstWord(left[i])
    if (short === left[i].words) continue
    left[i] = { ...left[i], words: short, shortened: true }
    b = { ...b, left: left.slice() }
    steps.push(b)
  }
  // a long label (the thread the panel shows) to its plain name (`Coverage`), else to its start, so coverage keeps its
  // place
  if (b.label && Array.from(b.label).length > LABEL_SHORT) {
    const plain = bar.labelShort && Array.from(bar.labelShort).length < Array.from(b.label).length ? bar.labelShort : b.label
    b = { ...b, label: cutEnd(plain, LABEL_SHORT) }
    steps.push(b)
  }
  // then coverage
  for (const c of cov) {
    b = { ...b, counts: b.counts.filter(x => x !== c) }
    steps.push(b)
  }
  // the label last
  if (b.label) steps.push({ ...b, label: '' })
  return steps
}

/** The bar as it fits `width`: the fullest step that fits, else the last, cut at the end with an ellipsis (`cut`). Once
 *  the counts are gone, a status that does not fit is cut at its end (`! "55" is not in the …`) before the keys lose
 *  their words, so it always reads as the start of its sentence. */
export function fitBar(bar, width, measure = s => Array.from(String(s)).length) {
  const steps = barLadder(bar)
  for (const s of steps) {
    if (measure(barLine(s)) <= width) return { ...s, cut: false }
    // a key that yields, cut at its end to the room left (`reply 2 of 4: The wri…`) while it says more than its short
    // form, so the counts keep their place
    const y = s.left.findIndex(x => x.yields && x.short && x.words !== x.short)
    if (y >= 0) {
      const g = s.left[y]
      const room = width - measure(barLine({ ...s, left: s.left.map((x, i) => (i === y ? { ...x, words: '' } : x)) })) - (g.key ? 1 : 0)
      if (room >= measure(g.short) + 4) return { ...s, left: s.left.map((x, i) => (i === y ? { ...x, words: cutEnd(x.words, room) } : x)), cut: false }
    }
    const at = s.left.findIndex(x => x.status)
    if (at < 0 || s.counts.length) continue
    const room = width - measure(barLine({ ...s, left: s.left.map((x, i) => (i === at ? { ...x, words: '' } : x)) }))
    if (room >= 12) return { ...s, left: s.left.map((x, i) => (i === at ? { ...x, words: cutEnd(x.words, room) } : x)), cut: false }
  }
  return { ...steps[steps.length - 1], cut: true }
}

/** How long a label stays once the bar is short of room: `thimble:main/02-…`. */
const LABEL_SHORT = 16
const cutEnd = (s, n) => (Array.from(String(s)).length <= n ? String(s) : Array.from(String(s)).slice(0, Math.max(1, n - 1)).join('') + '…')
