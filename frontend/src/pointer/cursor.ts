// The ⌘ pointer as the system's own cursor: the normal arrow and I-beam drawn in the accent as CSS cursor images. Using
// the OS cursor means exactly one pointer shows, without lag, including over a view's frame, where a page-drawn arrow
// beside a hidden native cursor would double up. Pure; CmdPointer puts the values on the body and files/ViewerFrame
// gives the arrow to a view's page.

/** The normal pointer's outline, its tip at (3, 2) of a 22 box. */
const ARROW = 'M3 2 L3 18 L7.5 14 L10.5 20.5 L13 19.4 L10.1 13 L16 13 Z'
/** The I-beam: a stem with a curved serif at each end, centred on (11, 11). */
const BEAM = 'M8 3.5 Q 11 3.5 11 5.5 Q 11 3.5 14 3.5 M11 5.5 V16.5 M8 18.5 Q 11 18.5 11 16.5 Q 11 18.5 14 18.5'

/** The CSS box of each image, in px: the glyph's 22 and room for its shadow. */
export const CURSOR_BOX = 28
export const ARROW_HOT = { x: 3, y: 2 }
export const BEAM_HOT = { x: 11, y: 11 }

/** An SVG image of one glyph in `colour`, `scale` times the CSS box (2 for a screen of two device pixels a px). */
export function cursorSvg(glyph: 'arrow' | 'beam', colour: string, scale = 1): string {
  const size = CURSOR_BOX * scale
  const shadow = `<filter id="s" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="2" stdDeviation="1.6" flood-color="${colour}" flood-opacity="0.45"/></filter>`
  const shape =
    glyph === 'arrow'
      ? `<path d="${ARROW}" fill="${colour}" stroke="${colour}" stroke-width="1.4" stroke-linejoin="round"/>`
      : `<path d="${BEAM}" fill="none" stroke="${colour}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${CURSOR_BOX} ${CURSOR_BOX}"><defs>${shadow}</defs><g filter="url(#s)">${shape}</g></svg>`
}

const url = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`

/** A glyph as a CSS `cursor` value: the image at one and two device pixels a px with its hotspot, then the keyword
 * the browser shows when it takes no image. `imageSet` false gives the one-image form, for a browser without
 * image-set() in `cursor`. */
export function cursorValue(glyph: 'arrow' | 'beam', colour: string, imageSet = true): string {
  const hot = glyph === 'arrow' ? ARROW_HOT : BEAM_HOT
  const keyword = glyph === 'arrow' ? 'default' : 'text'
  const one = url(cursorSvg(glyph, colour, 1))
  const image = imageSet ? `image-set(${one} 1x, ${url(cursorSvg(glyph, colour, 2))} 2x)` : one
  return `${image} ${hot.x} ${hot.y}, ${keyword}`
}

export interface CmdCursors {
  arrow: string
  beam: string
}

let memo: { key: string; cursors: CmdCursors } | null = null

/** The ⌘ cursors in the accent `colour`, in the form this browser takes (image-set() when it supports it there). */
export function cmdCursors(colour: string): CmdCursors {
  const set = typeof CSS === 'undefined' || typeof CSS.supports !== 'function' || CSS.supports('cursor', cursorValue('arrow', colour))
  const key = `${colour}|${set}`
  if (memo?.key !== key) memo = { key, cursors: { arrow: cursorValue('arrow', colour, set), beam: cursorValue('beam', colour, set) } }
  return memo.cursors
}
