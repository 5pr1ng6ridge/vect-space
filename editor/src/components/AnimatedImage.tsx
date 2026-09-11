import {
  useEffect,
  useMemo,
  useReducer,
  type CSSProperties,
  type PointerEventHandler,
  type ReactElement,
} from "react";
import {
  FrameSequencePlayer,
  imageAssetSourceVersion,
  type ImageAssetSource,
} from "@vectspace/presentation-core/image-animation";

export interface EditorAnimatedImageProps {
  source: ImageAssetSource | null | undefined;
  paused?: boolean;
  className?: string;
  style?: CSSProperties;
  alt?: string;
  onError?: (error: Error) => void;
  draggable?: boolean;
  onPointerDown?: PointerEventHandler<HTMLImageElement>;
}

/** Editor counterpart of the game's image wrapper. Only the rAF adapter lives
 * here; frame selection and decorative clock semantics come from the shared
 * presentation package. */
export function AnimatedImage({
  source,
  paused = false,
  className,
  style,
  alt = "",
  onError,
  draggable = false,
  onPointerDown,
}: EditorAnimatedImageProps): ReactElement | null {
  const identity = imageAssetSourceVersion(source);
  // A changed logical asset starts at its first frame. Re-rendering a
  // workspace with the same asset must keep its current frame.
  const player = useMemo(
    () =>
      source === undefined || source === null
        ? null
        : new FrameSequencePlayer(source),
    [identity], // eslint-disable-line react-hooks/exhaustive-deps -- identity is the deliberate lifecycle key; equivalent source objects must not restart it.
  );
  const [, render] = useReducer((value: number) => value + 1, 0);

  useEffect(() => {
    if (player === null) return undefined;
    const unsubscribe = player.subscribe(() => render());
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
    let previous = performance.now();
    const tick = (now: number): void => {
      if (!active) return;
      player.advance(Math.max(0, now - previous));
      previous = now;
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => {
      active = false;
      cancelAnimationFrame(handle);
    };
  }, [paused, player]);

  const url = player?.url() ?? source?.url;
  if (url === undefined) return null;
  return (
    <img
      alt={alt}
      className={className}
      draggable={draggable}
      onError={() => onError?.(new Error(`图片加载失败：${url}`))}
      onPointerDown={onPointerDown}
      src={url}
      style={style}
    />
  );
}
