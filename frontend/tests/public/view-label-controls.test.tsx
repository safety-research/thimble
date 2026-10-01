// @vitest-environment jsdom
// The Labels sidebar beside a view (src/files/ViewSide.tsx useViewSide): a view draws its own label controls and thimble
// draws none in its head. A view whose page has them keeps the sidebar closed until its controls open a label's editor.
// Beside a view built without them, the sidebar opens while a label is on or a label marks the view's files, so turning
// the last label off keeps it, with the offer to add them, which asks for the change in the view's thread.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { FilesLabels } from '../../src/files/useLabels.ts'
import { ADD_LABEL_CONTROLS, useViewSide } from '../../src/files/ViewSide.tsx'
import type { BuiltView } from '../../src/files/ViewsBar.tsx'
import type { Concept } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const asks = { id: 'k1', name: 'asks', description: '', unit: 'record', kind: 'regex', spec: 'help', labels: ['asks', 'other'], created_by: 'analyst', ts: '', shown: true, classes: [{ name: 'asks', color: 2, highlight: true }, { name: 'other', color: 0, highlight: false }] } as unknown as Concept

function labelsWith(on: Concept[], marks: string[] = []): FilesLabels {
  return {
    all: [asks],
    on,
    focus: on[0]?.id ?? null,
    setFocus: () => undefined,
    byId: new Map([[asks.id, asks]]),
    presence: new Map([[asks.id, Object.fromEntries(marks.map((f) => [f, { asks: 1 }]))]]),
    toggle: () => undefined,
    setClasses: () => undefined,
    setColour: () => undefined,
    save: async () => asks,
  }
}

const VIEW: BuiltView = { slug: 'board', name: 'Board', claims: ['board.jsonl'] }

let edit: ((id: string | null) => void) | null = null

function Side({ own, labels }: { own: boolean; labels: FilesLabels }) {
  const side = useViewSide('w', { ...VIEW, label_controls: own }, labels)
  edit = side.editLabel
  return <div>{side.side}</div>
}

const sent: { url: string; body: string }[] = []

beforeEach(() => {
  sent.length = 0
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    sent.push({ url: String(url), body: String(init?.body ?? '') })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const sidebar = (el: HTMLElement) => el.querySelector('aside.files-side-labels')
const offer = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.files-labels-note button')

describe('the Labels sidebar beside a view', () => {
  test('beside a view built without label controls it shows while a label is on, with the offer to add them', async () => {
    const el = await mount(<Side own={false} labels={labelsWith([asks])} />)
    await settle()
    expect(sidebar(el)).not.toBeNull()
    expect(offer(el)?.textContent).toBe('Add label controls to the view')
    await act(async () => offer(el)!.click())
    await settle()
    const ask = sent.find((s) => s.url.endsWith('/views/proposals/board/message'))
    expect(ask && JSON.parse(ask.body)).toEqual({ text: ADD_LABEL_CONTROLS })
    expect(offer(el)).toBeNull()
    expect(el.querySelector('.files-labels-note')?.textContent).toBe('Adding label controls to the view')
  })

  test('beside a view with label controls of its own it stays closed until they open a label editor', async () => {
    const el = await mount(<Side own labels={labelsWith([asks])} />)
    await settle()
    expect(sidebar(el)).toBeNull()
    await act(async () => edit!('k1'))
    expect(sidebar(el)).not.toBeNull()
    expect(offer(el), 'no offer beside a view that has them').toBeNull()
  })

  test('beside a view built without label controls, turning the last label off keeps the sidebar while a label marks its files', async () => {
    const el = await mount(<Side own={false} labels={labelsWith([], ['board.jsonl'])} />)
    await settle()
    expect(sidebar(el)).not.toBeNull()
    expect(offer(el)).not.toBeNull()
  })

  test('with no label on and none marking its files, nothing shows beside a view built without label controls', async () => {
    const el = await mount(<Side own={false} labels={labelsWith([], ['other.jsonl'])} />)
    await settle()
    expect(sidebar(el)).toBeNull()
  })

})
