// subject.js: the top of every thread in the side panel, one look for each kind of subject (a card, a citation, an
// explainer, a label, Coverage, the labels list): a quoted block as Claude Code draws a quote, a dim rule `▎` down its
// left side, the subject's title on its first row, bold, and one dim row that says what it is and where it comes from.
// The thing itself (the card, the rows behind a citation, a label's values and records) follows under it.
//
//   subjectBlock(k, {title, line, glyph, parts, rows})   title and line are markup (escaped by the caller), the line
//                                                  dim unless it says otherwise; glyph a markup mark before the title
//                                                  (a label's ● in its color); parts nodes drawn after the line on its
//                                                  row (presses, such as a version); rows more rows of nodes under it,
//                                                  each its own row of the block (a label the card rests on)

export function subjectBlock(k, { title, line = '', glyph = '', parts = [], rows: more = [] }) {
  const bar = () => k.text('{dim:▎} ', { wrap: false })
  const rows = [k.text(`{dim:▎} ${glyph ? `${glyph} ` : ''}**${title}**`, { wrap: false })]
  if (line || parts.length) {
    rows.push(parts.length
      ? k.beside(k.text(`{dim:▎} ${dimmed(line)}`, { wrap: false }), ...parts, { gap: 0 })
      : k.text(`{dim:▎} ${dimmed(line)}`, { wrap: false }))
  }
  for (const r of more) rows.push(k.beside(bar(), ...(Array.isArray(r) ? r : [r]), { gap: 0 }))
  rows.push(k.text(' '))
  return k.stack(rows)
}

/** A line of plain words drawn dim; one that carries its own tones (`{c2:●}`) as it is. */
const dimmed = s => (!s ? '' : /\{[a-z0-9-]+:/i.test(s) ? s : `{dim:${s}}`)
