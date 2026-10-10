// The view kit's messages (backend/app/viewer_messages.js, viewer_parts.css) in a real browser, in a sandboxed frame as
// ViewerFrame holds a view, in the theme's own tokens: one author's messages that follow each other share a head, the
// later ones under it at the same left edge; a date line stands between two days; a reply is one level in under its
// parent's group, a deeper reply at the same level; an event is one line, its icon in the avatars' rail and its time at
// the right; quoted mail is folded behind "…" and the search finds a word in it and opens it; the bars follow Color by
// as it changes, with no onChange of the page's; a boxed message is a box beside its avatar, its head on a tint and its
// words inside, light and dark; and the part works alone on a page with no other part mounted. What
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
    assert.deepEqual(order, ['Thu, Aug 27, 2026', 'b.jsonl#L1', 'b.jsonl#L2', 'b.jsonl#L3', 'b.jsonl#L4', 'b.jsonl#L5', 'Fri, Aug 28, 2026', 'b.jsonl#L6', 'b.jsonl#L7'])
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
          return [e.getAttribute('data-color'), m ? m[0] : null]
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

describe('the messages under the label filter and in a long list', () => {
  test("the label filter hides a message that held its group's head: the next one shown takes the head; a day with none shown hides its date line", async () => {
    const { page: p, frame, errors } = await framed(CHAT)
    // thimble's label filter keeps every message but the first and the next day's two (viewer_bridge.js, `keep`)
    const filter = (dropped: string[]) =>
      p.evaluate((dropped) => {
        const col = '#d0750a'
        const marks: Record<string, object> = {}
        for (let n = 1; n <= 7; n++) {
          const ref = 'b.jsonl#L' + n
          marks[ref] = { bar: col, names: ['L'], values: [{ id: 'l1', label: 'L', value: 'yes', colour: col }], keep: !dropped.includes(ref) }
        }
        const w = (document.getElementById('f') as HTMLIFrameElement).contentWindow!
        w.postMessage({ type: 'thimble:labels', marks, filter: { label: 'l1', value: 'yes', colour: col }, on: [{ id: 'l1', name: 'L', colour: col, values: [] }], answered: 99 }, '*')
      }, dropped)
    const shown = () =>
      frame().evaluate(() =>
        [...document.querySelectorAll('.thimble-msg, .thimble-msg-day')].filter((e) => e.getClientRects().length).map((e) => {
          const ref = e.getAttribute('data-anchor')
          return ref ? [ref, e.querySelector(':scope > .thimble-msg-main > .thimble-msg-head .thimble-msg-author')?.textContent ?? null, !!e.querySelector('.avatar')] : e.textContent
        }),
      )
    await filter(['b.jsonl#L1', 'b.jsonl#L6', 'b.jsonl#L7'])
    await p.waitForTimeout(400)
    assert.deepEqual(await shown(), [
      'Thu, Aug 27, 2026',
      ['b.jsonl#L2', 'agent-03', true],
      ['b.jsonl#L3', 'agent-08', true],
      ['b.jsonl#L4', 'agent-03', true],
      ['b.jsonl#L5', null, false],
    ])
    // the filter lifted: the head back on the first message alone, the date line back
    await filter([])
    await p.waitForTimeout(400)
    const all = await shown()
    assert.deepEqual(all.slice(0, 3), ['Thu, Aug 27, 2026', ['b.jsonl#L1', 'agent-03', true], ['b.jsonl#L2', null, false]])
    assert.deepEqual(all.slice(6), ['Fri, Aug 28, 2026', ['b.jsonl#L6', 'agent-01', true], ['b.jsonl#L7', null, false]])
    assert.deepEqual(errors, [])
    await p.close()
  })

  test('reveal brings a long message far down a long list to the top, clear of the sticky header', async () => {
    const LONG = page(`<div id="msgs"></div>
<script>
const ms = []
for (let i = 0; i < 2000; i++) ms.push({ ref: 'h#L' + i, t: ${T0} + i * 97, author: 'agent-' + (i % 48), text: 'message ' + i + (i === 1600 ? '\\n'.repeat(3) + 'x\\n'.repeat(40) : '') })
window.conv = thimble.messages({ mount: '#msgs' })
conv.draw(ms, { title: '# long' })
</script>`)
    const { page: p, frame, errors } = await framed(LONG)
    assert.equal(await frame().evaluate(() => (window as any).conv.reveal('h#L1600')), true)
    await p.waitForTimeout(300)
    const [m, head, list] = [await boxOf(frame, '[data-anchor="h#L1600"]'), await boxOf(frame, '.thimble-msg-header'), await boxOf(frame, '#msgs')]
    assert.ok(m.height > list.height, `taller than the list (${m.height}px)`)
    assert.ok(m.y >= head.bottom && m.y - head.bottom < 12, `its top just under the header (${m.y}, ${head.bottom})`)
    assert.deepEqual(errors, [])
    await p.close()
  })

  test('the search goes to a word low in a long message far down a long list, and the match is drawn on screen', async () => {
    // messages of 11 long lines, under the fold but several times the list's height, which the list leaves undrawn out
    // of view at a height of a few lines (content-visibility): a match measured low inside one was scrolled to with the
    // message's top above the list, so the message stayed undrawn and the match unseen (live QA 3, Swarm Board)
    const LONG = page(`<div class="top"><span id="search"></span></div><div id="msgs"></div>
<script>
const ms = []
for (let i = 0; i < 400; i++) ms.push({ ref: 'h#L' + i, t: ${T0} + i * 97, author: 'agent-' + (i % 48),
  text: Array.from({ length: 11 }, (_, k) => 'message ' + i + ' line ' + k + ' and its words'.repeat(24) + (k === 9 && i % 100 === 50 ? ' under a merge zanzibar' : '')).join('\\n') })
window.search = thimble.search({ mount: '#search', in: '#msgs' })
window.conv = thimble.messages({ mount: '#msgs', format: 'plain' })
conv.draw(ms, { title: '# long' })
</script>`)
    const { page: p, frame, errors } = await framed(LONG)
    const current = () =>
      frame().evaluate(() => {
        const r = [...CSS.highlights.get('thimble-search-current')!][0] as Range
        const b = r.getBoundingClientRect()
        const el = r.startContainer.parentElement!
        const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
        const list = document.getElementById('msgs')!.getBoundingClientRect()
        return {
          count: document.querySelector('.thimble-search-count')!.textContent,
          ref: el.closest('[data-anchor]')!.getAttribute('data-anchor'),
          drawn: !!at && (el === at || el.contains(at) || at.contains(el)),
          inList: b.top >= list.top && b.bottom <= list.bottom,
        }
      })
    await frame().locator('.thimble-search-input').fill('zanzibar')
    await p.waitForTimeout(400)
    const seen = [await current()]
    for (let i = 0; i < 3; i++) {
      await frame().locator('.thimble-search-input').press('Enter')
      await p.waitForTimeout(300)
      seen.push(await current())
    }
    assert.deepEqual(seen.map((s) => [s.count, s.ref]), [['1 of 4', 'h#L50'], ['2 of 4', 'h#L150'], ['3 of 4', 'h#L250'], ['4 of 4', 'h#L350']])
    for (const s of seen) assert.ok(s.drawn && s.inList, `the match is drawn in the list's box (${JSON.stringify(s)})`)
    // one message at a time is drawn out of the list's rule, and none once the box is emptied
    const forced = () => frame().evaluate(() => [...document.querySelectorAll<HTMLElement>('.thimble-msg')].filter((e) => e.style.contentVisibility).map((e) => e.getAttribute('data-anchor')))
    assert.deepEqual(await forced(), ['h#L350'])
    await frame().locator('.thimble-search-input').fill('')
    await p.waitForTimeout(300)
    assert.deepEqual(await forced(), [])
    assert.deepEqual(errors, [])
    await p.close()
  })
})

