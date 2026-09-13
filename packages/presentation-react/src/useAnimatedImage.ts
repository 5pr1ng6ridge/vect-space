import { useEffect, useMemo, useReducer } from "react";

import {
  FrameSequencePlayer,
  imageAssetSourceVersion,
  type ImageAssetSource,
} from "@vectspace/presentation-core/image-animation";

/**
 * Wraps a plain url in the shared source shape.
 *
 * Static entry points keep working unchanged: the caller says what the image
 * is, not how its pixels are produced.
 */
export function staticImageSource(
  url: string | null | undefined,
): ImageAssetSource | null {
  if (url === null || url === undefined || url === "") return null;
  return { asset: url, url, width: 0, height: 0 };
}

/**
 * Preloads every frame of an animated source before the first swap, so an
 * entry that paints through CSS (paper, map decoration) never shows a
 * half-loaded frame.
 */
export function useAnimationPreload(
  source: ImageAssetSource | null | undefined,
  onError?: (error: Error) => void,
): void {
  const frames = source?.animation?.frames;
  const key = frames?.map((frame) => frame.url).join("|") ?? "";
  useEffect(() => {
    if (key === "") return;
    let active = true;
    void Promise.all(
      key.split("|").map(async (url) => {
        const image = new Image();
        image.decoding = "async";
        image.src = url;
        try {
          if (typeof image.decode === "function") {
            await image.decode();
          } else {
            await new Promise<void>((resolve, reject) => {
              image.onload = () => resolve();
              image.onerror = () => reject(new Error(`图片加载失败：${url}`));
            });
          }
        } catch (error) {
          if (active) {
            onError?.(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        }
      }),
    );
    return () => {
      active = false;
    };
  }, [key, onError]);
}

export interface AnimatedImageState {
  url: string | undefined;
  width: number | undefined;
  height: number | undefined;
  isAnimated: boolean;
  frameIndex: number;
  seek(elapsedMs: number): void;
}

/**
 * Drives one instance's decorative frame loop.
 *
 * The frame index is derived during render from the player, and the player
 * notifies through a render counter; nothing is written back into state from
 * an effect, so a re-render can never restart a loop.  The player is created
 * once per (instance, asset) pair: moving, scaling or re-rendering the
 * surrounding React tree keeps it, while a different asset id replaces it with
 * a fresh player positioned on the first frame.
 */
export function useAnimatedImage(
  source: ImageAssetSource | null | undefined,
  paused: boolean,
): AnimatedImageState {
  const sourceVersion = imageAssetSourceVersion(source);

  const player = useMemo(() => {
    if (source == null) return null;
    return new FrameSequencePlayer(source);
    // Asset identity, not object identity: the host re-resolves every asset on
    // bootstrap and a re-render must not disturb a running loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceVersion]);

  const [, forceRender] = useReducer((count: number) => count + 1, 0);

  useEffect(() => {
    if (player === null) return undefined;
    const unsubscribe = player.subscribe(() => forceRender());
    return () => {
      unsubscribe();
      player.dispose();
    };
  }, [player]);

  useEffect(() => {
    if (player === null) return undefined;
    player.setPaused(paused);
    if (paused || !player.isAnimated) return undefined;
    let active = true;
    let handle = 0;
    let last = performance.now();
    const tick = (): void => {
      if (!active) return;
      const now = performance.now();
      const delta = now - last;
      last = now;
      player.advance(delta);
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => {
      active = false;
      cancelAnimationFrame(handle);
    };
  }, [paused, player]);

  return {
    url: player?.frame()?.url ?? source?.url,
    width: source?.animation?.width,
    height: source?.animation?.height,
    isAnimated: player?.isAnimated ?? false,
    frameIndex: player?.frameIndex() ?? -1,
    seek: (elapsedMs: number) => {
      player?.seek(elapsedMs);
    },
  };
}
