// The shell of lean thimble: it puts the kernel's objects in front of the person, in the terminal and the browser.
//
//   inline     when Claude saves an object (`lean save` in Bash), the object is drawn under the turn's last reply, in
//              cells (draw/term.js, draw/paint.js), with one quiet row under it: the 2-3 verbs picked for it, `? all`,
//              and the ways to open it. A click on a verb runs it; `open` opens the detail view.
//   detail     one pane, the object's detail view: the drawing with the selected region lit, the region's cite, its
//              source rows (`lean resolve`) and its examples, the object's citations when no region is selected, the
//              parts to select, and the verbs on keys. The chat stays live beside it: while it is open, a prompt
//              carries the object and the region to Claude, and the prompt's row says so.
//   verbs      found by folder (lean/verbs/<name>/, shell/node/registry.mjs) and run by /verb, a click or a key
//              (shell/node/verb.mjs); a verb's words and object show in the command's row.
//   browser    `open in browser` starts a server on 127.0.0.1 (shell/node/serve.mjs) and opens the object's page on
//              the same selection; the page's "back to terminal" brings its selection back to the detail view.
//
// What it never does: it registers no model tool (a plugin's tool skips the asks of Manual mode), starts no
// `claude`, and allows nothing on anyone's behalf. Everything it runs is the person's press or command, or a pure
// drawing of what Claude saved. The Node helpers run as child processes: a hooks module has no Node, and an
// object's program runs only in the drawing contract's sandbox.
import type { EngineInterface, Register } from 'claude-code'

import type { ObjRef, Ran, Sel } from '../types'
import { toHash } from '../draw/handoff.js'
import { renderTerm } from '../draw/term.js'
import { paintRegions, regionOfKey, selectable } from './cells'
import { chainWords, isRef, objectRefs, recordRefs, regionMeta, regionRefs } from './object.js'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
type Verb = { key: string | null; name: string; line: string; phrase: string | null; picked: boolean; extra?: Record<string, unknown> }
type Prepared = { object: Any; drawing: Any; grid: Any; verbs: Verb[]; problems: string[]; error?: string }

export const PANE = 'object'
const UNDER = { plugin: 'thimble-lean', key: 'under' } as const
const SEL = { plugin: 'thimble-lean', key: 'sel' } as const
const LAST = { plugin: 'thimble-lean', key: 'last' } as const
const ASKED = { plugin: 'thimble-lean', key: 'asked' } as const
const RAN = { plugin: 'thimble-lean', key: 'ran' } as const
const ROWS = { plugin: 'thimble-lean', key: 'rows' } as const
const WEB = { plugin: 'thimble-lean', key: 'web' } as const
const READY = { plugin: 'thimble-lean', key: 'ready' } as const

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/
const REGION = /^[A-Za-z0-9][A-Za-z0-9_.:~-]{0,95}$/
const SAVED = /^saved (\S+) v(\d+): \S+/gm
const rowKey = (id: string) => String(id).slice(0, 24)
const refText = (r: { id: string; v: number | null }) => (r.v != null ? `${r.id}@${r.v}` : r.id)
const cut = (s: string, n: number) => ([...s].length <= n ? s : [...s].slice(0, Math.max(0, n - 1)).join('') + '…')
const fmtN = (x: unknown) => (typeof x === 'number' ? x.toLocaleString('en-US') : String(x))

// the module's own memory: lost on a reload, rebuilt from $.state and the object files
const objects = new Map<string, Any>()
const citeLabels = new Map<string, string>()
const preps = new Map<string, Prepared>()
const pending = new Map<string, Promise<Prepared>>()
let turn: { unplaced: ObjRef[]; lastRow: string; calls: string[] } | null = null
let theme: 'dark' | 'light' = 'dark'
let pendingAsk: { text: string; about: { id: string; v: number | null; region: string | null; label: string } } | null = null
let server: { base: string; root: string } | null = null
let serverStarting: Promise<{ base: string } | { problem: string }> | null = null

// ------------------------------------------------------------------------------------------------ objects

/** The folder under analysis that holds object `id`: LEAN_ROOT, a `cd` the command made, the session's folder or a
 *  folder above it. */
async function findRoot($: Engine, id: string, hints: string[] = []): Promise<string | null> {
  const env = await $.env.get('LEAN_ROOT')
  const cwd = String(await $.session.cwd())
  const tries: string[] = []
  for (const h of [env, ...hints, cwd]) {
    if (!h) continue
    const abs = h.startsWith('/') ? h : `${cwd.replace(/\/+$/, '')}/${h}`
    let d = abs.replace(/\/+$/, '')
    while (d) {
      tries.push(d)
      d = d.slice(0, d.lastIndexOf('/'))
    }
  }
  for (const d of [...new Set(tries)]) if (await $.fs.exists(`${d}/thimble/objects/${id}.json`)) return d
  return null
}

async function loadObject($: Engine, ref: ObjRef): Promise<Any | null> {
  const key = `${ref.root}|${ref.id}|${ref.v ?? ''}`
  if (ref.v != null && objects.has(key)) return objects.get(key)
  const latest = `${ref.root}/thimble/objects/${ref.id}.json`
  if (!(await $.fs.exists(latest))) return null
  let o = JSON.parse(String(await $.fs.read(latest)))
  if (ref.v != null && Number(o.version) !== ref.v) {
    const old = `${ref.root}/thimble/objects/.versions/${ref.id}/v${ref.v}.json`
    if (await $.fs.exists(old)) o = JSON.parse(String(await $.fs.read(old)))
  }
  if (ref.v != null) objects.set(key, o)
  return o
}

/** The object drawn at `w` columns, with its verbs: the program runs in a Node child, in the contract's sandbox.
 *  Kept per object version and width; a failed one stays failed until the module reloads. */
function prepared($: Engine, ref: ObjRef, w: number): Promise<Prepared> {
  const key = prepKey(ref, w)
  const hit = preps.get(key)
  if (hit) return Promise.resolve(hit)
  const running = pending.get(key)
  if (running) return running
  const p = (async (): Promise<Prepared> => {
    const object = await loadObject($, ref)
    if (!object) return { object: null, drawing: null, grid: null, verbs: [], problems: [], error: `no object ${ref.id} in ${ref.root}/thimble/objects` }
    const dir = $.plugin.root.replace(/\/+$/, '')
    const r = await $.process.run(['node', '--permission', `--allow-fs-read=${dir}`, `${dir}/shell/node/prep.mjs`], { stdin: JSON.stringify({ object, w, h: 24 }), timeoutMs: 30000 })
    if (r.exitCode !== 0) return { object, drawing: null, grid: null, verbs: [], problems: [], error: (r.stderr || r.stdout).trim().split('\n')[0]?.slice(0, 300) || `exit ${r.exitCode}` }
    const out = JSON.parse(r.stdout)
    return { object, drawing: out.drawing, grid: renderTerm(out.drawing, { w }), verbs: out.verbs || [], problems: out.problems || [] }
  })()
  pending.set(key, p)
  void p.then(x => { preps.set(key, x); pending.delete(key) }, () => pending.delete(key))
  return p
}

