// register.ts: the bar above the prompt, and its panes.
//
//   registerBar  the bar (bar.tsx) in the AbovePrompt band, under what the features put above it (core/answerview.ts
//                aboveBar). /thimble-settings and a click on `thimble` open the
//                settings; the person's next prompt takes the failure line and the line at the session's start (intro.ts); the counts at each load of the plugin and
//                after each of main's turns (counts.ts)
//   barKey       r and l at an empty prompt (hooks/keys.ts asks), while the bar names them: coverage and the labels.
//                Each pane takes the keys its key row names (coverage's j k ↵ and r, the labels' number keys that
//                check records), and esc closes it
import type { EngineInterface, Register } from 'claude-code'

import { aboveBar } from '../core/answerview'
import { closePane, openPane, paneNow, PANE_ID } from '../core/pane'
import { openLabels } from '../labels/pane'
import { barKeys, barRows, type BarPresses } from './bar'
import { countsNow, needCounts, recount } from './counts'
import { introDone, introRow } from './intro'
import { noticeLine, promptTyped } from './notice'

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

/** Coverage or the labels: open, or closed when the pane shows it. Each takes the keys, so the keys its key row names
 *  act in it, not in the prompt (coverage.tsx, labels/pane.tsx), and esc closes it. A pane a key opened that
 *  Claude Code did not place (a narrow terminal, core/pane.ts) is said in the bar, with the click that opens it. */
async function togglePane($: Engine, kind: 'coverage' | 'labels'): Promise<void> {
  if (await paneShows($, kind)) { await closePane($); return }
  if (kind === 'coverage') void recount($).catch(() => undefined)
  const placed = kind === 'labels' ? await openLabels($) : await openPane($, kind, {}, TITLES[kind], { focus: true })
  if (!placed) {
    // the words the bar shows for it, which a click opens
    const n = (await countsNow($))?.labels ?? 0
    const shown = kind === 'labels' ? `${n.toLocaleString('en-US')} label${n === 1 ? '' : 's'}` : 'coverage'
    noticeLine($, `Claude Code opens the ${kind} pane from a key only in a wider terminal. Click “${shown}” in the bar below to open it here.`, `pane:${kind}`)
  }
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
  // /thimble-settings, and the counts of this load (a new or resumed session, a reload, a switch turned on)
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const r = await next(e)
    needCounts($)
    try {
      await $.command.register({ name: 'thimble-settings', description: "thimble's settings: turn citations, cards, and the bar's coverage and labels on or off", immediate: true })
    } catch {
      // a click on `thimble` in the bar still opens them
    }
    return r
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'thimble-settings' }, async $ => {
    await openSettings($)
    return {}
  })

  // the end of main's turn: the counts
  on('turn.complete', { turnId: /./ }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      $.clock.after(0, () => { void recount($).catch(() => undefined) })
    }
    return r
  }).catch(($, e, next) => next(e))

  // the person's own prompt: the failure line goes
  on('prompt.submit', { origin: { kind: /^(?:composer|bridge)$/ } }, async ($, e, next) => {
    if (!e.command) await promptTyped($).catch(() => undefined)
    await introDone($).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      if (e.props.hasSurvey) return next(e)
      const els = $.ui.resolve(e) as Any
      const presses: BarPresses = { settings: () => openSettings($), pane: kind => togglePane($, kind) }
      const width = Math.max(20, e.props.bodyColumns)
      // the line at a session's start that says what the keys do (intro.ts), right above the bar
      const intro = await introRow($, els, presses).catch(() => null)
      const rows = [...(intro ? [intro] : []), ...(await barRows($, els, width, { presses }))]
      // what the features put above the bar (the tray, a label run's ask), a blank row above it, as above the bar
      // in the rows the band has left over the bar and the two blank rows, so a tall tray never pushes the bar off
      const room = Number(e.props.maxRows) > 0 ? Math.max(4, Number(e.props.maxRows) - rows.length - 2) : 0
      const above = await aboveBar($, els, width, room)
      return els.Box({ flexDirection: 'column', children: [...(above.length ? [els.Text({ key: 'above-gap', children: ' ' }), ...above] : []), els.Text({ key: 'gap', children: ' ' }), ...rows] })
    } catch {
      // a drawing that throws is drawn as Claude Code draws it: the person never sees the error itself
      return next(e)
    }
  })
}
