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
import { forkOf } from '../core/forks'
import { featureOn } from '../settings/features.mjs'
import { cardPost, clientFault, frame, framesUnder, noteShown, noteTurn, noteViewport } from './draw'
import { callOf, cardIdOf, inTemp, metaOf, restoreCards } from './store'
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

  on('turn.start', { turnId: /\S/ }, async ($, e, next) => {
    if (e.agentId === undefined) noteTurn(e.turnId)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__thimble__card' }, async ($, e) => {
    if (!featureOn('cards')) return { deny: 'Cards are off in thimble\'s settings (/thimble-settings).' }
    return cardCall($, e)
  }).catch(() => ({ result: 'The card did not draw: thimble failed while it drew the card. Call card again; if it fails again, tell the analyst that cards do not work here.' }))

  // the rows of a card: thimble asks Claude to write them in the temp folder ($TMPDIR), which is outside the working
  // folder, so Claude Code would ask the person before Claude reads them back. A read there needs no dialog; so does a
  // write by v's fork, which works in the background, where a dialog would stop it until the person answers. Only an
  // ask that the mode makes is let through: a rule or a hook of the person's still decides
  on('tool.check', { tool: /^(Read|Grep|Glob|Write|Edit)$/ }, async ($, e, next) => {
    const v = await next(e)
    if (v.decision !== 'ask' || v.rule || v.hook || v.plugin || !featureOn('cards')) return v
    if ((e.tool === 'Write' || e.tool === 'Edit') && forkOf(e.agentId)?.kind !== 'designer') return v
    const input = (e.input ?? {}) as { file_path?: unknown; path?: unknown }
    return (await inTemp($, input.file_path ?? input.path)) ? { decision: 'allow' } : v
  }).catch(($, e, next) => next(e))

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
    if (meta.anchorRow || meta.toolUseId !== e.props.tool_use_id) return own
    const E = $.ui.resolve(e) as Any
    noteShown($, [meta.id], e.props.onScreen)
    return E.Box({ flexDirection: 'column', children: [own, await frame($, e, meta, null)] })
  }).catch(($, e, next) => next(e))

  // the call's result: the person reads the card, not the text copy Claude got; one line in its place: what the card
  // read, or, for a call that drew a version elsewhere (in the card's place), where the card stands
  on('ui.render', { component: 'ToolResult', props: { tool: 'mcp__thimble__card' } }, async ($, e, next) => {
    if (!featureOn('cards') || e.props.isExpanded) return next(e)
    const id = await callOf($, e.props.tool_use_id)
    const meta = id ? await metaOf($, id) : null
    const call = meta?.calls[e.props.tool_use_id]
    if (!meta || !call) return next(e)
    const away = meta.anchorRow || meta.toolUseId !== e.props.tool_use_id
    // the card stands at a later call when the screen could not draw it again in its place (canRedraw)
    const order = Object.keys(meta.calls)
    const below = !meta.anchorRow && order.indexOf(meta.toolUseId) > order.indexOf(e.props.tool_use_id)
    const now = call.version < meta.version ? `, now version ${meta.version}` : ''
    const line = call.error
      ? `did not draw: ${call.error.slice(0, 160)} · Claude got the error`
      : !away
        ? `${meta.version > 1 ? `version ${meta.version} · ` : ''}${meta.read} from ${meta.file.split('/').pop()}`
        : below
          ? `↓ version ${call.version} · “${cut(meta.title, 60)}” is drawn further down${now}`
          : `↑ version ${call.version} · “${cut(meta.title, 60)}” is drawn in its place ${meta.anchorRow ? 'under the answer v was pressed on' : 'above'}${now}`
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
