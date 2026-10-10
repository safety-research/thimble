// The view kit's tree (backend/app/viewer_tree.js, thimble.tree) in a real browser, a page holding the view in a
// sandboxed frame as ViewerFrame does: 5,000 nodes draw within a bound far above what they take, and only the rows near
// the view are drawn as it scrolls; at 200 px wide a row's number never stands over its name, which is cut short and
// shown whole on hover; the keys move, fold, open and pick, the find keeps the matches with their folders open, and the
// folds and the choice are kept per view, Reset putting back the folds it opened with; with Rows, the nodes are
// rows.groups's, with their records counted. It needs no Color by, time range or side panel.
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
  ['viewer_colour.js', 'viewer_controls.js', 'viewer_side.js', 'viewer_transcript.js', 'viewer_search.js', 'viewer_table.js', 'viewer_tree.js', 'viewer_range.js']
    .map((n) => `<script>${inline(read(n))}</script>`)
    .join('') +
  `<style>${read('viewer_kit.css')}</style><style>${read('viewer_parts.css')}</style>`
const TOKENS =
  ':root{--label-1:#025ac3;--label-2:#d0750a;--label-3:#08632f;--label-none:#a09c93;--ink-rgb:27,26,24;--surface-card:#fffdf8;' +
  '--text-primary:#000;--text-secondary:#4a4844;--text-tertiary:#726f69;--text-placeholder:#a09c93;--accent:#5135ff;--radius-chip:4px;--radius-ui:6px;' +
  '--h-row:28px;--control-sm:28px;--h-control:24px;--h-chip:20px;--text-xs:12px;--text-ui-sm:12px;--text-sm:13px;--text-mono-sm:11px;--border-subtle:rgba(27,26,24,0.12);' +
  '--border-hairline:rgba(27,26,24,0.08);--border-strong:rgba(27,26,24,0.3);--surface-selected:rgba(27,26,24,0.06);--hl-bg:rgba(255,214,0,0.35);--font-body:sans-serif;--font-mono:monospace}'

/** A view whose body is `script`, with a mount #tree `width` px wide and 480 px tall; what it asks thimble to keep is
 * the outer page's window.__kept, and `kept` is what thimble kept of it before. */
const view = (script: string, width: number, kept?: unknown) => `<!doctype html><html><head><style>${TOKENS} html,body{margin:0;height:100%}
body{font:13px sans-serif;background:#fffdf8} .top{display:flex;gap:8px;padding:8px;height:28px} #tree{width:${width}px;height:480px}</style>
${kept ? `<script>window.__thimbleColour = ${JSON.stringify(kept)}</script>` : ''}${KIT}</head><body>
<div class="top"><span id="colour"></span></div><div id="tree"></div>
<script>window.picks = []
${script}</script></body></html>`

let browser: Browser
beforeAll(async () => {
  browser = await launch()
})
afterAll(async () => {
  await browser?.close()
  cleanup()
})

async function framed(script: string, width = 300, kept?: unknown): Promise<{ page: Page; frame: () => Frame; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.setContent(`<!doctype html><html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="border:0;width:900px;height:640px"></iframe></body></html>`)
  await page.evaluate(() => {
    const w = window as unknown as { __kept: unknown[] }
    w.__kept = []
    window.addEventListener('message', (e) => e.data && e.data.type === 'thimble:colour' && w.__kept.push(e.data.state))
  })
  await page.evaluate((doc) => ((document.getElementById('f') as HTMLIFrameElement).srcdoc = doc), view(script, width, kept))
  const frame = () => page.frames().find((f) => f !== page.mainFrame())!
  await page.waitForTimeout(300)
  await frame().waitForSelector('.thimble-tree-row', { state: 'attached' })
  return { page, frame, errors }
}
const lastKept = (page: Page) => page.evaluate(() => (window as unknown as { __kept: any[] }).__kept.at(-1))
/** the rows drawn, in the order they stand: their names and keys */
const drawn = (frame: () => Frame) =>
  frame().evaluate(() =>
    [...document.querySelectorAll('.thimble-tree-row')]
      .map((r) => ({ top: (r as HTMLElement).offsetTop, name: r.querySelector('.thimble-tree-name')!.textContent, key: r.getAttribute('data-key'), active: r.classList.contains('active'), cursor: r.classList.contains('is-cursor') }))
      .sort((a, b) => a.top - b.top),
  )

