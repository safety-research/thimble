// A newer version of a view loaded where the analyst was, in a real browser (backend/app/viewer_bridge.js pageState and
// restore): a page asked for its `state` answers with the element the analyst last clicked, the scroll positions of
// the page's boxes, the fields they typed in and the chosen option of each segmented control; the newer version's page,
// whose records arrive only after a fetch, gets them back from `restore`, the scroll positions once its content is
// there. A scroll by the analyst while it restores stops it. What ViewerFrame does with them is view-updated.test.tsx.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { FRONTEND, launch } from './page.ts'

const BRIDGE = readFileSync(path.join(FRONTEND, '..', 'backend', 'app', 'viewer_bridge.js'), 'utf8')
let browser: Browser
let page: Page

// a list of threads in a scrolling box beside a search field and a segmented control; the rows arrive after a fetch,
// as a view's records do, and `newer` marks the version built after it
const view = (newer: boolean) => `<!doctype html><html><head>
<style>#list{height:120px;overflow:auto} .row{height:30px} .seg-opt.active{font-weight:600}</style>
<script>${BRIDGE.replace(/<\/script/g, '<\\/script')}</script></head><body class="${newer ? 'newer' : ''}">
<input id="q" type="search" value="">
<span class="seg"><button class="seg-opt active">All</button><button class="seg-opt">Open</button></span>
<div id="list"></div>
<script>
  let picked = 'All'
  for (const b of document.querySelectorAll('.seg-opt')) b.onclick = () => {
    for (const o of document.querySelectorAll('.seg-opt')) o.classList.toggle('active', o === b)
    picked = b.textContent
  }
  thimble.fetch({ op: 'threads' }).then((n) => {
    const list = document.getElementById('list')
    for (let i = 0; i < n; i++) {
      const row = document.createElement('div')
      row.className = 'row'
      row.dataset.anchor = 'view:threads/t' + i
      row.textContent = 'thread ' + i
      list.append(row)
    }
  })
</script></body></html>`

beforeAll(async () => {
  browser = await launch()
  page = await browser.newPage()
  await page.setContent('<!doctype html><html><body><iframe id="f" sandbox="allow-scripts" style="border:0;width:400px;height:300px"></iframe></body></html>')
  await page.evaluate(() => {
    const w = window as any
    w.__msgs = []
    w.__delay = 0
    addEventListener('message', (e) => {
      const d = (e.data || {}) as any
      w.__msgs.push(d)
      // the page's records: 40 threads, after __delay ms
      if (d.type === 'thimble:fetch') setTimeout(() => (e.source as Window).postMessage({ type: 'thimble:result', id: d.id, data: 40 }, '*'), w.__delay)
    })
  })
})
afterAll(async () => {
  await browser?.close()
})

const frame = () => page.frames().find((f) => f !== page.mainFrame())!
const load = async (doc: string) => {
  await page.evaluate((d) => {
    ;(window as any).__msgs = []
    ;(document.getElementById('f') as HTMLIFrameElement).srcdoc = d
  }, doc)
  await page.waitForFunction(() => (window as any).__msgs.some((m: any) => m.type === 'thimble:ready'))
}
const post = (msg: object) => page.evaluate((m) => (document.getElementById('f') as HTMLIFrameElement).contentWindow!.postMessage(m, '*'), msg)
const askState = async () => {
  await post({ type: 'thimble:state', id: 7 })
  await page.waitForFunction(() => (window as any).__msgs.some((m: any) => m.type === 'thimble:state' && m.id === 7))
  return page.evaluate(() => (window as any).__msgs.find((m: any) => m.type === 'thimble:state' && m.id === 7).state)
}

test('a page says what the analyst is looking at, and the newer version gets it back once its records arrive', async () => {
  await load(view(false))
  await frame().waitForFunction(() => document.querySelectorAll('.row').length === 40)
  await frame().fill('#q', 'deadline')
  await frame().click('.seg-opt:nth-child(2)')
  await frame().click('[data-anchor="view:threads/t3"]')
  await frame().evaluate(() => (document.getElementById('list')!.scrollTop = 450))
  const state = await askState()
  assert.deepEqual(state, {
    ref: 'view:threads/t3',
    scroll: [{ path: '#list', top: 450, left: 0 }],
    fields: [{ path: '#q', value: 'deadline' }],
    segs: [{ path: '1', text: 'Open' }],
  })

  await page.evaluate(() => ((window as any).__delay = 300))
  await load(view(true))
  await post({ type: 'thimble:open', open: { ref: state.ref } })
  await post({ type: 'thimble:restore', state })
  await frame().waitForFunction(() => document.querySelectorAll('.row').length === 40)
  await frame().waitForFunction(() => document.getElementById('list')!.scrollTop === 450, undefined, { timeout: 3000 })
  const back = await frame().evaluate(() => ({
    newer: document.body.className,
    q: (document.getElementById('q') as HTMLInputElement).value,
    seg: document.querySelector('.seg-opt.active')!.textContent,
  }))
  assert.deepEqual(back, { newer: 'newer', q: 'deadline', seg: 'Open' })
})

test("a scroll by the analyst while the page restores stops it, so the page never pulls against them", async () => {
  await page.evaluate(() => ((window as any).__delay = 600))
  await load(view(true))
  await post({ type: 'thimble:restore', state: { ref: null, scroll: [{ path: '#list', top: 450, left: 0 }], fields: [], segs: [] } })
  await frame().dispatchEvent('#list', 'wheel')
  await frame().waitForFunction(() => document.querySelectorAll('.row').length === 40)
  await page.waitForTimeout(300)
  assert.equal(await frame().evaluate(() => document.getElementById('list')!.scrollTop), 0)
})
