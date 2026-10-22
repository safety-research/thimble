// Which texts of a chat are notes on the way to the reply rather than the reply. Pure.

/** The indexes of the text rows written in the middle of a turn, which draw as notes among its steps. Claude's reply is
 * the text after the turn's last call; words written before a later call are a note on the way there ("Let me count
 * the runs first."). When Claude wrote nothing after the last call (it answered and then made a card), the last words
 * before that call are the reply, and only the earlier ones are notes. While the last turn still runs (`running`), a
 * text a call follows is a note, since the reply may still come. A blank text counts as no text. Pure. */
export function midTurnTexts(rows: readonly { kind: string; index: number; text?: string }[], running = false): Set<number> {
  const out = new Set<number>()
  let after: number[] = [] // the texts since the turn's latest call
  let before: number[] = [] // the last texts a call followed
  const end = () => {
    if (!after.length) for (const i of before) out.delete(i)
    after = []
    before = []
  }
  for (const r of rows) {
    if (r.kind === 'text') {
      if (r.text === undefined || r.text.trim()) after.push(r.index)
    } else if (r.kind === 'tool' || r.kind === 'tools' || r.kind === 'calls' || r.kind === 'cardcall') {
      if (after.length) {
        for (const i of after) out.add(i)
        before = after
        after = []
      }
    } else if (r.kind === 'user') end()
  }
  if (!running) end()
  return out
}
