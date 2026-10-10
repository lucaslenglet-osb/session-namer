/** Names proposed by Haiku, shown in the band; empty = band hidden. */
export type Suggestions = string[]

/** Baseline name (picked or dismissed): suggestions come back only if the subject diverges from it. */
export type Baseline = string | null

/** Tokens consumed by one or more Haiku calls. */
export type Spend = { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number }

declare module 'claude-code' {
  interface PluginState {
    'session-namer': {
      suggestions: Suggestions
      baseline: Baseline
      /** The call that produced the suggestions shown. */
      lastCall: Spend | null
      /** All calls of the session, including those that showed nothing. */
      total: Spend
    }
  }
}
