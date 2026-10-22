// register.ts: the bar above the prompt, its keys, and its panes.
//
//   registerFixKeys  f and F on a failure line, p and u on a fix in use, at an empty prompt (bar/fix.ts). It comes
//                    before the cards' keys, so a failure's keys win while its line shows.
//   registerBar      the bar (bar.tsx) in the AbovePrompt band; r and l at an empty prompt open coverage and the labels
//                    while the bar names them, and the same key again closes the pane; /thimble-settings and a click on
//                    `thimble` open the settings; the fixes' lifecycle (a `thimble fix` call, /thimble:fix, the
//                    person's next prompt; a `fix_ask` line of the change feed is core/feed.ts's); the counts after each
//                    of main's turns (counts.ts), and whether an answer exists for v.
//
// A bar key acts WORD_MS after it is pressed: a letter typed in that time means the person is typing a word that starts
// with it, so the key and the letter go back to the prompt and nothing runs. One key waits at a time, for every key the
// bar names; the fix keys' hook sees each letter at an empty prompt first, so it gives the word back.
import type { EngineInterface, Register } from 'claude-code'

import { closePane, openPane, paneNow, PANE_ID } from '../core/pane'
import { barKeys, barRows, setAnswered, type BarPresses } from './bar'
import { recount } from './counts'
import { failNotice, fixCommand, fixKeyOf, pressFix, promptTyped, refreshFixes } from './fix'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** How long after a key a letter means the person is typing a word that starts with it. */
export const WORD_MS = 350

/** The bar key pressed last, until WORD_MS has passed or a letter came. */
let waiting: { key: string; at: number; cancelled: boolean } | null = null

/** A letter straight after a bar key: the key began a word, which goes back to the prompt whole. */
function wordGoesOn(k: string, now: number, inputText: string): { text: string; cursor: number } | null {
  const w = waiting
  if (!w || w.cancelled || now - w.at >= WORD_MS || !/^\p{L}$/u.test(k)) return null
  w.cancelled = true
  waiting = null
  return { text: `${w.key}${inputText}`, cursor: w.key.length + inputText.length }
}

/** Take the key: its work runs WORD_MS later, unless a letter came first. */
function holdKey($: Engine, key: string, now: number, work: () => Promise<unknown>): { text: string; cursor: number } {
  const mine = { key, at: now, cancelled: false }
  waiting = mine
  $.clock.after(WORD_MS, () => {
    if (mine.cancelled) return
    if (waiting === mine) waiting = null
    void work().catch(err => failNotice($, `The ${key} key did not run: ${String((err as Error)?.message || err).slice(0, 200)}`))
  })
  return { text: '', cursor: 0 }
}

const TITLES = { coverage: 'Coverage', labels: 'Labels', settings: 'thimble settings' } as const

/** Whether the side pane shows this kind now. */
async function paneShows($: Engine, kind: string): Promise<boolean> {
  if ((await paneNow($))?.kind !== kind) return false
  return (await $.ui.panes()).some(p => p.id === PANE_ID)
}

/** Coverage or the labels: open, or closed when the pane shows it. Opened from the prompt, it leaves the keys there,
 *  so the same key closes it; a click inside it presses its rows. */
async function togglePane($: Engine, kind: 'coverage' | 'labels'): Promise<void> {
  if (await paneShows($, kind)) { await closePane($); return }
  if (kind === 'coverage') void recount($).catch(() => undefined)
  await openPane($, kind, {}, TITLES[kind])
}

/** The settings: they take the keys (tab walks the switches, ↵ turns one on or off, esc closes). */
export async function openSettings($: Engine): Promise<void> {
  await openPane($, 'settings', {}, TITLES.settings, { focus: true })
}

export const registerFixKeys: Register = on => {
  on('prompt.edit', { origin: { kind: 'composer' }, text: /^$/ }, async ($, e, next) => {
    const k = e.key
    if (!k || k.ctrl || k.meta) return next(e)
    const now = Number(await $.clock.now())
    const word = wordGoesOn(k.key, now, e.inputText)
    if (word) return word
    const what = await fixKeyOf($, k.key)
    if (!what) return next(e)
    return holdKey($, k.key, now, () => pressFix($, what))
  }).catch(($, e, next) => next(e))
}

export const registerBar: Register = on => {
  // the fixes as they stand: one still working shows in the bar, and its draft opens when it is written; whether the
  // conversation (a resumed one) holds an answer v can draw; /thimble-settings
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const r = await next(e)
    void refreshFixes($).catch(() => undefined)
    try {
      const rows = await $.session.messages()
      await setAnswered($, rows.some(m => m.role === 'assistant' && !!String(m.text || '').trim()))
    } catch {
      // the next answer sets it
    }
    try {
      await $.command.register({ name: 'thimble-settings', description: "thimble's settings: turn marks, cards, and the bar's coverage and labels on or off", immediate: true })
    } catch {
      // a click on `thimble` in the bar still opens them
    }
    return r
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'thimble-settings' }, async $ => {
    await openSettings($)
    return {}
  })

  // a `thimble fix` call (main's or a subagent's): the bar's fix note, and the line when a fix came into use
  on('tool.call', { tool: /^Bash$/ }, async ($, e, next) => {
    const r = await next(e)
    if (/\bthimble\b[^\n|;&]*\bfix\b/.test(String((e as Any).command || ''))) void refreshFixes($).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))

  // the end of a turn: the fixes again (a subagent may have worked on one); after main's, the counts, and an answer
  // for v
  on('turn.complete', { turnId: /./ }, async ($, e, next) => {
    const r = await next(e)
    void refreshFixes($).catch(() => undefined)
    if (e.agentId === undefined) {
      if (e.reason === 'answer' && e.answer.trim()) await setAnswered($, true)
      $.clock.after(0, () => { void recount($).catch(() => undefined) })
    }
    return r
  }).catch(($, e, next) => next(e))

  // the person's own prompt: a failure line's keys go
  on('prompt.submit', { origin: { kind: /^(?:composer|bridge)$/ } }, async ($, e, next) => {
    if (!e.command) await promptTyped($).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  // /thimble:fix [words] (commands/fix.md): submit, undo, try and the list are answered here; any other words are the
  // change the person wants, which the command's own text asks Claude to make
  on('command.run', { command: /^(thimble:)?fix$/ }, async ($, e, next) => {
    const r = await fixCommand($, e.args)
    return r ?? next(e)
  }).catch(($, e, next) => next(e))

  // r and l at an empty prompt, while the bar names them
  on('prompt.edit', { origin: { kind: 'composer' }, text: /^$/, key: { key: /^[rl]$/ } }, async ($, e, next) => {
    const k = e.key!
    if (k.ctrl || k.meta || !(await barKeys($)).has(k.key)) return next(e)
    const kind = k.key === 'r' ? 'coverage' : 'labels'
    return holdKey($, k.key, Number(await $.clock.now()), () => togglePane($, kind))
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      if (e.props.hasSurvey) return next(e)
      const els = $.ui.resolve(e) as Any
      const presses: BarPresses = { settings: () => openSettings($), pane: kind => togglePane($, kind) }
      const rows = await barRows($, els, Math.max(20, e.props.bodyColumns), { presses })
      return els.Box({ flexDirection: 'column', children: [els.Text({ key: 'gap', children: ' ' }), ...rows] })
    } catch {
      // a drawing that throws is drawn as Claude Code draws it: the person never sees the error itself
      return next(e)
    }
  })
}
