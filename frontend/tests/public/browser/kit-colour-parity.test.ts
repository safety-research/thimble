// Every part of the view kit that draws records (backend/app/viewer_table.js, viewer_transcript.js, viewer_record.js,
// viewer_colour.js recordCard, viewer_controls.js timeline) in a real browser, in a sandboxed frame as ViewerFrame holds
// a view, on a page whose Color by's onChange draws nothing again: each part colors its records by the page's Color by
// with no `colour` given, mounted before or after it, and keeps its bars itself as the choice changes, a second choice
// comes and goes, a value is turned off and a value is recolored, with its elements, folds and scroll kept; `color` is
// the same option, and a part given `colour: false` (or `color: false`) shows no bar through every change.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Frame, Page } from 'playwright'
import { cleanup, FRONTEND, launch } from './page.ts'

const APP = path.join(FRONTEND, '..', 'backend', 'app')
const read = (name: string) => readFileSync(path.join(APP, name), 'utf8')
const inline = (js: string) => js.replace(/<\/script/g, '<\\/script')
// the kit as views.frame_document loads it
const KIT =
  `<script>window.__thimbleLabelOrder = ${read('label_order.json')}; window.__thimbleLabelWheel = ${read('label_wheel.json')}</script>` +
  ['viewer_bridge.js', 'viewer_colour.js', 'viewer_controls.js', 'viewer_side.js', 'viewer_transcript.js', 'viewer_search.js', 'viewer_table.js', 'viewer_record.js', 'viewer_range.js']
    .map((n) => `<script>${inline(read(n))}</script>`)
    .join('') +
  `<style>${read('viewer_kit.css')}</style><style>${read('viewer_parts.css')}</style>`
const TOKENS =
  ':root{--label-1:#025ac3;--label-2:#d0750a;--label-3:#08632f;--label-5:#b88a00;--label-6:#00787a;--label-13:#d0342c;--label-none:#a09c93;' +
  '--ink-rgb:27,26,24;--surface-card:#fffdf8;--bg-sunken:#f3f0e8;--text-primary:#000;--text-secondary:#4a4844;--text-tertiary:#726f69;' +
  '--accent:#5135ff;--radius-chip:4px;--radius-ui:6px;--radius-hl:3px;--h-row:28px;--control-sm:28px;--h-control:24px;--h-chip:20px;' +
  '--text-xs:12px;--text-ui-sm:12px;--text-sm:13px;--text-mono-sm:11px;--border-subtle:rgba(27,26,24,0.12);--border-hairline:rgba(27,26,24,0.08);' +
  '--border-strong:rgba(27,26,24,0.3);--status-negative:#c93a28;--font-body:sans-serif;--font-mono:monospace}'
const T0 = Date.UTC(2026, 4, 16, 9) / 1000
// six posts of a thread: who wrote each and whether it opens a thread or replies; the third is a tool call, folded
const RECS = [
  ['ana', 'post'],
  ['bo', 'reply'],
  ['cy', 'reply'],
  ['ana', 'reply'],
  ['bo', 'post'],
  ['cy', 'post'],
].map(([author, role], i) => ({ n: i + 1, author, role, t: T0 + i * 60, text: `Post ${i + 1} by ${author}` }))
const FIELDS = [
  { name: 'author', title: 'Author', values: [{ name: 'ana', colour: 1 }, { name: 'bo', colour: 2 }, { name: 'cy', colour: 3 }] },
  { name: 'role', title: 'Role', values: [{ name: 'post', colour: 5 }, { name: 'reply', colour: 6 }] },
]

