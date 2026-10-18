// An example card drawn by the canvas's own CardFace (canvas/bodies.tsx ExampleBody) with thimble's stylesheets, in a
// real browser, on a made-up JSON document of a few chat steps, one of them long: a quote deep inside a long record
// opens the record's fold at the quote, and Show all still shows the whole record.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

let browser: Browser
let page: Page

const LONG = [
  'Here is everything I have so far for Saturday.',
  'We meet at the north gate of Willow Park at eleven, and the walk from the car park to the lawn by the pond takes about ten minutes, so plan to arrive a little early.',
  'Maya is bringing two folding tables and the big striped blanket, and Theo said he can carry the cooler if someone else takes the speaker.',
  'The forecast says light cloud in the morning and sun after noon, with a small chance of a shower around four, so I packed a tarp just in case.',
  'For food we have sandwiches, a pasta salad, a fruit bowl, and lemonade in the glass jugs, and Priya offered to bake a lemon cake.',
  'Remember that the park rules ask us not to use grills on the lawn, so anything hot has to come ready to eat.',
  'We still need someone to pick up ice on the way, and I would like one more person to help set up the shade tent before the others arrive.',
  'The games box has a frisbee, a set of boules, and a deck of cards for anyone who wants a quiet corner.',
  'If it rains properly we can move under the bandstand roof, which fits about twenty people and is a short walk from the pond.',
  'Please bring your own water bottle so we can cut down on plastic cups.',
  'Last thing: the bins by the gate close at six, so we should start packing up at half past five.',
].join(' ')
const STEPS = [
  { role: 'user', content: LONG },
  { role: 'assistant', content: 'Thanks, that covers it. I will bring the ice and help with the shade tent.' },
]
/** what GET /corpora/{c}/ref answers for plan.json#/steps/<i> (refs._resolve_record) */
const resolved = (i: number) => ({
  ref: `plan.json#/steps/${i}`,
  kind: 'pointer',
  path: 'plan.json',
  record: STEPS[i],
  blocks: [{ kind: 'raw', text: JSON.stringify(STEPS[i], null, 2) }],
  excerpt: JSON.stringify(STEPS[i], null, 2).slice(0, 500),
  meta: { n: i + 1, line: 3 + 4 * i, end_line: 6 + 4 * i },
})

const THREE = ['north gate of Willow Park', 'Priya offered to bake a lemon cake', 'start packing up at half past five']
/** each card by name: its payload */
const CARDS: Record<string, unknown> = {
  three: { refs: ['plan.json#/steps/0', 'plan.json#/steps/0', 'plan.json#/steps/0'], quotes: THREE },
  deep: { refs: ['plan.json#/steps/0'], quotes: ['start packing up at half past five'] },
  two: { refs: ['plan.json#/steps/0', 'plan.json#/steps/1'] },
  told: { refs: ['plan.json#/steps/0'] },
}
/** each card's takeaway, by name: `told` quotes its record only there (bug hunt L5) */
const TAKEAWAYS: Record<string, string> = { told: 'The plan says to [["start packing up at half past five"|plan.json#/steps/0]].' }

