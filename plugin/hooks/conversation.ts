// conversation.ts: the key thimble keeps a session's records under. Claude Code can continue a conversation in a new
// session, with a new id and the transcript copied there (a session moved to the background, `--fork-session`). What
// thimble kept for it (the change feed, the events and what Claude read) belongs to the conversation, so a
// continuation finds it again under the same key: the id of the conversation's first session.
//
// The link is the conversation's first launch ($.session.usage().startedAt), which Claude Code keeps the same in every
// continuation. $THIMBLE_HOME/lean/conversations/<startedAt>.json holds {key, sessions}: written at the first turn of a
// conversation, and joined by a later session that starts with the conversation's transcript already in it. A session
// that starts empty is a conversation of its own, whatever file it finds. Where any of it cannot be read, the key is
// the session's own id, as before.
import type { EngineInterface } from 'claude-code'

type Engine = EngineInterface
type Conversation = { key: string; sessions: string[] }

const C = { id: '', key: '', pending: null as Promise<string> | null, noted: '' }
const MAX_SESSIONS = 50

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120) || 'none'

/** The file of this session's conversation, or null where Claude Code says no first launch. */
async function conversationFile($: Engine): Promise<string | null> {
  const at = Number((await $.session.usage())?.startedAt)
  if (!Number.isFinite(at) || at <= 0) return null
  const home = (await $.env.get('THIMBLE_HOME')) || `${(await $.env.get('HOME')) || '.'}/.thimble`
  return `${home.replace(/\/+$/, '')}/lean/conversations/${safe(String(Math.round(at)))}.json`
}

async function readConversation($: Engine, file: string): Promise<Conversation | null> {
  try {
    if (!(await $.fs.exists(file))) return null
    const c = JSON.parse(String(await $.fs.read(file)))
    if (!c || typeof c.key !== 'string' || !c.key) return null
    return { key: c.key, sessions: Array.isArray(c.sessions) ? c.sessions.filter((x: unknown) => typeof x === 'string') : [c.key] }
  } catch {
    return null
  }
}

async function writeConversation($: Engine, file: string, c: Conversation): Promise<void> {
  try {
    await $.fs.write(file, JSON.stringify({ key: c.key, sessions: c.sessions.slice(-MAX_SESSIONS) }))
  } catch {
    // the key holds for this load; a later session finds the conversation by its first file
  }
}

async function resolveKey($: Engine, id: string): Promise<string> {
  const file = await conversationFile($)
  if (!file) return id
  const c = await readConversation($, file)
  if (!c) return id
  if (c.sessions.includes(id) || c.key === id) return c.key
  // a continuation carries the conversation's transcript from its start; a session that starts empty is a new one
  const carried = ((await $.session.messages()) as unknown[]).length > 0
  if (!carried) return id
  await writeConversation($, file, { key: c.key, sessions: [...c.sessions, id] })
  return c.key
}

/** The key of this session's records: its conversation's first session id (its own id in a new conversation). */
export async function sessionKey($: Engine): Promise<string> {
  const id = String(await $.session.id())
  if (C.id === id && C.key) return C.key
  if (C.id === id && C.pending) return C.pending
  C.id = id
  C.key = ''
  const p = resolveKey($, id).catch(() => id).then(key => {
    if (C.id === id) {
      C.key = key
      C.pending = null
    }
    return key
  })
  C.pending = p
  return p
}

/** A turn of the conversation began: its file is written once, so a continuation in another session finds its key. */
export async function noteConversation($: Engine): Promise<void> {
  const key = await sessionKey($)
  if (C.noted === key) return
  C.noted = key
  try {
    const file = await conversationFile($)
    if (!file || (await readConversation($, file))) return
    await writeConversation($, file, { key, sessions: [key] })
  } catch {
    // a continuation then starts its own records
  }
}
