// The public test suite, tests/public: the page's contracts under Node, and its components under jsdom where a test
// names that environment in its first line. No test here opens a browser, reaches the network or compares pictures.
// Run from frontend/: npm test (or npx vitest for watch mode).
import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  // the terminal plugin's drawing toolkit, which a program card draws with (src/kit), read from plugin/draw
  server: { fs: { allow: ['.', '../../plugin/draw'] } },
  test: {
    include: ['tests/public/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**'],
    environment: 'node',
    // a component test that waits on React or DOMPurify finishes in well under a second; a hang fails fast
    testTimeout: 10_000,
  },
})
