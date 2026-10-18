// lib.ts: the browser's side of the panes (lean/panes/): the same program files the terminal runs, loaded from the
// page server (/code/panes/...), and the drawing kit (draw/kit.js) loaded into the page. A pane is thimble's own code,
// so it runs here in the page, as the terminal runs it in its hooks module; a card's program (Claude's) runs only in
// the sandbox (draw/browser/sandbox.js).
import { api, BASE, objectOf, resolveRef, serverModule } from '../lib/api'
import { getState } from '../lib/store'

export interface PaneModule {
  name: string
  title: string
  reads: (args: Record<string, unknown>) => string[]
  stateKey: (args: Record<string, unknown>) => string
  data: (stores: Record<string, unknown>, args: Record<string, unknown>, size: { w: number; h: number }) => unknown
  program: (k: any, data: any) => any
}

interface Mods {
  panes: Record<string, PaneModule>
  host: any
  kit: any
}
let mods: Promise<Mods> | null = null

export function paneModules(): Promise<Mods> {
  if (!mods) {
    mods = (async () => {
      await import(/* @vite-ignore */ `${BASE}/draw/kit.js`)
      const [index, host] = await Promise.all([serverModule('code/panes/index.js'), serverModule('code/panes/host.js')])
      return { panes: index.default, host, kit: (globalThis as any).DrawKit }
    })()
    mods.catch(() => {
      mods = null
    })
  }
  return mods
}

/** One store a pane reads, by name, as the terminal reads it: the claims, the order of the messages, a record. */
export async function readStore(name: string): Promise<unknown> {
  const [kind, ...rest] = name.split(':')
  const arg = rest.join(':')
  const s = getState()
  switch (kind) {
    case 'claims': {
      const r = await api('claims')
      return r.error ? null : r.store
    }
    case 'index':
      return s.rows.map((r) => ({ row: r.row, kind: r.kind }))
    case 'record':
      return s.rows.find((r) => r.row === arg)?.record ?? null
    case 'object': {
      const r = await objectOf(arg, null)
      return r.error ? null : r
    }
    default:
      return null
  }
}

/** What a program wants that its data does not hold (k.want): {rows: [refs]} through the kernel. */
export async function readWant(request: any): Promise<unknown> {
  if (Array.isArray(request?.rows)) {
    const refs = request.rows.filter((r: unknown) => typeof r === 'string').slice(0, 200)
    if (!refs.length) return { records: [], count: 0 }
    return resolveRef(refs, Math.max(1, Math.min(20, Number(request.n) || 8)))
  }
  return { error: 'the page cannot read that' }
}

/** A pane's state as either surface left it: {state, by, at} or null. */
export async function readPaneState(key: string): Promise<{ state: Record<string, unknown> | null; by?: string; at?: string } | null> {
  const r = await api(`pane/${encodeURIComponent(key)}`)
  return r.error ? null : r
}
