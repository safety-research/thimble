// table.mjs: a cited table cell as the terminal shows it, header and row. Evidence that is a table (a card's cell, or
// printed output that is a table: engine/kernel/evidence.py table_of, text_table) carries `table`: its corner, columns,
// the rows around the cited one and the cited cell `at` (c = -1: the row's name). The terminal shows the header over
// the cited row, the row's name first, then the cited column and as many columns beside it as fit, each right-aligned
// as a printed DataFrame aligns them, and tints the cited cell. Pure.

/**
 * The two lines of a cited cell: the header and the cited row, each {text, spans}, the cited cell's span in the row's;
 * null when the table has no cited row. `width`: the characters the lines may take.
 */
export function tableLines(t, width = 80) {
  const row = t && Array.isArray(t.rows) && t.at ? t.rows[t.at.r] : null
  if (!row) return null
  const cols = Array.isArray(t.cols) ? t.cols.map(String) : []
  const vals = Array.isArray(row.values) ? row.values.map(v => String(v ?? '')) : []
  const c0 = Number(t.at.c)
  const w = c => Math.max(cols[c].length, (vals[c] ?? '').length)
  const labelW = Math.max(String(t.corner ?? '').length, String(row.label ?? '').length)
  const chosen = c0 >= 0 && c0 < cols.length ? [c0] : []
  let used = labelW + chosen.reduce((n, c) => n + 2 + w(c), 0)
  let right = c0 >= 0 ? c0 + 1 : 0
  let left = c0 - 1
  for (let turn = 0; right < cols.length || left >= 0; turn++) {
    const c = turn % 2 === 0 ? (right < cols.length ? right++ : left--) : (left >= 0 ? left-- : right++)
    if (c < 0 || c >= cols.length) continue
    if (used + 2 + w(c) > width) break
    chosen.push(c)
    used += 2 + w(c)
  }
  chosen.sort((a, b) => a - b)
  let head = String(t.corner ?? '').padEnd(labelW)
  let text = String(row.label ?? '').padEnd(labelW)
  let spans = c0 < 0 ? [[0, String(row.label ?? '').length]] : []
  for (const c of chosen) {
    head += `  ${cols[c].padStart(w(c))}`
    const v = (vals[c] ?? '').padStart(w(c))
    if (c === c0) spans = [[text.length + 2 + (v.length - (vals[c] ?? '').length), text.length + 2 + v.length]]
    text += `  ${v}`
  }
  return [{ text: head.trimEnd(), spans: [] }, { text: text.trimEnd(), spans }]
}
