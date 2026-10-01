// What a view's head says it leaves out (src/files/ViewChrome.tsx ResidueLine), drawn with the app's stylesheets in
// headless Chromium: the lines or files its reader could not read read "1 unreadable line", "N unreadable lines" or
// "N unreadable files", in the same ink as the head's other items (the count of files beside it), never in the error
// colour, in the light and the dark theme.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

beforeAll(async () => {
  const script = await bundle(
    'view-head',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { flushSync } from 'react-dom'`,
      `import { ViewNotesLine } from '${src('files/ViewChrome.tsx')}'`,
      `let root = null`,
      `;(window as any).__head = (problems) => flushSync(() => {`,
      `  root ??= createRoot(document.getElementById('root')!)`,
      `  root.render(<div className="view-pane"><div className="view-pane-head"><div className="view-pane-title"><span className="view-pane-name">Runs</span><span className="view-pane-sub">`,
      `    <button type="button" className="view-pane-files">25 files</button>`,
      `    <ViewNotesLine ws="ws" name="Runs" notes={{ shown: null, problems }} shownLabels={[]} residueOpen={false} onResidue={() => {}} />`,
      `  </span></div></div></div>)`,
      `})`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const dir = path.dirname(script)
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.route('**/*', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>' })
    const file = path.join(dir, p)
    if (existsSync(file)) return route.fulfill({ status: 200, contentType: p.endsWith('.css') ? 'text/css' : 'text/javascript', body: readFileSync(file) })
    return route.fulfill({ status: 404, body: '' })
  })
  await page.goto(`${ORIGIN}/`)
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const lines = (n: number) => ({ count: n, examples: [{ ref: 'runs/r1/events.jsonl#L9', why: 'not JSON' }] })
const files = (n: number) => ({ count: n, examples: [{ ref: 'papers/a.pdf', why: 'not a PDF' }] })

for (const theme of ['light', 'dark']) {
  test(`the residue reads as unreadable lines or files, in the head's ink, in the ${theme} theme`, async () => {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    for (const [problems, words] of [
      [lines(1), '1 unreadable line'],
      [lines(3), '3 unreadable lines'],
      [files(2), '2 unreadable files'],
    ] as const) {
      await page.evaluate((p) => (window as any).__head(p), problems)
      const got = await page.evaluate(() => {
        const res = document.querySelector('.view-pane-residue')!
        const token = (v: string) => {
          const probe = document.createElement('span')
          probe.style.color = `var(${v})`
          document.body.append(probe)
          const c = getComputedStyle(probe).color
          probe.remove()
          return c
        }
        const inks = new Set([res, ...res.querySelectorAll('*')].map((e) => getComputedStyle(e).color))
        return { text: res.textContent, inks: [...inks], files: getComputedStyle(document.querySelector('.view-pane-files')!).color, tertiary: token('--text-tertiary'), negative: token('--status-negative') }
      })
      assert.equal(got.text, words)
      assert.deepEqual(got.inks, [got.files], `${words}: in the ink of the files beside it ${JSON.stringify(got)}`)
      assert.equal(got.files, got.tertiary, `${words}: the head's ink is the theme's tertiary text`)
      assert.notEqual(got.files, got.negative, `${words}: not in the error colour`)
    }
  })
}
