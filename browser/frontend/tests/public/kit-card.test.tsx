// @vitest-environment jsdom
// A card drawn by a program (src/kit/KitBody.tsx): the drawing the server kept with the card's run draws as an SVG at
// the card's width, each part anchored as card:<id>#<part id>, and a click on a part opens the record it stands for.
import { act } from 'react'
import { afterEach, expect, test } from 'vitest'
import KIT from '../../../../plugin/draw/kit.js?raw'
import { KitBody, kitRunOf, partRef } from '../../src/kit/KitBody.tsx'
import { KIT_MIME } from '../../src/kit/types.ts'
import { bus } from '../../src/lib/bus.ts'
import type { Cell } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

afterEach(() => unmountAll())

const PROGRAM = "return k.bars(data.outcomes.map(d => ({ id: d.outcome, label: d.outcome, value: d.n, meta: { refs: d.refs } })))"
const DATA = { outcomes: [{ outcome: 'failed', n: 11, refs: ['results.csv#row=2'] }, { outcome: 'merged', n: 13, refs: ['results.csv#row=1', 'results.csv#row=3'] }] }

// the plugin's toolkit, run here as the server's sandbox runs it, for the drawing a card's run keeps
new Function(KIT)()
const DrawKit = (globalThis as unknown as { DrawKit: { run: (program: string, data: unknown, opts: object) => unknown } }).DrawKit

function card(): Cell {
  const drawing = DrawKit.run(PROGRAM, DATA, { w: 88, h: 30, surface: 'browser', title: 'How did the runs end?', id: 'c1' })
  return { id: 'c1', notebook: 'main', kind: 'program', title: 'How did the runs end?', created_by: 'main', ts: '', program: PROGRAM, status: 'ok', outputs: [{ [KIT_MIME]: { drawing, data: DATA, w: 88 } }] } as unknown as Cell
}

test("a program card draws its kept drawing, each part anchored by the program's own id", async () => {
  const c = card()
  expect(kitRunOf(c)?.drawing.regions?.map((r) => r.id)).toEqual(['failed', 'merged'])
  const el = await mount(<KitBody cell={c} width={600} />)
  await settle()
  const svg = el.querySelector('.bcell-output-kit svg')
  expect(svg).not.toBeNull()
  const part = el.querySelector('[data-region="merged"]')!
  expect(part.getAttribute('data-anchor')).toBe('card:c1#merged')
  expect([...el.querySelectorAll("text")].map((t) => t.textContent).join(" ")).toMatch(/merged/)
})

test('a click on a part opens the first record it stands for', async () => {
  const opened: string[] = []
  const off = bus.on('openRef', (e) => void opened.push(e.ref))
  const el = await mount(<KitBody cell={card()} width={600} />)
  await settle()
  await act(async () => (el.querySelector('[data-region="merged"]') as SVGElement).dispatchEvent(new MouseEvent('click', { bubbles: true })))
  off()
  expect(opened).toEqual(['results.csv#row=1'])
  expect(partRef({ ref: 'a.jsonl#L2' })).toBe('a.jsonl#L2')
  expect(partRef({ label: 'x' })).toBeNull()
})
