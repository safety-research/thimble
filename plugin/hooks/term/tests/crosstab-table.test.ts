// A pandas crosstab drawn as a table card from its html (bug hunt B23): the index's name heads the first column, the
// columns' name (`speaker`) heads nothing, and no empty row stands for the index's name (hooks/term/cell.ts htmlTable).
// `claude plugin test plugin`.
import { expect, test } from 'claude-code/testing'

import { cardOfCell, htmlTable } from '../cell'
import type { ThimbleCell } from '../cell'
import { CELLS } from './fixtures'

// pd.crosstab(df.participant, df.speaker, margins=True, margins_name='total').to_html(), as pandas writes it
const CROSSTAB = `<table border="1" class="dataframe">
  <thead>
    <tr style="text-align: right;">
      <th>speaker</th>
      <th>participant</th>
      <th>researcher</th>
      <th>total</th>
    </tr>
    <tr>
      <th>participant</th>
      <th></th>
      <th></th>
      <th></th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <th>P1</th>
      <td>10</td>
      <td>0</td>
      <td>10</td>
    </tr>
    <tr>
      <th>P2</th>
      <td>14</td>
      <td>2</td>
      <td>16</td>
    </tr>
  </tbody>
</table>`

test("a crosstab's index name heads its first column and its columns' name is dropped", () => {
  const cell = { ...(CELLS.ff73e071 as object), outputs: [{ 'text/html': CROSSTAB, 'text/plain': '' }] } as unknown as ThimbleCell
  const { card } = cardOfCell(cell)
  expect(card.kind).toBe('table')
  expect(card.columns).toEqual(['participant', 'participant', 'researcher', 'total'])
  expect(card.rows).toEqual([
    ['P1', 10, 0, 10],
    ['P2', 14, 2, 16],
  ])
})

test("a body row whose cells after the first are empty stays a row", () => {
  const html = '<table><tr><th>name</th><th>note</th></tr><tr><th>P1</th><td></td></tr><tr><th>P2</th><td>x</td></tr></table>'
  expect(htmlTable(html)).toEqual([
    ['name', 'note'],
    ['P1', ''],
    ['P2', 'x'],
  ])
})
