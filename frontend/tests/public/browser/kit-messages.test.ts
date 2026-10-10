// The view kit's messages (backend/app/viewer_messages.js, viewer_parts.css) in a real browser, in a sandboxed frame as
// ViewerFrame holds a view, in the theme's own tokens: one author's messages that follow each other share a head, the
// later ones under it at the same left edge; a date line stands between two days; a reply is one level in under its
// parent's group, a deeper reply at the same level; an event is one line, its icon in the avatars' rail and its time at
// the right; quoted mail is folded behind "…" and the search finds a word in it and opens it; the bars follow Color by
// as it changes, with no onChange of the page's; and the part works alone on a page with no other part mounted. What
// the part decides without layout (the grouping rule, the folds' markup) is tests/public/data-kit.test.ts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, test } from 'vitest'
import type { Browser, Frame, Page } from 'playwright'
import { cleanup, FRONTEND, launch } from './page.ts'

const APP = path.join(FRONTEND, '..', 'backend', 'app')
const read = (name: string) => readFileSync(path.join(APP, name), 'utf8')
const inline = (js: string) => js.replace(/<\/script/g, '<\\/script')
// the kit as views.frame_document loads it
const KIT =
  `<script>${inline(read('viewer_bridge.js'))}</script><script>window.__thimbleLabelOrder = ${read('label_order.json')}</script>` +
  ['viewer_colour.js', 'viewer_controls.js', 'viewer_side.js', 'viewer_transcript.js', 'viewer_messages.js', 'viewer_search.js', 'viewer_table.js', 'viewer_diff.js', 'viewer_range.js']
    .map((n) => `<script>${inline(read(n))}</script>`)
    .join('') +
  `<style>${read('viewer_kit.css')}</style><style>${read('viewer_parts.css')}</style>`
const TOKENS = readFileSync(path.join(FRONTEND, 'src', 'styles', 'tokens.css'), 'utf8') + ':root{--font-body:sans-serif;--font-mono:monospace}'
const page = (body: string) =>
  `<!doctype html><html><head><style>${TOKENS} html,body{margin:0;height:100%} body{background:var(--surface-card);overflow:hidden}
.top{display:flex;gap:8px;align-items:center;padding:8px} #msgs{height:600px;overflow-y:auto}</style>${KIT}</head><body>${body}</body></html>`

// 23:50 on Thursday 27 August 2026: the last messages come after midnight
const T0 = Date.UTC(2026, 7, 27, 23, 50) / 1000
const MESSAGES = [
  { ref: 'b.jsonl#L1', t: T0, author: 'agent-03', room: 'review', title: 'Review swap', text: 'Who can review #66763?' },
  { ref: 'b.jsonl#L2', t: T0 + 60, author: 'agent-03', room: 'review', text: 'Tests pass on main.' },
  { ref: 'b.jsonl#L3', t: T0 + 120, author: 'agent-08', room: 'review', parent: 'b.jsonl#L1', text: 'I will take it.' },
  { ref: 'b.jsonl#L4', t: T0 + 180, author: 'agent-03', room: 'review', parent: 'b.jsonl#L3', text: 'Thanks.' },
  { ref: 'b.jsonl#L5', t: T0 + 240, author: 'agent-08', room: 'review', kind: 'event', icon: 'approve', said: 'approved #66763' },
  { ref: 'b.jsonl#L6', t: T0 + 1200, author: 'agent-01', room: 'ops', text: 'Merged it.\n\nOn Thu 27 Aug, agent-03 wrote:\n> Who can review it?\n> The zanzibar case fails.' },
  { ref: 'b.jsonl#L7', t: T0 + 1260, author: 'agent-01', room: 'ops', text: 'Closing the duplicates next.' },
]
const CHAT = page(`<div class="top"><span id="search"></span><span id="colour"></span></div><div id="msgs"></div>
<script>
window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'author', title: 'Author' }, { name: 'room', title: 'Room' }], strip: '#msgs' })
window.search = thimble.search({ mount: '#search', in: '#msgs' })
window.conv = thimble.messages({ mount: '#msgs' })
conv.draw(${JSON.stringify(MESSAGES)}, { title: '# review-swaps' })
</script>`)
const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
const ALONE = page(`<div id="c" style="width:560px"></div>
<script>
window.picked = []
window.conv = thimble.messages({ mount: '#c', format: 'plain', onPick: (m) => window.picked.push(m.ref) })
conv.draw(${JSON.stringify([...MESSAGES.map(({ room: _room, ...m }) => m), { ref: 'b.jsonl#L8', t: T0 + 1300, author: 'agent-12', text: long }])})
</script>`)

