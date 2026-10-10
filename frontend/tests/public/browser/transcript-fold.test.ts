// Files' Transcript mode in a real browser (src/files/Reader.tsx, views/transcript.tsx, fold.ts, useFilterBy.ts,
// FilterBy.tsx): the reader over a Claude Code stream answered in the page, as an agent's transcript reads. A tool call,
// a tool result, a system record and a message of more than a few lines open folded to one row as tall as the Table
// mode's, the head and the start of the words or the call on it; a short reply shows whole. The chevron at the start of
// a record's head opens and folds it, turned, in one place. A Bash command that holds a whole file as one JSON string
// opens clipped to a few lines with Show more under it, not as a wall of text, and Show less in the same place clips it
// again, by a click or the keyboard. Collapse all and Expand
// all in the mode's top row fold and open every record, and the choice and a record opened by itself are kept for the
// file. Filter by, before Color by, filters by a key of the records: a value turned off hides its records, a long run of
// them says how many it hides, and Show brings them back; the choice is kept for the file.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, ORIGIN, src } from './page.ts'

const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' }
let browser: Browser
let page: Page
let dir = ''

beforeAll(async () => {
  const script = await bundle(
    'transcript-fold',
    [
      `import '${src('styles/index.css')}'`,
      `import { createRoot } from 'react-dom/client'`,
      `import { Reader } from '${src('files/Reader.tsx')}'`,
      `const w = window as any`,
      `const ts = (i) => '2026-10-01T12:' + String(i % 60).padStart(2, '0') + ':00Z'`,
      `const msg = (type, content) => ({ type, session_id: 's1', message: { role: type, content } })`,
      // line 4: a Bash command holding a whole file in one string, 8,000 characters on one line of its JSON
      `const FILE = Array.from({ length: 160 }, (_, i) => '#define SHIM_' + i + ' ' + i + ' /* offline shim */').join('\\n')`,
      `const RECORDS = [`,
      `  { type: 'system', subtype: 'init', session_id: 's1', cwd: '/work/repo' },`,
      `  msg('user', 'You are agent 01 in a swarm.\\nRead the issue.\\nFix the build.\\nOpen a pull request.\\nReport back.\\nDo not push to main.'),`,
      `  msg('assistant', [{ type: 'text', text: 'I will look at the build first.' }]),`,
      `  msg('assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: "cat > shim.h <<'EOF'\\n" + FILE + '\\nEOF', description: 'Write the shim' } }]),`,
      `  msg('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'wrote shim.h' }]),`,
      // lines 6 to 35: a run of thirty assistant replies, which a filter on type hides as one run
      `  ...Array.from({ length: 30 }, (_, i) => msg('assistant', [{ type: 'text', text: 'Step ' + (i + 1) + ' done.' }])),`,
      `  msg('user', [{ type: 'tool_result', tool_use_id: 't2', content: 'all tests passed' }]),`,
      `]`,
      `const TOTAL = RECORDS.length`,
      `const rec = (i) => ({ line: i, record: { ...RECORDS[i - 1], timestamp: ts(i) }, blocks: [{ kind: 'raw', text: JSON.stringify(RECORDS[i - 1]) }], meta: {} })`,
      `const page = (a, b) => { const out = []; for (let i = Math.max(1, a); i <= Math.min(TOTAL, b); i++) out.push(rec(i)); return { path: 'agent-01.jsonl', kind: 'text', total_lines: TOTAL, start: Math.max(1, a), records: out, transcript: { format: 'stream', score: 1 } } }`,
      `const count = (k) => { const c = {}; RECORDS.forEach((r) => (c[r[k]] = (c[r[k]] || 0) + 1)); return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, n })) }`,
      `const answer = (u) => {`,
      `  const p = u.pathname, s = u.searchParams`,
      `  if (p.endsWith('/source/around')) { const l = +s.get('line'); return page(l - +s.get('before'), l + +s.get('after')) }`,
      `  if (p.endsWith('/source/lines')) return { path: 'agent-01.jsonl', total_lines: TOTAL, estimated: false, indexed: 1 }`,
      `  if (p.endsWith('/source/keys')) return { path: 'agent-01.jsonl', total: TOTAL, bins: 0, partial: false, bytes: [], keys: [{ key: 'type', values: count('type'), more: { values: 0, n: 0 }, none: 0, at: [] }] }`,
      `  if (p.endsWith('/source')) { const a = +s.get('start'); return page(a, a + +s.get('count') - 1) }`,
      `  if (p.endsWith('/labels')) return []`,
      `  return null`,
      `}`,
      `w.fetch = async (url) => {`,
      `  const got = answer(new URL(String(url), location.origin))`,
      `  if (got == null) return new Response(JSON.stringify({ detail: 'not here' }), { status: 404, headers: { 'content-type': 'application/json' } })`,
      `  return new Response(JSON.stringify(got), { status: 200, headers: { 'content-type': 'application/json' } })`,
      `}`,
      `const labels = { all: [], on: [], focus: null, setFocus() {}, byId: new Map(), presence: new Map(), toggle() {}, setClasses() {}, setColour() {}, save: async () => ({}), remove: async () => {} }`,
      `const root = createRoot(document.getElementById('root')!)`,
      `w.__mount = (n) => root.render(<div key={n} data-mount={n} style={{ height: 1400, display: 'flex' }}><div className="files-main"><Reader workspace="ws" path="agent-01.jsonl" kind="text" labels={labels} lead={null} /></div></div>)`,
      `w.__mount(0)`,
    ],
    {
      loader: { '.css': 'css', '.woff2': 'file', '.woff': 'file', '.json': 'json' },
      conditions: ['style'],
      assetNames: '[name]-[hash]',
      publicPath: '/',
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.BASE_URL': '"/"' },
    },
  )
  dir = path.dirname(script)
  browser = await launch()
  page = await browser.newPage({ viewport: { width: 1100, height: 1500 } })
  page.on('pageerror', (e) => console.warn('page error:', e.message))
  await page.route('**/*', (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body style="margin:0"><div id="root"></div><script src="/bundle.js"></script></body></html>' })
    const file = path.join(dir, p)
    if (existsSync(file)) return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
    return route.fulfill({ status: 404, body: '' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.waitForSelector('.reader-card[data-line="3"]', { timeout: 20000 })
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

const card = (line: number) => `.reader-card[data-line="${line}"]`
const folded = (line: number) => page.evaluate((s) => document.querySelector(s)?.classList.contains('is-folded') ?? null, card(line))
const height = (sel: string) => page.evaluate((s) => document.querySelector(s)!.getBoundingClientRect().height, sel)
const box = (sel: string) => page.evaluate((s) => document.querySelector(s)!.getBoundingClientRect().toJSON() as DOMRect, sel)
/** Draw the reader again from scratch, as on opening the file again, and wait for its record on `line`. */
const remount = async (n: number, line: number) => {
  await page.evaluate((k) => (window as any).__mount(k), n)
  await page.waitForSelector(`[data-mount="${n}"] ${card(line)}`)
}

test('tool calls, results and long messages open folded to one row; a short reply shows whole', async () => {
  assert.equal(await folded(2), true, 'the six-line prompt is folded')
  assert.equal(await folded(3), false, 'the short reply shows')
  assert.equal(await folded(4), true, 'the tool call is folded')
  assert.equal(await folded(5), true, 'the tool result is folded')
  // a folded record is one row, about as tall as a row of the Table mode
  const h = await height(card(4))
  assert.ok(h <= 34, `a folded record is ${h}px tall`)
  // its row reads its head and the start of its call: the tool's name and the command's first line
  const row = await page.evaluate((s) => document.querySelector(`${s} .reader-fold-line`)!.textContent, card(4))
  assert.match(row!, /^assistant · 2026-10-01 12:04/)
  assert.match(row!, /Bash cat > shim\.h <<'EOF'/)
  // the folded row stays on one line: its words are cut, not wrapped
  const lines = await page.evaluate((s) => {
    const el = document.querySelector<HTMLElement>(`${s} .reader-fold-text`)!
    return Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight))
  }, card(2))
  assert.equal(lines, 1)
})

test('a Bash command holding a whole file in one string opens clipped to a few lines, with Show more under it and Show less in its place', async () => {
  // the chevron at the start of the head opens the record and folds it again, turned: a click on the same spot does both
  const caret = `${card(4)} .reader-fold-caret`
  const shut = await box(caret)
  const at = { x: shut.x + shut.width / 2, y: shut.y + shut.height / 2 }
  await page.mouse.click(at.x, at.y)
  assert.equal(await folded(4), false)
  const open = await box(caret)
  assert.ok(Math.abs(open.x - shut.x) < 1 && Math.abs(open.y - shut.y) <= 8, `the chevron stays at the head's start (${shut.x},${shut.y} folded, ${open.x},${open.y} open)`)
  await page.mouse.click(at.x, at.y)
  assert.equal(await folded(4), true, 'a second click on the same spot folds it')
  await page.mouse.click(at.x, at.y)
  assert.equal(await folded(4), false)
  const block = `${card(4)} .reader-tool_use`
  const clipped = await height(block)
  assert.ok(clipped < 160, `the call shows ${clipped}px of its input`)
  const more = page.locator(`${card(4)} .reader-more`)
  // right under the block, cut or whole
  const under = async () => {
    const [b, m] = [await box(block), await box(`${card(4)} .reader-more`)]
    return m.y - (b.y + b.height)
  }
  assert.deepEqual([await more.textContent(), await more.getAttribute('aria-expanded')], ['Show more', 'false'])
  const gap = await under()
  assert.ok(gap >= 0 && gap <= 4, `Show more sits under the cut text (${gap}px below it)`)
  await more.click()
  const whole = await height(block)
  assert.ok(whole > clipped * 3, `expanded, it shows its input whole (${whole}px)`)
  assert.deepEqual([await more.textContent(), await more.getAttribute('aria-expanded')], ['Show less', 'true'])
  const gapOpen = await under()
  assert.ok(Math.abs(gapOpen - gap) < 0.5, `Show less sits where Show more did, under the text (${gapOpen}px, ${gap}px)`)
  assert.equal(await page.locator(`${card(4)} :text-is("Collapse")`).count(), 0)
  // the keyboard: Tab reaches Show less, ringed; Enter clips the block again and the focus stays on it
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  assert.deepEqual([await more.evaluate((e) => e === document.activeElement), await more.evaluate((e) => getComputedStyle(e).boxShadow !== 'none')], [true, true])
  await page.keyboard.press('Enter')
  assert.ok((await height(block)) < 160, 'Enter clips it again')
  assert.deepEqual([await more.textContent(), await more.evaluate((e) => e === document.activeElement)], ['Show more', true])
  await page.keyboard.press('Enter')
  assert.ok((await height(block)) > clipped * 3, 'Enter opens it whole')
  // the head folds it again, its chevron turned back where it was; Enter on the folded row opens the record
  await page.click(`${card(4)} .reader-fold-head`)
  assert.equal(await folded(4), true)
  const back = await box(caret)
  assert.ok(Math.abs(back.x - shut.x) < 1 && Math.abs(back.y - shut.y) < 1, 'the chevron is back where it was')
  await page.locator(`${card(4)} .reader-fold-line`).focus()
  await page.keyboard.press('Enter')
  assert.equal(await folded(4), false)
})

test('Collapse all folds every record and Expand all opens them; the choice is kept for the file', async () => {
  const all = page.locator('.reader-foldall')
  assert.equal(await all.textContent(), 'Collapse all')
  await all.click()
  const states = () => page.evaluate(() => [...document.querySelectorAll('.reader-card.reader-record')].map((c) => c.classList.contains('is-folded')))
  assert.ok((await states()).every(Boolean), 'every record is folded')
  assert.equal(await all.textContent(), 'Expand all')
  // one opened by itself stays open after the reader is drawn again
  await page.click(`${card(3)} .reader-fold-line`)
  await remount(1, 36)
  assert.equal(await page.locator('.reader-foldall').textContent(), 'Expand all')
  assert.equal(await folded(3), false)
  assert.equal(await folded(6), true)
  await page.locator('.reader-foldall').click()
  assert.ok((await states()).every((f) => !f), 'every record is open')
  assert.equal(await page.locator('.reader-foldall').textContent(), 'Collapse all')
})

test('Filter by a key hides the records of a value turned off, says how many a long run hides, and Show brings them back', async () => {
  // Filter by stands before Color by in the top row
  const order = await page.evaluate(() => [...document.querySelector('.reader-colorbar')!.children].map((c) => c.className.split(' ')[0]))
  assert.deepEqual(order.slice(0, 2), ['filterby', 'colorby'])
  await page.click('.filterby-trigger')
  await page.click('.colorby-menu .colorby-item:has-text("type")')
  assert.equal(await page.locator('.filterby-trigger b').textContent(), 'type')
  const chips = await page.locator('.filterby-chip').allTextContents()
  assert.deepEqual(chips, ['assistant32', 'user3', 'system1'])
  await page.click('.filterby-chip[data-value="assistant"]')
  assert.equal(await page.locator('.filterby-chip[data-value="assistant"]').getAttribute('aria-pressed'), 'false')
  // the assistant's records have no row; the thirty in a row say so in one line
  assert.equal(await page.locator(card(3)).count(), 0)
  assert.equal(await page.locator(card(20)).count(), 0)
  assert.equal(await page.locator(card(5)).count(), 1)
  const notes = await page.locator('.reader-hidden-run > span').allTextContents()
  assert.deepEqual(notes, ['30 records filtered out'])
  // kept for the file
  await remount(2, 36)
  assert.equal(await page.locator(card(20)).count(), 0)
  assert.equal(await page.locator('.filterby-trigger b').textContent(), 'type')
  await page.click('.reader-hidden-run button')
  await page.waitForSelector(card(20))
  assert.equal(await page.locator('.reader-hidden-run').count(), 0)
  assert.equal(await page.locator('.filterby-chip[data-value="assistant"]').getAttribute('aria-pressed'), 'true')
})
