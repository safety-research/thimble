// A label colored by in a view's table (backend/app/viewer_colour.js, viewer_table.js, through viewer_bridge.js), as
// Files' Timeline mode draws its records: the table draws only the rows near its view, and thimble sends the marks of
// the records the page reports. Every row the kit reads a label's value of is reported, drawn or not, so once thimble
// answers, each row has its value (which the strip and the lanes color by) and the chips count every row. Run in a
// jsdom window whose page half answers each report as thimble's does (files/ViewerFrame.tsx): with the marks of the
// refs reported so far.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, expect, test } from 'vitest'

const kit = (name: string) => readFileSync(path.resolve(__dirname, '../../../backend/app', name), 'utf8').replace(/<\/script/gi, '<\\/script')
const KIT = ['viewer_bridge.js', 'viewer_colour.js', 'viewer_controls.js', 'viewer_table.js'].map((f) => `<script>${kit(f)}</script>`).join('')
const ORDER = `<script>window.__thimbleLabelOrder = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]</script>`
const VIEW = `<!doctype html><html><head>${ORDER}${KIT}</head><body><div id="color"></div><div id="list"></div></body></html>`

const ROWS = 300
const ref = (i: number) => `run.jsonl#L${i + 1}`
// "step kind" marks every third record read and every other one of the rest edit; the others it leaves unmarked
const valueOf = (i: number): string | null => (i % 3 === 0 ? 'read' : i % 2 === 1 ? 'edit' : null)
const LABEL = { id: 'k1', name: 'step kind', colour: 'rgb(0, 0, 255)', values: [{ name: 'read', colour: 'rgb(0, 0, 255)' }, { name: 'edit', colour: 'rgb(255, 128, 0)' }] }
const ITEM = { ...LABEL, on: true, here: true, values: [...LABEL.values.map((v) => ({ ...v, highlight: true })), { name: 'other', colour: 'rgb(128, 128, 128)', highlight: false }], count: null }

type Msg = { type: string; [k: string]: unknown }
let dom: JSDOM
afterEach(() => dom.window.close())

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('a label colored by reaches every row of a table, those it never drew too, and the chips count them all', async () => {
  dom = new JSDOM(VIEW, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://view.invalid/' })
  const win = dom.window as unknown as Window & typeof globalThis & { thimble: any }
  const reported = new Set<string>()
  const fromPage = (data: object) => win.dispatchEvent(new dom.window.MessageEvent('message', { data, source: win.parent as any }))
  // thimble's page half: the marks of the refs reported so far, sent again after each report
  const answer = () => {
    const marks: Record<string, unknown> = {}
    for (const r of reported) {
      const i = Number(r.split('#L')[1]) - 1
      const v = valueOf(i)
      if (v) marks[r] = { bar: LABEL.values.find((x) => x.name === v)!.colour, names: [LABEL.name], values: [{ id: LABEL.id, label: LABEL.name, value: v, colour: 'rgb(0, 0, 255)' }], spans: [] }
    }
    fromPage({ type: 'thimble:labels', marks, on: [LABEL], filter: null, all: [ITEM], palette: [], answered: -1 })
  }
  win.postMessage = ((msg: Msg) => {
    if (msg?.type !== 'thimble:anchors') return
    for (const r of msg.refs as string[]) reported.add(r)
    setTimeout(answer, 0)
  }) as typeof win.postMessage
  await wait(20)

  const rows = Array.from({ length: ROWS }, (_, i) => ({ ref: ref(i), t: 1_700_000_000 + i * 60, text: `step ${i + 1}` }))
  const color = win.thimble.colorBy({ mount: '#color', fields: [] })
  win.thimble.table({ mount: '#list', color, rows, columns: [{ name: 't', title: 'Time', type: 'time' }, { name: 'text', title: 'Record' }] })
  // the label is on: Color by takes it, and the table reads every row's value of it
  answer()
  await wait(400)

  const drawn = win.document.querySelectorAll('#list [data-anchor]').length
  expect(drawn).toBeLessThan(ROWS)
  expect(reported.size).toBe(ROWS)
  expect(color.label).toBe('k1')
  expect(color.valueOf(rows[ROWS - 1])).toBe(valueOf(ROWS - 1))
  const chips = [...win.document.querySelectorAll('#color .thimble-colour-chip')].map((c) => c.textContent)
  const n = (v: string | null) => rows.filter((_, i) => valueOf(i) === v).length.toLocaleString('en-US')
  expect(chips).toEqual([`read${n('read')}`, `edit${n('edit')}`, `Not marked${n(null)}`])
})
