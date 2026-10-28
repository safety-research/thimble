// head.ts: the keys in a card's header, `a ask · p artifact`. They act on the card that takes the keys now (draw.ts
// headOwner: the card in focus, else the newest on screen), whose header alone shows the letters; every other card's
// header shows the words, which a click presses.
//
//   a   a side thread about the card, as a click on `ask` starts (core/answerview.ts cardAsk)
//   p   a private claude.ai artifact of the card: a fork of the conversation (core/forks.ts, kind `artifact`, with
//       prompts/artifact.md) publishes it with its Artifact tool, and its last message is the link. One publish of a
//       card at a time: a press while one starts or runs starts nothing. While it works the card says `creating
//       artifact…`, and the bar's busy line `publishing an artifact`; then `↗ <link>` under it, or why there is none.
//       Main reads the link, or why there is none, with the person's next prompt (core/tell.ts).
//
// p is a letter too (hooks/keys.ts holds the word window): as with v, the fork is spawned inside the key's own hook,
// and this module's agent.spawn hook holds it until the window closes, refusing it when a letter came. The card shows
// the publish once the window closed with no letter, so a word that starts with p leaves the card, and its link, as
// they were. A click has no window, and shows at once.
//
// A reload of the plugin (a change of the settings, /reload-plugins) empties this module's memory while a fork may
// still publish: $.state keeps which cards' artifacts are being made, so the fork's end still finds its card, and at
// session start one whose fork Claude Code no longer runs ends as failed, and says so.
//
//   headKey($, key, until)      what a or p does at an empty prompt now (hooks/keys.ts asks), or null when it types
//   startArtifact($, id, until) p's work, from the key or a click on `artifact`
//   artifactLine($, E, id)      the line under a card about its artifact, or null
//
//   state: cardArtifacts (each card's artifact, by card id), cardArtifactsNow (the cards whose artifact is being made)
import { update, type EngineInterface, type Register } from 'claude-code'

import { busyWhile } from '../bar/busy'
import { cardAsk } from '../core/answerview'
import { forkOf, spawnFork } from '../core/forks'
import { tellAtNextPrompt } from '../core/tell'
import { cut, fenced } from '../core/text.js'
import { promptText } from '../prompts/prompts'
import { fill } from '../prompts/registry.mjs'
import { featureOn } from '../settings/features.mjs'
import { cardText, headOwner } from './draw'
import { metaOf } from './store'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** thimble's letters in a card's header, which no card may take (hooks/keys.ts ownKeys). */
export const HEAD_KEYS = ['a', 'p']

export type Made = {
  card: string
  /** held: the fork waits to start; running: the fork works; the rest: it ended */
  status: 'held' | 'running' | 'done' | 'failed' | 'cancelled'
  agentId: string | null
  /** when the word window closes: the spawn waits until then */
  until: number
  url?: string
  error?: string
}

/** The words the fork shows as in /tasks, and how this module's agent.spawn hook knows the spawn as p's. */
const DESCRIPTION = 'artifact of a card (p)'
/** The busy line's step while a fork publishes a card. */
const STEP = 'publishing an artifact'
/** The most of a card's text copy the fork reads. */
const COPY_CHARS = 4000
const MADE = { plugin: 'thimble', key: 'cardArtifacts' } as const
const NOW = { plugin: 'thimble', key: 'cardArtifactsNow' } as const
/** A claude.ai artifact's link, as the Artifact tool gives it. */
const LINK = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/

/** The artifact each card has, as this load of the module holds it; $.state holds it too. */
const made = new Map<string, Made>()
/** The publishes whose fork is starting: held for a key's word window, or spawned and not yet named by Claude Code. */
const starting = new Set<Made>()

const firstLine = (s: string) => String(s || '').split('\n').map(l => l.trim()).find(Boolean) || ''
const reason = (err: unknown) => cut(String((err as Error)?.message || err), 200)
const working = (m: Made | null | undefined) => m?.status === 'held' || m?.status === 'running'
/** Whether a publish of the card starts or runs now, as this load knows it. */
const making = (card: string) => [...starting].some(m => m.card === card && m.status === 'held') || working(made.get(card))

async function madeOf($: Engine, card: string): Promise<Made | null> {
  const known = made.get(card)
  if (known) return known
  // a reload of the plugin: the record as the earlier load kept it, known again
  const kept = ((await $.state.get({ ...MADE, id: card })).value ?? null) as Made | null
  // each read of $.state gives a copy of its own: the record another read (the session start's, the card's drawing)
  // or a save kept meanwhile is the one, so that the fork's end changes the record the busy step watches
  const meanwhile = made.get(card)
  if (meanwhile) return meanwhile
  if (kept) made.set(card, kept)
  return kept
}

async function save($: Engine, m: Made): Promise<void> {
  made.set(m.card, m)
  await $.state.set({ ...MADE, id: m.card }, m)
  await update($, NOW, cur => [...(cur ?? []).filter(c => c !== m.card), ...(working(m) ? [m.card] : [])])
  $.ui.invalidate('ui.render')
}

