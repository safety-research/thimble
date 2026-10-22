// register.ts: cards. Claude writes rows as a JSON file and calls the `card` tool with the file and a short view; the
// plugin runs the view in its runner, draws the card under the call (or under the answer v was pressed on), takes the
// cards' keys at an empty prompt, and gives Claude a text copy of what it drew.
//
//   tool.ts      the card tool: one call draws a card, or a new version of one, and answers its text copy
//   runner.mjs   the runner, one Node process per session: each card's view in a sandbox, its state and handlers
//   ask.ts       the runner from the hooks: started when first needed, again when it stopped
//   layout.js    a tree laid out on a grid of cells: the text copy
//   client.tsx   the one Client module that draws a card's tree in the terminal
//   draw.ts      the frame, the drawing at the screen's width, the person's keys, clicks and search
//   store.ts     each card in $.state and on disk, for a resumed session
//
// With the Cards switch off (featureOn('cards')), no tool is registered and nothing is drawn.
import type { Register } from 'claude-code'

import { failNotice } from '../bar/fix'
import { featureOn } from '../settings/features.mjs'
import { WORD_MS } from '../bar/register'
import { cardKey, cardPost, clientFault, frame, framesUnder, keepSearch, keyOwner, noteShown, noteViewport, searchRestored, searchTyped, undoKeys } from './draw'
import { callOf, cardIdOf, metaOf, restoreCards, searchNow } from './store'
import { cardCall, registerCardTool } from './tool'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const cut = (s: string, n: number) => ([...s].length <= n ? s : `${[...s].slice(0, n - 1).join('')}…`)
// the keys cards took since the person last typed into the box, in the order pressed
let taken = ''
// the keys cards took within WORD_MS of each other, the last at `at`: a letter typed within WORD_MS after them means
// the person types a word that starts with them
let word: { at: number; keys: { key: string; id: string }[] } | null = null

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
        : `${call.version > 1 ? `version ${call.version} · ` : ''}${call.rows ?? meta.rows} row${(call.rows ?? meta.rows) === 1 ? '' : 's'} from ${(call.file ?? meta.file).split('/').pop()}`
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

  // keys at an empty prompt reach the card on screen that takes them (v and the failure line's keys come first). Keys
  // that come quickly arrive as one edit with several letters: when each is a card's key, each goes to its card in
  // turn. Claude Code makes an edit from the box as it would be with the keys still waiting for an answer typed into
  // it, and asks the hooks once those answers came: so a box that holds only keys the cards took (the last of them) is
  // empty too. A key the cards do not take, typed within WORD_MS after keys they took, means the person types a word
  // that starts with those keys: the cards undo them, and the word goes into the box whole. While a `/` search is
  // typed, what the prompt box holds is the search.
  on('prompt.edit', { origin: { kind: /^composer$/ } }, async ($, e, next) => {
    if (!featureOn('cards')) return next(e)
    const search = await searchNow($)
    if (search && !search.kept) {
      const r = await next(e)
      await searchTyped($, r.text)
      return r.text ? { ...r, decorations: [...(r.decorations ?? []), { start: 0, end: 0, virtualText: 'search: ', dimColor: true }] } : r
    }
    if (e.text !== '' && !(taken && taken.endsWith(e.text))) { taken = ''; word = null; return next(e) }
    const now = Number(await $.clock.now())
    const k = e.key
    // what the person typed after keys a card took goes in an empty box, or, typed straight after them, with them
    const typed = async () => {
      const w = word
      taken = ''
      word = null
      if (w && e.inputText && !k?.ctrl && !k?.meta && now - w.at < WORD_MS) {
        await undoKeys($, w.keys.map(x => x.id))
        const text = w.keys.map(x => x.key).join('') + e.inputText
        return { text, cursor: text.length }
      }
      return next(e.text ? { ...e, text: '', cursor: 0, start: 0, end: 0 } : e)
    }
    if (k && (k.ctrl || k.meta || [...k.key].length !== 1)) return typed()
    const keys = k ? [k.key] : [...e.inputText]
    if (!keys.length || (keys.length > 1 && keys.includes('/'))) return typed()
    for (const key of keys) if (!(await keyOwner($, key))) return typed()
    taken = (taken + keys.join('')).slice(-64)
    const got: { key: string; id: string }[] = []
    for (const key of keys) {
      const id = await cardKey($, key)
      if (id && key !== '/') got.push({ key, id })
    }
    word = keys.includes('/') ? null : { at: now, keys: [...(word && now - word.at < WORD_MS ? word.keys : []), ...got] }
    return { text: '', cursor: 0 }
  }).catch(($, e, next) => next(e))

  // Enter while a search is typed keeps the search on the card and sends nothing; Claude Code then puts the words back
  // in the box, and they are cleared there
  on('prompt.submit', { origin: { kind: 'composer' } }, async ($, e, next) => {
    const search = await searchNow($)
    if (!search || search.kept || e.command || !featureOn('cards') || e.text !== search.text) return next(e)
    return { drop: await keepSearch($) }
  }).catch(($, e, next) => next(e))

  on('prompt.change', { origin: { kind: 'engine' } }, async ($, e, next) => {
    const r = await next(e)
    await searchRestored($, e.text)
    return r
  }).catch(($, e, next) => next(e))
}
