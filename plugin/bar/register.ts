// register.ts: the bar above the prompt, and its panes.
//
//   registerBar  the bar (bar.tsx) in the AbovePrompt band, under what the features put above it (core/answerview.ts
//                aboveBar). /thimble-settings and a click on `thimble` open the
//                settings; the person's next prompt takes the failure line and the line at the first session's start (intro.ts); the counts at each load of the plugin and
//                after each of main's turns (counts.ts)
//   barKey       r and l at an empty prompt (hooks/keys.ts asks), while the bar names them: coverage and the labels.
//                Each pane takes the keys its key row names (coverage's j k ↵, the labels' number keys that check
//                records), and esc closes it; coverage's r close is a click, so an r typed in it reaches the prompt,
//                where it only closes the pane, if it still shows once the word window closed
//   barPaneClosed  the side pane closed (core/pane.ts): the next r or l opens its pane, though the bar has not drawn
//                since
import type { EngineInterface, Register } from 'claude-code'

import { aboveBar, bandDrawn } from '../core/answerview'
import { closePane, narrowNotice, openPane, paneNow, paneShows } from '../core/pane'
import { treeRows } from '../core/trail.mjs'
import { openLabels } from '../labels/pane'
import { barKeys, barRows, type BarPresses } from './bar'
import { countsNow, needCounts, recount } from './counts'
import { clicksReach, introDone, introHint } from './intro'
import { remindAfterAnswer } from './hints'
import { failNotice, promptTyped } from './notice'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** The keys the bar takes, while it names them. */
export const BAR_KEYS = ['r', 'l']

const TITLES = { coverage: 'Coverage', labels: 'Labels', settings: 'thimble settings' } as const

/** Which pane the side pane showed as the bar last drew: r or l typed while its own pane shows means to close it.
 *  Kept in memory, so the key reads no state. */
let drawnPane: string | null = null

/** The side pane closed (esc or its close mark, core/pane.ts), which may draw the bar no more: an r or l then opens
 *  its pane again. */
export function barPaneClosed(): void {
  drawnPane = null
}

/** Coverage or the labels: open, or closed when the pane shows it. Each takes the keys, so the keys its key row names
 *  act in it, not in the prompt (coverage.tsx, labels/pane.tsx), and esc closes it. A pane a key opened that
 *  Claude Code did not place (a narrow terminal, core/pane.ts) is said in the bar (core/pane.ts narrowNotice). */
async function togglePane($: Engine, kind: 'coverage' | 'labels', byKey = false): Promise<void> {
  if (await paneShows($, kind)) { await closePane($); return }
  if (kind === 'coverage') void recount($).catch(() => undefined)
  const placed = kind === 'labels' ? await openLabels($) : await openPane($, kind, {}, TITLES[kind], { focus: true })
  if (placed) return
  const name = TITLES[kind]
  if (!byKey) { failNotice($, `Claude Code did not open the ${name} pane here.`, `pane:${kind}`); return }
  // the words the bar shows for it, which a click opens
  const n = (await countsNow($))?.labels ?? 0
  const shown = kind === 'labels' ? `${n.toLocaleString('en-US')} label${n === 1 ? '' : 's'}` : 'coverage'
  const key = kind === 'labels' ? 'l' : 'r'
  failNotice($, narrowNotice(key, `${key} ${shown}`), `pane:${kind}`)
}

/** The settings: they take the keys (tab walks the switches, ↵ turns one on or off, esc closes). */
export async function openSettings($: Engine): Promise<void> {
  if (!(await openPane($, 'settings', {}, TITLES.settings, { focus: true }))) failNotice($, 'Claude Code did not open the settings here. Type /thimble-settings to open them.', 'pane:settings')
}

/** r or l at an empty prompt, while the bar names it: its pane opens or closes once the word window closed. Typed while
 *  its pane shows (in the pane, which leaves the key to the prompt), it closes the pane if esc or a click has not closed
 *  it within the window, and never opens it again (as w does the claims', claims/seam.ts). */
export async function barKey($: Engine, k: string): Promise<{ later: () => Promise<unknown> } | null> {
  if (!BAR_KEYS.includes(k) || !(await barKeys($)).has(k)) return null
  const kind = k === 'r' ? 'coverage' : 'labels'
  const close = drawnPane === kind
  return { later: async () => (close ? (await paneShows($, kind).catch(() => false)) && closePane($) : togglePane($, kind, true)) }
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
      // one reminder of a feature asked for on demand that the session has not used yet (hints.ts)
      $.clock.after(0, () => { void remindAfterAnswer($).catch(() => undefined) })
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
      const shows = (await paneNow($).catch(() => null))?.kind ?? null
      drawnPane = shows && (await paneShows($, shows).catch(() => false)) ? shows : null
      const width = Math.max(20, e.props.bodyColumns)
      // the hint at the first session's start that says where the settings are (intro.ts), in the bar: the click on
      // `thimble`, or the command where no click reaches it
      const intro = await introHint($, await clicksReach($, e).catch(() => true)).catch(() => null)
      const rows = await barRows($, els, width, { presses, ...(intro ? { intro } : {}) })
      // what the features put above the bar (the tray), then a blank row and the bar. Claude Code shows the band whole
      // while it has at most maxRows rows, and a taller one in a window of maxRows − 1 rows that its wheel scrolls, its
      // own row under the window counting the rest: a tray taller than the rows over the bar takes that window, and the
      // bar follows below it (the bar's rows as drawn: a failure line or a hint wraps)
      const maxRows = Number(e.props.maxRows)
      const above = await aboveBar($, els, width, maxRows > 0 ? { rows: maxRows - 1, at: Number(e.props.scroll?.offset) || 0, id: String(e.requestId) } : null)
      // a blank row above it too while all of it fits with the bar
      const gap = above.length > 0 && !(maxRows > 0 && treeRows(above, width) + treeRows(rows, width) + 2 > maxRows)
      const band = els.Box({ flexDirection: 'column', children: [...(gap ? [els.Text({ key: 'above-gap', children: ' ' })] : []), ...above, els.Text({ key: 'gap', children: ' ' }), ...rows] })
      // the rows the band takes on the screen, which the transcript's window gives way to
      bandDrawn(maxRows > 0 ? Math.min(maxRows, treeRows(band, width)) : treeRows(band, width))
      return band
    } catch {
      // a drawing that throws is drawn as Claude Code draws it: the person never sees the error itself
      return next(e)
    }
  })
}