async function end($: Engine, m: Made, status: Made['status'], o: { url?: string; error?: string } = {}): Promise<void> {
  m.status = status
  if (o.url) m.url = o.url
  if (o.error) m.error = o.error
  await save($, m)
}

/** The fork's prompt: the card's title, its rows' file and its text copy as drawn now. */
async function promptOf($: Engine, card: string): Promise<string | null> {
  const meta = await metaOf($, card)
  if (!meta || meta.version < 1) return null
  return fill(await promptText($, 'artifact'), { TITLE: meta.title, FILE: meta.lastFile || meta.file, COPY: fenced(cut(await cardText($, card), COPY_CHARS)) })
}

/** The fork, spawned while the key's or the click's own hook runs (the agent.spawn hook below holds it for the word
 *  window). Once Claude Code names it, the card and the bar show that it works. */
async function spawn($: Engine, m: Made, prompt: string): Promise<void> {
  try {
    const r = await spawnFork($, { kind: 'artifact', prompt, description: DESCRIPTION })
    if (m.status === 'cancelled') return
    if (!r.agentId) return await end($, m, 'failed', { error: cut(r.deny || 'Claude Code started no agent', 160) })
    m.agentId = r.agentId
    m.status = 'running'
    await save($, m)
    await busyWhile($, STEP, () => m.status === 'running')
  } catch (err) {
    await end($, m, 'failed', { error: reason(err) })
  } finally {
    starting.delete(m)
  }
}

/** p, or a click on `artifact`: the fork that publishes the card, spawned inside the hook that calls this (a click's:
 *  `until` 0; a key's: when its word window closes). Null when nothing starts: the card has no version, or its
 *  artifact is still being made. */
export async function startArtifact($: Engine, card: string, until: number): Promise<{ now: () => Promise<unknown>; undo: () => Promise<unknown> } | null> {
  if (!featureOn('cards') || making(card) || working(await madeOf($, card))) return null
  const prompt = await promptOf($, card)
  return prompt ? launch($, card, prompt, until) : null
}

/** The fork for a card's artifact, with its prompt made: `now` starts it (inside the hook that calls it), `undo`
 *  lets it go while the word window holds it. A press while another of the card's publishes starts or runs (a double
 *  click, p and a click) starts nothing. A click shows on the card at once; a key's publish shows once its spawn goes. */
export function launch($: Engine, card: string, prompt: string, until: number): { now: () => Promise<unknown>; undo: () => Promise<unknown> } {
  const m: Made = { card, status: 'held', agentId: null, until }
  return {
    now: async () => {
      if (making(card)) return
      starting.add(m)
      void spawn($, m, prompt)
      if (!until) await save($, m)
    },
    undo: async () => {
      if (m.status === 'held') m.status = 'cancelled'
    },
  }
}

/** a or p at an empty prompt, on the card that takes the keys now; null when the key types. */
export async function headKey($: Engine, key: string, until: number): Promise<{ now?: () => Promise<unknown>; undo?: () => Promise<unknown>; later?: () => Promise<unknown> } | null> {
  if (!HEAD_KEYS.includes(key) || !featureOn('cards')) return null
  const meta = await headOwner($)
  if (!meta) return null
  if (key === 'a') {
    const ask = await cardAsk($, meta.id, meta.title)
    return ask ? { later: async () => { await ask.press() } } : null
  }
  return startArtifact($, meta.id, until)
}

/** The line under a card about its artifact: being made, its link, or why there is none. Null when it has none. */
export async function artifactLine($: Engine, E: Any, card: string): Promise<Any | null> {
  const m = await madeOf($, card)
  if (!m || m.status === 'cancelled') return null
  const box = (children: Any[]) => E.Box({ key: `artifact-${card}`, marginLeft: 4, children })
  if (working(m)) return box([E.Text({ key: 'w', dimColor: true, children: 'creating artifact…' })])
  // the link with no label, which Claude Code draws as the address alone (with a label: the label, then the address)
  if (m.status === 'done' && m.url) return box([E.Text({ key: 'a', dimColor: true, children: '↗ ' }), E.Link({ key: 'l', href: m.url })])
  return box([E.Text({ key: 'x', color: 'error', wrap: 'wrap', children: `× no artifact${m.error ? `: ${m.error}` : ''}` })])
}

/** The fork ended: the link its last message gives, or why it gave none. Main reads either with the person's next
 *  prompt, since the person may ask about the page, which only the account this session publishes with can open. */
