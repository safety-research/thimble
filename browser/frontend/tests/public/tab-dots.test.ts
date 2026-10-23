// The top bar's tab dots (src/shell/dots.ts): which stream events light which tab.
import { describe, expect, test } from 'vitest'
import { tabOfEvent } from '../../src/shell/dots.ts'

describe('the Canvas tab', () => {
  test('a card made or deleted lights it, the orientation\'s among them; an edit does not', () => {
    expect(tabOfEvent('cell', { op: 'created' })).toBe('canvas')
    expect(tabOfEvent('cell', { op: 'deleted' })).toBe('canvas')
    expect(tabOfEvent('cell', { op: 'edited' })).toBeNull()
    expect(tabOfEvent('orient', { status: 'done' })).toBeNull()
  })
})

describe('the Files tab', () => {
  test('a view built lights it; a view proposal, a build queued, under way or failed, and one dropped or deleted do not', () => {
    expect(tabOfEvent('view', { slug: 'timeline', status: 'built' })).toBe('files')
    for (const status of ['suggested', 'queued', 'building', 'failed', 'dropped', 'deleted', 'chat'])
      expect(tabOfEvent('view', { slug: 'timeline', status }), status).toBeNull()
  })
  test('a label lights it only when a label over files that is on there finishes its run, so its marks appear', () => {
    expect(tabOfEvent('concepts', { concept: 'k1', what: 'applied', scope: 'files', shown: true })).toBe('files')
    // a label made, starting its run, changed or deleted: nothing new to see in Files yet
    for (const what of ['defined', 'redefined', 'applying', 'changed', 'deleted'])
      expect(tabOfEvent('concepts', { concept: 'k1', what, scope: 'files', shown: true }), what).toBeNull()
    // a label that is off in Files, a label over cards or the report, and an event from an older server without a scope
    expect(tabOfEvent('concepts', { concept: 'k1', what: 'applied', scope: 'files', shown: false })).toBeNull()
    expect(tabOfEvent('concepts', { concept: 'k1', what: 'applied', scope: 'canvas', shown: true })).toBeNull()
    expect(tabOfEvent('concepts', { concept: 'k1', what: 'applied', scope: 'report', shown: false })).toBeNull()
    expect(tabOfEvent('concepts', { concept: 'k1', what: 'applied' })).toBeNull()
  })
  test('a filter set on the files lights it; one on the canvas lights the Canvas tab instead', () => {
    expect(tabOfEvent('filter', { scope: 'files' })).toBe('files')
    expect(tabOfEvent('filter', { scope: 'canvas' })).toBe('canvas')
  })
})
