/**
 * Domain-neutral keyframe surface.
 *
 * Story timelines, reusable sprite actions, button templates and UI motion
 * presets all author the same interaction: a ruler with a scrubbable playhead,
 * a transport, marquee/multi selection, draggable keyframe markers, an easing
 * (including cubic-bezier) inspector for the selected keyframe, keyboard
 * delete and an in-app copy/paste clipboard.
 *
 * The surface deliberately knows nothing about `TimelineNode`, button states
 * or UI targets.  It operates on {@link TimelineSurfaceDocument}, a plain
 * document of self-describing tracks whose domain payload travels untouched in
 * `data`.  Each workspace adapts its own schema to this contract instead of
 * forcing every domain into the story scene schema.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  copyTimelineKeyframesFrom,
  pasteTimelineKeyframesInto,
  snapTimelineTime,
  type TimelineKeyframeClipboard,
} from "../timeline";
import { evaluateChannel } from "@vectspace/presentation-core/timeline";
import type {
  TimelineChannels,
  TimelineEvent,
  TimelineKeyframe,
} from "../types";
import { ClipboardPaste, Copy, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import { IconButton } from "../ui/Button";
import { channelLabel } from "../labels";
import { isEditableTarget } from "./nodeDeleteShortcut";
import { MAX_ZOOM, MIN_ZOOM, clampZoom, rulerTicks } from "./timelineRuler";

export interface TimelineSurfaceTrack<TData = unknown> {
  /** Stable identity used for copy/paste addressing and React keys. */
  id: string;
  /** Human label rendered in the track head. */
  label: string;
  channels: TimelineChannels;
  /** Channels offered by the per-track channel picker and "＋关键帧". */
  allowedChannels: readonly string[];
  /** Fallback value per channel for a new keyframe / 0 ms anchor. */
  defaults: Record<string, number>;
  /** Whether an "inherit" keyframe is valid on this track (default true). */
  allowInherit?: boolean;
  /** Opaque domain payload the surface never inspects. */
  data: TData;
}

export interface TimelineSurfaceDocument<TData = unknown> {
  duration_ms: number;
  tracks: TimelineSurfaceTrack<TData>[];
  events: TimelineEvent[];
}

export interface TimelineSurfaceSelection {
  track: number;
  channel: string;
  index: number;
  frame: TimelineKeyframe;
}

export interface TimelineSurfaceEventSelection {
  index: number;
  event: TimelineEvent;
}

export interface TimelineSurfaceTrackApi<TData> {
  index: number;
  channelName: string;
  setChannelName(name: string): void;
  updateTrack(track: TimelineSurfaceTrack<TData>): void;
  removeTrack(): void;
}

interface MarqueeBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * One process-wide clipboard shared by every surface so a keyframe copied in
 * one workspace can be pasted into another (they share the same channel
 * vocabulary even though their documents differ).
 */
let surfaceClipboard: TimelineKeyframeClipboard | null = null;

