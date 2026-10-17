// A chart with many series in as many colors (live feedback, 10-17: a line chart of 12 step types read as "too few
// colors", seven hues come round again): a line card's twelve lines and a stacked bar card's ten groups each in a color
// of its own, from the theme's palette, the same in the key as on the marks.
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { cardLayout } from '../draw'
import type { CardData } from '../draw'
import { COLORS } from '../paint'

const NAMES = ['Ash', 'Birch', 'Cedar', 'Dogwood', 'Elm', 'Fir', 'Ginkgo', 'Hazel', 'Ironwood', 'Juniper', 'Kapok', 'Larch']

/** The colors of a card's key, by the name after each `●`. */
function keyColors(c: CardData, cols = 160): Map<string, string> {
  const out = new Map<string, string>()
  for (const l of cardLayout(c, cols, -1).lines) l.forEach((s, i) => (s.s === '● ' && l[i + 1] ? out.set(l[i + 1]!.s.trim(), String(s.fg)) : undefined))
  return out
}

test('a line card of twelve series draws each line in a color of its own', () => {
  const card: CardData = {
    id: 'l1n3s012',
    kind: 'line',
    question: 'How many saves did each of the 12 busiest editors make per hour?',
    x: 'hour',
    y: 'saves',
    note: '',
    source: {},
    series: NAMES.map((name, i) => ({ name, points: [0, 1, 2, 3].map(h => [h, (i + 1) * (h + 1)] as [number, number]) })),
  }
  const key = keyColors(card)
  expect([...key.keys()]).toEqual(NAMES)
  expect(new Set(key.values()).size).toBe(12)
  // the first seven are the browser's series, in order
  expect(NAMES.slice(0, 7).map(n => key.get(n))).toEqual([...COLORS.series])
})

test("a bar card colored by a field with ten values draws each value's bars and key in a color of its own", () => {
  const card: CardData = {
    id: 'b4rs0010',
    kind: 'bar',
    question: 'Which pages got the most saves, by the editor with the most saves on each?',
    x: 'saves',
    y: 'page',
    note: '',
    source: {},
    rows: NAMES.slice(0, 10).map((g, i) => ({ label: `page-${i + 1}`, value: 100 - i * 7, group: g })),
  }
  const key = keyColors(card)
  expect(key.size).toBe(10)
  expect(new Set(key.values()).size).toBe(10)
  // each bar in its group's color
  const bars = cardLayout(card, 160, -1).lines.slice(0, 10).map(l => l.find(s => /[█▏▎▍▌▋▊▉]/.test(s.s))?.fg)
  expect(bars).toEqual(NAMES.slice(0, 10).map(n => key.get(n)))
})
