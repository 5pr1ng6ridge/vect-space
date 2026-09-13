/**
 * Editor-facing alias of the shared animated image component.
 *
 * The frame-loop adapter lives in `@vectspace/presentation-react` so the game,
 * the inspector previews and every editor workspace show the same frame of the
 * same asset under the same paused/decorative-clock rules.  This module keeps
 * the editor's historical prop names (`EditorAnimatedImageProps`) stable.
 */
export { AnimatedImage } from "@vectspace/presentation-react/animated-image";
export type { AnimatedImageProps as EditorAnimatedImageProps } from "@vectspace/presentation-react/animated-image";
