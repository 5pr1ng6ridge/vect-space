import { useRef, useState, type CSSProperties, type ReactElement } from "react";

import type { ImageAssetSource } from "@vectspace/presentation-core/image-animation";

import { useAnimatedImage } from "./useAnimatedImage";

interface AnimatedImageProps {
  source: ImageAssetSource | null | undefined;
  /**
   * Decoration rule input: the host passes the same "paused" condition it
   * uses for the Pixi surface (menu open, page hidden, replay idle).
   */
  paused: boolean;
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
}

/**
 * One image element whose pixels may come from a static file or a loop
 * animation.
 *
 * The rendered `<img>` keeps a single intrinsic size for the whole loop, so a
 * frame change never reflows the layout it participates in (dialogue chrome,
 * paper artwork, buttons, chapter map).
 */
export function AnimatedImage({
  source,
  paused,
  className,
  style,
  fallbackUrl,
  alt = "",
  lockLayoutSize = false,
  width,
  height,
  onError,
}: AnimatedImageProps): ReactElement | null {
  const {
    url,
    width: animationWidth,
    height: animationHeight,
  } = useAnimatedImage(source, paused);
  const sourceKey = `${source?.asset ?? ""}:${source?.animation?.id ?? ""}`;
  const [failureState, setFailureState] = useState<{
    sourceKey: string;
    urls: ReadonlySet<string>;
  }>({ sourceKey: "", urls: new Set() });
  // Keep a failed-frame fallback scoped to the current logical asset.  The
  // key is checked during render instead of resetting state from an effect,
  // which avoids an extra cascading render whenever a new asset is selected.
  const failedUrls =
    failureState.sourceKey === sourceKey ? failureState.urls : EMPTY_URLS;
  const candidates = [
    url,
    ...(source?.animation?.frames.map((frame) => frame.url) ?? []),
    fallbackUrl ?? undefined,
  ].filter((candidate): candidate is string =>
    Boolean(candidate && !failedUrls.has(candidate)),
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
      draggable={false}
      height={height}
      ref={ref}
      src={resolved}
      style={layout}
      width={width}
      onError={() => {
        setFailureState((previous) => {
          const urls =
            previous.sourceKey === sourceKey
              ? new Set(previous.urls)
              : new Set<string>();
          urls.add(resolved);
          return { sourceKey, urls };
        });
        onError?.(new Error(`图片加载失败：${resolved}`));
      }}
    />
  );
}

const EMPTY_URLS: ReadonlySet<string> = new Set();
