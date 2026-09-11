import {
  FrameSequencePlayer,
  type AnimationSource,
  type ImageAssetSource,
} from "@vectspace/presentation-core/image-animation";
import { useCallback, useEffect, useState, type ReactElement } from "react";

export interface PreviewFrame {
  /** Logical asset id of the frame image. */
  asset: string;
  /** Resolved url of that frame. */
  url: string;
  duration_ms: number;
}

export interface FrameSequencePreviewProps {
  frames: readonly PreviewFrame[];
  label: string;
  width?: number | null;
  height?: number | null;
  className?: string;
}

/**
 * Shared decorative frame preview.
 *
 * Playback runs through the shared `FrameSequencePlayer`, whose clock is
 * *decorative*: pausing stops time instead of banking it, so resuming always
 * continues on the frame the author saw.  The editor never hand-rolls a second
 * frame-selection rule.
 */
export function FrameSequencePreview(
  props: FrameSequencePreviewProps,
): ReactElement {
  const signature = [
    props.label,
    props.width ?? "",
    props.height ?? "",
    ...props.frames.map(
      (frame) => `${frame.asset}:${frame.duration_ms}:${frame.url}`,
    ),
  ].join("|");
  // Remounting on a signature change gives every edited frame list a fresh
  // player at elapsed 0, without an effect that would reset state after paint.
  return <FrameSequenceLoop key={signature} {...props} />;
}

function FrameSequenceLoop({
  frames,
  label,
  width,
  height,
  className = "asset-preview",
}: FrameSequencePreviewProps): ReactElement {
  // A player is created once per mounted frame list and is never rebuilt for a
  // re-render, so a moving preview cannot restart its own loop.
  const [player] = useState(
    () => new FrameSequencePlayer(buildSource(frames, label, width, height)),
  );
  const [elapsedMs, setElapsedMs] = useState(0);
  const [playing, setPlaying] = useState(true);

  useEffect(() => () => player.dispose(), [player]);

  useEffect(() => {
    player.setPaused(!playing);
    if (!playing) return;
    let handle = 0;
    let previous: number | null = null;
    const tick = (timestamp: number): void => {
      const delta = previous === null ? 0 : timestamp - previous;
      previous = timestamp;
      player.advance(delta);
      setElapsedMs(player.clock.elapsedMs());
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [player, playing]);

  const seekToIndex = useCallback(
    (index: number): void => {
      const count = frames.length;
      if (count === 0) return;
      const target = ((index % count) + count) % count;
      let offset = 0;
      for (let cursor = 0; cursor < target; cursor += 1) {
        offset += frames[cursor]?.duration_ms ?? 0;
      }
      player.seek(offset);
      setElapsedMs(player.clock.elapsedMs());
    },
    [frames, player],
  );

  const frameIndex = frames.length === 0 ? -1 : player.frameIndex();
  const current = frameIndex >= 0 ? frames[frameIndex] : undefined;
  const total = frames.reduce((sum, frame) => sum + frame.duration_ms, 0);
  const size =
    width === null ||
    width === undefined ||
    height === null ||
    height === undefined
      ? "尺寸未知"
      : `${width} × ${height}`;

  return (
    <div className="frame-sequence-preview">
      {current === undefined ? (
        <div className={`${className} frame-sequence-empty`}>还没有帧</div>
      ) : (
        <img
          alt={`${label} 第 ${frameIndex + 1} 帧`}
          className={className}
          src={current.url}
        />
      )}
      <div className="frame-sequence-controls">
        <button
          aria-label="上一帧"
          disabled={frames.length === 0}
          onClick={() => seekToIndex(frameIndex - 1)}
          type="button"
        >
          ◀
        </button>
        <button
          aria-label={playing ? "暂停" : "播放"}
          disabled={frames.length === 0}
          onClick={() => setPlaying((currentPlaying) => !currentPlaying)}
          type="button"
        >
          {playing ? "暂停" : "播放"}
        </button>
        <button
          aria-label="下一帧"
          disabled={frames.length === 0}
          onClick={() => seekToIndex(frameIndex + 1)}
          type="button"
        >
          ▶
        </button>
        <small>
          第 {frameIndex + 1} / {frames.length} 帧 · 总时长 {total} ms · {size}
        </small>
        <small className="muted">
          已播放 {Math.floor(elapsedMs)} ms（装饰时钟）
        </small>
      </div>
    </div>
  );
}

function buildSource(
  frames: readonly PreviewFrame[],
  label: string,
  width: number | null | undefined,
  height: number | null | undefined,
): ImageAssetSource {
  const animation: AnimationSource | undefined =
    frames.length === 0
      ? undefined
      : {
          id: label,
          width: width ?? 0,
          height: height ?? 0,
          total_duration_ms: frames.reduce(
            (sum, frame) => sum + frame.duration_ms,
            0,
          ),
          frames: frames.map((frame) => ({
            asset: frame.asset,
            url: frame.url,
            duration_ms: frame.duration_ms,
          })),
        };
  return {
    asset: label,
    url: frames[0]?.url ?? "",
    width: width ?? 0,
    height: height ?? 0,
    animation,
  };
}