let browser: Browser

beforeAll(async () => {
  browser = await launch()
})
afterAll(async () => {
  await browser?.close()
  cleanup()
})

/** A page holding `doc` in a sandboxed frame 800 px wide; the frame's errors are collected in `errors`. */
async function framed(doc: string): Promise<{ page: Page; frame: () => Frame; errors: string[] }> {
  const p = await browser.newPage({ viewport: { width: 840, height: 720 } })
  const errors: string[] = []
  p.on('pageerror', (e) => errors.push(e.message))
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await p.setContent(`<!doctype html><html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="border:0;width:800px;height:680px"></iframe></body></html>`)
  await p.evaluate((d) => ((document.getElementById('f') as HTMLIFrameElement).srcdoc = d), doc)
  const frame = () => p.frames().find((f) => f !== p.mainFrame())!
  await p.waitForTimeout(300)
  await frame().waitForSelector('.thimble-msg', { state: 'attached' })
  return { page: p, frame, errors }
}
type Box = { x: number; y: number; width: number; height: number; right: number; bottom: number }
const boxOf = (frame: () => Frame, sel: string) =>
  frame().evaluate((s) => {
    const r = document.querySelector(s)!.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom } as Box
  }, sel)
const msg = (n: number, part = '') => `[data-anchor="b.jsonl#L${n}"]${part ? ' ' + part : ''}`

