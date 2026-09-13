/**
 * Game-facing alias of the shared animated-image hook.
 *
 * The implementation lives in `@vectspace/presentation-react`; the app keeps
 * this module so existing imports, and the paused/asset-identity contract they
 * rely on, stay stable.
 */
export {
  staticImageSource,
  useAnimatedImage,
  useAnimationPreload,
  type AnimatedImageState,
} from "@vectspace/presentation-react/animated-image";