async function finish($: Engine, m: Made, e: { reason: string; answer: string }): Promise<void> {
  if (e.reason === 'aborted') return end($, m, 'cancelled')
  const url = String(e.answer || '').match(LINK)?.[0]
  const said = cut(firstLine(e.answer), 160)
  const error = url ? '' : e.reason === 'refusal' ? "the model's safeguards refused it" : said || (e.reason === 'error' ? 'the model call failed' : 'the copy gave no link')
  if (url) await end($, m, 'done', { url })
  else await end($, m, 'failed', { error })
  const title = (await metaOf($, m.card).catch(() => null))?.title
  const card = `the card “${title || m.card}” (id "${m.card}")`
  await tellAtNextPrompt($, `p:${m.card}`, url
    ? `The analyst pressed p on ${card}, and a copy of you published it as a new private claude.ai artifact: ${url}. Its link shows under the card. Only the claude.ai account this session publishes with can open it.`
    : `The analyst pressed p on ${card} to publish it as a claude.ai artifact, and no artifact was published: ${error.replace(/[.\s]+$/, '')}.`)
    .catch(() => undefined)
}

/** The artifact a fork makes: as this load holds it, else as $.state keeps it (the plugin was loaded again while the
 *  fork ran). */
async function owning($: Engine, agentId: string | undefined): Promise<Made | null> {
  const its = (m: Made | null | undefined) => !!m && !!agentId && m.agentId === agentId && m.status === 'running'
  for (const m of made.values()) if (its(m)) return m
  for (const card of ((await $.state.get(NOW)).value ?? []) as string[]) {
    const m = await madeOf($, card)
    if (its(m)) return m
  }
  return null
}

/** A reload of the plugin: each artifact still being made is known again, with its busy step; one whose fork Claude
 *  Code no longer runs (its end came while the plugin loaded) ends as failed, and says so under its card. */
async function resume($: Engine): Promise<void> {
  const cards = ((await $.state.get(NOW)).value ?? []) as string[]
  if (!cards.length) return
  const agents = await $.agent.list()
  for (const card of cards) {
    const m = await madeOf($, card)
    if (!m || !working(m)) continue
    const a = m.status === 'running' ? agents.find(x => x.id === m.agentId) : undefined
    if (a && !['completed', 'failed', 'killed'].includes(a.status)) await busyWhile($, STEP, () => m.status === 'running')
    else await end($, m, 'failed', { error: 'thimble lost the copy that made it; press p to publish the card again' })
  }
}

export const registerCardHead: Register = on => {
  // a click on a card's `artifact`: what p does, started in this hook, so the plugin's other hooks serve its fork
  on('ui.press', { element: /^card-artifact-/ }, async ($, e, next) => {
    if (e.plugin !== 'thimble') return next(e)
    try {
      const t = await startArtifact($, String(e.element).slice('card-artifact-'.length), 0)
      if (!t) return next(e)
      await t.now()
    } catch {
      return next(e)
    }
    return { element: e.element }
  }).catch(($, e, next) => next(e))

  // a reload of the plugin: the artifacts being made are known again
  on('session.start', { cwd: /^\/?/ }, async ($, e, next) => {
    const r = await next(e)
    try {
      await resume($)
    } catch {
      // each ends when its fork does
    }
    return r
  }).catch(($, e, next) => next(e))

  // a fork's end, found by the card's record that names its agent: at a reload the fork registry (core/forks.ts) knows
  // the fork again only after this module's session start, and the end may come before that
  on('turn.complete', { agentId: /\S/ }, async ($, e, next) => {
    const r = await next(e)
    const kind = forkOf(e.agentId)?.kind
    if (kind && kind !== 'artifact') return r
    const m = await owning($, e.agentId)
    if (m) {
      try {
        await finish($, m, e)
      } catch (err) {
        await end($, m, 'failed', { error: reason(err) })
      }
    }
    return r
  }).catch(($, e, next) => next(e))

  // the fork's calls: it reads, runs code and publishes; it writes only the page (.html) it publishes
  on('tool.call', { agentId: /\S/ }, async ($, e, next) => {
    if (forkOf(e.agentId)?.kind !== 'artifact') return next(e)
    const tool = String((e as Any).tool)
    if (tool === 'Edit' || tool === 'NotebookEdit') return { deny: "The artifact's copy changes no file; it writes the page it publishes with Write." }
    if (tool === 'Write' && !/\.html?$/i.test(String((e as Any).file_path ?? ''))) return { deny: "The artifact's copy writes only the page it publishes, an .html file." }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : forkOf(e.agentId)?.kind === 'artifact' ? { deny: "thimble could not check this call of the artifact's copy" } : next(e)))

  // p's spawn waits out the word window, and is refused when a letter came in it
  on('agent.spawn', { description: DESCRIPTION }, async ($, e, next) => {
    if (next.origin.plugin !== 'thimble') return next(e)
    const m = [...starting].filter(x => x.status === 'held').at(-1)
    if (!m) return next(e)
    const left = m.until - Number(await $.clock.now())
    if (left > 0) await $.clock.sleep(left)
    if (m.status === 'cancelled') return { deny: 'the person typed a word that starts with p' }
    return next(e)
  }).catch(($, e, next) => next(e))
}