// Each part twice: following the page's Color by, and given `colour: false` (the transcript `color: false`, the same
// option); a transcript given `color: colour` follows it as the default does, and a timeline given a Color by of the
// page's making draws in that one's colours. `mount` says when the page mounts Color by: before the parts draw, after,
// or never.
type Mount = 'first' | 'after' | 'never'
const view = (mount: Mount) => `<!doctype html><html><head><style>${TOKENS} html,body{margin:0} body{font:12px sans-serif;background:#fffdf8}
.top{display:flex;align-items:center;gap:8px;padding:8px} .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:0 12px}
.tall{height:150px;overflow:auto}</style>${KIT}</head><body>
<div class="top"><span id="colour"></span></div>
<div class="grid">
  <div id="t" style="height:220px"></div><div id="off-t" style="height:220px"></div>
  <div id="tr" class="tall"></div><div id="off-tr" class="tall"></div>
  <div id="rec"></div><div id="off-rec"></div>
  <div id="cards" class="thimble-cards"></div><div id="off-cards" class="thimble-cards"></div>
  <div id="tl"></div><div id="off-tl"></div>
  <div id="alias-tr"></div><div id="own-tl"></div>
</div>
<script>
const RECS = ${JSON.stringify(RECS)}
window.__changes = 0
const mountColour = () => (window.colour = thimble.colorBy({ mount: '#colour', fields: ${JSON.stringify(FIELDS)}, onChange: () => window.__changes++ }))
${mount === 'first' ? 'mountColour()' : ''}
const rows = (p) => RECS.map((r) => ({ ...r, ref: p + '.jsonl#L' + r.n }))
const turns = (p) => rows(p).map((r) => (r.n === 3 ? { ...r, speaker: r.author, kind: 'tool', tool: 'Bash', input: 'ls', output: 'a\\nb' } : { ...r, speaker: r.author, kind: 'text' }))
const cards = (p, o) => rows(p).map((r) => thimble.recordCard({ ref: r.ref, record: r, key: '#' + r.n, title: r.text, ...o })).join('')
thimble.table({ mount: '#t', rows: rows('t'), columns: ['author', 'role', 'text'] })
thimble.table({ mount: '#off-t', rows: rows('off-t'), columns: ['author', 'role', 'text'], colour: false })
thimble.transcript({ mount: '#tr' }).draw(turns('tr'))
thimble.transcript({ mount: '#off-tr', color: false }).draw(turns('off-tr'))
thimble.record({ mount: '#rec', value: RECS[1], ref: 'rec.jsonl#L2' })
thimble.record({ mount: '#off-rec', value: RECS[1], ref: 'off-rec.jsonl#L2', colour: false })
document.getElementById('cards').innerHTML = cards('cards', {})
document.getElementById('off-cards').innerHTML = cards('off-cards', { colour: false })
thimble.timeline({ mount: '#tl' }).draw(RECS)
thimble.timeline({ mount: '#off-tl', colour: false }).draw(RECS)
// a timeline given a Color by of the page's making: its marks in that one's colours
thimble.timeline({ mount: '#own-tl', colour: { valueOf: (r) => r.author, colourOf: (v) => (v ? 'rgb(1, 2, 3)' : null) } }).draw(RECS)
${mount === 'first' ? "thimble.transcript({ mount: '#alias-tr', color: window.colour }).draw(turns('alias-tr'))" : mount === 'after' ? 'mountColour()' : ''}
</script></body></html>`

let browser: Browser
beforeAll(async () => {
  browser = await launch()
})
afterAll(async () => {
  await browser?.close()
  cleanup()
})

async function framed(mount: Mount = 'first'): Promise<{ page: Page; frame: () => Frame }> {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1500 } })
  await page.setContent('<!doctype html><html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="border:0;width:960px;height:1460px"></iframe></body></html>')
  // what the kit reports to thimble as the view's errors
  await page.evaluate(() => {
    const w = window as unknown as { __errors: string[] }
    w.__errors = []
    window.addEventListener('message', (e) => e.data && e.data.type === 'thimble:error' && w.__errors.push(String(e.data.message)))
  })
  await page.evaluate((doc) => ((document.getElementById('f') as HTMLIFrameElement).srcdoc = doc), view(mount))
  const frame = () => page.frames().find((f) => f !== page.mainFrame())!
  await page.waitForFunction(() => (document.getElementById('f') as HTMLIFrameElement).contentWindow)
  await page.waitForTimeout(300)
  await frame().waitForSelector(mount === 'never' ? '.thimble-lane-mark' : '.thimble-colour-chip', { state: 'attached' })
  await settle(page)
  return { page, frame }
}
const settle = (page: Page) => page.waitForTimeout(250)
const errors = (page: Page) => page.evaluate(() => (window as unknown as { __errors: string[] }).__errors)

type Seen = { value: string | null; bar: string | null; tracks: string | null; edge: string | null }
type Look = { seen: Record<string, Seen[]>; tl: (string | null)[]; offTl: (string | null)[]; ownTl: (string | null)[] }
/** Each part's records as drawn: the value it stamped (data-colour), the bar the bridge drew (its colour as a color
 *  property computes it, or null for none), its tracks' values and its edge; and the fill of each timeline mark, by
 *  its record's index (null for the gray of no colour). */
