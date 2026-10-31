import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";

import { PreviewProofPrompt } from "./PreviewProofPrompt";
import type { ProofGraph } from "@vectspace/presentation-core/proof";
import { resolveImageAsset } from "@vectspace/presentation-core/image-animation";
import {
  ArrowLeft,
  Play,
  RotateCcw,
  SkipBack,
  Square,
  StepForward,
} from "lucide-react";
import { Button } from "../ui/Button";
import { shouldIgnoreShortcut } from "../ui/keyboard";
import type { AnimationMap } from "@vectspace/presentation-core/image-animation";
import type {
  AssetUrlMap,
  DialoguePageSnapshot,
  LongTextPageSnapshot,
  PlaybackSnapshot,
  RuntimeSnapshot,
  RuntimeUpdate,
  Settings,
} from "@vectspace/presentation-core/types";
import { UiMotionHost } from "@vectspace/presentation-core/ui-motion";
import { ChoiceLayer } from "@vectspace/presentation-react/choice";
import {
  ButtonLayer,
  DialogueBox,
  LongTextPanel,
  SceneCanvas,
  selectGameplayFont,
  useGameplayFont,
  type DialogueBoxHandle,
  type LongTextPanelHandle,
  type SceneCanvasHandle,
} from "@vectspace/presentation-react/gameplay";
import { autoReadingDelay, hasImmediateAutoAdvance } from "@vectspace/text";

import {
  assetUrl,
  editorApi,
  previewAssetsToAnimations,
  previewAssetsToUrls,
} from "../api";
import { projectRequest } from "../story";
import {
  buildEditorVisualResources,
  EMPTY_EDITOR_VISUALS,
  type EditorVisualResources,
} from "../visualResources";
import { sceneRole, WINDOW_ROLE_LABELS } from "../windowInteraction";
import type {
  EditorProject,
  PreviewChoiceDecision,
  PreviewSessionStartResult,
  PreviewSessionTickResult,
  StoryLocation,
} from "../types";
import { errorMessage } from "./errorMessage";

const DESIGN_WIDTH = 1920;
const DESIGN_HEIGHT = 1080;

/** How often the preview asks the host to advance its Scene timers. */
const TIMER_POLL_MS = 100;
/** Effect updates kept for the canvas; older ones were consumed long ago. */
const MAX_KEPT_EFFECTS = 64;

/**
 * Editor gameplay preview is deliberately silent: the controller reuses the
 * real audio graph, but a master volume of zero keeps authoring from emitting
 * surprise sounds.  Everything else (cues, timeline, UI motion) is the game's.
 * The runtime session never touches the player's profile or save.
 */
const PREVIEW_SETTINGS: Settings = {
  master_volume: 0,
  bgm_volume: 0,
  sfx_volume: 0,
  video_volume: 0,
  ambience_volume: 0,
  text_speed_cps: 30,
  text_reveal_animation: "typewriter",
  skip_mode: "read_only",
};

const NORMAL_PLAYBACK: PlaybackSnapshot = {
  auto: "normal",
  ctrl_fast_forward: "allow",
};

/**
 * Map a pointer position to design coordinates on the 1920x1080 surface.
 *
 * The measured stage rect is the authoritative rendered scale; the observer's
 * `scale` is only a fallback for a rect jsdom/WebView has not measured yet.  A
 * zero-sized stage or a pointer outside the actual scaled content returns null,
 * so the readout can never report coordinates over the empty area below the
 * picture.
 */
function stagePointToDesign(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
  fallbackScale: number,
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const measured = rect.width / DESIGN_WIDTH;
  const scale =
    Number.isFinite(measured) && measured > 0 ? measured : fallbackScale;
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const x = (clientX - rect.left) / scale;
  const y = (clientY - rect.top) / scale;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || y < 0 || x > DESIGN_WIDTH || y > DESIGN_HEIGHT) return null;
  return { x, y };
}

interface NeedsChoiceState {
  location: StoryLocation;
  visit: number;
  choices: { id: string; label: string; enabled: boolean }[];
}

interface GameplayPreviewProps {
  project: EditorProject;
  importTokens: string[];
  sceneId: string;
  nodeId: string | null;
  /**
   * When set, the preview starts automatically on mount with this mode (an
   * ordinary node double-click opens at `node`).  Omitted for the toolbar
   * entry, which keeps the explicit start buttons.
   */
  autoStart?: "scene" | "node" | "reset_node";
  onError(message: string): void;
  /** Leave the preview (renders the back button in the toolbar). */
  onBack?(): void;
}

type Status = "idle" | "starting" | "playing" | "stopped";

