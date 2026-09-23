import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { assetUrl } from "../api";
import { firstVisibleAssetId } from "../assetLibrary";
import { AssetChooser, useAssetLayout } from "./AssetChooser";
import { defaultFlashEffect } from "../presentationDefaults";
import { evaluateVideoClip } from "@vectspace/presentation-core/video-clip";
import { evaluateChannel, timelineTrackIdentity } from "../timeline";
import {
  KeyframeInspector,
  TimelineSurface,
  type TimelineSurfaceDocument,
  type TimelineSurfaceEventSelection,
  type TimelineSurfaceSelection,
  type TimelineSurfaceTrack,
} from "./TimelineSurface";
import type {
  AmbienceSlot,
  EditorAsset,
  TimelineKeyframe,
  TimelineNode,
  TimelineTrack,
} from "../types";

export type TimelineSelection = TimelineSurfaceSelection;
export type TimelineEventSelection = TimelineSurfaceEventSelection;

const AMBIENCE_SLOTS: readonly AmbienceSlot[] = [
  "slot_1",
  "slot_2",
  "slot_3",
  "slot_4",
];

const TIMELINE_CHANNELS: Record<TimelineTrack["type"], string[]> = {
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
  ambience: ["volume"],
  button: [
    "x",
    "y",
    "width",
    "height",
    "scale_x",
    "scale_y",
    "rotation_deg",
    "opacity",
    "z",
  ],
};
const CHANNELS = TIMELINE_CHANNELS;
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

/**
 * Canonical `TimelineNode` adapter over the shared {@link TimelineSurface}.
 *
 * The story timeline keeps its own domain surface (asset/event controls,
 * standalone media stage) but the ruler, transport, marquee/selection,
 * keyframe drag, easing inspector, keyboard delete and copy/paste are the one
 * shared implementation every workspace uses.
 */
