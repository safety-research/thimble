// The key that places a card freely on the canvas (src/canvas/Canvas.tsx, src/lib/platform.ts freeKeyHeld), in a real
// browser with the real Canvas: of ⌘ (Ctrl off a Mac) and ⌥ (Alt), the one Settings did not pick as the ask key. With
// ⌘ picked (the default), a card dragged with Alt held is placed free where it is dropped.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let script = ''
let css = ''

type Pos = { x: number; y: number }
const cell = (id: string, notebook: string, height: number, pos: Pos | null = null) => ({ id, notebook, kind: 'note', title: `Card ${id}`, takeaway: '', created_by: 'user', ts: '2026-10-08T12:00:00+00:00', payload: { text: id }, text: id, height, pos })
const board = () => ({
  groups: [
    { id: 'g', title: 'Your work', parent: null, kind: 'sequence', anchor: null, chat: null, role: 'analyst' },
    { id: 'l', title: '', parent: null, kind: 'loose', anchor: null, chat: null, role: 'analyst' },
  ],
  cells: [cell('a', 'g', 200), cell('b', 'g', 200), cell('c', 'g', 200), cell('x', 'l', 200, { x: 900, y: 80 })],
})

beforeAll(async () => {
  script = await bundle(
    'canvas-free-key',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { Canvas } from '${src('canvas/Canvas.tsx')}'`,
      `import { setAskKey } from '${src('lib/platform.ts')}'`,
      `;(window as unknown as { setAskKey: typeof setAskKey }).setAskKey = setAskKey`,
      `createRoot(document.getElementById('root')!).render(<Canvas ws="w" active={true} />)`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  css = readFileSync(script.replace(/\.js$/, '.css'), 'utf8')
  browser = await launch()
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** A page of the board with Your work open at 50%, the ask key picked as `ask`; the moves the page asks for. */
async function open(ask: 'meta' | 'alt'): Promise<{ page: Page; moves: Record<string, unknown>[] }> {
  const canvas = board()
  const moves: Record<string, unknown>[] = []
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  await page.route('**/*', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: css })
    if (p === '/api/ws/w/canvas') return json(canvas)
    if (p === '/api/ws/w/cells/move') {
      moves.push(JSON.parse(req.postData() || '{}'))
      return json([])
    }
    if (p === '/api/ws/w/canvas/comments') return json({ comments: [] })
    if (p === '/api/ws/w/chats' || p === '/api/ws/w/concepts' || p === '/api/ws/w/checks') return json([])
    if (p.startsWith('/api/')) return json({})
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root" style="position:absolute;inset:0;display:flex"></div></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.evaluate(() => {
    localStorage.setItem('thimble:w:canvas-view', JSON.stringify({ x: 0, y: 0, scale: 0.5 }))
  })
  await page.addScriptTag({ path: script })
  await page.evaluate((k) => (window as unknown as { setAskKey: (k: string) => void }).setAskKey(k), ask)
  await page.waitForSelector('[data-cell="x"]')
  await page.waitForTimeout(300)
  return { page, moves }
}

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number }
const box = (page: Page, sel: string): Promise<Box> => page.evaluate((s) => document.querySelector<HTMLElement>(s)!.getBoundingClientRect().toJSON(), sel)

/** Drag card x to the gap between a and b, in steps, with `key` held throughout. */
async function dragToGap(page: Page, key: 'Alt' | 'Control' | null) {
  const [x, a, b] = await Promise.all(['x', 'a', 'b'].map((id) => box(page, `[data-cell="${id}"]`)))
  const start = { x: x.left + x.width / 2, y: x.top + x.height / 2 }
  const to = { x: a.left + a.width / 2, y: (a.bottom + b.top) / 2 }
  if (key) await page.keyboard.down(key)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(start.x + ((to.x - start.x) * i) / 8, start.y + ((to.y - start.y) * i) / 8)
  await page.mouse.up()
  if (key) await page.keyboard.up(key)
  await page.waitForTimeout(400)
}

test('with ⌘ picked as the ask key, Alt held places the card free', async () => {
  const { page, moves } = await open('meta')
  await dragToGap(page, 'Alt')
  assert.equal(moves.length, 1)
  const m = moves[0] as { cells: string[]; group: string; pos?: Pos; after?: string }
  assert.deepEqual([m.cells, m.group, m.after], [['x'], 'g', undefined])
  assert.ok(m.pos && typeof m.pos.x === 'number', `placed free: ${JSON.stringify(m)}`)
  await page.close()
})
