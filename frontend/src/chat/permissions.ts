// The permission requests waiting for the analyst from every session, and the plain words the permission card says
// about each: who asks, what it asks to do, and why. Main's requests are the analyst's own Claude Code session's
// prompts, relayed by the shim; every other session thimble started asks through its chat's meta (backend
// agent_session.ask). Pure.
import type { ChatMeta, PermissionRequest } from '../lib/types'
import { toolDisplayName } from './model'
import { threadKind } from './threads'
import { cardAsks } from './waiting'

/** One request waiting for the analyst, and the chat whose session asks: `main` for a prompt of the analyst's own
 * session. */
export interface PendingAsk {
  chat: string
  request: PermissionRequest
}

/** Every request on the card: main's, then those of every session thimble started while it runs, the one asked first
 * first, and after them those declined unanswered. Pure. */
export function pendingRequests(main: Pick<ChatMeta, 'permissions'> | null | undefined, metas: Iterable<ChatMeta>): PendingAsk[] {
  const out: PendingAsk[] = (main?.permissions ?? []).map((request) => ({ chat: 'main', request }))
  for (const m of metas) {
    if (m.id === 'main') continue
    for (const request of cardAsks(m)) out.push({ chat: m.id, request })
  }
  // a stable order: by when each asked, and in the order read where a time is missing
  const done = (a: PendingAsk) => (a.request.expired ? 1 : 0)
  const when = (a: PendingAsk) => Date.parse(a.request.since ?? '') || 0
  return out
    .map((a, i) => ({ a, i }))
    .sort((x, y) => done(x.a) - done(y.a) || when(x.a) - when(y.a) || x.i - y.i)
    .map((x) => x.a)
}

/** The thread a request comes from, which the card's head names: the thread of main whose agent asked (main's
 * request that names it), else the chat of the session that asked, main for main's own. Pure. */
export function askThread(ask: PendingAsk, metas?: ReadonlyMap<string, ChatMeta>, labels?: ReadonlyMap<string, string>): string {
  if (ask.chat !== 'main') return ask.chat
  const id = ask.request.chat
  const m = id ? metas?.get(id) : undefined
  if (!id || !m || labels?.has(id) || threadKind(m) != null) return id || 'main'
  // a subagent of main, which the thread tree does not list: main, or (in a chat an earlier build left) the orientation
  // run as main's subagent that started it
  const parent = m.parent ? metas?.get(m.parent) : undefined
  return parent && threadKind(parent) === 'orient' ? parent.id : 'main'
}

/** What a call of each tool asks to do, as the card's head says it (asks to run a command). */
const ASKS_TO: Readonly<Record<string, string>> = {
  Bash: 'run a command',
  Read: 'read a file',
  Edit: 'edit a file',
  MultiEdit: 'edit a file',
  Write: 'write a file',
  NotebookEdit: 'edit a notebook',
  Glob: 'search for files',
  Grep: 'search the files',
  WebFetch: 'fetch a web page',
  WebSearch: 'search the web',
  Agent: 'start an agent',
  Task: 'start an agent',
  ThimbleCode: "change thimble's own code",
  ThimblePackage: 'install a package',
}

/** What the request asks to do, in words (run a command); another tool is named (use thimble's add_card). Pure. */
export function asksTo(tool: string): string {
  const name = toolDisplayName(tool)
  return ASKS_TO[name] ?? `use ${name}`
}

/** The session that asks, in words: your Claude Code session for main (or the thread of it that asked), the
 * orientation, its critique, the report writer, a report check, the dev agent and its task (dev · view Posts, dev ·
 * ticket #3). `labels` names each chat as the thread tree does. Pure. */
export function askedBy(ask: PendingAsk, metas: ReadonlyMap<string, ChatMeta>, labels: ReadonlyMap<string, string> = new Map()): string {
  if (ask.chat === 'main') {
    const id = ask.request.chat
    const from = id ? labels.get(id) : null
    if (from && from !== 'main') return from === 'orient' || from.startsWith('orient-') ? 'The orientation' : `The thread ${from}`
    // a subagent of main, or (in a chat an earlier build left) one an orientation run as main's subagent started, which
    // the tree does not list
    const m = id ? metas.get(id) : undefined
    if (!m || from === 'main') return 'Your Claude Code session'
    const parent = m.parent ? metas.get(m.parent) : undefined
    const title = (m.title || 'agent').trim()
    return parent && threadKind(parent) === 'orient' ? `The orientation's agent “${title}”` : `Main's agent “${title}”`
  }
  const m = metas.get(ask.chat)
  const kind = m ? threadKind(m) : null
  if (kind === 'orient') return 'The orientation'
  if (kind === 'writer') return 'The report writer'
  if (kind === 'check') return m?.title ? `The ${m.title} check` : 'A report check'
  if (kind === 'dev') return `dev · ${devTask(m?.title ?? '', !!m?.view)}`
  if (kind === 'step') {
    const parent = m?.parent ? metas.get(m.parent) : undefined
    const title = (m?.title || 'step').trim()
    return parent && threadKind(parent) === 'orient' ? `The orientation's ${title}` : `The step ${title}`
  }
  return labels.get(ask.chat) ?? 'A session'
}

