// The pointing gesture in a laid-out page (src/pointer/anchors.ts, PointerBox.tsx): a selection across cards gathers
// the outer anchors once, in document order; a sentence in a report block stands for its block; a word of a paragraph
// is a text hit with a rect on the point while a button and the margin are not; a click on a word takes its paragraph
// within the anchor, a long raw text its line; a clamped comment draws only its visible lines; and a chip in a cell
// takes the ask box beside the cell. The pure side is tests/public/pointer-model.test.ts.
import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'
import type { Browser, Page } from 'playwright'
import { bundle, cleanup, launch, src } from './page.ts'

let browser: Browser
let page: Page
let browserBundle: string

beforeAll(async () => {
  // the DOM side as globals for the page
  browserBundle = await bundle('pointer-page', [
    `import * as A from '${src('pointer/anchors.ts')}'`,
    `import { hostCell, regionPlace } from '${src('pointer/PointerBox.tsx')}'`,
    `;(window as any).__anchors = A`,
    `;(window as any).__box = { hostCell, regionPlace }`,
  ])
  browser = await launch()
  page = await browser.newPage()
})

afterAll(async () => {
  await browser?.close()
  cleanup()
})

test('anchorsInRange in a page: a selection across cards gathers the outer anchors once, in document order', async () => {
  await page.setContent(
    `<!doctype html><html><body>
      <p id="intro">Nothing anchored here.</p>
      <article data-anchor="cell:a1" data-anchor-text="Agents per run"><h3 id="q1">Agents per run</h3><div>a table</div></article>
      <article data-anchor="cell:b2"><h3 id="q2">Lines per file</h3><div>a chart</div></article>
      <section data-anchor="group:g9"><span data-anchor="report:report#s1" id="s1">First sentence.</span> <span data-anchor="report:report#s2" id="s2">Second sentence.</span></section>
      <p id="tail">Nothing anchored here either.</p>
    </body></html>`,
  )
  await page.addScriptTag({ path: browserBundle })
  const out = await page.evaluate(() => {
    const A = (window as any).__anchors
    const range = document.createRange()
    range.setStart(document.getElementById('intro')!.firstChild!, 5)
    range.setEnd(document.getElementById('s1')!.firstChild!, 5)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    const anchors = A.anchorsInSelection(sel)
    return {
      refs: anchors.map((a: any) => a.anchor),
      texts: anchors.map((a: any) => a.text),
      joined: A.joinAnchors(anchors),
      context: A.rangeContext(anchors, sel.toString()),
      collapsed: A.anchorsInSelection((() => {
        const s = window.getSelection()!
        s.removeAllRanges()
        const r = document.createRange()
        r.setStart(document.getElementById('q1')!.firstChild!, 1)
        r.collapse(true)
        s.addRange(r)
        return s
      })()).length,
    }
  })
  assert.deepEqual(out.refs, ['cell:a1', 'cell:b2', 'report:report#s1'], 'the cards, then the sentence the range enters; the group that holds it is skipped for its inner anchor')
  assert.equal(out.texts[0], 'Agents per run', 'data-anchor-text wins over the element text')
  assert.equal(out.joined, 'cell:a1,cell:b2,report:report#s1')
  assert.match(out.context, /^ng anchored here\.\s*Agents per run/, 'the selected text is the context')
  assert.equal(out.collapsed, 0, 'a collapsed selection gathers nothing')
})

test('cellOf in a page: text in a report block is the whole block, a chip in it keeps its own region, a line outside a block has none', async () => {
  await page.setContent(
    `<!doctype html><html><body>
      <div data-anchor="report:report#p1" data-anchor-cell="" data-anchor-text="First. Second." id="blk"><span data-anchor="report:report#s1" id="s1">First.</span> <span class="chip" data-anchor="card:c1" id="chip">c1</span> <span data-anchor="report:report#s2" id="s2">Second.</span></div>
      <p><span data-anchor="report:slides#s9" id="s9">A slide's line.</span></p>
    </body></html>`,
  )
  await page.addScriptTag({ path: browserBundle })
  const out = await page.evaluate(() => {
    const A = (window as any).__anchors
    const of = (id: any) => {
      const a = A.nearestAnchor(document.getElementById(id)!)
      const c = a && A.cellOf(a)
      return c ? [c.anchor, c.text] : null
    }
    return { s1: of('s1'), s2: of('s2'), blk: of('blk'), chip: of('chip'), s9: of('s9') }
  })
  assert.deepEqual(out.s1, ['report:report#p1', 'First. Second.'], 'a sentence stands for its block')
  assert.deepEqual(out.s2, out.s1)
  assert.deepEqual(out.blk, out.s1, 'the block itself')
  assert.equal(out.chip, null, 'a citation chip is a control with its own region')
  assert.equal(out.s9, null, 'a sentence outside a report block is itself')
})

