// Path helpers of the Files tab. Kind inference mirrors backend corpus.source_kind.
import type { SourceKind } from '../lib/types'

export const TREE = { def: 250, min: 180, max: 640 }

export function isDatabasePath(path: string): boolean {
  return /\.(db|sqlite|sqlite3)$/i.test(path)
}

export function inferKind(path: string): SourceKind {
  const parts = path.split('/')
  const name = parts[parts.length - 1]
  const parent = parts.length > 1 ? parts[parts.length - 2] : ''
  if (parent === 'agents' && name.endsWith('.jsonl')) return 'agent'
  if (name === 'board.jsonl') return 'board'
  if (name === 'events.jsonl') return 'events'
  if (isDatabasePath(name)) return 'forge'
  if (parent === 'prompts') return 'prompt'
  return 'text'
}