describe('the messages in a frame, with Color by and the search', () => {
  test('one author\'s messages share a head; a date line between two days; a reply one level in; an event on one line', async () => {
    const { page: p, frame, errors } = await framed(CHAT)
    // drawn in this order: the first group, its replies one level in, the event, the date line, the next day's group
    const order = await frame().evaluate(() => [...document.querySelectorAll('.thimble-msg, .thimble-msg-day')].map((e) => e.getAttribute('data-anchor') || e.textContent))
    assert.deepEqual(order, ['Thu 27 Aug 2026', 'b.jsonl#L1', 'b.jsonl#L2', 'b.jsonl#L3', 'b.jsonl#L4', 'b.jsonl#L5', 'Fri 28 Aug 2026', 'b.jsonl#L6', 'b.jsonl#L7'])
    // the second message has no head or avatar of its own, its words at the first's left edge, right under them
    const has = (sel: string) => frame().evaluate((s) => document.querySelector(s) != null, sel)
    assert.deepEqual([await has(msg(2, '.thimble-msg-head')), await has(msg(2, '.avatar')), await has(msg(1, '.avatar'))], [false, false, true])
    const [b1, b2] = [await boxOf(frame, msg(1, '.thimble-msg-body')), await boxOf(frame, msg(2, '.thimble-msg-body'))]
    assert.ok(Math.abs(b1.x - b2.x) < 0.5, `the words line up (${b1.x}, ${b2.x})`)
    assert.ok(b2.y - b1.bottom >= 0 && b2.y - b1.bottom < 8, `the second message's words follow the first's (${b2.y - b1.bottom}px apart)`)
    // the date line stands between the event of the first day and the first message of the next
    const [ev, day, next] = [await boxOf(frame, msg(5)), await boxOf(frame, '.thimble-msg-day ~ .thimble-msg-day'), await boxOf(frame, msg(6))]
    assert.ok(day.y >= ev.bottom && day.bottom <= next.y, `the date line between the days (${ev.bottom} ${day.y}-${day.bottom} ${next.y})`)
    // a reply one level in under its parent's group, a reply to the reply at that level too, with a smaller avatar
    const [m1, m3, m4] = [await boxOf(frame, msg(1)), await boxOf(frame, msg(3)), await boxOf(frame, msg(4))]
    assert.ok(m3.x - m1.x >= 30 && m3.x - m1.x <= 60, `the reply is one level in (${m3.x - m1.x}px)`)
    assert.equal(m4.x, m3.x, 'a deeper reply stays at that level')
    const [a1, a3] = [await boxOf(frame, msg(1, '.avatar')), await boxOf(frame, msg(3, '.avatar'))]
    assert.ok(a3.width < a1.width, `a reply's avatar is smaller (${a3.width}, ${a1.width})`)
    // the event: one line, its icon in the avatars' rail, its time at the right on the same line
    const [ico, said, time, list] = [await boxOf(frame, msg(5, '.thimble-msg-ico')), await boxOf(frame, msg(5, '.thimble-msg-said')), await boxOf(frame, msg(5, '.thimble-msg-time')), await boxOf(frame, '#msgs')]
    assert.ok(ev.height < 32, `one line (${ev.height}px)`)
    assert.ok(Math.abs(ico.x + ico.width / 2 - (a1.x + a1.width / 2)) < 1, 'the icon is centered in the avatars\' rail')
    assert.ok(Math.abs(time.y - said.y) < 3 && time.x > said.x + 200 && list.right - time.right < 40, `the time at the right of its line (${JSON.stringify({ time, said })})`)
    assert.equal(await frame().evaluate((s) => document.querySelector(s)!.textContent, msg(5, '.thimble-msg-said')), 'agent-08 approved #66763')
    assert.deepEqual(errors, [])
    await p.close()
  })

  test('quoted mail is folded behind "…"; the search finds a word in it and opens it, the match on screen', async () => {
    const { page: p, frame } = await framed(CHAT)
    const fold = msg(6, '.thimble-msg-fold')
    const hidden = () => frame().evaluate((s) => (document.querySelector(s) as HTMLElement).hidden, fold)
    assert.equal(await hidden(), true)
    const dots = await boxOf(frame, msg(6, '.thimble-msg-dots'))
    assert.ok(dots.width > 10 && dots.height >= 10 && dots.height <= 20, `the "…" button shows (${JSON.stringify(dots)})`)
    await frame().locator('.thimble-search-input').fill('zanzibar')
    await p.waitForTimeout(400)
    const found = await frame().evaluate((s) => {
      const cur = CSS.highlights.get('thimble-search-current')
      const r = cur ? ([...cur][0] as Range).getBoundingClientRect() : null
      const f = document.querySelector(s) as HTMLElement
      return { count: document.querySelector('.thimble-search-count')!.textContent, open: !f.hidden, dots: f.previousElementSibling!.getAttribute('aria-expanded'), h: r ? r.height : 0, top: r ? r.top : -1 }
    }, fold)
    assert.deepEqual([found.count, found.open, found.dots], ['1 of 1', true, 'true'])
    assert.ok(found.h > 0 && found.top >= 0 && found.top < 680, `the match is on screen (${JSON.stringify(found)})`)
    // the "…" folds it again
    await frame().locator(msg(6, '.thimble-msg-dots')).click()
    assert.equal(await hidden(), true)
    await p.close()
  })

  test("each message takes Color by's bar, which follows the choice with no onChange of the page's", async () => {
    const { page: p, frame } = await framed(CHAT)
    const bars = () =>
      frame().evaluate(() =>
        [...document.querySelectorAll('.thimble-msg')].map((e) => {
          const m = /rgb\([^)]*\)(?= 3px 0px 0px 0px inset)/.exec(getComputedStyle(e).boxShadow)
          return [e.getAttribute('data-colour'), m ? m[0] : null]
        }),
      )
    const chip = (name: string) => frame().evaluate((n) => {
      const c = [...document.querySelectorAll('.thimble-colour-chip')].find((x) => x.textContent!.startsWith(n))
      return c ? getComputedStyle(c.querySelector('.chip-sw')!).backgroundColor : null
    }, name)
    await p.waitForTimeout(200)
    const byAuthor = await bars()
    assert.deepEqual(byAuthor.map((b) => b[0]), ['agent-03', 'agent-03', 'agent-08', 'agent-03', 'agent-08', 'agent-01', 'agent-01'])
    assert.equal(byAuthor[0][1], await chip('agent-03'))
    assert.equal(byAuthor[2][1], await chip('agent-08'))
    assert.equal(byAuthor[5][1], await chip('agent-01'))
    assert.notEqual(byAuthor[0][1], byAuthor[2][1])
    // Off: no bar
    await frame().locator('.thimble-colour-by').click()
    await frame().locator('.thimble-colour-menu [data-by="off"]').click()
    await p.waitForTimeout(250)
    assert.ok((await bars()).every((b) => b[0] == null && b[1] == null), JSON.stringify(await bars()))
    // Room: the bars of each room's messages in its color
    await frame().locator('.thimble-colour-by').click()
    await frame().locator('.thimble-colour-menu [data-by="f:room"]').click()
    await p.keyboard.press('Escape')
    await p.waitForTimeout(250)
    const byRoom = await bars()
    assert.deepEqual(byRoom.map((b) => b[0]), ['review', 'review', 'review', 'review', 'review', 'ops', 'ops'])
    assert.equal(byRoom[0][1], await chip('review'))
    assert.equal(byRoom[6][1], await chip('ops'))
    assert.notEqual(byRoom[0][1], byRoom[6][1])
    await p.close()
  })
})

