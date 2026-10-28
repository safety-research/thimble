// @vitest-environment jsdom
// A custom card looks like thimble's own pages by construction (lib/cardStyle): its frame's head carries thimble's card
// stylesheet, the paper's tokens and the few named classes cards draw, ahead of the page's own styles, which still win,
// and with no !important against a style of the page's.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { CustomFrame } from '../../src/canvas/DataViz.tsx'
import { CARD_CLASSES, CARD_STYLE } from '../../src/lib/cardStyle.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(unmountAll)

async function frameOf(el: HTMLElement): Promise<HTMLIFrameElement> {
  for (let i = 0; i < 40 && !el.querySelector('iframe'); i++) await settle()
  const frame = el.querySelector('iframe')
  expect(frame).not.toBeNull()
  return frame!
}

test("the frame carries thimble's card stylesheet with its classes ahead of the page's own style, and no !important", async () => {
  const page = "<style>.label{color:red}</style><div class='steps'><div class='box'><div class='label'>Opened</div><div class='value'>412</div></div></div>"
  const doc = (await frameOf(await mount(<CustomFrame html={page} title="Pull requests" />))).getAttribute('srcdoc') ?? ''
  expect(doc).toContain(CARD_STYLE)
  for (const c of CARD_CLASSES) expect(CARD_STYLE).toContain(`.${c}{`)
  // the page's own rule comes after the stylesheet's, so it wins
  expect(doc.indexOf(CARD_STYLE)).toBeLessThan(doc.indexOf('.label{color:red}'))
  expect(CARD_STYLE).not.toContain('!important')
  // colors from the paper's tokens, never a color of its own
  expect(CARD_STYLE).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i)
})

test("add_card's html names the stylesheet's classes, and its example uses only them", () => {
  const tools = readFileSync(path.resolve(__dirname, '../../../prompts/tools.md'), 'utf8')
  const schema = JSON.parse(tools.split('## add_card')[1].split('```json')[1].split('```')[0]) as { properties: { html: { description: string } } }
  const html = schema.properties.html.description
  for (const c of CARD_CLASSES) expect(html).toContain(c)
  const used = [...html.matchAll(/class='([^']+)'/g)].flatMap((m) => m[1].split(/\s+/))
  expect(used.length).toBeGreaterThan(0)
  for (const c of used) expect(CARD_CLASSES as readonly string[]).toContain(c)
})
