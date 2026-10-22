// register.ts: the line above the prompt, and the fix keys.
//
//   registerFixKeys  f and F on a failure line, p and u on a fix in use, at an empty prompt (bar/fix.ts). A letter typed
//                    within WORD_MS of the key means the person is typing a word: the key and the letter go back to the
//                    prompt, and nothing runs.
//   registerBar      the line: `thimble`, the step thimble works on now (busy.ts), the fix line's keys (fix.ts), and the
//                    counts (counts.ts: coverage, labels); the fixes' lifecycle (a `thimble fix` call, /thimble:fix, the
//                    person's next prompt; a `fix_ask` line of the change feed is core/feed.ts's); the counts after each
//                    of main's turns
import type { EngineInterface, Register } from 'claude-code'

import { featureOn } from '../settings/features.mjs'
import { busyNow } from './busy'
import { countsNow, recount } from './counts'
import { failNotice, fixBar, fixCommand, fixKeyOf, pressFix, promptTyped, refreshFixes } from './fix'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** How long after a key a letter means the person is typing a word that starts with it. */
export const WORD_MS = 350

/** The fix key pressed last, until WORD_MS has passed or a letter came. */
let waiting: { key: string; at: number; cancelled: boolean } | null = null

export const registerFixKeys: Register = on => {
  on('prompt.edit', { origin: { kind: 'composer' }, text: /^$/ }, async ($, e, next) => {
    const k = e.key
    if (!k || k.ctrl || k.meta) return next(e)
    const now = Number(await $.clock.now())
    const w = waiting
    // a letter straight after a fix key: the key began a word
    if (w && !w.cancelled && now - w.at < WORD_MS && /^\p{L}$/u.test(k.key)) {
      w.cancelled = true
      waiting = null
      return { text: `${w.key}${e.inputText}`, cursor: w.key.length + e.inputText.length }
    }
    const what = await fixKeyOf($, k.key)
    if (!what) return next(e)
    const mine = { key: k.key, at: now, cancelled: false }
    waiting = mine
    $.clock.after(WORD_MS, () => {
      if (mine.cancelled) return
      if (waiting === mine) waiting = null
      void pressFix($, what).catch(err => failNotice($, `× The fix key did not run: ${String((err as Error)?.message || err).slice(0, 200)}`))
    })
    return { text: '', cursor: 0 }
  }).catch(($, e, next) => next(e))
}

/** The line's parts as text runs: [words, how they are drawn]. */
async function lineParts($: Engine): Promise<{ text: string; dim?: boolean; bold?: boolean; color?: string }[]> {
  const parts: { text: string; dim?: boolean; bold?: boolean; color?: string }[] = []
  const sep = () => { if (parts.length) parts.push({ text: ' · ', dim: true }) }
  const b = await busyNow($)
  if (b) { sep(); parts.push({ text: `${b.glyph} ${b.word}${b.secs != null ? ` ${b.secs}s` : ''}` }) }
  for (const f of await fixBar($)) {
    sep()
    if (f.key) parts.push({ text: f.key, bold: true }, { text: ` ${f.words}`, ...(f.tone === 'error' ? { color: 'error' } : {}) })
    else parts.push({ text: f.words, ...(f.good ? { color: 'success' } : {}) })
  }
  const c = featureOn('counts') ? await countsNow($) : null
  if (c?.coverage) { sep(); parts.push({ text: `coverage ${c.coverage}`, dim: true }) }
  if (c?.labels) { sep(); parts.push({ text: `${c.labels} label${c.labels === 1 ? '' : 's'}`, dim: true }) }
  return parts
}

export const registerBar: Register = on => {
  // the fixes as they stand: one still working shows in the bar, and its draft opens when it is written; the counts
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const r = await next(e)
    void refreshFixes($).catch(() => undefined)
    $.clock.after(0, () => { void recount($).catch(() => undefined) })
    return r
  }).catch(($, e, next) => next(e))

  // a `thimble fix` call (main's or a subagent's): the bar's fix note, and the line when a fix came into use
  on('tool.call', { tool: /^Bash$/ }, async ($, e, next) => {
    const r = await next(e)
    if (/\bthimble\b[^\n|;&]*\bfix\b/.test(String((e as Any).command || ''))) void refreshFixes($).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))

  // the end of a turn: the fixes again (a subagent may have worked on one), and after main's, the counts
  on('turn.complete', { turnId: /./ }, async ($, e, next) => {
    const r = await next(e)
    void refreshFixes($).catch(() => undefined)
    if (e.agentId === undefined) $.clock.after(0, () => { void recount($).catch(() => undefined) })
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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      if (e.props.hasSurvey) return next(e)
      const parts = await lineParts($)
      if (!parts.length) return next(e)
      const { Box, Text } = $.ui.resolve(e) as Any
      const line = Text({ wrap: 'truncate-end', children: [Text({ key: 'name', dimColor: true, children: 'thimble  ' }), ...parts.map((p, i) => Text({ key: `p${i}`, dimColor: !!p.dim, bold: !!p.bold, ...(p.color ? { color: p.color } : {}), children: p.text }))] })
      return Box({ flexDirection: 'column', children: [Text({ key: 'gap', children: ' ' }), line] })
    } catch {
      // a drawing that throws is drawn as Claude Code draws it: the person never sees the error itself
      return next(e)
    }
  })
}
