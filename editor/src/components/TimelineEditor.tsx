import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { assetUrl } from "../api";
import { evaluateChannel } from "../timeline";
import type {
  EditorAsset,
  TimelineEasing,
  TimelineNode,
  TimelineTrack,
} from "../types";

const CHANNELS: Record<TimelineTrack["type"], string[]> = {
  sprite: [
    "x",
    "y",
    "scale",
    "scale_x",
    "scale_y",
    "rotation_deg",
    "opacity",
    "z",
  ],
  camera: ["x", "y", "zoom", "rotation_deg"],
  video: ["x", "y", "width", "height", "opacity", "z", "volume"],
  bgm: ["volume"],
};
const DEFAULTS: Record<string, number> = {
  x: 0,
  y: 0,
  scale: 1,
  scale_x: 1,
  scale_y: 1,
  rotation_deg: 0,
  opacity: 1,
  z: 0,
  zoom: 1,
  width: 1920,
  height: 1080,
  volume: 1,
};

export function TimelineEditor({
  node,
  assets,
  onChange,
}: {
  node: TimelineNode;
  assets: EditorAsset[];
  onChange(node: TimelineNode): void;
}): ReactElement {
  const [dragDraft, setDragDraft] = useState<TimelineNode | null>(null);
  const draft = dragDraft ?? node;
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [snap, setSnap] = useState(50);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [trackType, setTrackType] = useState<TimelineTrack["type"]>("sprite");
  const [channelName, setChannelName] = useState("x");
  const rulerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number): void => {
      const delta = now - previous;
      previous = now;
      setPlayhead((value) => {
        const next = value + delta;
        if (next >= draft.duration_ms) {
          setPlaying(false);
          return draft.duration_ms;
        }
        return next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [draft.duration_ms, playing]);

  const videoTrack = draft.tracks.find(
    (track): track is Extract<TimelineTrack, { type: "video" }> =>
      track.type === "video",
  );
  useEffect(() => {
    const video = videoRef.current;
    if (
      video === null ||
      videoTrack === undefined ||
      !Number.isFinite(video.duration)
    )
      return;
    const desired = videoTrack.clip_start_ms / 1000 + playhead / 1000;
    if (Math.abs(video.currentTime - desired) > 0.04)
      video.currentTime = Math.min(video.duration, desired);
  }, [playhead, videoTrack]);

  const urls = useMemo(
    () =>
      Object.fromEntries(
        assets.map((asset) => [asset.id, assetUrl(asset.absolute_path)]),
      ),
    [assets],
  );
  const commit = (next: TimelineNode): void => {
    onChange(next);
  };
  const updateTrack = (index: number, track: TimelineTrack): void => {
    const tracks = [...draft.tracks];
    tracks[index] = track;
    commit({ ...draft, tracks });
  };
  const addTrack = (): void => {
    const sprite = assets.find((asset) => asset.kind === "sprite")?.id ?? "";
    const video = assets.find((asset) => asset.kind === "video")?.id ?? "";
    const track: TimelineTrack =
      trackType === "sprite"
        ? {
            type: "sprite",
            sprite_id: `sprite_${draft.tracks.length + 1}`,
            asset: sprite,
            remove_at_end: false,
            channels: {},
          }
        : trackType === "video"
          ? {
              type: "video",
              asset: video,
              clip_start_ms: 0,
              clip_end_ms: null,
              loop: false,
              fit: "contain",
              audio_enabled: true,
              channels: {},
            }
          : { type: trackType, channels: {} };
    commit({ ...draft, tracks: [...draft.tracks, track] });
  };
  const selectedFrame = findSelectedFrame(draft, selected);

  const beginDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    key: string,
  ): void => {
    event.preventDefault();
    const selection =
      event.ctrlKey || event.metaKey
        ? new Set(
            selected.has(key)
              ? [...selected].filter((item) => item !== key)
              : [...selected, key],
          )
        : selected.has(key)
          ? new Set(selected)
          : new Set([key]);
    setSelected(selection);
    if (!selection.has(key)) return;
    const initial = structuredClone(draft);
    const startX = event.clientX;
    const width = Math.max(1, rulerRef.current?.clientWidth ?? 1);
    let latest = initial;
    const move = (moveEvent: PointerEvent): void => {
      const delta =
        Math.round(
          (((moveEvent.clientX - startX) / width) * initial.duration_ms) / snap,
        ) * snap;
      latest = structuredClone(initial);
      for (const item of selection) {
        const [trackIndex, channel, frameIndex] = item.split(":");
        const frame =
          latest.tracks[Number(trackIndex)]?.channels[channel]?.[
            Number(frameIndex)
          ];
        const original =
          initial.tracks[Number(trackIndex)]?.channels[channel]?.[
            Number(frameIndex)
          ];
        if (frame !== undefined && original !== undefined) {
          frame.at_ms = Math.max(
            0,
            Math.min(initial.duration_ms, original.at_ms + delta),
          );
        }
      }
      setDragDraft(latest);
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      for (const track of latest.tracks) {
        for (const frames of Object.values(track.channels))
          frames.sort((a, b) => a.at_ms - b.at_ms);
      }
      onChange(latest);
      setDragDraft(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  return (
    <div className="timeline-editor">
      <div className="timeline-preview-pane">
        <div className="timeline-preview-stage">
          {draft.tracks.map((track, index) =>
            track.type === "sprite" ? (
              <img
                alt={track.sprite_id}
                key={`sprite-${index}`}
                src={urls[track.asset]}
                style={spriteStyle(track, playhead)}
              />
            ) : null,
          )}
          {videoTrack !== undefined && (
            <video
              className="timeline-video-preview"
              muted
              onLoadedMetadata={(event) => {
                const element = event.currentTarget;
                setVideoDuration(element.duration * 1000);
                element.currentTime = videoTrack.clip_start_ms / 1000;
              }}
              preload="metadata"
              ref={videoRef}
              src={urls[videoTrack.asset]}
              style={videoStyle(videoTrack, playhead)}
            />
          )}
          <div className="timeline-safe-frame">1920 × 1080</div>
        </div>
        <div className="timeline-properties">
          <strong>时间线属性</strong>
          <label>
            时长{" "}
            <input
              min={1}
              max={1_800_000}
              type="number"
              value={draft.duration_ms}
              onChange={(event) =>
                commit({
                  ...draft,
                  duration_ms: Number(event.currentTarget.value),
                })
              }
            />
          </label>
          <label>
            吸附{" "}
            <select
              value={snap}
              onChange={(event) => setSnap(Number(event.currentTarget.value))}
            >
              <option value={10}>10 ms</option>
              <option value={50}>50 ms</option>
              <option value={100}>100 ms</option>
            </select>
          </label>
          {selectedFrame !== null && (
            <KeyframeInspector
              frame={selectedFrame.frame}
              onChange={(frame) => {
                const next = structuredClone(draft);
                const frames =
                  next.tracks[selectedFrame.track]?.channels[
                    selectedFrame.channel
                  ];
                if (frames !== undefined) frames[selectedFrame.index] = frame;
                commit(next);
              }}
            />
          )}
          {videoTrack !== undefined && (
            <small>
              视频元数据由浏览器读取；裁剪：{videoTrack.clip_start_ms}–
              {videoTrack.clip_end_ms ?? "结尾"} ms；素材时长：
              {videoDuration === null
                ? "读取中"
                : `${Math.round(videoDuration)} ms`}
            </small>
          )}
        </div>
      </div>
      <div className="timeline-transport">
        <button
          onClick={() => {
            if (playhead >= draft.duration_ms) setPlayhead(0);
            setPlaying((value) => !value);
          }}
          type="button"
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <button
          onClick={() => {
            setPlaying(false);
            setPlayhead(0);
          }}
          type="button"
        >
          ■
        </button>
        <code>
          {Math.round(playhead)} / {draft.duration_ms} ms
        </code>
        <input
          aria-label="播放头"
          max={draft.duration_ms}
          min={0}
          onChange={(event) => setPlayhead(Number(event.currentTarget.value))}
          type="range"
          value={playhead}
        />
        <select
          value={trackType}
          onChange={(event) => {
            const value = event.currentTarget.value as TimelineTrack["type"];
            setTrackType(value);
            setChannelName(firstItem(CHANNELS[value]) ?? "x");
          }}
        >
          <option value="sprite">立绘轨</option>
          <option value="camera">镜头轨</option>
          <option value="video">视频轨</option>
          <option value="bgm">BGM 音量轨</option>
        </select>
        <button onClick={addTrack} type="button">
          ＋轨道
        </button>
        <button
          onClick={() => {
            const asset =
              assets.find((candidate) => candidate.kind === "sfx")?.id ?? "";
            const event = {
              type: "sfx" as const,
              id: uniqueEventId(draft, "sfx"),
              at_ms: Math.round(playhead / snap) * snap,
              asset,
              volume: 1,
            };
            commit({
              ...draft,
              events: [...draft.events, event].sort(
                (a, b) => a.at_ms - b.at_ms,
              ),
            });
          }}
          type="button"
        >
          ＋SFX 事件
        </button>
        <button
          onClick={() => {
            const event = {
              type: "screen_effect" as const,
              id: uniqueEventId(draft, "flash"),
              at_ms: Math.round(playhead / snap) * snap,
              effect: "flash" as const,
              duration_ms: Math.min(200, draft.duration_ms - playhead),
            };
            commit({
              ...draft,
              events: [...draft.events, event].sort(
                (a, b) => a.at_ms - b.at_ms,
              ),
            });
          }}
          type="button"
        >
          ＋闪光事件
        </button>
        <button
          disabled={selected.size === 0}
          onClick={() => {
            const next = structuredClone(draft);
            for (const item of [...selected].reverse()) {
              const [track, channel, frame] = item.split(":");
              next.tracks[Number(track)]?.channels[channel]?.splice(
                Number(frame),
                1,
              );
            }
            setSelected(new Set());
            commit(next);
          }}
          type="button"
        >
          删除关键帧
        </button>
      </div>
      <div
        className="timeline-ruler"
        ref={rulerRef}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          setPlayhead(
            Math.round(
              (((event.clientX - rect.left) / rect.width) * draft.duration_ms) /
                snap,
            ) * snap,
          );
        }}
      >
        {Array.from({ length: 11 }, (_, index) => (
          <span key={index} style={{ left: `${index * 10}%` }}>
            {Math.round((draft.duration_ms * index) / 10)}
          </span>
        ))}
        <i
          className="timeline-playhead"
          style={{ left: `${(playhead / draft.duration_ms) * 100}%` }}
        />
      </div>
      <div className="timeline-tracks">
        {draft.tracks.map((track, trackIndex) => (
          <div className="timeline-track" key={`${track.type}-${trackIndex}`}>
            <div className="timeline-track-head">
              <strong>
                {track.type} {track.type === "sprite" ? track.sprite_id : ""}
              </strong>
              {(track.type === "sprite" || track.type === "video") && (
                <select
                  value={track.asset}
                  onChange={(event) =>
                    updateTrack(trackIndex, {
                      ...track,
                      asset: event.currentTarget.value,
                    })
                  }
                >
                  {assets
                    .filter((asset) => asset.kind === track.type)
                    .map((asset) => (
                      <option key={asset.id}>{asset.id}</option>
                    ))}
                </select>
              )}
              <select
                value={channelName}
                onChange={(event) => setChannelName(event.currentTarget.value)}
              >
                {CHANNELS[track.type].map((channel) => (
                  <option key={channel}>{channel}</option>
                ))}
              </select>
              <button
                onClick={() => {
                  const frames = [
                    ...(track.channels[channelName] ?? []).filter(
                      (frame) =>
                        frame.at_ms !== Math.round(playhead / snap) * snap,
                    ),
                    {
                      at_ms: Math.round(playhead / snap) * snap,
                      value: DEFAULTS[channelName] ?? 0,
                      easing: "linear" as const,
                    },
                  ].sort((a, b) => a.at_ms - b.at_ms);
                  updateTrack(trackIndex, {
                    ...track,
                    channels: { ...track.channels, [channelName]: frames },
                  });
                }}
                type="button"
              >
                ＋关键帧
              </button>
              <button
                onClick={() =>
                  commit({
                    ...draft,
                    tracks: draft.tracks.filter(
                      (_, index) => index !== trackIndex,
                    ),
                  })
                }
                type="button"
              >
                ×
              </button>
            </div>
            {track.type === "sprite" && (
              <div className="timeline-track-config">
                <label>
                  Sprite ID
                  <input
                    value={track.sprite_id}
                    onChange={(event) =>
                      updateTrack(trackIndex, {
                        ...track,
                        sprite_id: event.currentTarget.value,
                      })
                    }
                  />
                </label>
                <label>
                  <input
                    checked={track.remove_at_end}
                    onChange={(event) =>
                      updateTrack(trackIndex, {
                        ...track,
                        remove_at_end: event.currentTarget.checked,
                      })
                    }
                    type="checkbox"
                  />
                  结束后移除
                </label>
              </div>
            )}
            {track.type === "video" && (
              <div className="timeline-track-config">
                <label>
                  裁剪起点
                  <input
                    min={0}
                    type="number"
                    value={track.clip_start_ms}
                    onChange={(event) =>
                      updateTrack(trackIndex, {
                        ...track,
                        clip_start_ms: Number(event.currentTarget.value),
                      })
                    }
                  />
                </label>
                <label>
                  裁剪终点
                  <input
                    min={0}
                    placeholder="视频结尾"
                    type="number"
                    value={track.clip_end_ms ?? ""}
                    onChange={(event) =>
                      updateTrack(trackIndex, {
                        ...track,
                        clip_end_ms:
                          event.currentTarget.value === ""
                            ? null
                            : Number(event.currentTarget.value),
                      })
                    }
                  />
                </label>
                <label>
                  适配
                  <select
                    value={track.fit}
                    onChange={(event) =>
                      updateTrack(trackIndex, {
                        ...track,
                        fit: event.currentTarget.value as typeof track.fit,
                      })
                    }
                  >
                    <option value="contain">contain</option>
                    <option value="cover">cover</option>
                    <option value="stretch">stretch</option>
                  </select>
                </label>
                <label>
                  <input
                    checked={track.audio_enabled}
                    onChange={(event) =>
                      updateTrack(trackIndex, {
                        ...track,
                        audio_enabled: event.currentTarget.checked,
                      })
                    }
                    type="checkbox"
                  />
                  视频声音
                </label>
                <label>
                  <input
                    checked={track.loop}
                    onChange={(event) =>
                      updateTrack(trackIndex, {
                        ...track,
                        loop: event.currentTarget.checked,
                      })
                    }
                    type="checkbox"
                  />
                  循环片段
                </label>
              </div>
            )}
            {Object.entries(track.channels).map(([channel, frames]) => (
              <div className="timeline-channel" key={channel}>
                <label>{channel}</label>
                <div>
                  {frames.map((frame, frameIndex) => {
                    const key = `${trackIndex}:${channel}:${frameIndex}`;
                    return (
                      <button
                        aria-label={`${channel} ${frame.at_ms}ms`}
                        className={selected.has(key) ? "selected" : ""}
                        key={key}
                        onPointerDown={(event) => beginDrag(event, key)}
                        style={{
                          left: `${(frame.at_ms / draft.duration_ms) * 100}%`,
                        }}
                        title={`${frame.at_ms} ms · ${frame.value}`}
                        type="button"
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ))}
        <div className="timeline-track timeline-event-track">
          <div className="timeline-track-head">
            <strong>events</strong>
            <small>单击定位；双击删除</small>
          </div>
          <div className="timeline-channel">
            <label>瞬时事件</label>
            <div>
              {draft.events.map((event) => (
                <button
                  aria-label={`${event.id} ${event.at_ms}ms`}
                  className={`timeline-event-marker event-${event.type}`}
                  key={event.id}
                  onClick={() => setPlayhead(event.at_ms)}
                  onDoubleClick={() =>
                    commit({
                      ...draft,
                      events: draft.events.filter(
                        (candidate) => candidate.id !== event.id,
                      ),
                    })
                  }
                  style={{
                    left: `${(event.at_ms / draft.duration_ms) * 100}%`,
                  }}
                  title={`${event.id} · ${event.type} · ${event.at_ms} ms`}
                  type="button"
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function KeyframeInspector({
  frame,
  onChange,
}: {
  frame: { at_ms: number; value: number; easing: TimelineEasing };
  onChange(frame: {
    at_ms: number;
    value: number;
    easing: TimelineEasing;
  }): void;
}): ReactElement {
  const cubic =
    typeof frame.easing === "object"
      ? frame.easing.cubic_bezier
      : ([0.25, 0.1, 0.25, 1] as [number, number, number, number]);
  return (
    <div className="keyframe-inspector">
      <label>
        时间{" "}
        <input
          type="number"
          value={frame.at_ms}
          onChange={(event) =>
            onChange({ ...frame, at_ms: Number(event.currentTarget.value) })
          }
        />
      </label>
      <label>
        数值{" "}
        <input
          type="number"
          step="0.01"
          value={frame.value}
          onChange={(event) =>
            onChange({ ...frame, value: Number(event.currentTarget.value) })
          }
        />
      </label>
      <label>
        缓动{" "}
        <select
          value={typeof frame.easing === "object" ? "cubic" : frame.easing}
          onChange={(event) =>
            onChange({
              ...frame,
              easing:
                event.currentTarget.value === "cubic"
                  ? { cubic_bezier: cubic }
                  : (event.currentTarget.value as TimelineEasing),
            })
          }
        >
          <option value="step">step</option>
          <option value="linear">linear</option>
          <option value="ease_in">ease in</option>
          <option value="ease_out">ease out</option>
          <option value="ease_in_out">ease in/out</option>
          <option value="cubic">cubic-bezier</option>
        </select>
      </label>
      {typeof frame.easing === "object" && (
        <>
          <svg
            aria-label="贝塞尔缓动曲线"
            className="cubic-preview"
            viewBox="0 0 100 100"
          >
            <path d="M 0 100 L 100 0" />
            <path
              className="curve"
              d={`M 0 100 C ${cubic[0] * 100} ${100 - cubic[1] * 100}, ${cubic[2] * 100} ${100 - cubic[3] * 100}, 100 0`}
            />
          </svg>
          <div className="cubic-controls">
            {cubic.map((value, index) => (
              <input
                aria-label={`Bezier ${index + 1}`}
                key={index}
                max={index % 2 === 0 ? 1 : 4}
                min={index % 2 === 0 ? 0 : -4}
                step="0.01"
                type="number"
                value={value}
                onChange={(event) => {
                  const next = [...cubic] as [number, number, number, number];
                  next[index] = Number(event.currentTarget.value);
                  onChange({ ...frame, easing: { cubic_bezier: next } });
                }}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function findSelectedFrame(node: TimelineNode, selected: Set<string>) {
  const key = selected.values().next().value;
  if (key === undefined) return null;
  const [track, channel, index] = key.split(":");
  const frame = node.tracks[Number(track)]?.channels[channel]?.[Number(index)];
  return frame === undefined || channel === undefined
    ? null
    : { track: Number(track), channel, index: Number(index), frame };
}

function firstItem<T>(values: readonly T[]): T | undefined {
  for (const value of values) return value;
  return undefined;
}

function uniqueEventId(node: TimelineNode, prefix: string): string {
  const used = new Set(node.events.map((event) => event.id));
  let index = node.events.length + 1;
  while (used.has(`${prefix}_${index}`)) index += 1;
  return `${prefix}_${index}`;
}

function spriteStyle(
  track: Extract<TimelineTrack, { type: "sprite" }>,
  time: number,
): React.CSSProperties {
  const scale = evaluateChannel(track.channels, "scale", time, 1);
  return {
    position: "absolute",
    left: `${evaluateChannel(track.channels, "x", time, 960) / 19.2}%`,
    top: `${evaluateChannel(track.channels, "y", time, 1080) / 10.8}%`,
    opacity: evaluateChannel(track.channels, "opacity", time, 1),
    zIndex: Math.round(evaluateChannel(track.channels, "z", time, 0)),
    transformOrigin: "50% 100%",
    transform: `translate(-50%, -100%) rotate(${evaluateChannel(track.channels, "rotation_deg", time, 0)}deg) scale(${scale * evaluateChannel(track.channels, "scale_x", time, 1)}, ${scale * evaluateChannel(track.channels, "scale_y", time, 1)})`,
  };
}
function videoStyle(
  track: Extract<TimelineTrack, { type: "video" }>,
  time: number,
): React.CSSProperties {
  return {
    position: "absolute",
    left: `${evaluateChannel(track.channels, "x", time, 0) / 19.2}%`,
    top: `${evaluateChannel(track.channels, "y", time, 0) / 10.8}%`,
    width: `${evaluateChannel(track.channels, "width", time, 1920) / 19.2}%`,
    height: `${evaluateChannel(track.channels, "height", time, 1080) / 10.8}%`,
    objectFit: track.fit === "stretch" ? "fill" : track.fit,
    opacity: evaluateChannel(track.channels, "opacity", time, 1),
    zIndex: Math.round(evaluateChannel(track.channels, "z", time, 0)),
  };
}
