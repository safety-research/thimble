// text.js: how many cells a text takes in a terminal, and a text cut to a number of cells. Pure: the hooks module, the
// card runner and the tests import it, so every drawing of thimble wraps and cuts text alike.
//
//   textWidth(s)   the cells a string takes: 2 for a wide character (CJK, most emoji), 0 for a combining mark or a
//                  zero-width character, 1 for the rest
//   cut(s, n, middle)  s in at most n cells, with `…` where it was cut: at its end, or in its middle

/** A code point's cells: 0 for combining marks and zero-width characters, 2 for wide and fullwidth ones. */
function charWidth(cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x200d ||
    (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x1dc0 && cp <= 0x1dff) || (cp >= 0x20d0 && cp <= 0x20ff) || (cp >= 0xe0100 && cp <= 0xe01ef)) return 0
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x1f680 && cp <= 0x1f6ff) || (cp >= 0x20000 && cp <= 0x3fffd) ||
    cp === 0x231a || cp === 0x231b || cp === 0x23f0 || cp === 0x23f3 || cp === 0x2614 || cp === 0x2615 ||
    (cp >= 0x2648 && cp <= 0x2653) || cp === 0x267f || cp === 0x2693 || cp === 0x26a1 || cp === 0x26aa || cp === 0x26ab ||
    cp === 0x26bd || cp === 0x26be || cp === 0x26c4 || cp === 0x26c5 || cp === 0x26ce || cp === 0x26d4 || cp === 0x26ea ||
    cp === 0x26f2 || cp === 0x26f3 || cp === 0x26f5 || cp === 0x26fa || cp === 0x26fd || cp === 0x2705 || cp === 0x270a ||
    cp === 0x270b || cp === 0x2728 || cp === 0x274c || cp === 0x274e || (cp >= 0x2753 && cp <= 0x2755) || cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) || cp === 0x27b0 || cp === 0x27bf || cp === 0x2b1b || cp === 0x2b1c || cp === 0x2b50 ||
    cp === 0x2b55 || (cp >= 0x1f1e6 && cp <= 0x1f1ff) || (cp >= 0x1fa70 && cp <= 0x1faff)) return 2
  return 1
}

export function textWidth(s) {
  let w = 0
  for (const ch of String(s)) w += charWidth(ch.codePointAt(0))
  return w
}

/** The first characters of a list of them that fit in n cells. */
function fit(chars, n) {
  let out = ''
  let w = 0
  for (const ch of chars) {
    const cw = textWidth(ch)
    if (w + cw > n) break
    out += ch
    w += cw
  }
  return out
}

/** s in at most n cells, with `…` where it was cut: at its end, or with `middle` after its first third, so that names
 *  that start alike keep the end that tells them apart (`annot…underspecified-fan-out`). */
export function cut(s, n, middle = false) {
  const t = String(s ?? '')
  if (textWidth(t) <= n) return t
  if (n <= 0) return ''
  if (!middle) return `${fit(t, n - 1)}…`
  const left = Math.floor((n - 1) / 3)
  return `${fit(t, left)}…${[...fit([...t].reverse(), n - 1 - left)].reverse().join('')}`
}
