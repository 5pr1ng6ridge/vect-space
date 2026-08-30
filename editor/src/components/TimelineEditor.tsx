import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { assetUrl } from "../api";
import {
  copyTimelineKeyframes,
  evaluateChannel,
  pasteTimelineKeyframes,
  snapTimelineTime,
  type TimelineKeyframeClipboard,
} from "../timeline";
import type {
  EditorAsset,
  TimelineEasing,
  TimelineEvent,
  TimelineKeyframe,
  TimelineNode,
  TimelineTrack,
} from "../types";

export interface TimelineSelection {
  track: number;
  channel: string;
  index: number;
  frame: TimelineKeyframe;
}

export interface TimelineEventSelection {
  index: number;
  event: TimelineEvent;
}

interface MarqueeBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

let keyframeClipboard: TimelineKeyframeClipboard | null = null;

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
  hidePreview = false,
  hideTransport = false,
  playheadOverride,
  playbackStartOverride,
  onPlayheadChange,
  snapOverride,
  onSnapChange,
  onSelectionChange,
  onEventSelectionChange,
}: {
  node: TimelineNode;
  assets: EditorAsset[];
  onChange(node: TimelineNode): void;
  hidePreview?: boolean;
  hideTransport?: boolean;
  playheadOverride?: number;
  playbackStartOverride?: number;
  onPlayheadChange?(value: number): void;
  snapOverride?: number;
  onSnapChange?(value: number): void;
  onSelectionChange?(selection: TimelineSelection | null): void;
  onEventSelectionChange?(selection: TimelineEventSelection | null): void;
}): ReactElement {
  const [dragDraft, setDragDraft] = useState<TimelineNode | null>(null);
  const draft = dragDraft ?? node;
  const [internalPlayhead, setInternalPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [internalSnap, setInternalSnap] = useState(50);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<MarqueeBox | null>(null);
  const [clipboardStatus, setClipboardStatus] = useState<string | null>(null);
  const [trackType, setTrackType] = useState<TimelineTrack["type"]>("sprite");
  const [channelName, setChannelName] = useState("x");
  const rulerRef = useRef<HTMLDivElement>(null);
  const tracksRef = useRef<HTMLDivElement>(null);
  const clipboardStatusTimerRef = useRef<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playhead = playheadOverride ?? internalPlayhead;
  const playbackStart = playbackStartOverride ?? playhead;
  const snap = snapOverride ?? internalSnap;
  const setSnap = (value: number): void => {
    setInternalSnap(value);
    onSnapChange?.(value);
  };
  const setPlayhead = useCallback(
    (value: number | ((current: number) => number)): void => {
      setInternalPlayhead((current) => {
        const next = typeof value === "function" ? value(current) : value;
        onPlayheadChange?.(next);
        return next;
      });
    },
    [onPlayheadChange],
  );

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
  }, [draft.duration_ms, playing, setPlayhead]);

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
  const addKeyframe = (
    trackIndex: number,
    channel: string,
    atMs: number,
  ): void => {
    const track = draft.tracks[trackIndex];
    if (track === undefined) return;
    const at = Math.max(
      0,
      Math.min(draft.duration_ms, snapTimelineTime(atMs, snap, playbackStart)),
    );
    const frames = [
      ...(track.channels[channel] ?? []).filter((frame) => frame.at_ms !== at),
      {
        at_ms: at,
        value: evaluateChannel(
          track.channels,
          channel,
          at,
          DEFAULTS[channel] ?? 0,
        ),
        easing: "linear" as const,
      },
    ].sort((left, right) => left.at_ms - right.at_ms);
    updateTrack(trackIndex, {
      ...track,
      channels: { ...track.channels, [channel]: frames },
    });
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
  const selectedFrameSignature =
    selectedFrame === null
      ? ""
      : `${selectedFrame.track}:${selectedFrame.channel}:${selectedFrame.index}:${selectedFrame.frame.at_ms}:${selectedFrame.frame.value}:${JSON.stringify(selectedFrame.frame.easing)}`;
  useEffect(() => {
    onSelectionChange?.(selectedFrame);
    // findSelectedFrame intentionally returns a fresh object for easy edits;
    // the primitive signature prevents this synchronization from firing on
    // every render and causing a parent state loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSelectionChange, selectedFrameSignature]);
  const selectedEvent =
    selectedEventId === null
      ? null
      : (() => {
          const index = draft.events.findIndex(
            (event) => event.id === selectedEventId,
          );
          const event = draft.events[index];
          return event === undefined ? null : { index, event };
        })();
  const selectedEventSignature =
    selectedEvent === null
      ? ""
      : `${selectedEvent.index}:${selectedEvent.event.id}:${selectedEvent.event.at_ms}:${JSON.stringify(selectedEvent.event)}`;
  useEffect(() => {
    onEventSelectionChange?.(selectedEvent);
    // selectedEvent is derived from the stable signature for the same reason
    // as keyframe selection above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onEventSelectionChange, selectedEventSignature]);
  const deleteSelected = useCallback((): void => {
    if (selected.size === 0) return;
    const next = structuredClone(draft);
    for (const item of [...selected].sort(compareSelectionKeys)) {
      const [track, channel, frame] = item.split(":");
      next.tracks[Number(track)]?.channels[channel]?.splice(Number(frame), 1);
    }
    setSelected(new Set());
    onChange(next);
  }, [draft, onChange, selected]);

  const showClipboardStatus = useCallback((message: string): void => {
    setClipboardStatus(message);
    if (clipboardStatusTimerRef.current !== null)
      window.clearTimeout(clipboardStatusTimerRef.current);
    clipboardStatusTimerRef.current = window.setTimeout(
      () => setClipboardStatus(null),
      2400,
    );
  }, []);

  useEffect(
    () => () => {
      if (clipboardStatusTimerRef.current !== null)
        window.clearTimeout(clipboardStatusTimerRef.current);
    },
    [],
  );

  const copySelected = useCallback((): void => {
    const clipboard = copyTimelineKeyframes(
      draft,
      [...selected].map(selectionAddress),
    );
    if (clipboard === null) {
      showClipboardStatus("请先选择关键帧");
      return;
    }
    keyframeClipboard = clipboard;
    showClipboardStatus(`已复制 ${clipboard.items.length} 个关键帧`);
  }, [draft, selected, showClipboardStatus]);

  const pasteCopied = useCallback((): void => {
    if (keyframeClipboard === null) {
      showClipboardStatus("关键帧剪贴板为空");
      return;
    }
    const result = pasteTimelineKeyframes(
      draft,
      keyframeClipboard,
      playhead,
      snap,
      playbackStart,
    );
    if (result.pasted.length === 0) {
      showClipboardStatus(
        result.skipped > 0
          ? "目标轨道不存在或关键帧超出时间线"
          : "没有可粘贴的关键帧",
      );
      return;
    }
    setSelected(
      new Set(
        result.pasted.map(
          ({ track, channel, index }) => `${track}:${channel}:${index}`,
        ),
      ),
    );
    setSelectedEventId(null);
    onChange(result.node);
    showClipboardStatus(
      `已粘贴 ${result.pasted.length} 个关键帧${result.skipped > 0 ? `，跳过 ${result.skipped} 个` : ""}`,
    );
  }, [draft, onChange, playbackStart, playhead, showClipboardStatus, snap]);

  useEffect(() => {
    const handleClipboardKey = (event: KeyboardEvent): void => {
      if (isEditableTarget(event.target)) return;
      if (event.key === "Delete" && selected.size > 0) {
        event.preventDefault();
        deleteSelected();
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "c" && selected.size > 0) {
        event.preventDefault();
        copySelected();
      } else if (key === "v" && keyframeClipboard !== null) {
        event.preventDefault();
        pasteCopied();
      }
    };
    window.addEventListener("keydown", handleClipboardKey);
    return () => window.removeEventListener("keydown", handleClipboardKey);
  }, [copySelected, deleteSelected, pasteCopied, selected.size]);

  const beginMarquee = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || tracksRef.current === null) return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(
        "button, input, select, textarea, .timeline-track-head, .timeline-track-config",
      ) !== null
    ) {
      return;
    }
    event.preventDefault();
    setSelectedEventId(null);
    const container = tracksRef.current;
    const startX = event.clientX;
    const startY = event.clientY;
    const additive = event.ctrlKey || event.metaKey;
    const base = additive ? new Set(selected) : new Set<string>();
    let moved = false;
    const move = (moveEvent: PointerEvent): void => {
      if (
        Math.abs(moveEvent.clientX - startX) > 2 ||
        Math.abs(moveEvent.clientY - startY) > 2
      ) {
        moved = true;
      }
      const left = Math.min(startX, moveEvent.clientX);
      const right = Math.max(startX, moveEvent.clientX);
      const top = Math.min(startY, moveEvent.clientY);
      const bottom = Math.max(startY, moveEvent.clientY);
      const bounds = container.getBoundingClientRect();
      setMarquee({
        left: left - bounds.left + container.scrollLeft,
        top: top - bounds.top + container.scrollTop,
        width: right - left,
        height: bottom - top,
      });
      const next = new Set(base);
      for (const marker of container.querySelectorAll<HTMLElement>(
        "[data-keyframe-key]",
      )) {
        const rect = marker.getBoundingClientRect();
        if (
          rect.right >= left &&
          rect.left <= right &&
          rect.bottom >= top &&
          rect.top <= bottom
        ) {
          const key = marker.dataset.keyframeKey;
          if (key !== undefined) next.add(key);
        }
      }
      setSelected(next);
    };
    const finish = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      setMarquee(null);
      if (!moved && !additive) setSelected(new Set());
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  };

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
    setSelectedEventId(null);
    if (!selection.has(key)) return;
    const initial = structuredClone(draft);
    const startX = event.clientX;
    const width = Math.max(1, rulerRef.current?.clientWidth ?? 1);
    let latest = initial;
    const move = (moveEvent: PointerEvent): void => {
      const rawDelta =
        ((moveEvent.clientX - startX) / width) * initial.duration_ms;
      const delta = snapDragDelta(
        rawDelta,
        snap,
        playbackStart,
        initial,
        selection,
      );
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
          if (original.value === "inherit") continue;
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
      const selectedFrames = [...selection].flatMap((item) => {
        const { track, channel, index } = selectionAddress(item);
        const frame = latest.tracks[track]?.channels[channel]?.[index];
        return frame === undefined ? [] : [{ track, channel, frame }];
      });
      for (const track of latest.tracks) {
        for (const frames of Object.values(track.channels))
          frames.sort((a, b) => a.at_ms - b.at_ms);
      }
      setSelected(
        new Set(
          selectedFrames.flatMap(({ track, channel, frame }) => {
            const index =
              latest.tracks[track]?.channels[channel]?.indexOf(frame);
            return index === undefined || index < 0
              ? []
              : [`${track}:${channel}:${index}`];
          }),
        ),
      );
      onChange(latest);
      setDragDraft(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  return (
    <div
      className={`timeline-editor${hidePreview ? " timeline-editor-compact" : ""}`}
      tabIndex={-1}
    >
      {!hidePreview && (
        <div className="timeline-preview-pane">
          <div className="timeline-preview-stage">
            {draft.tracks.map((track, index) =>
              track.type === "sprite" && track.asset !== null ? (
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
                allowInherit={
                  selectedFrame.index === 0 &&
                  draft.tracks[selectedFrame.track]?.type !== "video" &&
                  (draft.tracks[selectedFrame.track]?.channels[
                    selectedFrame.channel
                  ]?.length ?? 0) >= 2
                }
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
      )}
      {!hideTransport && (
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
            onClick={deleteSelected}
            type="button"
          >
            删除关键帧
          </button>
        </div>
      )}
      <div className="timeline-ruler-row">
        <div className="timeline-clipboard-tools">
          <button
            disabled={selected.size === 0}
            onClick={copySelected}
            type="button"
          >
            复制
          </button>
          <button
            disabled={keyframeClipboard === null}
            onClick={pasteCopied}
            type="button"
          >
            粘贴
          </button>
          <span>
            {selected.size > 0 ? `${selected.size} 已选` : "拖框多选"}
          </span>
        </div>
        <div
          className="timeline-ruler"
          ref={rulerRef}
          onClick={(event) => {
            if (event.target !== event.currentTarget) return;
            const rect = event.currentTarget.getBoundingClientRect();
            setPlayhead(
              Math.round(
                (((event.clientX - rect.left) / rect.width) *
                  draft.duration_ms) /
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
            className="timeline-playback-start"
            style={{ left: `${(playbackStart / draft.duration_ms) * 100}%` }}
          />
          <i
            className="timeline-playhead"
            style={{ left: `${(playhead / draft.duration_ms) * 100}%` }}
          />
        </div>
      </div>
      <div
        className="timeline-tracks"
        onPointerDown={beginMarquee}
        ref={tracksRef}
      >
        {draft.tracks.map((track, trackIndex) => (
          <div className="timeline-track" key={`${track.type}-${trackIndex}`}>
            <div className="timeline-track-head">
              <strong>
                {track.type} {track.type === "sprite" ? track.sprite_id : ""}
              </strong>
              {(track.type === "sprite" || track.type === "video") && (
                <select
                  value={track.asset ?? ""}
                  onChange={(event) => {
                    const asset = event.currentTarget.value;
                    if (track.type === "sprite") {
                      updateTrack(trackIndex, {
                        ...track,
                        asset: asset === "" ? null : asset,
                      });
                    } else {
                      updateTrack(trackIndex, { ...track, asset });
                    }
                  }}
                >
                  {track.type === "sprite" && (
                    <option value="">继承进入时素材</option>
                  )}
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
                onClick={() => addKeyframe(trackIndex, channelName, playhead)}
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
            {CHANNELS[track.type].map((channel) => {
              const frames = track.channels[channel] ?? [];
              return (
                <div className="timeline-channel" key={channel}>
                  <label title="双击轨道空白处可快速添加关键帧">
                    {channel}
                  </label>
                  <div
                    onDoubleClick={(event) => {
                      if (event.target instanceof HTMLButtonElement) return;
                      const rect = event.currentTarget.getBoundingClientRect();
                      const atMs =
                        ((event.clientX - rect.left) / rect.width) *
                        draft.duration_ms;
                      const snapped = Math.max(
                        0,
                        Math.min(
                          draft.duration_ms,
                          snapTimelineTime(atMs, snap, playbackStart),
                        ),
                      );
                      setPlayhead(snapped);
                      addKeyframe(trackIndex, channel, snapped);
                    }}
                    title="双击空白处添加关键帧"
                  >
                    {frames.map((frame, frameIndex) => {
                      const key = `${trackIndex}:${channel}:${frameIndex}`;
                      return (
                        <button
                          aria-label={`${channel} ${frame.at_ms}ms`}
                          className={`${selected.has(key) ? "selected" : ""}${frame.value === "inherit" ? " inherited" : ""}`}
                          data-keyframe-key={key}
                          key={key}
                          onPointerDown={(event) => beginDrag(event, key)}
                          style={{
                            left: `${(frame.at_ms / draft.duration_ms) * 100}%`,
                          }}
                          title={`${frame.at_ms} ms · ${frame.value === "inherit" ? "继承入口值" : frame.value}`}
                          type="button"
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}
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
                  onClick={() => {
                    setSelectedEventId(event.id);
                    setPlayhead(event.at_ms);
                  }}
                  onDoubleClick={() => {
                    setSelectedEventId(null);
                    commit({
                      ...draft,
                      events: draft.events.filter(
                        (candidate) => candidate.id !== event.id,
                      ),
                    });
                  }}
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
        {marquee !== null && (
          <div className="timeline-selection-marquee" style={marquee} />
        )}
      </div>
      {clipboardStatus !== null && (
        <div className="timeline-clipboard-status" role="status">
          {clipboardStatus}
        </div>
      )}
    </div>
  );
}

function selectionAddress(key: string): {
  track: number;
  channel: string;
  index: number;
} {
  const [track, channel = "", index] = key.split(":");
  return { track: Number(track), channel, index: Number(index) };
}

function snapDragDelta(
  rawDelta: number,
  snap: number,
  snapPoint: number,
  node: TimelineNode,
  selection: ReadonlySet<string>,
): number {
  const gridDelta =
    Math.round(rawDelta / Math.max(1, snap)) * Math.max(1, snap);
  let closestMarkerDelta: number | null = null;
  for (const key of selection) {
    const { track, channel, index } = selectionAddress(key);
    const frame = node.tracks[track]?.channels[channel]?.[index];
    if (frame === undefined || frame.value === "inherit") continue;
    const candidate = snapPoint - frame.at_ms;
    if (
      closestMarkerDelta === null ||
      Math.abs(candidate - rawDelta) < Math.abs(closestMarkerDelta - rawDelta)
    ) {
      closestMarkerDelta = candidate;
    }
  }
  return closestMarkerDelta !== null &&
    Math.abs(closestMarkerDelta - rawDelta) <= Math.abs(gridDelta - rawDelta)
    ? closestMarkerDelta
    : gridDelta;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function KeyframeInspector({
  allowInherit,
  frame,
  onChange,
}: {
  allowInherit: boolean;
  frame: TimelineKeyframe;
  onChange(frame: TimelineKeyframe): void;
}): ReactElement {
  const cubic =
    typeof frame.easing === "object"
      ? frame.easing.cubic_bezier
      : ([0.25, 0.1, 0.25, 1] as [number, number, number, number]);
  return (
    <div className="keyframe-inspector">
      <label>
        值来源{" "}
        <select
          value={frame.value === "inherit" ? "inherit" : "number"}
          onChange={(event) =>
            onChange({
              ...frame,
              at_ms: event.currentTarget.value === "inherit" ? 0 : frame.at_ms,
              value: event.currentTarget.value === "inherit" ? "inherit" : 0,
            })
          }
        >
          <option value="number">固定数值</option>
          {allowInherit && <option value="inherit">继承入口值</option>}
        </select>
      </label>
      <label>
        时间{" "}
        <input
          disabled={frame.value === "inherit"}
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
          disabled={frame.value === "inherit"}
          type="number"
          step="0.01"
          value={frame.value === "inherit" ? 0 : frame.value}
          onChange={(event) =>
            onChange({ ...frame, value: Number(event.currentTarget.value) })
          }
        />
      </label>
      {frame.value === "inherit" && (
        <small>0 ms 时从真实进入状态读取此通道。</small>
      )}
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

function findSelectedFrame(
  node: TimelineNode,
  selected: Set<string>,
): TimelineSelection | null {
  const key = selected.values().next().value;
  if (key === undefined) return null;
  const [track, channel, index] = key.split(":");
  const frame = node.tracks[Number(track)]?.channels[channel]?.[Number(index)];
  return frame === undefined || channel === undefined
    ? null
    : { track: Number(track), channel, index: Number(index), frame };
}

function compareSelectionKeys(left: string, right: string): number {
  const [leftTrack, leftChannel, leftIndex] = left.split(":");
  const [rightTrack, rightChannel, rightIndex] = right.split(":");
  const trackDelta = Number(rightTrack) - Number(leftTrack);
  if (trackDelta !== 0) return trackDelta;
  const channelDelta = (rightChannel ?? "").localeCompare(leftChannel ?? "");
  if (channelDelta !== 0) return channelDelta;
  return Number(rightIndex) - Number(leftIndex);
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