const prepKey = (ref: ObjRef, w: number) => `${ref.root}|${ref.id}|${ref.v ?? ''}|${w}`

/** For a drawing hook: the object if it is ready; else null, with the work started outside the drawing (a render's
 *  dispatch may be abandoned, which would stop the child) and the drawing subscribed to its end. */
async function preparedNow($: Engine, ref: ObjRef, w: number): Promise<Prepared | null> {
  const key = prepKey(ref, w)
  const hit = preps.get(key)
  if (hit) return hit
  await $.state.get({ ...READY, id: key })
  if (!pending.has(key)) $.clock.after(0, () => { void prepared($, ref, w).then(() => $.state.set({ ...READY, id: key }, Date.now())) })
  return null
}

/** The ref with its version: the latest when none is named. */
async function withVersion($: Engine, ref: ObjRef): Promise<ObjRef> {
  if (ref.v != null) return ref
  const o = await loadObject($, ref)
  return { ...ref, v: o?.version != null ? Number(o.version) : null }
}

async function verbsOf($: Engine, ref: ObjRef): Promise<Verb[]> {
  return (await prepared($, ref, 96)).verbs
}

// ------------------------------------------------------------------------------------------------ running things

/** The env of the shell's own `lean` calls: the person's, never counted as what Claude read (coverage). */
async function leanEnv($: Engine, root: string): Promise<Record<string, string>> {
  return { LEAN_ROOT: root, LEAN_SESSION: `person-${String(await $.session.id()).slice(0, 8)}` }
}

async function resolveRefs($: Engine, root: string, refs: string[]): Promise<void> {
  const dir = $.plugin.root.replace(/\/+$/, '')
  for (const ref of refs.slice(0, 3)) {
    const at = { ...ROWS, id: `${root}|${ref}` }
    if ((await $.state.get(at)).value !== undefined) continue
    const r = await $.process.run([`${dir}/bin/lean`, 'resolve', ref, '-n', '3', '--json'], { cwd: root, env: await leanEnv($, root), timeoutMs: 60000 })
    let v: unknown
    try { v = JSON.parse(r.stdout) } catch { v = { ref, error: (r.stdout + r.stderr).trim().slice(0, 400) || 'lean resolve gave nothing' } }
    await $.state.set(at, v)
  }
}

/** The kernel refs behind the selection: the region's, or the object's citations with no region. */
async function refsOf($: Engine, sel: Sel): Promise<{ refs: string[]; how: string }> {
  const p = await prepared($, sel, 96)
  if (!p.object) return { refs: [], how: '' }
  if (sel.region) return regionRefs(p.object, p.drawing, sel.region)
  return { refs: objectRefs(p.object).map((c: Any) => c.ref), how: 'cited in its words' }
}

async function select($: Engine, sel: Sel): Promise<void> {
  await $.state.set(SEL, sel)
  const { refs } = await refsOf($, sel)
  await resolveRefs($, sel.root, refs)
}

async function openDetail($: Engine, at: ObjRef, region: string | null = null): Promise<void> {
  const ref = await withVersion($, at)
  await select($, { ...ref, region, ex: 0, all: false })
  const o = await loadObject($, ref)
  await $.ui.open({ id: PANE, title: o?.title ? cut(String(o.title), 40) : ref.id, focus: true })
}

/** The folder under analysis for a ref that names no object: the latest object's, else the nearest folder at or above
 *  the session's that holds a thimble/ record folder. */
async function rootHere($: Engine): Promise<string | null> {
  const last = (await $.state.get(LAST)).value
  if (last) return last.root
  const env = await $.env.get('LEAN_ROOT')
  if (env) return env
  let d = String(await $.session.cwd()).replace(/\/+$/, '')
  while (d) {
    if ((await $.fs.exists(`${d}/thimble/objects`)) || (await $.fs.exists(`${d}/thimble/queries`))) return d
    d = d.slice(0, d.lastIndexOf('/'))
  }
  return null
}

/** A citation of Claude's words, opened in the detail view: where its value came from, down to its rows. */
async function openCite($: Engine, ref: string | null, label: string): Promise<void> {
  if (!ref) return
  const root = await rootHere($)
  if (!root) { $.ui.toast(`no thimble/ folder here to resolve ${ref}`); return }
  const last = (await $.state.get(LAST)).value
  await $.state.set(SEL, { id: last?.id ?? '', v: last?.v ?? null, root, region: null, ex: 0, all: false, cite: ref })
  citeLabels.set(ref, label)
  await $.ui.open({ id: PANE, title: 'citation', focus: true })
  await resolveRefs($, root, [ref])
}

/** Run a verb on an object (and region): its run.mjs in a Node child (shell/node/verb.mjs). What it made is kept; an
 *  `ask` goes to Claude as a prompt once the session is idle. */
async function execVerb($: Engine, word: string, ref: ObjRef, region: string | null, cols: number): Promise<Ran> {
  const p = await prepared($, ref, 96)
  const on = `${refText(ref)}${region ? ' ▸ ' + region : ''}`
  if (!p.object) return { verb: word, on, error: `no object ${refText(ref)}: ${p.error}` }
  const { refs } = region ? regionRefs(p.object, p.drawing, region) : { refs: objectRefs(p.object).map((c: Any) => c.ref) }
  const dir = $.plugin.root.replace(/\/+$/, '')
  const input = { object: p.object, region, regionMeta: region ? regionMeta(p.drawing, region) : null, refs, root: ref.root, w: Math.max(40, Math.min(120, cols)) }
  const r = await $.process.run(['node', `${dir}/shell/node/verb.mjs`, 'run', word], { stdin: JSON.stringify(input), cwd: ref.root, env: await leanEnv($, ref.root), timeoutMs: 600000 })
  let out: Any
  try { out = JSON.parse(r.stdout) } catch { out = { verb: word, error: (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 400) || `exit ${r.exitCode}` } }
  const ran: Ran = { verb: String(out.verb || word), text: out.text, note: out.note, ask: out.ask, error: out.error, on, saved: out.saved ? { id: out.saved.id, v: out.saved.v ?? null, root: ref.root } : null }
  if (ran.saved) await $.state.set(LAST, ran.saved)
  if (ran.ask) void $.prompt.submit({ text: ran.ask })
  return ran
}

