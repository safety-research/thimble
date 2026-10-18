// The demo's state contract: one counter the reply rows and command rows read, bumped when a squeeze changes, so
// they draw again.
export type SqueezeDemoTick = number

declare module 'claude-code' {
  interface PluginState {
    'lean-squeeze-demo': { tick: SqueezeDemoTick }
  }
}
