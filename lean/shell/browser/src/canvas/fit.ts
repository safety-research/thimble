// fit.ts: the canvas's Fit, with a floor. 0.9's Fit shows the whole board however small its cards get. On lean's
// canvas a card is a chart and its words, so Fit stops at the zoom where the words still read; the board then starts
// at its top left, and the person pans to the rest (the wheel, a drag on the board, the minimap). Pure.

export interface FitView {
  x: number
  y: number
  scale: number
}
export interface FitRect {
  x: number
  y: number
  w: number
  h: number
}

/** The zoom under which a card's words stop reading: its 13 px text at about 9 px. */
export const READABLE_FIT = 0.7

/** `fit` (0.9's view of the whole board) when its zoom reads, else the board at READABLE_FIT from its top left (centred
 *  across or down when that side fits). `right` is the room the controls take at the right. */
export function readableFit(fit: FitView, content: FitRect | null, vw: number, vh: number, pad = 48, right = 0, floor = READABLE_FIT): FitView {
  if (!content || !(fit.scale < floor)) return fit
  const s = floor
  const w = Math.max(100, vw - right)
  const x = content.w * s > w - 2 * pad ? pad - content.x * s : (w - content.w * s) / 2 - content.x * s
  const y = content.h * s > vh - 2 * pad ? pad - content.y * s : (vh - content.h * s) / 2 - content.y * s
  return { scale: s, x, y }
}
