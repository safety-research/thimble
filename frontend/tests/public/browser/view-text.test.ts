// The view kit's formatted text (backend/app/viewer_text.js, thimble.text) in a real browser, the page in a sandboxed
// frame as ViewerFrame holds it, with the kit as views.frame_document loads it and the markdown parser
// (src/lib/kitMarkdown.ts, bundled here as vite build bundles it into kit/markdown.js), in the theme's own tokens: a
// pull request's body in GitHub's markdown draws its headings, tables, task lists, code and quotes in thimble's look,
// light and dark, within its mount's width; raw HTML shows as text and runs nothing; a citation that quotes the source
// word for word, its ** and list markers included, is found in the rendered text, and opens a fold it is in; the search
// finds a phrase across a bold word and opens a fold that holds its match. What the part decides without layout
// (mentions, escaping, links, the fold's place) is tests/public/data-kit.test.ts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, test } from 'vitest'
import type { Browser, Frame, Page } from 'playwright'
import { bundle, cleanup, FRONTEND, launch, src } from './page.ts'

const APP = path.join(FRONTEND, '..', 'backend', 'app')
const read = (p: string) => readFileSync(p, 'utf8')
const inline = (js: string) => `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`
// a value as JavaScript inside an inline script, whose </script> would end it
const js = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c')
// the theme's own tokens, light and dark (data-paper="dark")
const TOKENS = read(path.join(FRONTEND, 'src', 'styles', 'tokens.css')) + ':root{--font-body:sans-serif;--font-mono:monospace}'

const REF = 'forge/prs.jsonl#L3'
const BODY = `## Summary

Fixes the **gale** warning when the ferry is _late_, and drops the old \`retry()\` loop. See #142.

- [x] [Tests added](https://github.com/o/r/pull/1)
- [ ] Docs in [the README](README.md#L4)

| metric | before | after |
|---|--:|--:|
| p50 latency | 120 ms | 80 ms |

> The harbor master asked for this.

\`\`\`py
def gale(force):
    return force >= 8
\`\`\`

![the harbor at noon](https://img.example/harbor.png) and ~~old~~ text, https://example.org/ferry.
`
// a body whose last lines fold away, and an email whose last lines do
const LONG = ['## Log', ...Array.from({ length: 30 }, (_, i) => `- step ${i + 1} of the crossing`), '- the **squall** came at dusk', '- and passed'].join('\n')
const MAIL = ['From: ana', 'To: bo', '', ...Array.from({ length: 20 }, (_, i) => `Line ${i + 1} of the timetable.`), 'The last ferry waits for the tide.', 'Ana'].join('\n')

let browser: Browser
let kit: string

beforeAll(async () => {
  const parser = read(await bundle('kit-markdown', [`import '${src('lib/kitMarkdown.ts')}'`]))
  kit =
    inline(read(path.join(APP, 'viewer_bridge.js'))) +
    inline(`window.__thimbleLabelOrder = ${read(path.join(APP, 'label_order.json'))}`) +
    ['viewer_colour.js', 'viewer_controls.js'].map((n) => inline(read(path.join(APP, n)))).join('') +
    inline(parser) +
    ['viewer_text.js', 'viewer_side.js', 'viewer_transcript.js', 'viewer_search.js', 'viewer_table.js', 'viewer_diff.js', 'viewer_record.js', 'viewer_range.js']
      .map((n) => inline(read(path.join(APP, n))))
      .join('') +
    `<style>${read(path.join(APP, 'viewer_kit.css'))}</style><style>${read(path.join(APP, 'viewer_parts.css'))}</style>`
  browser = await launch()
})
afterAll(async () => {
  await browser?.close()
  cleanup()
})

const doc = (body: string, dark = false) =>
  `<!doctype html><html${dark ? ' data-paper="dark"' : ''}><head><style>${TOKENS} :root{color-scheme:${dark ? 'dark' : 'light'}} html,body{margin:0}
body{background:var(--surface-card)} .top{padding:8px} #list{height:560px;overflow-y:auto;padding:0 16px} #pr{width:520px}</style>${kit}</head><body>${body}</body></html>`

