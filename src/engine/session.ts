/**
 * Game-facing alias of the shared session transition guard.
 *
 * The implementation lives in `@vectspace/presentation-core` so the game and
 * the editor gameplay preview both reject stale async completions with the same
 * generation/session bookkeeping.  This module keeps the app's historical
 * import path stable.
 */
export * from "@vectspace/presentation-core/session-transition";