const look = (frame: Frame): Promise<Look> =>
  frame.evaluate(() => {
    const norm = (c: string | null) => {
      if (!c) return null
      const i = document.createElement('i')
      i.style.color = c
      document.body.appendChild(i)
      const got = getComputedStyle(i).color
      i.remove()
      return got
    }
    const seen = (sel: string) =>
      [...document.querySelectorAll(sel)].map((el) => ({
        value: el.getAttribute('data-colour'),
        bar: el.hasAttribute('data-thimble-bar') ? norm(getComputedStyle(el).getPropertyValue('--thimble-label').trim()) : null,
        tracks: el.getAttribute('data-colour-tracks'),
        edge: el.getAttribute('data-thimble-edge'),
      }))
    const fills = (sel: string) => {
      const out: (string | null)[] = []
      for (const r of document.querySelectorAll<SVGRectElement>(sel + ' .thimble-lane-mark')) out[Number(r.getAttribute('data-i'))] = r.style.fill ? norm(r.style.fill) : null
      return out
    }
    return {
      seen: {
        t: seen('#t .thimble-table-row'),
        tr: seen('#tr > .thimble-turn'),
        rec: seen('#rec > .thimble-record'),
        cards: seen('#cards > .thimble-card'),
        aliasTr: seen('#alias-tr > .thimble-turn'),
        offT: seen('#off-t .thimble-table-row'),
        offTr: seen('#off-tr > .thimble-turn'),
        offRec: seen('#off-rec > .thimble-record'),
        offCards: seen('#off-cards > .thimble-card'),
      },
      tl: fills('#tl'),
      offTl: fills('#off-tl'),
      ownTl: fills('#own-tl'),
    }
  })
/** what a palette place is drawn in here */
const place = (frame: Frame, k: number) =>
  frame.evaluate((k) => {
    const i = document.createElement('i')
    i.style.color = `var(--label-${k})`
    document.body.appendChild(i)
    const got = getComputedStyle(i).color
    i.remove()
    return got
  }, k)
const ON = ['t', 'tr', 'rec', 'cards'] as const
const OFF = ['offT', 'offTr', 'offRec', 'offCards'] as const
/** the records each part draws, in order: all six, or the record viewer's one (the second) */
const recsOf = (part: string) => (part === 'rec' || part === 'offRec' ? [RECS[1]] : RECS)

/** Every part that follows Color by shows `field`'s value on each record, a bar in `colourOf(value)` (none for a value
 *  in `off`), one bar and no tracks; the timeline's marks are in the same colours. */
function follows(got: Look, field: 'author' | 'role', colourOf: Record<string, string>, off: string[] = [], parts: readonly string[] = [...ON, 'aliasTr']) {
  for (const part of parts) {
    const want = recsOf(part).map((r) => ({ value: r[field], bar: off.includes(r[field]) ? null : colourOf[r[field]], tracks: null }))
    assert.deepEqual(
      got.seen[part].map((s) => ({ value: s.value, bar: s.bar, tracks: s.tracks })),
      want,
      `${part}: each record stamped with its ${field} and barred in its colour`,
    )
    for (const s of got.seen[part]) assert.ok(s.bar == null || s.edge === 'in' || s.edge === 'out', `${part}: one bar, not bands (${s.edge})`)
  }
  assert.deepEqual(got.tl, RECS.map((r) => (off.includes(r[field]) ? null : colourOf[r[field]])), "the timeline's marks in the same colours")
}
/** No part given colour: false stamps a value or shows a bar, and its timeline's marks are gray; the timeline given its
 *  own Color by keeps to it. */
function plain(got: Look) {
  for (const part of OFF) {
    assert.equal(got.seen[part].length, recsOf(part).length, `${part} drew its records`)
    for (const s of got.seen[part]) assert.deepEqual([s.value, s.bar, s.tracks, s.edge], [null, null, null, null], `${part}: no stamp and no bar`)
  }
  assert.deepEqual(got.offTl, RECS.map(() => null), "the timeline given colour: false draws its marks gray")
  assert.deepEqual(got.ownTl, RECS.map(() => 'rgb(1, 2, 3)'), 'the timeline given a Color by of its own draws in its colours')
}
/** opens the Color by menu and clicks a field in it */
async function menuClick(frame: Frame, field: string) {
  if (!(await frame.locator('.thimble-colour-menu').isVisible().catch(() => false))) await frame.click('.thimble-colour-by')
  await frame.click(`.thimble-colour-menu [data-by="f:${field}"]`)
}

