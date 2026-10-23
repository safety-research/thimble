// A rehype pass shared by every markdown thimble renders (a reply, a note card, a text/markdown output, a README): a
// table body cell that holds a number gets the class `mono`, the class the stylesheets give a numeric cell (mono,
// right aligned) in every table thimble draws, so numbers read one way everywhere.
import type { Element, Root, Text } from 'hast'

const NUMERIC = /^[-+−]?[$€£]?\d[\d,_]*(\.\d+)?%?$|^[-+−]?\d+(\.\d+)?e[-+]?\d+$|^(true|false|null|nan|none)$/i
function textOf(node: Element | Text): string {
  if (node.type === 'text') return node.value
  return node.children.map((c) => (c.type === 'text' || c.type === 'element' ? textOf(c) : '')).join('')
}
function markNumericCells(node: Root | Element): void {
  for (const child of node.children) {
    if (child.type !== 'element') continue
    if (child.tagName === 'td' && NUMERIC.test(textOf(child).trim())) {
      const cls = child.properties.className
      child.properties.className = Array.isArray(cls) ? [...cls, 'mono'] : cls ? [String(cls), 'mono'] : ['mono']
    } else markNumericCells(child)
  }
}

/** rehype plugin: a table body cell that holds a number (or a boolean, or null) gets the class `mono`, the class the
 * stylesheets give a numeric cell (mono, right aligned) in every table thimble draws. */
export function rehypeNumericCells() {
  return (tree: Root) => {
    markNumericCells(tree)
  }
}