export function TimelineEditor({
  node,
  assets,
  onChange,
  hidePreview = false,
  hideStagePreview = false,
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
  /** Keep the numeric/keyframe inspector but omit the legacy HTML media stage. */
  hideStagePreview?: boolean;
  hideTransport?: boolean;
  playheadOverride?: number;
  playbackStartOverride?: number;
  onPlayheadChange?(value: number): void;
  snapOverride?: number;
  onSnapChange?(value: number): void;
  onSelectionChange?(selection: TimelineSelection | null): void;
  onEventSelectionChange?(selection: TimelineEventSelection | null): void;
}): ReactElement {
  const [internalPlayhead, setInternalPlayhead] = useState(0);
  const assetLayout = useAssetLayout();
  // Hidden assets are never offered as a new default.  Video and SFX tracks
  // require a real asset (a sprite track may inherit the entry asset), so their
  // creation controls are disabled with a reason when nothing is visible.
  const visibleVideo = firstVisibleAssetId(assets, assetLayout, "video");
  const visibleSfx = firstVisibleAssetId(assets, assetLayout, "sfx");
  const [internalSnap, setInternalSnap] = useState(50);
  const [channelName, setChannelName] = useState("x");
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [selectedFrame, setSelectedFrame] =
    useState<TimelineSurfaceSelection | null>(null);
  const [trackType, setTrackType] = useState<TimelineTrack["type"]>("sprite");
  const videoRef = useRef<HTMLVideoElement>(null);
  const playhead = playheadOverride ?? internalPlayhead;
  const playbackStart = playbackStartOverride ?? playhead;
  const snap = snapOverride ?? internalSnap;
  const setSnap = (value: number): void => {
    setInternalSnap(value);
    onSnapChange?.(value);
  };
  const setPlayhead = useCallback(
    (value: number): void => {
      setInternalPlayhead(value);
      onPlayheadChange?.(value);
    },
    [onPlayheadChange],
  );

  const videoTrack = node.tracks.find(
    (track): track is Extract<TimelineTrack, { type: "video" }> =>
      track.type === "video",
  );
  useEffect(() => {
    const video = videoRef.current;
    if (video === null || videoTrack === undefined) return;
    // `videoDuration` mirrors `loadedmetadata`; reading it here makes the
    // effect re-run when the element finally reports its length, so a fixed
    // `playheadOverride` (a paused workspace transport) is synced to the same
    // clip-window target the shared runtime would seek to instead of staying
    // at the clip start.
    const knownSeconds =
      videoDuration !== null && Number.isFinite(videoDuration)
        ? videoDuration / 1_000
        : null;
    const mediaSeconds = Number.isFinite(video.duration)
      ? video.duration
      : knownSeconds;
    if (mediaSeconds === null) return;
    // The standalone stage uses the same window math as the shared runtime
    // session: explicit clip end, media-duration fallback, loop wrap and the
    // terminal hold must agree between authoring and playback.
    const position = evaluateVideoClip(videoTrack, playhead, mediaSeconds);
    if (position === null) return;
    if (Math.abs(video.currentTime - position.desiredSeconds) > 0.04)
      video.currentTime = position.desiredSeconds;
    if (!video.paused && position.atEnd) video.pause();
  }, [playhead, videoDuration, videoTrack]);

  const urls = useMemo(
    () =>
      Object.fromEntries(
        assets.map((asset) => [asset.id, assetUrl(asset.absolute_path)]),
      ),
    [assets],
  );

  const document = useMemo<TimelineSurfaceDocument<TimelineTrack>>(
    () => nodeToSurfaceDocument(node),
    [node],
  );
  const commitDocument = useCallback(
    (next: TimelineSurfaceDocument<TimelineTrack>): void => {
      onChange(surfaceDocumentToNode(next, node));
    },
    [node, onChange],
  );

  const updateTrackData = useCallback(
    (track: TimelineSurfaceTrack<TimelineTrack>, next: TimelineTrack): void => {
      const index = document.tracks.indexOf(track);
      if (index < 0) return;
      const tracks = [...document.tracks];
      tracks[index] = { ...track, data: next };
      commitDocument({ ...document, tracks });
    },
    [commitDocument, document],
  );

  const addTrack = (): void => {
    // A hidden asset must never seed a new track.  A sprite track may inherit
    // the entry asset (`null`), but a video track requires a real asset: when
    // none is visible the operation is refused (the toolbar button is also
    // disabled with a reason).
    const sprite = firstVisibleAssetId(assets, assetLayout, "sprite");
    const video = firstVisibleAssetId(assets, assetLayout, "video");
    const ambienceSlot =
      AMBIENCE_SLOTS.find(
        (slot) =>
          !node.tracks.some(
            (track) => track.type === "ambience" && track.slot === slot,
          ),
      ) ?? "slot_1";
    if (
      trackType === "ambience" &&
      node.tracks.filter((track) => track.type === "ambience").length >=
        AMBIENCE_SLOTS.length
    )
      return;
    if (trackType === "video" && video === null) return;
    const track: TimelineTrack =
      trackType === "sprite"
        ? {
            type: "sprite",
            sprite_id: `sprite_${node.tracks.length + 1}`,
            asset: sprite,
            remove_at_end: false,
            channels: {},
          }
        : trackType === "video"
          ? {
              type: "video",
              asset: video ?? "",
              clip_start_ms: 0,
              clip_end_ms: null,
              loop: false,
              fit: "contain",
              audio_enabled: true,
              channels: {},
            }
          : trackType === "button"
            ? {
                type: "button",
                instance_id: `button_${node.tracks.length + 1}`,
                channels: {},
              }
            : trackType === "ambience"
              ? { type: "ambience", slot: ambienceSlot, channels: {} }
              : { type: trackType, channels: {} };
    onChange({ ...node, tracks: [...node.tracks, track] });
  };

  const addEvent = (event: TimelineNode["events"][number]): void => {
    onChange({
      ...node,
      events: [...node.events, event].sort((a, b) => a.at_ms - b.at_ms),
    });
  };

  const handleSelectionChange = useCallback(
    (selection: TimelineSurfaceSelection | null): void => {
      setSelectedFrame(selection);
      onSelectionChange?.(selection);
    },
    [onSelectionChange],
  );

  const editSelectedKeyframe = (frame: TimelineKeyframe): void => {
    if (selectedFrame === null) return;
    const next = structuredClone(node);
    const frames =
      next.tracks[selectedFrame.track]?.channels[selectedFrame.channel];
    if (frames !== undefined) frames[selectedFrame.index] = frame;
    onChange(next);
  };

  return (
    <div
      className={`timeline-editor${hidePreview ? " timeline-editor-compact" : ""}`}
      tabIndex={-1}
    >
      {!hidePreview && (
        <div
          className={`timeline-preview-pane${hideStagePreview ? " timeline-preview-pane-properties-only" : ""}`}
        >
          {!hideStagePreview && (
            <div className="timeline-preview-stage">
              {node.tracks.map((track, index) =>
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
          )}
          <div className="timeline-properties">
            <strong>时间线属性</strong>
            <label>
              时长{" "}
              <input
                min={1}
                max={1_800_000}
                type="number"
                value={node.duration_ms}
                onChange={(event) =>
                  onChange({
                    ...node,
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
                  node.tracks[selectedFrame.track]?.type !== "video" &&
                  (node.tracks[selectedFrame.track]?.channels[
                    selectedFrame.channel
                  ]?.length ?? 0) >= 2
                }
                frame={selectedFrame.frame}
                onChange={editSelectedKeyframe}
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
      <TimelineSurface<TimelineTrack>
        allowRemoveTrack
        channelName={channelName}
        document={document}
        emptyLabel="暂无轨道"
        onChannelNameChange={setChannelName}
        onChange={commitDocument}
        onEventSelectionChange={onEventSelectionChange}
        onSelectionChange={handleSelectionChange}
        onPlayheadChange={setPlayhead}
        playhead={playhead}
        playbackStart={playbackStart}
        showEvents
        showTransport={!hideTransport}
        snap={snap}
        transportExtras={
          <>
            <select
              aria-label="新建轨道类型"
              value={trackType}
              onChange={(event) => {
                const value = event.currentTarget
                  .value as TimelineTrack["type"];
                setTrackType(value);
                setChannelName(firstItem(CHANNELS[value]) ?? "x");
              }}
            >
              <option value="sprite">立绘轨</option>
              <option value="camera">镜头轨</option>
              <option value="video">视频轨</option>
              <option value="bgm">BGM 音量轨</option>
              <option value="ambience">环境声轨</option>
              <option value="button">按钮轨</option>
            </select>
            <button
              disabled={trackType === "video" && visibleVideo === null}
              onClick={addTrack}
              title={
                trackType === "video" && visibleVideo === null
                  ? "没有可用的视频素材（或全部已隐藏），无法新建视频轨"
                  : undefined
              }
              type="button"
            >
              ＋轨道
            </button>
            <button
              disabled={visibleSfx === null}
              onClick={() => {
                if (visibleSfx === null) return;
                addEvent({
                  type: "sfx",
                  id: uniqueEventId(node, "sfx"),
                  at_ms: Math.round(playhead / snap) * snap,
                  asset: visibleSfx,
                  volume: 1,
                });
              }}
              title={
                visibleSfx === null
                  ? "没有可用的音效素材（或全部已隐藏），无法新建 SFX 事件"
                  : undefined
              }
              type="button"
            >
              ＋SFX 事件
            </button>
            <button
              onClick={() => {
                addEvent({
                  type: "screen_effect",
                  id: uniqueEventId(node, "flash"),
                  at_ms: Math.round(playhead / snap) * snap,
                  effect: defaultFlashEffect(),
                  duration_ms: Math.min(200, node.duration_ms - playhead),
                });
              }}
              type="button"
            >
              ＋闪光事件
            </button>
          </>
        }
        renderTrackConfig={(track) => {
          const data = track.data;
          if (data.type === "sprite") {
            return (
              <div className="timeline-track-config">
                <label>
                  Sprite ID
                  <input
                    value={data.sprite_id}
                    onChange={(event) =>
                      updateTrackData(track, {
                        ...data,
                        sprite_id: event.currentTarget.value,
                      })
                    }
                  />
                </label>
                <label>
                  <input
                    checked={data.remove_at_end}
                    onChange={(event) =>
                      updateTrackData(track, {
                        ...data,
                        remove_at_end: event.currentTarget.checked,
                      })
                    }
                    type="checkbox"
                  />
                  结束后移除
                </label>
              </div>
            );
          }
          if (data.type === "ambience") {
            return (
              <div className="timeline-track-config">
                <label>
                  槽位
                  <select
                    value={data.slot}
                    onChange={(event) => {
                      const slot = event.currentTarget.value as AmbienceSlot;
                      const alreadyUsed = node.tracks.some(
                        (candidate) =>
                          candidate !== data &&
                          candidate.type === "ambience" &&
                          candidate.slot === slot,
                      );
                      if (!alreadyUsed)
                        updateTrackData(track, { ...data, slot });
                    }}
                  >
                    {AMBIENCE_SLOTS.map((slot) => (
                      <option
                        disabled={node.tracks.some(
                          (candidate) =>
                            candidate !== data &&
                            candidate.type === "ambience" &&
                            candidate.slot === slot,
                        )}
                        key={slot}
                        value={slot}
                      >
                        {slot}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            );
          }
          if (data.type === "video") {
            return (
              <div className="timeline-track-config">
                <label>
                  裁剪起点
                  <input
                    min={0}
                    type="number"
                    value={data.clip_start_ms}
                    onChange={(event) =>
                      updateTrackData(track, {
                        ...data,
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
                    value={data.clip_end_ms ?? ""}
                    onChange={(event) =>
                      updateTrackData(track, {
                        ...data,
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
                    value={data.fit}
                    onChange={(event) =>
                      updateTrackData(track, {
                        ...data,
                        fit: event.currentTarget.value as typeof data.fit,
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
                    checked={data.audio_enabled}
                    onChange={(event) =>
                      updateTrackData(track, {
                        ...data,
                        audio_enabled: event.currentTarget.checked,
                      })
                    }
                    type="checkbox"
                  />
                  视频声音
                </label>
                <label>
                  <input
                    checked={data.loop}
                    onChange={(event) =>
                      updateTrackData(track, {
                        ...data,
                        loop: event.currentTarget.checked,
                      })
                    }
                    type="checkbox"
                  />
                  循环片段
                </label>
              </div>
            );
          }
          return null;
        }}
        renderTrackExtra={(track) => {
          const data = track.data;
          if (data.type !== "sprite" && data.type !== "video") return null;
          return (
            <AssetChooser
              allowEmpty={data.type === "sprite"}
              assets={assets}
              emptyLabel="继承进入时素材"
              kind={data.type}
              label={`轨道${data.type === "sprite" ? "立绘" : "视频"}素材`}
              onChange={(asset) => {
                if (data.type === "sprite") {
                  updateTrackData(track, { ...data, asset });
                } else {
                  updateTrackData(track, { ...data, asset: asset ?? "" });
                }
              }}
              value={data.asset ?? null}
            />
          );
        }}
      />
    </div>
  );
}

function nodeToSurfaceDocument(
  node: TimelineNode,
): TimelineSurfaceDocument<TimelineTrack> {
  return {
    duration_ms: node.duration_ms,
    tracks: node.tracks.map((track) => ({
      id: timelineTrackIdentity(track),
      label: trackLabel(track),
      channels: track.channels,
      allowedChannels: CHANNELS[track.type],
      defaults: DEFAULTS,
      allowInherit: track.type !== "video",
      data: track,
    })),
    events: node.events,
  };
}

function surfaceDocumentToNode(
  document: TimelineSurfaceDocument<TimelineTrack>,
  node: TimelineNode,
): TimelineNode {
  return {
    ...node,
    duration_ms: document.duration_ms,
    tracks: document.tracks.map((track) => ({
      ...track.data,
      channels: track.channels,
    })),
    events: document.events,
  };
}

function trackLabel(track: TimelineTrack): string {
  if (track.type === "sprite") return `sprite ${track.sprite_id}`;
  if (track.type === "button") return `button ${track.instance_id}`;
  if (track.type === "ambience") return `ambience ${track.slot}`;
  return track.type;
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
