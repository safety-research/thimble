// hint.mjs: whether Squeeze is worth a visible hint on an object, and the words of that hint.
//
//   applies(object, {drawing}) -> a short phrase for the hint row, or null (drawing: the object as the person sees it)
//
// A long text gets "squeeze 41 lines". A squeeze gets "shorter" while a shorter version exists on its first
// dimension, else nothing (the shell shows the other verbs). No model call: this runs for every object drawn.
import { renderTerm } from '../../draw/term.js'
import { drawnLines, isLong, isSqueeze, originalOf } from './run.mjs'

export function applies(object, o = {}) {
  if (!object) return null
  if (isSqueeze(object)) {
    const d = object.data
    const dim = d.dims[0]
    const at = (d.at || {})[dim?.id] ?? 0
    return dim && at > 0 ? 'shorter' : null
  }
  // an object whose words are short is squeezed as the person sees it: its drawing's lines
  let shown = null
  try { shown = o.drawing ? drawnLines(renderTerm(o.drawing, { w: 96 })) : null } catch { shown = null }
  const orig = originalOf(object, shown)
  if (orig.spans.length < 2 || !isLong(orig.text, { lines: 8, chars: 700 })) return null
  return `squeeze ${orig.lines} lines`
}
