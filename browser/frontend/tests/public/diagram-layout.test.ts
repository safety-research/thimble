// thimble.diagram's layout (src/canvas/DataViz diagramLayout), for a loop: the two edges between two nodes run close,
// and a label written across both left the other edge's numbered note circle no clear spot, so the circle was drawn on
// top of the label. Every circle now sits on its own edge clear of the labels, the nodes and the other circles.
import { expect, test } from 'vitest'
import { diagramLayout } from '../../src/canvas/DataViz.tsx'
import type { GraphDataset } from '../../src/lib/types.ts'

type Box = { x0: number; y0: number; x1: number; y1: number }
/** the drawing's sizes (DataViz): a label's character and height, and a circle's radius */
const LABEL_CW = 6
const LABEL_H = 14
const MARK_R = 8
const hits = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1

const LONG = 'fixed and sent back for another round of review'
const graph = (edges: [string, string, string][]): GraphDataset => ({
  nodes: [...new Set(edges.flatMap(([a, b]) => [a, b]))].map((id) => ({ id })),
  edges: edges.map(([source, target, label]) => ({ source, target, label })),
})
// a pull request's life with a loop: reviewed -> changes asked -> reviewed again
const loops: [string, GraphDataset, number | undefined][] = [
  ['the loop back has the long label', graph([['open', 'reviewed', 'reviewed'], ['reviewed', 'changes asked', 'asked for changes'], ['changes asked', 'reviewed', LONG], ['reviewed', 'merged', 'merged']]), 260],
  ['the loop back comes first', graph([['open', 'reviewed', 'reviewed'], ['changes asked', 'reviewed', LONG], ['reviewed', 'changes asked', 'asked for changes'], ['reviewed', 'merged', 'merged']]), 600],
  ['a short label beside the loop crowds out a neighbor', graph([['open', 'reviewed', 'reviewed'], ['reviewed', 'changes asked', '64'], ['changes asked', 'reviewed', '52 fixed and resubmitted'], ['reviewed', 'merged', 'merged']]), 600],
  ['the forward edge has the long label', graph([['reviewed', 'changes asked', LONG], ['changes asked', 'reviewed', 'asked for changes'], ['reviewed', 'merged', 'merged']]), 400],
]

for (const [what, g, width] of loops)
  test(`a loop's numbered circles sit on their own edges, clear of every label, node and circle: ${what}`, () => {
    const lay = diagramLayout(g, { width })
    const labels = lay.edges.filter((e) => e.label && e.inline).map((e) => ({ x0: e.lx - (e.label.length * LABEL_CW) / 2 - 3, y0: e.ly - LABEL_H / 2, x1: e.lx + (e.label.length * LABEL_CW) / 2 + 3, y1: e.ly + LABEL_H / 2 }))
    const nodes = lay.nodes.map((n) => ({ x0: n.x, y0: n.y, x1: n.x + n.w, y1: n.y + n.h }))
    const marked = lay.edges.filter((e) => !e.inline)
    expect(marked.length).toBeGreaterThan(0)
    const circles = marked.map((e) => ({ x0: e.lx - MARK_R, y0: e.ly - MARK_R, x1: e.lx + MARK_R, y1: e.ly + MARK_R }))
    circles.forEach((c, i) => {
      const e = marked[i]
      expect(labels.filter((b) => hits(c, b)), `circle ${e.n} over a label`).toEqual([])
      expect(nodes.filter((b) => hits(c, b)), `circle ${e.n} over a node`).toEqual([])
      expect(circles.filter((b, j) => j !== i && hits(c, b)), `circle ${e.n} over a circle`).toEqual([])
      // on its own edge's line
      expect(Math.min(...e.line.map((p) => Math.hypot(p.x - e.lx, p.y - e.ly)))).toBeLessThan(4)
    })
    // the notes numbered in the edges' order, each its edge's
    expect(marked.map((e) => e.n)).toEqual(marked.map((_e, i) => i + 1))
    expect(lay.notes.map((n) => n.label)).toEqual(marked.map((e) => e.label))
  })

test('a diagram with room for every label keeps its long label\'s number in the middle of its edge', () => {
  const lay = diagramLayout(graph([['backlog', 'claimed', '212 claimed'], ['claimed', 'closed', '20 closed, most as superseded or stale']]), { width: 600 })
  const [claimed, closed] = lay.edges
  expect([claimed.inline, closed.inline, closed.n]).toEqual([true, false, 1])
  const a = lay.nodes.find((n) => n.id === 'claimed')!
  const b = lay.nodes.find((n) => n.id === 'closed')!
  expect(closed.ly).toBeCloseTo((a.y + a.h + b.y) / 2, 0)
})
