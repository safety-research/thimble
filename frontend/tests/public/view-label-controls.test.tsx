// @vitest-environment jsdom
// thimble's own label control beside a view (src/files/ViewSide.tsx useViewSide): the Labels sidebar shows while a
// label is on, and for a view whose page draws label controls of its own (views' label_controls) it does not open by
// itself, but the head keeps a compact Labels control with how many labels are on, so the label state is always one
// click away.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { FilesLabels } from '../../src/files/useLabels.ts'
import { useViewSide } from '../../src/files/ViewSide.tsx'
import type { BuiltView } from '../../src/files/ViewsBar.tsx'
import type { Concept } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const asks = { id: 'k1', name: 'asks', description: '', unit: 'record', kind: 'regex', spec: 'help', labels: ['asks', 'other'], created_by: 'analyst', ts: '', shown: true, classes: [{ name: 'asks', color: 2, highlight: true }, { name: 'other', color: 0, highlight: false }] } as unknown as Concept

function labelsWith(on: Concept[]): FilesLabels {
  return {
    all: [asks],
    on,
    focus: on[0]?.id ?? null,
    setFocus: () => undefined,
    byId: new Map([[asks.id, asks]]),
    presence: new Map(),
    toggle: () => undefined,
    setClasses: () => undefined,
    setColour: () => undefined,
    save: async () => asks,
  }
}

const VIEW: BuiltView = { slug: 'board', name: 'Board', claims: ['board.jsonl'] }

function Side({ own, labels }: { own: boolean; labels: FilesLabels }) {
  const side = useViewSide('w', { ...VIEW, label_controls: own }, labels)
  return (
    <div>
      <div data-test="head">{side.lead}</div>
      {side.side}
    </div>
  )
}

beforeEach(() => {
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
})
afterEach(() => {
  unmountAll()
  vi.unstubAllGlobals()
})

const sidebar = (el: HTMLElement) => el.querySelector('aside.files-side-labels')
const lead = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-test="head"] button')

describe("thimble's label control beside a view", () => {
  test('the sidebar shows while a label is on and the view draws no label controls', async () => {
    const el = await mount(<Side own={false} labels={labelsWith([asks])} />)
    await settle()
    expect(sidebar(el)).not.toBeNull()
    expect(lead(el)).toBeNull()
  })

  test("a view with label controls of its own keeps the sidebar closed, and the head's control opens it", async () => {
    const el = await mount(<Side own labels={labelsWith([asks])} />)
    await settle()
    expect(sidebar(el)).toBeNull()
    expect(lead(el)?.textContent).toBe('1 label on')
    await act(async () => lead(el)!.click())
    expect(sidebar(el)).not.toBeNull()
  })

  test('with no label on, the control still shows in the head', async () => {
    const el = await mount(<Side own labels={labelsWith([])} />)
    await settle()
    expect(sidebar(el)).toBeNull()
    expect(lead(el)?.textContent).toBe('Labels')
  })
})
