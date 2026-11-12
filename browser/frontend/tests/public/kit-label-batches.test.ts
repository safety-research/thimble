// A label's marks arriving in batches at a view's page (backend/app/viewer_bridge.js, viewer_colour.js,
// viewer_controls.js, viewer_table.js), as thimble sends them while the rows of thousands of records come in: each
// batch carries only its own records' marks (`merge`), the page keeps those it has, and the lanes recolor their marks
// where they stand rather than drawing every mark anew for each batch. Run in a jsdom window whose page half answers
// the frame's reports in batches, as files/ViewerFrame.tsx does.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, expect, test } from 'vitest'

const kit = (name: string) => readFileSync(path.resolve(__dirname, '../../../backend/app', name), 'utf8').replace(/<\/script/gi, '<\\/script')
const KIT = ['viewer_bridge.js', 'viewer_colour.js', 'viewer_controls.js', 'viewer_table.js'].map((f) => `<script>${kit(f)}</script>`).join('')
const ORDER = `<script>window.__thimbleLabelOrder = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]</script>`
const VIEW = `<!doctype html><html><head>${ORDER}${KIT}</head><body><div id="color"></div><div id="lanes"></div><div id="list"></div></body></html>`

const ROWS = 300
const BATCH = 100
const ref = (i: number) => `run.jsonl#L${i + 1}`
const marked = (i: number) => i % 2 === 0
const EDIT = 'rgb(255, 128, 0)'
const LABEL = { id: 'k1', name: 'edit', colour: EDIT, values: [{ name: 'edit', colour: EDIT }] }
const ITEM = { ...LABEL, on: true, here: true, values: [{ name: 'edit', colour: EDIT, highlight: true }, { name: 'other', colour: 'rgb(128, 128, 128)', highlight: false }], count: null }
const mark = { bar: EDIT, names: ['edit'], values: [{ id: 'k1', label: 'edit', value: 'edit', colour: EDIT }], spans: [] }

let dom: JSDOM
afterEach(() => dom.window.close())
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("a label's marks that arrive in batches add up on the page, and the lanes recolor their marks in place", async () => {
  dom = new JSDOM(VIEW, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://view.invalid/' })
  const win = dom.window as unknown as Window & typeof globalThis & { thimble: any }
  const reported: string[] = []
  win.postMessage = ((msg: { type: string; refs?: string[] }) => {
    if (msg?.type === 'thimble:anchors') reported.push(...(msg.refs ?? []))
  }) as typeof win.postMessage
  const fromPage = (data: object) => win.dispatchEvent(new dom.window.MessageEvent('message', { data, source: win.parent as any }))
  const labels = (marks: Record<string, unknown>, merge: boolean) => fromPage({ type: 'thimble:labels', marks, ...(merge ? { merge } : {}), on: [LABEL], filter: null, all: [ITEM], palette: [], answered: -1 })
  await wait(20)

  const rows = Array.from({ length: ROWS }, (_, i) => ({ ref: ref(i), t: 1_700_000_000 + i * 60, text: `step ${i + 1}` }))
  const color = win.thimble.colorBy({ mount: '#color', fields: [] })
  const lanes = win.thimble.timeline({ mount: '#lanes', color })
  win.thimble.table({ mount: '#list', color, rows, columns: [{ name: 't', title: 'Time', type: 'time' }, { name: 'text', title: 'Record' }] })
  // the label is on: Color by takes it, the lanes draw the records, and every row is reported
  labels({}, false)
  await wait(100)
  lanes.draw(rows)
  await wait(100)
  expect(reported.length).toBe(ROWS)
  const first = win.document.querySelector('#lanes rect.thimble-lane-mark[data-i="0"]')
  expect(first).not.toBeNull()

  // thimble answers the rows a batch at a time, each message with that batch's marks alone
  for (let b = 0; b < ROWS; b += BATCH) {
    const marks: Record<string, unknown> = {}
    for (let i = b; i < b + BATCH; i++) if (marked(i)) marks[ref(i)] = mark
    labels(marks, true)
    await wait(60)
  }
  // a mark taken away in a later batch: null
  labels({ [ref(0)]: null }, true)
  await wait(100)

  const shown = rows.filter((_, i) => i > 0 && marked(i)).length
  expect(rows.filter((r) => win.thimble.markOf(r.ref)).length).toBe(shown)
  const chips = [...win.document.querySelectorAll('#color .thimble-colour-chip')].map((c) => c.textContent)
  expect(chips).toEqual([`edit${shown}`, `Not marked${ROWS - shown}`])
  // the same mark elements, recolored: record 2 in the label's color, record 0 (its mark gone) and record 1 without it
  expect(win.document.querySelector('#lanes rect.thimble-lane-mark[data-i="0"]')).toBe(first)
  const fill = (i: number) => (win.document.querySelector(`#lanes rect.thimble-lane-mark[data-i="${i}"]`) as SVGElement).style.fill
  expect([fill(0), fill(1), fill(2)]).toEqual(['', '', EDIT])
})
