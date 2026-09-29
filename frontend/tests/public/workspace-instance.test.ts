// A workspace's browser state belongs to one instance of it (src/lib/workspace.ts instanceAction, syncInstance): a
// workspace made again under an old name, with a new main chat, does not reopen on the old one's layout, and clearing
// one workspace's keys leaves another's alone, even one whose name it prefixes.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { instanceAction, PENDING_INSTANCE, storageKey, syncInstance, workspaceKeys } from '../../src/lib/workspace.ts'

describe('instanceAction', () => {
  test('the same stamp keeps everything', () => {
    expect(instanceAction('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')).toEqual({ clear: false, write: null })
  })
  test('another stamp clears and keeps the new one', () => {
    expect(instanceAction('2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z')).toEqual({ clear: true, write: '2026-01-01T00:00:00Z' })
  })
  test('no stamp kept (state from before the check) clears and keeps the new one', () => {
    expect(instanceAction(null, '2026-01-01T00:00:00Z')).toEqual({ clear: true, write: '2026-01-01T00:00:00Z' })
  })
  test('no main yet clears and keeps the sentinel, once', () => {
    expect(instanceAction('2025-01-01T00:00:00Z', null)).toEqual({ clear: true, write: PENDING_INSTANCE })
    expect(instanceAction(null, null)).toEqual({ clear: true, write: PENDING_INSTANCE })
    expect(instanceAction(PENDING_INSTANCE, null)).toEqual({ clear: false, write: null })
  })
  test('a stamp found while the sentinel is kept is adopted without clearing', () => {
    expect(instanceAction(PENDING_INSTANCE, '2026-01-01T00:00:00Z')).toEqual({ clear: false, write: '2026-01-01T00:00:00Z' })
  })
})

describe('workspaceKeys', () => {
  test('a name that prefixes another takes only its own keys', () => {
    const keys = ['thimble:logs:layout', 'thimble:logs-2:layout', 'thimble:logs2:x', 'thimble:last-ws', 'other:logs:x', 'thimble:logs:instance']
    expect(workspaceKeys('logs', keys)).toEqual(['thimble:logs:layout', 'thimble:logs:instance'])
    expect(workspaceKeys('logs-2', keys)).toEqual(['thimble:logs-2:layout'])
  })
})

/** A Storage over a Map, so these run under Node. */
class MemoryStorage implements Storage {
  private m = new Map<string, string>()
  get length() {
    return this.m.size
  }
  clear() {
    this.m.clear()
  }
  getItem(k: string) {
    return this.m.get(k) ?? null
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null
  }
  removeItem(k: string) {
    this.m.delete(k)
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v))
  }
}

describe('syncInstance', () => {
  let localStorage: Storage
  let sessionStorage: Storage
  beforeEach(() => {
    localStorage = new MemoryStorage()
    sessionStorage = new MemoryStorage()
    vi.stubGlobal('window', { localStorage, sessionStorage })
  })
  afterEach(() => vi.unstubAllGlobals())
  const seed = () => {
    localStorage.setItem(storageKey('logs', 'layout'), '{"chatOpen":false}')
    sessionStorage.setItem(storageKey('logs', 'seen'), '{}')
    localStorage.setItem(storageKey('logs-2', 'layout'), '{"chatOpen":true}')
    sessionStorage.setItem(storageKey('logs-2', 'seen'), '{}')
    localStorage.setItem('thimble:last-ws', 'logs')
  }

  test('an old install\'s state without a stamp is cleared, only for that workspace', () => {
    seed()
    syncInstance('logs', 'T1')
    expect(localStorage.getItem(storageKey('logs', 'layout'))).toBeNull()
    expect(sessionStorage.getItem(storageKey('logs', 'seen'))).toBeNull()
    expect(JSON.parse(localStorage.getItem(storageKey('logs', 'instance'))!)).toBe('T1')
    expect(localStorage.getItem(storageKey('logs-2', 'layout'))).toBe('{"chatOpen":true}')
    expect(sessionStorage.getItem(storageKey('logs-2', 'seen'))).toBe('{}')
    expect(localStorage.getItem('thimble:last-ws')).toBe('logs')
  })

  test('the same instance keeps its state', () => {
    syncInstance('logs', 'T1')
    seed()
    syncInstance('logs', 'T1')
    expect(localStorage.getItem(storageKey('logs', 'layout'))).toBe('{"chatOpen":false}')
  })

  test("a tab's session state from an older instance goes even when another tab already stamped the new one", () => {
    syncInstance('logs', 'T1')
    sessionStorage.setItem(storageKey('logs', 'instance'), JSON.stringify('T0'))
    sessionStorage.setItem(storageKey('logs', 'files'), '{"open":["a"]}')
    localStorage.setItem(storageKey('logs', 'layout'), '{"chatOpen":false}')
    expect(syncInstance('logs', 'T1')).toBe(true)
    expect(sessionStorage.getItem(storageKey('logs', 'files'))).toBeNull()
    expect(localStorage.getItem(storageKey('logs', 'layout'))).toBe('{"chatOpen":false}')
    expect(syncInstance('logs', 'T1')).toBe(false)
  })

  test('a pending instance keeps a layout made meanwhile when its stamp arrives', () => {
    syncInstance('logs', null)
    expect(JSON.parse(localStorage.getItem(storageKey('logs', 'instance'))!)).toBe(PENDING_INSTANCE)
    seed()
    syncInstance('logs', null)
    syncInstance('logs', 'T1')
    expect(localStorage.getItem(storageKey('logs', 'layout'))).toBe('{"chatOpen":false}')
    expect(JSON.parse(localStorage.getItem(storageKey('logs', 'instance'))!)).toBe('T1')
  })
})
