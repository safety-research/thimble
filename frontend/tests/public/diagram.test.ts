// A diagram card's layout (src/canvas/DataViz.tsx diagramLayout): a row too wide for the card spreads over more rows a
// group of siblings at a time, the edges from one node that pass a row run down it as one trunk, no two edges from
// different nodes cross where the graph allows it, and a short edge label sits where no other edge runs under it. The
// graphs are invented.
import { describe, expect, test } from 'vitest'
import { diagramLayout, segmentsCross, type DiagramLayout } from '../../src/canvas/DataViz.tsx'

type Pt = { x: number; y: number }

/** Whether two polylines cross at a point inside a segment of each. */
const linesCross = (a: Pt[], b: Pt[]): boolean => {
  for (let i = 1; i < a.length; i++) for (let j = 1; j < b.length; j++) if (segmentsCross(a[i - 1], a[i], b[j - 1], b[j])) return true
  return false
}

/** The pairs of edges with no node in common whose lines cross. */
const crossings = (lay: DiagramLayout): string[] => {
  const out: string[] = []
  lay.edges.forEach((e, i) =>
    lay.edges.slice(i + 1).forEach((f) => {
      const shared = [e.source, e.target].some((n) => n === f.source || n === f.target)
      if (!shared && linesCross(e.line, f.line)) out.push(`${e.source}->${e.target} x ${f.source}->${f.target}`)
    }),
  )
  return out
}

// a catalogue: three shelves under one root, each with four or five items, thirteen items in all, which one row of a
// card cannot hold
const shelves = { A: ['apples', 'apricots', 'avocados', 'artichokes', 'almonds'], B: ['beans', 'beets', 'broccoli', 'barley'], C: ['cherries', 'cabbage', 'carrots', 'celery'] }
const catalogue = {
  nodes: [{ id: 'catalogue' }, ...Object.keys(shelves).map((s) => ({ id: `shelf ${s}` })), ...Object.values(shelves).flat().map((id) => ({ id: `${id} (crate)` }))],
  edges: [
    ...Object.keys(shelves).map((s) => ({ source: 'catalogue', target: `shelf ${s}` })),
    ...Object.entries(shelves).flatMap(([s, items]) => items.map((it) => ({ source: `shelf ${s}`, target: `${it} (crate)` }))),
  ],
}

describe('diagramLayout', () => {
  test('a row too wide for the card spreads a group of siblings at a time, and no edges of different nodes cross', () => {
    const lay = diagramLayout(catalogue, { width: 660 })
    expect(lay.width).toBeLessThanOrEqual(660)
    const layerOf = new Map(lay.nodes.map((n) => [n.id, n.layer]))
    for (const items of Object.values(shelves)) expect(new Set(items.map((it) => layerOf.get(`${it} (crate)`))).size).toBe(1)
    expect(new Set(Object.values(shelves).map((items) => layerOf.get(`${items[0]} (crate)`))).size).toBeGreaterThan(1)
    expect(crossings(lay)).toEqual([])
  })

  test('the edges from one node that pass a row run down it as one line', () => {
    const lay = diagramLayout(catalogue, { width: 660 })
    const byId = new Map(lay.nodes.map((n) => [n.id, n]))
    let passing = 0
    for (const shelf of Object.keys(shelves).map((s) => `shelf ${s}`)) {
      const out = lay.edges.filter((e) => e.source === shelf)
      const below = byId.get(out[0].target)!
      const from = byId.get(shelf)!
      if (below.layer - from.layer < 2) continue
      passing++
      // where the edges cross the middle of the first row they pass, they are at one x
      const passed = lay.nodes.find((n) => n.layer === from.layer + 1)!
      const midY = passed.y + passed.h / 2
      const xs = out.map((e) => {
        const i = e.line.findIndex((p) => p.y >= midY)
        return Math.round(e.line[i].x)
      })
      expect(new Set(xs).size).toBe(1)
    }
    expect(passing).toBeGreaterThan(0)
  })

  test("a short label sits where no other edge's line runs under it", () => {
    // three workers that each use two shared tools: the six edges must cross, and the one label must still read clear
    const g = {
      nodes: ['team', 'worker 1', 'worker 2', 'worker 3', 'shared tool shed', 'shared workbench'].map((id) => ({ id })),
      edges: [
        { source: 'team', target: 'worker 1', label: 'one per shift' },
        { source: 'team', target: 'worker 2' },
        { source: 'team', target: 'worker 3' },
        ...['worker 1', 'worker 2', 'worker 3'].flatMap((w) => [{ source: w, target: 'shared tool shed' }, { source: w, target: 'shared workbench' }]),
      ],
    }
    const lay = diagramLayout(g, { width: 600 })
    const e = lay.edges.find((x) => x.label)!
    expect(e.inline).toBe(true)
    const half = (e.label.length * 6) / 2 + 4
    const box = { x0: e.lx - half, x1: e.lx + half, y0: e.ly - 7, y1: e.ly + 7 }
    const under = lay.edges.filter((f) => f !== e && f.line.some((p) => p.x > box.x0 && p.x < box.x1 && p.y > box.y0 && p.y < box.y1))
    expect(under.map((f) => `${f.source}->${f.target}`)).toEqual([])
  })
})
