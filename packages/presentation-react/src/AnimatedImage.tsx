import {
  useRef,
  useState,
  type CSSProperties,
  type PointerEventHandler,
  type ReactElement,
} from "react";

import {
  imageAssetSourceVersion,
  type ImageAssetSource,
} from "@vectspace/presentation-core/image-animation";

import { useAnimatedImage } from "./useAnimatedImage";

export interface AnimatedImageProps {
  source: ImageAssetSource | null | undefined;
  /**
   * Decoration rule input: the host passes the same "paused" condition it
   * uses for the Pixi surface (menu open, page hidden, replay idle).
   * Defaults to `false`, so a static editor thumbnail plays unless told not to.
   */
  paused?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Rendered when the asset is unknown, so a missing frame is never blank. */
  fallbackUrl?: string | null;
  alt?: string;
  /** Locks the box to the animation's measured size instead of the frame's. */
  lockLayoutSize?: boolean;
  /**
   * Fixed box size in CSS pixels.  Callers that own a design-space layout pass
   * their author-time size here so a frame change can never reflow it.
   */
  width?: number;
  height?: number;
  onError?: (error: Error) => void;
  /** Editor surfaces allow dragging artwork without the browser ghost. */
  draggable?: boolean;
  onPointerDown?: PointerEventHandler<HTMLImageElement>;
}

/**
 * One image element whose pixels may come from a static file or a loop
 * animation.
 *
 * The rendered `<img>` keeps a single intrinsic size for the whole loop, so a
 * frame change never reflows the layout it participates in (dialogue chrome,
 * paper artwork, buttons, chapter map).  A source that cannot produce any
 * usable url renders nothing and reports through `onError`, which lets a
 * template-driven host fall back to its text skin instead of locking.
 */
export function AnimatedImage({
  source,
  paused = false,
  className,
  style,
  fallbackUrl,
  alt = "",
  lockLayoutSize = false,
  width,
  height,
  onError,
  draggable = false,
  onPointerDown,
}: AnimatedImageProps): ReactElement | null {
  const {
    url,
    width: animationWidth,
    height: animationHeight,
  } = useAnimatedImage(source, paused);
  const sourceKey = imageSourceKey(source, fallbackUrl);
  const [failureState, setFailureState] = useState<{
    sourceKey: string;
    urls: ReadonlySet<string>;
  }>({ sourceKey: "", urls: EMPTY_URLS });
  const failureStateRef = useRef(failureState);
  // Keep failed-frame fallback scoped to the current logical asset and its
  // fallback candidate.  Resetting the ref during render is intentional: it
  // lets an error event that arrives before effects flush use the new source
  // immediately, without a state-reset effect and its extra render.
  if (failureStateRef.current.sourceKey !== sourceKey) {
    failureStateRef.current = { sourceKey, urls: EMPTY_URLS };
  }
  const failedUrls =
    failureState.sourceKey === sourceKey ? failureState.urls : EMPTY_URLS;
  const candidates = candidateUrls(source, url, fallbackUrl).filter(
    (candidate) => !failedUrls.has(candidate),
  );
  const resolved = candidates[0];
  const ref = useRef<HTMLImageElement>(null);
  if (resolved === undefined) return null;
  const layout: CSSProperties =
    lockLayoutSize &&
    animationWidth !== undefined &&
    animationHeight !== undefined
      ? { ...style, width: animationWidth, height: animationHeight }
      : (style ?? {});
  return (
    <img
      alt={alt}
      className={className}
      draggable={draggable}
      height={height}
      ref={ref}
      src={resolved}
      style={layout}
      width={width}
      onPointerDown={onPointerDown}
      onError={() => {
        const previous =
          failureStateRef.current.sourceKey === sourceKey
            ? failureStateRef.current.urls
            : EMPTY_URLS;
        if (previous.has(resolved)) return;
        const failed = new Set(previous);
        failed.add(resolved);
        const next = { sourceKey, urls: failed };
        failureStateRef.current = next;
        setFailureState(next);
        // A frame error is recoverable while any distinct source URL remains.
        // Only the final exhausted candidate is a host-level artwork failure;
        // otherwise an animated asset with one bad frame would be demoted even
        // though the player can still display another frame.
        const remaining = candidateUrls(source, url, fallbackUrl).some(
          (candidate) => !failed.has(candidate),
        );
        if (!remaining) onError?.(new Error(`图片加载失败：${resolved}`));
      }}
    />
  );
}

const EMPTY_URLS: ReadonlySet<string> = new Set();

function imageSourceKey(
  source: ImageAssetSource | null | undefined,
  fallbackUrl: string | null | undefined,
): string {
  return `${imageAssetSourceVersion(source)}\0${fallbackUrl ?? ""}`;
}

function candidateUrls(
  source: ImageAssetSource | null | undefined,
  currentUrl: string | undefined,
  fallbackUrl: string | null | undefined,
): string[] {
  return [
    currentUrl,
    source?.url,
    ...(source?.animation?.frames.map((frame) => frame.url) ?? []),
    fallbackUrl ?? undefined,
  ].filter(
    (candidate, index, all): candidate is string =>
      Boolean(candidate) && all.indexOf(candidate) === index,
  );
}