function ranNote(r: Ran): string {
  return `The person ran the verb ${r.verb} on ${r.on}.${r.note ? ' ' + r.note : ''}${r.saved ? ` It saved ${refText(r.saved)}.` : ''}`
}

/** A verb the person pressed (a key in the detail view, a click under an object). A plugin's own $.command.run never
 *  reaches its own command hooks, so a press runs the verb here: Claude reads what it said in a row of the
 *  conversation, the person sees it in a dim transcript line, and an object it made opens in the detail view. */
async function runVerb($: Engine, verb: string, ref: ObjRef, region: string | null): Promise<void> {
  $.clock.after(0, () => {
    void (async () => {
      const ran = await execVerb($, verb, ref, region, 96)
      const text = ranText(ran)
      await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `${ranNote(ran)}\nIt said:\n${text}` }] } }).catch(() => undefined)
      $.ui.log(`${ran.verb} on ${ran.on}: ${text.replace(/\n/g, ' ')}`)
      if (ran.saved) await openDetail($, ran.saved)
    })()
  })
}

// ------------------------------------------------------------------------------------------------ the browser

async function startServer($: Engine, root: string): Promise<{ base: string } | { problem: string }> {
  if (server && server.root === root) return { base: server.base }
  if (serverStarting) return serverStarting
  const dir = $.plugin.root.replace(/\/+$/, '')
  serverStarting = new Promise(resolve => {
    void (async () => {
      let buf = ''
      let ready = false
      try {
        const child = $.process.spawn({ argv: ['node', `${dir}/shell/node/serve.mjs`, '--root', root, '--lean', `${dir}/bin/lean`], env: await leanEnv($, root) })
        for await (const piece of child) {
          if (piece.stream !== 'stdout') continue
          buf += piece.text
          let nl = buf.indexOf('\n')
          while (nl >= 0) {
            const line = buf.slice(0, nl)
            buf = buf.slice(nl + 1)
            nl = buf.indexOf('\n')
            let msg: Any
            try { msg = JSON.parse(line) } catch { continue }
            if (msg.ready) {
              server = { base: `http://127.0.0.1:${msg.ready.port}/${msg.ready.token}`, root }
              ready = true
              await $.state.set(WEB, { base: server.base, root })
              resolve({ base: server.base })
            } else if (msg.back) {
              await backFromBrowser($, root, msg.back)
            }
          }
        }
      } catch (err) {
        if (!ready) resolve({ problem: String((err as Error)?.message || err).slice(0, 200) })
      }
      server = null
      serverStarting = null
      if (!ready) resolve({ problem: 'the page server stopped before it was ready' })
      await $.state.set(WEB, { problem: 'the page server stopped; open in browser starts it again' })
    })()
  })
  const r = await serverStarting
  if ('problem' in r) serverStarting = null
  return r
}

async function backFromBrowser($: Engine, root: string, back: { object: string; v: number | null; region: string | null }): Promise<void> {
  if (!ID.test(back.object)) return
  const region = back.region && REGION.test(back.region) ? back.region : null
  const ref = await withVersion($, { id: back.object, v: back.v ?? null, root })
  await select($, { ...ref, region, ex: 0, all: false })
  const o = await loadObject($, ref)
  await $.ui.open({ id: PANE, title: o?.title ? cut(String(o.title), 40) : ref.id })
  $.ui.toast(`back from the browser: ${refText(ref)}${region ? ' ▸ ' + region : ''}`)
}

async function openBrowser($: Engine, sel: Sel): Promise<string> {
  const s = await startServer($, sel.root)
  if ('problem' in s) {
    await $.state.set(WEB, { problem: s.problem })
    return `No page: ${s.problem}`
  }
  const url = `${s.base}/o/${encodeURIComponent(sel.id)}${sel.v != null ? `?v=${sel.v}` : ''}${toHash({ object: sel.id, v: sel.v ?? undefined, region: sel.region || undefined })}`
  const browser = await $.env.get('BROWSER')
  const tries = browser ? [[browser, url]] : [['xdg-open', url], ['open', url]]
  for (const argv of tries) {
    const r = await $.process.run(argv, { timeoutMs: 15000 }).catch(() => null)
    if (r && r.exitCode === 0) {
      await $.state.set(WEB, { base: s.base, root: sel.root, opened: url })
      return `Opened ${refText(sel)}${sel.region ? ' ▸ ' + sel.region : ''} in the browser.`
    }
  }
  await $.state.set(WEB, { base: s.base, root: sel.root, opened: url, problem: 'no browser opened here; open the link yourself' })
  return `No browser opened here. The page: ${url}`
}

// ------------------------------------------------------------------------------------------------ drawing

// a verb as a chip: its key and name. Where the key works (a focused pane) the Button carries it as its hotkey, and the
// engine draws the key itself, as `s: squeeze`; elsewhere (the transcript, where a click runs it) it reads `s squeeze`.
function verbChip(els: Any, key: string, v: Verb, onPress: () => unknown, hotkey?: boolean) {
  const { Button, Text } = els
  if (hotkey && v.key) return Button({ key, plain: true, hotkey: v.key, label: v.name, children: [Text({ dimColor: true, children: v.name })], onPress })
  const label = [v.key ? Text({ color: 'suggestion', children: v.key }) : null, Text({ dimColor: true, children: `${v.key ? ' ' : ''}${v.name}` })].filter(Boolean)
  return Button({ key, plain: true, label: v.name, children: label, onPress })
}

const sep = (els: Any) => els.Text({ dimColor: true, children: ' · ' })

