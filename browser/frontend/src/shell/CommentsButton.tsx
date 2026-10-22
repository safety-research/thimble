// The top bar's Comments button, beside Labels: it opens the right sidebar on the open comments (CommentsList.tsx),
// with their count.
import { Icon } from '../components/Icon'
import { useCommentItems } from './CommentsList'

export function CommentsButton({ ws, open, onClick }: { ws: string; open: boolean; onClick: () => void }) {
  const { items } = useCommentItems(ws)
  return (
    <button type="button" className={`shell-side-btn${open ? ' on' : ''}`} aria-pressed={open} data-side="comments" onClick={onClick}>
      <Icon name="comment" size={14} />
      Comments
      <span className="shell-side-n">{items.length}</span>
    </button>
  )
}
