import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { assetUrl, editorApi, previewAssetsToUrls } from "../api";
import { buildEditorVisualResources } from "../visualResources";
import {
  presetTimelineEvents,
  type ScreenEffectPreset,
} from "../screenEffectPresets";
import { projectRequest } from "../story";
import type {
  BuildNodePreviewResult,
  EditorAsset,
  EditorProject,
  PreviewChoiceDecision,
  TimelineEvent,
  TimelineKeyframe,
  TimelineNode,
  TimelineTrack,
  TimelinePreviewSettings,
} from "../types";
import {
  TimelineEditor,
  type TimelineEventSelection,
  type TimelineSelection,
} from "./TimelineEditor";
import {
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  type SceneObjectFrame,
  type SceneFrame,
} from "@vectspace/presentation-core/scene-frame";
import type { SceneSurface } from "@vectspace/presentation-core/scene-surface";
import { LEGACY_BACKGROUND_ID } from "@vectspace/presentation-core/visual";
import type { TimelineSession } from "@vectspace/presentation-core/timeline-session";
import { DeferredSession } from "@vectspace/presentation-core/deferred-session";
import {
  createEditorTimelinePreview,
  disposeEditorTimelinePreview,
  type EditorPreviewEnvironment,
  type EditorTimelinePreview,
} from "./timelinePreview";
import { buildAnimationMap } from "../imageAnimationMap";
import { useAssetLayout } from "./AssetChooser";
import { DeferredInput } from "./Fields";
import {
  Clapperboard,
  KeyRound,
  Pause,
  Play,
  RefreshCw,
  Volume2,
  VolumeX,
} from "lucide-react";
import { WorkspaceHeader } from "../shell/WorkspaceHeader";
import { Button, IconButton } from "../ui/Button";
import {
  escapeTextEntry,
  isComposing,
  isTextEntryTarget,
} from "../ui/keyboard";
import { isEditableTarget } from "./nodeDeleteShortcut";
import { firstVisibleAssetId } from "../assetLibrary";
import {
  type CameraHandle,
  type Tool,
  type TransformHandle,
  dragTransform,
  objectChannels,
  releasedTransform,
} from "./timeline/gizmo";
import {
  newTimelineEvent,
  planNewTrack,
  selectedObjectAssetChanged,
  snapTime,
  upsertKeyframe as upsertKeyframeAt,
} from "./timeline/trackEdits";
import { GizmoLayer } from "./timeline/GizmoLayer";
import { ObjectInspector } from "./timeline/ObjectInspector";
import { PendingExitDialog } from "./timeline/PendingExitDialog";
import { PreviewContextPanel } from "./timeline/PreviewContextPanel";
import { StageToolbar } from "./timeline/StageToolbar";
import { TimelineKeyframeInspector } from "./timeline/TimelineKeyframeInspector";
import { TimelineEventInspector } from "./timeline/TimelineEventInspector";
import { errorMessage } from "./errorMessage";

interface TimelineWorkspaceProps {
  project: EditorProject;
  sceneId: string;
  nodeId: string;
  node: TimelineNode;
  assets: EditorAsset[];
  dirty: boolean;
  futureAvailable: boolean;
  /** Whether the project history has an entry to undo. */
  pastAvailable?: boolean;
  previewSettings: TimelinePreviewSettings | undefined;
  onBack(): void;
  onChange(node: TimelineNode): void;
  onPreviewSettingsChange(settings: TimelinePreviewSettings): void;
  onSave(): void;
  onUndo(): void;
  onRedo(): void;
  onError(message: string): void;
  /** Opaque imports that are still staged, forwarded to the Rust preview. */
  importTokens: string[];
  /**
   * Test seam forwarded to the shared editor preview factory; production
   * mounts leave it undefined and get the real Pixi kit and media adapter.
   */
  previewEnvironment?: EditorPreviewEnvironment;
}

const DEFAULT_PREVIEW_SETTINGS: TimelinePreviewSettings = {
  variable_overrides: {},
  choices: [],
};

const PRESET_NO_ROOM_MESSAGE = "播放头之后的时间线时长不足，无法插入演出预设。";