test("with onChange drawing nothing, every part's bars follow the choice, a second choice, a value turned off and a value recolored, its elements, folds and scroll kept; a part given colour: false shows none", async () => {
  const { page, frame } = await framed()
  const f = frame()
  const [blue, orange, green, gold, teal, red] = await Promise.all([1, 2, 3, 5, 6, 13].map((k) => place(f, k)))
  const AUTHOR = { ana: blue, bo: orange, cy: green }
  const ROLE = { post: gold, reply: teal }
  let got = await look(f)
  follows(got, 'author', AUTHOR)
  plain(got)

  // what the change must keep: the parts' elements, the tool call opened, the transcript scrolled
  await f.click('#tr [data-anchor="tr.jsonl#L3"] .thimble-turn-line')
  await f.evaluate(() => {
    const w = window as any
    w.__kept = ['#tr > .thimble-turn', '#rec > .thimble-record', '#cards > .thimble-card', '#alias-tr > .thimble-turn'].map((s) => [...document.querySelectorAll(s)])
    document.getElementById('tr')!.scrollTop = 40
  })
  await settle(page)

  // Role checked after Author: a second choice, whose value every part stamps as its records' tracks, a band each
  await menuClick(f, 'role')
  await settle(page)
  got = await look(f)
  for (const part of [...ON, 'aliasTr']) {
    assert.deepEqual(got.seen[part].map((s) => [s.value, s.tracks]), recsOf(part).map((r) => [r.author, JSON.stringify([r.role])]), `${part}: Author stamped, Role as its track`)
    for (const s of got.seen[part]) assert.match(String(s.edge), /^bands/, `${part}: a band per choice`)
  }
  plain(got)

  // Author unchecked: Role is the one choice, stamped and drawn by each part, nothing drawn again
  await menuClick(f, 'author')
  await page.keyboard.press('Escape')
  await settle(page)
  got = await look(f)
  follows(got, 'role', ROLE)
  plain(got)
  const kept = await f.evaluate(() => {
    const w = window as any
    const now = ['#tr > .thimble-turn', '#rec > .thimble-record', '#cards > .thimble-card', '#alias-tr > .thimble-turn'].map((s) => [...document.querySelectorAll(s)])
    return {
      same: now.map((els, i) => els.length === w.__kept[i].length && els.every((el: Element, j: number) => el === w.__kept[i][j])),
      open: !!document.querySelector('#tr [data-anchor="tr.jsonl#L3"] .thimble-turn-call'),
      scroll: document.getElementById('tr')!.scrollTop,
      changes: w.__changes,
    }
  })
  assert.deepEqual(kept.same, [true, true, true, true], 'the transcripts, the record and the cards keep their elements: stamped, not drawn again')
  assert.equal(kept.open, true, 'the tool call opened stays open')
  assert.equal(kept.scroll, 40, 'the transcript keeps its scroll')
  assert.ok(kept.changes >= 2, 'the page heard each change and drew nothing')

  // "post" turned off: its records keep their stamp and lose their bar, everywhere; turned on, it is back
  const chip = (name: string) => f.locator('.thimble-colour-chip', { hasText: name }).first()
  await chip('post').click()
  await settle(page)
  got = await look(f)
  follows(got, 'role', ROLE, ['post'])
  plain(got)
  await chip('post').click()
  await settle(page)
  follows(await look(f), 'role', ROLE)

  // "reply" recolored red: every part's reply bars, and the timeline's reply marks, red
  await chip('reply').locator('.chip-sw').click()
  await f.click('.thimble-colour-pick[data-pick="12"]')
  await page.keyboard.press('Escape')
  await settle(page)
  got = await look(f)
  follows(got, 'role', { post: gold, reply: red })
  plain(got)
  assert.deepEqual(await errors(page), [], 'the kit reported no error')
  await page.close()
})

test('each part draws alone with no Color by, its records with no bar, and takes its bars when the page mounts it after', async () => {
  const alone = await framed('never')
  const got0 = await look(alone.frame())
  for (const part of [...ON, ...OFF]) {
    assert.equal(got0.seen[part].length, recsOf(part).length, `${part} drew its records`)
    for (const s of got0.seen[part]) assert.deepEqual([s.value, s.bar], [null, null], `${part}: no stamp and no bar with no Color by`)
  }
  assert.deepEqual(got0.tl, RECS.map(() => null), "the timeline's marks gray with no Color by")
  assert.deepEqual(got0.ownTl, RECS.map(() => 'rgb(1, 2, 3)'), 'the timeline given a Color by of its own draws in its colours')
  assert.deepEqual(await errors(alone.page), [], 'the kit reported no error')
  await alone.page.close()

  const { page, frame } = await framed('after')
  const f = frame()
  const [blue, orange, green] = await Promise.all([1, 2, 3].map((k) => place(f, k)))
  const got = await look(f)
  follows(got, 'author', { ana: blue, bo: orange, cy: green }, [], ON)
  plain(got)
  assert.deepEqual(await errors(page), [], 'the kit reported no error')
  await page.close()
})
