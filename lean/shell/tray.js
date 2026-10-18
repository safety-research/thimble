// tray.js: the tray's state, as pure functions. No `$`, no Node, no DOM.
//
// The tray is one small panel above the prompt. It shows one card at a time: a citation's source card or a gloss's
// explainer card. What it shows is the top of a stack, so a mark inside a card opens a card over it, and back (⌫)
// returns to the card under it; back from the first card closes the tray.
//
//   a frame   {row, i}                   the i-th mark of a message's record (row: the message's row key)
//             {ref, label, kind: 'cite'}  a mark inside a card (a nested citation)
//   a tray    {stack: [frame, ...]} or null
//
//   order(messages)        -> every mark position [{row, i}] in reading order; messages: [{row, marks}], oldest first
//   step(list, at, dir)    -> the next position (dir 1) or the one before (dir -1), wrapping; from none, the first
//                             mark of the latest message that has marks (dir 1) or the last mark (dir -1)
//   open(frame)            -> a tray showing that frame alone
//   push(tray, frame)      -> the frame over the tray's top (the same frame twice in a row is not stacked)
//   back(tray)             -> the tray with its top removed, or null when that was the last card
//   top(tray)              -> the frame shown, or null
//   moveTo(tray, frame)    -> the tray with the first card replaced (tab to the next mark leaves the nested cards)

export function order(messages) {
  const out = []
  for (const m of messages || []) (m.marks || []).forEach((_, i) => out.push({ row: m.row, i }))
  return out
}

const same = (a, b) => !!a && !!b && (a.ref != null || b.ref != null ? a.ref === b.ref && !!a.ref : a.row === b.row && a.i === b.i)

export function step(list, at, dir = 1) {
  if (!list || !list.length) return null
  const k = at && at.row != null ? list.findIndex(p => p.row === at.row && p.i === at.i) : -1
  if (k < 0) {
    if (dir > 0) {
      const last = list[list.length - 1].row
      return list.find(p => p.row === last)
    }
    return list[list.length - 1]
  }
  return list[(k + (dir > 0 ? 1 : -1) + list.length) % list.length]
}

export const open = frame => (frame ? { stack: [frame] } : null)

export function push(tray, frame) {
  if (!frame) return tray
  if (!tray || !tray.stack || !tray.stack.length) return open(frame)
  if (same(tray.stack[tray.stack.length - 1], frame)) return tray
  return { ...tray, stack: [...tray.stack, frame].slice(-12) }
}

export function back(tray) {
  if (!tray || !tray.stack || tray.stack.length <= 1) return null
  return { ...tray, stack: tray.stack.slice(0, -1) }
}

export const top = tray => (tray && tray.stack && tray.stack.length ? tray.stack[tray.stack.length - 1] : null)

export function moveTo(tray, frame) {
  if (!frame) return tray
  return open(frame)
}

/** The transcript position the tray stands on: the first card's mark, the place `]` moves on from. */
export const base = tray => (tray && tray.stack && tray.stack.length && tray.stack[0].row != null ? tray.stack[0] : null)
