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
import { assetUrl, editorApi } from "../api";
import { projectRequest } from "../story";
import type {
  EditorAsset,
  EditorProject,
  PreviewChoiceDecision,
  ScalarValue,
  TimelineEasing,
  TimelineEvent,
  TimelineKeyframe,
  TimelineNode,
  TimelineTrack,
  TimelinePreviewResult,
  TimelinePreviewSettings,
} from "../types";
import {
  TimelineEditor,
  type TimelineEventSelection,
  type TimelineSelection,
} from "./TimelineEditor";
import type { RuntimeUpdate as GameRuntimeUpdate } from "../../../src/engine/types";
import {
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  TimelinePreviewSurface,
  type PreviewObjectFrame,
  type TimelinePreviewFrame,
} from "../../../src/engine/timelinePreview";

interface TimelineWorkspaceProps {
  project: EditorProject;
  sceneId: string;
  nodeId: string;
  node: TimelineNode;
  assets: EditorAsset[];
  dirty: boolean;
  futureAvailable: boolean;
  previewSettings: TimelinePreviewSettings | undefined;
  onBack(): void;
  onChange(node: TimelineNode): void;
  onPreviewSettingsChange(settings: TimelinePreviewSettings): void;
  onSave(): void;
  onUndo(): void;
  onRedo(): void;
  onError(message: string): void;
}

type Tool = "select" | "camera";
type TransformHandle = "move" | "scale" | "scale_x" | "scale_y" | "rotate";
type CameraHandle = "move" | "zoom" | "rotate";

const DEFAULT_PREVIEW_SETTINGS: TimelinePreviewSettings = {
  variable_overrides: {},
  choices: [],
};

