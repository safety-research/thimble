// A lazy chunk that no longer loads (src/lib/chunkRecovery.ts): the server's build was replaced while the tab was
// open, so the old page asks for hashed files that are gone. The chunk is fetched again once; the tab reloads itself
// once when the server serves another build, never in a loop and never over typed text; the surfaces say to reload.
import { describe, expect, test } from 'vitest'
import { CHUNK_FAILED, failureText, isChunkError, mayReload, RELOAD_GUARD_MS, RELOAD_KEY, recoverStaleBuild, retryImport, type RecoverDeps } from '../../src/lib/chunkRecovery.ts'

const SAFARI = new TypeError('Importing a module script failed.')
const CHROME = new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1:8300/assets/Documents-abc123.js')
const FIREFOX = new TypeError('error loading dynamically imported module: http://127.0.0.1:8300/assets/vega-embed-1.js')

const noSleep = async () => {}

describe('a chunk failure', () => {
  test('is recognised in each browser wording, and nothing else is', () => {
    for (const e of [SAFARI, CHROME, FIREFOX, new Error('Unable to preload CSS for /assets/x.css')]) expect(isChunkError(e)).toBe(true)
    expect(isChunkError(new Error('Unrecognized data set: table'))).toBe(false)
    expect(isChunkError(null)).toBe(false)
  })
  test('is shown as what to do, not the browser message; any other failure keeps its own text', () => {
    expect(failureText(SAFARI)).toBe(CHUNK_FAILED)
    expect(CHUNK_FAILED).toMatch(/Reload the page/)
    expect(failureText(new Error('bad spec'))).toBe('bad spec')
  })
})

describe('retryImport', () => {
  test('fetches a chunk again once after a chunk failure', async () => {
    let n = 0
    const got = await retryImport(async () => {
      n++
      if (n === 1) throw SAFARI
      return 'module'
    }, 1, noSleep)
    expect(got).toBe('module')
    expect(n).toBe(2)
  })
  test('throws after the retry fails too', async () => {
    let n = 0
    await expect(
      retryImport(async () => {
        n++
        throw CHROME
      }, 1, noSleep),
    ).rejects.toBe(CHROME)
    expect(n).toBe(2)
  })
  test('does not retry a failure that is not a chunk failure', async () => {
    let n = 0
    const bad = new Error('module evaluation threw')
    await expect(
      retryImport(async () => {
        n++
        throw bad
      }, 1, noSleep),
    ).rejects.toBe(bad)
    expect(n).toBe(1)
  })
})

function memoryStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init))
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }
}

function deps(over: Partial<RecoverDeps> = {}) {
  const calls = { reload: 0, prompt: 0 }
  const store = memoryStore()
  const d: RecoverDeps = {
    loaded: async () => '100',
    served: async () => '200',
    typing: () => false,
    storage: () => store,
    reload: () => void calls.reload++,
    prompt: () => void calls.prompt++,
    now: () => 1_000_000,
    ...over,
  }
  return { d, calls, store }
}

describe('recoverStaleBuild', () => {
  test('reloads once when the server serves another build, and notes when', async () => {
    const { d, calls, store } = deps()
    expect(await recoverStaleBuild(d)).toBe('reloaded')
    expect(calls).toEqual({ reload: 1, prompt: 0 })
    expect(store.m.get(RELOAD_KEY)).toBe('1000000')
  })
  test('does nothing when the build is the same or unknown (a dropped connection, dev mode)', async () => {
    for (const [a, b] of [['100', '100'], [null, '200'], ['100', null]] as const) {
      const { d, calls } = deps({ loaded: async () => a, served: async () => b })
      expect(await recoverStaleBuild(d)).toBe('none')
      expect(calls).toEqual({ reload: 0, prompt: 0 })
    }
  })
  test('asks instead of reloading over typed text', async () => {
    const { d, calls } = deps({ typing: () => true })
    expect(await recoverStaleBuild(d)).toBe('prompted')
    expect(calls).toEqual({ reload: 0, prompt: 1 })
  })
  test('never reloads twice within the guard, so a chunk missing from the new build too cannot loop', async () => {
    const store = memoryStore({ [RELOAD_KEY]: String(1_000_000 - 5_000) })
    const { d, calls } = deps({ storage: () => store })
    expect(await recoverStaleBuild(d)).toBe('prompted')
    expect(calls).toEqual({ reload: 0, prompt: 1 })
    expect(mayReload(1_000_000, 1_000_000 - RELOAD_GUARD_MS - 1)).toBe(true)
    expect(mayReload(1_000_000, null)).toBe(true)
  })
  test('asks instead of reloading when sessionStorage is unavailable or throws', async () => {
    const none = deps({ storage: () => null })
    expect(await recoverStaleBuild(none.d)).toBe('prompted')
    expect(none.calls.reload).toBe(0)
    const throws = deps({
      storage: () => {
        throw new Error('SecurityError')
      },
    })
    expect(await recoverStaleBuild(throws.d)).toBe('prompted')
    expect(throws.calls.reload).toBe(0)
    const full = deps({
      storage: () => ({
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceededError')
        },
      }),
    })
    expect(await recoverStaleBuild(full.d)).toBe('prompted')
    expect(full.calls.reload).toBe(0)
  })
})
