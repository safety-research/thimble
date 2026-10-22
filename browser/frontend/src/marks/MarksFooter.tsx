// The lines under a reply once its marks' check settled: each note, what the check found false in the sentences around
// the marks. No counts: each mark shows its own status where it stands (the terminal's footer, plugin/marks/view.ts,
// counts nothing once the check settled either). Nothing while the check runs (the busy line says it), and nothing
// when no note was given.
import { notesOf, type MarkItem } from './marks'

export function MarksFooter({ items }: { items: readonly MarkItem[] }) {
  if (items.some((m) => m.status === 'checking')) return null
  const notes = notesOf(items)
  if (!notes.length) return null
  return (
    <div className="marks-foot">
      {notes.map((n) => (
        <div key={n} className="marks-foot-note">
          {n}
        </div>
      ))}
    </div>
  )
}
