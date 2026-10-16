// The view kit's formatted text (backend/app/viewer_text.js, thimble.text) in a real browser, the page in a sandboxed
// frame as ViewerFrame holds it, with the kit as views.frame_document loads it and the markdown parser
// (src/lib/kitMarkdown.ts, bundled as vite build bundles it into kit/markdown.js): raw HTML shows as text and runs
// nothing, in markdown and in plain text.
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
})