// ----------------------------------------------------------------------------- text under the pointer

test('textHitAt in a page: a word of a paragraph is a text hit with a rect on the point; a button and the margin are not', async () => {
  await page.setContent(
    `<!doctype html><html><body style="margin:0;font:16px/24px monospace">
      <article data-anchor="cell:a1" style="width:400px;padding:20px">
        <p id="p" style="margin:0">Eight top-level files hold the corpus, and line counts span four orders of magnitude.</p>
        <button id="b" style="font:inherit;margin-top:20px">run the cell</button>
      </article>
    </body></html>`,
  )
  await page.addScriptTag({ path: browserBundle })
  const out = await page.evaluate(() => {
    const A = (window as any).__anchors
    const p = document.getElementById('p')!
    const r = document.createRange()
    r.setStart(p.firstChild!, 6)
    r.setEnd(p.firstChild!, 15)
    const word = r.getBoundingClientRect()
    const x = word.left + word.width / 2
    const y = word.top + word.height / 2
    const hit = A.textHitAt(x, y)
    const within = A.textHitAt(x, y, document.getElementById('b')!)
    const b = document.getElementById('b')!.getBoundingClientRect()
    const onButton = A.textHitAt(b.left + b.width / 2, b.top + b.height / 2)
    const article = document.querySelector('article')!.getBoundingClientRect()
    const inPadding = A.textHitAt(article.left + 4, article.top + 4)
    // a range over the whole paragraph wraps: one piece per line, none wider than the paragraph's 400px
    r.selectNodeContents(p)
    const pieces = A.linePieces(r)
    return {
      word: hit?.word,
      el: hit?.el.id,
      holds: hit ? A.boxContains(hit.pieces[0], x, y) : null,
      pieces: hit?.pieces.length,
      within: within === null,
      onButton: onButton === null,
      inPadding: inPadding === null,
      lines: pieces.length,
      narrow: pieces.every((b: any) => b.left >= 20 && b.right <= 420),
      ordered: pieces.every((b: any, i: any) => i === 0 || b.top > pieces[i - 1].top),
    }
  })
  assert.equal(out.word, 'top-level')
  assert.equal(out.el, 'p')
  assert.equal(out.holds, true)
  assert.equal(out.pieces, 1)
  assert.equal(out.within, true, 'a hit is limited to the element it is asked within')
  assert.equal(out.onButton, true, 'text in a button is a control, not a span')
  assert.equal(out.inPadding, true, 'the padding beside the text is no word, though a caret is near')
  assert.ok(out.lines >= 2, 'the paragraph wraps into several lines')
  assert.equal(out.narrow, true)
  assert.equal(out.ordered, true)
})

test('the chunk in a page: a click on a word selects its paragraph within the anchor, a long raw text its line', async () => {
  const raw = Array.from({ length: 60 }, (_: any, i: any) => `line ${i} of the raw file with several words`).join('\n')
  await page.setContent(
    `<!doctype html><html><body style="margin:0;font:16px/24px monospace">
      <article data-anchor="cell:a1" style="width:400px;padding:20px">
        <p id="p1" style="margin:0">Eight <b>top-level</b> files hold the corpus, and line counts span four orders.</p>
        <p id="p2" style="margin:8px 0 0">March 3 has 6,521 saves.</p>
        <span id="inl" data-anchor="cell:a2">an inline anchor with <i>words</i></span>
      </article>
      <pre id="raw" style="margin:0;height:200px;overflow:auto">${raw}</pre>
    </body></html>`,
  )
  await page.addScriptTag({ path: browserBundle })
  const out = await page.evaluate(() => {
    const A = (window as any).__anchors
    const at = (el: any, from: any, to: any) => {
      const r = document.createRange()
      r.setStart(el, from)
      r.setEnd(el, to)
      const b = r.getBoundingClientRect()
      return { x: b.left + b.width * 0.75, y: b.top + b.height / 2 }
    }
    const art = document.querySelector('article')!
    const bold = document.querySelector('#p1 b')!.firstChild!
    const p = at(bold, 0, 3)
    const hit = A.textHitAt(p.x, p.y, art)
    const chunk = A.chunkAt(hit, art)
    const inl = document.querySelector('#inl i')!.firstChild!
    const q = at(inl, 0, 5)
    const inlHit = A.textHitAt(q.x, q.y)
    const inlChunk = A.chunkAt(inlHit, document.getElementById('inl')!)
    const rawNode = document.getElementById('raw')!.firstChild!
    const o = (rawNode as Text).data.indexOf('line 3 ') + 5
    const s = at(rawNode, o, o + 1)
    const rawHit = A.textHitAt(s.x, s.y)
    const rawChunk = A.chunkAt(rawHit)
    const last = A.lastLine(chunk.range)
    return {
      word: hit.word,
      chunk: chunk.text,
      chunkEl: chunk.el.id,
      lastLeft: last && Math.round(last.left),
      inline: inlChunk.text,
      raw: rawChunk.text,
    }
  })
  assert.equal(out.word, 'top-level')
  assert.equal(out.chunk, 'Eight top-level files hold the corpus, and line counts span four orders.', 'the bold word selects its whole paragraph')
  assert.equal(out.chunkEl, 'p1')
  assert.equal(out.lastLeft, 20, 'the box under the chunk starts at the left of its last line')
  assert.equal(out.inline, 'an inline anchor with words', 'the chunk stops at the anchor it was asked within')
  assert.equal(out.raw, 'line 3 of the raw file with several words', 'a raw file in one element selects the line')
})

