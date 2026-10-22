// register.ts: the bar above the prompt, and its panes.
//
//   registerBar  the bar (bar.tsx) in the AbovePrompt band. /thimble-settings and a click on `thimble` open the
//                settings; the fixes' lifecycle (a `thimble fix` call, /thimble:fix, the person's next prompt; a
//                `fix_ask` line of the change feed is core/feed.ts's); the counts after each of main's turns (counts.ts)
//   barKey       r and l at an empty prompt (hooks/keys.ts asks), while the bar names them: coverage and the labels.
//                Coverage leaves the keys at the prompt, so r again closes it; the labels pane takes the keys (its
//                number keys check records), and esc closes it
import type { EngineInterface, Register } from 'claude-code'

import { closePane, openPane, paneNow, PANE_ID } from '../core/pane'
import { openLabels } from '../labels/pane'
import { barKeys, barRows, type BarPresses } from './bar'
import { recount } from './counts'
import { failCleared, fixCommand, noticeLine, promptTyped, refreshFixes } from './fix'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** The keys the bar takes, while it names them. */
export const BAR_KEYS = ['r', 'l']

const TITLES = { coverage: 'Coverage', labels: 'Labels', settings: 'thimble settings' } as const

/** Whether the side pane shows this kind now. */
async function paneShows($: Engine, kind: string): Promise<boolean> {
  if ((await paneNow($))?.kind !== kind) return false
  return (await $.ui.panes()).some(p => p.id === PANE_ID)
}

/** Coverage or the labels: open, or closed when the pane shows it. Coverage leaves the keys at the prompt, so the same
 *  key closes it; a click inside it presses its rows. The labels pane takes the keys (labels/pane.tsx). A pane a key
 *  opened that Claude Code did not place (a narrow terminal, core/pane.ts) is said in the bar, with the click that
 *  opens it. */
async function togglePane($: Engine, kind: 'coverage' | 'labels'): Promise<void> {
  if (await paneShows($, kind)) { await closePane($); return }
  if (kind === 'coverage') void recount($).catch(() => undefined)
  const placed = kind === 'labels' ? await openLabels($) : await openPane($, kind, {}, TITLES[kind])
  if (placed) await failCleared($, `pane:${kind}`)
  else noticeLine($, `Claude Code opens the ${kind} pane from a key only in a wider terminal. Click “${kind}” below to open it here.`, `pane:${kind}`)
}

/** The settings: they take the keys (tab walks the switches, ↵ turns one on or off, esc closes). */
export async function openSettings($: Engine): Promise<void> {
  if (!(await openPane($, 'settings', {}, TITLES.settings, { focus: true }))) noticeLine($, 'Claude Code did not open the settings pane here. Type /thimble-settings to open it.')
}

/** r or l at an empty prompt, while the bar names it: its pane opens or closes once the word window closed. */
export async function barKey($: Engine, k: string): Promise<{ later: () => Promise<unknown> } | null> {
  if (!BAR_KEYS.includes(k) || !(await barKeys($)).has(k)) return null
  return { later: () => togglePane($, k === 'r' ? 'coverage' : 'labels') }
}

export const registerBar: Register = on => {
  // the fixes as they stand: one still working shows in the bar, and its draft opens when it is written;
  // /thimble-settings
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const r = await next(e)
    void refreshFixes($).catch(() => undefined)
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

  // the end of a turn: the fixes again (a subagent may have worked on one); after main's, the counts
  on('turn.complete', { turnId: /./ }, async ($, e, next) => {
    const r = await next(e)
    void refreshFixes($).catch(() => undefined)
    if (e.agentId === undefined) {
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
