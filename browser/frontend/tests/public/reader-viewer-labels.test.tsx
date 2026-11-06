// @vitest-environment jsdom
// A file viewer's label controls in the File browser's reader (src/files/Reader.tsx ReaderViewer): a file viewer shows
// only as a mode of the reader, so its page's label calls (labelCalls.ts) do what the Labels pane does there, as a view
// in the views bar (ViewPane) does: `on` turns a label on, and focuses it, or off.
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ViewLabelActions } from '../../src/files/labelCalls.ts'
import type { FilesLabels } from '../../src/files/useLabels.ts'
import { api } from '../../src/lib/api.ts'
import type { Concept, View } from '../../src/lib/types.ts'
import { mount, settle, unmountAll } from './mount.tsx'

let frameActions: ViewLabelActions | undefined
vi.mock('../../src/files/ViewerFrame', () => ({
  ViewerFrame: (p: { labelActions?: ViewLabelActions }) => {
    frameActions = p.labelActions
    return <div className="stub-frame" />
  },
}))

const { pickKey, Reader } = await import('../../src/files/Reader.tsx')
const { runLabelCall } = await import('../../src/files/labelCalls.ts')

const kind = { id: 'k1', name: 'answered', unit: 'record', marks: 'record', shown: false, classes: [{ name: 'yes', color: 1, highlight: true }] } as unknown as Concept

function filesLabels(): FilesLabels {
  return { all: [kind], on: [], focus: null, setFocus: vi.fn(), byId: new Map([[kind.id, kind]]), presence: new Map(), toggle: vi.fn(), setClasses: vi.fn(), setColour: vi.fn(), save: async () => kind, remove: async () => undefined }
}

const VIEWER: View = { slug: 'exercises', origin: 'workspace', name: 'Exercises And Answers', description: '', claims: ['*.pdf'], accepts: [], units: [], libs: [], built: '2026-10-14T10:00:00Z', ok: true, forms: [], file_type: true, unit: 'file' }

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
  frameActions = undefined
})

describe("a file viewer's label toggle in the reader", () => {
  for (const path of ['book.pdf', 'notes.cue']) {
    test(`turns the label on for ${path}`, async () => {
      vi.stubGlobal('fetch', async () => new Response('{"detail":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } }))
      vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
      vi.spyOn(api, 'viewsForFile').mockResolvedValue([VIEWER])
      vi.spyOn(api, 'suggestView').mockResolvedValue({ slug: null })
      vi.spyOn(api, 'source').mockResolvedValue({ path, kind: 'text', total_lines: 1, start: 1, records: [{ line: 1, record: { text: 'a' }, blocks: [{ kind: 'text', text: 'a' }], meta: {} }] })
      localStorage.setItem(pickKey('w', path), JSON.stringify(`v:${VIEWER.slug}`))
      const labels = filesLabels()
      await mount(<Reader workspace="w" path={path} kind="text" labels={labels} lead={<span />} />)
      await settle()
      await settle()
      await runLabelCall('on', { id: 'k1', on: true }, { ws: 'w', byId: labels.byId, palette: [], actions: frameActions })
      expect(labels.setFocus).toHaveBeenCalledWith('k1')
      expect(labels.toggle).toHaveBeenCalledWith('k1')
    })
  }
})
