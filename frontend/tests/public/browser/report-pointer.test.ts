// The ⌘ pointer in the report editor (src/pointer/CmdPointer.tsx over src/report/Editor.tsx), mounted with the report
// page. ProseMirror reads the pointer's key with a click as its select-node modifier, so the editor leaves those presses
// to the pointer: a ⌘-click asks about the whole block and leaves no block selected, and a ⌘-drag, even one that starts
// in the block just clicked or inside a standing selection, selects text rather than dragging the block, and asks
// about exactly that text on the sentences it covers. The check runs off a Mac, where Ctrl is the pointer's key and
// ProseMirror's modifier alike.
import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { addStyles, bundle, cleanup, launch, ORIGIN, serve, src } from './page.ts'

let script: string
let browser: Browser

const sentence = (id: string, text: string) => ({ id, text, refs: [], tags: [] })
const DOC = {
  title: 'Why customers were charged twice',
  frame: false,
  generation: 1,
  sections: [
    {
      id: 'h1',
      heading: 'What happened',
      paragraphs: [
        { id: 'p1', sentences: [sentence('s1', 'The billing job charged the same customer three times in one run and sent the receipts a second later.'), sentence('s2', 'The ledger shows the charges land in order, before any refund was asked for.')] },
        { id: 'p2', sentences: [sentence('s3', 'The customer then wrote to support for a refund, and two agents answered within a minute.')] },
      ],
      figures: [],
    },
  ],
  comments: [],
}

beforeAll(async () => {
  script = await bundle('report-pointer', [
    `import { createRoot } from 'react-dom/client'`,
    `import { flushSync } from 'react-dom'`,
    `import { ReportPage } from '${src('report/ReportPage.tsx')}'`,
    `import { CmdPointer } from '${src('pointer/CmdPointer.tsx')}'`,
    `window.__mount = (doc) => { const el = document.createElement('div'); el.style.cssText = 'position:absolute;left:0;top:0;width:1200px;height:760px;display:flex'; document.body.appendChild(el); flushSync(() => createRoot(el).render(<><div className="wu-root"><div className="wu-body"><ReportPage ws="w" slug="report" doc={doc} filter={null} client="t" onSaved={() => {}} /></div></div><CmdPointer ws="w" /></>)) }`,
  ])
  browser = await launch()
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

interface Posted {
  anchor: string
  anchor_text: string | null
}

async function open(): Promise<{ page: Page; posted: Posted[]; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } })
  const errors: string[] = []
  const posted: Posted[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await serve(page, (req, url) => {
    if (url.pathname === '/api/ws/w/canvas') return { json: { cells: [], groups: [] } }
    if (url.pathname === '/api/ws/w/checks') return { json: [] }
    if (url.pathname === '/api/ws/w/chats' && req.method() === 'POST') {
      posted.push(JSON.parse(req.postData() ?? '{}'))
      return { json: { detail: 'no session' }, status: 409 }
    }
    return undefined
  })
  await page.goto(`${ORIGIN}/?ws=w`)
  await addStyles(page, ['tokens', 'base', 'components', 'spinner', 'refchip', 'report', 'pointer'], true)
  await page.addScriptTag({ path: script })
  await page.evaluate(() => {
    ;(window as any).__drags = 0
    document.addEventListener('dragstart', () => (window as any).__drags++, true)
  })
  await page.evaluate((doc) => (window as any).__mount(doc), DOC)
  await page.waitForSelector('.wu-s[data-sid="s3"]')
  await page.waitForTimeout(300)
  return { page, posted, errors }
}

/** A point just inside the left edge of character `i` of sentence `sid`'s text, where a press puts the caret before it. */
const charAt = (page: Page, sid: string, i: number) =>
  page.evaluate(
    ([sid, i]) => {
      const t = document.createTreeWalker(document.querySelector(`.wu-s[data-sid="${sid}"]`)!, NodeFilter.SHOW_TEXT).nextNode() as Text
      const r = document.createRange()
      r.setStart(t, i as number)
      r.setEnd(t, (i as number) + 1)
      const b = r.getBoundingClientRect()
      return { x: b.left + 1, y: b.top + b.height / 2 }
    },
    [sid, i] as const,
  )

