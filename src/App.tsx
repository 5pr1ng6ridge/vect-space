import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";

import "katex/dist/katex.min.css";
import "./App.css";

import { HistoryPanel } from "./components/HistoryPanel";
import {
  ButtonLayer,
  DialogueBox,
  LongTextPanel,
  MarkupText,
  SceneCanvas,
  useTextRevealSession,
  type DialogueBoxHandle,
  type LongTextPanelHandle,
  type SceneCanvasHandle,
} from "@vectspace/presentation-react/gameplay";
import type { AnimationMap } from "@vectspace/presentation-core/image-animation";
import { resolveImageAsset } from "@vectspace/presentation-core/image-animation";
import { ChoiceLayer } from "@vectspace/presentation-react/choice";
import { ChapterMapPage } from "./components/ChapterMapPage";
import {
  engineApi,
  resolvedAssetsToAnimations,
  resolvedAssetsToUrls,
} from "./engine/api";
import {
  requireSessionId,
  SessionTransitionController,
  type SessionTransitionToken,
} from "@vectspace/presentation-core/session-transition";
import {
  autoReadingDelay,
  buildVisibleUnitCps,
  hasImmediateAutoAdvance,
  parseMarkup,
} from "@vectspace/text";
import { canFastForwardPrompt } from "./engine/playback";
import { UiMotionHost } from "@vectspace/presentation-core/ui-motion";
import type {
  AdvanceSource,
  AssetUrlMap,
  BootstrapPayload,
  DialoguePrompt,
  DialogueHistoryEntry,
  LongTextPrompt,
  PresentationCue,
  RuntimeUpdate,
  SaveSlotSummary,
  Settings,
  ChapterMapSnapshot,
  TextRevealAnimation,
} from "@vectspace/presentation-core/types";
import { useViewportMetrics } from "./viewport/viewport";
import { BoundedLedger } from "@vectspace/presentation-core/ledger";
import type { WireU64 } from "../shared/generated/WireU64";

const DEFAULT_SETTINGS: Settings = {
  master_volume: 1,
  bgm_volume: 0.7,
  sfx_volume: 0.8,
  video_volume: 1,
  ambience_volume: 0.8,
  text_speed_cps: 30,
  text_reveal_animation: "typewriter",
  skip_mode: "read_only",
};

type Phase = "booting" | "title" | "chapter_map" | "playing";
type Panel = "none" | "saves" | "settings" | "history";

interface InitialAppState {
  bootstrap: BootstrapPayload;
  settings: Settings;
  slots: SaveSlotSummary[];
  assets: AssetUrlMap;
  animations: AnimationMap;
}

interface LockedTextSettings {
  instanceKey: string;
  defaultCps: number;
  initialCps: number;
  animation: TextRevealAnimation;
}

let initialAppStatePromise: Promise<InitialAppState> | null = null;

