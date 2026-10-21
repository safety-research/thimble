// hover.js: how a press looks under the pointer. Claude Code draws a plain Button inverse while the pointer is over it,
// which turns a label into a solid block and a bar into a thin line. Every press thimble draws opts out: it names a
// hover group of its own (`scope`), and while the pointer is over any member of that group the overrides apply: no
// inverse, and a light cue that keeps the words readable (an underline), or for a mark a brighter shade of its color.
//   quiet(key, over) -> a Button's or a Text's `hover`: { scope, inverse: false, underline: true, ...over }
//   scopeOf(key) -> the group's name for a key: short and stable (Claude Code takes at most 64 characters)

/** A short, stable name for a string. */
export function scopeOf(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return `q-${h.toString(36)}`
}

/** The `hover` of a quiet press: no inverse, its words underlined; `over` adds to it or replaces it. */
export function quiet(key, over = {}) {
  return { scope: scopeOf(String(key)), inverse: false, underline: true, ...over }
}
