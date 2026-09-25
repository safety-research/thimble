// The part of jsdom's API bridge.test.ts uses; jsdom ships no types of its own.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: { runScripts?: 'dangerously' | 'outside-only'; pretendToBeVisual?: boolean; url?: string; beforeParse?: (window: Window & typeof globalThis) => void })
    readonly window: Window & typeof globalThis
  }
}
