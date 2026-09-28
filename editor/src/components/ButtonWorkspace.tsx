import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { AnimationMap } from "@vectspace/presentation-core/image-animation";
import { MousePointerClick } from "lucide-react";
import { WorkspaceHeader } from "../shell/WorkspaceHeader";
import type {
  AssetUrlMap,
  ButtonSnapshot,
} from "@vectspace/presentation-core/types";
import { TemplateButton } from "@vectspace/presentation-react/button";
// The shared gameplay stylesheet carries the `scene-button*` rules the real
// button is styled with; a host-local copy is forbidden by the CSS contract.
import "@vectspace/presentation-react/gameplay.css";
import { assetUrl } from "../api";
import { AssetChooser } from "./AssetChooser";
import { escapeTextEntry, isComposing } from "../ui/keyboard";
import { evaluateChannel } from "@vectspace/presentation-core/timeline";
import {
  KeyframeInspector,
  TimelineSurface,
  type TimelineSurfaceDocument,
  type TimelineSurfaceSelection,
} from "./TimelineSurface";
import type {
  ButtonAnimation,
  ButtonAnimations,
  ButtonAssetFit,
  ButtonAssetMode,
  ButtonFile,
  ButtonState,
  EditorAsset,
  TimelineChannels,
  TimelineKeyframe,
} from "../types";

const STATES: { id: ButtonState; label: string }[] = [
  { id: "normal", label: "正常" },
  { id: "hover", label: "悬停" },
  { id: "pressed", label: "按下" },
];

/** Button animation channels keep their runtime names (offsets + multiples). */
const BUTTON_ANIMATION_CHANNELS = [
  "offset_x",
  "offset_y",
  "scale_x",
  "scale_y",
  "rotation_deg",
  "opacity",
] as const;

const BUTTON_CHANNEL_DEFAULTS: Record<string, number> = {
  offset_x: 0,
  offset_y: 0,
  scale_x: 1,
  scale_y: 1,
  rotation_deg: 0,
  opacity: 1,
};