describe('a boxed message', () => {
  for (const dark of [false, true]) {
    test(`a pull request's opening post: a box beside its avatar, the author, what they did and the time on a tinted head, the words inside; a comment after it unboxed (${dark ? 'dark' : 'light'})`, async () => {
      const doc = page(`<div id="msgs"></div>
<script>
${dark ? "document.documentElement.setAttribute('data-paper', 'dark')" : ''}
window.conv = thimble.messages({ mount: '#msgs' })
conv.draw(${JSON.stringify([
        { ref: 'b.jsonl#L1', t: T0, author: 'agent-03', box: true, said: 'opened this pull request', text: 'Fixes the zanzibar case.\n\nThe parser read a time with no zone in the machine\'s.' },
        { ref: 'b.jsonl#L2', t: T0 + 60, author: 'agent-03', text: 'Tests pass on main.' },
      ])})
</script>`)
      const { page: p, frame, errors } = await framed(doc)
      const [row, avatar, box, head, said, time, body, next] = await Promise.all(
        [msg(1), msg(1, '.avatar'), msg(1, '.thimble-msg-box'), msg(1, '.thimble-msg-boxhead'), msg(1, '.thimble-msg-said'), msg(1, '.thimble-msg-time'), msg(1, '.thimble-msg-body'), msg(2)].map((s) => boxOf(frame, s)),
      )
      // the avatar in the rail at the box's left, the box inside its row, its head on top, the words inside under it
      assert.ok(avatar.right <= box.x && box.x - avatar.right < 16 && Math.abs(avatar.y - box.y) < 4, `the avatar beside the box (${JSON.stringify({ avatar, box })})`)
      assert.ok(box.x >= row.x && box.right <= row.right && box.y >= row.y && box.bottom <= row.bottom, 'the box inside its row')
      assert.ok(Math.abs(head.y - box.y) <= 1.5 && head.bottom <= body.y && body.bottom < box.bottom && body.x > box.x + 4 && body.right < box.right - 4, `the head on top, the words inside (${JSON.stringify({ box, head, body })})`)
      assert.ok(Math.abs(time.y - said.y) < 3 && box.right - time.right < 24 && time.x > said.right, `the time at the right of the head (${JSON.stringify({ said, time, box })})`)
      assert.equal(await frame().evaluate((s) => document.querySelector(s)!.textContent, msg(1, '.thimble-msg-said')), 'agent-03 opened this pull request')
      // the box's edge in the theme's subtle border and its radius, the head on a tint of the ink that stands apart from the paper
      const look = await frame().evaluate((s) => {
        const b = getComputedStyle(document.querySelector(s + ' .thimble-msg-box')!)
        const h = getComputedStyle(document.querySelector(s + ' .thimble-msg-boxhead')!)
        const probe = document.createElement('div')
        probe.style.cssText = 'border:1px solid var(--border-subtle);border-radius:var(--radius-card)'
        document.body.appendChild(probe)
        const want = getComputedStyle(probe)
        const out = { edge: b.borderTopColor, want: want.borderTopColor, width: b.borderTopWidth, radius: b.borderTopLeftRadius, wantRadius: want.borderTopLeftRadius, head: h.backgroundColor, line: h.borderBottomColor }
        probe.remove()
        return out
      }, msg(1))
      assert.equal(look.edge, look.want)
      assert.equal(look.width, '1px')
      assert.equal(look.radius, look.wantRadius)
      assert.equal(look.line, look.want, 'a hairline under the head')
      const alpha = Number((/rgba\([^)]*,\s*([\d.]+)\)/.exec(look.head) || [])[1])
      assert.ok(alpha > 0.02 && alpha < 0.1, `the head on a light tint (${look.head})`)
      // the comment by the same author a minute later has its own head and avatar, and no box
      assert.ok(next.y >= row.bottom, 'the comment under the box')
      assert.deepEqual(await frame().evaluate((s) => [!!document.querySelector(s + ' .thimble-msg-head'), !!document.querySelector(s + ' .avatar'), !!document.querySelector(s + ' .thimble-msg-box')], msg(2)), [true, true, false])
      assert.deepEqual(errors, [])
      await p.close()
    })
  }
})

describe('the messages alone', () => {
  test('drawn with no other part: folds open and close, a long body behind Show more, a pick, reveal', async () => {
    const { page: p, frame, errors } = await framed(ALONE)
    assert.equal(await frame().evaluate(() => document.querySelectorAll('.thimble-msg').length), 8)
    assert.equal(await frame().evaluate(() => document.querySelectorAll('[data-color], [data-colour], [data-thimble-edge], .thimble-colour-strip').length), 0, 'no Color by, no bar')
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