export default function App(): ReactElement {
  const { metrics: viewportMetrics, style: viewportStyle } =
    useViewportMetrics();
  const sceneRef = useRef<SceneCanvasHandle>(null);
  const dialogueRef = useRef<DialogueBoxHandle>(null);
  const longTextRef = useRef<LongTextPanelHandle>(null);
  const uiMotionHost = useMemo(() => new UiMotionHost(), []);
  const phaseRef = useRef<Phase>("booting");
  const busyRef = useRef(false);
  const acknowledgedUpdates = useRef(new BoundedLedger<string>(256));
  const autosavedRevisions = useRef(new BoundedLedger<string>(256));
  const heldControlKeys = useRef(new Set<string>());
  const replayTransitionRef = useRef<Promise<void> | null>(null);
  const transitionControllerRef = useRef(new SessionTransitionController());
  const commandOwnerRef = useRef(0);
  // Reads used by title/map/history pages are not runtime commands and do not
  // acquire the command lock.  Keep an independent request generation so a
  // late response cannot switch the page after a session boundary has begun.
  const pageRequestGenerationRef = useRef(0);
  // Incremented before every story/replay boundary.  A command that was
  // already in flight may still resolve, but it must not repopulate a page
  // belonging to the new boundary.
  const sessionGenerationRef = useRef(0);
  // Host identity survives clearing presentation state on title/map screens.
  const activeSessionId = useRef("0");

  const [phase, setPhase] = useState<Phase>("booting");
  const [panel, setPanel] = useState<Panel>("none");
  const [update, setUpdate] = useState<RuntimeUpdate | null>(null);
  const [assets, setAssets] = useState<AssetUrlMap>({});
  const [animations, setAnimations] = useState<AnimationMap>({});
  const [loadedFontUrl, setLoadedFontUrl] = useState<string | null>(null);
  const [fontLoadErrorUrl, setFontLoadErrorUrl] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [draftSettings, setDraftSettings] =
    useState<Settings>(DEFAULT_SETTINGS);
  const [saveSlots, setSaveSlots] = useState<SaveSlotSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contentVersion, setContentVersion] = useState("");
  const [defaultFontId, setDefaultFontId] = useState<string | null>(null);
  const [typingSfxActive, setTypingSfxActive] = useState(false);
  const [typingSfxCps, setTypingSfxCps] = useState(
    DEFAULT_SETTINGS.text_speed_cps,
  );
  const [normalAuto, setNormalAuto] = useState(false);
  const [ctrlHeld, setCtrlHeld] = useState(false);
  const [pageHidden, setPageHidden] = useState(document.hidden);
  // A stable prompt_id may legitimately be revisited.  Completion belongs to
  // the RuntimeUpdate/presentation instance, never to the story node alone.
  const [completedPromptKey, setCompletedPromptKey] = useState<string | null>(
    null,
  );
  const [history, setHistory] = useState<DialogueHistoryEntry[]>([]);
  const [chapterMap, setChapterMap] = useState<ChapterMapSnapshot | null>(null);
  const [chapterMapAvailable, setChapterMapAvailable] = useState(false);
  const [replayMode, setReplayMode] = useState(false);
  const [replaySceneId, setReplaySceneId] = useState<string | null>(null);
  // Keep the map camera outside the page component so leaving for a replay
  // and returning does not unexpectedly jump back to the author's origin.
  const [chapterMapCenter, setChapterMapCenter] = useState<{
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    let active = true;
    void getInitialAppState()
      .then(
        ({
          bootstrap,
          settings: loadedSettings,
          slots,
          assets,
          animations,
        }) => {
          if (!active) {
            return;
          }
          setAssets(assets);
          setAnimations(animations);
          setSettings(loadedSettings);
          setDraftSettings(loadedSettings);
          setSaveSlots(slots);
          sessionGenerationRef.current += 1;
          activeSessionId.current = requireSessionId(
            bootstrap.update.session_id,
          );
          setUpdate(bootstrap.update);
          setContentVersion(bootstrap.content_version);
          setDefaultFontId(bootstrap.default_font ?? null);
          setChapterMapAvailable(bootstrap.chapter_map_available === true);
          setPhase("title");
        },
      )
      .catch((reason: unknown) => {
        if (active) {
          setError(errorMessage(reason));
          setPhase("title");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const fontUrl = defaultFontId === null ? undefined : assets[defaultFontId];
    if (fontUrl === undefined) {
      return;
    }
    let active = true;
    const face = new FontFace("VECT Pixel", `url("${fontUrl}")`, {
      display: "swap",
    });
    document.fonts.add(face);
    void face
      .load()
      .then(async () => {
        // FontFace.load() resolves when this face is usable, while the
        // document-wide promise also accounts for any companion faces that
        // KaTeX/layout may have queued.  Do not mark the URL ready on a
        // rejected load: doing so would freeze a fallback-font layout as if it
        // were authoritative.
        await document.fonts.ready;
        if (active) setLoadedFontUrl(fontUrl);
      })
      .catch((reason: unknown) => {
        if (active) {
          // A font is an enhancement, not a reason to deadlock the story. The
          // text components keep their system fallback geometry when loading
          // fails; remember the failed URL so the readiness gate can release.
          setFontLoadErrorUrl(fontUrl);
          setError(`中文字体加载失败，已使用系统字体：${errorMessage(reason)}`);
        }
      });
    return () => {
      active = false;
      document.fonts.delete(face);
    };
  }, [assets, defaultFontId]);

  const fontUrl = defaultFontId === null ? undefined : assets[defaultFontId];
  const fontReady =
    fontUrl === undefined ||
    loadedFontUrl === fontUrl ||
    fontLoadErrorUrl === fontUrl;

  const refreshSlots = useCallback(async (): Promise<void> => {
    setSaveSlots(await engineApi.listSaveSlots());
  }, []);

  const applyUpdate = useCallback((next: RuntimeUpdate): void => {
    activeSessionId.current = requireSessionId(next.session_id);
    setUpdate(next);
    const panelCue = next.cues.find(
      (
        cue,
      ): cue is Extract<PresentationCue, { type: "button_system_action" }> =>
        cue.type === "button_system_action",
    );
    if (panelCue !== undefined) setPanel(panelCue.panel);
  }, []);

  /**
   * Restores the previous authoritative update after a same-session failure.
   *
   * Recovery is instant: the world is hard-aligned without replaying cues and
   * any session curtain left behind by a superseded switch is forced down, so
   * a retryable failure never adds a cover/reveal fade for a switch that did
   * not happen.
   */
  const restoreRetainedUpdate = useCallback(
    async (retained: RuntimeUpdate): Promise<void> => {
      setUpdate(retained);
      let alignmentError: unknown;
      try {
        await sceneRef.current?.applySnapshotImmediately(retained.snapshot);
      } catch (error) {
        alignmentError = error;
      } finally {
        // The curtain is always forced down, even when the hard alignment
        // failed; the alignment error stays the one the caller handles.
        try {
          await sceneRef.current?.revealSession();
        } catch (error) {
          if (alignmentError === undefined) throw error;
        }
      }
      if (alignmentError !== undefined) {
        // The original alignment error is preserved (same Error instance) and
        // never replaced by a curtain error.  A non-Error throw still fails
        // loudly instead of silently succeeding.
        throw alignmentError instanceof Error
          ? alignmentError
          : new Error("Failed to restore the retained update");
      }
    },
    [],
  );

  const runStoryCommand = useCallback(
    async (
      command: () => Promise<RuntimeUpdate>,
      generation = sessionGenerationRef.current,
      expectedSessionId = activeSessionId.current,
      allowSessionChange = false,
      expectedMode?: "story" | "replay",
      /** Session switch: align the new world behind the host curtain. */
      sessionBoundary = false,
    ): Promise<boolean> => {
      if (busyRef.current) {
        return false;
      }
      const token = transitionControllerRef.current.begin(
        generation,
        expectedSessionId,
      );
      commandOwnerRef.current = token.id;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const next = await command();
        const returnedSessionId = requireSessionId(next.session_id);
        if (!allowSessionChange && returnedSessionId !== expectedSessionId) {
          throw new Error("运行时返回了不属于当前会话的响应，请重试。");
        }
        if (
          expectedMode !== undefined &&
          next.mode !== undefined &&
          next.mode !== expectedMode
        ) {
          throw new Error("运行时返回了不匹配的会话模式，请重试。");
        }
        // Boundary commands (new game, load and replay start) are allowed to
        // rotate the host session id.  Treat that id change as one atomic
        // commit: the token and generation must still be current, and the
        // active id must still be the id captured when the command began.
        if (allowSessionChange) {
          const current =
            transitionControllerRef.current.isCurrentGeneration(
              token,
              sessionGenerationRef.current,
            ) && activeSessionId.current === expectedSessionId;
          if (current) {
            if (sessionBoundary) {
              // Cover the canvas, hard-align the new world while it is fully
              // black (no cue is replayed) and reveal again after the first
              // stable frame.  A newer transition may supersede this command
              // while the cover is up; if so it owns the world and the UI.
              await sceneRef.current?.applySessionSnapshot(next.snapshot);
              if (
                !transitionControllerRef.current.isCurrentGeneration(
                  token,
                  sessionGenerationRef.current,
                )
              ) {
                return false;
              }
            }
            activeSessionId.current = returnedSessionId;
            applyUpdate(next);
          }
          return current;
        }
        const current = transitionControllerRef.current.isCurrent(
          token,
          sessionGenerationRef.current,
          activeSessionId.current,
        );
        if (current) applyUpdate(next);
        return current;
      } catch (reason) {
        if (
          transitionControllerRef.current.isCurrent(
            token,
            sessionGenerationRef.current,
            activeSessionId.current,
          )
        )
          setError(errorMessage(reason));
        return false;
      } finally {
        if (commandOwnerRef.current === token.id) {
          busyRef.current = false;
          setBusy(false);
        }
      }
    },
    [applyUpdate],
  );

  const beginSessionTransition =
    useCallback((): SessionTransitionToken | null => {
      if (busyRef.current || replayTransitionRef.current !== null) return null;
      const token = transitionControllerRef.current.begin(
        sessionGenerationRef.current,
        activeSessionId.current,
      );
      commandOwnerRef.current = token.id;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      return token;
    }, []);

  const stopTransientPlayback = useCallback((): void => {
    // Session boundaries must not inherit input state from the previous
    // page.  In particular a Ctrl key can remain logically pressed when a
    // toolbar click steals focus, and an old typewriter callback can otherwise
    // restart the loop on the first frame of the new session.
    heldControlKeys.current.clear();
    pageRequestGenerationRef.current += 1;
    setCtrlHeld(false);
    setNormalAuto(false);
    setTypingSfxActive(false);
    setCompletedPromptKey(null);
  }, []);

  const finishSessionTransition = useCallback(
    (token: SessionTransitionToken): boolean => {
      if (
        !transitionControllerRef.current.isCurrentGeneration(
          token,
          sessionGenerationRef.current,
        )
      )
        return false;
      if (commandOwnerRef.current === token.id) {
        commandOwnerRef.current = 0;
        busyRef.current = false;
        setBusy(false);
      }
      replayTransitionRef.current = null;
      return true;
    },
    [],
  );

  const handlePresentationSettled = useCallback(
    (
      settled: RuntimeUpdate,
      outcome: "completed" | "skipped" | "failed",
    ): void => {
      if (
        settled.session_id === undefined ||
        settled.session_id !== activeSessionId.current ||
        busyRef.current ||
        (settled.mode !== undefined &&
          settled.mode !== (replayMode ? "replay" : "story"))
      )
        return;
      const settledSessionId = settled.session_id;
      if (settled.requires_ack) {
        if (!acknowledgedUpdates.current.consume(runtimeUpdateKey(settled))) {
          return;
        }
        void runStoryCommand(() =>
          engineApi.presentationComplete(
            settled.update_id,
            outcome,
            settledSessionId,
          ),
        );
        return;
      }

      if (replayMode) return;

      const prompt = settled.snapshot.prompt;
      const isStable = prompt.kind !== "none" && phaseRef.current === "playing";
      if (
        !isStable ||
        autosavedRevisions.current.has(runtimeRevisionKey(settled))
      ) {
        return;
      }
      autosavedRevisions.current.consume(runtimeRevisionKey(settled));
      const thumbnail = sceneRef.current?.captureThumbnail() ?? null;
      void engineApi
        .saveSlot("auto", thumbnail, settledSessionId)
        .then(() => refreshSlots())
        .catch((reason: unknown) => console.error("Autosave failed", reason));
    },
    [refreshSlots, replayMode, runStoryCommand],
  );

  const startNewGame = (): void => {
    void (async () => {
      if (replayTransitionRef.current !== null || busyRef.current) return;
      stopTransientPlayback();
      // A new game is a hard presentation boundary even when it starts from
      // the normal story session.  Leaving an old controller alive until the
      // host response arrives could let a late cue finish/ack or keep media
      // playing behind the newly created runtime.
      sceneRef.current?.cancelCurrentPresentation();
      let expectedSessionId = activeSessionId.current;
      const generation = ++sessionGenerationRef.current;
      if (replayMode) {
        const token = beginSessionTransition();
        if (token === null) return;
        const retainedUpdate = update;
        sceneRef.current?.cancelCurrentPresentation();
        try {
          const nextSessionId = requireSessionId(
            await engineApi.exitSceneReplay(expectedSessionId),
          );
          if (
            !transitionControllerRef.current.isCurrentGeneration(
              token,
              generation,
            )
          )
            return;
          expectedSessionId = nextSessionId;
          activeSessionId.current = nextSessionId;
          setUpdate(null);
          setReplayMode(false);
          setReplaySceneId(null);
          if (!finishSessionTransition(token)) return;
        } catch (reason) {
          if (
            transitionControllerRef.current.isCurrentGeneration(
              token,
              generation,
            )
          ) {
            if (retainedUpdate !== null) {
              await restoreRetainedUpdate(retainedUpdate);
            }
            setError(errorMessage(reason));
            finishSessionTransition(token);
          }
          return;
        }
      }
      setReplayMode(false);
      setReplaySceneId(null);
      autosavedRevisions.current.clear();
      setHistory([]);
      // Do not let the previous scene remain visible while the boundary
      // command is in flight.  The command response is the only source that
      // may install the new authoritative update.
      setUpdate(null);
      setPhase("playing");
      phaseRef.current = "playing";
      setPanel("none");
      void sceneRef.current?.unlockAudio();
      const started = await runStoryCommand(
        () => engineApi.startNewGame(expectedSessionId),
        generation,
        expectedSessionId,
        true,
        "story",
        true,
      );
      // A failed boundary command must not leave the title screen in a
      // half-entered story session. Only the transition that started this
      // command may restore the page; a newer transition owns the UI.
      if (
        !started &&
        generation === sessionGenerationRef.current &&
        activeSessionId.current === expectedSessionId
      ) {
        setPhase("title");
        phaseRef.current = "title";
        setPanel("none");
        setUpdate(null);
      }
    })();
  };

  const advance = useCallback(
    (source: AdvanceSource): void => {
      const snapshot = update?.snapshot;
      if (
        snapshot === undefined ||
        (snapshot.prompt.kind !== "dialogue" &&
          snapshot.prompt.kind !== "long_text")
      ) {
        return;
      }
      void runStoryCommand(() =>
        engineApi.advance(snapshot.revision, source, activeSessionId.current),
      );
    },
    [runStoryCommand, update],
  );

  const choose = (choiceId: string): void => {
    const snapshot = update?.snapshot;
    if (snapshot === undefined || snapshot.prompt.kind !== "choice") {
      return;
    }
    void runStoryCommand(() =>
      engineApi.choose(choiceId, snapshot.revision, activeSessionId.current),
    );
  };

  const clickButton = useCallback(
    (instanceId: string): void => {
      const snapshot = update?.snapshot;
      if (
        snapshot === undefined ||
        phaseRef.current !== "playing" ||
        panel !== "none" ||
        busyRef.current ||
        update?.requires_ack
      ) {
        return;
      }
      void runStoryCommand(() =>
        engineApi.clickButton(
          instanceId,
          snapshot.revision,
          activeSessionId.current,
        ),
      );
    },
    [panel, runStoryCommand, update],
  );

  const saveManual = async (slot: string): Promise<void> => {
    if (busyRef.current) {
      return;
    }
    setError(null);
    try {
      await engineApi.saveSlot(
        slot,
        sceneRef.current?.captureThumbnail() ?? null,
        activeSessionId.current,
      );
      await refreshSlots();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const load = (slot: string): void => {
    if (replayMode || busyRef.current || replayTransitionRef.current !== null)
      return;
    stopTransientPlayback();
    // Loading is also a session boundary.  Cancel the old presentation
    // before clearing its update so delayed cue/media callbacks cannot leak
    // across the asynchronous host transition.
    sceneRef.current?.cancelCurrentPresentation();
    const generation = ++sessionGenerationRef.current;
    const expectedSessionId = activeSessionId.current;
    autosavedRevisions.current.clear();
    setHistory([]);
    // A load is a session boundary.  Clear the old presentation before the
    // asynchronous command so a failed load cannot show a mixed scene.
    setUpdate(null);
    setPhase("playing");
    phaseRef.current = "playing";
    setPanel("none");
    void sceneRef.current?.unlockAudio();
    void runStoryCommand(
      () => engineApi.loadSlot(slot, expectedSessionId),
      generation,
      expectedSessionId,
      true,
      "story",
      true,
    ).then((loaded) => {
      // Keep the title page when loading fails. The generation/session guard
      // prevents an older load from undoing a newer boundary transition.
      if (
        !loaded &&
        generation === sessionGenerationRef.current &&
        activeSessionId.current === expectedSessionId
      ) {
        setPhase("title");
        phaseRef.current = "title";
        setPanel("none");
      }
    });
  };

  const persistSettings = async (): Promise<void> => {
    try {
      const saved = await engineApi.saveSettings(draftSettings);
      setSettings(saved);
      setDraftSettings(saved);
      setPanel("none");
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const toggleFullscreen = async (): Promise<void> => {
    try {
      const window = getCurrentWindow();
      await window.setFullscreen(!(await window.isFullscreen()));
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const returnToTitle = (): void => {
    if (busyRef.current) return;
    stopTransientPlayback();
    if (replayMode) {
      if (replayTransitionRef.current !== null) return;
      const generation = ++sessionGenerationRef.current;
      const token = beginSessionTransition();
      if (token === null) return;
      const retainedUpdate = update;
      const transition = (async () => {
        sceneRef.current?.cancelCurrentPresentation();
        try {
          const nextSessionId = requireSessionId(
            await engineApi.exitSceneReplay(activeSessionId.current),
          );
          if (
            !transitionControllerRef.current.isCurrentGeneration(
              token,
              generation,
            )
          )
            return;
          activeSessionId.current = nextSessionId;
          setUpdate(null);
          setReplayMode(false);
          setReplaySceneId(null);
          setHistory([]);
          setPanel("none");
          setPhase("title");
          phaseRef.current = "title";
          finishSessionTransition(token);
        } catch (reason) {
          if (
            transitionControllerRef.current.isCurrentGeneration(
              token,
              generation,
            )
          ) {
            // The presentation was cancelled before the host call, but the
            // authoritative update remains visible so the user can retry.
            if (retainedUpdate !== null) {
              await restoreRetainedUpdate(retainedUpdate);
            }
            setError(errorMessage(reason));
            finishSessionTransition(token);
          }
        } finally {
          if (
            transitionControllerRef.current.isCurrentGeneration(
              token,
              generation,
            )
          )
            replayTransitionRef.current = null;
        }
      })();
      replayTransitionRef.current = transition;
      return;
    }
    const generation = ++sessionGenerationRef.current;
    const token = beginSessionTransition();
    if (token === null) return;
    const retainedUpdate = update;
    setReplayMode(false);
    setReplaySceneId(null);
    // Leaving the story must invalidate the active presentation as well as
    // hiding it.  Otherwise a late cue completion can still ack the runtime
    // after the title screen is visible (and an audio/video element can keep
    // running behind the menu).
    sceneRef.current?.cancelCurrentPresentation();
    void (async () => {
      try {
        const nextSessionId = requireSessionId(
          await engineApi.invalidateSession(activeSessionId.current),
        );
        if (
          !transitionControllerRef.current.isCurrentGeneration(
            token,
            generation,
          )
        )
          return;
        activeSessionId.current = nextSessionId;
        setUpdate(null);
        setPhase("title");
        phaseRef.current = "title";
        finishSessionTransition(token);
      } catch (reason) {
        if (
          transitionControllerRef.current.isCurrentGeneration(token, generation)
        ) {
          if (retainedUpdate !== null) {
            await restoreRetainedUpdate(retainedUpdate);
          }
          setError(errorMessage(reason));
          finishSessionTransition(token);
        }
      } finally {
        // finishSessionTransition owns cleanup.  Do not release a newer
        // command's busy lock from this old request.
      }
    })();
    setHistory([]);
    setPanel("none");
  };

  const openHistory = (): void => {
    const requestGeneration = ++pageRequestGenerationRef.current;
    const requestSessionId = activeSessionId.current;
    void engineApi
      .getDialogueHistory()
      .then((entries) => {
        if (
          requestGeneration !== pageRequestGenerationRef.current ||
          requestSessionId !== activeSessionId.current ||
          phaseRef.current !== "playing"
        )
          return;
        setHistory(entries);
        setPanel("history");
      })
      .catch((reason: unknown) => {
        if (
          requestGeneration === pageRequestGenerationRef.current &&
          requestSessionId === activeSessionId.current &&
          phaseRef.current === "playing"
        )
          setError(errorMessage(reason));
      });
  };

  const openChapterMap = (): void => {
    const requestGeneration = ++pageRequestGenerationRef.current;
    const requestSessionId = activeSessionId.current;
    void engineApi
      .getChapterMap()
      .then((map) => {
        if (
          requestGeneration !== pageRequestGenerationRef.current ||
          requestSessionId !== activeSessionId.current ||
          phaseRef.current !== "title"
        )
          return;
        if (map === null) {
          setError("当前内容未配置章节地图。");
          return;
        }
        setChapterMap(map);
        setNormalAuto(false);
        setPanel("none");
        setPhase("chapter_map");
        phaseRef.current = "chapter_map";
      })
      .catch((reason: unknown) => {
        if (
          requestGeneration === pageRequestGenerationRef.current &&
          requestSessionId === activeSessionId.current &&
          phaseRef.current === "title"
        )
          setError(errorMessage(reason));
      });
  };

  const startSceneReplay = (sceneId: string): void => {
    if (busyRef.current || replayTransitionRef.current !== null) return;
    stopTransientPlayback();
    const generation = ++sessionGenerationRef.current;
    const expectedSessionId = activeSessionId.current;
    setError(null);
    // Do not let the previous story update briefly render behind the replay
    // while the host constructs its isolated runtime.
    setUpdate(null);
    sceneRef.current?.cancelCurrentPresentation();
    setReplayMode(true);
    setReplaySceneId(sceneId);
    setPanel("none");
    setPhase("playing");
    phaseRef.current = "playing";
    // Keep the complete transition (including the map refresh after a failed
    // replay start) behind one controller-owned token.  Releasing `busy` as
    // soon as `start_scene_replay` settles used to expose a blank playing
    // screen for one async turn, during which a second command could race the
    // map recovery and overwrite the new page.
    const transition = (async () => {
      try {
        const started = await runStoryCommand(
          () => engineApi.startSceneReplay(sceneId, expectedSessionId),
          generation,
          expectedSessionId,
          true,
          "replay",
          true,
        );
        if (generation !== sessionGenerationRef.current || started) return;
        // Keep a failed replay from leaving the game controls over a stale
        // main-story snapshot.  The map remains the authoritative place to
        // retry, and its current camera is preserved in the parent state.
        const map = await engineApi.getChapterMap();
        if (generation !== sessionGenerationRef.current) return;
        setChapterMap(map);
        setReplayMode(false);
        setReplaySceneId(null);
        setPhase("chapter_map");
        phaseRef.current = "chapter_map";
      } catch (reason: unknown) {
        if (generation !== sessionGenerationRef.current) return;
        setReplayMode(false);
        setReplaySceneId(null);
        setPhase("chapter_map");
        phaseRef.current = "chapter_map";
        setError(errorMessage(reason));
      } finally {
        if (generation === sessionGenerationRef.current)
          replayTransitionRef.current = null;
      }
    })();
    replayTransitionRef.current = transition;
  };

  const finishSceneReplay = useCallback((): void => {
    if (replayTransitionRef.current !== null) return;
    stopTransientPlayback();
    const generation = ++sessionGenerationRef.current;
    const token = beginSessionTransition();
    if (token === null) return;
    const retainedUpdate = update;
    const expectedSessionId = activeSessionId.current;
    let exitedSessionId: WireU64 | null = null;
    const transition = (async () => {
      sceneRef.current?.cancelCurrentPresentation();
      try {
        const nextSessionId = requireSessionId(
          await engineApi.exitSceneReplay(expectedSessionId),
        );
        if (
          !transitionControllerRef.current.isCurrentGeneration(
            token,
            generation,
          )
        )
          return;
        // Keep the replay frame visible until the map has been fetched.  A
        // failed exit call must leave the exact frame the player was looking
        // at; a successful host switch followed by a map read failure is a
        // different case and can fall back to the already loaded map.
        exitedSessionId = nextSessionId;
        const map = await engineApi.getChapterMap();
        if (
          !transitionControllerRef.current.isCurrentGeneration(
            token,
            generation,
          )
        )
          return;
        activeSessionId.current = nextSessionId;
        setChapterMap(map);
        setUpdate(null);
        setReplayMode(false);
        setReplaySceneId(null);
        setPanel("none");
        setPhase("chapter_map");
        phaseRef.current = "chapter_map";
        finishSessionTransition(token);
      } catch (reason) {
        if (
          transitionControllerRef.current.isCurrentGeneration(token, generation)
        ) {
          if (exitedSessionId === null) {
            if (retainedUpdate !== null) {
              await restoreRetainedUpdate(retainedUpdate);
            }
          } else {
            // The host is already back in story mode.  Do not leave replay
            // controls attached to an update that can no longer be acked;
            // show the existing map and let the user retry the read instead.
            activeSessionId.current = exitedSessionId;
            setUpdate(null);
            setReplayMode(false);
            setReplaySceneId(null);
            setPanel("none");
            setPhase("chapter_map");
            phaseRef.current = "chapter_map";
          }
          setError(errorMessage(reason));
          finishSessionTransition(token);
        }
      } finally {
        if (
          transitionControllerRef.current.isCurrentGeneration(token, generation)
        )
          replayTransitionRef.current = null;
      }
    })();
    replayTransitionRef.current = transition;
  }, [
    beginSessionTransition,
    finishSessionTransition,
    restoreRetainedUpdate,
    stopTransientPlayback,
    update,
  ]);

  useEffect(() => {
    if (!replayMode || replaySceneId === null || update === null) return;
    const crossed = update.snapshot.location.scene_id !== replaySceneId;
    const ended = update.snapshot.prompt.kind === "end";
    if ((crossed || ended) && !update.requires_ack) {
      const frame = requestAnimationFrame(finishSceneReplay);
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [finishSceneReplay, replayMode, replaySceneId, update]);

  const closeChapterMap = (): void => {
    if (busyRef.current || replayTransitionRef.current !== null) return;
    setPhase("title");
    phaseRef.current = "title";
  };

  const dialogue =
    update?.snapshot.prompt.kind === "dialogue" ? update.snapshot.prompt : null;
  const longText =
    update?.snapshot.prompt.kind === "long_text"
      ? update.snapshot.prompt
      : null;
  const textPrompt: DialoguePrompt | LongTextPrompt | null =
    dialogue ?? longText;
  const dialoguePage =
    update?.snapshot.dialogue_page ??
    (dialogue === null
      ? null
      : {
          page_id: dialogue.prompt_id,
          speaker: dialogue.speaker,
          speaker_id: dialogue.speaker_id ?? null,
          name_color: dialogue.name_color ?? null,
          text_color: dialogue.text_color ?? null,
          segments: [dialogue.text],
        });
  const hasUiMotionCue =
    update?.cues.some(
      (cue) =>
        cue.type === "dialogue_ui_transition" || cue.type === "ui_motion",
    ) ?? false;
  const renderedDialoguePage =
    longText === null
      ? (dialoguePage ??
        (hasUiMotionCue
          ? {
              page_id: "ui_motion_preview",
              speaker: null,
              speaker_id: null,
              name_color: null,
              text_color: null,
              segments: [""],
            }
          : null))
      : null;
  const longTextPage = update?.snapshot.long_text_page ?? null;
  const choice =
    update?.snapshot.prompt.kind === "choice" ? update.snapshot.prompt : null;
  const textCueCps = useMemo(
    () => textRevealSpeed(update, textPrompt),
    [textPrompt, update],
  );
  const hasTextRevealCue =
    update?.cues.some(
      (cue) =>
        (cue.type === "dialogue_reveal" || cue.type === "long_text_reveal") &&
        cue.prompt_id === textPrompt?.prompt_id,
    ) ?? false;
  const cueRevealAnimation = textRevealAnimation(update, textPrompt);
  const textInstanceKey =
    textPrompt === null
      ? null
      : `${update?.update_id ?? "none"}:${textPrompt.prompt_id}`;
  const currentTextSettings = useMemo<LockedTextSettings | null>(() => {
    if (textPrompt === null) return null;
    return {
      instanceKey: textInstanceKey ?? "none",
      defaultCps: settings.text_speed_cps,
      initialCps: textCueCps ?? settings.text_speed_cps,
      animation: cueRevealAnimation ?? settings.text_reveal_animation,
    };
  }, [cueRevealAnimation, settings, textCueCps, textInstanceKey, textPrompt]);
  const [lockedTextSettings, setLockedTextSettings] =
    useState<LockedTextSettings | null>(null);
  useEffect(() => {
    if (currentTextSettings === null) {
      const frame = requestAnimationFrame(() => setLockedTextSettings(null));
      return () => cancelAnimationFrame(frame);
    }
    const frame = requestAnimationFrame(() => {
      setLockedTextSettings((previous) =>
        previous?.instanceKey === currentTextSettings.instanceKey
          ? previous
          : currentTextSettings,
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [currentTextSettings]);
  const effectiveTextSettings =
    lockedTextSettings?.instanceKey === currentTextSettings?.instanceKey
      ? lockedTextSettings
      : currentTextSettings;
  const revealCps =
    effectiveTextSettings?.initialCps ?? settings.text_speed_cps;
  const revealDefaultCps =
    effectiveTextSettings?.defaultCps ?? settings.text_speed_cps;
  const revealAnimation =
    effectiveTextSettings?.animation ?? settings.text_reveal_animation;
  const runtimeLocked = update?.requires_ack ?? false;
  const timelineCue = update?.cues.find(
    (cue): cue is Extract<PresentationCue, { type: "timeline" }> =>
      cue.type === "timeline",
  );
  const runtimeTimelineCue = update?.cues.find(
    (cue): cue is Extract<PresentationCue, { type: "timeline" }> =>
      cue.type === "timeline" && cue.gate === "runtime",
  );
  const playback = update?.snapshot.playback ?? {
    auto: "normal" as const,
    ctrl_fast_forward: "allow" as const,
  };
  const forcedAuto = playback.auto === "forced";
  const immediateAutoAdvance =
    textPrompt !== null && hasImmediateAutoAdvance(textPrompt.text);
  const ctrlPolicyAllows =
    !forcedAuto && playback.ctrl_fast_forward === "allow";
  const fastForwardRequested =
    ctrlHeld && ctrlPolicyAllows && settings.skip_mode !== "disabled";
  const fastForwardDialogueAllowed =
    textPrompt !== null &&
    (settings.skip_mode === "all" ||
      (settings.skip_mode === "read_only" && textPrompt.is_read));
  const fastForwardActive =
    phase === "playing" &&
    panel === "none" &&
    fastForwardRequested &&
    update !== null &&
    canFastForwardPrompt(
      playback,
      settings.skip_mode,
      update.snapshot.prompt,
    ) &&
    (runtimeTimelineCue === undefined ||
      settings.skip_mode === "all" ||
      (settings.skip_mode === "read_only" && runtimeTimelineCue.is_seen));
  const autoSlot = saveSlots.find((slot) => slot.slot === "auto");
  const handleTypingChange = useCallback(
    (typing: boolean, cps: number): void => {
      setTypingSfxActive(typing);
      setTypingSfxCps(cps);
    },
    [],
  );
  const handlePlayerAdvance = useCallback((): void => {
    if (
      phaseRef.current !== "playing" ||
      panel !== "none" ||
      busyRef.current ||
      (!runtimeLocked &&
        (textPrompt === null ||
          (longText === null && !update?.snapshot.world.dialogue_ui_visible)))
    ) {
      return;
    }

    void sceneRef.current?.unlockAudio();
    if (forcedAuto) {
      return;
    }
    if (runtimeLocked) {
      sceneRef.current?.skipCurrentPresentation();
      return;
    }
    if (textPrompt === null) return;
    const textHandle =
      longText === null ? dialogueRef.current : longTextRef.current;
    if (!textHandle?.isComplete()) {
      textHandle?.complete();
      return;
    }
    advance("manual");
  }, [advance, forcedAuto, longText, panel, runtimeLocked, textPrompt, update]);

  const handleRevealComplete = useCallback((instanceKey: string): void => {
    setCompletedPromptKey(instanceKey);
  }, []);

  useEffect(() => {
    if (
      phase !== "playing" ||
      panel !== "none" ||
      busy ||
      runtimeLocked ||
      textPrompt === null ||
      !fastForwardRequested ||
      !fastForwardDialogueAllowed
    ) {
      return;
    }

    // Ctrl is a request to finish the current reveal, including an explicit
    // pause. It must happen before the completion gate below; otherwise a
    // held Ctrl key can never leave a prompt that is still typing or paused.
    // The component reports completion asynchronously, so the normal
    // revision-safe advance effect remains the only place that advances.
    if (longText === null) dialogueRef.current?.complete();
    else longTextRef.current?.complete();
  }, [
    busy,
    fastForwardDialogueAllowed,
    fastForwardRequested,
    longText,
    panel,
    phase,
    runtimeLocked,
    textPrompt,
  ]);

  useEffect(() => {
    if (
      phase !== "playing" ||
      panel !== "none" ||
      busy ||
      runtimeLocked ||
      textPrompt === null
    ) {
      return;
    }

    let timer = 0;
    if (completedPromptKey !== textInstanceKey) return;
    if (immediateAutoAdvance) {
      timer = window.setTimeout(
        () => advance(forcedAuto ? "forced_auto" : "auto"),
        0,
      );
    } else if (forcedAuto) {
      timer = window.setTimeout(
        () => advance("forced_auto"),
        autoReadingDelay(textPrompt.text),
      );
    } else if (fastForwardRequested) {
      if (!fastForwardDialogueAllowed) return;
      timer = window.setTimeout(() => advance("fast_forward"), 50);
    } else if (normalAuto && completedPromptKey === textInstanceKey) {
      timer = window.setTimeout(
        () => advance("auto"),
        autoReadingDelay(textPrompt.text),
      );
    }
    return () => window.clearTimeout(timer);
  }, [
    advance,
    busy,
    completedPromptKey,
    textPrompt,
    textInstanceKey,
    fastForwardDialogueAllowed,
    fastForwardRequested,
    forcedAuto,
    immediateAutoAdvance,
    normalAuto,
    panel,
    phase,
    runtimeLocked,
    longText,
  ]);

  useEffect(() => {
    const handleClick = (event: MouseEvent): void => {
      if (
        event.button === 0 &&
        !event.defaultPrevented &&
        !isInteractiveTarget(event.target)
      ) {
        handlePlayerAdvance();
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.code === "ControlLeft" || event.code === "ControlRight") {
        heldControlKeys.current.add(event.code);
        setCtrlHeld(true);
        return;
      }
      if (
        event.key === "Enter" &&
        !event.repeat &&
        !event.defaultPrevented &&
        !isInteractiveTarget(event.target)
      ) {
        event.preventDefault();
        handlePlayerAdvance();
      }
    };
    const handleKeyUp = (event: KeyboardEvent): void => {
      if (event.code !== "ControlLeft" && event.code !== "ControlRight") return;
      heldControlKeys.current.delete(event.code);
      setCtrlHeld(heldControlKeys.current.size > 0);
    };
    const clearControlKeys = (): void => {
      heldControlKeys.current.clear();
      setCtrlHeld(false);
    };
    const handleVisibility = (): void => {
      setPageHidden(document.hidden);
      if (document.hidden) clearControlKeys();
    };
    window.addEventListener("click", handleClick);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", clearControlKeys);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("click", handleClick);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", clearControlKeys);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [handlePlayerAdvance]);

  useEffect(() => {
    const closePanel = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && panel === "history") {
        event.preventDefault();
        setPanel("none");
      }
    };
    window.addEventListener("keydown", closePanel);
    return () => window.removeEventListener("keydown", closePanel);
  }, [panel, phase]);

  // Opening any in-game panel is a hard input boundary.  In particular a
  // Ctrl key that was held while clicking the toolbar must not resume a
  // fast-forward as soon as the panel closes (the key-up event may have been
  // delivered to the panel/WebView instead of the game surface).
  useEffect(() => {
    if (panel !== "none") {
      heldControlKeys.current.clear();
      const frame = requestAnimationFrame(() => setCtrlHeld(false));
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [panel]);

  return (
    <main className="app-shell">
      <section className="game-viewport" style={viewportStyle}>
        <SceneCanvas
          animations={animations}
          assets={assets}
          onDiagnostic={setError}
          onSettled={handlePresentationSettled}
          paused={panel !== "none" || phase !== "playing" || pageHidden}
          playbackRate={fastForwardActive ? 8 : 1}
          ref={sceneRef}
          settings={settings}
          suppressOneShots={fastForwardActive}
          typingSfxActive={typingSfxActive && !fastForwardActive}
          typingSfxCps={typingSfxCps}
          update={update}
          uiMotionHost={uiMotionHost}
          visible={phase === "playing"}
        />

        {phase === "playing" && update !== null && (
          <ButtonLayer
            animations={animations}
            assets={assets}
            disabled={panel !== "none" || busy || runtimeLocked}
            onClick={clickButton}
            paused={panel !== "none" || phase !== "playing" || pageHidden}
            playbackRate={fastForwardActive ? 8 : 1}
            snapshot={update.snapshot}
            timeline={timelineCue ?? null}
          />
        )}

        {phase === "booting" && (
          <div className="boot-screen">
            <div className="loader" />
            <p>正在校验内容与启动运行时…</p>
          </div>
        )}

        {phase === "title" && (
          <div className="title-screen">
            <div className="title-card">
              <p className="eyebrow">A MATHEMATICAL VISUAL NOVEL</p>
              <h1>VECTSPACE</h1>
              <p className="title-formula">
                <MarkupText source="$V=U\oplus W$" />
              </p>
              <div className="title-actions">
                <button disabled={busy} onClick={startNewGame} type="button">
                  开始演示
                </button>
                <button
                  disabled={!autoSlot?.exists || busy}
                  onClick={() => load("auto")}
                  type="button"
                >
                  继续
                </button>
                <button onClick={() => setPanel("saves")} type="button">
                  读取存档
                </button>
                <button onClick={() => setPanel("settings")} type="button">
                  设置
                </button>
                <button
                  disabled={!chapterMapAvailable}
                  onClick={openChapterMap}
                  type="button"
                >
                  章节地图
                </button>
              </div>
              <small>内容版本 {contentVersion || "未载入"}</small>
            </div>
          </div>
        )}

        {phase === "chapter_map" && chapterMap !== null && (
          <ChapterMapPage
            animations={animations}
            assets={assets}
            map={chapterMap}
            onClose={closeChapterMap}
            onReplay={startSceneReplay}
            onViewChange={setChapterMapCenter}
            paused={pageHidden}
            sessionCenter={chapterMapCenter}
          />
        )}

        {phase === "playing" && update !== null && (
          <>
            <nav className="game-toolbar" aria-label="游戏菜单">
              <button
                aria-pressed={normalAuto}
                disabled={forcedAuto}
                onClick={() => setNormalAuto((value) => !value)}
                type="button"
              >
                {forcedAuto
                  ? "自动（强制）"
                  : normalAuto
                    ? "自动：开"
                    : "自动：关"}
              </button>
              {!replayMode && (
                <button onClick={() => setPanel("saves")} type="button">
                  存档 / 读档
                </button>
              )}
              <button onClick={() => setPanel("settings")} type="button">
                设置
              </button>
              <button onClick={openHistory} type="button">
                历史
              </button>
              <button onClick={() => void toggleFullscreen()} type="button">
                全屏
              </button>
              <button onClick={returnToTitle} type="button">
                标题
              </button>
            </nav>

            {renderedDialoguePage !== null && (
              <DialogueBox
                defaultCps={revealDefaultCps}
                dialogueBoxSource={
                  resolveImageAsset("gui.dialogue_box", assets, animations) ??
                  null
                }
                disabled={busy || runtimeLocked}
                initialCps={revealCps}
                key={`${update.update_id}:${dialogue?.prompt_id ?? `retained:${update.snapshot.revision}`}`}
                motionHost={uiMotionHost}
                nameBoxSource={
                  resolveImageAsset("gui.name_box", assets, animations) ?? null
                }
                onTypingChange={handleTypingChange}
                onRevealComplete={handleRevealComplete}
                page={renderedDialoguePage}
                prompt={dialogue}
                revealAnimation={revealAnimation}
                fontReady={fontReady}
                measurementScale={viewportMetrics.scale}
                ref={dialogueRef}
                revealImmediately={dialogue === null || !hasTextRevealCue}
                sessionKey={`${update.update_id}:${dialogue?.prompt_id ?? `retained:${renderedDialoguePage.page_id}`}`}
                suspended={panel !== "none" || pageHidden}
                visible={update.snapshot.world.dialogue_ui_visible}
              />
            )}

            {longTextPage !== null && (
              <LongTextPanel
                defaultCps={revealDefaultCps}
                disabled={busy || runtimeLocked || longText === null}
                fastForward={fastForwardActive}
                initialCps={revealCps}
                key={longTextPage.document_id}
                onRevealComplete={handleRevealComplete}
                onTypingChange={handleTypingChange}
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
                revealAnimation={revealAnimation}
                designScale={viewportMetrics.scale}
                fontReady={fontReady}
                fontKey={defaultFontId ?? "system"}
                ref={longTextRef}
                revealImmediately={!hasTextRevealCue}
                sessionKey={`${update.update_id}:${longText?.prompt_id ?? `retained:${longTextPage.active_step_index}`}`}
                suspended={panel !== "none" || pageHidden}
                visible={longTextPage.visible !== false}
              />
            )}

            {choice !== null && (
              // Keep this component mounted across same-prompt runtime updates.
              // ChoiceLayer owns the stable prompt-id reset; update_id is a
              // volatile revision and must not restart focus or artwork loops.
              <ChoiceLayer
                animations={animations}
                assets={assets}
                disabled={busy || runtimeLocked}
                onChoose={choose}
                // A non-fatal presentation problem (missing template/icon,
                // invalid anchor) is surfaced once instead of locking the
                // prompt; the resolved fallback skin stays playable.
                onDiagnostic={(diagnostic) => setError(diagnostic.message)}
                paused={panel !== "none" || pageHidden}
                prompt={choice}
              />
            )}

            {update.snapshot.prompt.kind === "end" && (
              <div className="end-card">
                <p>{replayMode ? "章节重演结束" : "演示场景结束"}</p>
                <button
                  onClick={replayMode ? finishSceneReplay : returnToTitle}
                  type="button"
                >
                  {replayMode ? "返回章节地图" : "返回标题"}
                </button>
              </div>
            )}

            {runtimeLocked && <div className="runtime-lock">表现同步中…</div>}
          </>
        )}

        {panel === "saves" && (
          <SavePanel
            canSave={phase === "playing" && !runtimeLocked && !replayMode}
            onClose={() => setPanel("none")}
            onLoad={load}
            onSave={(slot) => void saveManual(slot)}
            slots={saveSlots}
          />
        )}

        {panel === "settings" && (
          <SettingsPanel
            onChange={setDraftSettings}
            onClose={() => {
              setDraftSettings(settings);
              setPanel("none");
            }}
            onSave={() => void persistSettings()}
            settings={draftSettings}
          />
        )}

        {panel === "history" && (
          <HistoryPanel entries={history} onClose={() => setPanel("none")} />
        )}
        {error !== null && (
          <div className="error-toast" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)} type="button">
              关闭
            </button>
          </div>
        )}
      </section>
    </main>
  );
}

interface SavePanelProps {
  slots: SaveSlotSummary[];
  canSave: boolean;
  onSave(slot: string): void;
  onLoad(slot: string): void;
  onClose(): void;
}

function SavePanel({
  slots,
  canSave,
  onSave,
  onLoad,
  onClose,
}: SavePanelProps): ReactElement {
  return (
    <div className="modal-backdrop">
      <section className="modal-panel save-panel" aria-label="存档">
        <header>
          <div>
            <p className="eyebrow">SNAPSHOT ONLY</p>
            <h2>存档与读档</h2>
          </div>
          <button onClick={onClose} type="button">
            关闭
          </button>
        </header>
        <div className="slot-grid">
          {slots.map((slot) => (
            <article className="save-slot" key={slot.slot}>
              {slot.thumbnail_data_url !== null ? (
                <img alt="场景缩略图" src={slot.thumbnail_data_url} />
              ) : (
                <div className="empty-thumbnail">NO DATA</div>
              )}
              <div className="slot-copy">
                <strong>
                  {slot.slot === "auto" ? "自动存档" : `手动槽 ${slot.slot}`}
                </strong>
                <span>{formatTimestamp(slot.saved_at_unix_ms)}</span>
                <p>{slot.prompt_preview ?? "空存档"}</p>
              </div>
              <div className="slot-actions">
                {slot.slot !== "auto" && (
                  <button
                    disabled={!canSave}
                    onClick={() => onSave(slot.slot)}
                    type="button"
                  >
                    保存
                  </button>
                )}
                <button
                  disabled={!slot.exists}
                  onClick={() => onLoad(slot.slot)}
                  type="button"
                >
                  读取
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

interface SettingsPanelProps {
  settings: Settings;
  onChange(settings: Settings): void;
  onSave(): void;
  onClose(): void;
}

export function SettingsPanel({
  settings,
  onChange,
  onSave,
  onClose,
}: SettingsPanelProps): ReactElement {
  const [animationPreviewRevision, setAnimationPreviewRevision] = useState(0);
  const animationPreviewSource = "示例：$A \\cong B$，文字";
  const animationPreviewUnits = useMemo(
    () => parseMarkup(animationPreviewSource),
    [animationPreviewSource],
  );
  const animationPreviewCps = useMemo(
    () =>
      buildVisibleUnitCps(
        animationPreviewUnits,
        settings.text_speed_cps,
        settings.text_speed_cps,
      ),
    [animationPreviewUnits, settings.text_speed_cps],
  );
  const previewKey = `${animationPreviewRevision}:${settings.text_reveal_animation}:${settings.text_speed_cps}`;
  const [previewLineLayoutKey, setPreviewLineLayoutKey] = useState<
    string | null
  >(null);
  const preview = useTextRevealSession({
    animation: settings.text_reveal_animation,
    defaultCps: settings.text_speed_cps,
    initialCps: settings.text_speed_cps,
    instanceKey: previewKey,
    ready:
      settings.text_reveal_animation !== "line_sweep" ||
      previewLineLayoutKey === previewKey,
    restorePresentation: false,
    units: animationPreviewUnits,
    waitForInlineMath: settings.text_reveal_animation !== "drop_fade",
  });
  const rows: {
    key:
      | "master_volume"
      | "bgm_volume"
      | "ambience_volume"
      | "sfx_volume"
      | "video_volume"
      | "text_speed_cps";
    label: string;
    min: number;
    max: number;
    step: number;
  }[] = [
    { key: "master_volume", label: "主音量", min: 0, max: 1, step: 0.01 },
    { key: "bgm_volume", label: "BGM", min: 0, max: 1, step: 0.01 },
    {
      key: "ambience_volume",
      label: "环境声",
      min: 0,
      max: 1,
      step: 0.01,
    },
    { key: "sfx_volume", label: "音效", min: 0, max: 1, step: 0.01 },
    { key: "video_volume", label: "视频", min: 0, max: 1, step: 0.01 },
    { key: "text_speed_cps", label: "文字速度", min: 5, max: 80, step: 1 },
  ];
  return (
    <div className="modal-backdrop">
      <section className="modal-panel settings-panel" aria-label="设置">
        <header>
          <div>
            <p className="eyebrow">LOCAL SETTINGS</p>
            <h2>设置</h2>
          </div>
          <button onClick={onClose} type="button">
            关闭
          </button>
        </header>
        {rows.map((row) => {
          // Settings files written before C1 omit ambience_volume. Keep the
          // control usable while the compatibility default is supplied by the
          // runtime and Rust save layer.
          const value =
            row.key === "ambience_volume"
              ? (settings.ambience_volume ?? 0.8)
              : settings[row.key];
          return (
            <label className="setting-row" key={row.key}>
              <span>{row.label}</span>
              <input
                aria-label={row.label}
                max={row.max}
                min={row.min}
                onChange={(event) =>
                  onChange({
                    ...settings,
                    [row.key]: Number(event.currentTarget.value),
                  })
                }
                step={row.step}
                type="range"
                value={value}
              />
              <output>{formatSetting(value, row.key)}</output>
            </label>
          );
        })}
        <label className="setting-row">
          <span>文字动画</span>
          <select
            onChange={(event) =>
              onChange({
                ...settings,
                text_reveal_animation: event.currentTarget
                  .value as TextRevealAnimation,
              })
            }
            value={settings.text_reveal_animation}
          >
            <option value="line_sweep">逐行横向渐显</option>
            <option value="typewriter">逐字 / 公式渐显</option>
            <option value="drop_fade">下落渐显</option>
          </select>
          <output />
        </label>
        <div className="text-animation-preview" key={previewKey}>
          <MarkupText
            animateMath
            instantMathReveal={preview.isComplete()}
            instantReveal={preview.isComplete()}
            lineSweepElapsedMs={preview.state.elapsedMs}
            onLineSweepLayoutChange={(ready) =>
              setPreviewLineLayoutKey(ready ? previewKey : null)
            }
            pauseWindows={preview.plan.pauses}
            revealAnimation={settings.text_reveal_animation}
            revealClock={preview.clock}
            revealSchedule={preview.plan.events.map((event) => event.atMs)}
            source={animationPreviewSource}
            unitCps={animationPreviewCps}
            visibleCount={preview.state.revealedCount}
          />
          <button
            onClick={() =>
              setAnimationPreviewRevision((revision) => revision + 1)
            }
            type="button"
          >
            重播示例
          </button>
        </div>
        <label className="setting-row">
          <span>Ctrl 快进</span>
          <select
            onChange={(event) =>
              onChange({
                ...settings,
                skip_mode: event.currentTarget.value as Settings["skip_mode"],
              })
            }
            value={settings.skip_mode}
          >
            <option value="disabled">关闭快进</option>
            <option value="read_only">快进已读内容</option>
            <option value="all">全部快进</option>
          </select>
          <output />
        </label>
        <button className="primary-action" onClick={onSave} type="button">
          保存设置
        </button>
      </section>
    </div>
  );
}

function textRevealSpeed(
  update: RuntimeUpdate | null,
  prompt: DialoguePrompt | LongTextPrompt | null,
): number | null | undefined {
  if (update === null || prompt === null) {
    return undefined;
  }
  const cue = update.cues.find(
    (candidate) =>
      (candidate.type === "dialogue_reveal" ||
        candidate.type === "long_text_reveal") &&
      candidate.prompt_id === prompt.prompt_id,
  );
  return cue?.type === "dialogue_reveal" || cue?.type === "long_text_reveal"
    ? cue.speed_cps
    : undefined;
}

function textRevealAnimation(
  update: RuntimeUpdate | null,
  prompt: DialoguePrompt | LongTextPrompt | null,
): TextRevealAnimation | null {
  if (update === null || prompt === null) return null;
  const cue = update.cues.find(
    (candidate) =>
      (candidate.type === "dialogue_reveal" ||
        candidate.type === "long_text_reveal") &&
      candidate.prompt_id === prompt.prompt_id,
  );
  return cue?.type === "dialogue_reveal" || cue?.type === "long_text_reveal"
    ? (cue.reveal_animation ?? null)
    : null;
}

function getInitialAppState(): Promise<InitialAppState> {
  initialAppStatePromise ??= loadInitialAppState().catch((reason: unknown) => {
    initialAppStatePromise = null;
    throw reason instanceof Error ? reason : new Error(String(reason));
  });
  return initialAppStatePromise;
}

async function loadInitialAppState(attempt = 1): Promise<InitialAppState> {
  try {
    return await withStartupTimeout(loadInitialAppStateAttempt(), 6_000);
  } catch (reason) {
    if (attempt >= 3) {
      throw reason;
    }
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, attempt * 250);
    });
    return loadInitialAppState(attempt + 1);
  }
}

async function loadInitialAppStateAttempt(): Promise<InitialAppState> {
  const [bootstrap, settings, slots] = await Promise.all([
    engineApi.bootstrap(),
    engineApi.loadSettings(),
    engineApi.listSaveSlots(),
  ]);
  const resolved = await engineApi.resolveAssets(bootstrap.asset_ids);
  return {
    bootstrap,
    settings,
    slots,
    assets: resolvedAssetsToUrls(resolved),
    animations: resolvedAssetsToAnimations(resolved),
  };
}

function withStartupTimeout<T>(
  promise: Promise<T>,
  durationMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error("连接 Rust 运行时超时，正在重试")),
      durationMs,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (reason: unknown) => {
        window.clearTimeout(timer);
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      },
    );
  });
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function runtimeUpdateKey(update: RuntimeUpdate): string {
  return `${update.session_id ?? "0"}:${update.update_id}`;
}

function runtimeRevisionKey(update: RuntimeUpdate): string {
  return `${update.session_id ?? "0"}:${update.snapshot.revision}`;
}

function formatTimestamp(value: number | null): string {
  return value === null
    ? "—"
    : new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function formatSetting(
  value: number,
  key:
    | "master_volume"
    | "bgm_volume"
    | "ambience_volume"
    | "sfx_volume"
    | "video_volume"
    | "text_speed_cps",
): string {
  return key === "text_speed_cps"
    ? `${Math.round(value)} cps`
    : `${Math.round(value * 100)}%`;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "button, input, select, textarea, a, label, [contenteditable='true'], [data-block-story-advance]",
    ) !== null
  );
}
