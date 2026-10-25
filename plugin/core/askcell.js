// askcell.js: the margin cell that asks a side thread about what stands beside it (0.10's shell/view.ts margin). Pure:
// no `$`. marks/view.ts draws it left of each passage of a reply (a card asks with the words at its title's right);
// the threads (threads/seam.ts) say whether the thing has a thread and open it.
//
//   askCell(els, o)        the 2 columns: a purple ↳ once a side thread was asked about the thing, which opens it; else
//                          `glyph` (the reply's ● or a blank) with a purple ? over it, shown only while the pointer is
//                          over the row (the row's keyed Box scopes the hover), which asks about it. The mark takes
//                          the glyph's own cell, so it never adds indent
//   passageLabel(text)     a passage's few words: a heading's section by its heading, else its first words
//   quiet(key, over)       a press's `hover`: a group of its own, no inverse, its words underlined

/** A short, stable name for a string (Claude Code takes at most 64 characters for a hover group). */
function scopeOf(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return `q-${h.toString(36)}`
}

/** The `hover` of a quiet press: no inverse (Claude Code draws a plain Button inverse under the pointer), its words
 *  underlined; `over` adds to it or replaces it. */
export function quiet(key, over = {}) {
  return { scope: scopeOf(String(key)), inverse: false, underline: true, ...over }
}

/**
 * The cell. o: {key, label, has, press, color, glyph?}: `color` is thimble's (core/theme.ts accent()); `label` names the thing in words (`"Two runs failed."`, `the card
 * "Saves per day"`); `has`: a side thread was asked about it; `press` asks about it, or opens its thread.
 */
export function askCell(els, o) {
  const glyph = o.glyph ?? ' '
  if (o.has) return els.Box({ width: 2, flexShrink: 0, children: [els.Button({ key: `${o.key}-asked`, plain: true, label: `open the thread about ${o.label}`, onPress: o.press, hover: quiet(`${o.key}-asked`), children: [els.Text({ color: o.color, children: '↳' })] })] })
  const q = els.Button({ key: `${o.key}-ask`, plain: true, label: `ask about ${o.label}`, onPress: o.press, hover: quiet(`${o.key}-ask`), children: [els.Text({ color: o.color, bold: true, children: '?' })] })
  return els.Box({ width: 2, flexShrink: 0, children: [els.Text({ children: glyph }), els.Box({ width: 1, display: 'none', hover: { display: 'flex' }, position: 'absolute', top: 0, left: 0, children: [q] })] })
}

/** A passage's few words: a heading's section by its heading, else its first words. */
export function passageLabel(text) {
  const first = String(text).split('\n')[0].trim()
  const head = /^#{1,6}\s+(.*)$/.exec(first)
  const words = (head ? head[1] : first).replace(/[*_`#>]|\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\s*(?:[-+]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim()
  const cut = [...words].length > 40 ? [...words].slice(0, 39).join('') + '…' : words
  return head ? `the section "${cut}"` : `"${cut}"`
}
