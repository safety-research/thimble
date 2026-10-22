// The line under a reply once its marks' check settled, when some failed: how many the check could not confirm. The
// check's notes (what it found false in the sentences around the marks) are not shown: main reads them with its next
// event (backend marks.tell_text). Nothing while the check runs (the busy line says it), and nothing when every mark
// held.
import { footerCounts, LOOK_WORD, type MarkItem } from './marks'

export function MarksFooter({ items }: { items: readonly MarkItem[] }) {
  if (items.some((m) => m.status === 'checking')) return null
  const counts = footerCounts(items)
  if (!counts.length) return null
  return (
    <div className="marks-foot">
      <div className="marks-foot-counts">
        {counts.map((c) => (
          <span key={c.look} className={`marks-foot-n is-${c.look}`}>
            {c.n} {LOOK_WORD[c.look]}
          </span>
        ))}
      </div>
    </div>
  )
}
