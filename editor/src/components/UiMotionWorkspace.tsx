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
import { Sparkles } from "lucide-react";
import { WorkspaceHeader } from "../shell/WorkspaceHeader";
import {
  resolveImageAsset,
  type AnimationMap,
} from "@vectspace/presentation-core/image-animation";
import type {
  AssetUrlMap,
  DialoguePageSnapshot,
  DialoguePrompt,
} from "@vectspace/presentation-core/types";
import { UiMotionHost } from "@vectspace/presentation-core/ui-motion";
import {
  DialogueBox,
  selectGameplayFont,
  useGameplayFont,
} from "@vectspace/presentation-react/gameplay";
import { evaluateChannel } from "@vectspace/presentation-core/timeline";
import { escapeTextEntry, isComposing } from "../ui/keyboard";
import { isEditableTarget } from "./nodeDeleteShortcut";
import { KeyframeInspector } from "./timeline/KeyframeInspector";
import {
  TimelineSurface,
  type TimelineSurfaceDocument,
  type TimelineSurfaceSelection,
} from "./TimelineSurface";
import type {
  EditorAsset,
  TimelineKeyframe,
  UiMotionFile,
  UiMotionPreset,
  UiMotionTarget,
} from "../types";

const TARGET_LABELS: Record<UiMotionTarget, string> = {
  dialogue_root: "对话框整体",
  dialogue_frame: "对话框图片",
  dialogue_nameplate: "姓名框",
  dialogue_text: "正文",
  dialogue_advance_indicator: "推进标记",
};

/**
 * Draw order of the editor hit boxes: outer containers first, so the innermost
 * target (text/indicator) wins the pointer, exactly like clicking the real DOM.
 */
const UI_MOTION_TARGETS: UiMotionTarget[] = [
  "dialogue_root",
  "dialogue_frame",
  "dialogue_nameplate",
  "dialogue_text",
  "dialogue_advance_indicator",
];

/** UI-motion channels keep the runtime's offset/multiplier vocabulary. */
const UI_MOTION_CHANNELS = [
  "offset_x",
  "offset_y",
  "scale_x",
  "scale_y",
  "rotation_deg",
  "opacity",
] as const;

const UI_MOTION_DEFAULTS: Record<string, number> = {
  offset_x: 0,
  offset_y: 0,
  scale_x: 1,
  scale_y: 1,
  rotation_deg: 0,
  opacity: 1,
};

const DESIGN_WIDTH = 1920;

/** Typing speed for the static preset preview; the text is revealed at once, so
 * this only feeds the reveal plan/metrics, not a live typewriter. */
const PREVIEW_CPS = 30;

/** A preset is applied to whatever dialogue is on screen, so the workspace
 * previews it against a representative dialogue.  Hosts that can supply the
 * project's own page/prompt pass `previewDialogue`; this neutral sample is the
 * fallback and is deliberately not tied to any project character. */
export interface UiMotionPreviewDialogue {
  page: DialoguePageSnapshot;
  prompt: DialoguePrompt | null;
}

const DEFAULT_PREVIEW_DIALOGUE: UiMotionPreviewDialogue = {
  page: {
    page_id: "ui-motion-preview",
    speaker: "角色名",
    segments: ["这里显示一段示例对话，用于预览所选目标的 UI 动效。"],
  },
  prompt: {
    kind: "dialogue",
    prompt_id: "ui-motion-preview",
    speaker: "角色名",
    text: "这里显示一段示例对话，用于预览所选目标的 UI 动效。",
    is_read: false,
  },
};

/** Also records the registered nodes so the editor can draw hit boxes. */
class PreviewUiMotionHost extends UiMotionHost {
  readonly elements = new Map<UiMotionTarget, HTMLElement>();

  register(target: UiMotionTarget, element: HTMLElement | null): void {
    super.register(target, element);
    if (element === null) this.elements.delete(target);
    else this.elements.set(target, element);
  }
}

interface TargetRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type TargetRects = Partial<Record<UiMotionTarget, TargetRect>>;

