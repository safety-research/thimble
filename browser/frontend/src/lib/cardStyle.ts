// thimble's card stylesheet: the look a custom card's page is drawn in (canvas/DataViz CustomFrame), placed before the
// page's own html, so a page of plain HTML takes the card face's type, sizes and colors on every paper, and the page's
// own styles still win where it sets them. Its colors are the paper's tokens, which the frame's head defines
// (lib/frame frameStyle). Besides the elements, it names the few things cards draw, which a page uses by class, each
// with thimble's prefix (CARD_PREFIX), so a page that names a class of its own `label` or `steps` takes nothing of them:
//
//   tc-title  a heading inside the card, in the question's type
//   tc-label  what a value or a part is, in the secondary ink, as written (no capitals, no letter spacing)
//   tc-value  a number the card is about, large, its digits tabular
//   tc-box    a part of the card set apart by a hairline, the card face's own
//   tc-steps  a row of parts in order, an arrow between each two
//
// The prompts name the classes (prompts/tools.md, add_card's `html`), and CARD_CLASSES is the list they may name.
export const CARD_PREFIX = 'tc-'
export const CARD_CLASSES = ['tc-title', 'tc-label', 'tc-value', 'tc-box', 'tc-steps'] as const

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
  '.tc-title{margin:0 0 8px;font-size:14px;font-weight:500;line-height:1.35;color:var(--text-primary)}',
  '.tc-label{font-size:12px;line-height:1.4;color:var(--text-secondary)}',
  '.tc-value{font-size:22px;font-weight:500;line-height:1.25;font-variant-numeric:tabular-nums;color:var(--text-primary)}',
  '.tc-box{padding:10px 12px;border:1px solid var(--border-subtle);border-radius:var(--radius-ui,6px)}',
  '.tc-steps{display:flex;flex-wrap:wrap;align-items:stretch;gap:8px 24px}',
  '.tc-steps>*{position:relative;min-width:0}',
  ".tc-steps>*+*::before{content:'→';position:absolute;left:-17px;top:50%;transform:translateY(-50%);color:var(--text-tertiary)}",
].join('')

/** The card stylesheet as a style element, for a frame's head. */
export function cardStyle(): string {
  return `<style>${CARD_STYLE}</style>`
}