/**
 * Project level button template editor.
 *
 * The preview deliberately uses the same asset fit and state animation
 * equations as the game button layer, but never dispatches click actions.
 * The animation channels are authored with the same keyframe surface (ruler,
 * transport, marquee selection, drag, easing inspector, copy/paste/delete)
 * every other timeline workspace uses, while button states, variants, asset
 * mode and fit remain domain concerns outside it.
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
  undoAvailable = true,
  redoAvailable = true,
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
  undoAvailable?: boolean;
  redoAvailable?: boolean;
}): ReactElement {
  const [state, setState] = useState<ButtonState>("normal");
  const [playhead, setPlayhead] = useState(0);
  const [showHitArea, setShowHitArea] = useState(true);
  const [selection, setSelection] = useState<TimelineSurfaceSelection | null>(
    null,
  );
  const [channelName, setChannelName] = useState<string>(
    BUTTON_ANIMATION_CHANNELS[0],
  );
  const [gestureDraft, setGestureDraft] =
    useState<TimelineSurfaceDocument<ButtonState> | null>(null);
  const [previewScale, setPreviewScale] = useState(0.5);
  const previewRef = useRef<HTMLDivElement>(null);
  const draft = file.definition;
  const animation = draft.animations[state] ?? null;

  const imageAssets = useMemo(
    () =>
      assets.filter((asset) => asset.kind === "gui" || asset.kind === "sprite"),
    [assets],
  );
  // The shared `TemplateButton` resolves artwork by asset id, exactly like the
  // game, so the preview feeds it the same id→url map the runtime uses.
  const urls: AssetUrlMap = useMemo(
    () =>
      Object.fromEntries(
        assets.map((asset) => [asset.id, assetUrl(asset.absolute_path)]),
      ),
    [assets],
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
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (event.defaultPrevented || isComposing(event)) return;
      if (escapeTextEntry(event)) return;
      onBack();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onBack]);

  const surfaceDocument: TimelineSurfaceDocument<ButtonState> = useMemo(
    () => ({
      duration_ms: animation?.duration_ms ?? 0,
      tracks:
        animation === null
          ? []
          : [
              {
                id: `button:${state}`,
                label:
                  STATES.find((candidate) => candidate.id === state)?.label ??
                  state,
                channels: animation.channels,
                allowedChannels: BUTTON_ANIMATION_CHANNELS,
                defaults: BUTTON_CHANNEL_DEFAULTS,
                allowInherit: false,
                data: state,
              },
            ],
      events: [],
    }),
    [animation, state],
  );

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
  const updateAnimation = (next: ButtonAnimation | null): void => {
    const animations = { ...draft.animations, [state]: next };
    commitDefinition({ ...draft, animations });
  };
  const writeChannels = (
    channels: TimelineChannels,
    durationMs: number,
  ): void => {
    if (animation === null) return;
    onChange({
      ...file,
      definition: {
        ...draft,
        animations: {
          ...draft.animations,
          [state]: { ...animation, duration_ms: durationMs, channels },
        },
      },
    });
  };
  const commitSurface = (next: TimelineSurfaceDocument<ButtonState>): void => {
    const track = next.tracks[0];
    if (animation === null || track === undefined) return;
    writeChannels(track.channels, next.duration_ms);
  };
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
    writeChannels(
      { ...animation.channels, [selection.channel]: frames },
      animation.duration_ms,
    );
  };
  // The authored state is scrubbed, not animated on a wall clock: the channels
  // are pre-evaluated at the editor playhead and baked into a single keyframe,
  // so `TemplateButton` renders exactly the pose the game would show at that
  // millisecond (and keeps owning artwork/state/overlay resolution).  During a
  // keyframe drag the surface reports its live draft so the pose keeps up
  // before the gesture commits.
  const previewAnimation: ButtonAnimation = useMemo(
    () => ({
      duration_ms: gestureDraft?.duration_ms ?? animation?.duration_ms ?? 0,
      channels: gestureDraft?.tracks[0]?.channels ?? animation?.channels ?? {},
    }),
    [animation, gestureDraft],
  );
  const bakedState: ButtonAnimation | null = useMemo(
    () => bakeAnimation(previewAnimation, playhead),
    [playhead, previewAnimation],
  );
  // Every slot carries the same baked pose so a stray pointer state can never
  // change the artwork or the transform mid-scrub.
  const previewAnimations: ButtonAnimations = useMemo(
    () => ({ normal: bakedState, hover: bakedState, pressed: bakedState }),
    [bakedState],
  );
  const previewButton: ButtonSnapshot = useMemo(
    () => ({
      id: draft.id,
      template: draft.id,
      asset_mode: draft.asset_mode,
      fit: draft.fit,
      normal: draft.normal ?? null,
      hover: draft.hover ?? null,
      pressed: draft.pressed ?? null,
      animations: previewAnimations,
      x: 0,
      y: 0,
      width: draft.width,
      height: draft.height,
      rotation_deg: 0,
      scale_x: 1,
      scale_y: 1,
      opacity: 1,
      z: 0,
      visible: true,
      enabled: true,
      action: { sets: [], next: null },
    }),
    [draft, previewAnimations],
  );
  const setPreviewState = (next: ButtonState): void => {
    setState(next);
    if (next !== state) {
      setPlayhead(0);
      setSelection(null);
    }
  };

  return (
    <main className="button-workspace">
      <WorkspaceHeader
        dirty={dirty}
        icon={MousePointerClick}
        kind="按钮模板"
        onBack={onBack}
        onRedo={onRedo}
        onSave={onSave}
        onUndo={onUndo}
        redoAvailable={redoAvailable}
        title={draft.id}
        undoAvailable={undoAvailable}
      />
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
            {/* The dashed box is the authored hit area; the artwork itself is
                the real shared `TemplateButton`, pinned to the selected state
                and posed at the editor playhead. */}
            <div
              className="button-preview-hit"
              style={{
                width: draft.width,
                height: draft.height,
                borderStyle: showHitArea ? "dashed" : "none",
              }}
            >
              <TemplateButton
                animations={animationMap}
                assets={urls}
                button={previewButton}
                className="scene-button"
                // Authoring only: activating a template here must never run a
                // game action, so the preview stays inert.
                disabled
                onActivate={() => undefined}
                sessionKey={`${draft.id}:${state}`}
                state={state}
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                }}
              />
            </div>
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
                onClick={() => setPreviewState(candidate.id)}
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
              <AssetChooser
                allowEmpty
                assets={imageAssets}
                emptyLabel="无（沿用/透明）"
                kind={["gui", "sprite"]}
                label={
                  slot === "normal"
                    ? "正常贴图"
                    : slot === "hover"
                      ? "悬停贴图"
                      : "按下贴图"
                }
                onChange={(value) => setAsset(slot, value ?? "")}
                value={draft[slot] ?? null}
              />
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
            <label>
              动画时长
              <input
                max={1_800_000}
                min={1}
                type="number"
                value={animation.duration_ms}
                onChange={(event) =>
                  writeChannels(
                    animation.channels,
                    Math.max(1, Number(event.currentTarget.value)),
                  )
                }
              />
            </label>
          )}
          {selection !== null && (
            <KeyframeInspector
              allowInherit={false}
              frame={selection.frame}
              onChange={editSelectedFrame}
            />
          )}
        </aside>
      </section>
      <TimelineSurface<ButtonState>
        allowRemoveTrack={false}
        channelName={channelName}
        className="button-timeline-surface"
        document={surfaceDocument}
        emptyLabel="该状态还没有动画，先添加状态动画"
        keyboardPlayback
        onChannelNameChange={setChannelName}
        onChange={commitSurface}
        onDraftChange={setGestureDraft}
        onPlayheadChange={setPlayhead}
        onSelectionChange={setSelection}
        playhead={playhead}
        playbackStart={0}
        showTransport
        snap={10}
      />
    </main>
  );
}

/**
 * Pre-evaluates every authored channel at `playheadMs` and collapses it to a
 * single keyframe, so the shared button renders the authored pose at that
 * millisecond without running its wall-clock loop.
 *
 * `duration_ms` is 0 because the baked animation holds one constant pose; the
 * component's clock stops after its first frame instead of ticking the preview
 * at 60 fps while the author drags a ruler.
 */
function bakeAnimation(
  animation: ButtonAnimation | null,
  playheadMs: number,
): ButtonAnimation | null {
  if (animation === null) return null;
  const channels: TimelineChannels = {};
  for (const channel of BUTTON_ANIMATION_CHANNELS) {
    const frames = animation.channels[channel];
    if (frames === undefined || frames.length === 0) continue;
    channels[channel] = [
      {
        at_ms: 0,
        value: evaluateChannel(
          animation.channels,
          channel,
          playheadMs,
          BUTTON_CHANNEL_DEFAULTS[channel] ?? 0,
        ),
        easing: "linear",
      },
    ];
  }
  return { duration_ms: 0, channels };
}
