// @vitest-environment jsdom
// A pane with no surface (src/shell/PaneArea.tsx): it offers the surfaces no pane shows as the chat's chips that name a
// surface, a click showing that one there, and × still closes it; when every surface shows in another pane it says so
// rather than being a blank card. The surfaces are stubs.
import { act } from 'react'
import { afterEach, expect, test } from 'vitest'
import { PaneArea, type SurfaceSpec } from '../../src/shell/PaneArea.tsx'
import { arrange, preset, single, type Panes } from '../../src/shell/panes.ts'
import { mount, unmountAll } from './mount.tsx'

afterEach(() => unmountAll())

const stub = (id: string, label: string, icon: SurfaceSpec['icon']): SurfaceSpec => ({ id, label, icon, panel: id, keep: true, render: () => <div>{label}</div> })
const SURFACES = [stub('files', 'Files', 'files'), stub('canvas', 'Canvas', 'canvas'), stub('report', 'Report', 'report'), stub('view:board', 'Board', 'view')]

async function draw(panes: Panes, surfaces: SurfaceSpec[]) {
  const placed: [string, string][] = []
  const closed: string[] = []
  const geometry = arrange(panes.root, { x: 0, y: 0, w: 1200, h: 800 })
  const el = await mount(
    <PaneArea
      panes={panes}
      geometry={geometry}
      multi={geometry.panes.length > 1}
      surfaces={surfaces}
      area={() => undefined}
      drag={null}
      onDragStart={() => undefined}
      onFocus={() => undefined}
      onPlace={(pane, s) => placed.push([pane, s])}
      onClose={(pane) => closed.push(pane)}
      onResize={() => undefined}
    />,
  )
  return { el, placed, closed }
}

test('an empty pane offers the surfaces no pane shows as tab chips, and a click shows one there', async () => {
  // two panes: Files, and one left empty
  const panes = preset(single('files'), 'columns', ['files'])
  const { el, placed, closed } = await draw(panes, SURFACES)
  const empty = el.querySelector('.shell-panel.is-empty')!
  const chips = [...empty.querySelectorAll<HTMLButtonElement>('.pane-pick .view-tab')]
  expect(chips.map((c) => c.textContent)).toEqual(['Canvas', 'Report', 'Board'])
  expect(chips.map((c) => c.dataset.surface)).toEqual(['canvas', 'report', 'view:board'])
  await act(async () => chips[1].click())
  expect(placed).toEqual([['p2', 'report']])
  await act(async () => empty.querySelector<HTMLButtonElement>('.pane-close')!.click())
  expect(closed).toEqual(['p2'])
})

test('an empty pane says so when every surface shows in another pane', async () => {
  // four panes over three surfaces, as set_layout can ask for
  const three = SURFACES.slice(0, 3)
  const panes = preset(single('files'), 'quadrants', three.map((s) => s.id))
  const { el } = await draw(panes, three)
  const empty = el.querySelector('.shell-panel.is-empty')!
  expect(empty.querySelectorAll('.view-tab')).toHaveLength(0)
  expect(empty.querySelector('.pane-pick-none')?.textContent).toBe('Every surface shows in another pane')
  expect(empty.querySelector('.pane-close')).not.toBeNull()
})
