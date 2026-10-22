// The screenshot tool's picture of a card (backend tools._shot_card_in_ui), taken as soon as the card is drawn rather
// than after a fixed wait. The page it loads opens the card its URL names still (src/lib/teleport refFromUrl, Shell):
// the real Canvas (src/canvas/Canvas.tsx) centres a card opened still but neither selects nor flashes it, while a
// chip's ref still does both. scripts/ui_shot.mjs --settle waits until the card is drawn (no body saying
// `data-settled="false"`) and shows any animation at its end, so a highlight that fades out is not half there. The
// live QA of 0.7.0 (2026-10-10): each card screenshot took 4.2-4.6 s, 2.2 s of it a fixed wait for the 1.6 s flash.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, FRONTEND, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page
const dir = mkdtempSync(path.join(tmpdir(), 'thimble-card-shot-'))

const note = (id: string, title: string) => ({ id, notebook: 'g', kind: 'note', title, takeaway: '', created_by: 'model', ts: '2026-10-10T12:00:00+00:00', payload: { text: title }, text: title })
const CANVAS = {
  groups: [{ id: 'g', title: 'Your work', parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst' }],
  cells: [note('a', 'Which wikis were defaced first?'), note('b', 'How many saves came in each day?')],
}

beforeAll(async () => {
  const script = await bundle(
    'card-shot',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { Canvas } from '${src('canvas/Canvas.tsx')}'`,
      `import { teleport } from '${src('lib/teleport.ts')}'`,
      `;(window as unknown as { teleport: typeof teleport }).teleport = teleport`,
      `createRoot(document.getElementById('root')!).render(<Canvas ws="w" active={true} />)`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  await page.route('**/*', async (route) => {
    const p = new URL(route.request().url()).pathname
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p === '/api/ws/w/canvas') return json(CANVAS)
    if (p === '/api/ws/w/canvas/comments') return json({ comments: [] })
    if (p === '/api/ws/w/chats' || p === '/api/ws/w/concepts' || p === '/api/ws/w/checks') return json([])
    if (p.startsWith('/api/')) return json({})
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root" style="position:absolute;inset:0;display:flex"></div></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.evaluate(() => localStorage.setItem('thimble:w:canvas-open', JSON.stringify(['g'])))
  await page.addScriptTag({ path: script })
  await page.waitForSelector('[data-cell="b"]')
  await page.waitForTimeout(300)
})

afterAll(async () => {
  await browser?.close()
  cleanup()
  rmSync(dir, { recursive: true, force: true })
})

/** Whether the card is flashed and whether it is selected, 300 ms after `ref` was opened. */
async function opened(ref: string, still: boolean): Promise<{ flashed: boolean; selected: boolean }> {
  await page.evaluate(([r, s]) => (window as unknown as { teleport: (ref: string, o: object) => void }).teleport(r as string, { still: s }), [ref, still])
  await page.waitForTimeout(300)
  const id = ref.replace('card:', '')
  return page.evaluate((cell) => {
    const card = document.querySelector(`article.canvas-card[data-cell="${cell}"]`)!
    return { flashed: card.classList.contains('anchor-flash'), selected: !!card.closest('.is-selected') }
  }, id)
}

test('a card opened still is neither selected nor flashed, while a chip\'s ref selects and flashes its card', async () => {
  assert.deepEqual(await opened('card:b', true), { flashed: false, selected: false })
  assert.deepEqual(await opened('card:a', false), { flashed: true, selected: true })
})

/** The color of the pixel at the middle of a png, read in the page. */
async function middle(png: Buffer): Promise<number[]> {
  const shot = await browser.newPage()
  try {
    await shot.setContent(`<img id="i" src="data:image/png;base64,${png.toString('base64')}">`)
    return await shot.evaluate(async () => {
      const img = document.getElementById('i') as HTMLImageElement
      await img.decode()
      const c = document.createElement('canvas')
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      const ctx = c.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      return Array.from(ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data.slice(0, 3))
    })
  } finally {
    await shot.close()
  }
}

test('ui_shot --settle shoots the card once its body is drawn, with a flash on it shown at its end', async () => {
  // a body that draws 1.5 s after the page is quiet, under a red flash that would take 30 s to fade
  const html = `<!doctype html><html><head><style>
    body { margin: 0; background: #fff }
    #card { position: relative; width: 300px; height: 200px; margin: 40px }
    #card::after { content: ''; position: absolute; inset: 0; background: #f00; animation: fade 30s linear forwards }
    @keyframes fade { from { opacity: 1 } to { opacity: 0 } }
    #body { width: 100%; height: 100%; background: #ccc }
    #body[data-settled='true'] { background: #0a0 }
  </style></head><body><div id="card"><div id="body" data-body="" data-settled="false"></div></div>
  <script>setTimeout(() => document.getElementById('body').dataset.settled = 'true', 2000)</script></body></html>`
  const file = path.join(dir, 'card.html')
  const out = path.join(dir, 'card.png')
  writeFileSync(file, html)
  const run = spawnSync('node', [path.join(FRONTEND, '..', 'scripts', 'ui_shot.mjs'), '--url', pathToFileURL(file).href, '--out', out, '--selector', '#card', '--settle', '--wait', '0', '--offline'], { encoding: 'utf8', timeout: 45_000 })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(JSON.parse(run.stdout).found, true)
  assert.deepEqual(await middle(readFileSync(out)), [0, 170, 0], 'the drawn body, with no red over it')
})