const state = (page: Page) =>
  page.evaluate(() => ({
    box: !!document.querySelector('.pointer-box'),
    nodeSelected: !!document.querySelector('.ProseMirror-selectednode'),
    drags: (window as any).__drags as number,
  }))

async function sweep(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10)
}

/** A ⌘-drag from `from` to `to`, then a question sent from the box; the thread the box posted. */
async function pointDrag(page: Page, posted: Posted[], from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y)
  await page.keyboard.down('Control')
  await page.mouse.down()
  await sweep(page, from, to)
  await page.mouse.up()
  await page.keyboard.up('Control')
  await page.waitForSelector('.pointer-box')
  const after = await state(page)
  await page.keyboard.type('why')
  await page.keyboard.press('Enter')
  for (let i = 0; i < 50 && !posted.length; i++) await page.waitForTimeout(50)
  await page.keyboard.press('Escape')
  return { after, thread: posted.pop() }
}

test('a ⌘-click asks about the whole block and leaves no block selected; a ⌘-drag in that block then selects a span of it', async () => {
  const { page, posted, errors } = await open()
  try {
    const TEXT = 'The billing job charged the same customer three times in one run and sent the receipts a second later.'
    const at = await charAt(page, 's1', TEXT.indexOf('customer'))
    await page.mouse.move(at.x, at.y)
    await page.keyboard.down('Control')
    await page.mouse.move(at.x + 1, at.y)
    await page.mouse.click(at.x + 1, at.y)
    await page.keyboard.up('Control')
    await page.waitForSelector('.pointer-box')
    assert.equal((await state(page)).nodeSelected, false, 'the ⌘-click selects no block in the editor')
    await page.keyboard.type('what is this')
    await page.keyboard.press('Enter')
    for (let i = 0; i < 50 && !posted.length; i++) await page.waitForTimeout(50)
    assert.equal(posted.pop()?.anchor, 'report:report#pp1', 'the ⌘-click is about the paragraph')
    await page.keyboard.press('Escape')

    const from = await charAt(page, 's1', TEXT.indexOf('same'))
    const to = await charAt(page, 's1', TEXT.indexOf(' three'))
    const { after, thread } = await pointDrag(page, posted, from, to)
    assert.equal(after.drags, 0, 'nothing is dragged')
    assert.equal(thread?.anchor, 'report:report#s1', 'the span is on its sentence')
    assert.equal(thread?.anchor_text, 'same customer', 'the box quotes exactly the dragged text')
    assert.equal(await page.locator('.wu-s[data-sid="s1"]').textContent(), TEXT, 'the text stays where it was')
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})

test('a ⌘-drag that starts inside a standing selection selects anew, and one across paragraphs takes the sentences it covers', async () => {
  const { page, posted, errors } = await open()
  try {
    const TEXT = 'The billing job charged the same customer three times in one run and sent the receipts a second later.'
    const a = await charAt(page, 's1', TEXT.indexOf('billing'))
    const b = await charAt(page, 's1', TEXT.indexOf(' in one'))
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await sweep(page, a, b)
    await page.mouse.up()
    assert.equal(await page.evaluate(() => document.getSelection()!.toString()), 'billing job charged the same customer three times')

    const from = await charAt(page, 's1', TEXT.indexOf('charged'))
    const to = await charAt(page, 's1', TEXT.indexOf(' same'))
    const inside = await pointDrag(page, posted, from, to)
    assert.equal(inside.after.drags, 0, 'the standing selection is not dragged')
    assert.equal(inside.thread?.anchor_text, 'charged the', 'the new span alone is quoted')

    const end = await charAt(page, 's3', 'The customer'.length)
    const across = await pointDrag(page, posted, from, end)
    assert.equal(across.after.drags, 0)
    assert.equal(across.thread?.anchor, 'report:report#s1,report:report#s2,report:report#s3', 'every sentence the span covers')
    assert.match(across.thread?.anchor_text ?? '', /^charged the same .* before any refund was asked for\.\s*The customer$/s)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
})
