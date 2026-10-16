// The band above the prompt (term-panel lane, build spec 3.8): a panel Claude Code left undrawn and its `open panel`,
// the view proposal waiting for the analyst's answer, every agent's open notices, and what is new in the workspace
// since home was last opened (`open ›`, `dismiss`). 0.9.0's summary line replaces that last row here.
//
// The AbovePrompt hook as 0.8.0's register.tsx had it, moved here unchanged; register.tsx calls registerBand once. The
// hook builds its context from its own `$` with register.tsx's cxOf, imported by name (Claude Code follows `$` only into
// functions declared in or imported into the file). Nothing here runs at import.
import type { On, RenderElement } from 'claude-code'

import { COLORS } from './paint'
import { answerOffer, dismissNotice, homeNotices, homeOffer, noticeAct, openHomeNew, openNoticeChat, proposalsOff } from './panel'
import { cxOf } from './register'
import { PANEL, closePanel, openPending, placedLater, retryPending, rt, seeHome } from './term'

const ABOVE_LABEL = 16

/** The band's hook (ui.render, AbovePrompt). */
export function registerBand(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!rt.sc || e.props.hasSurvey || e.props.view.agentId) return next(e)
    const cx = cxOf($)
    const panes = await cx.panes()
    if (e.surface === 'terminal' && e.viewport?.columns && !panes.some(p => p.isPlaced)) rt.termColumns = e.viewport.columns
    const { Box, Text, Button } = $.ui.resolve(e)
    const rows: RenderElement[] = []
    const label = (s: string, color?: string) => (
      <Box width={ABOVE_LABEL} flexShrink={0}>
        {color ? <Text color={color}>{`  ${s}`}</Text> : <Text dimColor>{`  ${s}`}</Text>}
      </Box>
    )
    // a row under a row's label: the label's width left empty
    const under = (key: string, child: RenderElement) => (
      <Box key={key} flexDirection="row">
        {label('')}
        <Box flexShrink={1}>{child}</Box>
      </Box>
    )
    // a panel Claude Code left undrawn (an open it was not asked for, on a terminal narrower than it places those at),
    // and why; `open panel` opens it as `/thimble` does, from the press, which Claude Code places at any width. Gone
    // once the pane is drawn (Claude Code places it when the terminal is widened to that width)
    const pending = await cx.pending()
    const placed = panes.some(p => p.id === PANEL && p.isPlaced)
    if (pending && placed) $.clock.after(0, () => void placedLater(cx))
    if (pending && !placed) {
      const columns = (e.surface === 'terminal' ? e.viewport?.columns : 0) || pending.columns || 0
      const more = pending.floor && columns ? pending.floor - columns : 0
      if (pending.floor && columns && more <= 0) $.clock.after(0, () => void retryPending(cx, columns))
      rows.push(
        <Box key="above-panel" flexDirection="row">
          {label('panel')}
          <Box flexDirection="row" columnGap={2} flexShrink={1}>
            <Box flexShrink={1}>
              <Text wrap="truncate-end">{`${pending.title} is ready`}</Text>
            </Box>
            <Box flexDirection="row" columnGap={2} flexShrink={0}>
              <Button key="above-panel-open" label="open panel" plain onPress={() => openPending(cx)} />
              <Button key="above-panel-dismiss" label="dismiss" plain onPress={() => closePanel(cx)} />
            </Box>
          </Box>
        </Box>,
      )
    }
    // the view proposal waiting for the analyst's answer (proposer.py, or a viewer for a file type), until it is answered
    // and whatever the panel shows: `view proposal` in the accent, its name in bold, what it would show (for a viewer of
    // a file type, then its files) wrapped whole, never behind a press, and not the task it names; `accept`, `reject` and
    // `don't ask again`, which turns view proposals off; why accept could not start its build, in red, under them
    // (SPEC.md, "Main's chat")
    const offer = await homeOffer(cx)
    if (offer) {
      const accept = () => answerOffer(cx, offer.slug, 'accept')
      const reject = () => answerOffer(cx, offer.slug, 'reject')
      rows.push(
        <Box key="above-offer" flexDirection="row">
          {label('view proposal', COLORS.accent)}
          <Box flexDirection="row" columnGap={2} flexShrink={1}>
            <Box flexShrink={1}>
              <Text bold wrap="wrap">{offer.name}</Text>
            </Box>
            <Box flexDirection="row" columnGap={2} flexShrink={0}>
              {offer.pressed
                ? [<Text key="above-offer-pressed" dimColor>{offer.pressed === 'accept' ? '◌ accepting' : '◌ rejecting'}</Text>]
                : [
                    <Button key="above-offer-accept" label="accept" plain onPress={accept} />,
                    <Button key="above-offer-reject" label="reject" plain onPress={reject} />,
                    <Button key="above-offer-off" label="don't ask again" plain onPress={() => proposalsOff(cx)} />,
                  ]}
            </Box>
          </Box>
        </Box>,
      )
      if (offer.description) rows.push(under('above-offer-description', <Text wrap="wrap">{offer.description}</Text>))
      if (!offer.task && offer.claims.length) rows.push(under('above-offer-files', <Text wrap="wrap"><Text dimColor>{'files  '}</Text>{offer.claims.join(', ')}</Text>))
      if (offer.refused && !offer.pressed) rows.push(under('above-offer-refused', <Text color={COLORS.problem} wrap="wrap">{offer.refused}</Text>))
    }
    // every agent's open notices, newest first, under the view proposal's place: a failure with its fix (a safeguard's
    // block or switch of model, an API error, an agent that ended failed or was refused, a view build, a check or label
    // run, the view proposer), since Claude Code's own output shows only main's requests. `notice` dim, then its words
    // in red, which name the agent and the failure, wrapped whole; then the acts that fix it, `open ›` to the agent's
    // thread, `dismiss` (SPEC.md, "Main's chat")
    for (const n of await homeNotices(cx)) {
      rows.push(
        <Box key={`above-notice-${n.id}`} flexDirection="row">
          {label('notice')}
          <Box flexDirection="row" columnGap={2} flexShrink={1}>
            <Box flexShrink={1}>
              <Text color={COLORS.problem} wrap="wrap">{n.text}</Text>
            </Box>
            <Box flexDirection="row" columnGap={2} flexShrink={0}>
              {n.acts.map((a, i) => (
                <Button key={`above-notice-${n.id}-act-${i}`} label={a.label} plain onPress={() => noticeAct(cx, n, a)} />
              ))}
              {n.open ? <Button key={`above-notice-${n.id}-open`} label="open ›" plain onPress={() => openNoticeChat(cx, n)} /> : null}
              <Button key={`above-notice-${n.id}-dismiss`} label="dismiss" plain onPress={() => dismissNotice(cx, n)} />
            </Box>
          </Box>
        </Box>,
      )
    }
    // what is new in the workspace since home was last opened, like a toast: open › opens home on the first new item
    // and the row goes; dismiss marks what is there seen, as opening home does, and opens nothing; none while home
    // shows (live check term-fix8, quirk 6: it stayed beside home, which showed them)
    const home = await cx.home()
    const homeShown = (await cx.panel())?.view === 'home' && panes.some(p => p.id === PANEL && p.isPlaced)
    if (home && !homeShown) {
      // the first count of a session (refreshHome keeps it) is what was there already, so nothing is new yet
      const seen = (await cx.homeSeen()) ?? home
      const fresh = (k: 'cards' | 'labels' | 'docs' | 'views') => Math.max(0, home[k] - (seen as typeof home)[k])
      const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} new ${w}${n === 1 ? '' : 's'}`
      const words = [fresh('cards') ? plural(fresh('cards'), 'card') : '', fresh('labels') ? plural(fresh('labels'), 'label') : '', fresh('docs') ? plural(fresh('docs'), 'document') : '', fresh('views') ? plural(fresh('views'), 'view') : ''].filter(Boolean).join(' · ')
      if (words) {
        rows.push(
          <Box key="above-home" flexDirection="row">
            {label('thimble')}
            <Box flexDirection="row" columnGap={2} flexShrink={1}>
              {/* the word `new` in green, as wherever it shows (SPEC.md, rule 8) */}
              <Text wrap="truncate-end">{words.split(/( new )/).map((w, i) => (w === ' new ' ? <Text key={`new-${i}`}>{' '}<Text color={COLORS.fresh}>new</Text>{' '}</Text> : w))}</Text>
              <Button key="above-home-open" label="open ›" plain onPress={() => openHomeNew(cx)} />
              <Button key="above-home-dismiss" label="dismiss" plain onPress={() => seeHome(cx, home)} />
            </Box>
          </Box>,
        )
      }
    }
    // side threads show as `↳ thread` rows under main's latest row and as `N new` on the panel's title row (SPEC.md,
    // "Main's chat"): no row of their own here
    if (!rows.length) return next(e)
    return <Box flexDirection="column">{rows}</Box>
  })
}