describe('the messages alone', () => {
  test('drawn with no other part: folds open and close, a long body behind Show more, a pick, reveal', async () => {
    const { page: p, frame, errors } = await framed(ALONE)
    assert.equal(await frame().evaluate(() => document.querySelectorAll('.thimble-msg').length), 8)
    assert.equal(await frame().evaluate(() => document.querySelectorAll('[data-colour], [data-thimble-edge], .thimble-colour-strip').length), 0, 'no Color by, no bar')
    // the quote opens on its "…" and folds again
    const quote = () => frame().evaluate(() => (document.querySelector('[data-anchor="b.jsonl#L6"] .thimble-msg-fold') as HTMLElement).hidden)
    await frame().locator(msg(6, '.thimble-msg-dots')).click()
    assert.equal(await quote(), false)
    assert.deepEqual(await frame().evaluate(() => (window as any).picked), [], 'a fold\'s button is no pick')
    // thirty lines show their first eight, Show more the rest, Show less in its place under them
    const body = () => boxOf(frame, msg(8, '.thimble-msg-body'))
    const short = await body()
    assert.ok(short.height < 8 * 22, `folded, eight lines show (${short.height}px)`)
    await frame().locator(msg(8, '.thimble-msg-more')).click()
    const whole = await body()
    assert.ok(whole.height > short.height * 3, `open, the body shows whole (${whole.height}px)`)
    const more = await boxOf(frame, msg(8, '.thimble-msg-more'))
    assert.ok(more.y >= whole.bottom && more.y - whole.bottom < 8, 'Show less sits under the words')
    // a click on a message picks it, as Enter on it does once it has the focus
    await frame().locator(msg(2, '.thimble-msg-text')).click()
    await frame().locator(msg(3)).focus()
    await p.keyboard.press('Enter')
    assert.deepEqual(await frame().evaluate(() => (window as any).picked), ['b.jsonl#L2', 'b.jsonl#L3'])
    // reveal: its folds open, in view, highlighted
    await frame().locator(msg(6, '.thimble-msg-dots')).click()
    assert.equal(await quote(), true)
    assert.equal(await frame().evaluate(() => (window as any).conv.reveal('b.jsonl#L6')), true)
    assert.equal(await quote(), false)
    assert.equal(await frame().evaluate(() => document.querySelector('[data-anchor="b.jsonl#L6"]')!.classList.contains('thimble-msg-hit')), true)
    assert.deepEqual(errors, [])
    await p.close()
  })
})
