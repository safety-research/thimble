// register.ts: cards. Claude writes rows as a JSON file and calls the `card` tool with the file and a short view; the
// plugin runs the view in its runner, draws the card under the call (or under the answer v was pressed on), and gives
// Claude a text copy of what it drew. The cards' keys at an empty prompt reach them through hooks/keys.ts.
//
//   tool.ts      the card tool: one call draws a card, or a new version of one, and answers its text copy
//   runner.mjs   the runner, one Node process per session in Anthropic's sandbox runtime: each card's view in a context
//                of its own, its state and handlers
//   argv.mjs     the command that starts the runner, and the sandbox's rules for it
//   ask.ts       the runner from the hooks: started when first needed, again when it stopped; the sandbox, which
//                ../sandbox/setup.mjs installs at the first session start
//   layout.js    a tree laid out on a grid of cells: the text copy
//   client.tsx   the one Client module that draws a card's tree in the terminal
//   draw.ts      the frame, the drawing at the screen's width, the person's keys and clicks
//   store.ts     each card in $.state and on disk, for a resumed session
//
// With the Cards switch off (featureOn('cards')), no tool is registered and nothing is drawn.
import type { EngineInterface, Register } from 'claude-code'

import { failNotice } from '../bar/notice'
import { askOnce } from '../core/rowhook'
import { cut } from '../core/text.js'
import { featureOn } from '../settings/features.mjs'
import { sandbox, sandboxNotice, sandboxWhy, stopRunner } from './ask'
import { cardOfKey, cardPost, clientFault, firstWaits, frame, framesUnder, noteRun, noteShown, noteViewport, runFolded } from './draw'
import { cardRef } from '../marks/message.js'
import { callOf, cardIdOf, metaOf, restoreCards, saveMeta } from './store'
import { cardCall, registerCardTool } from './tool'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const registerCards: Register = on => {
  // the tool, and the cards this conversation drew before (a resumed session, a reload of the plugin)
  on('session.start', { cwd: /^(\/|[A-Za-z]:)/ }, async ($, e, next) => {
    const r = await next(e)
    if (!featureOn('cards')) return r
    try {
      await registerCardTool($)
    } catch (err) {
      try { failNotice($, `Cards are off for this session: thimble could not add its card tool (${String((err as Error)?.message || err).slice(0, 160)}).`) } catch { /* a session with no line above the prompt */ }
    }
    try { await restoreCards($) } catch { /* the cards draw again from their calls when their copies can be read */ }
    // the sandbox the cards run in: installed the first time (a plugin installed with `claude plugin install` alone ran
    // no setup of its own), checked at each session start, in the background; when it cannot work, the person reads
    // why and the fix now, and Claude reads it in the card tool's answer
    $.clock.after(0, () => {
      void sandbox($).then(s => { if (!s.ok) sandboxNotice($, `Cards cannot draw: ${sandboxWhy(s)}.`, !!s.fix) }).catch(() => undefined)
    })
    return r
  }).catch(($, e, next) => next(e))

  // the session ends: its runner stops, and the runner's folder (its socket) goes
  on('session.end', async ($, e, next) => {
    await stopRunner($).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__thimble__card' }, async ($, e) => {
    if (!featureOn('cards')) return { deny: 'Cards are off in thimble\'s settings (/thimble-settings).' }
    return cardCall($, e)
  }).catch(() => ({ result: 'The card did not draw: thimble failed while it drew the card. Call card again; if it fails again, tell the analyst that cards do not work here.' }))

  // the call's row: the call in short (the view's code only in ctrl+o), then the card under the call that drew its
  // first version; a later call's result line says where the card stands
  on('ui.render', { component: 'ToolUse', props: { tool: 'mcp__thimble__card' } }, async ($, e, next) => {
    noteViewport(e.viewport)
    if (!featureOn('cards')) return next(e)
    const input = (e.props.input ?? {}) as Any
    const id = (await callOf($, e.props.tool_use_id)) ?? (input.id ? String(input.id) : cardIdOf(e.props.tool_use_id))
    const meta = await metaOf($, id)
    const own = e.props.isExpanded ? await next(e) : await next({ ...e, props: { ...e.props, input: { title: String(input.title || meta?.title || ''), ...(input.data ? { data: String(input.data) } : {}) } } })
    if (!meta || meta.version < 1) return own
    if (meta.anchorRow || meta.inRow || meta.toolUseId !== e.props.tool_use_id) return own
    // drawn once the run of calls above has folded (draw.ts firstWaits), so the card does not jump up
    if (await firstWaits($, meta)) return own
    const E = $.ui.resolve(e) as Any
    noteShown($, [meta.id], e.props.onScreen)
    return E.Box({ flexDirection: 'column', children: [own, await frame($, e, meta)] })
  }).catch(($, e, next) => next(e))

  // the runs of calls Claude Code draws live, until they fold (draw.ts firstWaits); a step or the end of main's turn
  // folds them all
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    noteRun($, String(e.requestId ?? ''), !!e.props.isActive)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('turn.step', { turnId: /\S/ }, async function* ($, e, next) {
    if (e.agentId === undefined) {
      try { runFolded($, true) } catch { /* the step goes on */ }
    }
    return yield* next(e)
  })
  on('turn.complete', { turnId: /\S/ }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) runFolded($, true)
    return r
  }).catch(($, e, next) => next(e))

  // the call's result: the person reads the card, not the text copy Claude got; one line in its place: what the card
  // read (its version stands under the card's title), or, for a call that drew a version elsewhere (in the card's
  // place), where the card stands
  on('ui.render', { component: 'ToolResult', props: { tool: 'mcp__thimble__card' } }, async ($, e, next) => {
    if (!featureOn('cards') || e.props.isExpanded) return next(e)
    const id = await callOf($, e.props.tool_use_id)
    const meta = id ? await metaOf($, id) : null
    const call = meta?.calls[e.props.tool_use_id]
    if (!meta || !call) return next(e)
    const away = meta.anchorRow || meta.inRow || meta.toolUseId !== e.props.tool_use_id
    // the card stands at a later call when the screen could not draw it again in its place (canRedraw)
    const order = Object.keys(meta.calls)
    const below = !meta.anchorRow && order.indexOf(meta.toolUseId) > order.indexOf(e.props.tool_use_id)
    const now = call.version < meta.version ? `, now version ${meta.version}` : ''
    // an error of the view's is Claude's to fix, so it is cut to one line; why no card can draw (the sandbox) and its
    // fix are the person's, whole
    const line = call.error
      ? `did not draw: ${call.down ? call.error : cut(call.error, 160)} · Claude got the error`
      : !away
        ? `${meta.read} from ${meta.file.split('/').pop()}`
        : meta.inRow && !meta.anchorRow
          ? `↓ version ${call.version} · “${cut(meta.title, 60)}” is drawn in the answer${now}`
          : below
          ? `↓ version ${call.version} · “${cut(meta.title, 60)}” is drawn further down${now}`
          : `↑ version ${call.version} · “${cut(meta.title, 60)}” is drawn in its place ${meta.anchorRow ? 'under the answer v was pressed on' : 'above'}${now}`
    return next({ ...e, props: { ...e.props, output: line } })
  }).catch(($, e, next) => next(e))

  // a text row of main's that places cards on lines of their own (marks/message.js cardRef): each card draws there, and
  // no longer under its call
  on('session.append', { door: 'response' }, async ($, e, next) => {
    const stored = await next(e)
    try {
      const msg = e.message as { type?: string; content?: unknown }
      if (e.agentId !== undefined || msg.type !== 'assistant' || !featureOn('cards')) return stored
      const blocks = Array.isArray(msg.content) ? (msg.content as { type?: string; text?: string }[]) : []
      const text = blocks.filter(b => b.type === 'text').map(b => String(b.text || '')).join('\n')
      const row = String(stored?.uuid || e.uuid || '')
      if (row && text) await placeInRow($, row, text)
    } catch {
      // the row is stored whatever the cards make of it
    }
    return stored
  }).catch(($, e, next) => next(e))

  // the cards the designer fork drew under this answer, below it (outside the marks' drawing of the answer)
  // (fails safe, core/rowhook.ts: a throw here leaves the answer as drawn beneath)
  on('ui.render', { component: 'AssistantMessage', requestId: /./ }, async ($, e, next) => {
    const below = askOnce(e, next)
    try {
      noteViewport(e.viewport)
      const r = await below()
      if (!featureOn('cards')) return r
      const frames = await framesUnder($, e)
      if (!frames.length) return r
      const E = $.ui.resolve(e) as Any
      return E.Box({ flexDirection: 'column', children: [r, ...frames] })
    } catch {
      return below()
    }
  }).catch(($, e, next) => next(e))

  // a card's Client posted: a Button or a click
  on('ui.message', { element: /^card-c[0-9a-f]+(-\d+)?$/ }, async ($, e) => cardPost($, cardOfKey(String(e.element)).id, e.data, String(e.requestId ?? '')))
    .catch(() => ({}))

  // a card's Client failed on screen: the card says why where it stood
  on('ui.fault', { element: /^card-c[0-9a-f]+(-\d+)?$/ }, async ($, e, next) => {
    await clientFault($, String(e.element), String(e.reason ?? ''))
    return next(e)
  }).catch(($, e, next) => next(e))
}

/** The cards a text row of main's places on lines of their own: each draws in that row from now on. */
async function placeInRow($: EngineInterface, row: string, text: string): Promise<void> {
  for (const line of text.split('\n')) {
    const id = cardRef(line)
    const meta = id ? await metaOf($, id) : null
    if (meta && meta.version > 0 && !meta.anchorRow && meta.inRow !== row) await saveMeta($, { ...meta, inRow: row })
  }
}