/**
 * Live editor gameplay preview.
 *
 * It reuses the real editor-side runtime session (Rust `preview_session_*`
 * commands) and the exact in-game presentation components, so dialogue,
 * long-text, choice and UI-button behaviour are identical to gameplay.  A
 * selected node is reconstructed from its scene entry; when that path is
 * unreachable the author may explicitly reset and start there.
 *
 * Lifecycle contract:
 * - every in-flight request is scoped to a generation; a response from a
 *   superseded generation is discarded, and a superseded START stops the
 *   backend session it created with that session's exact token;
 * - stop/restart/unmount cancels the canvas presentation (timeline/audio/UI),
 *   drops the runtime session and resets the busy flag;
 * - presentation acknowledgements are independent of the busy flag, scoped to
 *   the generation + session + update they settle, and de-duplicated.
 */
export function GameplayPreview({
  project,
  importTokens,
  sceneId,
  nodeId,
  autoStart,
  onError,
  onBack,
}: GameplayPreviewProps): ReactElement {
  const [status, setStatus] = useState<Status>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  /**
   * The *story* update: it owns the presentation, the acknowledgement and the
   * text components' identity.  Timer effects and live state refreshes never
   * replace it (that would cancel the running presentation).
   */
  const [update, setUpdate] = useState<RuntimeUpdate | null>(null);
  /** Latest snapshot from any update: variables, prompt text, titles, blocks. */
  const [live, setLive] = useState<RuntimeSnapshot | null>(null);
  /** Timer effect updates since the story update, for the canvas. */
  const [effects, setEffects] = useState<RuntimeUpdate[]>([]);
  /** Single-window limitations reported by the host. */
  const [windowNotes, setWindowNotes] = useState<string[]>([]);
  const [assets, setAssets] = useState<AssetUrlMap>({});
  const [animations, setAnimations] = useState<AnimationMap>({});
  const [visuals, setVisuals] =
    useState<EditorVisualResources>(EMPTY_EDITOR_VISUALS);
  const [needsChoice, setNeedsChoice] = useState<NeedsChoiceState | null>(null);
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const [branchDecisions, setBranchDecisions] = useState<
    PreviewChoiceDecision[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [scale, setScale] = useState(1);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [revealCompleteKey, setRevealCompleteKey] = useState<string | null>(
    null,
  );

  const generationRef = useRef(0);
  const sessionRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const updateIdRef = useRef<string | null>(null);
  const liveRef = useRef<RuntimeSnapshot | null>(null);
  // The host-driven tick must not restart because the parent re-rendered with
  // a fresh error callback.
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  const tickRef = useRef<Promise<void> | null>(null);
  const ackedRef = useRef<Set<string>>(new Set());
  const canvasHandleRef = useRef<SceneCanvasHandle | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const dialogueRef = useRef<DialogueBoxHandle>(null);
  const longTextRef = useRef<LongTextPanelHandle>(null);
  const uiMotionHost = useMemo(() => new UiMotionHost(), []);

  const previewKey = `${sceneId}/${nodeId ?? ""}`;
  const previewSettings = useMemo(
    () =>
      project.layout.timeline_previews?.[previewKey] ?? {
        variable_overrides: {},
        choices: [],
      },
    [project, previewKey],
  );
  const localRole = sceneRole(
    project.scenes.find((file) => file.definition.id === sceneId)?.definition,
  );

  /**
   * Install the snapshot of any update as the live state.  Commands read the
   * revision from here, so a timer effect that bumped it never makes the next
   * click stale.
   */
  const publishLive = useCallback((snapshot: RuntimeSnapshot): void => {
    liveRef.current = snapshot;
    setLive(snapshot);
  }, []);

  /** Take a story update: it replaces the presentation and its identity. */
  const applyStory = useCallback(
    (next: RuntimeUpdate): void => {
      updateIdRef.current = next.update_id;
      setUpdate(next);
      setEffects([]);
      publishLive(next.snapshot);
    },
    [publishLive],
  );

  const addNotes = useCallback((notes: readonly string[] | undefined): void => {
    if (notes === undefined || notes.length === 0) return;
    setWindowNotes((current) => {
      const added = notes.filter((note) => !current.includes(note));
      return added.length === 0 ? current : [...current, ...added];
    });
  }, []);

  // Register the project's font under the shared gameplay family so the preview
  // measures and reveals text with the same metrics the game uses.  The asset
  // id is the layout-cache identity (identical to the game's `fontKey`), and a
  // missing URL or a host without FontFace simply stays on the system fallback.
  const fontAsset = useMemo(
    () => selectGameplayFont(project.manifest.default_font, project.assets),
    [project],
  );
  const gameplayFont = useGameplayFont(
    fontAsset === undefined ? undefined : assetUrl(fontAsset.absolute_path),
  );
  const fontKey = fontAsset?.id ?? "system";

  // Fit both dimensions of the remaining space below the preview controls.
  useEffect(() => {
    const element = viewportRef.current;
    if (element === null) return;
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0]?.contentRect ?? {
        width: 0,
        height: 0,
      };
      if (width > 0 && height > 0) {
        setScale(Math.min(width / DESIGN_WIDTH, height / DESIGN_HEIGHT));
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /**
   * The canvas ref is a callback so a detach (unmount) can cancel the running
   * presentation before the imperative handle is gone.
   */
  const attachCanvas = useCallback((handle: SceneCanvasHandle | null): void => {
    if (handle === null) {
      canvasHandleRef.current?.cancelCurrentPresentation();
      canvasHandleRef.current = null;
      return;
    }
    canvasHandleRef.current = handle;
  }, []);

  /** Stop the presentation surface's timeline/audio/UI motion. */
  const cancelPresentation = useCallback((): void => {
    canvasHandleRef.current?.cancelCurrentPresentation();
  }, []);

  /**
   * Track the pointer over the scaled stage and expose it in design
   * coordinates.  Leaving the stage (or losing usable geometry) clears it so
   * the readout is only ever shown over the actual 1920x1080 content.
   */
  const handleStagePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const rect = stageRef.current?.getBoundingClientRect();
      if (rect === undefined) {
        setPointer(null);
        return;
      }
      setPointer(stagePointToDesign(rect, event.clientX, event.clientY, scale));
    },
    [scale],
  );

  const clearPointer = useCallback((): void => setPointer(null), []);

  const release = useCallback((generation: number): void => {
    if (generation === generationRef.current) {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  /**
   * Stop the live preview.  A stop owns the busy flag immediately, so a manual
   * stop during a pending startup/command never leaves the panel locked, and
   * the superseded request's `finally` cannot unlock a replacement session.
   */
  const stopSession = useCallback((): void => {
    generationRef.current += 1;
    busyRef.current = false;
    setBusy(false);
    const current = sessionRef.current;
    sessionRef.current = null;
    updateIdRef.current = null;
    ackedRef.current.clear();
    cancelPresentation();
    setSessionId(null);
    setUpdate(null);
    liveRef.current = null;
    setLive(null);
    setEffects([]);
    setWindowNotes([]);
    setNeedsChoice(null);
    setUnreachable(null);
    setRevealCompleteKey(null);
    setStatus("stopped");
    if (current !== null) void editorApi.previewSessionStop(current);
  }, [cancelPresentation]);

  // Tear the session and its presentation down on unmount.  The canvas ref
  // callback also cancels the presentation as it detaches.
  useEffect(
    () => () => {
      generationRef.current += 1;
      busyRef.current = false;
      const current = sessionRef.current;
      sessionRef.current = null;
      if (current !== null) void editorApi.previewSessionStop(current);
      canvasHandleRef.current?.cancelCurrentPresentation();
    },
    [],
  );

  const start = useCallback(
    async (
      mode: "scene" | "node" | "reset_node",
      decisions: PreviewChoiceDecision[],
    ): Promise<void> => {
      if (busyRef.current) return;
      const generation = ++generationRef.current;
      busyRef.current = true;
      setBusy(true);
      setNotice(null);
      setUnreachable(null);
      setNeedsChoice(null);
      setRevealCompleteKey(null);
      setWindowNotes([]);
      ackedRef.current.clear();
      // Replace the previous session atomically: stop its runtime, cancel its
      // presentation and drop the world it was showing.  The displayed
      // session/update/assets are cleared here (not only on success) so a
      // restart that ends in needs_choice/unreachable/failure cannot leave the
      // old dialogue/choice/buttons on screen or keep a stale session id.
      const previous = sessionRef.current;
      sessionRef.current = null;
      updateIdRef.current = null;
      cancelPresentation();
      setSessionId(null);
      setUpdate(null);
      liveRef.current = null;
      setLive(null);
      setEffects([]);
      setAssets({});
      setAnimations({});
      setVisuals(EMPTY_EDITOR_VISUALS);
      if (previous !== null) void editorApi.previewSessionStop(previous);
      setStatus("starting");
      try {
        const result: PreviewSessionStartResult =
          await editorApi.previewSessionStart({
            project: projectRequest(project, importTokens),
            mode,
            scene_id: sceneId,
            node_id: nodeId ?? undefined,
            variable_overrides: previewSettings.variable_overrides,
            choices: decisions,
          });
        if (generation !== generationRef.current) {
          // Superseded while pending (stop/unmount/selection change): the
          // backend still installed a session for this request, so stop it with
          // that exact token.  It can neither leak nor touch the newer session.
          if (result.status === "started")
            void editorApi.previewSessionStop(result.session_id);
          return;
        }
        if (result.status === "needs_choice") {
          setNeedsChoice({
            location: result.location,
            visit: result.visit,
            choices: result.choices,
          });
          setStatus("idle");
          return;
        }
        if (result.status === "unreachable") {
          setUnreachable(result.message);
          setStatus("idle");
          return;
        }
        // Own the returned token before resolving resources: a frontend failure
        // must still stop the runtime the host just installed.
        sessionRef.current = result.session_id;
        const resolvedUrls = previewAssetsToUrls(result.assets);
        const visualResources = buildEditorVisualResources(
          project,
          resolvedUrls,
          result,
        );
        setSessionId(result.session_id);
        setVisuals(visualResources);
        setAssets(resolvedUrls);
        setAnimations(previewAssetsToAnimations(result.assets));
        applyStory(result.update);
        addNotes(result.notes);
        setStatus("playing");
      } catch (reason) {
        if (generation === generationRef.current) {
          const failedSession = sessionRef.current;
          sessionRef.current = null;
          if (failedSession !== null)
            void editorApi.previewSessionStop(failedSession);
          setStatus("idle");
          onError(errorMessage(reason));
        }
      } finally {
        release(generation);
      }
    },
    [
      addNotes,
      applyStory,
      cancelPresentation,
      importTokens,
      nodeId,
      onError,
      previewSettings.variable_overrides,
      project,
      release,
      sceneId,
    ],
  );

  /**
   * Auto-start once per mount (an ordinary node double-click).
   *
   * The start is deferred to a macrotask so the preview never sets state during
   * the commit that mounted it, and React StrictMode's simulated unmount can
   * clear the pending tick while the real setup schedules it again: exactly one
   * START is issued, and the teardown effect never supersedes a start that has
   * not happened yet (which would otherwise leave the busy flag stuck).
   */
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (autoStart === undefined || autoStartedRef.current) return undefined;
    const tick = window.setTimeout(() => {
      autoStartedRef.current = true;
      void start(autoStart, []);
    }, 0);
    return () => window.clearTimeout(tick);
  }, [autoStart, start]);

  const runCommand = useCallback(
    async (
      command: (session: string, revision: string) => Promise<RuntimeUpdate>,
    ) => {
      const session = sessionRef.current;
      if (session === null || busyRef.current || update === null) return;
      const generation = generationRef.current;
      busyRef.current = true;
      setBusy(true);
      try {
        // A timer tick may be in flight and bump the revision: let it land so
        // the command is issued against the latest state, never a stale one.
        await tickRef.current;
        const revision = liveRef.current?.revision;
        if (
          generation !== generationRef.current ||
          sessionRef.current !== session ||
          revision === undefined
        )
          return;
        const next = await command(session, revision);
        if (
          generation !== generationRef.current ||
          sessionRef.current !== session
        )
          return;
        applyStory(next);
      } catch (reason) {
        if (generation === generationRef.current) onError(errorMessage(reason));
      } finally {
        release(generation);
      }
    },
    [applyStory, onError, release, update],
  );

  /**
   * Fold one tick's updates into the preview, in order.  Effects go to the
   * canvas beside the story; a refresh only re-derives the live snapshot; a
   * story update (a local script advance) replaces the presentation.
   */
  const applyTick = useCallback(
    (result: PreviewSessionTickResult): void => {
      for (const next of result.updates) {
        if (next.kind === "effect") {
          publishLive(next.snapshot);
          setEffects((current) => [...current, next].slice(-MAX_KEPT_EFFECTS));
        } else if (next.kind === "state_refresh") {
          publishLive(next.snapshot);
        } else {
          applyStory(next);
        }
      }
      addNotes(result.notes);
      for (const diagnostic of result.diagnostics)
        onErrorRef.current(diagnostic);
    },
    [addNotes, applyStory, publishLive],
  );

  const hasTimers =
    live?.interaction?.timers !== undefined &&
    Object.keys(live.interaction.timers).length > 0;

  // Scene timers are owned by the host: the preview only asks it to advance
  // them, and stops asking when nothing is running or the session is gone.
  useEffect(() => {
    if (status !== "playing" || sessionId === null || !hasTimers)
      return undefined;
    const generation = generationRef.current;
    const handle = window.setInterval(() => {
      if (
        busyRef.current ||
        tickRef.current !== null ||
        generation !== generationRef.current ||
        sessionRef.current !== sessionId
      )
        return;
      const pending = editorApi
        .previewSessionTick(sessionId)
        .then((result) => {
          if (
            generation === generationRef.current &&
            sessionRef.current === sessionId
          )
            applyTick(result);
        })
        .catch((reason: unknown) => {
          if (generation === generationRef.current)
            onErrorRef.current(errorMessage(reason));
        })
        .finally(() => {
          if (tickRef.current === pending) tickRef.current = null;
        });
      tickRef.current = pending;
    }, TIMER_POLL_MS);
    return () => window.clearInterval(handle);
  }, [applyTick, hasTimers, sessionId, status]);

  const blocks = live?.interaction?.blocks ?? [];
  const blocked = blocks.length > 0;

  const advanceWith = useCallback(
    (source: "manual" | "auto" | "forced_auto"): void => {
      // A script block refuses every way of turning the page, and the preview
      // never sends a request the runtime is going to reject.
      if (update === null || update.requires_ack || blocked) return;
      void runCommand((session, revision) =>
        editorApi.previewSessionAdvance({
          session_id: session,
          expected_revision: revision,
          source,
        }),
      );
    },
    [blocked, runCommand, update],
  );

  const advance = useCallback((): void => {
    const snapshot = live ?? update?.snapshot;
    if (snapshot === undefined || snapshot === null) return;
    // Gated presentation: never issue an invalid advance.  Skip it when the
    // runtime allows, otherwise stay locked until it settles.
    if (update?.requires_ack === true) {
      canvasHandleRef.current?.skipCurrentPresentation();
      return;
    }
    if (
      snapshot.prompt.kind !== "dialogue" &&
      snapshot.prompt.kind !== "long_text"
    ) {
      return;
    }
    const revealing =
      dialogueRef.current?.isComplete() === false ||
      longTextRef.current?.isComplete() === false;
    if (revealing) {
      dialogueRef.current?.complete();
      longTextRef.current?.complete();
      return;
    }
    advanceWith("manual");
  }, [advanceWith, live, update]);

  // Space / Enter advance like in the game (never while typing or when a
  // focused button would activate itself).
  useEffect(() => {
    if (status !== "playing") return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== " " && event.key !== "Enter") return;
      if (shouldIgnoreShortcut(event) || busy) return;
      if (event.target instanceof HTMLButtonElement) return;
      event.preventDefault();
      advance();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [advance, busy, status]);

  const choose = useCallback(
    (choiceId: string): void => {
      if (update === null || update.requires_ack) return;
      void runCommand((session, revision) =>
        editorApi.previewSessionChoose({
          session_id: session,
          expected_revision: revision,
          choice_id: choiceId,
        }),
      );
    },
    [runCommand, update],
  );

  const submitProof = useCallback(
    async (graph: ProofGraph) => {
      const session = sessionRef.current;
      const generation = generationRef.current;
      if (
        session === null ||
        busyRef.current ||
        update === null ||
        update.requires_ack
      )
        throw new Error("预览正忙");
      busyRef.current = true;
      setBusy(true);
      try {
        await tickRef.current;
        const revision = liveRef.current?.revision;
        if (
          revision === undefined ||
          generation !== generationRef.current ||
          sessionRef.current !== session
        )
          throw new Error("预览会话已过期");
        const result = await editorApi.previewProofSubmit({
          session_id: session,
          expected_revision: revision,
          graph,
        });
        if (
          generation !== generationRef.current ||
          sessionRef.current !== session
        )
          throw new Error("预览会话已过期");
        if (result.update !== null) applyStory(result.update);
        return result;
      } finally {
        release(generation);
      }
    },
    [applyStory, release, update],
  );

  const abandonProof = useCallback(() => {
    if (update === null || update.requires_ack) return;
    void runCommand((session, revision) =>
      editorApi.previewProofAbandon({
        session_id: session,
        expected_revision: revision,
      }),
    );
  }, [runCommand, update]);

  const clickButton = useCallback(
    (instanceId: string): void => {
      if (update === null || update.requires_ack) return;
      void runCommand((session, revision) =>
        editorApi.previewSessionClickButton({
          session_id: session,
          expected_revision: revision,
          instance_id: instanceId,
        }),
      );
    },
    [runCommand, update],
  );

  /**
   * Acknowledge a settled presentation.
   *
   * Deliberately independent of `busyRef`: a settlement that arrives while a
   * command response is being applied must still be acknowledged.  It is scoped
   * to the original generation + session + update, and de-duplicated so a
   * duplicate settlement or a callback from a restarted session is ignored.
   */
  const handleSettled = useCallback(
    (settled: RuntimeUpdate, outcome: "completed" | "skipped" | "failed") => {
      const session = sessionRef.current;
      if (session === null || !settled.requires_ack) return;
      if (updateIdRef.current !== settled.update_id) return;
      if (ackedRef.current.has(settled.update_id)) return;
      ackedRef.current.add(settled.update_id);
      const generation = generationRef.current;
      void editorApi
        .previewSessionPresentationComplete({
          session_id: session,
          update_id: settled.update_id,
          outcome,
        })
        .then((next) => {
          if (
            generation !== generationRef.current ||
            sessionRef.current !== session
          )
            return;
          applyStory(next);
        })
        .catch((reason: unknown) => {
          if (generation === generationRef.current) {
            ackedRef.current.delete(settled.update_id);
            onError(errorMessage(reason));
          }
        });
    },
    [applyStory, onError],
  );

  const pickBranch = useCallback(
    (choiceId: string): void => {
      if (needsChoice === null) return;
      const decisions: PreviewChoiceDecision[] = [
        ...branchDecisions,
        {
          scene_id: needsChoice.location.scene_id,
          node_id: needsChoice.location.node_id,
          visit: needsChoice.visit,
          choice_id: choiceId,
        },
      ];
      setBranchDecisions(decisions);
      void start("node", decisions);
    },
    [branchDecisions, needsChoice, start],
  );

  const startScene = useCallback((): void => {
    setBranchDecisions([]);
    void start("scene", []);
  }, [start]);

  const startNode = useCallback((): void => {
    setBranchDecisions([]);
    void start("node", []);
  }, [start]);

  const resetAtNode = useCallback((): void => {
    if (nodeId === null) return;
    setBranchDecisions([]);
    void start("reset_node", []);
  }, [nodeId, start]);

  // Prompt text, variables and buttons follow the live snapshot; everything
  // that identifies the presentation keeps following the story update.
  const snapshot = live ?? update?.snapshot ?? null;
  const dialogue =
    snapshot !== null && snapshot.prompt.kind === "dialogue"
      ? snapshot.prompt
      : null;
  const longText =
    snapshot !== null && snapshot.prompt.kind === "long_text"
      ? snapshot.prompt
      : null;
  const choice =
    snapshot !== null && snapshot.prompt.kind === "choice"
      ? snapshot.prompt
      : null;
  const proof = snapshot?.prompt.kind === "proof" ? snapshot.prompt : null;
  const dialoguePage: DialoguePageSnapshot | null =
    snapshot?.dialogue_page ?? null;
  const longTextPage: LongTextPageSnapshot | null =
    snapshot?.long_text_page ?? null;
  const timelineCue =
    update?.cues.find((cue) => cue.type === "timeline") ?? null;
  const hasTextRevealCue =
    update?.cues.some(
      (cue) =>
        cue.type === "dialogue_reveal" || cue.type === "long_text_reveal",
    ) ?? false;
  const endPrompt = snapshot?.prompt.kind === "end";
  const playback: PlaybackSnapshot = snapshot?.playback ?? NORMAL_PLAYBACK;
  const forcedAuto = playback.auto === "forced";
  const textPrompt = dialogue ?? longText;
  const textInstanceKey =
    textPrompt === null
      ? null
      : `${update?.update_id ?? "0"}:${textPrompt.prompt_id}`;
  const immediateAutoAdvance =
    textPrompt !== null && hasImmediateAutoAdvance(textPrompt.text);

  // Authored auto playback (forced auto / immediate auto).  The reveal clock is
  // the real gate: only advance once the current prompt finished revealing, and
  // always clear the timer on prompt/status change or unmount.
  useEffect(() => {
    if (
      status !== "playing" ||
      update === null ||
      update.requires_ack ||
      textPrompt === null ||
      textInstanceKey === null ||
      revealCompleteKey !== textInstanceKey
    ) {
      return undefined;
    }
    let timer = 0;
    if (immediateAutoAdvance) {
      timer = window.setTimeout(
        () => advanceWith(forcedAuto ? "forced_auto" : "auto"),
        0,
      );
    } else if (forcedAuto) {
      timer = window.setTimeout(
        () => advanceWith("forced_auto"),
        autoReadingDelay(textPrompt.text),
      );
    }
    return () => window.clearTimeout(timer);
  }, [
    advanceWith,
    forcedAuto,
    immediateAutoAdvance,
    revealCompleteKey,
    status,
    textInstanceKey,
    textPrompt,
    update,
  ]);

  const stopEnabled = status === "starting" || status === "playing";
  const activeTimerIds = Object.keys(live?.interaction?.timers ?? {}).sort();
  const windowTitle = live?.interaction?.titles?.[localRole] ?? null;
  // Session-scoped keys reset reveal/pagination/scroll when a new session
  // starts at the same node (a fresh runtime reuses node ids).
  const scope = sessionId ?? "none";

  return (
    <section className="gameplay-preview">
      <header className="gameplay-preview-toolbar workspace-header-bar">
        {onBack !== undefined && (
          <>
            <Button icon={ArrowLeft} onClick={onBack} size="sm" variant="ghost">
              返回编辑器
            </Button>
            <span aria-hidden="true" className="shell-divider" />
          </>
        )}
        <div className="workspace-header-title">
          <Play aria-hidden="true" />
          <span>游戏预览</span>
        </div>
        <div className="workspace-header-tools">
          <Button
            disabled={busy}
            icon={SkipBack}
            onClick={startScene}
            size="sm"
            variant="ghost"
          >
            从场景入口开始
          </Button>
          <Button
            disabled={busy || nodeId === null}
            icon={Play}
            onClick={startNode}
            size="sm"
            variant="ghost"
          >
            从所选节点开始
          </Button>
          <Button
            disabled={busy || nodeId === null}
            icon={RotateCcw}
            onClick={resetAtNode}
            size="sm"
            title="不执行前置节点，使用场景默认值直接从此节点开始"
            variant="ghost"
          >
            重置并从此节点开始
          </Button>
          <span aria-hidden="true" className="shell-divider" />
          <Button
            disabled={busy || status !== "playing"}
            icon={StepForward}
            onClick={advance}
            size="sm"
            title="也可以按空格或 Enter"
          >
            {update?.requires_ack === true ? "跳过表现" : "推进 / 完成打字"}
          </Button>
          <Button
            disabled={!stopEnabled}
            icon={Square}
            onClick={stopSession}
            size="sm"
            variant="ghost"
          >
            停止
          </Button>
        </div>
        <span className="gameplay-preview-status">
          {status === "playing"
            ? `运行中 · ${snapshot?.location.scene_id ?? ""} / ${snapshot?.location.node_id ?? ""}${forcedAuto ? " · 强制自动" : ""}${windowTitle === null ? "" : ` · ${WINDOW_ROLE_LABELS[localRole]}标题：${windowTitle}`}${activeTimerIds.length === 0 ? "" : ` · 计时器 ${activeTimerIds.join("、")}`}`
            : status === "starting"
              ? "启动中…"
              : status === "stopped"
                ? "已停止"
                : "未开始"}
        </span>
      </header>

      {notice !== null && <p className="gameplay-preview-notice">{notice}</p>}
      {status === "playing" &&
        blocks.map((block) => (
          <p
            className="gameplay-preview-notice gameplay-preview-block"
            key={`${block.source_scene}/${block.id}`}
            role="status"
          >
            翻页已被阻挡（{block.id}）
            {block.message === "" ? "" : `：${block.message}`}
            ——选项和按钮仍可用，需要执行「解除阻挡」后才能继续。
          </p>
        ))}
      {windowNotes.map((note) => (
        <p className="gameplay-preview-notice" key={note} role="note">
          {note}
        </p>
      ))}
      {gameplayFont.error !== null && (
        <p className="gameplay-preview-notice">
          游戏字体加载失败，已回退系统字体：{gameplayFont.error}
        </p>
      )}
      {needsChoice !== null && (
        <div className="gameplay-preview-gate">
          <p>
            到达分支 {needsChoice.location.scene_id}/
            {needsChoice.location.node_id}，请选择一条路径后再从此节点开始：
          </p>
          <div>
            {needsChoice.choices.map((item) => (
              <button
                disabled={!item.enabled}
                key={item.id}
                onClick={() => pickBranch(item.id)}
                type="button"
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {unreachable !== null && (
        <div className="gameplay-preview-gate">
          <p>无法从场景入口构造该节点的进入状态：{unreachable}</p>
          <p>可改用「重置并从此节点开始」直接以场景默认值进入。</p>
        </div>
      )}

      <div className="gameplay-preview-viewport" ref={viewportRef}>
        <div
          className="gameplay-preview-stage"
          onPointerLeave={clearPointer}
          onPointerMove={handleStagePointerMove}
          ref={stageRef}
          style={{ width: DESIGN_WIDTH * scale, height: DESIGN_HEIGHT * scale }}
        >
          <div
            className="gameplay-preview-design"
            style={{
              transform: `scale(${scale})`,
              width: DESIGN_WIDTH,
              height: DESIGN_HEIGHT,
            }}
          >
            <SceneCanvas
              animations={animations}
              assets={assets}
              textBlocks={visuals.textBlocks}
              particles={visuals.particles}
              onDiagnostic={onError}
              onSettled={handleSettled}
              paused={status !== "playing"}
              playbackRate={1}
              ref={attachCanvas}
              settings={PREVIEW_SETTINGS}
              suppressOneShots={false}
              typingSfxActive={false}
              typingSfxCps={PREVIEW_SETTINGS.text_speed_cps}
              uiMotionHost={uiMotionHost}
              update={status === "playing" ? update : null}
              effects={effects}
              activeTimers={
                live?.interaction?.timers === undefined ? null : activeTimerIds
              }
              visible={status === "playing"}
            />
            {snapshot !== null && status === "playing" && (
              <ButtonLayer
                animations={animations}
                assets={assets}
                disabled={busy || update?.requires_ack === true}
                onClick={clickButton}
                paused={false}
                playbackRate={1}
                snapshot={snapshot}
                timeline={timelineCue}
              />
            )}
            {dialoguePage !== null && status === "playing" && (
              <DialogueBox
                defaultCps={PREVIEW_SETTINGS.text_speed_cps}
                dialogueBoxSource={
                  resolveImageAsset("gui.dialogue_box", assets, animations) ??
                  null
                }
                disabled={busy}
                fontReady={gameplayFont.ready}
                initialCps={PREVIEW_SETTINGS.text_speed_cps}
                key={`${scope}:${update?.update_id ?? "0"}:${dialogue?.prompt_id ?? ""}`}
                measurementScale={scale}
                motionHost={uiMotionHost}
                nameBoxSource={
                  resolveImageAsset("gui.name_box", assets, animations) ?? null
                }
                onRevealComplete={setRevealCompleteKey}
                onTypingChange={() => undefined}
                page={dialoguePage}
                prompt={dialogue}
                ref={dialogueRef}
                revealAnimation={PREVIEW_SETTINGS.text_reveal_animation}
                revealImmediately={!hasTextRevealCue}
                sessionKey={
                  dialogue === null
                    ? undefined
                    : `${update?.update_id ?? "0"}:${dialogue.prompt_id}`
                }
                visible={snapshot?.world.dialogue_ui_visible ?? false}
              />
            )}
            {longTextPage !== null && status === "playing" && (
              <LongTextPanel
                defaultCps={PREVIEW_SETTINGS.text_speed_cps}
                designScale={scale}
                disabled={busy || longText === null}
                fastForward={false}
                fontKey={fontKey}
                fontReady={gameplayFont.ready}
                initialCps={PREVIEW_SETTINGS.text_speed_cps}
                key={`${scope}:${longTextPage.document_id}`}
                onRevealComplete={setRevealCompleteKey}
                onTypingChange={() => undefined}
                page={longTextPage}
                paperSource={
                  longTextPage.paper === null ||
                  longTextPage.paper === undefined
                    ? undefined
                    : (resolveImageAsset(
                        longTextPage.paper,
                        assets,
                        animations,
                      ) ?? null)
                }
                prompt={longText}
                ref={longTextRef}
                revealAnimation={PREVIEW_SETTINGS.text_reveal_animation}
                revealImmediately={!hasTextRevealCue}
                sessionKey={
                  longText === null
                    ? undefined
                    : `${update?.update_id ?? "0"}:${longText.prompt_id}`
                }
                visible={longTextPage.visible !== false}
              />
            )}
            {choice !== null && status === "playing" && (
              <ChoiceLayer
                animations={animations}
                assets={assets}
                disabled={busy || update?.requires_ack === true}
                onChoose={choose}
                onDiagnostic={(diagnostic) => onError(diagnostic.message)}
                paused={false}
                prompt={choice}
              />
            )}
            {proof !== null && sessionId !== null && status === "playing" && (
              <PreviewProofPrompt
                key={`${sessionId}:${proof.prompt_id}`}
                prompt={proof}
                sessionId={sessionId}
                onSubmit={submitProof}
                onAbandon={abandonProof}
                onError={onError}
              />
            )}
            {endPrompt && status === "playing" && (
              <div className="gameplay-preview-end">场景结束</div>
            )}
            {status !== "playing" && (
              <p className="gameplay-preview-placeholder">
                选择一个起点开始预览：场景入口、所选节点，或重置后直接从此节点。
              </p>
            )}
          </div>
          {pointer !== null && (
            <div className="gameplay-preview-coords" aria-hidden="true">
              X {Math.round(pointer.x)} · Y {Math.round(pointer.y)}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