export function TimelineSurface<TData>({
  document: doc,
  onChange,
  playhead,
  playbackStart = 0,
  onPlayheadChange,
  snap = 50,
  channelName,
  onChannelNameChange,
  onSelectionChange,
  onEventSelectionChange,
  showTransport = true,
  showEvents = false,
  allowRemoveTrack = true,
  keyboardPlayback = false,
  onDraftChange,
  transportExtras,
  renderTrackExtra,
  renderTrackConfig,
  renderEventInspector,
  className,
  emptyLabel = "暂无可编辑的关键帧",
}: {
  document: TimelineSurfaceDocument<TData>;
  onChange(next: TimelineSurfaceDocument<TData>): void;
  playhead: number;
  playbackStart?: number;
  onPlayheadChange(value: number): void;
  snap?: number;
  /** Channel targeted by the per-track "＋关键帧" control. */
  channelName: string;
  onChannelNameChange(name: string): void;
  onSelectionChange?(selection: TimelineSurfaceSelection | null): void;
  onEventSelectionChange?(
    selection: TimelineSurfaceEventSelection | null,
  ): void;
  showTransport?: boolean;
  showEvents?: boolean;
  allowRemoveTrack?: boolean;
  /** Toggle play/pause with the space bar (for workspaces without one). */
  keyboardPlayback?: boolean;
  /** Live document while a keyframe drag is in progress (ends with null). */
  onDraftChange?(document: TimelineSurfaceDocument<TData> | null): void;
  /** Extra transport controls (domain add-track / add-event buttons). */
  transportExtras?: ReactNode;
  renderTrackExtra?(
    track: TimelineSurfaceTrack<TData>,
    api: TimelineSurfaceTrackApi<TData>,
  ): ReactNode;
  renderTrackConfig?(
    track: TimelineSurfaceTrack<TData>,
    api: TimelineSurfaceTrackApi<TData>,
  ): ReactNode;
  renderEventInspector?(event: TimelineEvent, index: number): ReactNode;
  className?: string;
  emptyLabel?: string;
}): ReactElement {
  const [dragDraft, setDragDraft] =
    useState<TimelineSurfaceDocument<TData> | null>(null);
  const draft = dragDraft ?? doc;
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<MarqueeBox | null>(null);
  const [clipboardStatus, setClipboardStatus] = useState<string | null>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const tracksRef = useRef<HTMLDivElement>(null);
  // Horizontal zoom of the lanes: 1 fits the whole duration in the view.
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    const element = tracksRef.current;
    if (element === null) return;
    // Ctrl/⌘+wheel zooms the lanes (non-passive, so the page never zooms).
    const handleWheel = (event: WheelEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.deltaY === 0) return;
      event.preventDefault();
      setZoom((current) =>
        clampZoom(current * (event.deltaY < 0 ? 1.25 : 1 / 1.25)),
      );
    };
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, []);
  const clipboardStatusTimerRef = useRef<number | null>(null);
  const playheadRef = useRef(playhead);

  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);

  const setPlayhead = useCallback(
    (value: number): void => {
      playheadRef.current = value;
      onPlayheadChange(value);
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
      const next = playheadRef.current + delta;
      if (next >= draft.duration_ms) {
        setPlaying(false);
        setPlayhead(draft.duration_ms);
        return;
      }
      setPlayhead(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [draft.duration_ms, playing, setPlayhead]);

  useEffect(() => {
    if (!keyboardPlayback) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== "Space" || isEditableTarget(event.target)) return;
      event.preventDefault();
      if (playheadRef.current >= draft.duration_ms) setPlayhead(0);
      setPlaying((value) => !value);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [draft.duration_ms, keyboardPlayback, setPlayhead]);

  const commit = useCallback(
    (next: TimelineSurfaceDocument<TData>): void => {
      onChange(next);
    },
    [onChange],
  );

  const updateTrack = useCallback(
    (index: number, track: TimelineSurfaceTrack<TData>): void => {
      const tracks = [...draft.tracks];
      tracks[index] = track;
      commit({ ...draft, tracks });
    },
    [commit, draft],
  );

  const addKeyframe = useCallback(
    (trackIndex: number, requestedChannel: string, atMs: number): void => {
      const track = draft.tracks[trackIndex];
      if (track === undefined) return;
      // The surface keeps one shared channel picker, but a channel selected on
      // one track may not exist on another (e.g. `z` on a camera track).
      // Normalize to a channel the target track actually allows instead of
      // writing an unsupported channel into the domain document.
      const channel = track.allowedChannels.includes(requestedChannel)
        ? requestedChannel
        : track.allowedChannels[0];
      if (channel === undefined) return;
      const at = Math.max(
        0,
        Math.min(
          draft.duration_ms,
          snapTimelineTime(atMs, snap, playbackStart),
        ),
      );
      const frames = [
        ...(track.channels[channel] ?? []).filter(
          (frame) => frame.at_ms !== at,
        ),
        {
          at_ms: at,
          value: evaluateChannel(
            track.channels,
            channel,
            at,
            track.defaults[channel] ?? 0,
          ),
          easing: "linear" as const,
        },
      ].sort((left, right) => left.at_ms - right.at_ms);
      updateTrack(trackIndex, {
        ...track,
        channels: { ...track.channels, [channel]: frames },
      });
    },
    [draft, playbackStart, snap, updateTrack],
  );

  const selectedFrame = findSelectedFrame(draft, selected);
  const selectedFrameSignature =
    selectedFrame === null
      ? ""
      : `${selectedFrame.track}:${selectedFrame.channel}:${selectedFrame.index}:${selectedFrame.frame.at_ms}:${selectedFrame.frame.value}:${JSON.stringify(selectedFrame.frame.easing)}`;
  // Keep the latest callback in a ref so an inline parent handler cannot
  // re-fire the synchronization on every render (which would loop when the
  // parent mirrors the selection back into state).
  const selectionCallbackRef = useRef(onSelectionChange);
  const eventSelectionCallbackRef = useRef(onEventSelectionChange);
  useEffect(() => {
    selectionCallbackRef.current = onSelectionChange;
    eventSelectionCallbackRef.current = onEventSelectionChange;
  });
  useEffect(() => {
    selectionCallbackRef.current?.(selectedFrame);
    // findSelectedFrame intentionally returns a fresh object for easy edits;
    // the primitive signature prevents this synchronization from firing on
    // every render and causing a parent state loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFrameSignature]);

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
    eventSelectionCallbackRef.current?.(selectedEvent);
    // selectedEvent is derived from the stable signature for the same reason
    // as keyframe selection above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEventSignature]);

  const deleteSelected = useCallback((): void => {
    if (selected.size === 0) return;
    const next = structuredClone(draft);
    for (const item of [...selected].sort(compareSelectionKeys)) {
      const [track, channel, frame] = item.split(":");
      const channels = next.tracks[Number(track)]?.channels;
      const frames = channels?.[channel];
      if (frames === undefined) continue;
      frames.splice(Number(frame), 1);
      if (frames.length === 0) delete channels?.[channel];
    }
    setSelected(new Set());
    onChange(next);
  }, [draft, onChange, selected]);

  const deleteSelectedEvent = useCallback((): void => {
    if (selectedEventId === null) return;
    setSelectedEventId(null);
    commit({
      ...draft,
      events: draft.events.filter(
        (candidate) => candidate.id !== selectedEventId,
      ),
    });
  }, [commit, draft, selectedEventId]);

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
    const clipboard = copyTimelineKeyframesFrom(
      draft.tracks,
      (track: TimelineSurfaceTrack<TData>) => track.id,
      [...selected].map(selectionAddress),
    );
    if (clipboard === null) {
      showClipboardStatus("请先选择关键帧");
      return;
    }
    surfaceClipboard = clipboard;
    showClipboardStatus(`已复制 ${clipboard.items.length} 个关键帧`);
  }, [draft, selected, showClipboardStatus]);

  const pasteCopied = useCallback((): void => {
    if (surfaceClipboard === null) {
      showClipboardStatus("关键帧剪贴板为空");
      return;
    }
    const result = pasteTimelineKeyframesInto(
      draft,
      (track: TimelineSurfaceTrack<TData>) => track.id,
      (track: TimelineSurfaceTrack<TData>) => track.allowedChannels,
      (track: TimelineSurfaceTrack<TData>) => track.allowInherit !== false,
      surfaceClipboard,
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
    onChange(result.document);
    showClipboardStatus(
      `已粘贴 ${result.pasted.length} 个关键帧${result.skipped > 0 ? `，跳过 ${result.skipped} 个` : ""}`,
    );
  }, [draft, onChange, playbackStart, playhead, showClipboardStatus, snap]);

  useEffect(() => {
    const handleClipboardKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isEditableTarget(event.target)) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        if (selected.size > 0) {
          event.preventDefault();
          deleteSelected();
          return;
        }
        if (selectedEventId !== null) {
          event.preventDefault();
          deleteSelectedEvent();
          return;
        }
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "c" && selected.size > 0) {
        event.preventDefault();
        copySelected();
      } else if (key === "v" && surfaceClipboard !== null) {
        event.preventDefault();
        pasteCopied();
      }
    };
    window.addEventListener("keydown", handleClipboardKey);
    return () => window.removeEventListener("keydown", handleClipboardKey);
  }, [
    copySelected,
    deleteSelected,
    deleteSelectedEvent,
    pasteCopied,
    selected.size,
    selectedEventId,
  ]);

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
      onDraftChange?.(latest);
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
      onDraftChange?.(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  const trackApis = useMemo(
    () =>
      draft.tracks.map((track, index) => ({
        index,
        channelName,
        setChannelName: onChannelNameChange,
        updateTrack: (next: TimelineSurfaceTrack<TData>) =>
          updateTrack(index, next),
        removeTrack: () =>
          commit({
            ...draft,
            tracks: draft.tracks.filter(
              (_candidate, candidateIndex) => candidateIndex !== index,
            ),
          }),
      })),
    [channelName, commit, draft, onChannelNameChange, updateTrack],
  );

  return (
    <div
      className={`timeline-surface${showTransport ? " timeline-surface-with-transport" : ""}${className === undefined ? "" : ` ${className}`}`}
    >
      {showTransport && (
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
          {transportExtras}
        </div>
      )}
      <div
        className="timeline-tracks"
        onPointerDown={beginMarquee}
        ref={tracksRef}
        style={{ "--timeline-zoom": zoom } as CSSProperties}
      >
        <div className="timeline-ruler-row">
          <div className="timeline-clipboard-tools">
            <IconButton
              disabled={selected.size === 0}
              icon={Copy}
              label="复制"
              onClick={copySelected}
              shortcut="Ctrl+C"
              size="sm"
              tooltip="复制所选关键帧"
            />
            <IconButton
              disabled={surfaceClipboard === null}
              icon={ClipboardPaste}
              label="粘贴"
              onClick={pasteCopied}
              shortcut="Ctrl+V"
              size="sm"
              tooltip="粘贴到播放头"
            />
            <IconButton
              disabled={selected.size === 0}
              icon={Trash2}
              label="删除关键帧"
              onClick={deleteSelected}
              shortcut="Delete"
              size="sm"
            />
            <span aria-hidden="true" className="timeline-tools-divider" />
            <IconButton
              disabled={zoom <= MIN_ZOOM}
              icon={ZoomOut}
              label="缩小时间轴"
              onClick={() => setZoom((current) => clampZoom(current / 1.5))}
              shortcut="Ctrl+滚轮"
              size="sm"
            />
            <IconButton
              disabled={zoom >= MAX_ZOOM}
              icon={ZoomIn}
              label="放大时间轴"
              onClick={() => setZoom((current) => clampZoom(current * 1.5))}
              shortcut="Ctrl+滚轮"
              size="sm"
            />
            {selected.size > 0 && <span>已选 {selected.size}</span>}
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
            {rulerTicks(draft.duration_ms, zoom).map((tick) => (
              <span
                key={tick.at}
                style={{
                  left: `${(tick.at / Math.max(1, draft.duration_ms)) * 100}%`,
                }}
              >
                {tick.label}
              </span>
            ))}
            <i
              className="timeline-playback-start"
              style={{
                left: `${(playbackStart / Math.max(1, draft.duration_ms)) * 100}%`,
              }}
            />
            <i
              className="timeline-playhead"
              style={{
                left: `${(playhead / Math.max(1, draft.duration_ms)) * 100}%`,
              }}
            />
          </div>
        </div>
        {draft.tracks.map((track, trackIndex) => {
          const api = trackApis[trackIndex];
          if (api === undefined) return null;
          return (
            <div className="timeline-track" key={`${track.id}-${trackIndex}`}>
              <div className="timeline-track-head">
                <strong>{track.label}</strong>
                {renderTrackExtra?.(track, api)}
                <select
                  aria-label="关键帧通道"
                  value={trackChannel(track, channelName)}
                  onChange={(event) =>
                    onChannelNameChange(event.currentTarget.value)
                  }
                >
                  {track.allowedChannels.map((channel) => (
                    <option key={channel} value={channel}>
                      {channelLabel(channel)}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() =>
                    addKeyframe(
                      trackIndex,
                      trackChannel(track, channelName),
                      playhead,
                    )
                  }
                  type="button"
                >
                  ＋关键帧
                </button>
                {allowRemoveTrack && (
                  <IconButton
                    icon={Trash2}
                    label={`删除轨道 ${track.label}`}
                    onClick={() => api.removeTrack()}
                    size="sm"
                  />
                )}
              </div>
              {renderTrackConfig?.(track, api)}
              {track.allowedChannels
                .filter(
                  // Only channels with keyframes (plus the one picked in the
                  // channel menu) get a row, so tracks stay compact.
                  (channel) =>
                    (track.channels[channel]?.length ?? 0) > 0 ||
                    channel === trackChannel(track, channelName),
                )
                .map((channel) => {
                  const frames = track.channels[channel] ?? [];
                  return (
                    <div className="timeline-channel" key={channel}>
                      <label title={`${channel} · 双击右侧空白处添加关键帧`}>
                        {channelLabel(channel)}
                      </label>
                      <div
                        onDoubleClick={(event) => {
                          if (event.target instanceof HTMLButtonElement) return;
                          const rect =
                            event.currentTarget.getBoundingClientRect();
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
                                left: `${(frame.at_ms / Math.max(1, draft.duration_ms)) * 100}%`,
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
          );
        })}
        {draft.tracks.length === 0 && (
          <p className="timeline-surface-empty">{emptyLabel}</p>
        )}
        {showEvents && (
          <div className="timeline-track timeline-event-track">
            <div className="timeline-track-head">
              <strong>事件</strong>
              <small>单击选中并定位 · Delete 删除</small>
            </div>
            <div className="timeline-channel">
              <label>瞬时事件</label>
              <div>
                {draft.events.map((event) => (
                  <button
                    aria-label={`${event.id} ${event.at_ms}ms`}
                    className={`timeline-event-marker event-${event.type}${selectedEventId === event.id ? " selected" : ""}`}
                    key={event.id}
                    onClick={() => {
                      setSelectedEventId(event.id);
                      setPlayhead(event.at_ms);
                    }}
                    style={{
                      left: `${(event.at_ms / Math.max(1, draft.duration_ms)) * 100}%`,
                    }}
                    title={`${event.id} · ${event.type} · ${event.at_ms} ms`}
                    type="button"
                  />
                ))}
              </div>
            </div>
          </div>
        )}
        {marquee !== null && (
          <div className="timeline-selection-marquee" style={marquee} />
        )}
      </div>
      {selectedEvent !== null &&
        renderEventInspector?.(selectedEvent.event, selectedEvent.index)}
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

function snapDragDelta<TData>(
  rawDelta: number,
  snap: number,
  snapPoint: number,
  doc: TimelineSurfaceDocument<TData>,
  selection: ReadonlySet<string>,
): number {
  const gridDelta =
    Math.round(rawDelta / Math.max(1, snap)) * Math.max(1, snap);
  let closestMarkerDelta: number | null = null;
  for (const key of selection) {
    const { track, channel, index } = selectionAddress(key);
    const frame = doc.tracks[track]?.channels[channel]?.[index];
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

/**
 * Normalize the shared channel picker to a channel the track allows.
 *
 * The surface has one channel selection shared by every track head.  When the
 * selection does not exist on a given track (a sprite `z` while a camera track
 * is focused) the track head falls back to its first allowed channel, and
 * "＋关键帧" uses that same normalized channel.
 */
function trackChannel<TData>(
  track: TimelineSurfaceTrack<TData>,
  channelName: string,
): string {
  return track.allowedChannels.includes(channelName)
    ? channelName
    : (track.allowedChannels[0] ?? channelName);
}

function findSelectedFrame<TData>(
  doc: TimelineSurfaceDocument<TData>,
  selected: Set<string>,
): TimelineSurfaceSelection | null {
  const key = selected.values().next().value;
  if (key === undefined) return null;
  const [track, channel, index] = key.split(":");
  const frame = doc.tracks[Number(track)]?.channels[channel]?.[Number(index)];
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
