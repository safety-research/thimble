// host.js: what every surface does with a program on the runtime (draw/kit.js), as pure functions. A program is a card
// Claude saved or a pane of thimble's own (the card detail, the Claims graph, the squeeze chips): the same API, the same
// drawing, and the same rules for what reaches it. No `$`, no DOM, no Node: the terminal (shell/panes.ts) and the
// browser (shell/browser/src/panes/) both import this file, so the two read a program's keys the same way.
//
//   keysOf(drawing)            the keys a program takes, as the bar says them: [{key: '< >', words: 'change'}]. Keys
//                              that share their words are one entry; a key with no words is not shown (an alias)
//   barText(drawings)          the keys of a focus stack (top first) as one line: 'r replay · esc close'
//   takes(drawing, event)      whether the program has a handler the event reaches
//   keyEvent(key)              a key as an event {type: 'key', key}, named as handlers name keys ('space', 'return')
//   route(stack, event)        the first program of a focus stack (top first) that takes the event, or null
//   nextState(was, drawing)    the state a program answered with, or the state it had
//   same(a, b)                 two states the same
//   wantsOpen(drawing, got)    the wants of a drawing the host has not got yet

/** How the bar shows a key name. */
export const KEY_SHOW = { space: 'space', return: '↵', enter: '↵', up: '↑', down: '↓', left: '←', right: '→', esc: 'esc', escape: 'esc', tab: 'tab', backspace: '⌫', '-': '−' }
const ARROW = /^[↑↓←→]$/

const SKIP = /^(press|brush|hover|focus|key|tick|input)(:|$)/

/** The keys a program takes, as the bar says them. */
export function keysOf(drawing) {
  const on = Array.isArray(drawing?.on) ? drawing.on : []
  const out = []
  for (const h of on) {
    const name = String(h?.name || '')
    const words = String(h?.label || '').trim()
    if (!name || !words || SKIP.test(name)) continue
    const key = KEY_SHOW[name] || name
    const hit = out.find(x => x.words === words)
    if (hit) { if (!hit.keys.includes(key)) hit.keys.push(key) } else out.push({ keys: [key], words })
  }
  // arrows that share their words read as one key (↑↓), any other keys with a space between (< >)
  return out.map(x => ({ key: x.keys.every(k => ARROW.test(k)) ? x.keys.join('') : x.keys.join(' '), words: x.words }))
}

/** The keys of a focus stack, top first, as one line of the bar; a key the top takes is not said again below it. */
export function barText(drawings) {
  const seen = new Set()
  const segs = []
  for (const d of drawings || []) {
    for (const k of keysOf(d)) {
      if (seen.has(k.key)) continue
      seen.add(k.key)
      segs.push(`${k.key} ${k.words}`)
    }
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

/** The wants of a drawing that are not in `got`. */
export function wantsOpen(drawing, got) {
  return (Array.isArray(drawing?.wants) ? drawing.wants : []).filter(w => !got || !Object.prototype.hasOwnProperty.call(got, w.key))
}
