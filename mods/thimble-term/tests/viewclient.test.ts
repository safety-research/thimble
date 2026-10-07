// A terminal view's frame as its Client paints it (hooks/viewclient.tsx): a line's runs as few as look the same, so a
// chart or a row of columns is a few Texts rather than one a cell. `claude plugin test mods/thimble-term`.
import { expect, test } from 'claude-code/testing'

import type { Line } from '../hooks/draw'
import { fewer } from '../hooks/viewclient'

// each cell of a line with what shows of its style: a letter's every style; a space's background, underline, inverse
const looks = (l: Line) => l.flatMap(r => [...r.s].map(ch => (ch.trim() ? [ch, r.fg, r.bg, !!r.b, !!r.d, !!r.i, !!r.u, !!r.inv] : [ch, r.bg, !!r.u, !!r.inv])))

test("a view's line paints as few runs as look the same: spaces join the run beside them where no background, underline or inverse shows on them", () => {
  const hue = '#1d7fc0'
  // a list's row: its mark, a gap, its columns dim with gutters between them, the track on the selection background
  const row: Line = [{ s: '  ' }, { s: '●', fg: hue }, { s: ' ' }, { s: 'WillkommenImWiki' }, { s: '  ' }, { s: 'dse', d: true }, { s: '  ' }, { s: '2,327', d: true }, { s: '  ' }, { s: '342', d: true }, { s: '   ' }, { s: '▌', fg: hue, bg: 'selectionBg' }]
  // a lane: bars in a hue with empty cells between them, the rows in view on the selection background, a link
  const lane: Line = [{ s: '    dse     ' }, { s: '▁', fg: hue }, { s: ' ' }, { s: '▂', fg: hue }, { s: '  ' }, { s: '▁', fg: '#b77300' }, { s: ' ', bg: 'selectionBg' }, { s: '▃', fg: hue, bg: 'selectionBg' }, { s: ' ' }, { s: 'open', fg: 'remember', u: true }, { s: ' ' }, { s: 'it', fg: 'remember', u: true }]
  for (const l of [row, lane]) {
    const out = fewer(l)
    expect(looks(out)).toEqual(looks(l))
    expect(out.length).toBeLessThan(l.length)
  }
  expect(fewer(row).length).toBe(4)
  // an underlined run never takes the spaces after it, which would underline them
  expect(fewer(lane).at(-3)).toEqual({ s: 'open', fg: 'remember', u: true })
  expect(fewer([])).toEqual([])
})