/** The quiet row under an object: the picked verbs, `? all`, and the ways to open it. */
function hintRow($: Engine, els: Any, ref: ObjRef, verbs: Verb[], key: string, fullscreen: boolean) {
  const { Box, Button, Text } = els
  const picked = verbs.filter(v => v.picked).slice(0, 3)
  const kids: Any[] = []
  picked.forEach((v, i) => {
    if (i) kids.push(sep(els))
    kids.push(verbChip(els, `${key}:v:${v.name}`, v, () => runVerb($, v.name, ref, null)))
  })
  if (picked.length) kids.push(sep(els))
  kids.push(Button({ key: `${key}:all`, plain: true, label: 'all verbs', children: [Text({ color: 'suggestion', children: '?' }), Text({ dimColor: true, children: ' all' })], onPress: () => openAll($, ref) }))
  const right: Any[] = fullscreen
    ? [
        Button({ key: `${key}:open`, plain: true, label: 'open', children: [Text({ dimColor: true, children: 'open ' }), Text({ color: 'suggestion', children: '›' })], onPress: () => openDetail($, ref) }),
        sep(els),
        Button({ key: `${key}:web`, plain: true, label: 'browser', children: [Text({ dimColor: true, children: 'browser ' }), Text({ color: 'suggestion', children: '↗' })], onPress: () => openBrowserFor($, ref) }),
      ]
    : [Text({ dimColor: true, children: `/obj ${refText(ref)} opens it` })]
  return Box({ flexDirection: 'row', justifyContent: 'space-between', children: [Box({ flexDirection: 'row', children: kids }), Box({ flexDirection: 'row', children: right })] })
}

async function openAll($: Engine, ref: ObjRef): Promise<void> {
  await openDetail($, ref)
  const cur = (await $.state.get(SEL)).value
  if (cur) await $.state.set(SEL, { ...cur, all: true })
}

async function openBrowserFor($: Engine, ref: ObjRef): Promise<void> {
  const cur = (await $.state.get(SEL)).value
  const sel = cur && cur.id === ref.id && cur.root === ref.root ? cur : { ...ref, region: null, ex: 0, all: false }
  const said = await openBrowser($, sel)
  $.ui.toast(said)
}

/** One object inline: its cells and its hint row, or one red line saying why it cannot be drawn. */
async function inlineEl($: Engine, e: Any, ref: ObjRef, key: string): Promise<Any> {
  const els = $.ui.resolve(e)
  const { Box, Text } = els as Any
  const cols = Math.max(40, Math.min(120, (e.viewport?.columns ?? 100) - 4))
  const p = await preparedNow($, ref, cols)
  if (!p) return Box({ marginTop: 1, marginLeft: 2, children: [Text({ dimColor: true, children: `drawing ${refText(ref)}…` })] })
  if (p.error || !p.grid) return Text({ color: 'error', children: `× ${refText(ref)} cannot be drawn: ${p.error || 'no drawing'}` })
  const fullscreen = e.viewport?.isFullscreen !== false
  // calm: under a reply an object takes at most about half a screen; the rest waits in the detail view
  const most = Math.max(12, Math.min(30, Math.floor((e.viewport?.rows ?? 48) * 0.55)))
  const rows = p.grid.h > most ? most - 1 : p.grid.h
  const more = p.grid.h - rows
  const { Button } = els as Any
  return Box({
    flexDirection: 'column', marginTop: 1, marginLeft: 2, width: Math.max(p.grid.w, 40),
    children: [
      paintRegions(p.grid, els, { theme, key: `${key}-${ref.id}`, rows, onPress: fullscreen ? (id: string) => openDetail($, ref, id) : undefined }),
      more ? Button({ key: `${key}-${ref.id}:more`, plain: true, label: 'more rows', children: [Text({ dimColor: true, children: `↓ ${more} more rows in the detail view ` }), Text({ color: 'suggestion', children: '›' })], onPress: () => openDetail($, ref) }) : null,
      hintRow($, els, ref, p.verbs, `${key}-${ref.id}`, fullscreen),
    ].filter(Boolean),
  })
}

/** The detail view: one pane. The drawing (each part pressable, the selected one lit), what the selection rests on,
 *  then two quiet rows: what a prompt carries, and the keys. A drawing taller than the pane shows the rows around
 *  the selection, with how many are above and below. */
