// The waiting view (bug hunt F1). Claude Code's main screen (the classic renderer, where a fresh config starts) takes no
// clicks, so nothing above the prompt can be pressed there: not the view proposal's acts, a notice's, the SSH row's
// `copy link`, nor the thimble line's items. There home lists those rows first, under `Above the prompt` (home.ts), and
// Enter on one opens it here, with its acts on digit keys:
//
//   home › view proposal                                                                     ↗
//   Page Histories
//   Each wiki page as a strip of its saves over time, colored by the author
//   ──────────────────────────────────────────────────────────────────────────────────────────
//   1 accept   2 reject   3 don't ask again   4 dismiss
//   1–4 to press · b to go back · x to close
//
// A digit presses its act as a click on the band's would. An act that answers the row (accept, dismiss) goes back to
// home; a copy stays (the SSH row's `copy` and `copy link`, which copies a one-time link it never draws); an act that
// opens another view (`see the orientation ›`) shows that view. A row answered meanwhile says that nothing waits there.
// `/thimble browser` and the panel's `o` open the SSH row here at once on the main screen (offramp.ts). In fullscreen
// the band takes clicks, and home lists none of this.
import type { RenderElement } from 'claude-code'

import type { TermPanel } from './types'
import { waitItems } from './band'
import type { BandAct } from './band'
import type { Ctx } from './ctx'
import { COLORS } from './paint'
import type { PaneEvent } from './panel'
import { bottomRows, drawsView, hiddenKeys, none } from './panel'
import { navBack } from './term'

/** An act pressed from its key: what the band's press does; then, unless it keeps the row (`stay`) or opened another
 *  view, back to home. */
async function pressAct(cx: Ctx, key: string, a: BandAct): Promise<void> {
  await a.press?.()
  if (a.stay) return
  const p = await cx.panel()
  if (p?.view !== 'waiting' || p.slug !== key) return
  await navBack(cx)
}

/** The keys' hint: `1 to press`, or `1–4 to press`. */
export function pressHint(n: number): string {
  return n === 1 ? '1 to press' : `1–${n} to press`
}

async function drawWaiting(cx: Ctx, e: PaneEvent, p: TermPanel): Promise<RenderElement> {
  const els = cx.els(e)
  const { Box, Text, Button } = els
  const cols = Math.max(30, e.props.bodyColumns)
  const key = p.slug ?? ''
  const it = (await waitItems(cx)).find(x => x.key === key)
  if (!it) return <Box flexDirection="column">{[none(cx, e, 'nothing waits here now'), ...bottomRows(cx, e, cols, [], [], [])]}</Box>
  const body: RenderElement[] = []
  if (it.name) body.push(<Text key="wait-name" bold wrap="wrap">{it.name}</Text>)
  if (it.words) body.push(<Text key="wait-words" wrap="wrap">{it.words}</Text>)
  if (it.problem) body.push(<Text key="wait-problem" color={COLORS.problem} wrap="wrap">{it.problem}</Text>)
  // the acts with their digits, in the band's order; a state in their place (`◌ accepting`) dim, with no key
  const pressable = it.acts.filter(a => a.press)
  const controls = it.acts.map(a => {
    const n = pressable.indexOf(a) + 1
    if (!n) return <Text key={`wait-${a.key}`} dimColor>{a.label}</Text>
    return (
      <Button key={`wait-${a.key}`} plain onPress={() => void pressAct(cx, key, a)}>
        <Text color={COLORS.accent}>{`${n} `}</Text>
        <Text {...(a.primary ? { bold: true } : {})}>{a.label}</Text>
      </Button>
    )
  })
  const keys = hiddenKeys(cx, e, pressable.slice(0, 9).map((a, i) => ({ key: `wait-${i + 1}`, hotkey: String(i + 1), onPress: () => void pressAct(cx, key, a) })))
  body.push(...bottomRows(cx, e, cols, controls, [], pressable.length ? [pressHint(Math.min(9, pressable.length))] : []))
  return <Box flexDirection="column">{[...(keys ? [keys] : []), ...body]}</Box>
}

/** The waiting view's drawing registered with the panel (views.ts registerPanelViews). */
export function registerWaitingView(): void {
  drawsView('waiting', drawWaiting)
}
