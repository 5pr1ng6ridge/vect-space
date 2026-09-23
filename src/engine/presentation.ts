/**
 * Game-facing alias of the shared presentation host controller.
 *
 * The implementation lives in `@vectspace/presentation-core` so the game and
 * the editor gameplay preview drive one cue sequencer, one Pixi surface and one
 * timeline session.  This module keeps the app's historical import path stable.
 */
export * from "@vectspace/presentation-core/gameplay-host";