export function TimelineWorkspace({
  project,
  sceneId,
  nodeId,
  node,
  assets,
  dirty,
  futureAvailable,
  pastAvailable = true,
  previewSettings,
  onBack,
  onChange,
  onPreviewSettingsChange,
  onSave,
  onUndo,
  onRedo,
  onError,
  importTokens,
  previewEnvironment,
}: TimelineWorkspaceProps): ReactElement {
  const [localNode, setLocalNode] = useState(node);
  const assetLayout = useAssetLayout();
  // Hidden assets never seed a new default; video and SFX require a real asset.
  const visibleVideo = firstVisibleAssetId(assets, assetLayout, "video");
  const visibleSfx = firstVisibleAssetId(assets, assetLayout, "sfx");
  const [playhead, setPlayhead] = useState(0);
  const [playbackStart, setPlaybackStart] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [autoKey, setAutoKey] = useState(true);
  const [muted, setMuted] = useState(true);
  const [snap, setSnap] = useState(50);
  const [newTrackType, setNewTrackType] =
    useState<TimelineTrack["type"]>("sprite");
  const [newButtonInstanceId, setNewButtonInstanceId] = useState("");
  const [tool, setTool] = useState<Tool>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedKeyframe, setSelectedKeyframe] =
    useState<TimelineSelection | null>(null);
  const [selectedEvent, setSelectedEvent] =
    useState<TimelineEventSelection | null>(null);
  const [frame, setFrame] = useState<SceneFrame | null>(null);
  const [preview, setPreview] = useState<Extract<
    BuildNodePreviewResult,
    { status: "ready" }
  > | null>(null);
  // The live-patch path must read the *current* ready preview, not a value
  // captured by a render that may already be superseded.  A ref keeps the
  // session patch one ordered step behind the authoritative node instead of
  // silently returning when the React `preview` closure is stale.
  const previewRef = useRef<Extract<
    BuildNodePreviewResult,
    { status: "ready" }
  > | null>(null);
  const setCurrentPreview = useCallback(
    (
      value: Extract<BuildNodePreviewResult, { status: "ready" }> | null,
    ): void => {
      previewRef.current = value;
      setPreview(value);
    },
    [],
  );
  const [contextStatus, setContextStatus] = useState("尚未生成预览");
  const [contextBusy, setContextBusy] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [pendingChoice, setPendingChoice] = useState<Extract<
    BuildNodePreviewResult,
    { status: "needs_choice" }
  > | null>(null);
  const [pendingTransforms, setPendingTransforms] = useState<
    Record<string, Partial<SceneObjectFrame>>
  >({});
  const [pendingCamera, setPendingCamera] = useState<{
    x: number;
    y: number;
    zoom: number;
    rotation_deg: number;
  } | null>(null);
  const [exitPrompt, setExitPrompt] = useState(false);
  const [timelineHeight, setTimelineHeight] = useState(320);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const surfaceRef = useRef<SceneSurface | null>(null);
  const sessionRef = useRef<TimelineSession | null>(null);
  const surfaceReadyRef = useRef<Promise<void>>(Promise.resolve());
  const diagnosticRef = useRef<(message: string) => void>(() => undefined);
  const previewLifecycleRef =
    useRef<DeferredSession<EditorTimelinePreview> | null>(null);
  const contextRequestRef = useRef(0);
  const gestureCancelRef = useRef<(() => void) | null>(null);
  const parentNodeCommitRef = useRef<TimelineNode | null>(null);
  // Monotonic id for the live-patch path.  A superseded async resource load
  // (or its seek callback) must never clear a newer interactive override or
  // seek a newer playhead, so every patch claims a request id and only the
  // latest one may touch the session.
  const patchRequestRef = useRef(0);
  // True while a resource load started by the live-patch path is still in
  // flight.  A newer patch (including an undo that restores the previous
  // resource signature) must *supersede* that load instead of trusting
  // `applyTimelineEdit`, otherwise the older load can still commit its stale
  // resources after the request-id callback has been suppressed.
  const loadPendingRef = useRef(false);
  const projectRef = useRef(project);
  const nodeRef = useRef(localNode);
  const playheadRef = useRef(playhead);
  const playbackStartRef = useRef(playbackStart);
  const settings = useMemo(() => {
    const saved = previewSettings ?? DEFAULT_PREVIEW_SETTINGS;
    return {
      ...saved,
      choices: saved.choices.filter((choice) => choice.scene_id === sceneId),
    };
  }, [previewSettings, sceneId]);
  const targetKey = `${sceneId}:${nodeId}`;
  const buttonInstanceIds = useMemo(() => {
    const ids = new Set<string>();
    const scene = project.scenes.find((file) => file.definition.id === sceneId);
    for (const candidate of Object.values(scene?.definition.nodes ?? {})) {
      if (candidate.type === "button_create") ids.add(candidate.instance_id);
    }
    return [...ids].sort();
  }, [project.scenes, sceneId]);
  const selectedButtonInstanceId = buttonInstanceIds.includes(
    newButtonInstanceId,
  )
    ? newButtonInstanceId
    : (buttonInstanceIds[0] ?? "");

  const handlePreviewFrame = useCallback((next: SceneFrame): void => {
    // The Pixi preview owns the running clock. Mirror every emitted frame so
    // the visible ruler, keyboard playback and authoring operations all use
    // the exact same playhead.
    playheadRef.current = next.elapsed_ms;
    setPlayhead(next.elapsed_ms);
    setFrame(next);
  }, []);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);
  useEffect(() => {
    workspaceRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    nodeRef.current = localNode;
  }, [localNode]);
  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);
  useEffect(() => {
    playbackStartRef.current = playbackStart;
  }, [playbackStart]);
  useEffect(() => {
    // Keep an immediate local draft while App batches the history commit.
    // Parent replacements (undo/redo) must still reset that draft.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocalNode(node);
  }, [node]);

  const urls = useMemo(
    () =>
      Object.fromEntries(
        assets.map((asset) => [asset.id, assetUrl(asset.absolute_path)]),
      ),
    [assets],
  );

  // Frame lists for animated artwork.  The preview positions frames from the
  // timeline playhead, so scrubbing deterministically selects the same frame
  // the game would show at that decorative time.
  const animationMap = useMemo(
    () => buildAnimationMap(assets, project.animations),
    [assets, project.animations],
  );

  const handleDiagnostic = useCallback(
    (message: string): void => onError(message),
    [onError],
  );

  useEffect(() => {
    diagnosticRef.current = handleDiagnostic;
  }, [handleDiagnostic]);

  useEffect(() => {
    // Frame lists are a context dependency: re-resolving assets never restarts
    // a loop whose asset did not change.
    sessionRef.current?.setAnimations(animationMap);
  }, [animationMap]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const existing = previewLifecycleRef.current;
    if (existing === null) {
      previewLifecycleRef.current = new DeferredSession<EditorTimelinePreview>({
        create: () => {
          const created = createEditorTimelinePreview(
            canvas,
            (message: string) => diagnosticRef.current(message),
            previewEnvironment,
          );
          return {
            session: created.preview,
            initialized: created.initialized,
          };
        },
        dispose: (preview) => disposeEditorTimelinePreview(preview),
      });
    }
    const lifecycle = previewLifecycleRef.current;
    if (lifecycle === null) return;
    // One shared surface + session per canvas. React Strict Mode immediately
    // probes effects with a setup/cleanup/setup cycle, so disposal is deferred
    // by one task and the second setup reclaims the same initialized WebGL
    // application instead of tearing it down; on a real unmount the deferred
    // disposal releases objects, media, listeners and audio.
    const handle = lifecycle.acquire();
    const preview = handle.session;
    preview.session.setFrameListener(handlePreviewFrame);
    preview.session.setPlayingListener(setPlaying);
    surfaceRef.current = preview.surface;
    sessionRef.current = preview.session;
    let active = true;
    const ready = handle.initialized.then(() => undefined);
    surfaceReadyRef.current = ready;
    void ready.catch((error: unknown) => {
      if (active)
        handleDiagnostic(`时间轴 Pixi 初始化失败：${errorMessage(error)}`);
    });
    return () => {
      active = false;
      contextRequestRef.current += 1;
      preview.session.setFrameListener(null);
      preview.session.setPlayingListener(null);
      surfaceRef.current = null;
      sessionRef.current = null;
      // A pending patch-load belongs to the disposed session; the next
      // session starts clean so the first patch may use the fast path.
      loadPendingRef.current = false;
      lifecycle.release();
    };
  }, [handleDiagnostic, handlePreviewFrame, previewEnvironment]);

  const buildContext = useCallback(
    async (nextSettings = settings): Promise<void> => {
      const requestId = ++contextRequestRef.current;
      // A context rebuild prepares a whole new cue; any live-patch load is
      // superseded by this rebuild's own loads.
      loadPendingRef.current = false;
      setContextBusy(true);
      setContextError(null);
      setPendingChoice(null);
      try {
        const draft = projectRef.current;
        const result = await editorApi.buildNodePreview({
          project: projectRequest(draft, importTokens),
          target: {
            scene_id: sceneId,
            node_id: nodeId,
          },
          variable_overrides: nextSettings.variable_overrides,
          choices: nextSettings.choices,
        });
        if (requestId !== contextRequestRef.current) return;
        if (result.status === "needs_choice") {
          setPendingChoice(result);
          setContextStatus(
            `等待选择：${result.location.scene_id}/${result.location.node_id}`,
          );
        } else if (result.status === "unreachable") {
          setContextStatus("无法到达目标节点");
          setContextError(result.message);
          setCurrentPreview(null);
        } else {
          const surface = surfaceRef.current;
          const session = sessionRef.current;
          if (surface !== null && session !== null) {
            const desiredPlayhead = playheadRef.current;
            await surfaceReadyRef.current;
            if (sessionRef.current !== session) return;
            // Set the requested audio policy before restoring a snapshot: the
            // snapshot can already contain a looping BGM from the story path.
            session.setMuted(muted);
            const resolvedUrls =
              result.assets === undefined
                ? urls
                : previewAssetsToUrls(result.assets);
            const visuals = buildEditorVisualResources(
              draft,
              resolvedUrls,
              result,
            );
            surface.setVisualResources(visuals.textBlocks, visuals.particles);
            await session.load({
              update: result.update,
              assets: resolvedUrls,
              snapshot: result.start_snapshot,
              world: "restore",
              animations: animationMap,
            });
            // A newer context request supersedes this one while its
            // preparation was still decoding.  Its stale result must not
            // seek the replacement timeline or replace the newer preview.
            if (requestId !== contextRequestRef.current) return;
            await session.seek(desiredPlayhead, "scrub");
            if (requestId !== contextRequestRef.current) return;
          }
          setCurrentPreview(result);
          setContextStatus(
            `已捕获真实进入状态（${result.trace.length} 个边界）`,
          );
        }
      } catch (error) {
        if (requestId !== contextRequestRef.current) return;
        setCurrentPreview(null);
        setFrame(null);
        setPlaying(false);
        setContextStatus("上下文构建失败");
        setContextError(errorMessage(error));
      } finally {
        if (requestId === contextRequestRef.current) setContextBusy(false);
      }
    },
    [
      animationMap,
      importTokens,
      muted,
      sceneId,
      nodeId,
      setCurrentPreview,
      settings,
      urls,
    ],
  );

  useEffect(() => {
    // Building the preview is an intentional external-system synchronization
    // whenever the user opens a different timeline target.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void buildContext();
    // A target is intentionally the only automatic trigger. Timeline edits
    // patch the loaded cue locally and do not rerun the story path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  const patchLoadedCue = useCallback(
    (nextNode: TimelineNode): void => {
      const current = previewRef.current;
      const session = sessionRef.current;
      if (current === null || session === null) return;
      const requestId = ++patchRequestRef.current;
      const update = structuredClone(current.update);
      const timelineCue = update.cues.find(
        (cue) => (cue as { type?: string }).type === "timeline",
      ) as unknown as
        | {
            type: "timeline";
            duration_ms: number;
            tracks: unknown;
            events: unknown;
          }
        | undefined;
      if (timelineCue === undefined) return;
      timelineCue.duration_ms = nextNode.duration_ms;
      timelineCue.tracks = nextNode.tracks;
      // The editor authors the same canonical cue shapes the Rust loader
      // normalises YAML into, so editor events enter the shared preview
      // unchanged (no boundary normalisation).
      timelineCue.events = nextNode.events;
      const desiredPlayhead = playheadRef.current;
      // Ordinary keyframe edits only re-evaluate what is already prepared; a
      // change of artwork or video is a resource dependency and reloads the
      // context so the replacement pixels are prepared before they commit.
      // While a load is pending we always take the load path: a hot edit or an
      // undo may have restored a different resource signature, and merely
      // letting `applyTimelineEdit` succeed would leave the older pending load
      // free to commit its stale textures.  `session.load` aborts the previous
      // load (its own generation) and makes the newest cue authoritative.
      if (!loadPendingRef.current && session.applyTimelineEdit(update)) {
        // The committed keyframe is authoritative now.  Drop the transient
        // interactive override before seeking so the preview shows what the
        // timeline evaluates at the latest playhead instead of staying pinned
        // to the edited pose until the workspace is rebuilt.
        surfaceRef.current?.clearOverrides();
        void session
          .seek(desiredPlayhead, "scrub")
          .catch((error: unknown) =>
            onError(`时间轴预览刷新失败：${errorMessage(error)}`),
          );
        return;
      }
      loadPendingRef.current = true;
      void session
        .load({
          update,
          assets:
            current.assets === undefined
              ? urls
              : previewAssetsToUrls(current.assets),
          snapshot: current.start_snapshot,
          world: "restore",
          animations: animationMap,
        })
        .then((status) => {
          if (sessionRef.current !== session) {
            if (requestId === patchRequestRef.current)
              loadPendingRef.current = false;
            return;
          }
          // A newer patch owns the pending flag and the session now.
          if (requestId !== patchRequestRef.current) return;
          loadPendingRef.current = false;
          // A superseded load reports `stale`; it left the newer load's state
          // intact, so this callback must not clear overrides or seek.
          if (status === "stale") return;
          surfaceRef.current?.clearOverrides();
          return session.seek(desiredPlayhead, "scrub");
        })
        .catch((error: unknown) => {
          if (
            requestId === patchRequestRef.current &&
            sessionRef.current === session
          ) {
            loadPendingRef.current = false;
            onError(`时间轴预览刷新失败：${errorMessage(error)}`);
          }
        });
    },
    [animationMap, onError, urls],
  );

  useEffect(() => {
    if (nodeRef.current === node) return;
    const ownCommit = parentNodeCommitRef.current === node;
    parentNodeCommitRef.current = null;
    if (!ownCommit) {
      // Undo/redo or an external parent edit replaced the timeline node. Keep
      // the strict preview in lockstep with that authoritative document.
      setLocalNode(node);
      nodeRef.current = node;
      patchLoadedCue(node);
    }
  }, [node, patchLoadedCue]);

  const commitNode = useCallback(
    (next: TimelineNode): void => {
      if (
        selectedId !== null &&
        selectedObjectAssetChanged(nodeRef.current, next, selectedId)
      ) {
        // Replacing artwork can keep the same logical sprite id. Invalidate
        // the old interaction state instead of carrying its selection box and
        // pending transform onto the replacement.
        setSelectedId(null);
        setPendingTransforms((current) => {
          if (current[selectedId] === undefined) return current;
          const remaining = { ...current };
          Reflect.deleteProperty(remaining, selectedId);
          return remaining;
        });
      }
      setLocalNode(next);
      nodeRef.current = next;
      parentNodeCommitRef.current = next;
      onChange(next);
      patchLoadedCue(next);
    },
    [onChange, patchLoadedCue, selectedId],
  );

  const setPosition = useCallback(
    async (value: number): Promise<void> => {
      const next = Math.max(0, Math.min(localNode.duration_ms, value));
      playheadRef.current = next;
      setPlayhead(next);
      await sessionRef.current?.seek(next, "scrub");
    },
    [localNode.duration_ms],
  );

  const setPlaybackStartPosition = (value: number): void => {
    if (
      !autoKey &&
      (Object.keys(pendingTransforms).length > 0 || pendingCamera !== null)
    ) {
      commitPending();
    }
    const next = Math.max(0, Math.min(localNode.duration_ms, value));
    playbackStartRef.current = next;
    setPlaybackStart(next);
    if (playing) sessionRef.current?.pause();
    setPlaying(false);
    void setPosition(next);
  };

  const togglePlayback = (): void => {
    const session = sessionRef.current;
    if (session === null || preview === null) return;
    if (playing) {
      session.pause();
      setPlaying(false);
    } else {
      void (async (): Promise<void> => {
        // Each preview pass starts from the fixed marker, not from a prior
        // paused or completed playhead. This makes one timing range easy to
        // inspect repeatedly while authoring.
        await setPosition(playbackStartRef.current);
        if (sessionRef.current === session) await session.play();
      })();
    }
  };

  const upsertKeyframe = useCallback(
    (
      next: TimelineNode,
      trackIndex: number,
      channel: string,
      value: number,
    ): TimelineNode =>
      upsertKeyframeAt(
        next,
        trackIndex,
        channel,
        value,
        playheadRef.current,
        snap,
      ),
    [snap],
  );

  const writeObjectTransform = useCallback(
    (
      object: SceneObjectFrame,
      transform: Partial<SceneObjectFrame>,
      force = false,
    ): void => {
      let next = structuredClone(nodeRef.current);
      let trackIndex = next.tracks.findIndex(
        (track) =>
          (track.type === "sprite" && track.sprite_id === object.id) ||
          (track.type === "emitter" &&
            `emitter:${track.emitter_id}` === object.id) ||
          (track.type === "button" && track.instance_id === object.id) ||
          (track.type === "video" && `video:${track.asset}` === object.id),
      );
      if (trackIndex < 0 && object.kind === "sprite") {
        next.tracks.push({
          type: "sprite",
          sprite_id: object.id,
          asset: null,
          remove_at_end: false,
          channels: {},
        });
        trackIndex = next.tracks.length - 1;
      }
      if (trackIndex < 0 && object.kind === "emitter") {
        next.tracks.push({
          type: "emitter",
          emitter_id: object.id.slice("emitter:".length),
          remove_at_end: false,
          channels: {},
        });
        trackIndex = next.tracks.length - 1;
      }
      if (trackIndex < 0 && object.kind === "button") {
        next.tracks.push({
          type: "button",
          instance_id: object.id,
          channels: {},
        });
        trackIndex = next.tracks.length - 1;
      }
      if (trackIndex < 0) return;
      const channels = objectChannels(object.kind);
      for (const channel of channels) {
        const value = transform[channel as keyof SceneObjectFrame];
        if (typeof value === "number")
          next = upsertKeyframe(next, trackIndex, channel, value);
      }
      if (autoKey || force) commitNode(next);
      else
        setPendingTransforms((current) => ({
          ...current,
          [object.id]: { ...(current[object.id] ?? {}), ...transform },
        }));
    },
    [autoKey, commitNode, upsertKeyframe],
  );

  const beginObjectDrag = (
    event: ReactPointerEvent<HTMLElement>,
    object: SceneObjectFrame,
    handle: TransformHandle,
  ): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(object.id);
    if (playing) sessionRef.current?.pause();
    setPlaying(false);
    const stage = event.currentTarget.closest(".timeline-gizmo-layer");
    const rect = stage?.getBoundingClientRect();
    if (rect === null || rect === undefined) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const initial = { ...object };
    let moved = false;
    const move = (moveEvent: PointerEvent): void => {
      const dx = ((moveEvent.clientX - startX) / rect.width) * DESIGN_WIDTH;
      const dy = ((moveEvent.clientY - startY) / rect.height) * DESIGN_HEIGHT;
      moved = moved || Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5;
      const transform = dragTransform(
        handle,
        object,
        initial,
        dx,
        dy,
        frame?.camera,
      );
      surfaceRef.current?.setObjectOverride(object.id, transform);
      setFrame((current) =>
        current === null
          ? current
          : {
              ...current,
              objects: current.objects.map((candidate) =>
                candidate.id === object.id
                  ? { ...candidate, ...transform }
                  : candidate,
              ),
            },
      );
      if (!autoKey)
        setPendingTransforms((current) => ({
          ...current,
          [object.id]: transform,
        }));
    };
    let finished = false;
    const cleanup = (): void => {
      if (finished) return;
      finished = true;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      if (gestureCancelRef.current === cancel) gestureCancelRef.current = null;
    };
    const cancel = (): void => {
      cleanup();
      const surface = surfaceRef.current;
      surface?.clearOverrides();
      void sessionRef.current?.seek(playheadRef.current, "scrub");
      setPendingTransforms((current) => {
        const next = { ...current };
        Reflect.deleteProperty(next, object.id);
        return next;
      });
    };
    const up = (): void => {
      cleanup();
      const finalObject = sessionRef.current
        ?.frameAt(playheadRef.current)
        .objects.find((candidate) => candidate.id === object.id);
      if (moved && finalObject !== undefined) {
        const transform = releasedTransform(handle, object, finalObject);
        writeObjectTransform(finalObject, transform);
      }
    };
    gestureCancelRef.current = cancel;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true });
  };

  const commitPending = (): void => {
    for (const [id, transform] of Object.entries(pendingTransforms)) {
      const object = frame?.objects.find((candidate) => candidate.id === id);
      if (object === undefined) continue;
      writeObjectTransform(object, transform, true);
    }
    if (pendingCamera !== null) {
      const next = structuredClone(nodeRef.current);
      let trackIndex = next.tracks.findIndex(
        (track) => track.type === "camera",
      );
      if (trackIndex < 0) {
        next.tracks.push({ type: "camera", channels: {} });
        trackIndex = next.tracks.length - 1;
      }
      commitNode(
        ["x", "y", "zoom", "rotation_deg"].reduce(
          (current, channel) =>
            upsertKeyframe(
              current,
              trackIndex,
              channel,
              pendingCamera[channel as keyof typeof pendingCamera],
            ),
          next,
        ),
      );
    }
    setPendingTransforms({});
    setPendingCamera(null);
  };

  const requestBack = (): void => {
    if (gestureCancelRef.current !== null) {
      gestureCancelRef.current();
      return;
    }
    if (Object.keys(pendingTransforms).length > 0 || pendingCamera !== null) {
      setExitPrompt(true);
      return;
    }
    onBack();
  };

  const discardPending = (): void => {
    surfaceRef.current?.clearOverrides();
    void sessionRef.current?.seek(playheadRef.current, "scrub");
    setPendingTransforms({});
    setPendingCamera(null);
    setExitPrompt(false);
  };

  const toggleAutoKey = (): void => {
    if (
      !autoKey &&
      (Object.keys(pendingTransforms).length > 0 || pendingCamera !== null)
    ) {
      commitPending();
    }
    setAutoKey((value) => !value);
  };

  const addTrack = (): void => {
    const selected =
      selectedId === null
        ? undefined
        : frame?.objects.find((object) => object.id === selectedId);
    const plan = planNewTrack({
      current: nodeRef.current,
      newTrackType,
      objectIds: (frame?.objects ?? []).map((object) => object.id),
      selected,
      selectedButtonInstanceId,
      spriteAsset: firstVisibleAssetId(assets, assetLayout, "sprite"),
      videoAsset: firstVisibleAssetId(assets, assetLayout, "video"),
    });
    if ("error" in plan) {
      onError(plan.error);
      return;
    }
    const current = nodeRef.current;
    commitNode({ ...current, tracks: [...current.tracks, plan.track] });
  };

  const addTimelineEvent = (kind: TimelineEvent["type"]): void => {
    if (kind === "sfx" && visibleSfx === null) {
      onError("没有可用的音效素材（或全部已隐藏），无法新建 SFX 事件。");
      return;
    }
    const current = nodeRef.current;
    const atMs = snapTime(playheadRef.current, snap, current.duration_ms);
    const event = newTimelineEvent(kind, current, atMs, visibleSfx ?? "");
    commitNode({
      ...current,
      events: [...current.events, event].sort(
        (left, right) => left.at_ms - right.at_ms,
      ),
    });
  };

  const addScreenEffectPreset = (preset: ScreenEffectPreset): void => {
    const current = nodeRef.current;
    const atMs = snapTime(playheadRef.current, snap, current.duration_ms);
    const inserted = presetTimelineEvents(
      preset,
      atMs,
      current.duration_ms,
      current.events.map((event) => event.id),
    );
    if (inserted.length === 0) {
      onError(PRESET_NO_ROOM_MESSAGE);
      return;
    }
    commitNode({
      ...current,
      events: [...current.events, ...inserted].sort(
        (left, right) => left.at_ms - right.at_ms,
      ),
    });
  };

  const beginTimelineResize = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const initialHeight = timelineHeight;
    const move = (moveEvent: PointerEvent): void => {
      const availableHeight = Math.max(230, window.innerHeight - 150);
      const nextHeight = Math.round(
        Math.min(
          availableHeight,
          Math.max(230, initialHeight + startY - moveEvent.clientY),
        ),
      );
      setTimelineHeight(nextHeight);
    };
    const cleanup = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      document.body.classList.remove("timeline-resizing");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", cleanup, { once: true });
    window.addEventListener("pointercancel", cleanup, { once: true });
    document.body.classList.add("timeline-resizing");
  };

  const writeCameraTransform = (camera: {
    x: number;
    y: number;
    zoom: number;
    rotation_deg: number;
  }): void => {
    let next = structuredClone(nodeRef.current);
    let trackIndex = next.tracks.findIndex((track) => track.type === "camera");
    if (trackIndex < 0) {
      next.tracks.push({ type: "camera", channels: {} });
      trackIndex = next.tracks.length - 1;
    }
    for (const channel of ["x", "y", "zoom", "rotation_deg"] as const)
      next = upsertKeyframe(next, trackIndex, channel, camera[channel]);
    if (autoKey) commitNode(next);
    else setPendingCamera(camera);
  };

  const beginCameraDrag = (
    event: ReactPointerEvent<HTMLElement>,
    handle: CameraHandle,
  ): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (playing) sessionRef.current?.pause();
    setPlaying(false);
    const layer = event.currentTarget.closest(".timeline-gizmo-layer");
    const rect = layer?.getBoundingClientRect();
    if (rect === null || rect === undefined) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const startCamera = frame?.camera ?? {
      x: 0,
      y: 0,
      zoom: 1,
      rotation_deg: 0,
    };
    let latestCamera = { ...startCamera };
    let moved = false;
    const move = (moveEvent: PointerEvent): void => {
      const dx = ((moveEvent.clientX - startX) / rect.width) * DESIGN_WIDTH;
      const dy = ((moveEvent.clientY - startY) / rect.height) * DESIGN_HEIGHT;
      moved = moved || Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5;
      latestCamera =
        handle === "zoom"
          ? {
              ...startCamera,
              zoom: Math.max(0.05, startCamera.zoom - dy / 540),
            }
          : handle === "rotate"
            ? {
                ...startCamera,
                rotation_deg: startCamera.rotation_deg + dx * 0.35,
              }
            : { ...startCamera, x: startCamera.x + dx, y: startCamera.y + dy };
      surfaceRef.current?.setCameraOverride(latestCamera);
      setFrame((current) =>
        current === null ? current : { ...current, camera: latestCamera },
      );
    };
    let finished = false;
    const cleanup = (): void => {
      if (finished) return;
      finished = true;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      if (gestureCancelRef.current === cancel) gestureCancelRef.current = null;
    };
    const cancel = (): void => {
      cleanup();
      const surface = surfaceRef.current;
      surface?.clearOverrides();
      void sessionRef.current?.seek(playheadRef.current, "scrub");
      setPendingCamera(null);
    };
    const up = (): void => {
      cleanup();
      if (moved) writeCameraTransform(latestCamera);
    };
    gestureCancelRef.current = cancel;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true });
  };

  const onChoice = (choiceId: string): void => {
    if (pendingChoice === null) return;
    const choices: PreviewChoiceDecision[] = [
      ...settings.choices.filter(
        (choice) =>
          !(
            choice.scene_id === pendingChoice.location.scene_id &&
            choice.node_id === pendingChoice.location.node_id &&
            choice.visit === pendingChoice.visit
          ),
      ),
      {
        scene_id: pendingChoice.location.scene_id,
        node_id: pendingChoice.location.node_id,
        visit: pendingChoice.visit,
        choice_id: choiceId,
      },
    ];
    const nextSettings = { ...settings, choices };
    onPreviewSettingsChange(nextSettings);
    void buildContext(nextSettings);
  };

  // The track scroller and range control can consume Space before a bubbled
  // React handler sees it. Capture it while this workspace owns focus, so its
  // native page/track scroll (or a focused button's click) never runs.
  useEffect(() => {
    const onSpace = (event: KeyboardEvent): void => {
      if (event.key !== " " && event.code !== "Space") return;
      const workspace = workspaceRef.current;
      const target = event.target;
      if (
        workspace === null ||
        (!(target instanceof Node && workspace.contains(target)) &&
          !(
            target === document.body && document.activeElement === document.body
          )) ||
        event.defaultPrevented ||
        isComposing(event) ||
        isTextEntryTarget(target) ||
        (target instanceof Element &&
          target.closest('[role="dialog"], [role="menu"], [role="listbox"]') !==
            null) ||
        workspace.querySelector('[role="dialog"]') !== null
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      togglePlayback();
    };
    window.addEventListener("keydown", onSpace, true);
    return () => window.removeEventListener("keydown", onSpace, true);
  });

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.defaultPrevented || isComposing(event)) return;
    if (escapeTextEntry(event)) return;
    if (isEditableTarget(event.target)) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setPlaybackStartPosition(playbackStart - 10);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setPlaybackStartPosition(playbackStart + 10);
    } else if (event.key === "Escape") {
      if (gestureCancelRef.current !== null) {
        gestureCancelRef.current();
        return;
      }
      if (Object.keys(pendingTransforms).length > 0 || pendingCamera !== null) {
        setExitPrompt(true);
      } else requestBack();
    }
  };

  // The background-node adapter renders like any Sprite but is owned by
  // background nodes, so it gets no gizmo or list entry here.
  const objects = useMemo(
    () =>
      (frame?.objects ?? [])
        .filter((object) => object.id !== LEGACY_BACKGROUND_ID)
        .sort((left, right) => left.z - right.z),
    [frame?.objects],
  );
  // Buttons are placed by the DOM overlay in the game, above the camera-
  // transformed Pixi world.  The editor mirrors that with the shared button
  // component, its artwork coming from the runtime scene context and its
  // placement from the session-evaluated frame, so scrubbing shows exactly the
  // pose the game would show at that playhead.
  const buttonObjects = useMemo(
    () => objects.filter((object) => object.kind === "button"),
    [objects],
  );
  const previewButtons = preview?.start_snapshot.world.buttons;
  const gizmoObjects = useMemo(() => {
    if (selectedId === null) return objects;
    const selected = objects.find((object) => object.id === selectedId);
    return selected === undefined
      ? objects
      : [...objects.filter((object) => object.id !== selectedId), selected];
  }, [objects, selectedId]);
  const selectedObject =
    selectedId === null
      ? undefined
      : objects.find((object) => object.id === selectedId);
  useEffect(() => {
    if (selectedId === null || selectedObject !== undefined) return;
    // A video replacement changes its preview object id. Drop the departed
    // object's selection as soon as the refreshed frame arrives.
    const frame = requestAnimationFrame(() => setSelectedId(null));
    return () => cancelAnimationFrame(frame);
  }, [selectedId, selectedObject]);
  const editObjectChannel = (
    object: SceneObjectFrame,
    channel: keyof SceneObjectFrame,
    value: number,
  ): void => {
    if (!Number.isFinite(value)) return;
    const transform: Partial<SceneObjectFrame> = { [channel]: value };
    surfaceRef.current?.setObjectOverride(object.id, transform);
    setFrame((current) =>
      current === null
        ? current
        : {
            ...current,
            objects: current.objects.map((candidate) =>
              candidate.id === object.id
                ? { ...candidate, ...transform }
                : candidate,
            ),
          },
    );
    writeObjectTransform(object, transform);
  };
  const editSelectedKeyframe = (patch: Partial<TimelineKeyframe>): void => {
    if (selectedKeyframe === null) return;
    const next = structuredClone(nodeRef.current);
    const frames =
      next.tracks[selectedKeyframe.track]?.channels[selectedKeyframe.channel];
    const current = frames?.[selectedKeyframe.index];
    if (frames === undefined || current === undefined) return;
    const value = patch.value ?? current.value;
    frames[selectedKeyframe.index] = {
      ...current,
      ...patch,
      value,
      at_ms:
        value === "inherit"
          ? 0
          : Math.max(
              0,
              Math.min(next.duration_ms, patch.at_ms ?? current.at_ms),
            ),
    };
    frames.sort((left, right) => left.at_ms - right.at_ms);
    commitNode(next);
  };
  const editSelectedEvent = (edited: TimelineEvent): void => {
    if (selectedEvent === null) return;
    const next = structuredClone(nodeRef.current);
    const current = next.events[selectedEvent.index];
    if (current === undefined || current.id !== selectedEvent.event.id) return;
    next.events[selectedEvent.index] = {
      ...edited,
      at_ms: Math.max(0, Math.min(next.duration_ms, edited.at_ms)),
    };
    next.events.sort((left, right) => left.at_ms - right.at_ms);
    commitNode(next);
  };
  return (
    <main
      className="timeline-workspace"
      ref={workspaceRef}
      onKeyDown={handleKeyDown}
      style={{ "--timeline-height": `${timelineHeight}px` } as CSSProperties}
      tabIndex={0}
    >
      <WorkspaceHeader
        dirty={dirty}
        icon={Clapperboard}
        kind="关键帧时间线"
        onBack={requestBack}
        onRedo={onRedo}
        onSave={onSave}
        onUndo={onUndo}
        redoAvailable={futureAvailable}
        title={`${sceneId} / ${nodeId}`}
        undoAvailable={pastAvailable}
      >
        <div className="workspace-transport">
          <IconButton
            disabled={preview === null}
            icon={playing ? Pause : Play}
            label={playing ? "暂停" : "播放"}
            onClick={togglePlayback}
            shortcut="Space"
            variant="secondary"
          />
          <code className="workspace-transport-readout">
            播放 {Math.round(playhead)} · 起点 {Math.round(playbackStart)} ms
          </code>
        </div>
        <label className="workspace-header-field">
          时长
          <DeferredInput
            aria-label="时间线时长"
            max={1_800_000}
            min={1}
            onCommit={(raw) => {
              const duration = Number(raw);
              if (!Number.isInteger(duration) || duration < 1) return false;
              commitNode({ ...localNode, duration_ms: duration });
            }}
            type="number"
            value={String(localNode.duration_ms)}
          />
          <span>ms</span>
        </label>
        <label className="workspace-header-field">
          吸附
          <select
            aria-label="关键帧吸附"
            onChange={(event) => setSnap(Number(event.currentTarget.value))}
            value={snap}
          >
            <option value={10}>10 ms</option>
            <option value={50}>50 ms</option>
            <option value={100}>100 ms</option>
          </select>
        </label>
        <Button
          aria-pressed={autoKey}
          className={autoKey ? "is-active" : ""}
          icon={KeyRound}
          onClick={toggleAutoKey}
          size="sm"
          title="修改选中对象时自动在播放头写入关键帧"
          variant="ghost"
        >
          自动关键帧
        </Button>
        <IconButton
          icon={muted ? VolumeX : Volume2}
          label={muted ? "取消静音" : "静音"}
          onClick={() => {
            const next = !muted;
            setMuted(next);
            sessionRef.current?.setMuted(next);
          }}
          size="sm"
        />
        <span className="workspace-context-status" title={contextStatus}>
          {contextStatus}
        </span>
        <IconButton
          disabled={contextBusy}
          icon={RefreshCw}
          label={contextBusy ? "建立中…" : "重建上下文"}
          onClick={() => void buildContext()}
          size="sm"
          tooltip="重新用运行时计算进入这个节点时的画面状态"
        />
      </WorkspaceHeader>
      <div className="timeline-workspace-main">
        <section className="timeline-stage-pane">
          <div className="timeline-stage-wrap">
            <canvas
              className="timeline-stage"
              height={DESIGN_HEIGHT}
              ref={canvasRef}
              width={DESIGN_WIDTH}
            />
            <GizmoLayer
              animationMap={animationMap}
              buttonObjects={buttonObjects}
              camera={frame?.camera}
              gizmoObjects={gizmoObjects}
              onCameraDrag={beginCameraDrag}
              onObjectDrag={beginObjectDrag}
              previewButtons={previewButtons}
              selectedId={selectedId}
              targetKey={targetKey}
              tool={tool}
              urls={urls}
            />
          </div>
          <StageToolbar
            addTrackDisabled={
              selectedObject === undefined &&
              newTrackType === "video" &&
              visibleVideo === null
            }
            addTrackTitle={
              selectedObject === undefined &&
              newTrackType === "video" &&
              visibleVideo === null
                ? "没有可用的视频素材（或全部已隐藏），无法新建视频轨"
                : undefined
            }
            buttonInstanceIds={buttonInstanceIds}
            hasPendingEdits={
              !autoKey &&
              (Object.keys(pendingTransforms).length > 0 ||
                pendingCamera !== null)
            }
            newTrackType={newTrackType}
            onAddEvent={addTimelineEvent}
            onAddPreset={addScreenEffectPreset}
            onAddTrack={addTrack}
            onButtonInstanceChange={setNewButtonInstanceId}
            onCommitPending={commitPending}
            onNewTrackTypeChange={setNewTrackType}
            onStop={() => setPlaybackStartPosition(0)}
            onToolChange={setTool}
            selectedButtonInstanceId={selectedButtonInstanceId}
            sfxAvailable={visibleSfx !== null}
            tool={tool}
          />
        </section>
        <aside className="timeline-workspace-inspector">
          <PreviewContextPanel
            contextError={contextError}
            onChoice={onChoice}
            onInvalidOverrides={() => onError("变量覆盖不是有效 JSON")}
            onOverridesChange={(variable_overrides) => {
              const nextSettings = { ...settings, variable_overrides };
              onPreviewSettingsChange(nextSettings);
              void buildContext(nextSettings);
            }}
            overrides={settings.variable_overrides}
            pendingChoice={pendingChoice}
          />
          <h3>对象</h3>
          <div className="timeline-object-list">
            {objects.map((object) => (
              <button
                className={selectedId === object.id ? "active" : ""}
                key={object.id}
                onClick={() => setSelectedId(object.id)}
                type="button"
              >
                <span>
                  {object.kind === "video"
                    ? "VID"
                    : object.kind === "button"
                      ? "BTN"
                      : object.kind === "emitter"
                        ? "EMT"
                        : "SPR"}
                </span>
                {object.id}
                <small>z {Math.round(object.z)}</small>
              </button>
            ))}
          </div>
          {selectedObject !== undefined && (
            <ObjectInspector
              object={selectedObject}
              onEditChannel={editObjectChannel}
            />
          )}
          {selectedKeyframe !== null && (
            <TimelineKeyframeInspector
              allowInherit={
                selectedKeyframe.index === 0 &&
                localNode.tracks[selectedKeyframe.track]?.type !== "video" &&
                (localNode.tracks[selectedKeyframe.track]?.channels[
                  selectedKeyframe.channel
                ]?.length ?? 0) >= 2
              }
              selection={selectedKeyframe}
              onChange={editSelectedKeyframe}
            />
          )}
          {selectedEvent !== null && (
            <TimelineEventInspector
              assets={assets}
              selection={selectedEvent}
              onChange={editSelectedEvent}
            />
          )}
        </aside>
      </div>
      <section className="timeline-workspace-tracks">
        <div
          aria-label="调整时间轴高度"
          className="timeline-resize-handle"
          onPointerDown={beginTimelineResize}
          role="separator"
          tabIndex={0}
        />
        <TimelineEditor
          assets={assets}
          textBlocks={project.text_blocks ?? []}
          hidePreview
          hideTransport
          node={localNode}
          onChange={commitNode}
          onEventSelectionChange={setSelectedEvent}
          onPlayheadChange={setPlaybackStartPosition}
          onSelectionChange={setSelectedKeyframe}
          onSnapChange={setSnap}
          playheadOverride={playhead}
          playbackStartOverride={playbackStart}
          snapOverride={snap}
        />
        <input
          aria-label="时间线播放头"
          className="timeline-workspace-range"
          max={localNode.duration_ms}
          min={0}
          onChange={(event) =>
            setPlaybackStartPosition(Number(event.currentTarget.value))
          }
          type="range"
          value={playbackStart}
        />
      </section>
      {exitPrompt && (
        <PendingExitDialog
          onCancel={() => setExitPrompt(false)}
          onCommitAndLeave={() => {
            commitPending();
            setExitPrompt(false);
            onBack();
          }}
          onDiscardAndLeave={() => {
            discardPending();
            onBack();
          }}
        />
      )}
    </main>
  );
}

