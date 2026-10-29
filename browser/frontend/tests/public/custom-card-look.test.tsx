// @vitest-environment jsdom
// A custom card looks like thimble's own pages by construction (lib/cardStyle): its frame's head carries thimble's card
// stylesheet, which gives plain HTML the paper's tokens and thimble's type, ahead of the page's own styles, which still
// win, and with no !important against a style of the page's. It styles elements only, never a class, so a page needs no
// class of thimble's to take its look and a page's own classes take none of its rules (tests/public/browser/
// card-classes.test.ts draws both). add_card's `html` says so and names no class: its earlier example, numbers in boxes
// of their own, made cards that looked like a dashboard.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { CustomFrame } from '../../src/canvas/DataViz.tsx'
import { CARD_STYLE } from '../../src/lib/cardStyle.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(unmountAll)

async function frameOf(el: HTMLElement): Promise<HTMLIFrameElement> {
  for (let i = 0; i < 40 && !el.querySelector('iframe'); i++) await settle()
  const frame = el.querySelector('iframe')
  expect(frame).not.toBeNull()
  return frame!
}

test("the frame carries thimble's card stylesheet ahead of the page's own style, and no !important", async () => {
  const page = '<style>th{color:red}</style><table><tr><th>Queue</th><th>Answered within a day</th></tr><tr><td>Refunds</td><td>82%</td></tr></table>'
  const doc = (await frameOf(await mount(<CustomFrame html={page} title="Queues" />))).getAttribute('srcdoc') ?? ''
  expect(doc).toContain(CARD_STYLE)
  expect(CARD_STYLE).toContain('th{')
  // the page's own rule comes after the stylesheet's, so it wins
  expect(doc.indexOf(CARD_STYLE)).toBeLessThan(doc.indexOf('th{color:red}'))
  expect(CARD_STYLE).not.toContain('!important')
  // colors from the paper's tokens, never a color of its own
  expect(CARD_STYLE).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i)
})

test("add_card's html says that plain HTML takes thimble's look, and names no class and no example of numbers in boxes", () => {
  const tools = readFileSync(path.resolve(__dirname, '../../../prompts/tools.md'), 'utf8')
  const schema = JSON.parse(tools.split('## add_card')[1].split('```json')[1].split('```')[0]) as { properties: { html: { description: string } } }
  const html = schema.properties.html.description
  expect(html).toContain('plain HTML')
  expect(html).not.toMatch(/class=|tc-|<div/)
})

test("the stylesheet styles elements only, never a class, so a page's own `steps` or `label` takes none of its rules", () => {
  expect([...CARD_STYLE.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1])).toEqual([])
  for (const el of ['h2', 'p', 'small', 'table', 'th', 'td']) expect(CARD_STYLE).toMatch(new RegExp(`(^|[},])${el}[{,]`))
})