async function detailEl($: Engine, e: Any): Promise<Any> {
  const els = $.ui.resolve(e) as Any
  const { Box, Text, Button, Link } = els
  const sel = (await $.state.get(SEL)).value as Sel | null
  if (!sel) return Text({ dimColor: true, children: 'No object is open. An object Claude saves shows under its reply; open it from there.' })
  const cols = Math.max(30, (e.props.bodyColumns ?? 80) - 1)
  if (sel.cite) {
    const label = citeLabels.get(sel.cite) || sel.cite
    return Box({ flexDirection: 'column', children: [
      Box({ flexDirection: 'row', justifyContent: 'space-between', children: [Text({ bold: true, wrap: 'truncate-end', children: `where ${label} comes from` }), Text({ dimColor: true, children: ` ${cut(sel.cite, 40)}` })] }),
      Box({ flexDirection: 'column', marginTop: 1, children: await rowsEls($, els, sel.root, [sel.cite], '', cols) }),
      Box({ flexDirection: 'column', marginTop: 1, children: [Text({ dimColor: true, wrap: 'truncate-end', children: `ask  your next prompt carries this citation · esc goes to the prompt` })] }),
    ] })
  }
  const p = await preparedNow($, sel, Math.min(cols, 140))
  if (!p) return Text({ dimColor: true, children: `drawing ${refText(sel)}…` })
  if (p.error || !p.grid) return Text({ color: 'error', children: `× ${refText(sel)} cannot be drawn: ${p.error || 'no drawing'}` })
  const o = p.object

  // what the selection rests on
  const section: Any[] = []
  if (sel.all) {
    section.push(Text({ children: [Text({ bold: true, children: 'all verbs' }), Text({ dimColor: true, children: ` on ${o.id}${sel.region ? ' ▸ ' + sel.region : ''} · ● picked for it` })] }))
    for (const v of p.verbs) {
      section.push(Button({
        key: `all:${v.name}`, plain: true, label: v.name, onPress: () => runVerb($, v.name, sel, sel.region),
        children: [Text({ dimColor: true, children: v.picked ? '● ' : '  ' }), Text({ color: 'suggestion', children: v.key || ' ' }), Text({ children: `  ${v.name.padEnd(10)} ` }), Text({ dimColor: true, children: cut(v.phrase || v.line, Math.max(10, cols - 18)) })],
      }))
    }
    if (!p.verbs.length) section.push(Text({ dimColor: true, children: 'No verbs yet: a verb is a folder in lean/verbs/.' }))
  } else if (sel.region) {
    const meta = regionMeta(p.drawing, sel.region)
    if (!meta) section.push(Text({ dimColor: true, children: `no part "${sel.region}" in this version` }))
    else {
      section.push(Text({ wrap: 'truncate-end', children: [Text({ bold: true, children: `▸ ${meta.label || sel.region}` }), Text({ dimColor: true, children: `  ${sel.region}` })] }))
      const cite = typeof meta.cite === 'string' ? p.drawing.cites?.[meta.cite] : null
      if (cite?.text || cite?.source) section.push(Text({ wrap: 'wrap', children: [Text({ children: `  ${cite.text || ''}` }), Text({ dimColor: true, children: cite.source ? ` · ${cite.source}` : '' })] }))
      if (meta.note) section.push(Text({ dimColor: true, italic: true, wrap: 'wrap', children: `  ${meta.note}` }))
      const { refs, how } = regionRefs(o, p.drawing, sel.region)
      section.push(...(await rowsEls($, els, sel.root, refs, how, cols)))
      const own = recordRefs(p.drawing, sel.region)
      const ex = typeof meta.examples === 'string' ? p.drawing.examples?.[meta.examples] : null
      if (ex && ex.records?.length) {
        const i = ((sel.ex % ex.records.length) + ex.records.length) % ex.records.length
        section.push(Box({ flexDirection: 'row', children: [
          Text({ dimColor: true, children: `  example ${i + 1} of ${fmtN(ex.total ?? ex.records.length)}${ex.label ? ' · ' + ex.label : ''}  ` }),
          Button({ key: 'ex-prev', plain: true, hotkey: 'j', label: 'previous example', children: [Text({ dimColor: true, children: '‹' })], onPress: () => stepExample($, -1) }),
          Text({ children: '  ' }),
          Button({ key: 'ex-next', plain: true, hotkey: 'k', label: 'next example', children: [Text({ dimColor: true, children: '›' })], onPress: () => stepExample($, 1) }),
        ] }))
        section.push(Text({ wrap: 'wrap', children: `  ${cut(exampleText(ex.fmt, ex.records[i]), cols * 3)}` }))
      } else if (own.length) {
        for (const r of own.slice(0, 3)) section.push(Text({ wrap: 'truncate-end', children: [Text({ dimColor: true, children: `  ${r.ref}  ` }), Text({ children: String(r.text) })] }))
      }
    }
  } else {
    const cites = objectRefs(o)
    if (o.text) section.push(Text({ wrap: 'wrap', children: String(o.text).replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1') }))
    if (cites.length) section.push(...(await rowsEls($, els, sel.root, cites.map((c: Any) => c.ref), '', cols)))
    else if (!o.text) section.push(Text({ dimColor: true, children: 'Select a part to see its rows.' }))
  }

  // the two quiet rows: what a prompt carries, and the keys
  const parts = selectable(p.grid)
  const ask = Text({ dimColor: true, wrap: 'truncate-end', children: `ask  your next prompt carries ${o.id}${sel.region ? ' ▸ ' + sel.region : ''} · esc goes to the prompt` })
  const picked = p.verbs.filter(v => v.picked).slice(0, 3)
  const row: Any[] = []
  if (parts.length) row.push(Text({ color: 'suggestion', children: 'tab' }), Text({ dimColor: true, children: ' parts' }), sep(els))
  picked.forEach(v => { row.push(verbChip(els, `k:${v.name}`, v, () => runVerb($, v.name, sel, sel.region), true), sep(els)) })
  row.push(Button({ key: 'k:all', plain: true, hotkey: 'h', label: 'all verbs', children: [Text({ dimColor: true, children: sel.all ? 'fewer verbs' : 'all verbs' })], onPress: () => toggleAll($) }))
  row.push(sep(els))
  row.push(Button({ key: 'k:web', plain: true, hotkey: 'o', label: 'open in browser', children: [Text({ dimColor: true, children: 'open in browser' })], onPress: async () => $.ui.toast(await openBrowser($, (await $.state.get(SEL)).value ?? sel)) }))
  const keys = Box({ flexDirection: 'row', flexWrap: 'wrap', children: row })
  const web = (await $.state.get(WEB)).value
  const page = web?.opened && web.root === sel.root
    ? Text({ dimColor: true, wrap: 'truncate-end', children: ['page ', Link({ href: web.opened, children: 'open it again ↗' }), web.problem ? ` · ${web.problem}` : ' · served on this machine only'] })
    : web?.problem ? Text({ color: 'error', wrap: 'wrap', children: web.problem }) : null

  // the drawing's window: all of it when it fits, else the rows around the selection
  const head = 1 + (o.question ? 1 : 0)
  const fixed = head + 1 + rowsOf(section, cols) + 1 + 1 + 2 + (page ? 1 : 0)
  const room = Math.max(6, (e.props.scroll?.bodyRows ?? 40) - fixed)
  let from = 0
  let rows = p.grid.h
  if (p.grid.h > room) {
    rows = room - 2
    const r = sel.region ? p.grid.regions.find((x: Any) => x.id === sel.region && x.rects.length) : null
    const at = r ? r.rects[0].y : 0
    from = Math.max(0, Math.min(p.grid.h - rows, at - Math.floor(rows / 2)))
  }
  const above = from
  const below = p.grid.h - from - rows
  const drawing = Box({ flexDirection: 'column', marginTop: 1, children: [
    above ? Text({ dimColor: true, children: `↑ ${above} more row${above === 1 ? '' : 's'}` }) : null,
    paintRegions(p.grid, els, { theme, selected: sel.region, key: 'pane', from, rows, onPress: (id: string) => select($, { ...sel, region: id === sel.region ? null : id, ex: 0, all: false }) }),
    below ? Text({ dimColor: true, children: `↓ ${below} more row${below === 1 ? '' : 's'}` }) : null,
  ].filter(Boolean) })

  return Box({ flexDirection: 'column', children: [
    Box({ flexDirection: 'row', justifyContent: 'space-between', children: [Text({ bold: true, wrap: 'truncate-end', children: String(o.title || o.id) }), Text({ dimColor: true, children: ` ${o.id}@${o.version}` })] }),
    o.question ? Text({ dimColor: true, wrap: 'truncate-end', children: String(o.question) }) : null,
    drawing,
    Box({ flexDirection: 'column', marginTop: 1, children: section }),
    Box({ flexDirection: 'column', marginTop: 1, children: [ask, keys, page].filter(Boolean) }),
  ].filter(Boolean) })
}

/** About how many rows these elements take at `cols` columns: one each, more for a long text that wraps. */
function rowsOf(els: Any[], cols: number): number {
  const text = (n: Any): string => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(text).join('') : n?.props?.children != null ? text(n.props.children) : n?.children != null ? text(n.children) : '')
  return els.reduce((sum, n) => sum + (n?.props?.wrap === 'wrap' || n?.wrap === 'wrap' ? Math.max(1, Math.ceil([...text(n)].length / Math.max(10, cols))) : 1), 0)
}

async function rowsEls($: Engine, els: Any, root: string, refs: string[], how: string, cols: number): Promise<Any[]> {
  const { Text } = els
  const out: Any[] = []
  for (const ref of refs.slice(0, 3)) {
    const r = (await $.state.get({ ...ROWS, id: `${root}|${ref}` })).value as Any
    if (r === undefined) { out.push(Text({ dimColor: true, children: `  rows  resolving ${cut(ref, cols - 20)}…` })); continue }
    const c = chainWords(r)
    if (c.error) { out.push(Text({ color: 'error', wrap: 'wrap', children: `  rows  ${c.notes[0]}` })); continue }
    out.push(Text({ wrap: 'truncate-end', children: [Text({ dimColor: true, children: '  rows  ' }), Text({ children: `← ${c.line}` }), Text({ dimColor: true, children: how && !how.startsWith('named') ? `  (${how})` : '' })] }))
    for (const n of c.notes.slice(0, 2)) out.push(Text({ dimColor: true, italic: true, wrap: 'wrap', children: `        ${n}` }))
    for (const rec of c.records.slice(0, 3)) out.push(Text({ wrap: 'truncate-end', children: [Text({ dimColor: true, children: `        ${rec.ref}  ` }), Text({ children: String(rec.text ?? '') })] }))
    if (r.count != null && r.count > c.records.length) out.push(Text({ dimColor: true, children: `        + ${fmtN(r.count - c.records.length)} more · lean resolve ${cut(ref, Math.max(10, cols - 40))}` }))
  }
  return out
}

function exampleText(fmt: unknown, rec: Any): string {
  if (typeof fmt === 'string' && rec && typeof rec === 'object') {
    return fmt.replace(/\{([\w.]+)\}/g, (m, key) => {
      const v = key.split('.').reduce((x: Any, k: string) => (x == null ? undefined : x[k]), rec)
      return v === undefined ? m : String(v)
    }).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\n/g, ' · ')
  }
  return typeof rec === 'string' ? rec : JSON.stringify(rec)
}

async function stepExample($: Engine, d: number): Promise<void> {
  const cur = (await $.state.get(SEL)).value
  if (cur) await $.state.set(SEL, { ...cur, ex: cur.ex + d })
}

async function toggleAll($: Engine): Promise<void> {
  const cur = (await $.state.get(SEL)).value
  if (cur) await $.state.set(SEL, { ...cur, all: !cur.all })
}

const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g

/** Claude's citations in a reply: each kernel ref it links, once, with the words that link it. */
function citesIn(md: string): { ref: string; label: string }[] {
  const out: { ref: string; label: string }[] = []
  for (const m of String(md).matchAll(LINK)) {
    const ref = String(m[2])
    if (/^(https?|file):/i.test(ref) || !isRef(ref) || out.some(c => c.ref === ref)) continue
    out.push({ ref, label: String(m[1]) })
  }
  return out
}

/** The reply as drawn: a citation reads as its words. */
function withoutTargets(md: string): string {
  return String(md).replace(LINK, (m, label: string, ref: string) => (/^(https?|file):/i.test(ref) || !isRef(ref) ? m : label))
}

/** What the person sees of an object Claude just saved, in a few lines for Claude: how big it is, how many parts they
 *  can select, and what does not hold (a program that failed, the toolkit's warnings, example sets with no records,
 *  parts that rest on no rows). */
function drawnNote(p: Prepared, ref: ObjRef): string {
  if (p.error || !p.grid) return `The person cannot see ${refText(ref)}: ${p.error || 'it drew nothing'}.`
  const d = p.drawing
  const parts = selectable(p.grid)
  const lines = [`${refText(ref)} is drawn for the person under your reply: ${p.grid.h} rows by ${p.grid.w} columns, ${parts.length} part${parts.length === 1 ? '' : 's'} they can select.`]
  if (d.error) lines.push(`Its program failed: ${d.error.name}: ${d.error.message}${d.error.line ? ` (line ${d.error.line})` : ''}. They see the error in its place.`)
  for (const w of (d.warnings || []).slice(0, 5)) lines.push(`Warning: ${w}`)
  const empty = Object.entries(d.examples || {}).filter(([, x]: [string, Any]) => !x?.records?.length).map(([id]) => id)
  if (empty.length) lines.push(`${empty.length} example set${empty.length === 1 ? ' has' : 's have'} no records, so the person sees none for ${empty.length === 1 ? 'it' : 'them'}: ${empty.slice(0, 4).join(', ')}${empty.length > 4 ? ', …' : ''}.`)
  const bare = parts.filter((r: Any) => !regionRefs(p.object, d, r.id).refs.length && !recordRefs(d, r.id).length)
  if (bare.length) lines.push(`${bare.length} of ${parts.length} parts name no ref and match no data row, so selecting one shows no source rows: ${bare.slice(0, 4).map((r: Any) => r.id).join(', ')}${bare.length > 4 ? ', …' : ''}.`)
  return lines.join('\n')
}

/** The words a /verb run leaves in the transcript and for Claude. */
function ranText(r: Ran): string {
  if (r.error) return `${r.verb}: ${r.error}`
  const lines = [r.text || `${r.verb} ran${r.on ? ' on ' + r.on : ''}.`]
  if (r.saved) lines.push(`It saved ${refText(r.saved)}.`)
  if (r.ask) lines.push(`It asked Claude: ${cut(r.ask, 300)}`)
  return lines.join('\n')
}

/** "<id>[@v] [region]" → the object and region, the id matched as the kernel does (with or without its number). */
async function parseTarget($: Engine, words: string[]): Promise<{ ref: ObjRef | null; region: string | null; problem?: string }> {
  const [first, region] = words
  const sel = (await $.state.get(SEL)).value
  const last = (await $.state.get(LAST)).value
  if (!first) {
    const ref = sel ?? last
    return ref ? { ref: { id: ref.id, v: ref.v, root: ref.root }, region: sel && ref === sel ? sel.region : null } : { ref: null, region: null, problem: 'no object yet' }
  }
  const m = /^([^@\s]+)(?:@(\d+))?$/.exec(first)
  if (!m || !m[1] || !ID.test(m[1])) return { ref: null, region: null, problem: `"${first}" is not an object id` }
  const here = await rootHere($)
  const hints = [...new Set([sel?.root, last?.root, here].filter(Boolean))] as string[]
  let id: string = m[1]
  let root = await findRoot($, id, hints)
  if (!root) {
    // the slug without its number (saves-per-day for 01-saves-per-day)
    for (const r of hints) {
      const list = await $.fs.list(`${r}/thimble/objects`).catch(() => [])
      const hit = list.find(x => x.name.endsWith('.json') && x.name.replace(/\.json$/, '').replace(/^\d+-/, '') === id)
      if (hit) { id = hit.name.replace(/\.json$/, ''); root = r; break }
    }
  }
  if (!root) return { ref: null, region: null, problem: `no object ${first} here` }
  return { ref: await withVersion($, { id, v: m[2] ? Number(m[2]) : null, root }), region: region && REGION.test(region) ? region : null }
}

// ------------------------------------------------------------------------------------------------ hooks

export const registerShell: Register = on => {
  // (a matcher, as the kernel's module hooks session.start without one and the engine takes one bare hook per event)
  on('session.start', { cwd: /^/ }, async ($, e, next) => {
    const r = await next(e)
    try {
      await $.command.register({ name: 'obj', description: 'Open an object in the detail view: /obj [object] [region] · /obj browser opens it in the browser', argumentHint: '[object] [region]', immediate: true })
      await $.command.register({ name: 'verb', description: 'Run a verb on an object: /verb <verb> [object] [region] · /verb ? lists the verbs', argumentHint: '<verb> [object] [region]' })
      const row = (await $.config.list()).find(x => x.key === 'theme')
      theme = String(row?.value ?? 'dark').startsWith('light') ? 'light' : 'dark'
    } catch {
      // the shell draws nothing it cannot; the session goes on
    }
    return r
  })

  // a turn of main's: the objects it saved, and its last text row, under which they are drawn
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) turn = { unplaced: [], lastRow: '', calls: [] }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    let notes: string[] = []
    try {
      const input = e as unknown as { command?: string; agentId?: string; tool_use_id?: string }
      const text = typeof r.text === 'string' ? r.text : typeof r.result === 'string' ? r.result : ''
      if (r.deny !== undefined || r.isError || input.agentId || !/\blean\b/.test(String(input.command)) || !text.includes('saved ')) return r
      const cdTo = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*&&/.exec(String(input.command))
      notes = []
      for (const m of text.matchAll(SAVED)) {
        const id = String(m[1])
        const root = await findRoot($, id, cdTo ? [String(cdTo[1] || cdTo[2] || cdTo[3])] : [])
        if (!root) continue
        const ref: ObjRef = { id, v: Number(m[2]), root }
        if (turn) {
          turn.unplaced = [...turn.unplaced.filter(x => !(x.id === ref.id && x.root === root)), ref]
          if (input.tool_use_id) turn.calls.push(input.tool_use_id)
        }
        await $.state.set(LAST, ref)
        notes.push(drawnNote(await prepared($, ref, 96), ref))
      }
    } catch {
      // watching never changes a call's result
    }
    // what the person sees of each object, for Claude alone, after the call's own output
    return notes.length && r.deny === undefined && !r.isError ? { ...r, context: [...(r.context ?? []), notes.join('\n')] } : r
  }).catch(($, e, next) => next(e))

  // the first text row after a save carries its objects: they are placed before the row is stored, so the main screen
  // (which prints a finished row once) draws them too
  on('session.append', async ($, e, next) => {
    try {
      const msg = e.message as { type?: string; content?: unknown }
      const blocks = Array.isArray(msg.content) ? (msg.content as { type?: string; text?: string }[]) : []
      if (e.agentId === undefined && turn && e.door === 'response' && e.uuid && blocks.some(b => b.type === 'text' && String(b.text || '').trim())) {
        turn.lastRow = e.uuid
        if (turn.unplaced.length) {
          await $.state.set({ ...UNDER, id: rowKey(e.uuid) }, turn.unplaced)
          turn.unplaced = []
        }
      }
    } catch {
      // the row is stored whatever the shell makes of it
    }
    const stored = await next(e)
    try {
      if (e.agentId === undefined && stored.uuid) {
        const msg = e.message as { type?: string; content?: unknown }
        if (pendingAsk && e.door === 'prompt' && msg.type === 'user') {
          await $.state.set({ ...ASKED, id: rowKey(stored.uuid) }, pendingAsk.about)
          pendingAsk = null
        }
      }
    } catch {
      // the row is stored whatever the shell makes of it
    }
    return stored
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    try {
      // objects saved after the turn's last words: under those words (or the save's own row, with none)
      if (e.agentId === undefined && turn && turn.unplaced.length) {
        const at = turn.lastRow ? rowKey(turn.lastRow) : turn.calls.at(-1)
        if (at) {
          const cur = ((await $.state.get({ ...UNDER, id: at })).value ?? []) as ObjRef[]
          await $.state.set({ ...UNDER, id: at }, [...cur.filter(x => !turn!.unplaced.some(y => y.id === x.id)), ...turn.unplaced])
        }
      }
    } catch {
      // nothing drawn is better than a turn that does not end
    }
    if (e.agentId === undefined) turn = null
    return done
  })

  // the reply, then the objects its turn saved
  // the reply with its citations as their words (Claude Code draws a link that is no URL as its words and its target),
  // then one quiet row naming the cited values, each a press away from its rows; then the objects its turn saved
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const list = ((await $.state.get({ ...UNDER, id: rowKey(e.requestId) })).value ?? []) as ObjRef[]
    const cites = e.props.isSummary ? [] : citesIn(e.props.text)
    if (!list.length && !cites.length) return next(e)
    const els = $.ui.resolve(e) as Any
    const { Box, Text, Button } = els
    let own = await next(cites.length ? { ...e, props: { ...e.props, text: withoutTargets(e.props.text) } } : e)
    if (cites.length) {
      const room = Math.max(20, (e.viewport?.columns ?? 100) - 12)
      const chips: Any[] = [Text({ dimColor: true, children: 'cites ' })]
      let used = 6
      let shown = 0
      for (const c of cites) {
        const w = [...c.label].length + 3
        if (used + w > room) break
        if (shown) chips.push(Text({ dimColor: true, children: ' · ' }))
        chips.push(Button({ key: `cite-${rowKey(e.requestId)}-${shown}`, plain: true, label: c.label, children: [Text({ color: 'suggestion', children: cut(c.label, 30) })], onPress: () => openCite($, c.ref, c.label) }))
        used += w
        shown++
      }
      if (shown < cites.length) chips.push(Text({ dimColor: true, children: ` +${cites.length - shown}` }))
      own = Box({ flexDirection: 'column', children: [own, Box({ flexDirection: 'row', marginLeft: 2, children: chips })] })
    }
    if (!list.length) return own
    const drawn = await Promise.all(list.map((ref, i) => inlineEl($, e, ref, `row-${rowKey(e.requestId)}-${i}`)))
    return Box({ flexDirection: 'column', children: [own, ...drawn] })
  })

  // a turn whose last word was a tool call: its objects under that call's row
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const list = ((await $.state.get({ ...UNDER, id: e.props.tool_use_id })).value ?? []) as ObjRef[]
    if (!list.length || e.props.isErrored) return next(e)
    const { Box } = $.ui.resolve(e) as Any
    const own = await next(e)
    const drawn = await Promise.all(list.map((ref, i) => inlineEl($, e, ref, `call-${e.props.tool_use_id.slice(-10)}-${i}`)))
    return Box({ flexDirection: 'column', children: [own, ...drawn] })
  })

  // a prompt asked while the detail view was open: under it, what it carried
  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'composer' } } }, async ($, e, next) => {
    const about = (await $.state.get({ ...ASKED, id: rowKey(e.requestId) })).value
    if (!about) return next(e)
    const { Box, Text } = $.ui.resolve(e) as Any
    const own = await next(e)
    return Box({ flexDirection: 'column', children: [own, Text({ dimColor: true, wrap: 'truncate-end', children: `  ▸ about ${about.id}${about.v != null ? '@' + about.v : ''}${about.region ? ' ▸ ' + about.label : ''}` })] })
  })

  // the prompt carries the open object and its selected region, said to Claude in a few lines
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    try {
      const sel = (await $.state.get(SEL)).value
      const open = (await $.ui.panes()).some(x => x.id === PANE && x.isPlaced)
      if (sel && open && sel.cite) {
        pendingAsk = { text: e.text, about: { id: sel.cite, v: null, region: null, label: citeLabels.get(sel.cite) || sel.cite } }
        return next({ ...e, context: [...(e.context ?? []), `The person asked this with a citation of yours open in the detail view: ${citeLabels.get(sel.cite) || ''} (${sel.cite}). "This" may mean that value. \`lean resolve ${sel.cite}\` shows its rows.`] })
      }
      if (sel && open) {
        const p = await prepared($, sel, 96)
        const meta = sel.region ? regionMeta(p.drawing, sel.region) : null
        const { refs } = await refsOf($, sel)
        const label = sel.region ? String(meta?.label || sel.region) : ''
        const lines = [
          `The person asked this with an object open in the detail view: ${p.object?.id}@${p.object?.version} "${p.object?.title || ''}" (${sel.root}/thimble/objects/${sel.id}.json).`,
          sel.region ? `They had selected its part ${sel.region} ("${label}"). "This", "here" or "it" may mean that part.` : 'No part of it was selected.',
          refs.length ? `${sel.region ? 'That part' : 'Its words'} rest${sel.region ? 's' : ''} on ${refs.slice(0, 3).join(', ')}; \`lean resolve <ref>\` opens the rows, \`lean list ${sel.id}\` the object's lineage.` : `\`lean list ${sel.id}\` shows the object's lineage.`,
        ]
        pendingAsk = { text: e.text, about: { id: sel.id, v: p.object?.version ?? sel.v, region: sel.region, label } }
        return next({ ...e, context: [...(e.context ?? []), lines.join('\n')] })
      }
    } catch {
      // a prompt goes in as typed when the shell cannot say what it carries
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // /obj [object] [region] · /obj browser [object] [region]
  on('command.run', { command: 'obj' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    const toWeb = words[0] === 'browser'
    const t = await parseTarget($, toWeb ? words.slice(1) : words)
    if (!t.ref) return { text: `Nothing to open: ${t.problem}. An object Claude saves with \`lean save\` shows under its reply.` }
    if (toWeb) {
      const cur = (await $.state.get(SEL)).value
      const sel: Sel = cur && cur.id === t.ref.id && !words[2] ? cur : { ...t.ref, region: t.region, ex: 0, all: false }
      return { text: await openBrowser($, sel) }
    }
    await openDetail($, t.ref, t.region)
    return {}
  })

  // /verb <verb> [object] [region] · /verb ? (or /verb alone) lists the verbs for the object
  on('command.run', { command: 'verb' }, async ($, e) => {
    const [word = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    const t = await parseTarget($, rest)
    if (!word || word === '?' || word === 'all') {
      if (!t.ref) return { text: 'No object yet: the verbs work on an object Claude saved.' }
      const verbs = await verbsOf($, t.ref)
      const lines = verbs.map(v => `${v.picked ? '●' : ' '} ${v.key || ' '}  ${v.name.padEnd(10)} ${v.phrase || v.line}`)
      return { text: verbs.length ? `The verbs for ${refText(t.ref)} (● picked for it):\n${lines.join('\n')}` : 'No verbs yet: a verb is a folder in lean/verbs/.' }
    }
    if (!t.ref) return { text: `No object to run ${word} on: ${t.problem}.` }
    const ran = await execVerb($, word, t.ref, t.region, (e.presentation?.columns ?? 100) - 4)
    await $.state.set({ ...RAN, id: e.args.trim().slice(0, 300) }, ran)
    return { text: ranText(ran), context: [ranNote(ran)] }
  })

  // a verb's row: its words, then the object it made, drawn with its own hint row
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (e.props.command !== 'verb' || e.props.isErrored) return next(e)
    const ran = (await $.state.get({ ...RAN, id: e.props.args.trim().slice(0, 300) })).value
    if (!ran?.saved) return next(e)
    const { Box } = $.ui.resolve(e) as Any
    return Box({ flexDirection: 'column', children: [await next(e), await inlineEl($, e, ran.saved, `verb-${e.requestId.slice(-10)}`)] })
  })

  // the detail view
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => detailEl($, e))

  // tab through the parts: each lights in the drawing as the ring reaches it
  on('ui.focus', async ($, e, next) => {
    const r = await next(e)
    try {
      const region = e.requestId === PANE && typeof e.element === 'string' ? regionOfKey(e.element) : null
      if (region) {
        const cur = (await $.state.get(SEL)).value
        if (cur && cur.region !== region) await select($, { ...cur, region, ex: 0, all: false })
      }
    } catch {
      // the ring moves whatever the shell makes of it
    }
    return r
  }).catch(($, e, next) => next(e))
}

/** For tests: the module's memory, cleared. */
export function resetShell(): void {
  objects.clear()
  preps.clear()
  pending.clear()
  turn = null
  pendingAsk = null
  server = null
  serverStarting = null
}

export { isRef }
