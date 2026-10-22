// register.ts: cards. Claude writes rows as a JSON file and calls the `card` tool with the file and a short view; the
// plugin runs the view in its runner, draws the card under the call (or under the answer v was pressed on), and gives
// Claude a text copy of what it drew. The cards' keys at an empty prompt reach them through hooks/keys.ts.
//
//   tool.ts      the card tool: one call draws a card, or a new version of one, and answers its text copy
//   runner.mjs   the runner, one Node process per session: each card's view in a sandbox, its state and handlers
//   argv.mjs     the command that starts the runner
//   ask.ts       the runner from the hooks: started when first needed, again when it stopped
//   layout.js    a tree laid out on a grid of cells: the text copy
//   client.tsx   the one Client module that draws a card's tree in the terminal
//   draw.ts      the frame, the drawing at the screen's width, the person's keys and clicks
//   store.ts     each card in $.state and on disk, for a resumed session
//
// With the Cards switch off (featureOn('cards')), no tool is registered and nothing is drawn.
import type { Register } from 'claude-code'

import { failNotice } from '../bar/fix'
import { cut } from '../core/text.js'
import { featureOn } from '../settings/features.mjs'
import { cardPost, clientFault, frame, framesUnder, noteShown, noteViewport } from './draw'
import { callOf, cardIdOf, metaOf, restoreCards } from './store'
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
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__thimble__card' }, async ($, e) => {
    if (!featureOn('cards')) return { deny: 'Cards are off in thimble\'s settings (/thimble-settings).' }
    return cardCall($, e)
  }).catch(() => ({ result: 'The card did not draw: thimble failed while it drew the card. Call card again; if it fails again, tell the analyst that cards do not work here.' }))

  // the call's row: the call in short (the view's code only in ctrl+o), then the card under the call that drew its
  // version on screen; an earlier call's result line says where the card stands now
  on('ui.render', { component: 'ToolUse', props: { tool: 'mcp__thimble__card' } }, async ($, e, next) => {
    noteViewport(e.viewport)
    if (!featureOn('cards')) return next(e)
    const input = (e.props.input ?? {}) as Any
    const own = e.props.isExpanded ? await next(e) : await next({ ...e, props: { ...e.props, input: { title: String(input.title ?? ''), data: String(input.data ?? '') } } })
    const id = (await callOf($, e.props.tool_use_id)) ?? (input.id ? String(input.id) : cardIdOf(e.props.tool_use_id))
    const meta = await metaOf($, id)
    if (!meta || meta.version < 1) return own
    if (meta.anchorRow || meta.toolUseId !== e.props.tool_use_id) return own
    const E = $.ui.resolve(e) as Any
    noteShown($, [meta.id], e.props.onScreen)
    return E.Box({ flexDirection: 'column', children: [own, await frame($, e, meta, null)] })
  }).catch(($, e, next) => next(e))

  // the call's result: the person reads the card, not the text copy Claude got; one line in its place: what the card
  // read, or, for a call whose version a newer one replaced, where the card stands now
  on('ui.render', { component: 'ToolResult', props: { tool: 'mcp__thimble__card' } }, async ($, e, next) => {
    if (!featureOn('cards') || e.props.isExpanded) return next(e)
    const id = await callOf($, e.props.tool_use_id)
    const meta = id ? await metaOf($, id) : null
    const call = meta?.calls[e.props.tool_use_id]
    if (!meta || !call) return next(e)
    const moved = !call.error && meta.version > 0 && (meta.anchorRow || meta.toolUseId !== e.props.tool_use_id)
    const line = call.error
      ? `did not draw: ${call.error.slice(0, 160)} · Claude got the error`
      : moved
        ? `↓ version ${call.version} · “${cut(meta.title, 60)}” is drawn ${meta.anchorRow ? 'under the answer v was pressed on' : 'further down'}, as version ${meta.version}`
        : `${call.version > 1 ? `version ${call.version} · ` : ''}${call.read ?? meta.read ?? ''} from ${(call.file ?? meta.file).split('/').pop()}`
    return next({ ...e, props: { ...e.props, output: line } })
  }).catch(($, e, next) => next(e))

  // the cards the designer fork drew under this answer, below it (outside the marks' drawing of the answer)
  on('ui.render', { component: 'AssistantMessage', requestId: /./ }, async ($, e, next) => {
    noteViewport(e.viewport)
    const r = await next(e)
    if (!featureOn('cards')) return r
    const frames = await framesUnder($, e)
    if (!frames.length) return r
    const E = $.ui.resolve(e) as Any
    return E.Box({ flexDirection: 'column', children: [r, ...frames] })
  }).catch(($, e, next) => next(e))

  // a card's Client posted: a Button or a click
  on('ui.message', { element: /^card-c[0-9a-f]+$/ }, async ($, e) => cardPost($, String(e.element).slice(5), e.data))
    .catch(() => ({}))

  // a card's Client failed on screen: the card says why where it stood
  on('ui.fault', { element: /^card-c[0-9a-f]+$/ }, async ($, e, next) => {
    await clientFault($, String(e.element).slice(5), String(e.reason ?? ''))
    return next(e)
  }).catch(($, e, next) => next(e))
}
