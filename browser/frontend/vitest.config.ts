// The public test suite, tests/public: the UI's pure modules under Node, and its components under jsdom where a test
// names that environment in its first line. No test here opens a browser, reaches the network or compares pictures;
// the checks that need a real browser are tests/public/browser, which vitest.browser.config.ts runs.
// Run from frontend/: npm test (or npx vitest for watch mode).
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  // the plugin's hooks module test imports Claude Code's test kit, which `claude plugin test` gives it; here its
  // describe, test and expect are vitest's
  resolve: { alias: { 'claude-code/testing': fileURLToPath(new URL('./tests/public/claude-code-testing.ts', import.meta.url)) } },
  // the terminal plugin's drawing toolkit, which a program card draws with (src/kit), read from plugin/draw
  server: { fs: { allow: ['.', '../../plugin/draw'] } },
  test: {
    // and the plugin's hooks module (plugin/hooks/thimble.ts), against a fake Claude Code engine
    include: ['tests/public/**/*.test.{ts,tsx}'],
    exclude: ['tests/public/browser/**', '**/node_modules/**'],
    environment: 'node',
    // a component test that waits on React or DOMPurify finishes in well under a second; a hang fails fast
    testTimeout: 10_000,
  },
})
