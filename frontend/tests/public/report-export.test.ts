// A page's Export (src/report/pageFrame.ts pageFile): the file is the page's own html whole, with the theme's tokens and
// faces the frame shows it with, and the document's title when the html names none.
import { expect, test } from 'vitest'
import { pageFile } from '../../src/report/pageFrame.ts'

const ROWS = Array.from({ length: 7 }, (_, i) => `<tr><td>P${i + 1}</td><td>${i * 4}</td></tr>`).join('')
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>td{border-bottom:1px solid var(--border-subtle)}</style></head><body><table>${ROWS}</table></body></html>`
const TOKENS = { '--text-primary': '#222', '--border-subtle': '#ddd', '--font-body': '"Hanken Grotesk", sans-serif' }

test('the exported page keeps every row, its own style and the tokens it reads', () => {
  const file = pageFile(PAGE, 'Seven runs side by side', 'light', TOKENS, '@font-face{font-family:"Hanken Grotesk"}')
  for (let i = 1; i <= 7; i++) expect(file).toContain(`<td>P${i}</td>`)
  expect(file).toContain('td{border-bottom:1px solid var(--border-subtle)}')
  expect(file).toContain('--border-subtle:#ddd')
  expect(file).toContain('@font-face{font-family:"Hanken Grotesk"}')
  expect(file).toContain('color-scheme:light')
  expect(file).toContain('<title>Seven runs side by side</title>')
  expect(file.indexOf('<title>')).toBeLessThan(file.indexOf('<body>'))
})

test('a page with a title of its own keeps it, and the document title is escaped', () => {
  const own = PAGE.replace('<head>', '<head><title>Matrix</title>')
  expect(pageFile(own, 'Other', 'dark', TOKENS).match(/<title>/g)).toHaveLength(1)
  expect(pageFile('<table></table>', 'Rows < columns & notes', 'dark', TOKENS)).toContain('<title>Rows &lt; columns &amp; notes</title>')
})
