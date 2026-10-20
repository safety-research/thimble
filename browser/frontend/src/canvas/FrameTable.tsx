// A table card's DataFrame drawn as thimble's own table (lib/dataFrame, backend/app/frames.py): a sticky header,
// numbers right-aligned in their columns' formats, prose columns wrapping at a readable measure, and "n more rows"
// when the DataFrame was truncated. A table wider than the card wraps its text (`data-fit`); a table of numbers still
// wider scrolls sideways under a fade. Says `data-settled` at once, since it draws in one pass.
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cellText, type Frame } from '../lib/dataFrame'
import { isProse } from '../lib/tables'

/** a text cell longer than this, in characters, wraps its column even when it is not written as prose (a path, a run of
 * words without spaces) */
const LONG_TEXT = 48

export interface TableCol {
  /** the column's name, as the header shows it and a ref names it */
  key: string
  /** numbers: right-aligned, in the column's format */
  num: boolean
  /** a column of prose (a sentence, a description, a long text): the whole column wraps at a readable measure */
  prose: boolean
}
export interface TableRow {
  /** what names the row in a ref: the label column's value unformatted (backend frames.row_labels), else its place */
  name: string
  /** what the row's label shows: its name, or a number in its column's format */
  label: string
  cells: { text: string; prose: boolean }[]
}
export interface TableModel {
  /** the label column's name over the row labels, '' for rows named by their place or an unnamed index */
  corner: string
  /** rows are named by their place (a RangeIndex, no distinct text column): the labels stay in the table for the
   * citations, hidden */
  labelHidden: boolean
  cols: TableCol[]
  rows: TableRow[]
  /** rows of the DataFrame the card does not keep, for "n more rows" */
  more: number
}

/** The table as the card draws it: the shown columns, numbers in their formats, the row label first. Pure. */
/** the name pandas gives an index that has none (backend frames._UNNAMED_INDEX) */
const UNNAMED_INDEX = /^(?:index|level_\d+)$/

export function tableModel(frame: Frame): TableModel {
  const label = frame.label && frame.columns.includes(frame.label) ? frame.label : null
  const colIdx = new Map(frame.columns.map((c, i) => [c, i] as const))
  const cols = frame.view.columns.filter((c) => colIdx.has(c) && c !== label)
  const num = (c: string) => frame.types[c] === 'quantitative'
  const text = (c: string, v: Frame['rows'][number][number]) => (num(c) ? cellText(v, frame.view.formats[c]) : cellText(v))
  // a text column wraps as a whole when any cell of it is prose or runs long, since one long unwrapped cell sets the
  // width of the whole column
  const prose = new Set(
    cols.filter((c) => {
      if (num(c)) return false
      const k = colIdx.get(c)!
      return frame.rows.some((r) => {
        const t = cellText(r[k])
        return isProse(t) || t.length > LONG_TEXT
      })
    }),
  )
  return {
    corner: label && !(label === frame.index && UNNAMED_INDEX.test(label)) ? label : '',
    labelHidden: !label,
    cols: cols.map((c) => ({ key: c, num: num(c), prose: prose.has(c) })),
    rows: frame.rows.map((r, i) => {
      const v = label ? r[colIdx.get(label)!] : null
      const name = label ? cellText(v) : String(i)
      return {
        name,
        label: label ? text(label, v) : name,
        cells: cols.map((c) => ({ text: text(c, r[colIdx.get(c)!]), prose: prose.has(c) })),
      }
    }),
    more: frame.view.more,
  }
}

export function FrameTable({ frame }: { frame: Frame }) {
  const model = useMemo(() => tableModel(frame), [frame])
  const box = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)
  useLayoutEffect(() => {
    const el = box.current
    const root = el?.closest<HTMLElement>('.frame-table')
    if (!el || !root) return
    // a table wider than the card fits by letting its text wrap (`data-fit`, set here rather than through React so the
    // measure below reads the table without it); a table of numbers still wider scrolls sideways
    let width = -1
    const fit = () => {
      if (el.clientWidth === width) return
      width = el.clientWidth
      delete root.dataset.fit
      if (el.scrollWidth > el.clientWidth + 1) root.dataset.fit = ''
    }
    const check = () => {
      fit()
      setMore(el.scrollWidth - el.scrollLeft > el.clientWidth + 1)
    }
    check()
    el.addEventListener('scroll', check, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(check) : null
    ro?.observe(el)
    return () => {
      el.removeEventListener('scroll', check)
      ro?.disconnect()
    }
  }, [model])
  return (
    <div className="frame-table" data-body="" data-settled="true">
      <div className={`outputs-html-wrap${more ? ' outputs-html-more' : ''}`}>
        <div className="outputs-html outputs-html-table frame-table-box" ref={box}>
          <table className={[model.labelHidden ? 'outputs-rangeindex' : '', model.cols.some((c) => c.prose) ? 'frame-table-prose' : ''].filter(Boolean).join(' ') || undefined}>
            <thead>
              <tr>
                <th>{model.corner}</th>
                {model.cols.map((c) => (
                  <th key={c.key} className={c.num ? 'outputs-numhead' : undefined}>
                    {c.key}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {model.rows.map((r, i) => (
                <tr key={i}>
                  <th data-label={r.name !== r.label ? r.name : undefined}>{r.label}</th>
                  {r.cells.map((cell, k) => (
                    <td key={k} className={model.cols[k].num ? 'outputs-num' : cell.prose ? 'outputs-prose' : undefined}>
                      {cell.text}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {model.more > 0 && <div className="dim canvas-viz-more">{`${model.more.toLocaleString()} more rows`}</div>}
    </div>
  )
}
