// thimble's card stylesheet: the look a custom card's page is drawn in (canvas/DataViz CustomFrame), placed before the
// page's own html, so a page of plain HTML takes the card face's type, sizes and colors on every paper, and the page's
// own styles still win where it sets them. Its colors are the paper's tokens, which the frame's head defines
// (lib/frame frameStyle). It styles elements only, never a class: a page needs no class of thimble's to take its look,
// and a page's own classes take nothing of it. The prompts say so (prompts/tools.md, add_card's `html`).
export const CARD_STYLE = [
  'h1,h2,h3,h4{margin:0 0 8px;font-weight:500;line-height:1.35;color:var(--text-primary)}',
  'h1{font-size:16px}h2{font-size:14px}h3,h4{font-size:13px}',
  'p{margin:0 0 8px}',
  'small{font-size:12px;color:var(--text-secondary)}',
  'ul,ol{margin:0 0 8px;padding-left:20px}',
  'hr{border:0;border-top:1px solid var(--border-subtle);margin:12px 0}',
  'table{border-collapse:collapse;font-variant-numeric:tabular-nums}',
  'th,td{padding:4px 12px 4px 0;text-align:left;vertical-align:top}',
  'th{font-size:12px;font-weight:500;color:var(--text-secondary);border-bottom:1px solid var(--border-subtle)}',
].join('')

/** The card stylesheet as a style element, for a frame's head. */
export function cardStyle(): string {
  return `<style>${CARD_STYLE}</style>`
}
