// The line under a reply once its marks' check settled, when the check changed something: how many marks it corrected,
// found wrong, could not confirm or could not check, then each note, what it found false in the sentences around the
// marks (the terminal's footer, plugin/marks/view.ts). Nothing while the check runs (the busy line says it), and
// nothing when every mark held.
import { footerCounts, LOOK_WORD, notesOf, type MarkItem } from './marks'

export function MarksFooter({ items }: { items: readonly MarkItem[] }) {
  if (items.some((m) => m.status === 'checking')) return null
  const counts = footerCounts(items)
  const notes = notesOf(items)
  if (!counts.length && !notes.length) return null
  return (
    <div className="marks-foot">
      {counts.length > 0 && (
        <div className="marks-foot-counts">
          {counts.map((c) => (
            <span key={c.look} className={`marks-foot-n is-${c.look}`}>
              {c.n} {LOOK_WORD[c.look]}
            </span>
          ))}
        </div>
      )}
      {notes.map((n) => (
        <div key={n} className="marks-foot-note">
          {n}
        </div>
      ))}
    </div>
  )
}
