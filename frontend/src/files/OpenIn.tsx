// Open in, on a file's panel: the other views that claim the file, and the File browser when a view shows it. A viewer
// for the file's type is one of the File browser's own modes, so it is not listed.
import { useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { Menu, type MenuItem } from '../components/Menu'
import { bus } from '../lib/bus'
import type { View } from '../lib/types'
import { viewsForFile } from '../lib/views'

/** The menu's items: each view but `current`, then the File browser when `current` is a view. Pure. */
export function openInItems(views: Pick<View, 'slug' | 'name'>[], current: string | null, onOpen: (slug: string | null) => void): MenuItem[] {
  return [
    ...views.filter((v) => v.slug !== current).map((v) => ({ id: `v:${v.slug}`, label: v.name, onSelect: () => onOpen(v.slug) })),
    ...(current ? [{ id: 'browser', label: 'File browser', onSelect: () => onOpen(null) }] : []),
  ]
}

interface Props {
  ws: string
  path: string
  /** the view the file is shown in, null for the File browser */
  current: string | null
  onOpen: (slug: string | null) => void
}

export function OpenIn({ ws, path, current, onOpen }: Props) {
  const [views, setViews] = useState<View[]>([])
  useEffect(() => {
    let alive = true
    const read = () =>
      viewsForFile(ws, path)
        .then((list) => alive && setViews(Array.isArray(list) ? list.filter((v) => v.ok && !v.file_type) : []))
        .catch(() => undefined)
    read()
    const off = bus.on('view', () => void read())
    return () => {
      alive = false
      off()
    }
  }, [ws, path])
  const items = openInItems(views, current, onOpen)
  if (!items.length) return null
  return <Menu label="Open in" align="end" items={items} className="open-in" trigger={<Button variant="ghost" size="sm">Open in</Button>} />
}