beforeAll(async () => {
  const script = await bundle(
    'example-card',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { flushSync } from 'react-dom'`,
      `import { CardFace } from '${src('canvas/CardFace.tsx')}'`,
      `import { CanvasContext } from '${src('canvas/context.ts')}'`,
      `const ctx = { ws: 'w', filters: null, keep: null, concepts: new Map(), threadOf: () => ({ chatId: null, name: '', writable: false }), unread: new Set(), refresh: () => undefined, openThread: () => undefined }`,
      `window.__t = { card: (name, payload, takeaway) => {`,
      `  const el = document.createElement('div'); el.className = 'canvas-card-box'; el.dataset.state = name; el.style.width = '480px'; el.style.margin = '16px'; document.body.appendChild(el)`,
      `  const cell = { id: 'ex' + name, notebook: 'nb', kind: 'example', title: 'What did the picnic plan settle?', created_by: 'chat:main', ts: '', takeaway: takeaway || '', payload }`,
      `  flushSync(() => createRoot(el).render(<CanvasContext.Provider value={ctx}><CardFace cell={cell} width={440} label={{ concept: null, error: null }} /></CanvasContext.Provider>))`,
      `} }`,
    ],
    { loader: { '.css': 'css', '.woff2': 'empty', '.woff': 'empty' }, conditions: ['style'] },
  )
  const css = script.replace(/\.js$/, '.css')
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 560, height: 1600 } })
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    const p = url.pathname
    if (p === '/bundle.css') return route.fulfill({ status: 200, contentType: 'text/css', body: readFileSync(css) })
    const ref = url.searchParams.get('ref') ?? ''
    const m = /^plan\.json#\/steps\/(\d)$/.exec(ref)
    if (p.endsWith('/ref') && m) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(resolved(Number(m[1]))) })
    if (p.startsWith('/api/')) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"not found"}' })
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body></body></html>' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.addScriptTag({ path: script })
  for (const [name, payload] of Object.entries(CARDS)) await page.evaluate(([n, p, t]) => (window as any).__t.card(n, p, t), [name, payload, TAKEAWAYS[name] ?? ''] as const)
  for (const name of Object.keys(CARDS)) await page.waitForSelector(`[data-state="${name}"] [data-settled="true"] .bcell-q-body`)
  // a picture of the cards, for a reader who wants to look (not compared)
  const out = process.env.THIMBLE_EXAMPLE_SHOT
  if (out) writeFileSync(path.resolve(out), await page.screenshot({ fullPage: true }))
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** the card's entries, each with its address and its highlighted passages, and its fold: how far it is scrolled and
 * whether its first highlight and its first line show inside it */
const cardOf = (p: Page, name: string) =>
  p.evaluate((name) => {
    const card = document.querySelector<HTMLElement>(`[data-state="${name}"]`)!
    const shows = (box: DOMRect, el: Element | null) => {
      if (!el) return false
      const r = el.getClientRects()[0] ?? el.getBoundingClientRect()
      return r.top >= box.top - 1 && r.bottom <= box.bottom + 1
    }
    return [...card.querySelectorAll<HTMLElement>('.bcell-quote')].map((q) => {
      const clamp = q.querySelector<HTMLElement>('.bcell-clamp')!
      const box = clamp.getBoundingClientRect()
      return {
        address: q.querySelector('.bcell-address')?.textContent ?? '',
        marks: [...clamp.querySelectorAll('.hl')].map((h) => h.textContent),
        scrollTop: clamp.scrollTop,
        clipped: clamp.scrollHeight > clamp.clientHeight + 1,
        markShows: shows(box, clamp.querySelector('.hl')),
        startShows: shows(box, clamp.querySelector('.bcell-q-fields')),
        more: q.querySelector('.bcell-more')?.textContent ?? null,
      }
    })
  }, name)

test('a quote deep in a long record opens the fold at the quote; Show all shows the whole record', async () => {
  const [e] = await cardOf(page, 'deep')
  assert.deepEqual(e.marks, ['start packing up at half past five'])
  assert.ok(e.clipped && e.more === 'Show all', `the record is longer than its fold ${JSON.stringify(e)}`)
  assert.ok(e.scrollTop > 0 && e.markShows, `the fold opens at the quoted passage ${JSON.stringify(e)}`)
  assert.equal(e.startShows, false, "the record's start is above the fold")
  await page.click('[data-state="deep"] .bcell-more')
  const [all] = await cardOf(page, 'deep')
  assert.ok(all.more === 'Show less' && !all.clipped && all.scrollTop === 0, `Show all opens the whole record ${JSON.stringify(all)}`)
  assert.ok(all.startShows && all.markShows, 'the whole record shows, its start and the passage')
  await page.click('[data-state="deep"] .bcell-more')
  const [again] = await cardOf(page, 'deep')
  assert.ok(again.scrollTop > 0 && again.markShows, `Show less opens it at the quote again ${JSON.stringify(again)}`)
})

test("a quote that stands only in the takeaway, of a record the card's ref names whole, is marked and its fold opens at it (bug hunt L5)", async () => {
  const [e] = await cardOf(page, 'told')
  assert.deepEqual(e.marks, ['start packing up at half past five'])
  assert.ok(e.scrollTop > 0 && e.markShows, `the fold opens at the quoted passage ${JSON.stringify(e)}`)
})
