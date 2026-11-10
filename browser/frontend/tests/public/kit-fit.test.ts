// The row of chips beside Filter by and Color by (backend/app/viewer_controls.js, viewer_colour.js): the chips that do
// not fit the row go behind "N more". Run in a jsdom window with a row's layout faked, each chip 50 px wide in a row
// of 300 px: the chips that show and the count are those that fit, and the row is measured a few times, not once
// for each chip it hides, so a field with thousands of values does not hold the page.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, test } from 'vitest'

const kit = (name: string) => readFileSync(path.resolve(__dirname, '../../../backend/app', name), 'utf8').replace(/<\/script/gi, '<\\/script')
const KIT = ['viewer_bridge.js', 'viewer_colour.js', 'viewer_controls.js'].map((f) => `<script>${kit(f)}</script>`).join('')
const VIEW = `<!doctype html><html><head>${KIT}</head><body><div id="color"></div><div id="filter"></div></body></html>`

const CHIP = 50
const GAP = 4
const MORE = 60
const ROW = 300
const VALUES = Array.from({ length: 120 }, (_, i) => `value ${i}`)

type Choice = { control: string; choice: string; go(): void }
let dom: JSDOM
let reads = 0
const win = () => dom.window as unknown as Window & typeof globalThis & { thimble: any }
// the classes both rows share: the box of chips, a chip, and "N more"
const is = (el: Element, cls: 'thimble-colour-chips' | 'chip' | 'thimble-colour-more') => el.classList.contains(cls)

/** The view in a fresh window whose rows lay their chips out one after another, the hidden ones taking no room. */
function load() {
  dom = new JSDOM(VIEW, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://view.invalid/' })
  dom.window.postMessage = (() => undefined) as typeof dom.window.postMessage
  const proto = dom.window.HTMLElement.prototype
  Object.defineProperty(proto, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return is(this, 'thimble-colour-chips') ? ROW : 0
    },
  })
  proto.getBoundingClientRect = function (this: HTMLElement) {
    reads++
    let left = 0
    if (this.parentElement && is(this.parentElement, 'thimble-colour-chips'))
      for (let s = this.previousElementSibling as HTMLElement | null; s; s = s.previousElementSibling as HTMLElement | null) if (!s.hidden) left += CHIP + GAP
    const width = is(this, 'thimble-colour-more') ? MORE : is(this, 'chip') ? CHIP : ROW
    return { left, right: left + width, top: 0, bottom: 20, width, height: 20, x: left, y: 0 } as DOMRect
  }
  reads = 0
  return win()
}

/** One control's choice picked, as the view's check picks each. */
function pick(control: string, choice: string) {
  const all: Choice[] = win().thimble.__choices()
  const c = all.find((x) => x.control === control && x.choice === choice)
  if (!c) throw new Error(`no choice ${control}: ${choice} among ${all.map((x) => `${x.control}: ${x.choice}`).join(', ')}`)
  c.go()
}

/** What a row shows: how many chips, which is the first hidden one, and what "N more" says. */
function row(mount: string) {
  const root = win().document.querySelector(mount)!
  const chips = [...root.querySelectorAll<HTMLElement>('.thimble-colour-chips > .chip')]
  return { chips: chips.length, firstHidden: chips.findIndex((c) => c.hidden), more: root.querySelector('.thimble-colour-more')?.textContent }
}

afterEach(() => dom.window.close())

describe('a row of chips that is too wide', () => {
  // four chips and "116 more" fit 300 px (4 x 54 + 60); a fifth does not
  test('Filter by shows the chips that fit and measures the row a few times', () => {
    load().thimble.filterBy({ mount: '#filter', fields: [{ name: 'action', title: 'Action', values: VALUES }] })
    reads = 0
    pick('Filter by', 'Action')
    expect(row('#filter')).toEqual({ chips: 120, firstHidden: 4, more: '116 more' })
    expect(reads).toBeLessThan(20 * VALUES.length)
  })

  test('Color by shows the chips that fit and measures the row a few times', () => {
    load().thimble.colorBy({ mount: '#color', fields: [{ name: 'action', title: 'Action', values: VALUES }] })
    reads = 0
    pick('Color by', 'Action')
    expect(row('#color')).toEqual({ chips: 120, firstHidden: 4, more: '116 more' })
    expect(reads).toBeLessThan(20 * VALUES.length)
  })
})
