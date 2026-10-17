// @vitest-environment jsdom
// Where the product tour runs (src/lib/tourFrame.ts): always in thimble's read-only demo workspace, in a frame over the
// analyst's page, never over their own files. The workspace it picks, the frame's address, the messages the frame and
// the page around it take (this origin and that window only), and the storage the demo workspace gets back once the
// frame closes. And what the cards on the analyst's page say (tour/steps offerTexts): the 0.8.0 welcome, word for word,
// when a demo is installed; that the demo isn't installed, with the command and only Skip tour, when none is.
import { afterEach, describe, expect, test } from 'vitest'
import { inTourFrame, keepWorkspaceStorage, tourEventOf, tourFrameHref, tourWorkspace } from '../../src/lib/tourFrame.ts'
import { offerTexts, sessionTexts } from '../../src/tour/steps.ts'

afterEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

const folder = (name: string) => ({ name, kind: 'folder' as const })
const demo = (name: string, ready = true) => ({ name, kind: 'demo' as const, ready })
const example = (name: string) => ({ name, kind: 'example' as const })

describe('the workspace the tour runs in', () => {
  test('a demo page runs it on itself', () => {
    expect(tourWorkspace([folder('pilot'), demo('demo-collusion-wiki')], 'example-linked-sessions', true)).toBe('example-linked-sessions')
  })
  test('elsewhere, an installed demo dataset, one whose orientation ran in advance first', () => {
    expect(tourWorkspace([demo('demo-mythos-5', false), demo('demo-collusion-wiki'), example('example-timeline'), folder('pilot')], 'pilot', false)).toBe('demo-collusion-wiki')
    expect(tourWorkspace([demo('demo-mythos-5', false), folder('pilot')], 'pilot', false)).toBe('demo-mythos-5')
  })
  test('with no demo dataset, a worked example, the tour’s own first', () => {
    expect(tourWorkspace([example('example-linked-sessions'), example('example-timeline'), folder('pilot')], 'pilot', false)).toBe('example-timeline')
    expect(tourWorkspace([example('example-repository'), folder('pilot')], 'pilot', false)).toBe('example-repository')
  })
  test('never a folder of the analyst’s own: with none installed, none', () => {
    expect(tourWorkspace([folder('pilot'), folder('notes')], 'pilot', false)).toBeNull()
    expect(tourWorkspace([], 'pilot', false)).toBeNull()
  })
})

describe('the frame', () => {
  test('its address names the demo workspace and marks the page as the tour’s frame', () => {
    expect(tourFrameHref('demo-collusion-wiki', '/')).toBe('/?ws=demo-collusion-wiki&tour=frame')
    expect(tourFrameHref('example-timeline', '/thimble/')).toBe('/thimble/?ws=example-timeline&tour=frame')
  })
  test('a page with no page around it is no frame, whatever its address says', () => {
    window.history.replaceState(null, '', '/?ws=demo-collusion-wiki&tour=frame')
    expect(inTourFrame()).toBe(false)
    window.history.replaceState(null, '', '/')
  })
  test('a message counts only from the frame’s own window, on this origin, in the tour’s shape', () => {
    const from = {} as Window
    const msg = (data: unknown, origin = 'http://thimble.test', source: unknown = from) => ({ data, origin, source: source as Window })
    const origin = 'http://thimble.test'
    expect(tourEventOf(msg({ source: 'thimble-tour', event: 'end' }), from, origin)).toBe('end')
    expect(tourEventOf(msg({ source: 'thimble-tour', event: 'started' }), from, origin)).toBe('started')
    expect(tourEventOf(msg({ source: 'thimble-tour', event: 'end' }, 'http://evil.example'), from, origin)).toBeNull()
    expect(tourEventOf(msg({ source: 'thimble-tour', event: 'end' }, origin, {}), from, origin)).toBeNull()
    expect(tourEventOf(msg({ source: 'thimble-tour', event: 'reload' }), from, origin)).toBeNull()
    expect(tourEventOf(msg('end'), from, origin)).toBeNull()
    expect(tourEventOf(msg({ source: 'thimble-tour', event: 'end' }), null, origin)).toBeNull()
  })
})

describe('the demo workspace’s storage', () => {
  test('is put back as it was: keys added removed, keys changed restored, other workspaces untouched', () => {
    localStorage.setItem('thimble:demo:layout', '{"panes":"canvas"}')
    localStorage.setItem('thimble:demo:opened', 'true')
    localStorage.setItem('thimble:demo-2:layout', 'theirs')
    sessionStorage.setItem('thimble:demo:files', 'a')
    const restore = keepWorkspaceStorage('demo')
    localStorage.setItem('thimble:demo:layout', '{"panes":"report"}')
    localStorage.removeItem('thimble:demo:opened')
    localStorage.setItem('thimble:demo:canvas-view', 'moved')
    localStorage.setItem('thimble:demo-2:layout', 'theirs, changed meanwhile')
    sessionStorage.setItem('thimble:demo:files', 'b')
    sessionStorage.setItem('thimble:demo:reader', 'c')
    restore()
    expect(Object.fromEntries(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)]))).toEqual({
      'thimble:demo-2:layout': 'theirs, changed meanwhile',
      'thimble:demo:layout': '{"panes":"canvas"}',
      'thimble:demo:opened': 'true',
    })
    expect(Object.fromEntries(Object.keys(sessionStorage).map((k) => [k, sessionStorage.getItem(k)]))).toEqual({ 'thimble:demo:files': 'a' })
  })
})

describe('what the analyst’s page says', () => {
  test('with a demo installed, the 0.8.0 welcome, word for word', () => {
    expect(offerTexts('offer', false, true)).toEqual({
      title: 'Welcome to thimble',
      says: ['Would you like a short tour? The demo tour uses <b>example data</b>.'],
      begin: 'Take the tour',
      skip: 'Skip',
    })
    expect(offerTexts('offer', true, true).says).toEqual(['This is example data, not your files. To open your own folder, run <code>thimble</code> in it.', 'Would you like a short tour?'])
  })
  test('with none installed, that the demo isn’t installed, how to install it, and only Skip tour', () => {
    const first = offerTexts('missing', false, true)
    expect(first).toEqual({
      title: 'Welcome to thimble',
      says: ["The tour runs in thimble's demo workspace, on example data, and the demo isn't installed here.", 'To install it, run <code>thimble demo</code> in a terminal. Then take the tour from Settings.'],
      begin: null,
      skip: 'Skip tour',
    })
    expect(offerTexts('missing', false, false).title).toBe("The demo isn't installed")
  })
  test('a frame that did not open: said, with only Close', () => {
    expect(offerTexts('failed', false, false)).toMatchObject({ title: "The tour didn't open", begin: null, skip: 'Close' })
  })
  test('the steps speak as a demo page does, since they run only on the demo workspace', () => {
    expect(sessionTexts().chat[1]).toMatch(/^This is a demo and thimble isn't connected to a live Claude Code session/)
  })
})