/** A page holding `html` in a sandboxed frame, which keeps the messages the frame sends; `frame()` is the frame. */
async function framed(html: string): Promise<{ page: Page; frame: () => Frame; sent: () => Promise<{ type: string; [k: string]: unknown }[]> }> {
  const page = await browser.newPage({ viewport: { width: 800, height: 700 } })
  await page.setContent('<!doctype html><html><body style="margin:0"><iframe id="f" sandbox="allow-scripts" style="border:0;width:760px;height:660px"></iframe></body></html>')
  await page.evaluate((d) => {
    ;(window as any).sent = []
    addEventListener('message', (e) => (window as any).sent.push(e.data))
    ;(document.getElementById('f') as HTMLIFrameElement).srcdoc = d
  }, html)
  const frame = () => page.frames().find((f) => f !== page.mainFrame())!
  await page.waitForFunction(() => (document.getElementById('f') as HTMLIFrameElement).contentWindow)
  await page.waitForTimeout(300)
  return { page, frame, sent: () => page.evaluate(() => (window as any).sent) }
}

describe('the text', () => {
  for (const dark of [false, true]) {
    test(`a pull request's body in GitHub's markdown, in thimble's look (${dark ? 'dark' : 'light'})`, async () => {
      const { page, frame } = await framed(doc(`<div id="pr"></div><script>thimble.text('#pr', ${js(BODY)}, { ref: ${js(REF)} })</script>`, dark))
      const got = await frame().evaluate(() => {
        const root = document.querySelector('#pr > .thimble-text') as HTMLElement
        const css = (sel: string) => getComputedStyle(root.querySelector(sel)!)
        const token = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()
        const probe = document.createElement('i')
        document.body.appendChild(probe)
        const resolved = (v: string) => ((probe.style.color = v), getComputedStyle(probe).color)
        return {
          anchor: root.getAttribute('data-anchor'),
          h2: [root.querySelector('h2')?.textContent, css('h2').fontWeight, parseFloat(css('h2').fontSize) > parseFloat(css('p').fontSize)],
          strong: root.querySelector('p strong')?.textContent,
          del: root.querySelector('del')?.textContent,
          boxes: [...root.querySelectorAll('li > input[type=checkbox]')].map((b) => [(b as HTMLInputElement).disabled, (b as HTMLInputElement).checked]),
          bullet: getComputedStyle(root.querySelector('li')!).listStyleType,
          head: [css('thead th').textTransform, css('thead th').color === resolved(token('--text-tertiary'))],
          right: css('tbody td:nth-child(2)').textAlign,
          quote: [css('blockquote').color === resolved(token('--text-secondary')), css('blockquote').borderLeftStyle, parseFloat(css('blockquote').paddingLeft) > 0],
          code: [css('p code').fontFamily, css('p code').backgroundColor, css('pre').backgroundColor, css('pre').borderRadius],
          ink: token('--ink-rgb').split(',').map((v) => v.trim()).join(', '),
          radius: token('--radius-card'),
          img: [root.querySelectorAll('img').length, root.querySelector('.thimble-text-img')?.textContent],
          url: [...root.querySelectorAll('.thimble-text-url')].map((a) => [a.textContent, a.getAttribute('title'), a.hasAttribute('href')]),
          refs: [...root.querySelectorAll('.thimble-text-ref')].map((a) => [a.textContent, a.getAttribute('data-thimble-ref')]),
          wide: root.scrollWidth <= root.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth,
        }
      })
      assert.equal(got.anchor, REF)
      assert.deepEqual(got.h2, ['Summary', '500', true])
      assert.equal(got.strong, 'gale')
      assert.equal(got.del, 'old')
      assert.deepEqual(got.boxes, [[true, true], [true, false]], 'task lists as disabled checkboxes')
      assert.equal(got.bullet, 'none', "a task's box stands in for its bullet")
      assert.deepEqual(got.head, ['uppercase', true], "a table's head as the kit's .table draws it")
      assert.equal(got.right, 'right', 'a column aligned right in the source')
      assert.deepEqual(got.quote, [true, 'none', true], 'a quote indented in the secondary ink, no stripe')
      assert.match(got.code[0], /monospace/)
      // code on a light tint of the theme's ink, a block with the card's corners
      assert.equal(got.code[1], `rgba(${got.ink}, 0.06)`)
      assert.equal(got.code[2], `rgba(${got.ink}, 0.06)`)
      assert.equal(got.code[3], got.radius)
      assert.deepEqual(got.img, [0, 'the harbor at noon'], "an image is not loaded: its alt text in a chip")
      assert.deepEqual(got.url, [
        ['Tests added', 'https://github.com/o/r/pull/1', false],
        ['https://example.org/ferry', 'https://example.org/ferry', false],
      ])
      // a relative link is read from the folder of the record's file
      assert.deepEqual(got.refs, [['the README', 'forge/README.md#L4']])
      assert.equal(got.wide, true, 'nothing runs past the mount')
      await page.close()
    })
  }

  test('raw HTML shows as text and runs nothing, in markdown and in plain text', async () => {
    const raw = '<script>window.pwned = 1</script>\n\n<img src="x" onerror="window.pwned = 2">\n\nSee [this](javascript:window.pwned=3) and <b onclick="window.pwned=4">bold</b>.'
    const { page, frame } = await framed(doc(`<div id="a"></div><div id="b"></div><script>
thimble.text('#a', ${js(raw)})
document.getElementById('b').innerHTML = thimble.text.html(${js(raw)}, { format: 'plain' })</script>`))
    await frame().click('#a .thimble-text-url')
    const got = await frame().evaluate(() => ({
      pwned: (window as any).pwned ?? null,
      parsed: document.querySelectorAll('.thimble-text script, .thimble-text img, .thimble-text b, .thimble-text [onclick], .thimble-text [href]').length,
      a: document.querySelector('#a')!.textContent,
      b: document.querySelector('#b')!.textContent,
    }))
    assert.equal(got.pwned, null)
    assert.equal(got.parsed, 0)
    assert.ok(got.a!.includes('<script>window.pwned = 1</script>') && got.a!.includes('<img src="x" onerror="window.pwned = 2">'), got.a!)
    assert.ok(got.a!.includes('<b onclick="window.pwned=4">bold</b>'), got.a!)
    assert.equal(got.b, raw)
    await page.close()
  })

  test('a citation that quotes the source with its ** and list markers is found in the rendered text, and opens its fold', async () => {
    const { page, frame } = await framed(doc(`<div id="pr"></div><div id="log"></div><script>
thimble.text('#pr', ${js(BODY)}, { ref: ${js(REF)} })
document.getElementById('log').innerHTML = thimble.text.html(${js(LONG)}, { ref: 'forge/prs.jsonl#L9' })</script>`))
    const quote = async (record: string, text: string) => {
      await page.evaluate(
        ([record, text]) => {
          ;(window as any).sent = []
          ;(document.getElementById('f') as HTMLIFrameElement).contentWindow!.postMessage({ type: 'thimble:open', open: { ref: record }, quote: { record, text } }, '*')
        },
        [record, text],
      )
      await page.waitForFunction(() => (window as any).sent.some((m: any) => m?.type === 'thimble:quoted'), null, { timeout: 25000 })
      const found = await page.evaluate(() => (window as any).sent.find((m: any) => m?.type === 'thimble:quoted').found)
      const lit = await frame().evaluate(() => {
        const h = CSS.highlights.get('thimble-quote')
        return h ? [...h].map((r) => r.toString().replace(/\s+/g, ' ')).join('') : ''
      })
      return { found, lit }
    }
    assert.deepEqual(await quote(REF, 'Fixes the **gale** warning when the ferry is _late_'), { found: true, lit: 'Fixes the gale warning when the ferry is late' })
    assert.deepEqual(await quote(REF, '- [x] [Tests added](https://github.com/o/r/pull/1)'), { found: true, lit: 'Tests added' })
    // the passage is in the fold: the fold opens, and the passage shows
    assert.equal(await frame().evaluate(() => (document.querySelector('#log .thimble-text-more') as HTMLElement).textContent), 'Show more')
    assert.deepEqual(await quote('forge/prs.jsonl#L9', '- the **squall** came at dusk'), { found: true, lit: 'the squall came at dusk' })
    const open = await frame().evaluate(() => ({
      more: document.querySelector('#log .thimble-text-more')!.textContent,
      shows: (() => {
        const li = [...document.querySelectorAll('#log li')].find((l) => l.textContent!.includes('squall'))!
        return li.getClientRects().length > 0
      })(),
    }))
    assert.deepEqual(open, { more: 'Show less', shows: true })
    await page.close()
  })

  test('the search finds a phrase across a bold word, and opens the fold that holds a match', async () => {
    const { page, frame } = await framed(doc(`<div class="top"><span id="search"></span></div><div id="list"><div id="pr"></div><div id="log"></div><div id="mail"></div></div><script>
window.search = thimble.search({ mount: '#search', in: '#list' })
thimble.text('#pr', ${js(BODY)}, { ref: ${js(REF)} })
document.getElementById('log').innerHTML = thimble.text.html(${js(LONG)}, { ref: 'forge/prs.jsonl#L9' })
document.getElementById('mail').innerHTML = thimble.text.html(${js(MAIL)}, { format: 'plain', ref: 'mail.jsonl#L4' })</script>`))
    const find = async (text: string) => {
      await frame().locator('.thimble-search-input').fill(text)
      await frame().waitForTimeout(350)
      return frame().evaluate(() => {
        const cur = CSS.highlights.get('thimble-search-current')
        return { count: (window as any).search.count, current: cur ? [...cur].map((r) => r.toString()).join('') : null }
      })
    }
    assert.deepEqual(await find('the gale warning'), { count: 1, current: 'the gale warning' })
    // folded: the lines past the first 12, the squall's among them
    const before = await frame().evaluate(() => {
      const root = document.querySelector('#log .thimble-text') as HTMLElement
      const shown = [...root.querySelectorAll('li')].filter((l) => l.getClientRects().length).length
      return { shown, more: root.querySelector('.thimble-text-more')!.textContent, height: root.getBoundingClientRect().height }
    })
    assert.equal(before.shown, 11, 'the heading and 11 items: 12 lines')
    assert.equal(before.more, 'Show more')
    assert.deepEqual(await find('squall came'), { count: 1, current: 'squall came' })
    const after = await frame().evaluate(() => {
      const root = document.querySelector('#log .thimble-text') as HTMLElement
      const li = [...root.querySelectorAll('li')].find((l) => l.textContent!.includes('squall'))!
      const box = li.getBoundingClientRect()
      const list = document.getElementById('list')!.getBoundingClientRect()
      return {
        more: root.querySelector('.thimble-text-more')!.textContent,
        shown: [...root.querySelectorAll('li')].filter((l) => l.getClientRects().length).length,
        inView: box.top >= list.top && box.bottom <= list.bottom,
        numbers: getComputedStyle(root.querySelector('ul')!).listStyleType,
      }
    })
    assert.deepEqual(after, { more: 'Show less', shown: 32, inView: true, numbers: 'disc' })
    // in plain text the fold starts inside the text's one block: the search opens it there too, and the text reads on
    const mail = () =>
      frame().evaluate(() => {
        const p = document.querySelector('#mail .thimble-text-plain') as HTMLElement
        return { more: document.querySelector('#mail .thimble-text-more')!.textContent, text: p.innerText.trim().split('\n').length }
      })
    assert.deepEqual(await mail(), { more: 'Show more', text: 12 })
    assert.deepEqual(await find('waits for the tide'), { count: 1, current: 'waits for the tide' })
    assert.deepEqual(await mail(), { more: 'Show less', text: 25 })
    // Show less folds it again, and Show more opens it
    await frame().click('#log .thimble-text-more')
    assert.equal(await frame().evaluate(() => [...document.querySelectorAll('#log li')].filter((l) => l.getClientRects().length).length), 11)
    await frame().click('#log .thimble-text-more')
    assert.equal(await frame().evaluate(() => [...document.querySelectorAll('#log li')].filter((l) => l.getClientRects().length).length), 32)
    await page.close()
  })
})
