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
//   step(list, at, dir)    -> the next position (dir 1) or the one before (dir -1), null past the first or the last;
//                             from none, the first mark of the latest message that has marks (dir 1) or the last mark
//   stepFrom(list, k, dir) -> the same from the k-th position of any list (marks and cards)
//   open(frame)            -> a tray showing that frame alone
//   push(tray, frame)      -> the frame over the tray's top (the same frame twice in a row is not stacked)
//   back(tray)             -> the tray with its top removed, or null when that was the last card
//   top(tray)              -> the frame shown, or null
//   moveTo(tray, frame)    -> the tray with the first card replaced (tab to the next mark leaves the nested cards)
//   markNow(rec, frame)    -> the index of the frame's mark in the message's marks as they are now: a mark that came
//                             in before it (an explainer that arrived while the person steps) moves it on

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
  return stepFrom(list, k, dir)
}

/** The index of a frame's mark in the message's marks now. A frame keeps the index its mark had when it opened; a mark
 *  added before it since (an explainer the observer saved) moves its mark on, so the frame is found by what it shows:
 *  a gloss by its id, a citation or a series by its kind and ref, the one nearest its old index. */
export function markNow(rec, frame) {
  const marks = rec && Array.isArray(rec.marks) ? rec.marks : []
  if (!frame || frame.i == null) return -1
  const kind = frame.kind === 'gloss' ? 'gloss' : frame.kind === 'spark' ? 'spark' : 'cite'
  // a citation the healing pass re-pointed opens its new place (`ref`) and keeps the ref as written (`wrote`); the
  // message's own marks may hold either, so the frame's mark is the one that names either of its refs. By its new ref
  // alone, it would be found at another citation of that place, and ] would go back there.
  const refs = new Set([frame.ref, frame.wrote].filter(Boolean))
  const shows = m => !!m && (kind === 'gloss' ? m.kind === 'gloss' && !!frame.gloss && m.gloss === frame.gloss.id
    : (m.kind === 'spark' ? 'spark' : m.kind === 'gloss' ? 'gloss' : 'cite') === kind && (refs.has(m.ref) || (!!m.wrote && refs.has(m.wrote))))
  if (shows(marks[frame.i])) return frame.i
  let best = -1
  marks.forEach((m, j) => { if (shows(m) && (best < 0 || Math.abs(j - frame.i) < Math.abs(best - frame.i))) best = j })
  return best < 0 ? frame.i : best
}

// The steps stop at the ends: ] on the newest reply's last stop stays there. Going on into the oldest reply would open
// a mark far above the screen, and the keys would then act on that reply, out of sight.
export function stepFrom(list, k, dir = 1) {
  const j = k + (dir > 0 ? 1 : -1)
  return list && j >= 0 && j < list.length ? list[j] : null
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