test('the lines that show in a page: a clamped comment draws only its visible lines and its box goes under the last of them; a panel clips what it scrolls away', async () => {
  const long = Array.from({ length: 12 }, (_: any, i: any) => `sentence ${i} of a long comment`).join(' ')
  const rows = Array.from({ length: 30 }, (_: any, i: any) => `<p style="margin:0">row ${i} of the panel</p>`).join('')
  await page.setContent(
    `<!doctype html><html><body style="margin:0;font:16px/20px sans-serif">
      <div id="card" style="width:200px;padding:10px"><div id="clamped" style="display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden">${long}</div></div>
      <div id="next" style="width:200px;height:100px">the next card</div>
      <div id="panel" style="height:100px;overflow:auto">${rows}</div>
    </body></html>`,
  )
  await page.addScriptTag({ path: browserBundle })
  const out = await page.evaluate(() => {
    const A = (window as any).__anchors
    const clamped = document.getElementById('clamped')!
    const range = document.createRange()
    range.selectNodeContents(clamped)
    const box = clamped.getBoundingClientRect()
    const all = Array.from(range.getClientRects()).filter((r: any) => r.width > 0)
    const pieces = A.linePieces(range)
    const last = A.lastLine(range)
    const panel = document.getElementById('panel')!
    panel.scrollTop = 45
    const pr = document.createRange()
    pr.selectNodeContents(panel)
    const pb = panel.getBoundingClientRect()
    const panelPieces = A.linePieces(pr)
    return {
      spills: all.some((r: any) => r.bottom > box.bottom + 1),
      lines: pieces.length,
      inside: pieces.every((p: any) => p.top >= box.top - 0.5 && p.bottom <= box.bottom + 0.5),
      lastBottom: last && Math.round(last.bottom),
      boxBottom: Math.round(box.bottom),
      panelLines: panelPieces.length,
      panelInside: panelPieces.every((p: any) => p.top >= pb.top - 0.5 && p.bottom <= pb.bottom + 0.5),
      panelCut: Math.round(panelPieces[0].top) === Math.round(pb.top),
    }
  })
  assert.equal(out.spills, true, 'the range reports rects for the lines the clamp hides')
  assert.equal(out.lines, 3, 'only the three lines the clamp shows are pieces')
  assert.equal(out.inside, true, 'every piece is inside the clamped box')
  assert.ok(out.lastBottom <= out.boxBottom && out.lastBottom > out.boxBottom - 20, `the box goes under the last visible line (${out.lastBottom}, box ${out.boxBottom})`)
  assert.equal(out.panelInside, true, 'the rows scrolled out of the panel draw nothing')
  assert.ok(out.panelLines >= 5 && out.panelLines <= 7, `the rows in sight are pieces (${out.panelLines})`)
  assert.equal(out.panelCut, true, 'a row half scrolled out is cut at the panel\'s top')
})

test('regionPlace in a page: a chip in a cell takes the box beside the cell, the cell itself beside it, a tab under it', async () => {
  await page.setContent(
    `<!doctype html><html><body style="margin:0">
      <article id="cell" data-anchor="cell:a1" style="position:absolute;left:100px;top:50px;width:300px;height:200px">
        <div data-anchor="cell:a1" id="take">take <span class="chip" id="chip" data-anchor="events.jsonl#L3">L3</span></div>
      </article>
      <div role="tablist"><button role="tab" id="tab" data-anchor="file:README.md">README.md</button></div>
    </body></html>`,
  )
  await page.addScriptTag({ path: browserBundle })
  const out = await page.evaluate(() => {
    const B = (window as any).__box
    const p = (id: any) => {
      const pl = B.regionPlace(document.getElementById(id)!)
      return { under: pl.under, host: pl.host ? Math.round(pl.host.left) : null }
    }
    return { chip: p('chip'), take: p('take'), cell: p('cell'), tab: p('tab') }
  })
  assert.deepEqual(out.chip, { under: false, host: 100 })
  assert.deepEqual(out.take, { under: false, host: 100 }, 'a takeaway carries its cell\'s ref and sits in the cell')
  assert.deepEqual(out.cell, { under: false, host: null })
  assert.deepEqual(out.tab, { under: true, host: null })
})
