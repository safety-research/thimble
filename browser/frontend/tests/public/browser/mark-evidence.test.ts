// A mark's evidence label in a real browser, with thimble's own stylesheets (src/marks/Mark.tsx, styles/marks.css): a
// long cited line of a README and a long line of a call's output wrap inside the label, which stays at most 560 px
// wide, so no line runs past its edge and the highlighted words show inside it without a scroll.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

beforeAll(async () => {
  const script = await bundle(
    'mark-evidence',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { ChatMarkdown } from '${src('chat/markdown.tsx')}'`,
      `const words = 'what was actually said'`,
      `const paragraph = Array.from({ length: 70 }, (_, i) => 'word' + i + ' and').join(' ') + ' A node keeps what was actually said, verbatim and dated. ' + Array.from({ length: 70 }, (_, i) => 'more' + i + ' text').join(' ')`,
      // the README line as the check keeps it: 600 characters from 150 before the words, "…" where it is cut
      `const at = paragraph.indexOf(words), a = at - 150`,
      `const line = { n: 55, text: '…' + paragraph.slice(a, a + 600) + '…', highlight: [151, 151 + words.length] as [number, number] }`,
      `const quote = { kind: 'quote' as const, file: 'README.md', line: 55, lines: [{ n: 54, text: '' }, line, { n: 56, text: '' }] }`,
      `const output = ['5:**New agent: read the notes first.** ' + paragraph.slice(0, 300), '8:d55e920 ' + paragraph, '9:done'].join('\\n')`,
      `const o = output.indexOf(words)`,
      `const computed = { kind: 'computed' as const, code: 'git log --oneline | grep -n said', output, highlight: [[o, o + words.length]] as [number, number][], by: 'check' }`,
      `const item = (k: number, evidence: object) => ({ n: k + 1, piece: 0, k, words, sentence: '', status: 'verified' as const, shown: words, evidence })`,
      `createRoot(document.getElementById('root')!).render(<div className="chat-text" style={{ width: 300, padding: 16 }}><ChatMarkdown text={'In the notes, [' + words + '](#); in the log, [' + words + '](#).'} checks={[item(0, quote), item(1, computed)]} /></div>)`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  await page.route('**/*', async (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
  await page.waitForSelector('.mark-words')
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** The k-th mark's label, opened: its width, and whether a line runs past it or the highlighted words lie outside it. */
const label = async (k: number) => {
  await page.locator('.mark-words').nth(k).click()
  await page.waitForSelector('.mark-pop .cite-cell')
  const got = await page.evaluate(() => {
    const pop = document.querySelector('.mark-pop')!
    const P = pop.getBoundingClientRect()
    const lines = pop.querySelector('.refchip-lines')!
    const words = pop.querySelector('.cite-cell')!.getBoundingClientRect()
    return {
      width: P.width,
      overflow: lines.scrollWidth - lines.clientWidth,
      rows: Math.round(pop.querySelector('.cite-cell')!.closest('.refchip-line')!.getBoundingClientRect().height / parseFloat(getComputedStyle(lines).lineHeight)),
      inside: words.left >= P.left && words.right <= P.right && words.top >= P.top && words.bottom <= P.bottom,
    }
  })
  await page.keyboard.press('Escape')
  await page.mouse.click(990, 690)
  await page.waitForFunction(() => !document.querySelector('.mark-pop'))
  return got
}

test('a long cited line wraps inside the label, its quoted words in view', async () => {
  const q = await label(0)
  assert.ok(q.width <= 560 && q.overflow <= 1 && q.rows > 1 && q.inside, `the README line ${JSON.stringify(q)}`)
})

test("a long line of a call's output wraps inside the label, its highlighted words in view", async () => {
  const c = await label(1)
  assert.ok(c.width <= 560 && c.overflow <= 1 && c.rows > 1 && c.inside, `the output line ${JSON.stringify(c)}`)
})
