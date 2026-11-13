// The name of the folder a workspace opens (GET /corpora): its last part, as the analyst named it, else the workspace's
// own name. A folder's sessions open at once are workspaces `logs`, `logs.2` … of one folder, `logs`, which the Files
// tree's root names.
import { useEffect, useState } from 'react'
import { api } from './api'
import { shownPath } from './workspace'

/** The last part of a folder's path, '' for none. Pure. */
export function folderName(path: string | null | undefined): string {
  return (path ?? '').replace(/\/+$/, '').split('/').pop() ?? ''
}

export function useFolderName(ws: string): string {
  const [name, setName] = useState(ws)
  useEffect(() => {
    let alive = true
    setName(ws)
    api
      .corpora()
      .then((cs) => alive && setName(folderName(shownPath(cs.find((c) => c.name === ws))) || ws))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [ws])
  return name
}
