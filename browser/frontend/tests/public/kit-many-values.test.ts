// The colors of a field's values (backend/app/viewer_colour.js): a field keeps the color of its first 200 values, and
// the values past the palette's twelve colors share the chip "Other". Run in a jsdom window with a reader's counts of
// a field of 1500 values: the chips are the twelve and "Other", and the values are put in order a few times, not once
// for each value past the 200, so a field with thousands of values does not hold the page each time it is counted.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, expect, test } from 'vitest'

const kit = (name: string) => readFileSync(path.resolve(__dirname, '../../../backend/app', name), 'utf8').replace(/<\/script/gi, '<\\/script')
const KIT = ['viewer_bridge.js', 'viewer_colour.js', 'viewer_controls.js'].map((f) => `<script>${kit(f)}</script>`).join('')
const VIEW = `<!doctype html><html><head>${KIT}</head><body><div id="color"></div></body></html>`

// the most frequent value first: "author 0" has 1500 records, "author 1499" has one
const AUTHORS = Array.from({ length: 1500 }, (_, i) => `author ${i}`)
const COUNTS = Object.fromEntries(AUTHORS.map((a, i) => [a, AUTHORS.length - i]))

let dom: JSDOM
afterEach(() => dom.window.close())

test('a field of 1500 values is put in order a few times when its counts arrive', () => {
  dom = new JSDOM(VIEW, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://view.invalid/' })
  dom.window.postMessage = (() => undefined) as typeof dom.window.postMessage
  const win = dom.window as unknown as Window & typeof globalThis & { thimble: any }
  const color = win.thimble.colorBy({ mount: '#color', fields: [{ name: 'author', title: 'Author' }] })
  const author = win.thimble.__choices().find((c: { control: string; choice: string }) => c.control === 'Color by' && c.choice === 'Author')
  author.go()

  let sorts = 0
  const sort = win.Array.prototype.sort
  win.Array.prototype.sort = function (this: unknown[], ...args: Parameters<typeof sort>) {
    sorts++
    return sort.apply(this, args)
  } as typeof sort
  color.counts(COUNTS)
  win.Array.prototype.sort = sort

  const chips = [...win.document.querySelectorAll<HTMLElement>('#color .thimble-colour-chips > .chip')].map((c) => c.textContent)
  expect(chips.length).toBe(13)
  expect(chips[0]).toContain('author 0')
  expect(chips[12]).toContain('Other')
  expect(sorts).toBeLessThan(20)
})
