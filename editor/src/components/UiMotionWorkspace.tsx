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
import { evaluateChannel } from "../timeline";
import type {
  EditorAsset,
  TimelineEasing,
  TimelineKeyframe,
  UiMotionFile,
  UiMotionPreset,
  UiMotionTarget,
} from "../types";
import { UiMotionHost } from "../../../src/engine/uiMotion";
import { MarkupPreview } from "./MarkupPreview";

const TARGET_LABELS: Record<UiMotionTarget, string> = {
  dialogue_root: "对话框整体",
  dialogue_frame: "对话框图片",
  dialogue_nameplate: "姓名框",
  dialogue_text: "正文",
  dialogue_advance_indicator: "推进标记",
};

const CHANNELS = [
  "offset_x",
  "offset_y",
  "scale_x",
  "scale_y",
  "rotation_deg",
  "opacity",
] as const;

interface Selection {
  track: number;
  channel: string;
  frame: number;
}

export function UiMotionWorkspace({
  file,
  assets,
  dirty,
  onBack,
  onChange,
  onSave,
  onUndo,
  onRedo,
}: {
  file: UiMotionFile;
  assets: EditorAsset[];
  dirty: boolean;
  onBack(): void;
  onChange(file: UiMotionFile): void;
  onSave(): void;
  onUndo(): void;
  onRedo(): void;
}): ReactElement {
  const [gestureDraft, setGestureDraft] = useState<UiMotionPreset | null>(null);
  const draft = gestureDraft ?? file.definition;
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState<UiMotionTarget>(
    file.definition.tracks[0]?.target ?? "dialogue_root",
  );
  const [selection, setSelection] = useState<Selection | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [previewScale, setPreviewScale] = useState(0.5);
  const host = useMemo(() => new UiMotionHost(), []);
  const playheadRef = useRef(playhead);

  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);

  const commit = useCallback(
    (next: UiMotionPreset): void => {
      setGestureDraft(null);
      onChange({ ...file, definition: next });
    },
    [file, onChange],
  );

  useEffect(() => {
    const element = previewRef.current;
    if (element === null) return;
    const update = (): void => {
      const bounds = element.getBoundingClientRect();
      setPreviewScale(
        Math.max(0.05, Math.min(bounds.width / 1920, bounds.height / 1080)),
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    host.reconcileDialogueVisible(true);
    host.apply(draft, playhead, draft.duration_ms);
  }, [draft, host, playhead]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number): void => {
      const delta = now - previous;
      previous = now;
      setPlayhead((current) => {
        const next = current + delta;
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.code === "Space" &&
        !(event.target instanceof HTMLInputElement)
      ) {
        event.preventDefault();
        if (playheadRef.current >= draft.duration_ms) setPlayhead(0);
        setPlaying((value) => !value);
      } else if (event.key === "Escape") onBack();
      else if (
        event.key === "Delete" &&
        !(event.target instanceof HTMLInputElement) &&
        selection !== null
      ) {
        const next = structuredClone(draft);
        const frames =
          next.tracks[selection.track]?.channels[selection.channel];
        if (frames !== undefined) {
          frames.splice(selection.frame, 1);
          if (frames.length === 0) {
            Reflect.deleteProperty(
              next.tracks[selection.track]?.channels ?? {},
              selection.channel,
            );
          }
          setSelection(null);
          commit(next);
        }
      } else if (
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        !(event.target instanceof HTMLInputElement)
      ) {
        event.preventDefault();
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        const step = event.shiftKey ? 50 : 10;
        setPlaying(false);
        setPlayhead((value) =>
          Math.max(0, Math.min(draft.duration_ms, value + direction * step)),
        );
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commit, draft, onBack, selection]);
  const addTrack = (target: UiMotionTarget): void => {
    if (draft.tracks.some((track) => track.target === target)) return;
    commit({
      ...draft,
      tracks: [
        ...draft.tracks,
        {
          target,
          channels: {
            opacity: [
              { at_ms: 0, value: 1, easing: "linear" },
              { at_ms: draft.duration_ms, value: 1, easing: "linear" },
            ],
          },
        },
      ],
    });
    setSelectedTarget(target);
  };
  const addChannel = (trackIndex: number, channel: string): void => {
    const next = structuredClone(draft);
    const track = next.tracks[trackIndex];
    if (track === undefined || track.channels[channel] !== undefined) return;
    const base = channel.startsWith("scale_") || channel === "opacity" ? 1 : 0;
    track.channels[channel] = [
      { at_ms: 0, value: base, easing: "linear" },
      { at_ms: next.duration_ms, value: base, easing: "linear" },
    ];
    commit(next);
  };
  const upsert = (
    source: UiMotionPreset,
    trackIndex: number,
    channel: string,
    value: number,
  ): UiMotionPreset => {
    const next = structuredClone(source);
    const track = next.tracks[trackIndex];
    if (track === undefined) return source;
    const at = Math.round(playheadRef.current / 10) * 10;
    const frames = [...(track.channels[channel] ?? [])];
    const found = frames.findIndex((frame) => frame.at_ms === at);
    if (found >= 0) frames[found] = { at_ms: at, value, easing: "linear" };
    else {
      if (frames.length === 0 && at > 0) {
        frames.push({
          at_ms: 0,
          value: channel.startsWith("scale_") || channel === "opacity" ? 1 : 0,
          easing: "linear",
        });
      }
      frames.push({ at_ms: at, value, easing: "linear" });
    }
    frames.sort((left, right) => left.at_ms - right.at_ms);
    track.channels[channel] = frames;
    return next;
  };
  const beginTargetDrag = (
    event: ReactPointerEvent<HTMLElement>,
    target: UiMotionTarget,
  ): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const trackIndex = draft.tracks.findIndex(
      (track) => track.target === target,
    );
    if (trackIndex < 0) return;
    setPlaying(false);
    setSelectedTarget(target);
    const startX = event.clientX;
    const startY = event.clientY;
    const track = draft.tracks[trackIndex];
    const baseX = evaluateChannel(
      track?.channels ?? {},
      "offset_x",
      playhead,
      0,
    );
    const baseY = evaluateChannel(
      track?.channels ?? {},
      "offset_y",
      playhead,
      0,
    );
    let latest = draft;
    const move = (moveEvent: PointerEvent): void => {
      latest = upsert(
        draft,
        trackIndex,
        "offset_x",
        baseX + (moveEvent.clientX - startX) / previewScale,
      );
      latest = upsert(
        latest,
        trackIndex,
        "offset_y",
        baseY + (moveEvent.clientY - startY) / previewScale,
      );
      setGestureDraft(latest);
    };
    const finish = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      commit(latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  };
  const editFrame = (patch: Partial<TimelineKeyframe>): void => {
    if (selection === null) return;
    const next = structuredClone(draft);
    const frames = next.tracks[selection.track]?.channels[selection.channel];
    const frame = frames?.[selection.frame];
    if (frames === undefined || frame === undefined) return;
    const edited = {
      ...frame,
      ...patch,
      value: typeof patch.value === "number" ? patch.value : frame.value,
      at_ms: Math.max(
        0,
        Math.min(next.duration_ms, patch.at_ms ?? frame.at_ms),
      ),
    };
    frames[selection.frame] = edited;
    frames.sort((left, right) => left.at_ms - right.at_ms);
    setSelection({
      ...selection,
      frame: frames.findIndex((candidate) => candidate === edited),
    });
    commit(next);
  };
  const selectedFrame =
    selection === null
      ? undefined
      : draft.tracks[selection.track]?.channels[selection.channel]?.[
          selection.frame
        ];
  const dialogueBox = assets.find((asset) => asset.id === "gui.dialogue_box");
  const nameBox = assets.find((asset) => asset.id === "gui.name_box");
  const dialogueRootRef = useCallback(
    (element: HTMLElement | null) => host.register("dialogue_root", element),
    [host],
  );
  const dialogueFrameRef = useCallback(
    (element: HTMLElement | null) => host.register("dialogue_frame", element),
    [host],
  );
  const dialogueNameplateRef = useCallback(
    (element: HTMLElement | null) =>
      host.register("dialogue_nameplate", element),
    [host],
  );
  const dialogueTextRef = useCallback(
    (element: HTMLElement | null) => host.register("dialogue_text", element),
    [host],
  );
  const dialogueIndicatorRef = useCallback(
    (element: HTMLElement | null) =>
      host.register("dialogue_advance_indicator", element),
    [host],
  );

  return (
    <main className="ui-motion-workspace">
      <header className="ui-motion-toolbar">
        <button onClick={onBack} type="button">
          ← 返回剧情图
        </button>
        <strong>UI 动效 · {draft.id}</strong>
        <span>
          {Math.round(playhead)} / {draft.duration_ms} ms
        </span>
        <button onClick={() => setPlaying((value) => !value)} type="button">
          {playing ? "暂停" : "播放"}
        </button>
        <button onClick={onUndo} type="button">
          撤销
        </button>
        <button onClick={onRedo} type="button">
          重做
        </button>
        <button disabled={!dirty} onClick={onSave} type="button">
          保存
        </button>
      </header>
      <section className="ui-motion-main">
        <div className="ui-motion-preview" ref={previewRef}>
          <div
            className="ui-motion-design"
            style={{ transform: `scale(${previewScale})` }}
          >
            <div className="ui-motion-background">1920 × 1080 UI PREVIEW</div>
            <section
              className={`ui-preview-dialogue${selectedTarget === "dialogue_root" ? " selected" : ""}`}
              onPointerDown={(event) => beginTargetDrag(event, "dialogue_root")}
              ref={dialogueRootRef}
            >
              {dialogueBox !== undefined && (
                <img
                  alt=""
                  className={`ui-preview-frame${selectedTarget === "dialogue_frame" ? " selected" : ""}`}
                  draggable={false}
                  onPointerDown={(event) =>
                    beginTargetDrag(event, "dialogue_frame")
                  }
                  ref={dialogueFrameRef}
                  src={assetUrl(dialogueBox.absolute_path)}
                />
              )}
              <span
                className={`ui-preview-name${selectedTarget === "dialogue_nameplate" ? " selected" : ""}`}
                onPointerDown={(event) =>
                  beginTargetDrag(event, "dialogue_nameplate")
                }
                ref={dialogueNameplateRef}
              >
                {nameBox !== undefined && (
                  <img
                    alt=""
                    draggable={false}
                    src={assetUrl(nameBox.absolute_path)}
                  />
                )}
                <span>爱丽丝</span>
              </span>
              <span
                className={`ui-preview-text${selectedTarget === "dialogue_text" ? " selected" : ""}`}
                onPointerDown={(event) =>
                  beginTargetDrag(event, "dialogue_text")
                }
                ref={dialogueTextRef}
              >
                <MarkupPreview source={"向量 $v\\in V$ 可以写成 $v=u+w$。"} />
              </span>
              <span
                className={`ui-preview-indicator${selectedTarget === "dialogue_advance_indicator" ? " selected" : ""}`}
                onPointerDown={(event) =>
                  beginTargetDrag(event, "dialogue_advance_indicator")
                }
                ref={dialogueIndicatorRef}
              >
                ◆
              </span>
            </section>
          </div>
        </div>
        <aside className="ui-motion-inspector">
          <label>
            预设 ID
            <input readOnly value={draft.id} />
            <small>引用稳定；如需新 ID，请新建预设。</small>
          </label>
          <label>
            时长
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
            添加目标
            <select
              value=""
              onChange={(event) =>
                event.currentTarget.value &&
                addTrack(event.currentTarget.value as UiMotionTarget)
              }
            >
              <option value="">选择…</option>
              {Object.entries(TARGET_LABELS).map(([id, label]) => (
                <option
                  disabled={draft.tracks.some((track) => track.target === id)}
                  key={id}
                  value={id}
                >
                  {label}
                </option>
              ))}
            </select>
          </label>
          <strong>{TARGET_LABELS[selectedTarget]}</strong>
          {selectedFrame !== undefined && (
            <div className="ui-keyframe-fields">
              <label>
                时间
                <input
                  type="number"
                  value={selectedFrame.at_ms}
                  onChange={(event) =>
                    editFrame({ at_ms: Number(event.currentTarget.value) })
                  }
                />
              </label>
              <label>
                数值
                <input
                  step="0.01"
                  type="number"
                  value={
                    typeof selectedFrame.value === "number"
                      ? selectedFrame.value
                      : 0
                  }
                  onChange={(event) =>
                    editFrame({ value: Number(event.currentTarget.value) })
                  }
                />
              </label>
              <label>
                缓动
                <select
                  value={
                    typeof selectedFrame.easing === "string"
                      ? selectedFrame.easing
                      : "linear"
                  }
                  onChange={(event) =>
                    editFrame({
                      easing: event.currentTarget.value as TimelineEasing,
                    })
                  }
                >
                  {["step", "linear", "ease_in", "ease_out", "ease_in_out"].map(
                    (value) => (
                      <option key={value}>{value}</option>
                    ),
                  )}
                </select>
              </label>
            </div>
          )}
        </aside>
      </section>
      <section className="ui-motion-timeline">
        <input
          aria-label="播放头"
          max={draft.duration_ms}
          min={0}
          onChange={(event) => {
            setPlaying(false);
            setPlayhead(Number(event.currentTarget.value));
          }}
          type="range"
          value={playhead}
        />
        {draft.tracks.map((track, trackIndex) => (
          <article className="ui-motion-track" key={track.target}>
            <header onClick={() => setSelectedTarget(track.target)}>
              <strong>{TARGET_LABELS[track.target]}</strong>
              <select
                value=""
                onChange={(event) =>
                  event.currentTarget.value &&
                  addChannel(trackIndex, event.currentTarget.value)
                }
              >
                <option value="">＋ 通道</option>
                {CHANNELS.map((channel) => (
                  <option
                    disabled={track.channels[channel] !== undefined}
                    key={channel}
                  >
                    {channel}
                  </option>
                ))}
              </select>
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
                删除轨道
              </button>
            </header>
            {Object.entries(track.channels).map(([channel, frames]) => (
              <div className="ui-motion-channel" key={channel}>
                <span>{channel}</span>
                <div
                  onDoubleClick={(event) => {
                    const bounds = event.currentTarget.getBoundingClientRect();
                    const at =
                      Math.round(
                        Math.max(
                          0,
                          Math.min(
                            draft.duration_ms,
                            ((event.clientX - bounds.left) / bounds.width) *
                              draft.duration_ms,
                          ),
                        ) / 10,
                      ) * 10;
                    const value = evaluateChannel(
                      track.channels,
                      channel,
                      at,
                      channel.startsWith("scale_") || channel === "opacity"
                        ? 1
                        : 0,
                    );
                    const previousPlayhead = playheadRef.current;
                    playheadRef.current = at;
                    const next = upsert(draft, trackIndex, channel, value);
                    playheadRef.current = previousPlayhead;
                    commit(next);
                    setPlayhead(at);
                  }}
                  title="双击在播放头位置添加关键帧"
                >
                  {frames.map((frame, frameIndex) => (
                    <button
                      className={
                        selection?.track === trackIndex &&
                        selection.channel === channel &&
                        selection.frame === frameIndex
                          ? "selected"
                          : ""
                      }
                      key={`${frame.at_ms}-${frameIndex}`}
                      onClick={() => {
                        setSelection({
                          track: trackIndex,
                          channel,
                          frame: frameIndex,
                        });
                        setPlayhead(frame.at_ms);
                        setSelectedTarget(track.target);
                      }}
                      style={{
                        left: `${(frame.at_ms / draft.duration_ms) * 100}%`,
                      }}
                      title={`${frame.at_ms}ms · ${frame.value}`}
                      type="button"
                    />
                  ))}
                </div>
              </div>
            ))}
          </article>
        ))}
      </section>
    </main>
  );
}
