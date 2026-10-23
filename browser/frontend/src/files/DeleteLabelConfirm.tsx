// The confirm of a label's delete, by the control that asked (`at`: the Labels pane's ⋯, the label editor's Delete
// label), in the style of a view's delete (ViewsBar DeleteViewConfirm): it names the label and what goes with it. It
// takes the focus on Cancel, and gives it back to that control when it closes, unless the focus has moved elsewhere.
import { useEffect, useRef } from 'react'
import { Button } from '../components/Button'
import { Popover, type Align } from '../components/Menu'

export interface DeleteLabelAsk {
  id: string
  name: string
  at: HTMLElement
}

/** What the confirm says goes with a label. */
export const DELETE_LABEL_TEXT = 'Its marks, its card and any filter that uses it are deleted with it.'

/** `align`: the edge of `at` the confirm lines up with, `end` for a control at the right of its row (the ⋯), `start`
 * for one at the left (the editor's Delete label), so the confirm stays over what asked. */
export function DeleteLabelConfirm({ asked, onClose, onDelete, align = 'end' }: { asked: DeleteLabelAsk | null; onClose: () => void; onDelete: (ask: DeleteLabelAsk) => void; align?: Align }) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!asked) return
    const raf = requestAnimationFrame(() => cancelRef.current?.focus())
    return () => {
      cancelAnimationFrame(raf)
      const at = asked.at
      if (at.isConnected && (!document.activeElement || document.activeElement === document.body)) at.focus()
    }
  }, [asked])
  return (
    <Popover anchor={asked?.at} open={!!asked} onClose={onClose} align={align} label={asked ? `Delete ${asked.name}` : 'Delete label'} className="files-views-delete files-label-delete" width={280}>
      {asked && (
        <div className="files-views-delete-body">
          <p>
            Delete {asked.name}? {DELETE_LABEL_TEXT}
          </p>
          <div className="files-views-delete-actions">
            <Button size="sm" ref={cancelRef} onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" variant="secondary" className="files-views-delete-go" onClick={() => onDelete(asked)}>
              Delete
            </Button>
          </div>
        </div>
      )}
    </Popover>
  )
}