function sameTargetRects(left: TargetRects, right: TargetRects): boolean {
  const keys = new Set([
    ...(Object.keys(left) as UiMotionTarget[]),
    ...(Object.keys(right) as UiMotionTarget[]),
  ]);
  for (const key of keys) {
    const a = left[key];
    const b = right[key];
    if (a === b) continue;
    if (
      a === undefined ||
      b === undefined ||
      a.x !== b.x ||
      a.y !== b.y ||
      a.width !== b.width ||
      a.height !== b.height
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Full-screen keyframe workspace for one reusable UI motion preset.
 *
 * The preview is the *real* shared `DialogueBox` driven by the same
 * `UiMotionHost` the game uses, so the target nodes, the artwork, the font and
 * the motion equations can never drift from gameplay.  The editor only adds a
 * transparent hit-box/gizmo layer over the registered nodes for target
 * selection and dragging; the tracks/channels/frames are authored with the same
 * shared keyframe surface as the story timeline, actions and button templates.
 */
export function UiMotionWorkspace({
  file,
  assets,
  animationMap,
  dirty,
  previewDialogue,
  defaultFontId,
  onBack,
  onChange,
  onSave,
  onUndo,
  onRedo,
  undoAvailable = true,
  redoAvailable = true,
}: {
  file: UiMotionFile;
  assets: EditorAsset[];
  animationMap: AnimationMap;
  dirty: boolean;
  /** Representative dialogue the preset is previewed against. */
  previewDialogue?: UiMotionPreviewDialogue;
  /**
   * The project's `manifest.default_font`, so this preview resolves the same
   * face (and therefore the same text metrics) the game bootstraps with.  Omitted
   * it falls back to the shared `font.fusion_pixel`/first-font chain, matching
   * the runtime when a manifest does not declare a default font.
   */
  defaultFontId?: string | null;
  onBack(): void;
  onChange(file: UiMotionFile): void;
  onSave(): void;
  onUndo(): void;
  onRedo(): void;
  undoAvailable?: boolean;
  redoAvailable?: boolean;
}): ReactElement {
  const [domainGesture, setDomainGesture] = useState<UiMotionPreset | null>(
    null,
  );
  const draft = domainGesture ?? file.definition;
  const [surfaceGesture, setSurfaceGesture] =
    useState<TimelineSurfaceDocument<UiMotionTarget> | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [selectedTarget, setSelectedTarget] = useState<UiMotionTarget>(
    file.definition.tracks[0]?.target ?? "dialogue_root",
  );
  const [selection, setSelection] = useState<TimelineSurfaceSelection | null>(
    null,
  );
  const [channelName, setChannelName] = useState<string>(UI_MOTION_CHANNELS[0]);
  const [targetRects, setTargetRects] = useState<TargetRects>({});
  const previewRef = useRef<HTMLDivElement>(null);
  const designRef = useRef<HTMLDivElement>(null);
  const [previewScale, setPreviewScale] = useState(0.5);
  const host = useMemo(() => new PreviewUiMotionHost(), []);
  const playheadRef = useRef(playhead);
  const dialogue = previewDialogue ?? DEFAULT_PREVIEW_DIALOGUE;

  // Font identity/readiness comes from the shared gameplay facility, so the
  // preview measures and reveals text with the same face (and metrics) as the
  // game instead of the editor's UI font.  The project's `default_font` is
  // authoritative, exactly as in `GameplayPreview`/`LongTextWorkspace`.
  const previewFont = useMemo(
    () => selectGameplayFont(defaultFontId, assets),
    [assets, defaultFontId],
  );
  const font = useGameplayFont(
    previewFont === undefined ? undefined : assetUrl(previewFont.absolute_path),
  );
  const artworkUrls: AssetUrlMap = useMemo(
    () =>
      Object.fromEntries(
        assets.map((asset) => [asset.id, assetUrl(asset.absolute_path)]),
      ),
    [assets],
  );
  const dialogueBoxSource = useMemo(
    () =>
      resolveImageAsset("gui.dialogue_box", artworkUrls, animationMap) ?? null,
    [animationMap, artworkUrls],
  );
  const nameBoxSource = useMemo(
    () => resolveImageAsset("gui.name_box", artworkUrls, animationMap) ?? null,
    [animationMap, artworkUrls],
  );
  const dialogueSessionKey = `${dialogue.page.page_id}:${
    dialogue.prompt?.prompt_id ?? ""
  }`;
  // The preview never advances the story: these callbacks are deliberately
  // inert and stable so they cannot churn the reveal session's effects.
  const handleTypingChange = useCallback((): void => undefined, []);
  const handleRevealComplete = useCallback((): void => undefined, []);

  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);

  const persist = useCallback(
    (next: UiMotionPreset): void => {
      setDomainGesture(null);
      setSurfaceGesture(null);
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

  const surfaceDocument = useMemo(
    () => presetToSurfaceDocument(draft),
    [draft],
  );
  const previewPreset = useMemo(
    () => surfaceDocumentToPreset(surfaceGesture ?? surfaceDocument, draft),
    [draft, surfaceDocument, surfaceGesture],
  );
  useEffect(() => {
    host.reconcileDialogueVisible(true);
    host.apply(previewPreset, playhead, previewPreset.duration_ms);
  }, [previewPreset, host, playhead]);

  // The hit boxes follow the *registered* game nodes, including the motion the
  // host just applied, so a dragged target and its outline can never disagree.
  // Declared after the apply effect so it measures the applied pose.
  const measureTargets = useCallback((): void => {
    const design = designRef.current;
    const base = design?.getBoundingClientRect();
    if (design === null || base === undefined || base.width <= 0) {
      setTargetRects((previous) =>
        Object.keys(previous).length === 0 ? previous : {},
      );
      return;
    }
    const scale = base.width / DESIGN_WIDTH;
    const next: TargetRects = {};
    for (const target of UI_MOTION_TARGETS) {
      const element = host.elements.get(target);
      if (element === undefined) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) continue;
      next[target] = {
        x: (rect.left - base.left) / scale,
        y: (rect.top - base.top) / scale,
        width: rect.width / scale,
        height: rect.height / scale,
      };
    }
    setTargetRects((previous) =>
      sameTargetRects(previous, next) ? previous : next,
    );
  }, [host]);
  useEffect(() => {
    measureTargets();
  }, [
    dialogueSessionKey,
    measureTargets,
    playhead,
    previewPreset,
    previewScale,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isComposing(event)) return;
      if (event.key === "Escape") {
        if (escapeTextEntry(event)) return;
        onBack();
      } else if (
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        !isEditableTarget(event.target)
      ) {
        event.preventDefault();
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        const step = event.shiftKey ? 50 : 10;
        setPlayhead((value) =>
          Math.max(0, Math.min(draft.duration_ms, value + direction * step)),
        );
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [draft.duration_ms, onBack]);

  const addTrack = (target: UiMotionTarget): void => {
    if (draft.tracks.some((track) => track.target === target)) return;
    persist({
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
  const addChannel = (
    track: TimelineSurfaceDocument<UiMotionTarget>["tracks"][number],
    channel: string,
  ): void => {
    if (track.channels[channel] !== undefined) return;
    const base = channel.startsWith("scale_") || channel === "opacity" ? 1 : 0;
    persist(
      surfaceDocumentToPreset(
        {
          ...surfaceDocument,
          tracks: surfaceDocument.tracks.map((candidate) =>
            candidate.id === track.id
              ? {
                  ...candidate,
                  channels: {
                    ...candidate.channels,
                    [channel]: [
                      { at_ms: 0, value: base, easing: "linear" },
                      {
                        at_ms: surfaceDocument.duration_ms,
                        value: base,
                        easing: "linear",
                      },
                    ],
                  },
                }
              : candidate,
          ),
        },
        draft,
      ),
    );
  };
  const commitSurface = (
    next: TimelineSurfaceDocument<UiMotionTarget>,
  ): void => {
    persist(surfaceDocumentToPreset(next, draft));
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
    setSelectedTarget(target);
    if (trackIndex < 0) return;
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
      setDomainGesture(latest);
    };
    const finish = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      persist(latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  };
  const editFrame = (patch: Partial<TimelineKeyframe>): void => {
    if (selection === null) return;
    const next = structuredClone(draft);
    const frames = next.tracks[selection.track]?.channels[selection.channel];
    const frame = frames?.[selection.index];
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
    frames[selection.index] = edited;
    frames.sort((left, right) => left.at_ms - right.at_ms);
    setSelection({
      ...selection,
      index: frames.findIndex((candidate) => candidate === edited),
      frame: edited,
    });
    persist(next);
  };

  return (
    <main className="ui-motion-workspace">
      <WorkspaceHeader
        dirty={dirty}
        icon={Sparkles}
        kind="UI 动效"
        onBack={onBack}
        onRedo={onRedo}
        onSave={onSave}
        onUndo={onUndo}
        redoAvailable={redoAvailable}
        title={draft.id}
        undoAvailable={undoAvailable}
      />
      <section className="ui-motion-main">
        <div className="ui-motion-preview" ref={previewRef}>
          <div
            className="ui-motion-design"
            ref={designRef}
            style={{
              // Keep the design viewport centered after scaling.  Using a
              // separate CSS `translate` property makes its percentage
              // offset get scaled as well, which pushes the preview toward
              // the upper-left corner at non-1x scales.
              transform: `translate(-50%, -50%) scale(${previewScale})`,
            }}
          >
            <div className="ui-motion-background">1920 × 1080 UI PREVIEW</div>
            <DialogueBox
              defaultCps={PREVIEW_CPS}
              dialogueBoxSource={dialogueBoxSource}
              disabled={false}
              fontReady={font.ready}
              initialCps={PREVIEW_CPS}
              measurementScale={previewScale}
              motionHost={host}
              nameBoxSource={nameBoxSource}
              // The preset editor never advances story state: reveal is
              // restored immediately and the callbacks are inert.
              onRevealComplete={handleRevealComplete}
              onTypingChange={handleTypingChange}
              page={dialogue.page}
              prompt={dialogue.prompt}
              revealImmediately
              sessionKey={dialogueSessionKey}
              visible
            />
            <div className="ui-motion-gizmo-layer">
              {UI_MOTION_TARGETS.map((target) => {
                const rect = targetRects[target];
                if (rect === undefined) return null;
                return (
                  <div
                    aria-label={`${TARGET_LABELS[target]} 预览区域`}
                    className={`ui-motion-target${
                      selectedTarget === target ? " selected" : ""
                    }`}
                    key={target}
                    onPointerDown={(event) => beginTargetDrag(event, target)}
                    style={{
                      left: rect.x,
                      top: rect.y,
                      width: rect.width,
                      height: rect.height,
                    }}
                  />
                );
              })}
            </div>
          </div>
          <p className="ui-motion-preview-note">
            预览为真实对话框组件；拖动目标区域写入该目标在当前播放头的位移关键帧。
          </p>
          {font.error !== null && (
            <p className="ui-motion-preview-font-error" role="status">
              预览字体加载失败（{font.error}），已回退到系统字体。
            </p>
          )}
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
                persist({
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
          {selection !== null && (
            <KeyframeInspector
              allowInherit={false}
              frame={selection.frame}
              onChange={editFrame}
            />
          )}
        </aside>
      </section>
      <TimelineSurface<UiMotionTarget>
        allowRemoveTrack
        channelName={channelName}
        className="ui-motion-timeline-surface"
        document={surfaceDocument}
        emptyLabel="还没有目标轨道，先从右侧添加目标"
        keyboardPlayback
        onChannelNameChange={setChannelName}
        onChange={commitSurface}
        onDraftChange={setSurfaceGesture}
        onPlayheadChange={setPlayhead}
        onSelectionChange={(next) => {
          setSelection(next);
          if (next !== null)
            setSelectedTarget(
              surfaceDocument.tracks[next.track]?.data ?? selectedTarget,
            );
        }}
        playhead={playhead}
        playbackStart={0}
        renderTrackExtra={(track) => (
          <select
            aria-label={`${track.label} 添加通道`}
            value=""
            onChange={(event) =>
              event.currentTarget.value &&
              addChannel(track, event.currentTarget.value)
            }
          >
            <option value="">＋ 通道</option>
            {UI_MOTION_CHANNELS.map((channel) => (
              <option
                disabled={track.channels[channel] !== undefined}
                key={channel}
              >
                {channel}
              </option>
            ))}
          </select>
        )}
        showTransport
        snap={10}
      />
    </main>
  );
}

function presetToSurfaceDocument(
  preset: UiMotionPreset,
): TimelineSurfaceDocument<UiMotionTarget> {
  return {
    duration_ms: preset.duration_ms,
    tracks: preset.tracks.map((track) => ({
      id: `ui-motion:${track.target}`,
      label: TARGET_LABELS[track.target] ?? track.target,
      channels: track.channels,
      allowedChannels: UI_MOTION_CHANNELS,
      defaults: UI_MOTION_DEFAULTS,
      allowInherit: false,
      data: track.target,
    })),
    events: [],
  };
}

function surfaceDocumentToPreset(
  document: TimelineSurfaceDocument<UiMotionTarget>,
  base: UiMotionPreset,
): UiMotionPreset {
  return {
    ...base,
    duration_ms: document.duration_ms,
    tracks: document.tracks.map((track) => ({
      target: track.data,
      channels: track.channels,
    })),
  };
}
