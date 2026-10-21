// @vitest-environment jsdom
// A card drawn by a program (src/kit/KitBody.tsx): the drawing the server kept with the card's run draws as an SVG at
// the card's width, each part anchored as card:<id>#<part id>, and a click on a part opens the record it stands for.
import { act } from 'react'
import { afterEach, expect, test } from 'vitest'
import KIT from '../../../../plugin/draw/kit.js?raw'
import { KitBody, kitRunOf, partRef } from '../../src/kit/KitBody.tsx'
import { renderSvg } from '../../src/kit/svg.js'
import { KIT_MIME, type Drawing } from '../../src/kit/types.ts'
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

test('a card drawn again in a narrow place cuts its labels, never its numbers', async () => {
  const { renderSvg } = await import('../../src/kit/svg.js')
  const data = { rows: [['a-rather-long-name-of-a-run', 317], ['short', 187], ['other', 11956]] }
  // k.bars with the label width a wide card asked for, and the same row built by hand
  const programs = [
    "return k.frame(k.bars(data.rows.map(([l, v]) => ({ label: l, value: v })), { labelW: 22 }))",
    "return k.frame(k.stack(...data.rows.map(([l, v]) => k.beside(k.text(l, { w: 22, wrap: false }), k.bar(v, { max: 11956 }), k.text(k.fmt(v), { w: 6, align: 'right' }), { gap: 1 }))))",
  ]
  for (const program of programs) {
    const drawing = DrawKit.run(program, data, { w: 35, h: 30, surface: 'browser', id: 'c2' }) as Drawing
    const out = renderSvg(drawing, { cw: 7.8 })
    const values = [...out.svg.matchAll(/<text x="([\d.]+)"[^>]*text-anchor="end"[^>]*>(.*?)<\/text>/g)].map((m) => ({ x: +m[1], s: m[2].replace(/<[^>]+>/g, '') }))
    expect(values.map((v) => v.s)).toEqual(['317', '187', '11,956'])
    for (const v of values) expect(v.x).toBeLessThanOrEqual(drawing.w * 7.8)
    expect(out.cut.map((c) => c.s)).toContain('a-rather-long-name-of-a-run')
  }
})

test('a plot draws [x, y] pairs in values, dots per series as its legend shows them, and a long x label on a line of its own', async () => {
  const { renderSvg } = await import('../../src/kit/svg.js')
  const plot = (label: string, w: number) => {
    const program = `return k.plot([{ name: 'legal %', values: [[500, 60], [1000, 68], [1500, 84]], dots: true }, { name: 'goal', points: [[500, 99], [1500, 99]] }], { h: 8, x: { label: ${JSON.stringify(label)} } })`
    const drawing = DrawKit.run(program, {}, { w, h: 30, surface: 'browser', id: 'c3' }) as Drawing
    expect(drawing.warnings).toEqual([])
    const out = renderSvg(drawing, { cw: 7.8 })
    const texts = [...out.svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>(.*?)<\/text>/g)].map((m) => ({ y: +m[2], s: m[3].replace(/<[^>]+>/g, '') }))
    return { out, texts }
  }
  const label = 'minutes after 14:00 (pushed at 54, merged at 122)'
  const { out, texts } = plot(label, 60)
  // the pairs are points: three dots for the first series and one in its legend; the second a line, a stroke in its legend
  expect(out.svg.match(/<circle [^>]*r="2.5"/g)?.length).toBe(4)
  expect(out.svg.match(/<polyline /g)?.length).toBe(1)
  expect(out.svg.match(/<rect [^>]*width="12" height="3"/g)?.length).toBe(1)
  // the label is whole, below the tick values
  const at = texts.find((t) => t.s === label)
  const tick = texts.find((t) => t.s === '1,000')
  expect(at && tick && at.y > tick.y).toBe(true)
  // wider than the plot: cut with …, and said in `cut`
  const narrow = plot(label, 24)
  expect(narrow.texts.some((t) => t.s.startsWith('minutes') && t.s.endsWith('…'))).toBe(true)
  expect(narrow.out.cut.filter((c) => c.k === 'axis').length).toBe(1)
})

test("a code line's indent stays when its text wraps", () => {
  const drawing = DrawKit.run("return k.text('        if a:', { max: 2 })", {}, { w: 60, h: 10, surface: 'browser' }) as Drawing
  const texts = renderSvg(drawing, { w: 60 }).svg.match(/<text[^>]*>.*?<\/text>/g) || []
  expect(texts.map((t) => t.replace(/<[^>]+>/g, ''))).toContain('        if a:')
})

test("a key that wraps keeps each mark on the line of its name", () => {
  const names = ['ash', 'birch', 'cedar', 'elm', 'fir', 'oak']
  for (const w of [14, 20, 26]) {
    const drawing = DrawKit.run(`return k.legend(${JSON.stringify(names.map((n, i) => [n, 'c' + (i + 1)]))})`, {}, { w, h: 10, surface: 'browser' }) as Drawing
    const lines = (renderSvg(drawing, { w }).svg.match(/<text[^>]*>.*?<\/text>/g) || []).map((t) => t.replace(/<[^>]+>/g, ''))
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(l).toMatch(/^■ [a-z]+( {3}■ [a-z]+)*$/)
  }
})

test('a plot key with more series than one line holds wraps onto more lines, so every series is named', () => {
  const names = ['north depot', 'south depot', 'harbor', 'airport', 'rail yard', 'east market', 'old town']
  const program = `return k.plot(${JSON.stringify(names)}.map((name, i) => ({ name, points: [1, 2, 3].map(x => [x, x * (i + 1)]) })), { h: 10 })`
  const drawing = DrawKit.run(program, {}, { w: 50, h: 30, surface: 'browser', id: 'c4' }) as Drawing
  const out = renderSvg(drawing, { cw: 7.8 })
  const texts = [...out.svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>(.*?)<\/text>/g)].map((m) => ({ y: +m[2], s: m[3].replace(/<[^>]+>/g, '') }))
  const key = texts.filter((t) => names.includes(t.s))
  expect(key.map((t) => t.s)).toEqual(names)
  expect(new Set(key.map((t) => t.y)).size).toBeGreaterThan(1)
  expect(out.svg.match(/<rect [^>]*width="12" height="3"/g)?.length).toBe(names.length)
})