// a repository's files as paths: 50 folders of 10 folders of 10 files
const REPO = `const files = []
for (let a = 0; a < 50; a++) for (let b = 0; b < 10; b++) for (let c = 0; c < 10; c++) files.push({ key: 'pkg' + a + '/mod' + b + '/file' + c + '.py', n: c + 1 })`

describe('the tree in a frame', () => {
  test('5,000 nodes draw within a bound, and only the rows near the view are drawn as it scrolls', async () => {
    const { page, frame, errors } = await framed(`
const flat = Array.from({ length: 5000 }, (_, i) => ({ key: 'c' + i, name: 'channel-' + i, n: i }))
const t0 = performance.now()
window.tree = thimble.tree({ mount: '#tree', items: flat })
window.ms = performance.now() - t0
${REPO}
const t1 = performance.now()
window.repo = thimble.tree({ mount: document.body.appendChild(Object.assign(document.createElement('div'), { id: 'repo', style: 'height:300px;width:300px' })), split: '/', items: files })
window.repoMs = performance.now() - t1`)
    const got = await frame().evaluate(() => {
      const w = window as any
      return { ms: w.ms, repoMs: w.repoMs, rows: document.querySelectorAll('#tree .thimble-tree-row').length, height: document.querySelector('#tree .thimble-tree-body')!.getBoundingClientRect().height, repoNodes: w.repo.nodes.length }
    })
    // a bound many times what it takes (about 20 ms here), which fails a tree that draws every row
    assert.ok(got.ms < 400 && got.repoMs < 400, `drawn in ${got.ms} ms and ${got.repoMs} ms`)
    assert.equal(got.height, 5000 * 24, 'the rows take their whole height')
    // 480 px is 20 rows, and twelve more below them
    assert.ok(got.rows >= 20 && got.rows <= 20 + 2 * 12 + 2, `${got.rows} rows drawn`)
    assert.equal(got.repoNodes, 5000 + 500 + 50)
    // scrolled to the middle: the rows there are drawn, and no more than before
    await frame().evaluate(() => (document.getElementById('tree')!.scrollTop = 2500 * 24))
    await page.waitForTimeout(150)
    const mid = await frame().evaluate(() => {
      const box = document.getElementById('tree')!.getBoundingClientRect()
      const at = document.elementFromPoint(box.left + 40, box.top + 5)!.closest('.thimble-tree-row')
      return { name: at && at.querySelector('.thimble-tree-name')!.textContent, rows: document.querySelectorAll('#tree .thimble-tree-row').length }
    })
    assert.equal(mid.name, 'channel-2500')
    assert.ok(mid.rows <= 20 + 2 * 12 + 2, `${mid.rows} rows drawn`)
    assert.deepEqual(errors, [])
    await page.close()
  })

  test("at 200 px a row's number stands right of its name, never over it; a name cut short shows whole on hover", async () => {
    const { page, frame, errors } = await framed(
      `${REPO}
files.push({ key: 'pkg0/mod0/a_module_whose_name_runs_on_far_past_the_width_of_the_tree.py', n: 123456 })
window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'kind', title: 'Kind' }] })
window.tree = thimble.tree({ mount: '#tree', split: '/', items: files, mix: (n) => n.children ? null : { a: n.item.n, b: 10 - n.item.n } })
tree.reveal('pkg0/mod0/a_module_whose_name_runs_on_far_past_the_width_of_the_tree.py')`,
      200,
    )
    const rows = await frame().evaluate(() =>
      [...document.querySelectorAll('.thimble-tree-row')].map((r) => {
        const box = (e: Element | null) => (e ? e.getBoundingClientRect() : null)
        const name = r.querySelector('.thimble-tree-name')!
        return { name: box(name)!, cut: name.scrollWidth > name.clientWidth, n: box(r.querySelector('.thimble-tree-n')), end: box(r.querySelector('.thimble-tree-end')), row: box(r)!, text: name.textContent }
      }),
    )
    assert.ok(rows.length > 10)
    for (const r of rows) {
      assert.ok(r.n && r.end, `every row has its number: ${r.text}`)
      assert.ok(r.name.right <= r.end!.left + 0.5, `the number never stands over the name: ${JSON.stringify(r)}`)
      assert.ok(r.n!.right <= r.row.right + 0.5, `the number stays in its row: ${r.text}`)
    }
    const long = rows.find((r) => r.text!.startsWith('a_module'))!
    assert.equal(long.cut, true, 'the long name is cut with an ellipsis')
    await frame().locator('.thimble-tree-row.active .thimble-tree-name').hover()
    await page.waitForTimeout(150)
    const tip = await frame().evaluate(() => (document.querySelector('.thimble-tip') as HTMLElement | null)?.textContent)
    assert.equal(tip, 'a_module_whose_name_runs_on_far_past_the_width_of_the_tree.py')
    assert.equal(await frame().evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0)
    assert.deepEqual(errors, [])
    await page.close()
  })

  test('↑ ↓ move, → opens, ← folds and goes to the parent, Enter picks; a click on a chevron folds without picking', async () => {
    const { page, frame } = await framed(`${REPO}
window.tree = thimble.tree({ mount: '#tree', split: '/', items: files, anchor: (n) => 'view:repo/' + n.key, onPick: (n) => picks.push(n.key) })`)
    // 50 folders do not fit 20 rows open: the tree opens with them folded
    let rows = await drawn(frame)
    assert.deepEqual(rows.slice(0, 3).map((r) => r.name), ['pkg0', 'pkg1', 'pkg2'])
    assert.equal(await frame().evaluate(() => document.querySelector('.thimble-tree-row')!.getAttribute('data-anchor')), 'view:repo/pkg0')
    await frame().locator('#tree .thimble-tree-body').focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(50)
    rows = await drawn(frame)
    assert.deepEqual(rows.slice(0, 4).map((r) => r.name), ['pkg0', 'pkg1', 'mod0', 'mod1'], 'pkg1 opens')
    assert.equal(rows.find((r) => r.cursor)!.name, 'pkg1')
    // the ring on the row the keys are on, which the tree names as its active row
    const ring = () =>
      frame().evaluate(() => {
        const r = document.querySelector('.thimble-tree-row.is-cursor')
        return { outline: r ? getComputedStyle(r).outlineStyle : null, active: document.querySelector('.thimble-tree-body')!.getAttribute('aria-activedescendant') === (r && r.id) }
      })
    assert.deepEqual(await ring(), { outline: 'solid', active: true })
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(50)
    rows = await drawn(frame)
    assert.deepEqual(rows.slice(2, 5).map((r) => r.name), ['mod0', 'file0.py', 'file1.py'], '→ goes into pkg1, opens mod0 and goes to its first file')
    assert.equal(rows.find((r) => r.cursor)!.name, 'file0.py')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(50)
    assert.deepEqual(await frame().evaluate(() => (window as any).picks), ['pkg1/mod0/file1.py'])
    assert.equal((await drawn(frame)).find((r) => r.active)!.name, 'file1.py')
    assert.equal(await frame().evaluate(() => (window as any).tree.chosen), 'pkg1/mod0/file1.py')
    // ← goes to the parent, then folds it
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await page.waitForTimeout(50)
    rows = await drawn(frame)
    assert.equal(rows.find((r) => r.cursor)!.name, 'mod0')
    assert.deepEqual(rows.slice(2, 4).map((r) => r.name), ['mod0', 'mod1'])
    // a chevron's click folds pkg1 and picks nothing
    await frame().locator('.thimble-tree-row[data-key="pkg1"] .thimble-tree-fold').click()
    await page.waitForTimeout(50)
    assert.deepEqual((await drawn(frame)).slice(0, 3).map((r) => r.name), ['pkg0', 'pkg1', 'pkg2'])
    assert.equal((await frame().evaluate(() => (window as any).picks)).length, 1)
    // a click on a row picks it and opens it, with no ring; on the chosen folder again, folds it
    await frame().locator('.thimble-tree-row[data-key="pkg2"]').click()
    await page.waitForTimeout(50)
    assert.deepEqual((await drawn(frame)).slice(2, 4).map((r) => r.name), ['pkg2', 'mod0'])
    assert.equal((await ring()).outline, 'none')
    await frame().locator('.thimble-tree-row[data-key="pkg2"]').click()
    await page.waitForTimeout(50)
    assert.deepEqual((await drawn(frame)).slice(2, 4).map((r) => r.name), ['pkg2', 'pkg3'])
    assert.deepEqual(await frame().evaluate(() => (window as any).picks), ['pkg1/mod0/file1.py', 'pkg2', 'pkg2'])
    await page.close()
  })

  test('the find keeps the matching names with their folders open; Enter picks the first, Escape puts the tree back', async () => {
    const { page, frame } = await framed(`${REPO}
files.push({ key: 'pkg7/mod3/needle.py', n: 1 }, { key: 'pkg31/needle_two.py', n: 2 })
window.tree = thimble.tree({ mount: '#tree', split: '/', items: files, find: true, onPick: (n) => picks.push(n.key) })`)
    await frame().locator('.thimble-tree-input').fill('NEEDLE')
    await page.waitForTimeout(50)
    const rows = await drawn(frame)
    assert.deepEqual(rows.map((r) => r.name), ['pkg7', 'mod3', 'needle.py', 'pkg31', 'needle_two.py'])
    const marks = await frame().evaluate(() => [...document.querySelectorAll('.thimble-tree-hit')].map((m) => m.textContent))
    assert.deepEqual(marks, ['needle', 'needle'])
    await page.keyboard.press('Enter')
    await page.waitForTimeout(50)
    assert.deepEqual(await frame().evaluate(() => (window as any).picks), ['pkg7/mod3/needle.py'])
    // ↓ from the field goes into the tree, on the first match
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(50)
    assert.equal((await drawn(frame)).find((r) => r.cursor)!.name, 'pkg31')
    // nothing matches: a line says so
    await frame().locator('.thimble-tree-input').fill('nothing like it')
    await page.waitForTimeout(50)
    assert.equal(await frame().evaluate(() => document.querySelectorAll('.thimble-tree-row').length), 0)
    assert.equal(await frame().evaluate(() => (document.querySelector('.thimble-tree-none') as HTMLElement).hidden), false)
    // Escape empties it: the folders the find opened fold again, but those above the file it picked
    await frame().locator('.thimble-tree-input').press('Escape')
    await page.waitForTimeout(50)
    const back = await drawn(frame)
    assert.deepEqual(back.slice(6, 12).map((r) => r.name), ['pkg6', 'pkg7', 'mod0', 'mod1', 'mod2', 'mod3'])
    assert.equal(back.find((r) => r.active)!.key, 'pkg7/mod3/needle.py')
    // 50 folders, pkg7's 10 and mod3's 11 files: pkg31 is folded again
    assert.equal(await frame().evaluate(() => document.querySelector('.thimble-tree-body')!.getBoundingClientRect().height), (50 + 10 + 11) * 24)
    assert.equal(await frame().evaluate(() => (document.querySelector('.thimble-tree-input') as HTMLInputElement).value), '')
    await page.close()
  })

  test('the folds and the choice are kept per view; Reset puts back the folds the tree opened with and keeps the choice', async () => {
    const script = `${REPO}
window.colour = thimble.colorBy({ mount: '#colour', fields: [] })
window.tree = thimble.tree({ mount: '#tree', split: '/', items: files, key: 'repo' })`
    const { page, frame } = await framed(script)
    await frame().evaluate(() => {
      const t = (window as any).tree
      t.fold('pkg3', false)
      t.fold('pkg3/mod5', false)
      t.choose('pkg3/mod5/file2.py')
    })
    await page.waitForTimeout(100)
    const kept = await lastKept(page)
    assert.deepEqual(kept.parts['tree:repo'], { open: ['pkg3', 'pkg3/mod5'], chosen: 'pkg3/mod5/file2.py' })
    await page.close()
    // the page built again on what thimble kept opens on those folds and that choice
    const again = await framed(script, 300, kept)
    let rows = await drawn(again.frame)
    assert.deepEqual(rows.slice(3, 6).map((r) => r.name), ['pkg3', 'mod0', 'mod1'])
    assert.equal(rows.find((r) => r.active)!.key, 'pkg3/mod5/file2.py')
    assert.equal(await again.frame().evaluate(() => (window as any).tree.chosen), 'pkg3/mod5/file2.py')
    // Reset shows, and puts back the folds the tree opened with; the choice stays
    await again.frame().locator('.thimble-reset').click()
    await again.page.waitForTimeout(100)
    rows = await drawn(again.frame)
    assert.deepEqual(rows.slice(3, 5).map((r) => r.name), ['pkg3', 'pkg4'])
    assert.equal(await again.frame().evaluate(() => (window as any).tree.chosen), 'pkg3/mod5/file2.py')
    assert.equal((await lastKept(again.page)).parts['tree:repo'].open, undefined)
    assert.equal(await again.frame().evaluate(() => (document.querySelector('.thimble-reset') as HTMLElement).hidden), true)
    await again.page.close()
  })

  test('with split, each item is a node under its key as given', async () => {
    const { page, frame, errors } = await framed(`
window.tree = thimble.tree({ mount: '#tree', split: '/', items: [{ key: 'dse/StartSeite', n: 456 }, { key: 'dse/StartSeite/', n: 1 }, { key: 'dse/Hilfe', n: 7 }, { key: '/src/a.py', n: 2 }] })`)
    // two pages whose keys differ by a slash stay two nodes, each with its own number
    const nodes = await frame().evaluate(() => (window as any).tree.nodes.map((n: any) => [n.key, n.name, n.parent, n.n]))
    assert.deepEqual(nodes, [
      ['dse', 'dse', null, 464],
      ['dse/Hilfe', 'Hilfe', 'dse', 7],
      ['dse/StartSeite', 'StartSeite', 'dse', 456],
      ['dse/StartSeite/', 'StartSeite/', 'dse', 1],
      ['/src', 'src', null, 2],
      ['/src/a.py', 'a.py', '/src', 2],
    ])
    assert.equal(await frame().evaluate(() => (window as any).tree.reveal('dse/StartSeite/')), true)
    assert.equal((await drawn(frame)).find((r) => r.active)!.name, 'StartSeite/')
    assert.deepEqual(errors, [])
    await page.close()
  })

  test("the page's search leaves the tree out, which has its own find", async () => {
    const { page, frame, errors } = await framed(`
window.tree = thimble.tree({ mount: '#tree', items: [{ key: 'StartSeite' }, { key: 'Hilfe' }] })
document.body.insertAdjacentHTML('beforeend', '<div id="list"><p data-anchor="r1">StartSeite, a record</p></div>')
window.search = thimble.search({ mount: '#colour' })`)
    // the tree's names are groups, not records: the page's search counts the records alone
    await frame().evaluate(() => (window as any).search.set('startseite'))
    await page.waitForTimeout(200)
    assert.equal(await frame().evaluate(() => (window as any).search.count), 1)
    assert.deepEqual(errors, [])
    await page.close()
  })

  test('a tree that scrolls in its mount moves only the mount when it reveals a node or the keys move', async () => {
    const { page, frame } = await framed(`
// the tree stands low in a page that scrolls, all of it in view
document.getElementById('tree').insertAdjacentHTML('beforebegin', '<div style="height:100px"></div>')
document.body.insertAdjacentHTML('beforeend', '<div style="height:2000px"></div>')
window.tree = thimble.tree({ mount: '#tree', items: Array.from({ length: 3000 }, (_, i) => ({ key: 'c' + i, n: i })) })`)
    const at = () =>
      frame().evaluate(() => {
        const r = document.querySelector('.thimble-tree-row.active, .thimble-tree-row.is-cursor')!.getBoundingClientRect()
        const m = document.getElementById('tree')!.getBoundingClientRect()
        return { page: document.scrollingElement!.scrollTop, top: r.top - m.top, bottom: m.bottom - r.bottom, height: m.height }
      })
    await frame().evaluate(() => (window as any).tree.reveal('c2000'))
    let got = await at()
    assert.equal(got.page, 0, 'the page stays where it was')
    assert.ok(Math.abs(got.top + 12 - got.height / 2) <= 12, `the node stands in the middle of the tree: ${JSON.stringify(got)}`)
    // the keys walk past the tree's bottom edge: the tree follows, the page does not
    await frame().locator('#tree .thimble-tree-body').focus()
    for (let k = 0; k < 14; k++) await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(50)
    got = await at()
    assert.equal(got.page, 0)
    assert.ok(got.bottom >= 0 && got.top >= 0, JSON.stringify(got))
    await page.close()
  })

  test("with Rows, the nodes are rows.groups's with their records counted, by a tree of fields and by another field", async () => {
    const { page, frame } = await framed(`
const PARENT = { lead: null, explore: 'lead', grep: 'explore', test: 'lead', solo: null }
const tools = ['Bash', 'Read', 'Grep']
window.calls = []
Object.keys(PARENT).forEach((s, si) => { if (s !== 'explore') for (let i = 0; i < 10 + si; i++) calls.push({ session: s, tool: tools[(i + si) % 3] }) })
window.colour = thimble.colorBy({ mount: '#colour', fields: [{ name: 'tool', title: 'Tool' }] })
window.rows = thimble.rows({ fields: [{ name: 'session', title: 'Session', parentOf: (k) => PARENT[k] }, { name: 'tool', title: 'Tool' }], onChange: () => tree.draw() })
window.tree = thimble.tree({ mount: '#tree', rows, items: calls, mix: true })`)
    const compare = () =>
      frame().evaluate(() => {
        const w = window as any
        const groups = w.rows.groups(w.calls).map((g: any) => ({ key: g.key, name: g.name, parent: g.parent, depth: g.depth, own: g.items.length }))
        const nodes = w.tree.nodes.map((n: any) => ({ key: n.key, name: n.name, parent: n.parent, depth: n.depth, own: n.items.length, n: n.n }))
        return { groups, nodes }
      })
    let got = await compare()
    assert.deepEqual(got.nodes.map(({ n, ...g }: any) => g), got.groups)
    // a group's number is its records and those of the groups under it; explore takes none of its own
    assert.deepEqual(got.nodes.map((n: any) => [n.key, n.n]), [['lead', 10 + 12 + 13], ['explore', 12], ['grep', 12], ['test', 13], ['solo', 14]])
    // a group's mix: its records' Color by values, in the row; a group takes no color of its own
    const lead = await frame().evaluate(() => {
      const r = document.querySelector('.thimble-tree-row[data-key="lead"]')!
      return { mix: r.querySelector('.thimble-mix')!.getAttribute('aria-label'), colour: r.getAttribute('data-colour') }
    })
    assert.match(lead.mix!, /^Tool: /)
    assert.equal(lead.colour, null)
    // Rows by another field: the tree regroups as the lanes do
    await frame().evaluate(() => (window as any).rows.choose('tool'))
    await page.waitForTimeout(100)
    got = await compare()
    assert.deepEqual(got.nodes.map(({ n, ...g }: any) => g), got.groups)
    assert.deepEqual(got.nodes.map((n: any) => n.name), ['Bash', 'Read', 'Grep'])
    assert.deepEqual((await drawn(frame)).map((r) => r.name), ['Bash', 'Read', 'Grep'])
    await page.close()
  })

  test('with Rows grouped by another choice, its groups open as they fit; the folds made in a choice come back with it', async () => {
    const { page, frame } = await framed(`
const PARENT = { lead: null, explore: 'lead', test: 'lead', solo: null }
const PLACE = { Bash: 'shell', Read: 'files', Grep: 'files' }
window.calls = []
Object.keys(PARENT).forEach((s, si) => ['Bash', 'Read', 'Grep'].forEach((tool) => calls.push({ session: s, tool })))
window.rows = thimble.rows({ fields: [{ name: 'session', title: 'Session', parentOf: (k) => PARENT[k] }, { name: 'tool', title: 'Tool', parentOf: (k) => PLACE[k] || null }], onChange: () => tree.draw() })
window.tree = thimble.tree({ mount: '#tree', rows, items: calls, key: 'calls' })`)
    const names = async () => (await drawn(frame)).map((r) => r.name)
    assert.deepEqual(await names(), ['lead', 'explore', 'test', 'solo'])
    await frame().evaluate(() => (window as any).tree.fold('lead', true))
    await page.waitForTimeout(50)
    assert.deepEqual(await names(), ['lead', 'solo'])
    // by tool, a tree of its own: every group fits, so every group opens
    await frame().evaluate(() => (window as any).rows.choose('tool'))
    await page.waitForTimeout(100)
    assert.deepEqual(await names(), ['shell', 'Bash', 'files', 'Read', 'Grep'])
    // back by session: lead folded, as it was left
    await frame().evaluate(() => (window as any).rows.choose('session'))
    await page.waitForTimeout(100)
    assert.deepEqual(await names(), ['lead', 'solo'])
    await page.close()
  })
})