/** A dev chat's task as its title names it (backend dev: `view: <name>`, `ticket #<n>: <title>`): `view <name>`,
 * `ticket #<n>`. Pure. */
function devTask(title: string, view: boolean): string {
  const t = title.trim()
  if (view) return `view ${t.replace(/^view:\s*/, '')}`
  const m = /^(ticket(?: #\d+)?):/.exec(t)
  return m ? m[1] : t || 'ticket'
}

/** A wait in words: `a minute`, `10 minutes`, or `90 seconds` for one that is no whole number of minutes. Pure. */
export function waitWords(seconds: number): string {
  if (seconds < 60 || seconds % 60) return `${Number(seconds.toPrecision(6))} seconds`
  return seconds === 60 ? 'a minute' : `${seconds / 60} minutes`
}

/** The agent of the session that made the call, when a subagent or a workflow agent did: its step's title and type,
 * and the chat that opens it; null for the session itself. Pure. */
export function askingAgent(p: Pick<PermissionRequest, 'agent_id' | 'agent_type' | 'agent_title' | 'agent_chat'>): { title: string; type: string | null; chat: string | null } | null {
  if (!p.agent_id) return null
  const type = p.agent_type && p.agent_type !== p.agent_title ? p.agent_type : null
  return { title: p.agent_title || '', type, chat: p.agent_chat || null }
}

/** Claude Code's reason when auto mode's classifier gave no verdict on a call (backend agent_session.CLASSIFIER_DOWN). */
const CLASSIFIER_DOWN = /\bclassifier\b.*\bunavailable\b|\bno safety verdict\b/i

/** Whether auto mode left the call to the analyst only because its classifier gave no verdict. Pure. */
export function classifierDown(p: Pick<PermissionRequest, 'refused'>): boolean {
  return !!p.refused && CLASSIFIER_DOWN.test(p.refused)
}

/** The chat whose permission mode the card can switch out of Auto for this request: the asking session's own, when it
 * runs one (its card's switcher is ModeSwitch); null for main and the dev agent's sessions. Pure. */
export function modeChat(ask: PendingAsk, metas: ReadonlyMap<string, ChatMeta>): string | null {
  const m = metas.get(ask.chat)
  return ask.chat !== 'main' && m?.permission_mode ? ask.chat : null
}

/** Why thimble's config sends a call to the analyst whatever the session's permission mode (PermissionRequest.asked_by). */
const ASKED_BY: Readonly<Record<string, string>> = {
  data: 'thimble asks before an agent changes your files, in every permission mode.',
  installs: 'thimble asks before an agent installs software, in every permission mode.',
  commands: 'thimble asks about each command this agent runs outside its sandbox.',
}

/** The modes an orientation runs in, as its switcher names them. */
const MODE_NAMES: Readonly<Record<string, string>> = { manual: 'Manual', auto: 'Auto', bypass: 'Bypass' }

/** The line that says when an unanswered request is declined, '' for one that names no wait. Pure. */
function declineLine(seconds: number | null | undefined): string {
  return seconds ? ` If nobody answers within ${waitWords(seconds)}, it is declined.` : ''
}

/** Why the session asks, in one line: thimble's own reason when it gives one (a code ticket's question), auto mode
 * could not judge the call or left it to the analyst, the session runs in Manual, or main's prompt also waits in the
 * terminal, where the first answer counts; then when an unanswered request is declined. For a request declined
 * unanswered, that it was, and for one of the session's own calls that the agent went on without it. Pure. */
export function askWhy(ask: PendingAsk, metas: ReadonlyMap<string, ChatMeta>): string {
  const p = ask.request
  if (p.expired) return `Nobody answered ${p.wait_s ? `within ${waitWords(p.wait_s)}` : 'in time'}, so thimble declined it${p.why ? '' : ' and the agent went on without it'}.`
  if (p.why) return p.why
  if (classifierDown(p)) {
    const tries = p.rechecked ? `, all ${p.rechecked + 1} times it was asked` : ''
    return `Auto mode could not judge this call: Claude Code's classifier was unavailable${tries}.${declineLine(p.deny_after_s)}`
  }
  if (p.refused) return `Auto mode did not allow it on its own: ${p.refused.replace(/[.\s]+$/, '')}.${declineLine(p.wait_s)}`
  if (ask.chat === 'main') return 'Claude Code asks in your terminal too. The first answer counts.'
  const m = metas.get(ask.chat)
  const name = m?.permission_mode ?? p.mode
  const mode = name ? MODE_NAMES[name] : null
  const why =
    (p.asked_by && ASKED_BY[p.asked_by]) ||
    (mode === 'Manual' ? 'It runs in Manual, which asks before each call.' : mode === 'Auto' ? 'Auto mode asks you about this call.' : 'Its permission mode asks for this call.')
  return `${why}${declineLine(p.wait_s)}`
}
