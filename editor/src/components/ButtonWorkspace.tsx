import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import type { AnimationMap } from "@vectspace/presentation-core/image-animation";
import { editorImageSource } from "../imageAnimationMap";
import { AnimatedImage } from "./AnimatedImage";
import { evaluateChannel } from "../timeline";
import type {
  ButtonAnimation,
  ButtonAssetFit,
  ButtonAssetMode,
  ButtonFile,
  ButtonState,
  EditorAsset,
  TimelineEasing,
  TimelineKeyframe,
} from "../types";

const STATES: { id: ButtonState; label: string }[] = [
  { id: "normal", label: "正常" },
  { id: "hover", label: "悬停" },
  { id: "pressed", label: "按下" },
];
const CHANNELS = [
  "offset_x",
  "offset_y",
  "scale_x",
  "scale_y",
  "rotation_deg",
  "opacity",
] as const;

interface FrameSelection {
  channel: string;
  index: number;
}

/**
 * Project level button template editor.  The preview deliberately uses the
 * same asset fit and state animation equations as the game button layer, but
 * never dispatches click actions.
 */
export function ButtonWorkspace({
  file,
  assets,
  animationMap,
  dirty,
  onBack,
  onChange,
  onSave,
  onUndo,
  onRedo,
}: {
  file: ButtonFile;
  assets: EditorAsset[];
  animationMap: AnimationMap;
  dirty: boolean;
  onBack(): void;
  onChange(file: ButtonFile): void;
  onSave(): void;
  onUndo(): void;
  onRedo(): void;
}): ReactElement {
  const [state, setState] = useState<ButtonState>("normal");
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [showHitArea, setShowHitArea] = useState(true);
  const [selection, setSelection] = useState<FrameSelection | null>(null);
  const [previewScale, setPreviewScale] = useState(0.5);
  const previewRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef(playhead);
  const draft = file.definition;
  const animation = draft.animations[state] ?? null;
  const imageAssets = useMemo(
    () =>
      assets.filter((asset) => asset.kind === "gui" || asset.kind === "sprite"),
    [assets],
  );

  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);
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
    if (!playing) return;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number): void => {
      const duration = animation?.duration_ms ?? 0;
      const delta = now - previous;
      previous = now;
      setPlayhead((current) => {
        const next = current + delta;
        if (duration <= 0 || next >= duration) {
          setPlaying(false);
          return duration;
        }
        return next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [animation?.duration_ms, playing]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onBack();
      if (
        event.code === "Space" &&
        !(event.target instanceof HTMLInputElement)
      ) {
        event.preventDefault();
        if (playheadRef.current >= (animation?.duration_ms ?? 0))
          setPlayhead(0);
        setPlaying((value) => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [animation?.duration_ms, onBack]);

  const commitDefinition = (next: typeof draft): void => {
    setSelection(null);
    onChange({ ...file, definition: next });
  };
  const updateDefinition = (patch: Partial<typeof draft>): void =>
    commitDefinition({ ...draft, ...patch });
  const setAsset = (
    slot: "normal" | "hover" | "pressed",
    value: string,
  ): void => updateDefinition({ ...draft, [slot]: value || null });
  const ensureAnimation = (): ButtonAnimation =>
    animation ?? { duration_ms: 160, channels: {} };
  const updateAnimation = (next: ButtonAnimation | null): void => {
    const animations = { ...draft.animations, [state]: next };
    commitDefinition({ ...draft, animations });
  };
  const addChannel = (channel: string): void => {
    const next = ensureAnimation();
    const base =
      channel === "scale_x" || channel === "scale_y" || channel === "opacity"
        ? 1
        : 0;
    updateAnimation({
      ...next,
      channels: {
        ...next.channels,
        [channel]: [
          { at_ms: 0, value: base, easing: "linear" },
          { at_ms: next.duration_ms, value: base, easing: "linear" },
        ],
      },
    });
  };
  const upsertFrame = (channel: string, value: number): void => {
    const next = ensureAnimation();
    const at = Math.round(playheadRef.current / 10) * 10;
    const frames = [...(next.channels[channel] ?? [])];
    const found = frames.findIndex((frame) => frame.at_ms === at);
    const frame: TimelineKeyframe = { at_ms: at, value, easing: "linear" };
    if (found >= 0) frames[found] = frame;
    else frames.push(frame);
    frames.sort((left, right) => left.at_ms - right.at_ms);
    updateAnimation({
      ...next,
      channels: { ...next.channels, [channel]: frames },
    });
  };
  const selectedFrame =
    selection === null
      ? undefined
      : animation?.channels[selection.channel]?.[selection.index];
  const editSelectedFrame = (patch: Partial<TimelineKeyframe>): void => {
    if (selection === null || animation === null) return;
    const frames = [...(animation.channels[selection.channel] ?? [])];
    const current = frames[selection.index];
    if (current === undefined) return;
    frames[selection.index] = {
      ...current,
      ...patch,
      at_ms: Math.max(
        0,
        Math.min(animation.duration_ms, patch.at_ms ?? current.at_ms),
      ),
    };
    frames.sort((left, right) => left.at_ms - right.at_ms);
    updateAnimation({
      ...animation,
      channels: { ...animation.channels, [selection.channel]: frames },
    });
  };
  const baseAsset =
    draft.normal === null || draft.normal === undefined
      ? undefined
      : assets.find((asset) => asset.id === draft.normal);
  const stateId =
    state === "normal"
      ? draft.normal
      : draft.asset_mode === "separate"
        ? state === "hover"
          ? (draft.hover ?? draft.normal)
          : (draft.pressed ?? draft.normal)
        : state === "hover"
          ? draft.hover
          : draft.pressed;
  const stateAsset =
    stateId === null || stateId === undefined
      ? undefined
      : assets.find((asset) => asset.id === stateId);
  const values = {
    x: evaluateChannel(animation?.channels ?? {}, "offset_x", playhead, 0),
    y: evaluateChannel(animation?.channels ?? {}, "offset_y", playhead, 0),
    scaleX: evaluateChannel(animation?.channels ?? {}, "scale_x", playhead, 1),
    scaleY: evaluateChannel(animation?.channels ?? {}, "scale_y", playhead, 1),
    rotation: evaluateChannel(
      animation?.channels ?? {},
      "rotation_deg",
      playhead,
      0,
    ),
    opacity: evaluateChannel(animation?.channels ?? {}, "opacity", playhead, 1),
  };
  const objectFit = (fit: ButtonAssetFit): CSSProperties["objectFit"] =>
    fit === "contain" ? "contain" : fit === "cover" ? "cover" : "fill";
  const setPreviewState = (next: ButtonState): void => {
    setState(next);
    if (next !== state) setPlayhead(0);
  };

  return (
    <main className="button-workspace">
      <header className="ui-motion-toolbar">
        <button onClick={onBack} type="button">
          ← 返回项目
        </button>
        <strong>按钮模板 · {draft.id}</strong>
        <span>
          {Math.round(playhead)} / {animation?.duration_ms ?? 0} ms
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
      <section className="button-workspace-main">
        <div className="button-preview" ref={previewRef}>
          <div
            className="button-preview-design"
            style={{
              // Center in design pixels first, then apply the preview scale;
              // this keeps button hit areas and artwork aligned with the
              // 1920×1080 coordinate system.
              transform: `translate(-50%, -50%) scale(${previewScale})`,
            }}
          >
            <div className="button-preview-background">
              1920 × 1080 设计坐标
            </div>
            <button
              className="button-preview-hit"
              onPointerDown={() => setPreviewState("pressed")}
              onPointerEnter={() => setPreviewState("hover")}
              onPointerLeave={() => setPreviewState("normal")}
              onPointerUp={() => setPreviewState("hover")}
              style={{
                width: draft.width,
                height: draft.height,
                borderStyle: showHitArea ? "dashed" : "none",
              }}
              type="button"
            >
              <span
                className="button-preview-visual"
                style={{
                  transform: `translate(${values.x}px, ${values.y}px) rotate(${values.rotation}deg) scale(${values.scaleX}, ${values.scaleY})`,
                  opacity: values.opacity,
                }}
              >
                {draft.asset_mode === "overlay" &&
                  state !== "normal" &&
                  baseAsset !== undefined && (
                    <AnimatedImage
                      alt=""
                      source={editorImageSource(
                        baseAsset,
                        assets,
                        animationMap,
                      )}
                      style={{ objectFit: objectFit(draft.fit) }}
                    />
                  )}
                {stateAsset !== undefined && (
                  <AnimatedImage
                    alt=""
                    source={editorImageSource(stateAsset, assets, animationMap)}
                    style={{ objectFit: objectFit(draft.fit) }}
                  />
                )}
              </span>
            </button>
          </div>
        </div>
        <aside className="button-inspector">
          <label>
            模板 ID
            <input readOnly value={draft.id} />
          </label>
          <div className="field-grid">
            <label>
              宽度
              <input
                min={1}
                type="number"
                value={draft.width}
                onChange={(event) =>
                  updateDefinition({ width: Number(event.currentTarget.value) })
                }
              />
            </label>
            <label>
              高度
              <input
                min={1}
                type="number"
                value={draft.height}
                onChange={(event) =>
                  updateDefinition({
                    height: Number(event.currentTarget.value),
                  })
                }
              />
            </label>
          </div>
          <label>
            素材模式
            <select
              value={draft.asset_mode}
              onChange={(event) =>
                updateDefinition({
                  asset_mode: event.currentTarget.value as ButtonAssetMode,
                })
              }
            >
              <option value="separate">三种独立贴图</option>
              <option value="overlay">正常底图 + 状态覆盖</option>
            </select>
          </label>
          <label>
            适应模式
            <select
              value={draft.fit}
              onChange={(event) =>
                updateDefinition({
                  fit: event.currentTarget.value as ButtonAssetFit,
                })
              }
            >
              <option value="stretch">拉伸</option>
              <option value="contain">适应（完整显示）</option>
              <option value="cover">填充（裁剪）</option>
            </select>
          </label>
          <label className="inline-checkbox">
            <input
              checked={showHitArea}
              onChange={(event) => setShowHitArea(event.currentTarget.checked)}
              type="checkbox"
            />{" "}
            显示点击区轮廓
          </label>
          <div className="button-state-tabs">
            {STATES.map((candidate) => (
              <button
                className={state === candidate.id ? "active" : ""}
                key={candidate.id}
                onClick={() => {
                  setState(candidate.id);
                  setPlayhead(0);
                  setSelection(null);
                }}
                type="button"
              >
                {candidate.label}
              </button>
            ))}
          </div>
          {(["normal", "hover", "pressed"] as const).map((slot) => (
            <label key={slot}>
              {slot === "normal"
                ? "正常贴图"
                : slot === "hover"
                  ? "悬停贴图"
                  : "按下贴图"}
              <select
                value={draft[slot] ?? ""}
                onChange={(event) => setAsset(slot, event.currentTarget.value)}
              >
                <option value="">无（沿用/透明）</option>
                {imageAssets.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.id}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <div className="button-animation-actions">
            <button
              onClick={() =>
                updateAnimation(animation ?? { duration_ms: 160, channels: {} })
              }
              type="button"
            >
              {animation === null ? "添加状态动画" : "启用状态动画"}
            </button>
            {animation !== null && (
              <button onClick={() => updateAnimation(null)} type="button">
                清除状态动画
              </button>
            )}
          </div>
          {animation !== null && (
            <>
              <label>
                动画时长
                <input
                  max={1_800_000}
                  min={1}
                  type="number"
                  value={animation.duration_ms}
                  onChange={(event) =>
                    updateAnimation({
                      ...animation,
                      duration_ms: Math.max(
                        1,
                        Number(event.currentTarget.value),
                      ),
                    })
                  }
                />
              </label>
              {selectedFrame !== undefined && (
                <div className="ui-keyframe-fields">
                  <label>
                    时间
                    <input
                      type="number"
                      value={selectedFrame.at_ms}
                      onChange={(event) =>
                        editSelectedFrame({
                          at_ms: Number(event.currentTarget.value),
                        })
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
                        editSelectedFrame({
                          value: Number(event.currentTarget.value),
                        })
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
                        editSelectedFrame({
                          easing: event.currentTarget.value as TimelineEasing,
                        })
                      }
                    >
                      {[
                        "step",
                        "linear",
                        "ease_in",
                        "ease_out",
                        "ease_in_out",
                      ].map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
            </>
          )}
        </aside>
      </section>
      <section className="button-timeline">
        <input
          aria-label="按钮动画播放头"
          max={animation?.duration_ms ?? 0}
          min={0}
          onChange={(event) => {
            setPlaying(false);
            setPlayhead(Number(event.currentTarget.value));
          }}
          type="range"
          value={playhead}
        />
        {animation !== null && (
          <>
            <div className="button-channel-toolbar">
              {CHANNELS.map((channel) => (
                <button
                  disabled={animation.channels[channel] !== undefined}
                  key={channel}
                  onClick={() => addChannel(channel)}
                  type="button"
                >
                  ＋ {channel}
                </button>
              ))}
            </div>
            {Object.entries(animation.channels).map(([channel, frames]) => {
              const keyframes = frames;
              return (
                <div className="ui-motion-channel" key={channel}>
                  <span>{channel}</span>
                  <div className="button-keyframe-row">
                    {keyframes.map((frame, index) => (
                      <button
                        className={
                          selection?.channel === channel &&
                          selection.index === index
                            ? "selected"
                            : ""
                        }
                        key={`${channel}-${index}-${frame.at_ms}`}
                        onClick={() => {
                          setSelection({ channel, index });
                          setPlayhead(frame.at_ms);
                        }}
                        style={{
                          left: `${(frame.at_ms / Math.max(1, animation.duration_ms)) * 100}%`,
                        }}
                        title={`${frame.at_ms} ms`}
                        type="button"
                      >
                        ◆
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() =>
                      upsertFrame(
                        channel,
                        channel.startsWith("scale_") || channel === "opacity"
                          ? 1
                          : 0,
                      )
                    }
                    type="button"
                  >
                    在当前时间添加
                  </button>
                </div>
              );
            })}
          </>
        )}
      </section>
    </main>
  );
}
