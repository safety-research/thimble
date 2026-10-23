// table.mjs: a cited table cell as the terminal shows it, header and row. Evidence that is a table (a card's cell, or
// printed output that is a table: engine/kernel/evidence.py table_of, text_table) carries `table`: its corner, columns,
// the rows around the cited one and the cited cell `at` (c = -1: the row's name). The terminal shows the header over
// the cited row, the row's name first, then the cited column and as many columns beside it as fit, each right-aligned
// as a printed DataFrame aligns them, and tints the cited cell. Pure.

/**
 * The lines of a cited cell: the header and the cited row, each {text, spans}, the cited cell's span in the row's;
 * null when the table has no cited row. `width`: the characters the lines may take. A table whose citation names
 * several values (a range, a pair) carries the other cited cells in `also`: their columns are chosen first, and each
 * other cited row is one more line, its cited cells tinted.
 */
export function tableLines(t, width = 80) {
  const row = t && Array.isArray(t.rows) && t.at ? t.rows[t.at.r] : null
  if (!row) return null
  const cols = Array.isArray(t.cols) ? t.cols.map(String) : []
  const c0 = Number(t.at.c)
  const cited = [{ r: Number(t.at.r), c: c0 }, ...(Array.isArray(t.also) ? t.also : []).map(x => ({ r: Number(x.r), c: Number(x.c) })).filter(x => t.rows[x.r])]
  const citedRows = [...new Set(cited.map(x => x.r))]
  const valsOf = r => (Array.isArray(t.rows[r].values) ? t.rows[r].values.map(v => String(v ?? '')) : [])
  const w = c => Math.max(cols[c].length, ...citedRows.map(r => (valsOf(r)[c] ?? '').length))
  const labelW = Math.max(String(t.corner ?? '').length, ...citedRows.map(r => String(t.rows[r].label ?? '').length))
  const chosen = [...new Set(cited.map(x => x.c).filter(c => c >= 0 && c < cols.length))]
  let used = labelW + chosen.reduce((n, c) => n + 2 + w(c), 0)
  let right = c0 >= 0 ? c0 + 1 : 0
  let left = c0 - 1
  for (let turn = 0; right < cols.length || left >= 0; turn++) {
    const c = turn % 2 === 0 ? (right < cols.length ? right++ : left--) : (left >= 0 ? left-- : right++)
    if (c < 0 || c >= cols.length || chosen.includes(c)) continue
    if (used + 2 + w(c) > width) break
    chosen.push(c)
    used += 2 + w(c)
  }
  chosen.sort((a, b) => a - b)
  let head = String(t.corner ?? '').padEnd(labelW)
  for (const c of chosen) head += `  ${cols[c].padStart(w(c))}`
  const lines = citedRows.map(r => {
    const vals = valsOf(r)
    const label = String(t.rows[r].label ?? '')
    const mine = cited.filter(x => x.r === r).map(x => x.c)
    let text = label.padEnd(labelW)
    const spans = mine.includes(-1) ? [[0, label.length]] : []
    for (const c of chosen) {
      const v = (vals[c] ?? '').padStart(w(c))
      if (mine.includes(c)) spans.push([text.length + 2 + (v.length - (vals[c] ?? '').length), text.length + 2 + v.length])
      text += `  ${v}`
    }
    return { text: text.trimEnd(), spans }
  })
  return [{ text: head.trimEnd(), spans: [] }, ...lines]
}