export function TimelineWorkspace({
  project,
  sceneId,
  nodeId,
  node,
  assets,
  dirty,
  futureAvailable,
  previewSettings,
  onBack,
  onChange,
  onPreviewSettingsChange,
  onSave,
  onUndo,
  onRedo,
  onError,
}: TimelineWorkspaceProps): ReactElement {
  const [localNode, setLocalNode] = useState(node);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [autoKey, setAutoKey] = useState(true);
  const [muted, setMuted] = useState(true);
  const [snap, setSnap] = useState(50);
  const [newTrackType, setNewTrackType] =
    useState<TimelineTrack["type"]>("sprite");
  const [tool, setTool] = useState<Tool>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedKeyframe, setSelectedKeyframe] =
    useState<TimelineSelection | null>(null);
  const [selectedEvent, setSelectedEvent] =
    useState<TimelineEventSelection | null>(null);
  const [frame, setFrame] = useState<TimelinePreviewFrame | null>(null);
  const [preview, setPreview] = useState<Extract<
    TimelinePreviewResult,
    { status: "ready" }
  > | null>(null);
  const [contextStatus, setContextStatus] = useState("尚未建立真实上下文");
  const [contextBusy, setContextBusy] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [pendingChoice, setPendingChoice] = useState<Extract<
    TimelinePreviewResult,
    { status: "needs_choice" }
  > | null>(null);
  const [pendingTransforms, setPendingTransforms] = useState<
    Record<string, Partial<PreviewObjectFrame>>
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
  const surfaceRef = useRef<TimelinePreviewSurface | null>(null);
  const surfaceReadyRef = useRef<Promise<void>>(Promise.resolve());
  const contextRequestRef = useRef(0);
  const gestureCancelRef = useRef<(() => void) | null>(null);
  const parentNodeCommitRef = useRef<TimelineNode | null>(null);
  const projectRef = useRef(project);
  const nodeRef = useRef(localNode);
  const playheadRef = useRef(playhead);
  const settings = previewSettings ?? DEFAULT_PREVIEW_SETTINGS;
  const targetKey = `${sceneId}:${nodeId}`;

  useEffect(() => {
    projectRef.current = project;
  }, [project]);
  useEffect(() => {
    nodeRef.current = localNode;
  }, [localNode]);
  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);
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

  const handleDiagnostic = useCallback(
    (message: string): void => onError(message),
    [onError],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const surface = new TimelinePreviewSurface(
      canvas,
      handleDiagnostic,
      setFrame,
    );
    surface.setOnPlayingChange(setPlaying);
    surfaceRef.current = surface;
    let active = true;
    const ready = surface.init();
    surfaceReadyRef.current = ready;
    void ready.catch((error: unknown) => {
      if (active)
        handleDiagnostic(`时间轴 Pixi 初始化失败：${errorMessage(error)}`);
    });
    return () => {
      active = false;
      contextRequestRef.current += 1;
      surface.destroy();
      surfaceRef.current = null;
    };
  }, [handleDiagnostic]);

  const buildContext = useCallback(
    async (nextSettings = settings): Promise<void> => {
      const requestId = ++contextRequestRef.current;
      setContextBusy(true);
      setContextError(null);
      setPendingChoice(null);
      try {
        const result = await editorApi.buildTimelinePreview({
          project: projectRequest(projectRef.current),
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
          setPreview(null);
        } else {
          setPreview(result);
          setContextStatus(
            `已捕获真实进入状态（${result.trace.length} 个边界）`,
          );
          const surface = surfaceRef.current;
          if (surface !== null) {
            await surfaceReadyRef.current;
            if (surfaceRef.current !== surface) return;
            await surface.load(
              result.start_snapshot,
              result.update as unknown as GameRuntimeUpdate,
              urls,
            );
            await surface.seek(playheadRef.current, false);
            surface.setMuted(muted);
          }
        }
      } catch (error) {
        if (requestId !== contextRequestRef.current) return;
        setContextStatus("上下文构建失败");
        setContextError(errorMessage(error));
      } finally {
        if (requestId === contextRequestRef.current) setContextBusy(false);
      }
    },
    [muted, sceneId, nodeId, settings, urls],
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
      const current = preview;
      const surface = surfaceRef.current;
      if (current === null || surface === null) return;
      const update = structuredClone(
        current.update,
      ) as unknown as GameRuntimeUpdate;
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
      timelineCue.events = nextNode.events;
      void surface
        .load(current.start_snapshot, update, urls)
        .then(() => surface.seek(playheadRef.current, false))
        .catch((error: unknown) => {
          if (surfaceRef.current === surface)
            onError(`时间轴预览刷新失败：${errorMessage(error)}`);
        });
    },
    [onError, preview, urls],
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
      setLocalNode(next);
      nodeRef.current = next;
      parentNodeCommitRef.current = next;
      onChange(next);
      patchLoadedCue(next);
    },
    [onChange, patchLoadedCue],
  );

  const setPosition = useCallback(
    async (value: number): Promise<void> => {
      const next = Math.max(0, Math.min(localNode.duration_ms, value));
      setPlayhead(next);
      await surfaceRef.current?.seek(next, false);
    },
    [localNode.duration_ms],
  );

  const togglePlayback = (): void => {
    const surface = surfaceRef.current;
    if (surface === null || preview === null) return;
    if (playing) {
      surface.pause();
      setPlaying(false);
    } else {
      void surface.play();
      setPlaying(true);
    }
  };

  const upsertKeyframe = useCallback(
    (
      next: TimelineNode,
      trackIndex: number,
      channel: string,
      value: number,
    ): TimelineNode => {
      const tracks = structuredClone(next.tracks);
      const track = tracks[trackIndex];
      if (track === undefined) return next;
      const at = snapTime(playheadRef.current, snap, next.duration_ms);
      const frames = [...(track.channels[channel] ?? [])];
      const index = frames.findIndex((frame) => frame.at_ms === at);
      const keyframe = { at_ms: at, value, easing: "linear" as const };
      if (index >= 0) frames[index] = keyframe;
      else frames.push(keyframe);
      frames.sort((left, right) => left.at_ms - right.at_ms);
      track.channels[channel] = frames;
      return { ...next, tracks };
    },
    [snap],
  );

  const writeObjectTransform = useCallback(
    (
      object: PreviewObjectFrame,
      transform: Partial<PreviewObjectFrame>,
      force = false,
    ): void => {
      let next = structuredClone(nodeRef.current);
      let trackIndex = next.tracks.findIndex(
        (track) =>
          (track.type === "sprite" && track.sprite_id === object.id) ||
          (track.type === "video" && `video:${track.asset}` === object.id),
      );
      if (trackIndex < 0 && object.kind === "sprite") {
        next.tracks.push({
          type: "sprite",
          sprite_id: object.id,
          asset: object.asset,
          remove_at_end: false,
          channels: {},
        });
        trackIndex = next.tracks.length - 1;
      }
      if (trackIndex < 0) return;
      const channels =
        object.kind === "video"
          ? ["x", "y", "width", "height", "opacity", "z"]
          : [
              "x",
              "y",
              "scale",
              "scale_x",
              "scale_y",
              "rotation_deg",
              "opacity",
              "z",
            ];
      for (const channel of channels) {
        const value = transform[channel as keyof PreviewObjectFrame];
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
    object: PreviewObjectFrame,
    handle: TransformHandle,
  ): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(object.id);
    if (playing) surfaceRef.current?.pause();
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
      const transform: Partial<PreviewObjectFrame> =
        handle === "move"
          ? { x: initial.x + dx, y: initial.y + dy }
          : handle === "rotate"
            ? { rotation_deg: initial.rotation_deg + dx * 0.35 }
            : handle === "scale_x"
              ? object.kind === "video"
                ? { width: Math.max(16, initial.width + dx) }
                : { scale_x: Math.max(0.05, initial.scale_x + dx / 450) }
              : handle === "scale_y"
                ? object.kind === "video"
                  ? { height: Math.max(16, initial.height + dy) }
                  : { scale_y: Math.max(0.05, initial.scale_y - dy / 450) }
                : object.kind === "video"
                  ? {
                      width: Math.max(16, initial.width + dx),
                      height: Math.max(16, initial.height + dy),
                    }
                  : { scale: Math.max(0.05, initial.scale + dy / 450) };
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
      void surface?.seek(playheadRef.current, false);
      setPendingTransforms((current) => {
        const next = { ...current };
        Reflect.deleteProperty(next, object.id);
        return next;
      });
    };
    const up = (): void => {
      cleanup();
      const finalObject = surfaceRef.current
        ?.frameAt(playheadRef.current)
        .objects.find((candidate) => candidate.id === object.id);
      if (moved && finalObject !== undefined) {
        const transform =
          handle === "move"
            ? { x: finalObject.x, y: finalObject.y }
            : handle === "rotate"
              ? { rotation_deg: finalObject.rotation_deg }
              : handle === "scale_x"
                ? object.kind === "video"
                  ? { width: finalObject.width }
                  : { scale_x: finalObject.scale_x }
                : handle === "scale_y"
                  ? object.kind === "video"
                    ? { height: finalObject.height }
                    : { scale_y: finalObject.scale_y }
                  : object.kind === "video"
                    ? { width: finalObject.width, height: finalObject.height }
                    : { scale: finalObject.scale };
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
    void surfaceRef.current?.seek(playheadRef.current, false);
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
    const current = nodeRef.current;
    const spriteAsset =
      assets.find((asset) => asset.kind === "sprite")?.id ?? "";
    const videoAsset = assets.find((asset) => asset.kind === "video")?.id ?? "";
    const track: TimelineTrack =
      newTrackType === "sprite"
        ? {
            type: "sprite",
            sprite_id: `sprite_${current.tracks.length + 1}`,
            asset: spriteAsset,
            remove_at_end: false,
            channels: {},
          }
        : newTrackType === "video"
          ? {
              type: "video",
              asset: videoAsset,
              clip_start_ms: 0,
              clip_end_ms: null,
              loop: false,
              fit: "contain",
              audio_enabled: true,
              channels: {},
            }
          : { type: newTrackType, channels: {} };
    commitNode({ ...current, tracks: [...current.tracks, track] });
  };

  const addTimelineEvent = (kind: TimelineEvent["type"]): void => {
    const current = nodeRef.current;
    const atMs = snapTime(playheadRef.current, snap, current.duration_ms);
    const used = new Set(current.events.map((event) => event.id));
    let index = current.events.length + 1;
    const prefix = kind === "sfx" ? "sfx" : "flash";
    while (used.has(`${prefix}_${index}`)) index += 1;
    const event: TimelineEvent =
      kind === "sfx"
        ? {
            type: "sfx",
            id: `${prefix}_${index}`,
            at_ms: atMs,
            asset: assets.find((asset) => asset.kind === "sfx")?.id ?? "",
            volume: 1,
          }
        : {
            type: "screen_effect",
            id: `${prefix}_${index}`,
            at_ms: atMs,
            effect: "flash",
            duration_ms: Math.max(1, Math.min(200, current.duration_ms - atMs)),
          };
    commitNode({
      ...current,
      events: [...current.events, event].sort(
        (left, right) => left.at_ms - right.at_ms,
      ),
    });
  };

  const movePlayhead = (value: number): void => {
    if (
      !autoKey &&
      (Object.keys(pendingTransforms).length > 0 || pendingCamera !== null)
    ) {
      commitPending();
    }
    void setPosition(value);
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
    if (playing) surfaceRef.current?.pause();
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
      void surface?.seek(playheadRef.current, false);
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

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement
    )
      return;
    if (event.key === " ") {
      event.preventDefault();
      togglePlayback();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      movePlayhead(playhead - 10);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      movePlayhead(playhead + 10);
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

  const objects = useMemo(
    () => [...(frame?.objects ?? [])].sort((left, right) => left.z - right.z),
    [frame?.objects],
  );
  const selectedObject =
    selectedId === null
      ? undefined
      : objects.find((object) => object.id === selectedId);
  const editObjectChannel = (
    object: PreviewObjectFrame,
    channel: keyof PreviewObjectFrame,
    value: number,
  ): void => {
    if (!Number.isFinite(value)) return;
    const transform: Partial<PreviewObjectFrame> = { [channel]: value };
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
    frames[selectedKeyframe.index] = {
      ...current,
      ...patch,
      at_ms: Math.max(
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
      onKeyDown={handleKeyDown}
      style={{ "--timeline-height": `${timelineHeight}px` } as CSSProperties}
      tabIndex={0}
    >
      <header className="timeline-workspace-toolbar">
        <button onClick={requestBack} type="button">
          ← 返回剧情图
        </button>
        <strong>
          关键帧 · {sceneId}/{nodeId}
        </strong>
        <span className="timeline-context-status">{contextStatus}</span>
        <button
          disabled={contextBusy}
          onClick={() => void buildContext()}
          type="button"
        >
          {contextBusy ? "建立中…" : "重建上下文"}
        </button>
        <button
          disabled={preview === null}
          onClick={togglePlayback}
          type="button"
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <code>
          {Math.round(playhead)} / {localNode.duration_ms} ms
        </code>
        <label className="timeline-toolbar-select">
          吸附
          <select
            aria-label="关键帧吸附"
            onChange={(event) => setSnap(Number(event.currentTarget.value))}
            value={snap}
          >
            <option value={10}>10ms</option>
            <option value={50}>50ms</option>
            <option value={100}>100ms</option>
          </select>
        </label>
        <button
          className={autoKey ? "active" : ""}
          onClick={toggleAutoKey}
          type="button"
        >
          自动关键帧
        </button>
        <button
          onClick={() => {
            const next = !muted;
            setMuted(next);
            surfaceRef.current?.setMuted(next);
          }}
          type="button"
        >
          {muted ? "静音" : "声音"}
        </button>
        <button disabled={!futureAvailable} onClick={onRedo} type="button">
          重做
        </button>
        <button onClick={onUndo} type="button">
          撤销
        </button>
        <button disabled={!dirty} onClick={onSave} type="button">
          保存
        </button>
      </header>
      <div className="timeline-workspace-main">
        <section className="timeline-stage-pane">
          <div className="timeline-stage-wrap">
            <canvas
              className="timeline-stage"
              height={DESIGN_HEIGHT}
              ref={canvasRef}
              width={DESIGN_WIDTH}
            />
            <div className="timeline-gizmo-layer">
              {objects.map((object) => (
                <div
                  className={`timeline-gizmo${selectedId === object.id ? " selected" : ""}`}
                  key={object.id}
                  onPointerDown={(event) =>
                    beginObjectDrag(event, object, "move")
                  }
                  style={gizmoStyle(object, frame?.camera)}
                >
                  <span>{object.id}</span>
                  {selectedId === object.id && (
                    <>
                      <button
                        aria-label="缩放素材"
                        className="timeline-gizmo-scale"
                        onPointerDown={(event) =>
                          beginObjectDrag(event, object, "scale")
                        }
                        type="button"
                      />
                      <button
                        aria-label="水平缩放素材"
                        className="timeline-gizmo-scale-x"
                        onPointerDown={(event) =>
                          beginObjectDrag(event, object, "scale_x")
                        }
                        type="button"
                      />
                      <button
                        aria-label="垂直缩放素材"
                        className="timeline-gizmo-scale-y"
                        onPointerDown={(event) =>
                          beginObjectDrag(event, object, "scale_y")
                        }
                        type="button"
                      />
                      {object.kind === "sprite" && (
                        <button
                          aria-label="旋转素材"
                          className="timeline-gizmo-rotate"
                          onPointerDown={(event) =>
                            beginObjectDrag(event, object, "rotate")
                          }
                          type="button"
                        />
                      )}
                    </>
                  )}
                </div>
              ))}
              {tool === "camera" && (
                <div
                  className="timeline-camera-gizmo"
                  onPointerDown={(event) => beginCameraDrag(event, "move")}
                >
                  <button
                    aria-label="缩放镜头"
                    className="timeline-camera-zoom"
                    onPointerDown={(event) => beginCameraDrag(event, "zoom")}
                    type="button"
                  />
                  <button
                    aria-label="旋转镜头"
                    className="timeline-camera-rotate"
                    onPointerDown={(event) => beginCameraDrag(event, "rotate")}
                    type="button"
                  />
                </div>
              )}
            </div>
          </div>
          <div className="timeline-workspace-controls">
            <button onClick={() => movePlayhead(0)} type="button">
              ■
            </button>
            <button
              className={tool === "select" ? "active" : ""}
              onClick={() => setTool("select")}
              type="button"
            >
              选择
            </button>
            <button
              className={tool === "camera" ? "active" : ""}
              onClick={() => setTool("camera")}
              type="button"
            >
              镜头
            </button>
            {!autoKey &&
              (Object.keys(pendingTransforms).length > 0 ||
                pendingCamera !== null) && (
                <button onClick={commitPending} type="button">
                  写入所改通道
                </button>
              )}
            <select
              aria-label="新建轨道类型"
              onChange={(event) =>
                setNewTrackType(
                  event.currentTarget.value as TimelineTrack["type"],
                )
              }
              value={newTrackType}
            >
              <option value="sprite">立绘轨</option>
              <option value="camera">镜头轨</option>
              <option value="video">视频轨</option>
              <option value="bgm">BGM 轨</option>
            </select>
            <button onClick={addTrack} type="button">
              ＋轨道
            </button>
            <button onClick={() => addTimelineEvent("sfx")} type="button">
              ＋SFX
            </button>
            <button
              onClick={() => addTimelineEvent("screen_effect")}
              type="button"
            >
              ＋闪光
            </button>
          </div>
        </section>
        <aside className="timeline-workspace-inspector">
          <h3>预览上下文</h3>
          <p>使用运行时默认变量和已保存路径构造，不会写入玩家进度。</p>
          {contextError !== null && (
            <div className="timeline-context-error">{contextError}</div>
          )}
          {pendingChoice !== null && (
            <div className="timeline-choice-wizard">
              <strong>请选择预览路径</strong>
              {pendingChoice.choices.map((choice) => (
                <button
                  disabled={!choice.enabled}
                  key={choice.id}
                  onClick={() => onChoice(choice.id)}
                  type="button"
                >
                  {choice.label}
                </button>
              ))}
            </div>
          )}
          <label className="timeline-json-field">
            变量覆盖（JSON）
            <textarea
              defaultValue={JSON.stringify(
                settings.variable_overrides,
                null,
                2,
              )}
              key={JSON.stringify(settings.variable_overrides)}
              onBlur={(event) => {
                try {
                  const value = JSON.parse(event.currentTarget.value) as Record<
                    string,
                    ScalarValue
                  >;
                  const nextSettings = {
                    ...settings,
                    variable_overrides: value,
                  };
                  onPreviewSettingsChange(nextSettings);
                  void buildContext(nextSettings);
                } catch {
                  onError("变量覆盖不是有效 JSON");
                }
              }}
              spellCheck={false}
            />
          </label>
          <h3>对象</h3>
          <div className="timeline-object-list">
            {objects.map((object) => (
              <button
                className={selectedId === object.id ? "active" : ""}
                key={object.id}
                onClick={() => setSelectedId(object.id)}
                type="button"
              >
                <span>{object.kind === "video" ? "VID" : "SPR"}</span>
                {object.id}
                <small>z {Math.round(object.z)}</small>
              </button>
            ))}
          </div>
          {selectedObject !== undefined && (
            <div className="timeline-object-inspector">
              <strong>选中对象</strong>
              <label>
                X
                <input
                  onChange={(event) =>
                    editObjectChannel(
                      selectedObject,
                      "x",
                      Number(event.currentTarget.value),
                    )
                  }
                  step="0.1"
                  type="number"
                  value={selectedObject.x}
                />
              </label>
              <label>
                Y
                <input
                  onChange={(event) =>
                    editObjectChannel(
                      selectedObject,
                      "y",
                      Number(event.currentTarget.value),
                    )
                  }
                  step="0.1"
                  type="number"
                  value={selectedObject.y}
                />
              </label>
              {selectedObject.kind === "sprite" ? (
                <>
                  <label>
                    Scale
                    <input
                      onChange={(event) =>
                        editObjectChannel(
                          selectedObject,
                          "scale",
                          Number(event.currentTarget.value),
                        )
                      }
                      min="0.01"
                      step="0.01"
                      type="number"
                      value={selectedObject.scale}
                    />
                  </label>
                  <label>
                    Scale X
                    <input
                      onChange={(event) =>
                        editObjectChannel(
                          selectedObject,
                          "scale_x",
                          Number(event.currentTarget.value),
                        )
                      }
                      min="0.01"
                      step="0.01"
                      type="number"
                      value={selectedObject.scale_x}
                    />
                  </label>
                  <label>
                    Scale Y
                    <input
                      onChange={(event) =>
                        editObjectChannel(
                          selectedObject,
                          "scale_y",
                          Number(event.currentTarget.value),
                        )
                      }
                      min="0.01"
                      step="0.01"
                      type="number"
                      value={selectedObject.scale_y}
                    />
                  </label>
                  <label>
                    Rotation
                    <input
                      onChange={(event) =>
                        editObjectChannel(
                          selectedObject,
                          "rotation_deg",
                          Number(event.currentTarget.value),
                        )
                      }
                      step="0.1"
                      type="number"
                      value={selectedObject.rotation_deg}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label>
                    Width
                    <input
                      min="16"
                      onChange={(event) =>
                        editObjectChannel(
                          selectedObject,
                          "width",
                          Math.max(16, Number(event.currentTarget.value)),
                        )
                      }
                      step="1"
                      type="number"
                      value={selectedObject.width}
                    />
                  </label>
                  <label>
                    Height
                    <input
                      min="16"
                      onChange={(event) =>
                        editObjectChannel(
                          selectedObject,
                          "height",
                          Math.max(16, Number(event.currentTarget.value)),
                        )
                      }
                      step="1"
                      type="number"
                      value={selectedObject.height}
                    />
                  </label>
                </>
              )}
              <label>
                Opacity
                <input
                  max="1"
                  min="0"
                  onChange={(event) =>
                    editObjectChannel(
                      selectedObject,
                      "opacity",
                      Math.max(
                        0,
                        Math.min(1, Number(event.currentTarget.value)),
                      ),
                    )
                  }
                  step="0.01"
                  type="number"
                  value={selectedObject.opacity}
                />
              </label>
              <label>
                Z
                <input
                  onChange={(event) =>
                    editObjectChannel(
                      selectedObject,
                      "z",
                      Math.round(Number(event.currentTarget.value)),
                    )
                  }
                  step="1"
                  type="number"
                  value={Math.round(selectedObject.z)}
                />
              </label>
              <p className="timeline-selection-hint">
                拖动画布对象移动；角点缩放，顶部手柄旋转。当前播放头会作为关键帧时间。
              </p>
            </div>
          )}
          {selectedKeyframe !== null && (
            <TimelineKeyframeInspector
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
          hidePreview
          hideTransport
          node={localNode}
          onChange={commitNode}
          onEventSelectionChange={setSelectedEvent}
          onPlayheadChange={movePlayhead}
          onSelectionChange={setSelectedKeyframe}
          onSnapChange={setSnap}
          playheadOverride={playhead}
          snapOverride={snap}
        />
        <input
          aria-label="时间线播放头"
          className="timeline-workspace-range"
          max={localNode.duration_ms}
          min={0}
          onChange={(event) => movePlayhead(Number(event.currentTarget.value))}
          type="range"
          value={playhead}
        />
      </section>
      {exitPrompt && (
        <div className="timeline-exit-dialog" role="dialog">
          <div>
            <strong>存在未写入的姿态</strong>
            <p>离开时间轴前如何处理当前修改？</p>
            <div>
              <button
                onClick={() => {
                  commitPending();
                  setExitPrompt(false);
                  onBack();
                }}
                type="button"
              >
                写入并返回
              </button>
              <button
                onClick={() => {
                  discardPending();
                  onBack();
                }}
                type="button"
              >
                丢弃并返回
              </button>
              <button onClick={() => setExitPrompt(false)} type="button">
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function snapTime(value: number, snap: number, duration: number): number {
  return Math.max(0, Math.min(duration, Math.round(value / snap) * snap));
}

function TimelineKeyframeInspector({
  selection,
  onChange,
}: {
  selection: TimelineSelection;
  onChange(patch: Partial<TimelineKeyframe>): void;
}): ReactElement {
  const frame = selection.frame;
  const cubicEasing =
    typeof frame.easing === "object" ? frame.easing : undefined;
  const isCubic = cubicEasing !== undefined;
  const cubic =
    cubicEasing?.cubic_bezier ??
    ([0.25, 0.1, 0.25, 1] as [number, number, number, number]);
  return (
    <section className="timeline-keyframe-inspector">
      <strong>
        选中关键帧 · {selection.channel} · {frame.at_ms} ms
      </strong>
      <label>
        时间
        <input
          min={0}
          type="number"
          value={frame.at_ms}
          onChange={(event) =>
            onChange({ at_ms: Number(event.currentTarget.value) })
          }
        />
      </label>
      <label>
        数值
        <input
          step="0.01"
          type="number"
          value={frame.value}
          onChange={(event) =>
            onChange({ value: Number(event.currentTarget.value) })
          }
        />
      </label>
      <label>
        缓动
        <select
          value={isCubic ? "cubic" : (frame.easing as string)}
          onChange={(event) => {
            const value = event.currentTarget.value;
            onChange({
              easing:
                value === "cubic"
                  ? { cubic_bezier: cubic }
                  : (value as TimelineEasing),
            });
          }}
        >
          <option value="step">step</option>
          <option value="linear">linear</option>
          <option value="ease_in">ease in</option>
          <option value="ease_out">ease out</option>
          <option value="ease_in_out">ease in/out</option>
          <option value="cubic">cubic-bezier</option>
        </select>
      </label>
      {isCubic && (
        <div className="timeline-cubic-controls">
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
                onChange({ easing: { cubic_bezier: next } });
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function TimelineEventInspector({
  assets,
  selection,
  onChange,
}: {
  assets: EditorAsset[];
  selection: TimelineEventSelection;
  onChange(event: TimelineEvent): void;
}): ReactElement {
  const event = selection.event;
  return (
    <section className="timeline-keyframe-inspector">
      <strong>
        选中事件 · {event.type} · {event.id}
      </strong>
      <label>
        时间
        <input
          min={0}
          type="number"
          value={event.at_ms}
          onChange={(input) =>
            onChange({
              ...event,
              at_ms: Number(input.currentTarget.value),
            })
          }
        />
      </label>
      {event.type === "sfx" ? (
        <>
          <label>
            素材
            <select
              value={event.asset}
              onChange={(input) =>
                onChange({ ...event, asset: input.currentTarget.value })
              }
            >
              {assets
                .filter((asset) => asset.kind === "sfx")
                .map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.id}
                  </option>
                ))}
            </select>
          </label>
          <label>
            音量
            <input
              max="1"
              min="0"
              step="0.01"
              type="number"
              value={event.volume}
              onChange={(input) =>
                onChange({
                  ...event,
                  volume: Math.max(
                    0,
                    Math.min(1, Number(input.currentTarget.value)),
                  ),
                })
              }
            />
          </label>
        </>
      ) : (
        <>
          <label>
            效果
            <select
              value={event.effect}
              onChange={(input) =>
                onChange({
                  ...event,
                  effect: input.currentTarget.value as typeof event.effect,
                })
              }
            >
              <option value="flash">flash</option>
              <option value="shake">shake</option>
            </select>
          </label>
          <label>
            时长
            <input
              min={1}
              type="number"
              value={event.duration_ms}
              onChange={(input) =>
                onChange({
                  ...event,
                  duration_ms: Math.max(1, Number(input.currentTarget.value)),
                })
              }
            />
          </label>
        </>
      )}
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function gizmoStyle(
  object: PreviewObjectFrame,
  camera: TimelinePreviewFrame["camera"] | undefined,
): React.CSSProperties {
  const projected = projectPoint(object.x, object.y, camera);
  const zoom = camera?.zoom ?? 1;
  const width = Math.max(40, object.width * zoom);
  const height = Math.max(56, object.height * zoom);
  const rotation = (camera?.rotation_deg ?? 0) + object.rotation_deg;
  return {
    left: `${(projected.x / DESIGN_WIDTH) * 100}%`,
    top: `${(projected.y / DESIGN_HEIGHT) * 100}%`,
    width: `${(width / DESIGN_WIDTH) * 100}%`,
    height: `${(height / DESIGN_HEIGHT) * 100}%`,
    transform:
      object.kind === "sprite"
        ? `translate(-50%, -100%) rotate(${rotation}deg)`
        : `rotate(${rotation}deg)`,
  };
}

function projectPoint(
  x: number,
  y: number,
  camera: TimelinePreviewFrame["camera"] | undefined,
): { x: number; y: number } {
  if (camera === undefined) return { x, y };
  const angle = (camera.rotation_deg * Math.PI) / 180;
  const dx = x - (DESIGN_WIDTH / 2 + camera.x);
  const dy = y - (DESIGN_HEIGHT / 2 + camera.y);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: DESIGN_WIDTH / 2 + (dx * cos - dy * sin) * camera.zoom,
    y: DESIGN_HEIGHT / 2 + (dx * sin + dy * cos) * camera.zoom,
  };
}
