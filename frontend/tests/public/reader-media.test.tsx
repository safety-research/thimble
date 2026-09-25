// @vitest-environment jsdom
// The File browser's reader (src/files/Reader.tsx) on a media file: a video, an image or a recording shows as itself
// from the media route, a ref with a moment starts the video there, and another binary file says it has no text rather
// than drawing its bytes. The files are invented and nothing answers but a stand-in for the source route.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { looksBinary, Reader } from '../../src/files/Reader.tsx'
import { terminalText } from '../../src/files/views/raw.tsx'
import type { FilesLabels } from '../../src/files/useLabels.ts'
import { mount, settle, unmountAll } from './mount.tsx'

const labels = { on: [], all: [], presence: new Map() } as unknown as FilesLabels
const requests: string[] = []

beforeEach(() => {
  requests.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.stubGlobal('fetch', async (url: string) => {
    requests.push(String(url))
    // the source route reads a zip's first bytes as a record of control characters
    const page = { path: 'bundle.zip', kind: 'text', total_lines: 1, start: 1, records: [{ line: 1, record: { text: 'PK\u0003\u0004\u0014\u0000\u0008\u0000' }, blocks: [], meta: {} }] }
    return new Response(JSON.stringify(String(url).includes('/source') ? page : {}), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Reader on a media file', () => {
  test('a video plays from the media route, at the moment its ref names', async () => {
    const el = await mount(<Reader workspace="clips" path="sessions/day-2/screen.mp4" kind="text" targetRef="sessions/day-2/screen.mp4#t=1:30" lead={null} labels={labels} />)
    const video = el.querySelector('video')
    expect(video).not.toBeNull()
    expect(video!.getAttribute('src')).toBe('/api/ws/clips/media?path=sessions%2Fday-2%2Fscreen.mp4#t=90')
    expect(video!.hasAttribute('controls')).toBe(true)
    expect(el.textContent).not.toContain('ftyp')
    expect(requests.some((u) => u.includes('/source'))).toBe(false)
  })

  test('an image shows as itself, and a recording gets a player', async () => {
    const img = await mount(<Reader workspace="clips" path="figures/deletions.png" kind="text" lead={null} labels={labels} />)
    expect(img.querySelector('img')?.getAttribute('src')).toBe('/api/ws/clips/media?path=figures%2Fdeletions.png')
    const audio = await mount(<Reader workspace="clips" path="calls/call-03.m4a" kind="text" lead={null} labels={labels} />)
    expect(audio.querySelector('audio')).not.toBeNull()
  })

  test('a terminal log is text: its escape sequences are left out of the judgement and of the lines shown', () => {
    const line = '\u001b7\u001b[r\u001b8\u001b[?25h\u001b[2J\u001b[H\u001b]0;tmux\u0007\u001b[1;32m$ \u001b[0mpytest -q\u001b(B'
    expect(looksBinary([line, line, line])).toBe(false)
    expect(terminalText(line)).toBe('$ pytest -q')
    expect(terminalText('plain words\tand a tab')).toBe('plain words\tand a tab')
    expect(looksBinary(['PK\u0003\u0004\u0014\u0000\u0008'])).toBe(true)
  })

  test('another binary file says it has no text', async () => {
    const el = await mount(<Reader workspace="clips" path="bundle.zip" kind="text" lead={null} labels={labels} />)
    await settle()
    await settle()
    expect(el.querySelector('.reader-noview-reason')?.textContent).toMatch(/binary file/)
    expect(el.textContent).not.toContain('PK')
  })
})
